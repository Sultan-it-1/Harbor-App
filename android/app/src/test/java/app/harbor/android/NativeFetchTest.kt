package app.harbor.android

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The page's CORS-free fetch: cancelling, redirects and the body cap. */
class NativeFetchTest {
    private val results = ConcurrentHashMap<String, JSONObject>()
    private val latches = ConcurrentHashMap<String, CountDownLatch>()
    private val servers = mutableListOf<MiniHttpServer>()

    private fun fetcher(maxBody: Int = NativeFetch.MAX_BODY_BYTES) =
        NativeFetch(encode = { Base64.getEncoder().encodeToString(it) }, maxBodyBytes = maxBody) { id, json ->
            results[id] = JSONObject(json)
            latches[id]?.countDown()
        }

    private fun server(handler: (String, String, Map<String, String>, java.io.OutputStream) -> Unit) =
        MiniHttpServer(handler).also { servers += it }

    private fun request(f: NativeFetch, id: String, url: String, method: String = "GET", headers: Map<String, String> = emptyMap(), body: String? = null) {
        latches[id] = CountDownLatch(1)
        val req = JSONObject().put("url", url).put("method", method).put("timeoutMs", 10_000)
        if (headers.isNotEmpty()) req.put("headers", JSONObject(headers))
        if (body != null) req.put("body", body)
        f.enqueue(id, req.toString())
    }

    private fun await(id: String, seconds: Long = 10): JSONObject? {
        latches[id]?.await(seconds, TimeUnit.SECONDS)
        return results[id]
    }

    @After
    fun tearDown() = servers.forEach { it.close() }

    @Test
    fun returnsStatusHeadersAndBody() {
        val s = server { _, _, _, out -> MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "5", "X-Test" to "yes"), "hello".toByteArray()) }
        val f = fetcher()
        request(f, "a", "${s.base}/x")
        val r = await("a")!!
        assertTrue(r.getBoolean("ok"))
        assertEquals(200, r.getInt("status"))
        assertEquals("yes", r.getJSONObject("headers").getString("x-test"))
        assertEquals("hello", String(Base64.getDecoder().decode(r.getString("body"))))
        f.shutdown()
    }

    @Test
    fun cancellingARunningRequestFreesItAndNeverAnswers() {
        val release = CountDownLatch(1)
        val s = server { _, path, _, out ->
            if (path == "/slow") release.await(20, TimeUnit.SECONDS)
            MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "2"), "ok".toByteArray())
        }
        val f = fetcher()
        request(f, "slow", "${s.base}/slow")
        Thread.sleep(400) // running: connected and waiting for the answer
        f.cancel("slow")
        // The page stopped waiting: no answer may arrive for it, even once the server replies.
        release.countDown()
        Thread.sleep(600)
        assertNull(results["slow"])
        // And the pool still works.
        request(f, "next", "${s.base}/fast")
        assertTrue(await("next")!!.getBoolean("ok"))
        f.shutdown()
    }

    @Test
    fun cancellingAQueuedRequestDropsIt() {
        val f = fetcher()
        // The server answers only after the cancel: a local server answering at once could deliver
        // the reply before the test got to cancel it (a race in the test, not in NativeFetch).
        val release = CountDownLatch(1)
        val s = server { _, _, _, out ->
            release.await(5, TimeUnit.SECONDS)
            MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "0"))
        }
        f.cancel("never-sent") // unknown id: no-op
        request(f, "q", "${s.base}/q")
        f.cancel("q")
        release.countDown()
        Thread.sleep(500)
        // Either it was dropped before starting, or broken while running: never answered.
        assertNull(results["q"])
        f.shutdown()
    }

    @Test
    fun credentialsAreNotForwardedToAnotherHost() {
        var sawAuth: String? = "unset"
        val other = server { _, _, headers, out ->
            sawAuth = headers["authorization"]
            MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "0"))
        }
        // 127.0.0.1 redirects to "localhost": same machine, but another host name.
        val first = server { _, _, _, out -> MiniHttpServer.respond(out, 302, mapOf("Location" to "http://localhost:${other.port}/after")) }
        val f = fetcher()
        request(f, "r", "${first.base}/start", headers = mapOf("Authorization" to "Bearer secret"))
        val r = await("r")!!
        assertTrue(r.getBoolean("ok"))
        assertEquals(200, r.getInt("status"))
        assertNull(sawAuth)
        f.shutdown()
    }

    @Test
    fun seeOtherAfterPostContinuesAsGet() {
        var method: String? = null
        val s = server { m, path, _, out ->
            if (path == "/form") MiniHttpServer.respond(out, 303, mapOf("Location" to "/done"))
            else { method = m; MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "0")) }
        }
        val f = fetcher()
        request(f, "p", "${s.base}/form", method = "POST", body = "a=1")
        assertTrue(await("p")!!.getBoolean("ok"))
        assertEquals("GET", method)
        f.shutdown()
    }

    @Test
    fun bodyOverTheCapIsAnErrorNotAnAnswer() {
        val big = ByteArray(300_000) { 'x'.code.toByte() }
        val s = server { _, _, _, out -> MiniHttpServer.respond(out, 200, mapOf("Content-Length" to big.size.toString()), big) }
        val f = fetcher(maxBody = 100_000)
        request(f, "big", "${s.base}/big")
        val r = await("big")!!
        assertFalse(r.getBoolean("ok"))
        assertTrue(r.getString("error").contains("larger than"))
        f.shutdown()
    }

    @Test
    fun onlyHttpAndHttpsAreFetched() {
        val f = fetcher()
        request(f, "file", "file:///etc/hosts")
        val r = await("file")!!
        assertFalse(r.getBoolean("ok"))
        assertTrue(r.getString("error").contains("unsupported scheme"))
        f.shutdown()
    }
}
