package app.harbor.android

import java.io.BufferedInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/** Just enough HTTP/1.1 for the unit tests: one request per connection, handler writes the answer. */
class MiniHttpServer(private val handler: (method: String, path: String, headers: Map<String, String>, out: OutputStream) -> Unit) {
    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = socket.localPort
    val base: String get() = "http://127.0.0.1:$port"

    init {
        Thread {
            while (!socket.isClosed) {
                val s = try { socket.accept() } catch (_: IOException) { break }
                Thread { handle(s) }.apply { isDaemon = true }.start()
            }
        }.apply { isDaemon = true }.start()
    }

    private fun handle(s: Socket) {
        s.use {
            val input = BufferedInputStream(s.getInputStream())
            fun line(): String? {
                val b = StringBuilder()
                while (true) {
                    val c = input.read()
                    if (c < 0) return if (b.isEmpty()) null else b.toString()
                    if (c == '\n'.code) return b.toString().trimEnd('\r')
                    b.append(c.toChar())
                }
            }
            val request = line() ?: return
            val parts = request.split(" ")
            val method = parts.getOrNull(0) ?: return
            val path = parts.getOrNull(1) ?: return
            val headers = HashMap<String, String>()
            while (true) {
                val h = line() ?: break
                if (h.isEmpty()) break
                val i = h.indexOf(':')
                if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
            }
            handler(method, path, headers, s.getOutputStream())
        }
    }

    fun close() = socket.close()

    companion object {
        fun respond(out: OutputStream, code: Int, headers: Map<String, String> = emptyMap(), data: ByteArray? = null, send: Int = data?.size ?: 0) {
            val head = StringBuilder("HTTP/1.1 $code X\r\n")
            headers.forEach { (k, v) -> head.append("$k: $v\r\n") }
            if (data == null && !headers.containsKey("Content-Length")) head.append("Content-Length: 0\r\n")
            head.append("Connection: close\r\n\r\n")
            try {
                out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
                if (data != null) out.write(data, 0, send)
                out.flush()
            } catch (_: IOException) {
                // the client stopped reading
            }
        }
    }
}
