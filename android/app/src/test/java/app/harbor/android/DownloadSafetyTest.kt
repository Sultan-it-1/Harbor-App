package app.harbor.android

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Collections

/** Download ids/names (Downloads companion) and what HttpTransfer accepts as a finished video. */
class DownloadSafetyTest {
    private lateinit var server: MiniHttpServer
    private lateinit var dir: File
    private val ifRange = Collections.synchronizedList(ArrayList<String?>())
    private val video = ByteArray(200_000).also { b ->
        // An MP4 starts with a box size then "ftyp".
        byteArrayOf(0, 0, 0, 0x20, 'f'.code.toByte(), 't'.code.toByte(), 'y'.code.toByte(), 'p'.code.toByte()).copyInto(b)
    }

    @Before fun setUp() {
        dir = Files.createTempDirectory("harbor-dl-safety").toFile()
        server = MiniHttpServer { _, path, headers, out ->
            when (path) {
                "/portal" -> MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "text/html; charset=utf-8"), "<html><body>Log in to the Wi-Fi</body></html>".toByteArray())
                "/sneaky" -> MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "application/octet-stream"), "  <!DOCTYPE html><html></html>".toByteArray())
                "/playlist" -> MiniHttpServer.respond(out, 200, emptyMap(), "#EXTM3U\n#EXT-X-VERSION:3\nseg1.ts\n".toByteArray())
                "/hls" -> MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "application/vnd.apple.mpegurl"), "#EXTM3U\n".toByteArray())
                "/video" -> {
                    ifRange.add(headers["if-range"])
                    val range = headers["range"]?.let { Regex("bytes=(\\d+)-").find(it)?.groupValues?.get(1)?.toInt() }
                    if (range != null) {
                        MiniHttpServer.respond(out, 206, mapOf("Content-Type" to "video/mp4", "ETag" to "\"v1\"", "Content-Range" to "bytes $range-${video.size - 1}/${video.size}", "Content-Length" to "${video.size - range}"), video.copyOfRange(range, video.size))
                    } else {
                        // First try: promises the whole file, sends half, hangs up.
                        MiniHttpServer.respond(out, 200, mapOf("Content-Type" to "video/mp4", "ETag" to "\"v1\"", "Content-Length" to "${video.size}"), video, video.size / 2)
                    }
                }
                else -> MiniHttpServer.respond(out, 404)
            }
        }
    }

    @After fun tearDown() {
        server.close()
        dir.deleteRecursively()
    }

    private fun run(path: String): HttpTransfer.Result =
        HttpTransfer(server.base + path, emptyMap(), "test", File(dir, "v.mp4.part"), object : HttpTransfer.Listener {}).run()

    @Test fun captivePortalPageIsNotAVideo() {
        val r = run("/portal")
        assertTrue(r is HttpTransfer.Result.Fail && r.problem == HttpTransfer.Problem.NOT_MEDIA)
    }

    @Test fun htmlBodyWithBinaryTypeIsNotAVideo() {
        val r = run("/sneaky")
        assertTrue(r is HttpTransfer.Result.Fail && r.problem == HttpTransfer.Problem.NOT_MEDIA)
        assertFalse(File(dir, "v.mp4.part").exists())
    }

    @Test fun hlsPlaylistIsNotAVideo() {
        assertTrue((run("/playlist") as? HttpTransfer.Result.Fail)?.problem == HttpTransfer.Problem.NOT_MEDIA)
        assertTrue((run("/hls") as? HttpTransfer.Result.Fail)?.problem == HttpTransfer.Problem.NOT_MEDIA)
    }

    @Test fun resumeSendsIfRangeWithTheFirstEtag() {
        val first = run("/video")
        assertTrue(first is HttpTransfer.Result.Retry)
        val second = run("/video")
        assertEquals(HttpTransfer.Result.Done, second)
        assertEquals(listOf(null, "\"v1\""), ifRange.toList())
        assertEquals(video.size.toLong(), File(dir, "v.mp4.part").length())
    }

    @Test fun idsThatEscapeTheFolderAreRefused() {
        assertFalse(Downloads.validId(""))
        assertFalse(Downloads.validId("."))
        assertFalse(Downloads.validId(".."))
        assertFalse(Downloads.validId("../x"))
        assertFalse(Downloads.validId("a/b"))
        assertFalse(Downloads.validId("a..b"))
        assertTrue(Downloads.validId("lq3x9a2k"))
        assertTrue(Downloads.validId("tt0111161-1-2"))
    }

    @Test fun longNamesKeepTheirExtension() {
        val name = "The.Lord.of.the.Rings.The.Return.of.the.King.2003.EXTENDED.2160p.UHD.BluRay.x265.10bit.HDR10.DolbyVision.mkv"
        val safe = Downloads.safeFileName(name)
        assertTrue(safe.length <= 80)
        assertTrue(safe.endsWith(".mkv"))
        assertEquals("الحلقة_1.mp4", Downloads.safeFileName("الحلقة 1.mp4".replace(' ', '_')))
        assertEquals("video.mp4", Downloads.safeFileName(".."))
    }
}
