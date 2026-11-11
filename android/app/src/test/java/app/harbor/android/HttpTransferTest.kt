package app.harbor.android

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.nio.file.Files
import java.util.Collections
import kotlin.random.Random

/** Runs HttpTransfer against a small local HTTP server. */
class HttpTransferTest {
    private lateinit var server: MiniHttpServer
    private lateinit var dir: File
    private val body = Random(7).nextBytes(3 * 1024 * 1024 + 123)
    /** A debrid's "not ready" clip: a real, playable file of 146 KB where the film should be. */
    private val clip = body.copyOfRange(0, 146_000)
    /** What the page asks for a film or an episode. */
    private val filmMin = 5L * 1024 * 1024
    private val ranges = Collections.synchronizedList(ArrayList<String?>())
    /** The headers of the last request for /file. */
    @Volatile private var fileHeaders: Map<String, String> = emptyMap()
    private val port get() = server.port

    @Before fun setUp() {
        dir = Files.createTempDirectory("harbor-dl").toFile()
        server = MiniHttpServer { _, path, headers, out ->
            when (path) {
                "/file" -> {
                    fileHeaders = headers
                    serve(headers["range"], out, rangeSupport = true)
                }
                "/norange" -> serve(headers["range"], out, rangeSupport = false)
                "/clip" -> serve(headers["range"], out, rangeSupport = true, data = clip)
                "/clip-norange" -> serve(headers["range"], out, rangeSupport = false, data = clip)
                // No Content-Length: the size is only known once the connection closes.
                "/clip-nolen" -> MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "video/mp4", "ETag" to "\"clip\""), clip)
                "/nolen" -> MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "video/mp4"), body)
                "/redirect" -> MiniHttpServer.respond(out, 302, mapOf("Location" to "/file"))
                "/gone" -> MiniHttpServer.respond(out, 404)
                "/busy" -> MiniHttpServer.respond(out, 503)
                "/short" -> {
                    // Promises the whole file, sends half, hangs up.
                    ranges.add(headers["range"])
                    MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "${body.size}"), body, body.size / 2)
                }
                else -> MiniHttpServer.respond(out, 404)
            }
        }
    }

    @After fun tearDown() {
        server.close()
        dir.deleteRecursively()
    }

    private fun serve(range: String?, out: OutputStream, rangeSupport: Boolean, data: ByteArray = body) {
        ranges.add(range)
        val m = range?.let { Regex("bytes=(\\d+)-").find(it) }
        if (rangeSupport && m != null) {
            val start = m.groupValues[1].toInt()
            if (start >= data.size) {
                MiniHttpServer.respond(out, 416, mapOf("Content-Range" to "bytes */${data.size}", "Content-Length" to "0"))
                return
            }
            MiniHttpServer.respond(
                out, 206,
                mapOf("Content-Range" to "bytes $start-${data.size - 1}/${data.size}", "Content-Length" to "${data.size - start}"),
                data.copyOfRange(start, data.size),
            )
        } else {
            MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "${data.size}"), data)
        }
    }

    private class Probe(val stopAfter: Long = Long.MAX_VALUE, val free: Long = Long.MAX_VALUE) : HttpTransfer.Listener {
        var total = -2L
        var received = 0L
        override fun onTotal(total: Long) { this.total = total }
        override fun onProgress(received: Long) { this.received = received }
        override fun shouldStop() = received >= stopAfter
        override fun freeSpace() = free
    }

    private fun transfer(path: String, part: File, probe: Probe = Probe(), minBytes: Long = 0) =
        HttpTransfer("http://127.0.0.1:$port$path", mapOf("Referer" to "https://example.org/"), "HarborTest", part, probe, minBytes)

    private fun assertPlaceholder(r: HttpTransfer.Result) =
        assertTrue("got $r", r is HttpTransfer.Result.Fail && r.problem == HttpTransfer.Problem.TOO_SMALL)

    @Test fun downloadsWholeFile() {
        val part = File(dir, "a.part")
        val probe = Probe()
        assertEquals(HttpTransfer.Result.Done, transfer("/file", part, probe).run())
        assertArrayEquals(body, part.readBytes())
        assertEquals(body.size.toLong(), probe.total)
        assertEquals(body.size.toLong(), probe.received)
        assertEquals(listOf<String?>(null), ranges)
    }

    @Test fun resumesFromPartialFile() {
        val part = File(dir, "b.part")
        part.writeBytes(body.copyOfRange(0, 1_000_000))
        assertEquals(HttpTransfer.Result.Done, transfer("/file", part).run())
        assertArrayEquals(body, part.readBytes())
        assertEquals(listOf<String?>("bytes=1000000-"), ranges)
    }

    @Test fun startsOverWhenServerIgnoresRange() {
        val part = File(dir, "c.part")
        part.writeBytes(body.copyOfRange(0, 500_000))
        assertEquals(HttpTransfer.Result.Done, transfer("/norange", part).run())
        assertArrayEquals(body, part.readBytes()) // not appended twice
    }

    @Test fun alreadyCompleteFileIsDone() {
        val part = File(dir, "d.part")
        part.writeBytes(body)
        val probe = Probe()
        assertEquals(HttpTransfer.Result.Done, transfer("/file", part, probe).run())
        assertArrayEquals(body, part.readBytes())
        assertEquals(body.size.toLong(), probe.total)
    }

    @Test fun followsRedirects() {
        val part = File(dir, "e.part")
        assertEquals(HttpTransfer.Result.Done, transfer("/redirect", part).run())
        assertArrayEquals(body, part.readBytes())
    }

    private val login = mapOf("Authorization" to "Bearer secret", "Cookie" to "session=1", "Referer" to "https://example.org/")

    @Test fun redirectOnTheSameHostKeepsTheLogin() {
        val part = File(dir, "e2.part")
        assertEquals(HttpTransfer.Result.Done, HttpTransfer("http://127.0.0.1:$port/redirect", login, "HarborTest", part, Probe()).run())
        assertEquals("Bearer secret", fileHeaders["authorization"])
        assertEquals("session=1", fileHeaders["cookie"])
    }

    @Test fun redirectToAnotherHostGoesWithoutTheLogin() {
        var there: Map<String, String>? = null
        val other = MiniHttpServer { _, _, headers, out ->
            there = headers
            MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "${body.size}"), body)
        }
        // 127.0.0.1 redirects to "localhost": the same machine, but another host name.
        val first = MiniHttpServer { _, _, _, out -> MiniHttpServer.respond(out, 302, mapOf("Location" to "http://localhost:${other.port}/file")) }
        try {
            val part = File(dir, "e3.part")
            assertEquals(HttpTransfer.Result.Done, HttpTransfer("${first.base}/start", login, "HarborTest", part, Probe()).run())
            assertArrayEquals(body, part.readBytes())
            assertEquals(null, there!!["authorization"])
            assertEquals(null, there!!["cookie"])
            assertEquals("https://example.org/", there!!["referer"])
        } finally {
            first.close()
            other.close()
        }
    }

    @Test fun redirectToSomethingThatIsNotHttpFails() {
        val first = MiniHttpServer { _, _, _, out -> MiniHttpServer.respond(out, 302, mapOf("Location" to "file:///etc/hosts")) }
        try {
            val r = HttpTransfer("${first.base}/start", emptyMap(), "HarborTest", File(dir, "e4.part"), Probe()).run()
            assertTrue("got $r", r is HttpTransfer.Result.Fail && r.problem == HttpTransfer.Problem.OTHER)
        } finally {
            first.close()
        }
    }

    @Test fun expiredLinkFails() {
        val r = transfer("/gone", File(dir, "f.part")).run()
        assertTrue(r is HttpTransfer.Result.Fail)
        r as HttpTransfer.Result.Fail
        assertEquals(HttpTransfer.Problem.REFUSED, r.problem)
        assertEquals(404, r.httpCode)
    }

    @Test fun busyServerIsRetried() {
        val r = transfer("/busy", File(dir, "g.part")).run()
        assertTrue(r is HttpTransfer.Result.Retry && r.problem == HttpTransfer.Problem.SERVER)
    }

    @Test fun cutConnectionIsRetriedThenResumes() {
        val part = File(dir, "h.part")
        val r = transfer("/short", part).run()
        assertTrue("got $r", r is HttpTransfer.Result.Retry && r.madeProgress)
        val have = part.length()
        assertTrue(have in 1 until body.size)
        // The next attempt (here against the full server) carries on from there.
        assertEquals(HttpTransfer.Result.Done, transfer("/file", part).run())
        assertArrayEquals(body, part.readBytes())
        assertEquals("bytes=$have-", ranges.last())
    }

    @Test fun stopsWhenAsked() {
        val part = File(dir, "i.part")
        val r = transfer("/file", part, Probe(stopAfter = 600_000)).run()
        assertEquals(HttpTransfer.Result.Stopped, r)
        val have = part.length()
        assertTrue(have in 600_000 until body.size)
        assertArrayEquals(body.copyOfRange(0, have.toInt()), part.readBytes())
    }

    @Test fun notEnoughSpaceFails() {
        val r = transfer("/file", File(dir, "j.part"), Probe(free = 1_000_000)).run()
        assertTrue(r is HttpTransfer.Result.Fail && r.problem == HttpTransfer.Problem.SPACE)
    }

    @Test fun noServerIsANetworkRetry() {
        val dead = HttpTransfer("http://127.0.0.1:1/x", emptyMap(), "HarborTest", File(dir, "k.part"), Probe())
        val r = dead.run()
        assertTrue(r is HttpTransfer.Result.Retry && r.problem == HttpTransfer.Problem.NETWORK)
    }

    // ---- minBytes: a debrid's "not ready" clip is a real video file, but it is not the film ----

    @Test fun placeholderOfKnownSizeIsRefusedBeforeAnythingIsWritten() {
        val part = File(dir, "p1.part")
        val probe = Probe()
        assertPlaceholder(transfer("/clip", part, probe, filmMin).run())
        assertFalse(part.exists())
        assertFalse(File(part.path + ".validator").exists())
        // Never reported as a download under way.
        assertEquals(-2L, probe.total)
        assertEquals(0L, probe.received)
    }

    @Test fun placeholderOfUnknownSizeIsDeletedWhenItEnds() {
        val part = File(dir, "p2.part")
        assertPlaceholder(transfer("/clip-nolen", part, minBytes = filmMin).run())
        assertFalse(part.exists())
        assertFalse(File(part.path + ".validator").exists())
    }

    @Test fun fileOfExactlyTheMinimumOrMorePasses() {
        val exact = File(dir, "p3.part")
        assertEquals(HttpTransfer.Result.Done, transfer("/file", exact, minBytes = body.size.toLong()).run())
        assertArrayEquals(body, exact.readBytes())
        val more = File(dir, "p4.part")
        assertEquals(HttpTransfer.Result.Done, transfer("/file", more, minBytes = 1_000_000).run())
        assertArrayEquals(body, more.readBytes())
        // The same when the server never says the size.
        val unknown = File(dir, "p5.part")
        assertEquals(HttpTransfer.Result.Done, transfer("/nolen", unknown, minBytes = body.size.toLong()).run())
        assertArrayEquals(body, unknown.readBytes())
        // One byte under the minimum is refused, known size or not.
        val under = File(dir, "p6.part")
        assertPlaceholder(transfer("/file", under, minBytes = body.size + 1L).run())
        assertPlaceholder(transfer("/nolen", under, minBytes = body.size + 1L).run())
        assertFalse(under.exists())
    }

    @Test fun withoutAMinimumAShortFileIsSavedAsBefore() {
        val known = File(dir, "p7.part")
        assertEquals(HttpTransfer.Result.Done, transfer("/clip", known).run())
        assertArrayEquals(clip, known.readBytes())
        val unknown = File(dir, "p8.part")
        assertEquals(HttpTransfer.Result.Done, transfer("/clip-nolen", unknown).run())
        assertArrayEquals(clip, unknown.readBytes())
    }

    @Test fun completePlaceholderAlreadyOnDiskIsRefusedToo() {
        // Saved whole by an earlier try: the server has nothing more to send (416).
        val part = File(dir, "p9.part")
        part.writeBytes(clip)
        assertPlaceholder(transfer("/clip", part, minBytes = filmMin).run())
        assertFalse(part.exists())
        // And a piece of it is not carried on from.
        part.writeBytes(clip.copyOfRange(0, 50_000))
        assertPlaceholder(transfer("/clip", part, minBytes = filmMin).run())
        assertFalse(part.exists())
    }

    @Test fun partOfTheRealFileIsKeptWhenTheLinkTurnsIntoAPlaceholder() {
        // 1 MB of the film is here; the (fresh) link now answers with the clip.
        val part = File(dir, "p10.part")
        part.writeBytes(body.copyOfRange(0, 1_000_000))
        assertPlaceholder(transfer("/clip", part, minBytes = 500_000).run())
        assertEquals(1_000_000L, part.length())
        // The same from a server that ignores the range and offers the clip whole.
        assertPlaceholder(transfer("/clip-norange", part, minBytes = 500_000).run())
        assertEquals(1_000_000L, part.length())
        // Once the source is ready again, the download carries on from where it was.
        assertEquals(HttpTransfer.Result.Done, transfer("/file", part, minBytes = 500_000).run())
        assertArrayEquals(body, part.readBytes())
    }

    @Test fun parsesContentRange() {
        assertEquals(HttpTransfer.ContentRange(100, 199, 1000), HttpTransfer.parseContentRange("bytes 100-199/1000"))
        assertEquals(1000L, HttpTransfer.parseContentRange("bytes */1000")?.total)
        assertEquals(-1L, HttpTransfer.parseContentRange("bytes 0-9/*")?.total)
        assertEquals(null, HttpTransfer.parseContentRange(null))
    }
}
