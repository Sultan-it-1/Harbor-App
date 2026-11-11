package app.harbor.android

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL

/**
 * One HTTP download attempt into a ".part" file. Picks up where the file left off with a Range
 * request when the server allows it, and starts over when it doesn't. The caller (Downloads)
 * decides what to do with the result: retry later, wait for the network, or give up.
 *
 * No Android APIs here, so it runs in plain JVM unit tests (HttpTransferTest).
 */
class HttpTransfer(
    private val url: String,
    private val headers: Map<String, String>,
    private val userAgent: String,
    private val part: File,
    private val listener: Listener,
    /**
     * A whole file smaller than this is refused (0 = any size). A film or an episode is never a
     * few hundred kilobytes: that is the short "not ready" clip a debrid link answers with. It is
     * a real video file, so the "is this a video?" checks below let it through.
     */
    private val minBytes: Long = 0,
) {
    interface Listener {
        /** Full size once the server says it (-1 when it doesn't). */
        fun onTotal(total: Long) {}

        /** Bytes in the file so far; called after every read, so keep it cheap. */
        fun onProgress(received: Long) {}

        /** Checked between reads: true to stop now (pause / cancel). */
        fun shouldStop(): Boolean = false

        /** Free bytes on the volume the file is on. */
        fun freeSpace(): Long = Long.MAX_VALUE
    }

    enum class Problem { NETWORK, SERVER, REFUSED, SPACE, NOT_MEDIA, TOO_SMALL, OTHER }

    sealed class Result {
        object Done : Result()
        object Stopped : Result()

        /** Worth another go: connection cut, timeout, server busy. */
        data class Retry(val problem: Problem, val detail: String, val madeProgress: Boolean) : Result()

        /** Retrying right away won't help: link refused/expired, no space, bad response, a
         *  placeholder instead of the video. */
        data class Fail(val problem: Problem, val detail: String, val httpCode: Int = 0) : Result()
    }

    @Volatile private var conn: HttpURLConnection? = null

    /** Breaks a blocking read at once (pause / cancel from another thread). */
    fun abort() {
        try {
            conn?.disconnect()
        } catch (_: Exception) {
        }
    }

    /** Next to the .part: the host and ETag/Last-Modified of the file it holds (for If-Range). */
    private val validatorFile = File(part.path + ".validator")

    /**
     * The whole file is [size] bytes, less than [minBytes]: a placeholder, refused. What is on disk
     * of it goes too (a later try must not carry on from a piece of it). A .part bigger than that
     * is not the placeholder: it is part of the real file, from a link that worked earlier, and
     * stays for when the source is ready again.
     */
    private fun tooSmall(size: Long): Result {
        if (part.length() < minBytes) {
            part.delete()
            validatorFile.delete()
        }
        return Result.Fail(Problem.TOO_SMALL, "$size bytes")
    }

    private fun savedValidator(host: String): String? = try {
        val lines = validatorFile.readLines()
        if (lines.size >= 2 && lines[0] == host) lines[1].takeIf { it.isNotBlank() } else null
    } catch (_: Exception) {
        null
    }

    fun run(): Result {
        var target = URL(url)
        // The page's login headers are for the host the link points at: a redirect to another
        // host goes without them (RedirectGuard).
        val firstHost = target.host
        var redirects = 0
        var restarted = false
        val startBytes = if (part.exists()) part.length() else 0L
        var offset = startBytes
        if (offset == 0L) validatorFile.delete()
        while (true) {
            if (listener.shouldStop()) return Result.Stopped
            val c: HttpURLConnection
            val code: Int
            try {
                c = target.openConnection() as HttpURLConnection
                conn = c
                c.instanceFollowRedirects = false
                c.connectTimeout = CONNECT_TIMEOUT_MS
                c.readTimeout = READ_TIMEOUT_MS
                c.setRequestProperty("User-Agent", userAgent)
                headers.forEach { (k, v) ->
                    if (!k.equals("user-agent", true) && !k.equals("range", true) && !k.equals("accept-encoding", true) &&
                        RedirectGuard.maySend(k, firstHost, target.host)
                    ) {
                        c.setRequestProperty(k, v)
                    }
                }
                c.setRequestProperty("Accept-Encoding", "identity")
                if (offset > 0) {
                    c.setRequestProperty("Range", "bytes=$offset-")
                    // If the file on the server changed since the .part was started, the server
                    // sends the whole new file (200) instead of splicing two files together.
                    savedValidator(target.host)?.let { c.setRequestProperty("If-Range", it) }
                }
                code = c.responseCode
            } catch (e: IOException) {
                conn = null
                if (listener.shouldStop()) return Result.Stopped
                return Result.Retry(Problem.NETWORK, e.message ?: e.javaClass.simpleName, false)
            }

            if (code in 300..399 && code != 304) {
                val loc = c.getHeaderField("Location")
                c.disconnect()
                if (loc.isNullOrBlank()) return Result.Fail(Problem.OTHER, "redirect without a location", code)
                if (++redirects > MAX_REDIRECTS) return Result.Fail(Problem.OTHER, "too many redirects", code)
                val next = try { URL(target, loc) } catch (_: MalformedURLException) { null }
                if (next == null || (next.protocol != "http" && next.protocol != "https")) {
                    return Result.Fail(Problem.OTHER, "redirect to an unsupported address", code)
                }
                target = next
                continue
            }

            if (code == 416 && offset > 0) {
                // Nothing left to send from there: either it's all here already, or the file
                // on the server changed. Check the size it reports.
                val total = parseContentRange(c.getHeaderField("Content-Range"))?.total ?: -1
                c.disconnect()
                // The file there is too small to be the video (all of it here already, or it
                // took the place of the one this .part was started from): a placeholder.
                if (total in 1 until minBytes) return tooSmall(total)
                if (total == offset) {
                    listener.onTotal(total)
                    listener.onProgress(offset)
                    return Result.Done
                }
                if (restarted) return Result.Fail(Problem.OTHER, "server rejected the download range", code)
                part.delete()
                offset = 0
                restarted = true
                continue
            }

            if (code !in 200..299) {
                c.disconnect()
                return when {
                    code == 408 || code == 429 || code >= 500 -> Result.Retry(Problem.SERVER, "HTTP $code", false)
                    else -> Result.Fail(Problem.REFUSED, "HTTP $code", code)
                }
            }

            // 206 from where we asked = carry on; anything else = the server sends the whole file.
            val range = if (code == 206) parseContentRange(c.getHeaderField("Content-Range")) else null
            val resume = offset > 0 && code == 206 && range != null && range.start == offset
            if (offset > 0 && !resume) {
                if (code == 206) {
                    // A partial answer that doesn't start where we are: ask for the whole file.
                    c.disconnect()
                    if (restarted) return Result.Fail(Problem.OTHER, "server sent the wrong range", code)
                    part.delete()
                    offset = 0
                    restarted = true
                    continue
                }
                offset = 0 // 200: the server ignored the range
            }
            // A web page, an API error or a playlist is not a video: a captive Wi-Fi portal or a
            // proxy answering "200 OK" with HTML used to be saved and reported as finished.
            notMediaType(c.contentType)?.let { why ->
                c.disconnect()
                return Result.Fail(Problem.NOT_MEDIA, why, code)
            }
            val length = c.getHeaderFieldLong("Content-Length", -1L)
            val total = when {
                range != null && range.total > 0 -> range.total
                length >= 0 -> offset + length
                else -> -1L
            }
            // The server says how big the whole file is, and it is too small to be the video:
            // refused before a byte is written (and before anything kept from an earlier,
            // real file is touched).
            if (total in 1 until minBytes) {
                c.disconnect()
                return tooSmall(total)
            }
            if (!resume) {
                val v = c.getHeaderField("ETag")?.takeIf { !it.startsWith("W/") } ?: c.getHeaderField("Last-Modified")
                try {
                    if (v != null) validatorFile.writeText(target.host + "\n" + v) else validatorFile.delete()
                } catch (_: Exception) {
                }
            }
            if (total > 0 && listener.freeSpace() < total - offset + SPACE_MARGIN) {
                c.disconnect()
                return Result.Fail(Problem.SPACE, "not enough storage")
            }
            listener.onTotal(total)

            var got = offset
            try {
                FileOutputStream(part, resume).use { out ->
                    c.inputStream.use { input ->
                        val buf = ByteArray(BUFFER_BYTES)
                        var sinceSync = 0L
                        var sniffed = resume
                        listener.onProgress(got)
                        while (true) {
                            if (listener.shouldStop()) return Result.Stopped
                            val n = input.read(buf)
                            if (n < 0) break
                            if (!sniffed) {
                                sniffed = true
                                notMediaBytes(buf, n)?.let { why ->
                                    out.close()
                                    part.delete()
                                    validatorFile.delete()
                                    return Result.Fail(Problem.NOT_MEDIA, why, code)
                                }
                            }
                            out.write(buf, 0, n)
                            got += n
                            sinceSync += n
                            if (sinceSync >= SYNC_BYTES) {
                                // Keep what's on disk in step with the file size, so a crash or
                                // power loss can't leave a gap that a later resume would skip.
                                out.fd.sync()
                                sinceSync = 0
                            }
                            listener.onProgress(got)
                        }
                        out.fd.sync()
                    }
                }
            } catch (e: IOException) {
                if (listener.shouldStop()) return Result.Stopped
                if (isNoSpace(e)) return Result.Fail(Problem.SPACE, "not enough storage")
                return Result.Retry(Problem.NETWORK, e.message ?: e.javaClass.simpleName, got > startBytes)
            } finally {
                c.disconnect()
                conn = null
            }
            if (total > 0 && got < total) return Result.Retry(Problem.NETWORK, "connection closed early", got > startBytes)
            // The server never said the size, and what came is too small to be the video.
            if (got < minBytes) return tooSmall(got)
            validatorFile.delete()
            return Result.Done
        }
    }

    data class ContentRange(val start: Long, val end: Long, val total: Long)

    companion object {
        const val CONNECT_TIMEOUT_MS = 20_000
        const val READ_TIMEOUT_MS = 30_000
        private const val MAX_REDIRECTS = 10
        private const val BUFFER_BYTES = 256 * 1024
        private const val SYNC_BYTES = 32L * 1024 * 1024
        private const val SPACE_MARGIN = 64L * 1024 * 1024

        private val RANGE_RX = Regex("""bytes\s+(\d+)-(\d+)/(\d+|\*)""", RegexOption.IGNORE_CASE)
        private val UNSATISFIED_RX = Regex("""bytes\s+\*/(\d+)""", RegexOption.IGNORE_CASE)

        // "bytes 100-199/1000" -> (100, 199, 1000); "bytes [star]/1000" (a 416 answer) -> total only.
        fun parseContentRange(v: String?): ContentRange? {
            if (v.isNullOrBlank()) return null
            RANGE_RX.find(v)?.let { m ->
                val total = m.groupValues[3].toLongOrNull() ?: -1L
                return ContentRange(m.groupValues[1].toLong(), m.groupValues[2].toLong(), total)
            }
            UNSATISFIED_RX.find(v)?.let { m -> return ContentRange(-1, -1, m.groupValues[1].toLong()) }
            return null
        }

        /** Why a Content-Type can't be a video file, or null when it can. */
        fun notMediaType(contentType: String?): String? {
            val t = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return null
            return when {
                t == "text/html" || t == "application/xhtml+xml" -> "the server sent a web page"
                t == "application/json" || t.endsWith("+json") -> "the server sent an error message"
                t.contains("mpegurl") -> "the link is a streaming playlist (HLS), not a file"
                t == "application/dash+xml" -> "the link is a streaming playlist (DASH), not a file"
                else -> null
            }
        }

        /** Why the first bytes can't be a video file (HTML, JSON, a playlist), or null. */
        fun notMediaBytes(b: ByteArray, n: Int): String? {
            var i = 0
            while (i < n && i < 64 && (b[i] == ' '.code.toByte() || b[i] == '\n'.code.toByte() || b[i] == '\r'.code.toByte() || b[i] == '\t'.code.toByte() || b[i] == 0xEF.toByte() || b[i] == 0xBB.toByte() || b[i] == 0xBF.toByte())) i++
            val head = String(b, i, minOf(n - i, 64).coerceAtLeast(0), Charsets.ISO_8859_1).lowercase()
            return when {
                head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body") -> "the server sent a web page"
                head.startsWith("#extm3u") -> "the link is a streaming playlist (HLS), not a file"
                head.startsWith("<?xml") && head.contains("mpd") -> "the link is a streaming playlist (DASH), not a file"
                head.startsWith("{\"") || head.startsWith("{ \"") || head.startsWith("[{") -> "the server sent an error message"
                else -> null
            }
        }

        fun isNoSpace(e: IOException): Boolean {
            val m = (e.message ?: "") + " " + (e.cause?.message ?: "")
            return m.contains("ENOSPC") || m.contains("No space left", ignoreCase = true)
        }
    }
}
