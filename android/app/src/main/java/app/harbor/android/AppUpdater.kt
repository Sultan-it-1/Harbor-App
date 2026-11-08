package app.harbor.android

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Installs a new version of the app from inside it: downloads the release's APK into the app's
 * cache, checks it against the SHA-256 the release names, and hands it to Android's installer
 * (which only accepts it over the installed app when it is signed with the same key). Tells the
 * page how it goes through [send] (a JSON event: progress, installing, error).
 */
class AppUpdater(private val activity: Activity, private val send: (String) -> Unit) {
    private val running = AtomicBoolean(false)
    @Volatile private var cancelled = false

    /** Whether Android lets Harbor open its installer (the user allows it once, in Settings). */
    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    /** Android's "Install unknown apps" switch for Harbor. */
    fun openInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        activity.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
        )
    }

    fun cancel() {
        cancelled = true
    }

    fun download(url: String, sha256: String) {
        if (!running.compareAndSet(false, true)) return
        cancelled = false
        Thread({
            try {
                val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val file = File(dir, "harbor-update.apk")
                fetch(url, file)
                if (cancelled) {
                    file.delete()
                    event("cancelled")
                    return@Thread
                }
                val want = sha256.trim().lowercase()
                if (want.isNotEmpty() && sha256Of(file) != want) {
                    file.delete()
                    event("error", "message" to "The download doesn't match the release (SHA-256). Try again.")
                    return@Thread
                }
                event("installing")
                activity.runOnUiThread { install(file) }
            } catch (e: Throwable) {
                Log.w("Harbor", "update download failed", e)
                event("error", "message" to (e.message ?: e.javaClass.simpleName))
            } finally {
                running.set(false)
            }
        }, "harbor-update").start()
    }

    private fun fetch(url: String, into: File) {
        var conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 20_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "Harbor-App")
        // A GitHub download answers with a redirect to its file host (another host than the link).
        var hops = 0
        while (conn.responseCode in 300..399 && hops < 8) {
            val next = URL(URL(url), conn.getHeaderField("Location") ?: break)
            conn.disconnect()
            conn = next.openConnection() as HttpURLConnection
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("User-Agent", "Harbor-App")
            hops++
        }
        if (conn.responseCode !in 200..299) throw java.io.IOException("HTTP ${conn.responseCode}")
        val total = conn.contentLengthLong
        var received = 0L
        var lastSent = 0L
        conn.inputStream.use { input ->
            into.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (!cancelled) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    received += n
                    val now = System.currentTimeMillis()
                    if (now - lastSent > 250) {
                        lastSent = now
                        event("progress", "received" to received, "total" to total)
                    }
                }
            }
        }
        conn.disconnect()
        if (!cancelled) event("progress", "received" to received, "total" to total)
    }

    private fun sha256Of(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun install(file: File) {
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
            activity.startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (e: Throwable) {
            Log.w("Harbor", "update install failed", e)
            event("error", "message" to (e.message ?: e.javaClass.simpleName))
        }
    }

    private fun event(type: String, vararg fields: Pair<String, Any>) {
        val o = JSONObject().put("type", type)
        for ((k, v) in fields) o.put(k, v)
        send(o.toString())
    }
}
