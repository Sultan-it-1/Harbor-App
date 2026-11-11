package app.harbor.android

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Following redirects without handing out the page's logins. A request's Authorization / Cookie
 * headers are meant for the host it was made to: when a redirect leads to another host they stay
 * behind (as fetch() and curl do), while everything else (Referer, Range…) still goes along.
 *
 * One rule for the page's fetch (NativeFetch), downloads (HttpTransfer) and playback
 * (GuardedHttpDataSource). No Android APIs here, so it runs in plain JVM unit tests.
 */
object RedirectGuard {
    const val MAX_REDIRECTS = 20

    fun isCredential(header: String): Boolean =
        header.equals("authorization", true) || header.equals("cookie", true) || header.equals("proxy-authorization", true)

    /** May [header] go to [host], on a request that was first made to [firstHost]? */
    fun maySend(header: String, firstHost: String, host: String): Boolean =
        host.equals(firstHost, ignoreCase = true) || !isCredential(header)

    /**
     * Opens [first] and follows redirects by hand, up to the first answer that isn't one; that
     * connection is returned with its response ready. (Left to follow them itself, the system
     * repeats the headers it was given at every hop.) [headers] go on each request, minus the
     * logins once the host changes; [finish] then sets what the caller always wants (timeouts,
     * Range, User-Agent), over any header of the same name.
     */
    fun open(first: URL, method: String, body: ByteArray?, headers: Map<String, String>, finish: (HttpURLConnection) -> Unit): HttpURLConnection {
        var url = first
        var verb = method
        var payload = body
        repeat(MAX_REDIRECTS + 1) {
            val c = url.openConnection() as HttpURLConnection
            val code = try {
                for ((k, v) in headers) if (maySend(k, first.host, url.host)) c.setRequestProperty(k, v)
                finish(c)
                c.instanceFollowRedirects = false
                c.requestMethod = verb
                val out = payload
                if (out != null) {
                    c.doOutput = true
                    c.setFixedLengthStreamingMode(out.size)
                    c.outputStream.use { it.write(out) }
                }
                c.responseCode
            } catch (e: IOException) {
                c.disconnect()
                throw e
            }
            // GET and HEAD follow every kind of redirect; a POST follows 300-303 as a GET without
            // its body, and gets a 307/308 back as the answer.
            val redirect = when (verb) {
                "GET", "HEAD" -> code in 300..303 || code == 307 || code == 308
                "POST" -> code in 300..303
                else -> false
            }
            if (!redirect) return c
            val location = c.getHeaderField("Location")
            c.disconnect()
            if (location.isNullOrBlank()) throw IOException("redirect without a location")
            val next = URL(url, location)
            if (next.protocol != "http" && next.protocol != "https") throw IOException("redirect to an unsupported address (${next.protocol})")
            if (verb == "POST") {
                verb = "GET"
                payload = null
            }
            url = next
        }
        throw IOException("too many redirects")
    }
}
