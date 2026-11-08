package app.harbor.android

import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * The image cache's storage and network side (ImageCache is the WebView glue). Plain JVM, so it
 * runs in unit tests (ImageStoreTest).
 *
 *  - download(): a new image streams to the caller while it's saved; kept only when it arrived
 *    whole and really is an image.
 *  - Up to date: images that never change under the same address (TMDB) are kept as they are;
 *    others are re-checked with the server once their age passes the server's max-age (between
 *    an hour and a day): unchanged = kept (cheap 304), changed = replaced, gone = removed.
 *  - Tidy: over the limit, the least recently shown go first (down to 80% of it); not shown for
 *    unusedMs = removed. The limit follows the phone's free space (limitBytes): all of maxBytes
 *    with room to spare, less as the phone fills up.
 */
class ImageStore(
    private val dir: File,
    private val maxBytes: Long = 250L * 1024 * 1024,
    private val targetBytes: Long = 200L * 1024 * 1024,
    private val unusedMs: Long = 30L * 24 * 3600 * 1000,
    private val background: Executor = Executors.newFixedThreadPool(2) { r -> Thread(r, "harbor-img").apply { isDaemon = true } },
    /** Free space where the images are kept (a parameter for the tests). */
    private val freeSpace: () -> Long = { dir.usableSpace },
) {
    private val total = AtomicLong(0)
    private val checking = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var freeAt = 0L
    @Volatile private var freeSeen = Long.MAX_VALUE

    init {
        dir.mkdirs()
    }

    data class Meta(
        val url: String,
        val mime: String,
        val etag: String?,
        val lastModified: String?,
        val storedAt: Long,
        val maxAgeMs: Long,
        val immutable: Boolean,
    ) {
        fun stale(now: Long) = !immutable && now - storedAt > maxAgeMs

        fun encode(): String = listOf(url, mime, etag ?: "", lastModified ?: "", "$storedAt", "$maxAgeMs", if (immutable) "1" else "0")
            .joinToString("\n") { it.replace("\n", " ") }

        companion object {
            fun decode(s: String): Meta? {
                val p = s.split("\n")
                if (p.size < 7) return null
                return Meta(
                    p[0], p[1], p[2].ifBlank { null }, p[3].ifBlank { null },
                    p[4].toLongOrNull() ?: return null, p[5].toLongOrNull() ?: return null, p[6] == "1",
                )
            }
        }
    }

    class Cached(val file: File, val meta: Meta) {
        val stale: Boolean get() = meta.stale(System.currentTimeMillis())
    }

    private fun bodyFile(key: String) = File(dir, key)
    private fun metaFile(key: String) = File(dir, "$key.m")

    /** The saved copy, if any (and marks it as recently shown). */
    fun cached(url: String): Cached? {
        val key = keyFor(url)
        val body = bodyFile(key)
        if (!body.exists()) return null
        val meta = try { Meta.decode(metaFile(key).readText()) } catch (_: IOException) { null } ?: return null
        if (meta.url != url) return null
        val now = System.currentTimeMillis()
        if (now - body.lastModified() > TOUCH_EVERY_MS) body.setLastModified(now)
        return Cached(body, meta)
    }

    /** Streams a new image; it's saved once read to the end. Throws (on first read) for an error status. */
    fun download(url: String, headers: Map<String, String>): InputStream = NetworkStream(url, headers)

    /** Re-check a stale saved image in the background (at most one check per image at a time). */
    fun recheck(url: String, meta: Meta, headers: Map<String, String>) {
        val key = keyFor(url)
        if (!checking.add(key)) return
        background.execute {
            try {
                recheckNow(url, meta, headers)
            } finally {
                checking.remove(key)
            }
        }
    }

    /** What recheck() does; returns what happened ("same", "updated", "removed", "kept"). */
    fun recheckNow(url: String, meta: Meta, headers: Map<String, String>): String {
        val key = keyFor(url)
        val h = headers.toMutableMap()
        meta.etag?.let { h["If-None-Match"] = it }
        meta.lastModified?.let { h["If-Modified-Since"] = it }
        return try {
            val c = open(url, h)
            try {
                when (c.responseCode) {
                    304 -> {
                        writeMeta(key, meta.copy(storedAt = System.currentTimeMillis(), maxAgeMs = maxAgeFrom(c) ?: meta.maxAgeMs))
                        "same"
                    }
                    200 -> {
                        val m = metaFrom(url, c) ?: return "kept"
                        val t = File(dir, "$key.${System.nanoTime()}.tmp")
                        var n = 0L
                        c.inputStream.use { input ->
                            FileOutputStream(t).use { o ->
                                val buf = ByteArray(64 * 1024)
                                while (true) {
                                    val r = input.read(buf)
                                    if (r < 0) break
                                    o.write(buf, 0, r)
                                    n += r
                                    if (n > MAX_ENTRY_BYTES) throw IOException("too large")
                                }
                            }
                        }
                        if (n > 0) {
                            commit(key, t, m)
                            "updated"
                        } else {
                            t.delete()
                            "kept"
                        }
                    }
                    404, 410 -> {
                        remove(key)
                        "removed"
                    }
                    else -> "kept"
                }
            } finally {
                c.disconnect()
            }
        } catch (_: Exception) {
            "kept" // offline or the server is down: keep showing the saved one
        }
    }

    // ---- network ---------------------------------------------------------------------------

    private fun open(url: String, headers: Map<String, String>): HttpURLConnection {
        var target = URL(url)
        repeat(MAX_REDIRECTS) {
            val c = target.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            // A picture that doesn't come in time isn't worth holding a download slot for.
            c.connectTimeout = 8_000
            c.readTimeout = 12_000
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            val code = c.responseCode
            if (code in 300..399 && code != 304) {
                val loc = c.getHeaderField("Location")
                c.disconnect()
                if (loc.isNullOrBlank()) throw IOException("redirect without a location")
                target = URL(target, loc)
                return@repeat
            }
            return c
        }
        throw IOException("too many redirects")
    }

    private fun maxAgeFrom(c: HttpURLConnection): Long? {
        val cc = c.getHeaderField("Cache-Control") ?: return null
        val secs = MAX_AGE_RX.find(cc)?.groupValues?.get(1)?.toLongOrNull() ?: return null
        return (secs * 1000).coerceIn(MIN_CHECK_MS, MAX_CHECK_MS)
    }

    /** null = don't keep it (not an image, or the server says not to). */
    private fun metaFrom(url: String, c: HttpURLConnection): Meta? {
        val type = c.contentType?.substringBefore(';')?.trim()?.lowercase() ?: return null
        if (!type.startsWith("image/")) return null
        val cc = c.getHeaderField("Cache-Control") ?: ""
        if (cc.contains("no-store", true)) return null
        return Meta(
            url, type, c.getHeaderField("ETag"), c.getHeaderField("Last-Modified"), System.currentTimeMillis(),
            maxAgeFrom(c) ?: DEFAULT_CHECK_MS, isImmutable(url),
        )
    }

    private inner class NetworkStream(private val url: String, private val headers: Map<String, String>) : InputStream() {
        private val key = keyFor(url)
        private var conn: HttpURLConnection? = null
        private var src: InputStream? = null
        private var tmp: File? = null
        private var out: OutputStream? = null
        private var meta: Meta? = null
        private var expected = -1L
        private var count = 0L
        private var finished = false

        private fun source(): InputStream {
            src?.let { return it }
            val c = open(url, headers)
            conn = c
            val code = c.responseCode
            if (code != 200) {
                c.disconnect()
                throw IOException("HTTP $code") // the <img> fails, the page tries its fallback
            }
            expected = c.contentLengthLong
            meta = metaFrom(url, c)?.takeIf { expected <= MAX_ENTRY_BYTES }
            if (meta != null) {
                try {
                    val t = File(dir, "$key.${System.nanoTime()}.tmp")
                    out = BufferedOutputStream(FileOutputStream(t), 64 * 1024)
                    tmp = t
                } catch (_: IOException) {
                    meta = null
                }
            }
            return c.inputStream.also { src = it }
        }

        override fun read(): Int {
            val one = ByteArray(1)
            val n = read(one, 0, 1)
            return if (n < 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = try {
                source().read(b, off, len)
            } catch (e: IOException) {
                abandon()
                throw e
            }
            if (n < 0) {
                finish(eof = true)
                return -1
            }
            out?.let { o ->
                try {
                    o.write(b, off, n)
                } catch (_: IOException) {
                    abandon() // storage full etc.: still show it, just don't keep it
                }
            }
            count += n
            if (count > MAX_ENTRY_BYTES) abandon()
            return n
        }

        override fun close() {
            finish(eof = false)
            try {
                src?.close()
            } catch (_: IOException) {
            }
            conn?.disconnect()
        }

        private fun abandon() {
            try {
                out?.close()
            } catch (_: IOException) {
            }
            out = null
            tmp?.delete()
            tmp = null
            meta = null
        }

        private fun finish(eof: Boolean) {
            if (finished) return
            finished = true
            val o = out ?: return
            val t = tmp ?: return
            val m = meta ?: return
            out = null
            try {
                o.close()
            } catch (_: IOException) {
                t.delete()
                return
            }
            // Whole picture received: keep it. Cut short (scrolled away…): drop it.
            val complete = if (expected >= 0) count == expected else eof
            if (complete && count > 0) commit(key, t, m) else t.delete()
        }
    }

    // ---- storage ---------------------------------------------------------------------------

    private fun commit(key: String, tmp: File, meta: Meta) {
        val body = bodyFile(key)
        val old = if (body.exists()) body.length() else 0L
        val size = tmp.length()
        if (!tmp.renameTo(body)) {
            tmp.delete()
            return
        }
        writeMeta(key, meta)
        if (total.addAndGet(size - old) > limitBytes()) background.execute { evict() }
    }

    private fun writeMeta(key: String, meta: Meta) {
        try {
            val t = File(dir, "$key.m.${System.nanoTime()}.tmp")
            t.writeText(meta.encode())
            if (!t.renameTo(metaFile(key))) t.delete()
        } catch (_: IOException) {
        }
    }

    private fun remove(key: String) {
        val body = bodyFile(key)
        val size = if (body.exists()) body.length() else 0L
        body.delete()
        metaFile(key).delete()
        total.addAndGet(-size)
    }

    /** Startup: count what's there, drop leftovers and images not shown for unusedMs. */
    fun sweep() {
        val files = dir.listFiles() ?: return
        val now = System.currentTimeMillis()
        var sum = 0L
        for (f in files) {
            val name = f.name
            when {
                name.endsWith(".tmp") -> if (now - f.lastModified() > 3_600_000L) f.delete()
                name.endsWith(".m") -> if (!File(dir, name.removeSuffix(".m")).exists()) f.delete()
                now - f.lastModified() > unusedMs -> {
                    f.delete()
                    metaFile(name).delete()
                }
                else -> sum += f.length()
            }
        }
        total.set(sum)
        if (sum > limitBytes()) evict()
    }

    /** Over the limit: remove the least recently shown images until under the target. */
    @Synchronized
    fun evict() {
        val bodies = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".m") && !it.name.endsWith(".tmp") } ?: return
        var sum = bodies.sumOf { it.length() }
        val limit = limitBytes()
        if (sum > limit) {
            val target = targetFor(limit)
            for (f in bodies.sortedBy { it.lastModified() }) {
                if (sum <= target) break
                sum -= f.length()
                f.delete()
                metaFile(f.name).delete()
            }
        }
        total.set(sum)
    }

    /** Back in the app (the phone may have filled up meanwhile): over today's limit = tidy now. */
    fun trim() {
        freeAt = 0L
        if (usedBytes() > limitBytes()) evict()
    }

    /** Empties the cache (Settings > Clear). Pictures being saved right now are dropped too. */
    @Synchronized
    fun clear() {
        dir.listFiles()?.forEach { if (it.isFile) it.delete() }
        total.set(0)
    }

    fun usedBytes(): Long = total.get()

    /**
     * How much the images may take: all of maxBytes with [ROOMY_FREE] or more free on the phone,
     * 60% of it with [TIGHT_FREE] or more, 40% below that (250 / 150 / 100 MB by default).
     */
    fun limitBytes(): Long {
        val free = freeBytes()
        return when {
            free >= ROOMY_FREE -> maxBytes
            free >= TIGHT_FREE -> maxBytes * 3 / 5
            else -> maxBytes * 2 / 5
        }
    }

    /** Free space on the phone (read at most once a minute). */
    fun freeBytes(): Long {
        val now = System.currentTimeMillis()
        if (now - freeAt > FREE_CHECK_MS) {
            freeSeen = try {
                freeSpace()
            } catch (_: Exception) {
                Long.MAX_VALUE
            }
            freeAt = now
        }
        return freeSeen
    }

    private fun targetFor(limit: Long): Long = if (maxBytes <= 0) 0 else limit * targetBytes / maxBytes

    companion object {
        const val MAX_ENTRY_BYTES = 12L * 1024 * 1024
        /** Free space above which the images get their whole limit… */
        const val ROOMY_FREE = 5L * 1024 * 1024 * 1024
        /** …and below which they get the smallest. */
        const val TIGHT_FREE = 2L * 1024 * 1024 * 1024
        private const val FREE_CHECK_MS = 60_000L
        private const val TOUCH_EVERY_MS = 10L * 60 * 1000
        private const val DEFAULT_CHECK_MS = 24L * 3600 * 1000
        private const val MIN_CHECK_MS = 3_600_000L // re-check at most hourly…
        private const val MAX_CHECK_MS = 24L * 3600 * 1000 // …and at least daily
        private const val MAX_REDIRECTS = 5
        private const val TABLET_SHORT_SIDE_PX = 1600

        private val MAX_AGE_RX = Regex("max-age=(\\d+)", RegexOption.IGNORE_CASE)
        private val TMDB_ORIGINAL = Regex("(https?://image\\.tmdb\\.org/t/p/)original(/.+)", RegexOption.IGNORE_CASE)
        private val TMDB_SIZED = Regex("(https?://image\\.tmdb\\.org/t/p/)(w\\d+)(/.+)", RegexOption.IGNORE_CASE)
        private val METAHUB_BACKGROUND = Regex("(https?://images\\.metahub\\.space/background/)(small|medium)(/.+)", RegexOption.IGNORE_CASE)

        fun keyFor(url: String): String =
            MessageDigest.getInstance("SHA-1").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }

        /** TMDB never changes a picture under the same address (a new one gets a new file name). */
        fun isImmutable(url: String) = url.startsWith("https://image.tmdb.org/t/p/") || url.startsWith("http://image.tmdb.org/t/p/")

        /** TMDB "original" (often 4K) is far more than a phone screen shows: use the 1280px one.
         *  Tablets keep full size; SVG logos only exist as originals. */
        fun phoneSized(url: String, screenShortSidePx: Int): String {
            if (screenShortSidePx > TABLET_SHORT_SIDE_PX) return url
            val m = TMDB_ORIGINAL.matchEntire(url) ?: return url
            if (m.groupValues[2].lowercase().endsWith(".svg")) return url
            return m.groupValues[1] + "w1280" + m.groupValues[2]
        }

        /**
         * A full-width, tall picture cut from a wide one (a title's hero is ~1800px high on a
         * phone, its backdrop 16:9): the largest version, since only its middle is shown, and a
         * 780 or 1280px one is blown up two to four times. (Only the part shown is decoded.)
         */
        fun heroSized(url: String): String {
            TMDB_SIZED.matchEntire(url)?.let { m ->
                if (m.groupValues[3].lowercase().endsWith(".svg")) return url
                return m.groupValues[1] + "original" + m.groupValues[3]
            }
            METAHUB_BACKGROUND.matchEntire(url)?.let { m -> return m.groupValues[1] + "large" + m.groupValues[3] }
            return url
        }
    }
}
