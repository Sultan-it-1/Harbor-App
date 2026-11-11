package app.harbor.android

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.HttpDataSource.HttpDataSourceException
import androidx.media3.datasource.HttpUtil
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.TreeMap
import java.util.zip.GZIPInputStream

/**
 * The player's HTTP source for a stream that comes with a login (an Authorization or Cookie
 * header from the page). Media3's own source repeats every header at each redirect, so a link
 * that redirects to another host would hand that host the login. This one follows redirects
 * itself (RedirectGuard) and otherwise does what DefaultHttpDataSource does, step for step:
 * ranges, gzip, skipping ahead when the server ignores a range, and the same errors, so retries
 * and the "reconnecting" logic see no difference.
 */
@OptIn(UnstableApi::class)
class GuardedHttpDataSource(
    private val userAgent: String,
    private val defaultHeaders: Map<String, String>,
    private val connectTimeoutMs: Int,
    private val readTimeoutMs: Int,
) : BaseDataSource(/* isNetwork = */ true), HttpDataSource {

    class Factory(
        private val userAgent: String,
        private val headers: Map<String, String>,
        private val connectTimeoutMs: Int,
        private val readTimeoutMs: Int,
    ) : DataSource.Factory {
        override fun createDataSource(): DataSource = GuardedHttpDataSource(userAgent, HashMap(headers), connectTimeoutMs, readTimeoutMs)
    }

    private val requestProperties = HashMap<String, String>()
    private var dataSpec: DataSpec? = null
    private var connection: HttpURLConnection? = null
    private var input: InputStream? = null
    private var responseHeaders: Map<String, List<String>> = emptyMap()
    private var started = false
    private var code = 0
    private var bytesToRead = 0L
    private var bytesRead = 0L

    /** After redirects this is where the data really came from (HLS resolves segment links against it). */
    override fun getUri(): Uri? = connection?.let { Uri.parse(it.url.toString()) } ?: dataSpec?.uri

    override fun getResponseCode(): Int = if (connection == null || code <= 0) -1 else code

    override fun getResponseHeaders(): Map<String, List<String>> = responseHeaders

    override fun setRequestProperty(name: String, value: String) {
        synchronized(requestProperties) { requestProperties[name] = value }
    }

    override fun clearRequestProperty(name: String) {
        synchronized(requestProperties) { requestProperties.remove(name) }
    }

    override fun clearAllRequestProperties() {
        synchronized(requestProperties) { requestProperties.clear() }
    }

    override fun open(dataSpec: DataSpec): Long {
        this.dataSpec = dataSpec
        bytesRead = 0
        bytesToRead = 0
        transferInitializing(dataSpec)

        val c: HttpURLConnection
        val message: String?
        try {
            c = connect(dataSpec)
            connection = c
            code = c.responseCode
            message = c.responseMessage
        } catch (e: IOException) {
            closeConnectionQuietly()
            throw HttpDataSourceException.createForIOException(e, dataSpec, HttpDataSourceException.TYPE_OPEN)
        }
        // Names in any letter case must be found (HTTP/2 sends them in lower case); the status
        // line, which sits under a null name, is not a header.
        responseHeaders = TreeMap<String, List<String>>(String.CASE_INSENSITIVE_ORDER).also { map ->
            c.headerFields.forEach { (k, v) -> if (k != null && v != null) map[k] = v }
        }

        if (code < 200 || code > 299) {
            val fields = c.headerFields
            if (code == 416) {
                // Asked to start exactly at the end of the file: nothing to read, not an error.
                val size = HttpUtil.getDocumentSize(c.getHeaderField("Content-Range"))
                if (dataSpec.position == size) {
                    started = true
                    transferStarted(dataSpec)
                    return if (dataSpec.length != UNSET) dataSpec.length else 0
                }
            }
            val errorBody = try { c.errorStream?.use { it.readBytes() } } catch (_: IOException) { null } ?: ByteArray(0)
            closeConnectionQuietly()
            val cause = if (code == 416) DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE) else null
            throw HttpDataSource.InvalidResponseCodeException(code, message, cause, fields, dataSpec, errorBody)
        }

        // A 200 to a request that started further in: the server doesn't do ranges, so read up
        // to that point and throw it away.
        val toSkip = if (code == 200 && dataSpec.position != 0L) dataSpec.position else 0L
        val gzip = "gzip".equals(c.getHeaderField("Content-Encoding"), ignoreCase = true)
        bytesToRead = when {
            // The Content-Length of a gzip answer is the packed size, which is no use here.
            gzip || dataSpec.length != UNSET -> dataSpec.length
            else -> {
                val length = HttpUtil.getContentLength(c.getHeaderField("Content-Length"), c.getHeaderField("Content-Range"))
                if (length != UNSET) length - toSkip else UNSET
            }
        }

        try {
            input = if (gzip) GZIPInputStream(c.inputStream) else c.inputStream
        } catch (e: IOException) {
            closeConnectionQuietly()
            throw HttpDataSourceException(e, dataSpec, PlaybackException.ERROR_CODE_IO_UNSPECIFIED, HttpDataSourceException.TYPE_OPEN)
        }

        started = true
        transferStarted(dataSpec)

        try {
            skipFully(toSkip, dataSpec)
        } catch (e: IOException) {
            closeConnectionQuietly()
            throw e as? HttpDataSourceException
                ?: HttpDataSourceException(e, dataSpec, PlaybackException.ERROR_CODE_IO_UNSPECIFIED, HttpDataSourceException.TYPE_OPEN)
        }
        return bytesToRead
    }

    private fun connect(spec: DataSpec): HttpURLConnection {
        val headers = HashMap<String, String>(defaultHeaders)
        synchronized(requestProperties) { headers.putAll(requestProperties) }
        headers.putAll(spec.httpRequestHeaders)
        val range = HttpUtil.buildRangeRequestHeader(spec.position, spec.length)
        val gzip = spec.isFlagSet(DataSpec.FLAG_ALLOW_GZIP)
        return RedirectGuard.open(URL(spec.uri.toString()), DataSpec.getStringForHttpMethod(spec.httpMethod), spec.httpBody, headers) { c ->
            c.connectTimeout = connectTimeoutMs
            c.readTimeout = readTimeoutMs
            if (range != null) c.setRequestProperty("Range", range)
            c.setRequestProperty("User-Agent", userAgent)
            c.setRequestProperty("Accept-Encoding", if (gzip) "gzip" else "identity")
        }
    }

    private fun skipFully(count: Long, spec: DataSpec) {
        if (count == 0L) return
        val stream = input ?: return
        val buf = ByteArray(4096)
        var left = count
        while (left > 0) {
            val n = stream.read(buf, 0, minOf(left, buf.size.toLong()).toInt())
            if (Thread.currentThread().isInterrupted) {
                throw HttpDataSourceException(InterruptedIOException(), spec, PlaybackException.ERROR_CODE_IO_UNSPECIFIED, HttpDataSourceException.TYPE_OPEN)
            }
            if (n == -1) {
                throw HttpDataSourceException(spec, PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE, HttpDataSourceException.TYPE_OPEN)
            }
            left -= n
            bytesTransferred(n)
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        var want = length
        if (bytesToRead != UNSET) {
            val left = bytesToRead - bytesRead
            if (left == 0L) return C.RESULT_END_OF_INPUT
            want = minOf(want.toLong(), left).toInt()
        }
        val stream = input ?: return C.RESULT_END_OF_INPUT
        val n = try {
            stream.read(buffer, offset, want)
        } catch (e: IOException) {
            throw HttpDataSourceException.createForIOException(e, dataSpec ?: throw e, HttpDataSourceException.TYPE_READ)
        }
        if (n == -1) return C.RESULT_END_OF_INPUT
        bytesRead += n
        bytesTransferred(n)
        return n
    }

    override fun close() {
        try {
            val spec = dataSpec
            try {
                input?.close()
            } catch (e: IOException) {
                if (spec == null) throw e
                throw HttpDataSourceException(e, spec, PlaybackException.ERROR_CODE_IO_UNSPECIFIED, HttpDataSourceException.TYPE_CLOSE)
            }
        } finally {
            input = null
            closeConnectionQuietly()
            if (started) {
                started = false
                transferEnded()
            }
            connection = null
            dataSpec = null
        }
    }

    private fun closeConnectionQuietly() {
        try {
            connection?.disconnect()
        } catch (_: Exception) {
        }
    }

    private companion object {
        const val UNSET = C.LENGTH_UNSET.toLong()
    }
}
