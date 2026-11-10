package app.harbor.android

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/** Redirects followed by hand (playback with a login): where the login headers go and where they don't. */
class RedirectGuardTest {
    private val servers = mutableListOf<MiniHttpServer>()

    /** What each path was asked with: "GET /path" -> the request's headers. */
    private val seen = ConcurrentHashMap<String, Map<String, String>>()

    private fun server(handler: (path: String, out: OutputStream) -> Unit) =
        MiniHttpServer { method, path, headers, out ->
            seen["$method $path"] = headers
            handler(path, out)
        }.also { servers += it }

    private val login = mapOf("Authorization" to "Bearer secret", "Cookie" to "session=1", "Referer" to "https://example.org/")

    private fun open(url: String, method: String = "GET", body: ByteArray? = null, headers: Map<String, String> = login): HttpURLConnection =
        RedirectGuard.open(URL(url), method, body, headers) { c ->
            c.connectTimeout = 5_000
            c.readTimeout = 5_000
            c.setRequestProperty("Range", "bytes=0-")
        }

    @After
    fun tearDown() = servers.forEach { it.close() }

    @Test
    fun aRedirectToAnotherHostGoesWithoutTheLogin() {
        val other = server { _, out -> MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "2"), "ok".toByteArray()) }
        // 127.0.0.1 redirects to "localhost": the same machine, but another host name.
        val first = server { _, out -> MiniHttpServer.respond(out, 302, mapOf("Location" to "http://localhost:${other.port}/video")) }
        val c = open("${first.base}/start")
        assertEquals(200, c.responseCode)
        assertEquals("localhost", c.url.host)
        c.disconnect()

        assertEquals("Bearer secret", seen["GET /start"]!!["authorization"])
        assertEquals("session=1", seen["GET /start"]!!["cookie"])
        val there = seen["GET /video"]!!
        assertNull(there["authorization"])
        assertNull(there["cookie"])
        // Everything else still goes along.
        assertEquals("https://example.org/", there["referer"])
        assertEquals("bytes=0-", there["range"])
    }

    @Test
    fun aRedirectOnTheSameHostKeepsTheLogin() {
        val s = server { path, out ->
            if (path == "/start") MiniHttpServer.respond(out, 307, mapOf("Location" to "/video"))
            else MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "0"))
        }
        open("${s.base}/start").disconnect()
        assertEquals("Bearer secret", seen["GET /video"]!!["authorization"])
        assertEquals("session=1", seen["GET /video"]!!["cookie"])
    }

    @Test
    fun comingBackToTheFirstHostBringsTheLoginBack() {
        lateinit var first: MiniHttpServer
        val other = server { _, out -> MiniHttpServer.respond(out, 302, mapOf("Location" to "http://127.0.0.1:${first.port}/end")) }
        first = server { path, out ->
            if (path == "/start") MiniHttpServer.respond(out, 302, mapOf("Location" to "http://localhost:${other.port}/hop"))
            else MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "0"))
        }
        open("${first.base}/start").disconnect()
        assertNull(seen["GET /hop"]!!["authorization"])
        assertEquals("Bearer secret", seen["GET /end"]!!["authorization"])
    }

    @Test
    fun whatTheCallerSetsWinsOverAPageHeaderOfTheSameName() {
        val s = server { _, out -> MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "0")) }
        open("${s.base}/x", headers = mapOf("range" to "bytes=999-")).disconnect()
        assertEquals("bytes=0-", seen["GET /x"]!!["range"])
    }

    @Test
    fun aPostRedirectedWith303ContinuesAsGet() {
        val s = server { path, out ->
            if (path == "/form") MiniHttpServer.respond(out, 303, mapOf("Location" to "/done"))
            else MiniHttpServer.respond(out, 200, mapOf("Content-Length" to "0"))
        }
        val c = open("${s.base}/form", method = "POST", body = "a=1".toByteArray())
        assertEquals(200, c.responseCode)
        c.disconnect()
        assertTrue(seen.containsKey("POST /form"))
        assertTrue(seen.containsKey("GET /done"))
    }

    @Test
    fun anErrorAnswerIsReturnedNotFollowed() {
        val s = server { _, out -> MiniHttpServer.respond(out, 404) }
        val c = open("${s.base}/gone")
        assertEquals(404, c.responseCode)
        c.disconnect()
    }

    @Test
    fun redirectsInACircleStop() {
        val s = server { _, out -> MiniHttpServer.respond(out, 302, mapOf("Location" to "/again")) }
        try {
            open("${s.base}/again").disconnect()
            fail("should have given up")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("too many redirects"))
        }
    }

    @Test
    fun onlyHttpAndHttpsAreFollowed() {
        val s = server { _, out -> MiniHttpServer.respond(out, 302, mapOf("Location" to "file:///etc/hosts")) }
        try {
            open("${s.base}/x").disconnect()
            fail("should have refused")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("unsupported"))
        }
    }

    @Test
    fun onlyLoginHeadersAreHeldBack() {
        assertTrue(RedirectGuard.isCredential("Authorization"))
        assertTrue(RedirectGuard.isCredential("cookie"))
        assertTrue(RedirectGuard.isCredential("Proxy-Authorization"))
        assertFalse(RedirectGuard.isCredential("Referer"))
        assertTrue(RedirectGuard.maySend("Authorization", "Example.org", "example.org"))
        assertFalse(RedirectGuard.maySend("Authorization", "example.org", "cdn.example.org"))
        assertTrue(RedirectGuard.maySend("Referer", "example.org", "cdn.example.org"))
    }
}
