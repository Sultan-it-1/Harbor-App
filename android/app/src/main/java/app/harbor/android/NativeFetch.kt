package app.harbor.android

import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * CORS-free HTTP for the web UI. This replaces the /api-proxy route that server.js
 * provides on the hosted web build (addons without CORS headers, debrid REST APIs,
 * Stremio API logins). Response bodies travel back base64-encoded.
 */
class NativeFetch(
    /** Body to base64 text (android.util.Base64 works on API 24; the JVM tests pass java.util's). */
    private val encode: (ByteArray) -> String = { Base64.encodeToString(it, Base64.NO_WRAP) },
    private val maxBodyBytes: Int = MAX_BODY_BYTES,
    private val done: (id: String, resultJson: String) -> Unit,
) {
    // Mostly waiting on the network, so plenty of threads: a search asks dozens of addons at
    // once and a few dead ones used to hold up everything queued behind them.
    private val pool = Executors.newFixedThreadPool(12)
    private val tasks = ConcurrentHashMap<String, Future<*>>()
    private val conns = ConcurrentHashMap<String, HttpURLConnection>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private val started = ConcurrentHashMap.newKeySet<String>()
    @Volatile var userAgent: String = "Mozilla/5.0 (Linux; Android) HarborAndroid"

    fun enqueue(id: String, requestJson: String) {
        val f = pool.submit {
            started.add(id)
            try {
                // Cancelled while it waited in the queue: don't even start it.
                if (cancelled.remove(id)) return@submit
                val result = run(id, requestJson)
                // The page gave up on it (cancel): nobody is waiting for the answer.
                if (!cancelled.remove(id)) done(id, result)
            } finally {
                started.remove(id)
                tasks.remove(id)
                conns.remove(id)
            }
        }
        tasks[id] = f
        if (f.isDone) tasks.remove(id)
    }

    /**
     * Drops a request that hasn't started, or breaks one that is running (frees its thread).
     * (Future.cancel(false) also "succeeds" on a running task without stopping it, so a running
     * request is stopped by closing its connection.)
     */
    fun cancel(id: String) {
        val f = tasks.remove(id) ?: return // already finished
        cancelled.add(id)
        conns.remove(id)?.let { try { it.disconnect() } catch (_: Exception) {} }
        if (f.cancel(false) && !started.contains(id)) {
            // Never started and never will: nothing else would clear the mark.
            cancelled.remove(id)
        }
    }

    fun shutdown() = pool.shutdownNow()

    private fun run(id: String, requestJson: String): String {
        val out = JSONObject()
        try {
            val req = JSONObject(requestJson)
            val method = req.optString("method", "GET").uppercase()
            val timeout = req.optInt("timeoutMs", 30_000)
            var url = URL(req.getString("url"))
            if (url.protocol != "http" && url.protocol != "https") throw IllegalArgumentException("unsupported scheme ${url.protocol}")
            val headers = req.optJSONObject("headers")
            var body = if (req.has("body") && !req.isNull("body")) req.getString("body") else null
            var currentMethod = method
            // Credentials are only sent to the host they were meant for (like fetch()).
            val firstHost = url.host.lowercase()

            var conn: HttpURLConnection
            var redirects = 0
            while (true) {
                if (cancelled.contains(id)) throw java.io.IOException("cancelled")
                conn = url.openConnection() as HttpURLConnection
                conns[id] = conn
                conn.instanceFollowRedirects = false
                conn.connectTimeout = timeout
                conn.readTimeout = timeout
                conn.requestMethod = currentMethod
                conn.setRequestProperty("User-Agent", userAgent)
                val sameHost = url.host.lowercase() == firstHost
                headers?.keys()?.forEach { k ->
                    // HttpURLConnection handles gzip itself only when it set the header.
                    if (k.equals("accept-encoding", true) || k.equals("host", true) || k.equals("content-length", true)) return@forEach
                    if (!sameHost && (k.equals("authorization", true) || k.equals("cookie", true) || k.equals("proxy-authorization", true))) return@forEach
                    conn.setRequestProperty(k, headers.getString(k))
                }
                if (body != null && currentMethod != "GET" && currentMethod != "HEAD") {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body!!.toByteArray(Charsets.UTF_8)) }
                }
                val code = conn.responseCode
                if (code in 300..399 && code != 304 && redirects < 8) {
                    val loc = conn.getHeaderField("Location")
                    if (loc != null) {
                        val next = URL(url, loc)
                        conn.disconnect()
                        if (next.protocol != "http" && next.protocol != "https") break
                        // 303, and 301/302 after a POST, continue as a GET without the body;
                        // 307/308 repeat the request as it was.
                        if (code == 303 || ((code == 301 || code == 302) && currentMethod == "POST")) {
                            currentMethod = "GET"
                            body = null
                        }
                        url = next
                        redirects++
                        continue
                    }
                }
                break
            }

            val status = conn.responseCode
            val stream: InputStream? = if (status >= 400) conn.errorStream else try { conn.inputStream } catch (_: Exception) { conn.errorStream }
            val bytes = stream?.use { readAll(it, maxBodyBytes) } ?: ByteArray(0)
            val hdrs = JSONObject()
            conn.headerFields.forEach { (k, v) ->
                if (k != null && v != null && !k.equals("content-encoding", true) && !k.equals("transfer-encoding", true) && !k.equals("content-length", true)) {
                    hdrs.put(k.lowercase(), v.joinToString(", "))
                }
            }
            conn.disconnect()
            out.put("ok", true)
            out.put("status", status)
            out.put("url", url.toString())
            out.put("headers", hdrs)
            out.put("body", encode(bytes))
        } catch (e: Exception) {
            out.put("ok", false)
            out.put("error", e.javaClass.simpleName + ": " + (e.message ?: ""))
        }
        return out.toString()
    }

    /** Whole body, up to [max] bytes (the answer travels to the page as base64 text). */
    private fun readAll(s: InputStream, max: Int): ByteArray {
        val buf = ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        while (true) {
            val n = s.read(chunk)
            if (n < 0) break
            if (buf.size() + n > max) throw java.io.IOException("response larger than ${max / (1024 * 1024)} MB ($max bytes)")
            buf.write(chunk, 0, n)
        }
        return buf.toByteArray()
    }

    companion object {
        /** Plenty for an 11k-channel IPTV list; a runaway answer must not exhaust memory. */
        const val MAX_BODY_BYTES = 64 * 1024 * 1024
    }
}
