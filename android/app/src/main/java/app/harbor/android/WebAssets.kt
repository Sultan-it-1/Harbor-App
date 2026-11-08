package app.harbor.android

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException

/**
 * Serves the bundled web build (assets/www) at https://appassets.androidplatform.net/.
 * An https origin keeps localStorage, IndexedDB and secure-context APIs working, and
 * unknown extension-less paths fall back to index.html like the web server does.
 *
 * [headScript] is put at the very top of index.html, before any of the page's own scripts
 * (MainActivity uses it to hand the bridge token to the app's page only). index.html is served
 * without Access-Control-Allow-Origin, so no other origin can read that script.
 */
class WebAssets(private val context: Context, private val headScript: String) {
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host != HOST) return null
        if (request.method != "GET" && request.method != "HEAD") return null
        var path = (url.path ?: "/").trimStart('/')
        if (path.isEmpty()) path = "index.html"
        // The service worker is for the hosted PWA only; the app ships its files locally.
        if (path == "sw.js") return notFound()
        return open(path) ?: if (!path.substringAfterLast('/').contains('.')) open("index.html") else notFound()
    }

    private fun open(path: String): WebResourceResponse? = try {
        if (path == "index.html") openIndex() else openAsset(path)
    } catch (_: FileNotFoundException) {
        null
    } catch (_: java.io.IOException) {
        null
    }

    private fun openIndex(): WebResourceResponse {
        val html = context.assets.open("www/index.html").use { it.readBytes().toString(Charsets.UTF_8) }
        val tag = "<script>$headScript</script>"
        val at = html.indexOf("<head>", ignoreCase = true)
        val out = if (at >= 0) html.substring(0, at + 6) + tag + html.substring(at + 6) else tag + html
        return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(out.toByteArray(Charsets.UTF_8))).apply {
            responseHeaders = mapOf("Cache-Control" to "no-cache")
        }
    }

    private fun openAsset(path: String): WebResourceResponse {
        val stream = context.assets.open("www/$path")
        val mime = mimeFor(path)
        return WebResourceResponse(mime, if (mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json")) "utf-8" else null, stream).apply {
            responseHeaders = mapOf(
                "Access-Control-Allow-Origin" to "*",
                "Cache-Control" to "max-age=31536000",
            )
        }
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())

    companion object {
        const val HOST = "appassets.androidplatform.net"

        private val MIME = mapOf(
            "html" to "text/html",
            "htm" to "text/html",
            "js" to "application/javascript",
            "mjs" to "application/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "map" to "application/json",
            "webmanifest" to "application/manifest+json",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "avif" to "image/avif",
            "ico" to "image/x-icon",
            "woff" to "font/woff",
            "woff2" to "font/woff2",
            "ttf" to "font/ttf",
            "otf" to "font/otf",
            "wasm" to "application/wasm",
            "txt" to "text/plain",
            "xml" to "application/xml",
            "mp4" to "video/mp4",
            "webm" to "video/webm",
            "mp3" to "audio/mpeg",
            "lottie" to "application/json",
        )

        fun mimeFor(path: String): String =
            MIME[path.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
    }
}
