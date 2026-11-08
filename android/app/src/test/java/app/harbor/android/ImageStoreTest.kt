package app.harbor.android

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.Executor
import kotlin.random.Random

/** The phone image cache's storage + network side against a small local server. */
class ImageStoreTest {
    private lateinit var server: MiniHttpServer
    private lateinit var dir: File
    private lateinit var store: ImageStore
    private val direct = Executor { it.run() }

    // What the server currently has.
    @Volatile private var poster = Random(1).nextBytes(150_000)
    @Volatile private var posterTag = "\"v1\""
    @Volatile private var posterGone = false
    /** Simulates no connection: hang up without answering. */
    @Volatile private var offline = false
    /** The phone's free space, as the store sees it. */
    @Volatile private var free = Long.MAX_VALUE
    private val hits = Collections.synchronizedList(ArrayList<String>())
    private val conditional = Collections.synchronizedList(ArrayList<String?>())

    @Before fun setUp() {
        dir = Files.createTempDirectory("harbor-img").toFile()
        store = ImageStore(dir, maxBytes = 1_000_000, targetBytes = 600_000, background = direct, freeSpace = { free })
        server = MiniHttpServer { _, path, headers, out ->
            hits.add(path)
            if (offline) return@MiniHttpServer
            when {
                path == "/poster" -> {
                    conditional.add(headers["if-none-match"])
                    when {
                        posterGone -> MiniHttpServer.respond(out, 404)
                        headers["if-none-match"] == posterTag -> MiniHttpServer.respond(out, 304, mapOf("ETag" to posterTag))
                        else -> MiniHttpServer.respond(
                            out, 200,
                            mapOf("Content-Type" to "image/webp", "Content-Length" to "${poster.size}", "ETag" to posterTag, "Cache-Control" to "max-age=7200"),
                            poster,
                        )
                    }
                }
                path.startsWith("/big") -> {
                    val data = Random(path.hashCode()).nextBytes(200_000)
                    MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "image/jpeg", "Content-Length" to "${data.size}"), data)
                }
                path == "/redir" -> MiniHttpServer.respond(out, 301, mapOf("Location" to "/poster"))
                path == "/page" -> {
                    val html = "<html>oops</html>".toByteArray()
                    MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "text/html", "Content-Length" to "${html.size}"), html)
                }
                path == "/nostore" -> MiniHttpServer.respond(
                    out, 200, mapOf("Content-Type" to "image/png", "Content-Length" to "3", "Cache-Control" to "no-store"), byteArrayOf(1, 2, 3),
                )
                else -> MiniHttpServer.respond(out, 404)
            }
        }
    }

    @After fun tearDown() {
        server.close()
        dir.deleteRecursively()
    }

    private fun url(p: String) = server.base + p
    private val headers = mapOf("Accept" to "image/webp,image/*", "User-Agent" to "HarborTest")

    @Test fun savesWhatItShowsAndServesItAfterwards() {
        val got = store.download(url("/poster"), headers).use { it.readBytes() }
        assertArrayEquals(poster, got)
        val hit = store.cached(url("/poster"))
        assertNotNull(hit)
        assertEquals("image/webp", hit!!.meta.mime)
        assertArrayEquals(poster, hit.file.readBytes())
        assertFalse(hit.stale)
        assertEquals(1, hits.count { it == "/poster" })
    }

    @Test fun cutShortIsNotKept() {
        store.download(url("/poster"), headers).use { s -> s.read(ByteArray(10_000)) }
        assertNull(store.cached(url("/poster")))
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    }

    @Test fun errorStatusFailsTheImage() {
        val s = store.download(url("/nothing"), headers)
        try {
            s.read()
            throw AssertionError("expected the read to fail")
        } catch (_: IOException) {
        }
        s.close()
        assertNull(store.cached(url("/nothing")))
    }

    @Test fun errorPagesAndNoStoreAreNotKept() {
        store.download(url("/page"), headers).use { it.readBytes() }
        store.download(url("/nostore"), headers).use { it.readBytes() }
        assertNull(store.cached(url("/page")))
        assertNull(store.cached(url("/nostore")))
    }

    @Test fun followsRedirectsAndKeepsItUnderTheAskedAddress() {
        val got = store.download(url("/redir"), headers).use { it.readBytes() }
        assertArrayEquals(poster, got)
        assertNotNull(store.cached(url("/redir")))
    }

    @Test fun unchangedImageIsConfirmedCheaply() {
        store.download(url("/poster"), headers).use { it.readBytes() }
        val before = store.cached(url("/poster"))!!.meta
        val old = before.copy(storedAt = before.storedAt - 10 * 3600_000L)
        assertTrue(old.stale(System.currentTimeMillis()))
        assertEquals("same", store.recheckNow(url("/poster"), old, headers))
        assertEquals("\"v1\"", conditional.last())
        val after = store.cached(url("/poster"))!!
        assertFalse(after.stale)
        assertArrayEquals(poster, after.file.readBytes())
    }

    @Test fun changedImageReplacesTheSavedOne() {
        store.download(url("/poster"), headers).use { it.readBytes() }
        val meta = store.cached(url("/poster"))!!.meta
        poster = Random(2).nextBytes(120_000)
        posterTag = "\"v2\""
        assertEquals("updated", store.recheckNow(url("/poster"), meta, headers))
        val after = store.cached(url("/poster"))!!
        assertArrayEquals(poster, after.file.readBytes())
        assertEquals("\"v2\"", after.meta.etag)
    }

    @Test fun imageRemovedOnTheServerIsDropped() {
        store.download(url("/poster"), headers).use { it.readBytes() }
        val meta = store.cached(url("/poster"))!!.meta
        posterGone = true
        assertEquals("removed", store.recheckNow(url("/poster"), meta, headers))
        assertNull(store.cached(url("/poster")))
    }

    @Test fun offlineKeepsShowingTheSavedOne() {
        store.download(url("/poster"), headers).use { it.readBytes() }
        val meta = store.cached(url("/poster"))!!.meta
        offline = true
        assertEquals("kept", store.recheckNow(url("/poster"), meta, headers))
        assertNotNull(store.cached(url("/poster")))
    }

    @Test fun overTheLimitTheLeastRecentlyShownGoFirst() {
        val now = System.currentTimeMillis()
        for (i in 1..6) {
            store.download(url("/big$i"), headers).use { it.readBytes() }
            // pretend they were shown at different times: big1 longest ago
            File(dir, ImageStore.keyFor(url("/big$i"))).setLastModified(now - (10 - i) * 3600_000L)
        }
        store.evict()
        val kept = (1..6).filter { store.cached(url("/big$it")) != null }
        assertTrue("kept $kept", store.usedBytes() <= 600_000)
        assertEquals(listOf(4, 5, 6), kept)
    }

    @Test fun theLimitFollowsTheFreeSpace() {
        store.trim()
        assertEquals(1_000_000L, store.limitBytes())
        free = 3L * 1024 * 1024 * 1024
        store.trim()
        assertEquals(600_000L, store.limitBytes())
        free = 1L * 1024 * 1024 * 1024
        store.trim()
        assertEquals(400_000L, store.limitBytes())
    }

    @Test fun aPhoneThatFilledUpIsTidiedOnReturn() {
        val now = System.currentTimeMillis()
        for (i in 1..4) {
            store.download(url("/big$i"), headers).use { it.readBytes() }
            File(dir, ImageStore.keyFor(url("/big$i"))).setLastModified(now - (10 - i) * 3600_000L)
        }
        assertEquals(800_000L, store.usedBytes())
        // Under 2 GB free: the limit drops to 400 KB, tidied down to 80% of it.
        free = 1L * 1024 * 1024 * 1024
        store.trim()
        val kept = (1..4).filter { store.cached(url("/big$it")) != null }
        assertEquals(listOf(4), kept)
        assertTrue(store.usedBytes() <= 320_000)
    }

    @Test fun clearEmptiesTheCache() {
        store.download(url("/big1"), headers).use { it.readBytes() }
        store.download(url("/poster"), headers).use { it.readBytes() }
        store.clear()
        assertNull(store.cached(url("/big1")))
        assertNull(store.cached(url("/poster")))
        assertEquals(0L, store.usedBytes())
        assertTrue(dir.listFiles().isNullOrEmpty())
    }

    @Test fun cleanupRemovesImagesNotShownForAMonth() {
        store.download(url("/big1"), headers).use { it.readBytes() }
        store.download(url("/big2"), headers).use { it.readBytes() }
        File(dir, ImageStore.keyFor(url("/big1"))).setLastModified(System.currentTimeMillis() - 40L * 24 * 3600_000L)
        store.sweep()
        assertNull(store.cached(url("/big1")))
        assertNotNull(store.cached(url("/big2")))
    }

    @Test fun tmdbImagesNeverNeedAReCheck() {
        assertTrue(ImageStore.isImmutable("https://image.tmdb.org/t/p/w342/abc.jpg"))
        assertFalse(ImageStore.isImmutable("https://images.metahub.space/poster/medium/tt1/img"))
        val m = ImageStore.Meta("https://image.tmdb.org/t/p/w342/abc.jpg", "image/jpeg", null, null, 0, 1000, true)
        assertFalse(m.stale(System.currentTimeMillis()))
    }

    @Test fun phonesGetA1280pxBackdropInsteadOfTheOriginal() {
        assertEquals("https://image.tmdb.org/t/p/w1280/abc.jpg", ImageStore.phoneSized("https://image.tmdb.org/t/p/original/abc.jpg", 1080))
        assertEquals("https://image.tmdb.org/t/p/original/logo.svg", ImageStore.phoneSized("https://image.tmdb.org/t/p/original/logo.svg", 1080))
        assertEquals("https://image.tmdb.org/t/p/original/abc.jpg", ImageStore.phoneSized("https://image.tmdb.org/t/p/original/abc.jpg", 2000))
        assertEquals("https://image.tmdb.org/t/p/w342/abc.jpg", ImageStore.phoneSized("https://image.tmdb.org/t/p/w342/abc.jpg", 1080))
    }

    @Test fun heroesGetTheLargestPicture() {
        assertEquals("https://image.tmdb.org/t/p/original/abc.jpg", ImageStore.heroSized("https://image.tmdb.org/t/p/w780/abc.jpg"))
        assertEquals("https://image.tmdb.org/t/p/original/abc.jpg", ImageStore.heroSized("https://image.tmdb.org/t/p/w1280/abc.jpg"))
        assertEquals("https://image.tmdb.org/t/p/original/abc.jpg", ImageStore.heroSized("https://image.tmdb.org/t/p/original/abc.jpg"))
        assertEquals("https://image.tmdb.org/t/p/w500/logo.svg", ImageStore.heroSized("https://image.tmdb.org/t/p/w500/logo.svg"))
        assertEquals(
            "https://images.metahub.space/background/large/tt0111161/img",
            ImageStore.heroSized("https://images.metahub.space/background/medium/tt0111161/img"),
        )
        assertEquals("https://media.kitsu.app/c.jpg", ImageStore.heroSized("https://media.kitsu.app/c.jpg"))
    }

    @Test fun metaSurvivesARoundTrip() {
        val m = ImageStore.Meta("https://x/y", "image/png", "\"e\"", "Sat, 05 Apr 2025 04:55:55 GMT", 123, 456, false)
        assertEquals(m, ImageStore.Meta.decode(m.encode()))
    }
}
