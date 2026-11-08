package app.harbor.android

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.concurrent.Executors

/**
 * Keeps the posters and backdrops the web UI shows on the phone (ImageStore), so they come up
 * at once next time — and offline — and caps oversized TMDB images at what a phone screen shows.
 *
 * The WebView asks shouldInterceptRequest one request at a time, so this never waits on the
 * network itself: a saved image is handed over from storage, a new one as a stream that
 * downloads (on the WebView's reader thread, in parallel with the others) and is saved as it
 * arrives — one download per image, nothing held up. A saved image that may have changed is
 * re-checked in the background and replaced if it did.
 */
class ImageCache(context: Context, private val screenShortSidePx: Int) {
    @Volatile var userAgent: String = "HarborAndroid"

    /** Also read by the native screens (NativeImages), so both share one cache. */
    val store = ImageStore(File(context.cacheDir, "images"))

    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "harbor-img-sweep").apply { isDaemon = true } }

    init {
        worker.execute { store.sweep() }
    }

    /** Back in the app: tidy up if the phone filled up meanwhile (off the main thread). */
    fun trimSoon() = worker.execute { store.trim() }

    /** null = let the WebView load it itself (not an image, or anything went wrong here). */
    fun intercept(req: WebResourceRequest): WebResourceResponse? = try {
        interceptImage(req)
    } catch (_: Exception) {
        null
    }

    private fun interceptImage(req: WebResourceRequest): WebResourceResponse? {
        if (!req.method.equals("GET", true) || req.isForMainFrame) return null
        val uri = req.url
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") return null
        val host = uri.host?.lowercase() ?: return null
        if (host == WebAssets.HOST) return null
        val path = uri.path?.lowercase() ?: ""
        val accept = header(req, "Accept")
        if (accept != null && !accept.startsWith("image/") && mimeFor(path) == null) return null
        // The WebView needs the type before the server answers: known from the extension, or
        // from hosts that only serve pictures (the decoder reads the real format from the data).
        val mime = mimeFor(path) ?: if (host in RASTER_HOSTS) "image/jpeg" else return null

        val target = ImageStore.phoneSized(uri.toString(), screenShortSidePx)
        val headers = forwardHeaders(req)
        val hit = store.cached(target)
        if (hit != null) {
            if (hit.stale) store.recheck(target, hit.meta, headers)
            return response(hit.meta.mime, hit.file.length(), FileInputStream(hit.file))
        }
        return response(mime, -1, store.download(target, headers))
    }

    private fun header(req: WebResourceRequest, name: String): String? =
        req.requestHeaders?.entries?.firstOrNull { it.key.equals(name, true) }?.value

    private fun forwardHeaders(req: WebResourceRequest): Map<String, String> {
        val h = HashMap<String, String>()
        header(req, "Accept")?.let { h["Accept"] = it }
        header(req, "Referer")?.let { h["Referer"] = it }
        h["User-Agent"] = userAgent
        return h
    }

    private fun response(mime: String, length: Long, data: InputStream): WebResourceResponse {
        val headers = HashMap<String, String>()
        headers["Access-Control-Allow-Origin"] = "*"
        if (length >= 0) headers["Content-Length"] = length.toString()
        return WebResourceResponse(mime, null, 200, "OK", headers, data)
    }

    companion object {
        /** Hosts that only serve pictures (paths often have no extension, e.g. metahub's ".../img"). */
        private val RASTER_HOSTS = setOf(
            "image.tmdb.org", "images.metahub.space", "episodes.metahub.space", "live.metahub.space",
            "api.ratingposterdb.com", "img.youtube.com", "i.ytimg.com", "artworks.thetvdb.com",
            "assets.fanart.tv", "m.media-amazon.com", "media.kitsu.app", "media.kitsu.io",
            "cdn.myanimelist.net", "s4.anilist.co", "img.anili.st",
        )

        private fun mimeFor(path: String): String? = when {
            path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
            path.endsWith(".png") -> "image/png"
            path.endsWith(".webp") -> "image/webp"
            path.endsWith(".gif") -> "image/gif"
            path.endsWith(".avif") -> "image/avif"
            path.endsWith(".svg") -> "image/svg+xml"
            else -> null
        }
    }
}
