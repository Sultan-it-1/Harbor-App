package app.harbor.android

import android.app.DownloadManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * In-app downloads for offline watching. Harbor downloads the files itself (HttpTransfer) while
 * its background service (DownloadService) keeps it running. It used to hand them to the system
 * downloader, but that one runs them as background jobs on Harbor's behalf, and recent Android
 * versions hold those jobs back as soon as you leave the app — downloads stalled on "retrying".
 *
 *  - files go to the app's own storage (Android/data/app.harbor.android/files/Movies/Harbor/<id>/),
 *    no folder picker or storage permission; removed with the app
 *  - two at a time, the rest queued; continues where it stopped (HTTP Range), waits for the
 *    network, retries with back-off; pause / resume / retry from the Downloads page
 *  - picks up again after the app was closed or killed (state lives in SharedPreferences)
 *  - addon subtitles are saved next to the video (normalised to UTF-8) and deleted with it
 *  - delete removes the video, its subtitles and the folder for good
 *
 * One instance per process (get()), shared by the page bridge, the player and the service.
 */
class Downloads private constructor(private val ctx: Context) {

    /** Used for downloads that don't bring their own; set from the WebView's user agent. */
    @Volatile var userAgent: String = "HarborAndroid"

    private val prefs = ctx.getSharedPreferences("harbor.downloads", Context.MODE_PRIVATE)
    private val dm by lazy { ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager }
    private val pool by lazy { Executors.newFixedThreadPool(2) }
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val lock = Any()
    private val subsLock = Any()
    private val tasks = LinkedHashMap<String, Task>()
    private val subsCounts = ConcurrentHashMap<String, Int>()
    private var wake: ScheduledFuture<*>? = null

    private class Task(
        val id: String,
        var url: String,
        var headers: Map<String, String>,
        val ua: String,
        val file: String,
        val title: String,
        var state: String,
        val createdAt: Long,
    ) {
        var total = -1L
        @Volatile var received = 0L
        /** Why it failed (shown on the Downloads page): English text, and a code + HTTP status
         *  the page translates. */
        var reason: String? = null
        var code: String? = null
        var http = 0
        /** While waiting: for the network, or for the next retry at retryAt. */
        var waitingFor: String? = null
        var retryAt = 0L
        var attempts = 0
        /** Started by an older version through the system downloader (finished there). */
        var legacyDm = -1L
        @Volatile var stop = false
        @Volatile var transfer: HttpTransfer? = null
        var worker: Thread? = null
    }

    private fun root(): File? = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES)?.let { File(it, "Harbor") }

    /** Only plain ids get a folder: "", "." and ".." (and anything else odd) would point at
     *  the Harbor folder itself or its parent, and delete would wipe every download. */
    private fun dirFor(id: String): File? = if (validId(id)) root()?.let { File(it, id) } else null

    // =========================================================================================
    // Page bridge (MainActivity.JsApi)
    // =========================================================================================

    /** {id, url, headers, fileName, title, description, subtitles:[{url,lang,label}]} -> {ok, error?} */
    fun start(json: String): String {
        val out = JSONObject()
        try {
            val j = JSONObject(json)
            val id = j.getString("id")
            if (!validId(id)) return out.put("ok", false).put("error", "invalid id").toString()
            val dir = dirFor(id) ?: return out.put("ok", false).put("error", "storage unavailable").toString()
            dir.mkdirs()
            val fileName = safeFileName(j.optString("fileName").ifBlank { "video.mp4" })
            var ua = userAgent
            val headers = HashMap<String, String>()
            j.optJSONObject("headers")?.let { h ->
                h.keys().forEach { k -> if (k.equals("user-agent", true)) ua = h.getString(k) else headers[k] = h.getString(k) }
            }
            val title = listOf(j.optString("title"), j.optString("description")).filter { it.isNotBlank() }.joinToString(" · ")
            val t = Task(id, j.getString("url"), headers, ua, fileName, title.ifBlank { "Harbor" }, QUEUED, System.currentTimeMillis())
            // The check and the entry in one step, so two starts of one id can't both get through.
            synchronized(lock) {
                val old = tasks[id]
                // Started twice (a double tap, or delete + download again at once): one transfer per
                // id. While the old one runs, this start is a no-op; its worker would otherwise
                // delete the folder (with the new .part) when it ends.
                if (old != null && (old.worker != null || old.state == RUNNING || old.state == QUEUED || old.state == WAITING)) {
                    return out.put("ok", true).put("already", true).toString()
                }
                tasks[id] = t
                persist(t)
            }
            prefs.edit().putString("ua:$id", ua).apply()
            j.optJSONArray("subtitles")?.let { subs -> if (subs.length() > 0) background { saveSubtitles(id, dir, subs, ua) } }
            pump()
            out.put("ok", true)
        } catch (e: Exception) {
            out.put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
        }
        return out.toString()
    }

    fun pause(id: String): Boolean {
        synchronized(lock) {
            val t = tasks[id] ?: return false
            if (t.state == DONE || t.state == ERROR || t.state == PAUSED) return false
            t.state = PAUSED
            t.stop = true
            t.transfer?.abort()
            persist(t)
        }
        pump() // the next queued one can start
        return true
    }

    /** Resume a paused download, or try a failed one again (from where it got to). */
    fun resume(id: String): Boolean {
        synchronized(lock) {
            val t = tasks[id] ?: return false
            if (t.state == DONE || t.state == RUNNING) return false
            if (t.url.isBlank()) {
                t.state = ERROR
                t.reason = "The download link is gone. Delete it and download it again."
                persist(t)
                return false
            }
            t.state = QUEUED
            t.attempts = 0
            t.retryAt = 0
            t.waitingFor = null
            t.reason = null
            persist(t)
        }
        pump()
        return true
    }

    /**
     * A fresh link for a download whose link expired (debrid/CDN links are time-limited and
     * sometimes tied to the network they were made on). Keeps the .part and carries on from it.
     */
    fun relink(id: String, url: String, headersJson: String?): Boolean {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false
        synchronized(lock) {
            val t = tasks[id] ?: return false
            if (t.state == DONE || t.state == RUNNING || t.worker != null) return false
            t.url = url
            headersJson?.takeIf { it.isNotBlank() }?.let { hj ->
                val h = HashMap<String, String>()
                try {
                    val o = JSONObject(hj)
                    o.keys().forEach { k -> if (!k.equals("user-agent", true)) h[k] = o.optString(k) }
                    t.headers = h
                } catch (_: Exception) {
                }
            }
            t.state = QUEUED
            t.attempts = 0
            t.retryAt = 0
            t.waitingFor = null
            t.reason = null
            t.code = null
            t.http = 0
            persist(t)
        }
        pump()
        return true
    }

    /** Download only on Wi-Fi (or any unmetered network). On by default. */
    var wifiOnly: Boolean
        get() = prefs.getBoolean(PREF_WIFI_ONLY, true)
        set(v) {
            prefs.edit().putBoolean(PREF_WIFI_ONLY, v).apply()
            // Turned on while on mobile data: the running downloads stop too (they carry on over
            // Wi-Fi from where they got to), not only the ones that hadn't started.
            if (v && network() == NET_METERED) {
                synchronized(lock) {
                    for (t in tasks.values) {
                        if (t.state != RUNNING) continue
                        t.state = WAITING
                        t.waitingFor = WAIT_WIFI
                        t.stop = true
                        t.transfer?.abort()
                        persist(t)
                    }
                }
            }
            pump()
        }

    /** Unfinished downloads (for the "downloads paused" notice). */
    fun hasPendingWork(): Boolean = synchronized(lock) {
        tasks.values.any { it.state == QUEUED || it.state == RUNNING || it.state == WAITING }
    }

    /** Cancel and/or delete for good: the video, its subtitles and the folder. */
    fun delete(id: String): Boolean {
        val t = synchronized(lock) { tasks.remove(id) }
        if (t != null) {
            t.stop = true
            t.transfer?.abort()
            if (t.legacyDm >= 0) removeFromSystemDownloader(t.legacyDm)
        }
        dirFor(id)?.deleteRecursively()
        prefs.edit().remove(id).remove("ua:$id").apply()
        subsCounts.remove(id)
        pump()
        return true
    }

    /** Opening the app: carry on with anything that stalled while it was away (e.g. Android
     *  ended the background service after its daily time). */
    fun kick() = pump()

    /** {<id>: {status, received, total, reason, subs}} for every download. */
    fun status(): String {
        val out = JSONObject()
        val now = System.currentTimeMillis()
        synchronized(lock) {
            for (t in tasks.values) {
                out.put(
                    t.id,
                    JSONObject()
                        .put("subs", subsCount(t.id))
                        .put("status", when (t.state) {
                            QUEUED -> "pending"
                            RUNNING -> "downloading"
                            else -> t.state // waiting | paused | done | error
                        })
                        .put("received", t.received)
                        .put("total", if (t.total > 0) t.total else JSONObject.NULL)
                        .put("reason", noteFor(t, now))
                        .put("code", codeFor(t))
                        .put("title", t.title)
                        .put("http", t.http)
                        .put("sec", if (t.state == WAITING && t.waitingFor == WAIT_RETRY) ((t.retryAt - now + 999) / 1000).coerceAtLeast(1) else 0),
                )
            }
        }
        return out.toString()
    }

    /** What the page shows, as a code it translates (the English note stays as a fallback). */
    private fun codeFor(t: Task): String = when (t.state) {
        QUEUED -> "queued"
        WAITING -> when (t.waitingFor) {
            WAIT_NETWORK -> "waiting_network"
            WAIT_WIFI -> "waiting_wifi"
            else -> "retry_in"
        }
        PAUSED -> "paused"
        ERROR -> t.code ?: "failed"
        else -> ""
    }

    private fun noteFor(t: Task, now: Long): String = when (t.state) {
        QUEUED -> "Queued"
        WAITING -> when (t.waitingFor) {
            WAIT_NETWORK -> "Waiting for internet"
            WAIT_WIFI -> "Waiting for Wi-Fi"
            else -> "Retrying in ${((t.retryAt - now + 999) / 1000).coerceAtLeast(1)}s"
        }
        PAUSED -> "Paused"
        ERROR -> t.reason ?: "Download failed"
        else -> ""
    }

    /** Overall state for the background-service notification. */
    data class Summary(val active: Int, val running: Int, val received: Long, val total: Long, val note: String?) {
        fun percent(): Int? = if (total > 0) ((received * 100) / total).toInt().coerceIn(0, 100) else null
    }

    fun summary(): Summary = synchronized(lock) {
        val active = tasks.values.filter { it.state == QUEUED || it.state == RUNNING || it.state == WAITING }
        val running = active.count { it.state == RUNNING }
        holdWakeLock(running > 0) // also renews its timeout while downloads run
        var got = 0L
        var total = 0L
        var unknown = false
        active.forEach {
            got += it.received
            if (it.total > 0) total += it.total else unknown = true
        }
        val note = when {
            active.isEmpty() || running > 0 -> null
            active.any { it.state == WAITING && it.waitingFor == WAIT_NETWORK } -> Strings.waitingForInternet
            active.any { it.state == WAITING && it.waitingFor == WAIT_WIFI } -> Strings.waitingForWifi
            active.any { it.state == WAITING } -> Strings.retryingSoon
            else -> Strings.queued
        }
        Summary(active.size, running, got, if (unknown) 0 else total, note)
    }

    // =========================================================================================
    // Engine
    // =========================================================================================

    /** Starts what can start (two at a time), schedules the next retry, keeps the service up. */
    private fun pump() {
        var active: Boolean
        synchronized(lock) {
            val now = System.currentTimeMillis()
            val net = network()
            val online = net == NET_OK
            var running = tasks.values.count { it.state == RUNNING }
            for (t in tasks.values) {
                if (t.state == WAITING) {
                    val ready = if (t.waitingFor == WAIT_NETWORK || t.waitingFor == WAIT_WIFI) online else now >= t.retryAt
                    if (ready) t.state = QUEUED
                }
                if (t.state != QUEUED) continue
                if (!online) {
                    t.state = WAITING
                    t.waitingFor = if (net == NET_METERED) WAIT_WIFI else WAIT_NETWORK
                    continue
                }
                if (running >= MAX_PARALLEL) continue
                if (launch(t)) running++
            }
            active = tasks.values.any { it.state == QUEUED || it.state == RUNNING || it.state == WAITING }
            holdWakeLock(running > 0)
            scheduleWake(now)
        }
        if (active) DownloadService.ensureRunning(ctx)
    }

    private fun scheduleWake(now: Long) {
        val waiting = tasks.values.filter { it.state == WAITING }
        if (waiting.isEmpty()) return
        // Retries at their time; network waits are re-checked now and then in case the
        // "network is back" callback doesn't come.
        val next = waiting.minOf { if (it.waitingFor == WAIT_NETWORK || it.waitingFor == WAIT_WIFI) now + 30_000 else it.retryAt }
        wake?.cancel(false)
        wake = scheduler.schedule({ pump() }, (next - now).coerceAtLeast(300), TimeUnit.MILLISECONDS)
    }

    private fun launch(t: Task): Boolean {
        if (t.worker != null) return false // the previous run is still winding down
        t.state = RUNNING
        t.stop = false
        t.waitingFor = null
        t.reason = null
        t.code = null
        t.http = 0
        persist(t)
        t.worker = Thread({ runTask(t) }, "harbor-download").apply {
            isDaemon = true
            start()
        }
        return true
    }

    private fun runTask(t: Task) {
        val dir = dirFor(t.id)
        val result: HttpTransfer.Result = if (dir == null) {
            HttpTransfer.Result.Fail(HttpTransfer.Problem.OTHER, "storage unavailable")
        } else {
            dir.mkdirs()
            val tr = HttpTransfer(t.url, t.headers, t.ua, File(dir, t.file + PART), object : HttpTransfer.Listener {
                override fun onTotal(total: Long) {
                    t.total = total
                }

                override fun onProgress(received: Long) {
                    t.received = received
                }

                override fun shouldStop() = t.stop

                override fun freeSpace() = try { StatFs(dir.absolutePath).availableBytes } catch (_: Exception) { Long.MAX_VALUE }
            })
            t.transfer = tr
            if (t.stop) {
                HttpTransfer.Result.Stopped
            } else {
                try {
                    tr.run()
                } catch (e: Exception) {
                    HttpTransfer.Result.Retry(HttpTransfer.Problem.OTHER, e.message ?: e.javaClass.simpleName, false)
                }
            }
        }
        t.transfer = null
        var finished: Boolean? = null
        synchronized(lock) {
            t.worker = null
            if (tasks[t.id] !== t) {
                // Deleted while it was running: remove its folder. (Replaced by a new download of
                // the same id: the folder now belongs to that one, leave it.)
                if (tasks[t.id] == null) dir?.deleteRecursively()
                return
            }
            when {
                // Paused (or resumed and queued again) meanwhile: leave it as the user set it.
                result != HttpTransfer.Result.Done && t.state != RUNNING -> {}
                result == HttpTransfer.Result.Done -> {
                    val part = File(dir, t.file + PART)
                    val dest = File(dir, t.file)
                    if (dest.exists()) dest.delete()
                    if (part.renameTo(dest)) {
                        t.state = DONE
                        t.received = dest.length()
                        t.total = t.received
                        t.reason = null
                        finished = true
                    } else {
                        t.state = ERROR
                        t.reason = "Couldn't save the file"
                        t.code = "save_failed"
                        finished = false
                    }
                }
                result == HttpTransfer.Result.Stopped -> t.state = QUEUED
                result is HttpTransfer.Result.Retry -> {
                    if (result.madeProgress) t.attempts = 0
                    val net = network()
                    when {
                        // Offline (or only mobile data with Wi-Fi only on): wait for the network;
                        // that isn't a failed attempt.
                        net != NET_OK -> {
                            t.state = WAITING
                            t.waitingFor = if (net == NET_METERED) WAIT_WIFI else WAIT_NETWORK
                        }
                        ++t.attempts > MAX_ATTEMPTS -> {
                            t.state = ERROR
                            t.reason = "Keeps failing (${result.detail}). Tap retry."
                            t.code = "keeps_failing"
                            finished = false
                        }
                        else -> {
                            t.state = WAITING
                            t.waitingFor = WAIT_RETRY
                            t.retryAt = System.currentTimeMillis() + backoffMs(t.attempts)
                        }
                    }
                }
                result is HttpTransfer.Result.Fail -> {
                    t.attempts++
                    if (result.problem == HttpTransfer.Problem.REFUSED && t.attempts <= 2) {
                        // Sometimes just a hiccup on the server's side; try twice before giving up.
                        t.state = WAITING
                        t.waitingFor = WAIT_RETRY
                        t.retryAt = System.currentTimeMillis() + 5_000L * t.attempts
                    } else {
                        t.state = ERROR
                        t.reason = failText(result)
                        t.code = failCode(result)
                        t.http = result.httpCode
                        finished = false
                    }
                }
            }
            persist(t)
        }
        finished?.let { ok -> DownloadService.notifyFinished(ctx, t.id, t.title, ok) }
        pump()
    }

    private fun backoffMs(attempt: Int): Long = BACKOFF_MS[(attempt - 1).coerceIn(0, BACKOFF_MS.size - 1)]

    private fun failCode(f: HttpTransfer.Result.Fail): String = when {
        f.problem == HttpTransfer.Problem.SPACE -> "no_space"
        f.problem == HttpTransfer.Problem.NOT_MEDIA -> "not_media"
        f.httpCode == 404 || f.httpCode == 410 -> "expired"
        f.httpCode == 401 || f.httpCode == 403 -> "refused"
        f.httpCode > 0 -> "http_error"
        else -> "failed"
    }

    private fun failText(f: HttpTransfer.Result.Fail): String = when {
        f.problem == HttpTransfer.Problem.SPACE -> "Not enough storage on the phone"
        f.problem == HttpTransfer.Problem.NOT_MEDIA -> "This link isn't a video file (${f.detail})"
        f.httpCode == 404 || f.httpCode == 410 -> "The link has expired (HTTP ${f.httpCode}). Tap retry for a fresh link."
        f.httpCode == 401 || f.httpCode == 403 -> "The server refused the download (HTTP ${f.httpCode}). The link may have expired."
        f.httpCode > 0 -> "The server refused the download (HTTP ${f.httpCode})"
        else -> "Download failed (${f.detail})"
    }

    /** NET_OK, NET_NONE (no working internet: also a Wi-Fi without internet) or NET_METERED
     *  (only mobile data while "Wi-Fi only" is on). */
    private fun network(): Int = try {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        when {
            caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> NET_NONE
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> NET_NONE
            wifiOnly && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) -> NET_METERED
            else -> NET_OK
        }
    } catch (_: Exception) {
        NET_OK
    }

    private fun watchNetwork() {
        try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val later = { scheduler.schedule({ pump() }, 1500, TimeUnit.MILLISECONDS); Unit }
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = later()
                override fun onLost(network: Network) = later()
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = later()
            })
        } catch (_: Exception) {
        }
    }

    private val wakeLock by lazy {
        (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "harbor:downloads")
            .apply { setReferenceCounted(false) }
    }

    /** Keeps the CPU awake (screen off) while something downloads. */
    private fun holdWakeLock(on: Boolean) {
        try {
            if (on) wakeLock.acquire(WAKE_LOCK_MS) else if (wakeLock.isHeld) wakeLock.release()
        } catch (_: Exception) {
        }
    }

    private fun bytesOnDisk(t: Task): Long {
        val dir = dirFor(t.id) ?: return 0
        val f = if (t.state == DONE) File(dir, t.file) else File(dir, t.file + PART)
        return if (f.exists()) f.length() else 0
    }

    // ---- persistence ---------------------------------------------------------------------

    private fun persist(t: Task) {
        val j = JSONObject()
            .put("v", 2)
            .put("url", t.url)
            .put("ua", t.ua)
            .put("file", t.file)
            .put("title", t.title)
            .put("state", t.state)
            .put("total", t.total)
            .put("at", t.createdAt)
            .put("headers", JSONObject(t.headers as Map<*, *>))
        t.reason?.let { j.put("reason", it) }
        t.code?.let { j.put("code", it) }
        if (t.http > 0) j.put("http", t.http)
        if (t.legacyDm >= 0) j.put("dm", t.legacyDm)
        prefs.edit().putString(t.id, j.toString()).apply()
    }

    private fun fromJson(id: String, j: JSONObject): Task {
        val h = HashMap<String, String>()
        j.optJSONObject("headers")?.let { o -> o.keys().forEach { k -> h[k] = o.optString(k) } }
        return Task(
            id, j.optString("url"), h, j.optString("ua").ifBlank { userAgent }, j.optString("file").ifBlank { "video.mp4" },
            j.optString("title"), j.optString("state", QUEUED), j.optLong("at", 0),
        ).apply {
            total = j.optLong("total", -1)
            reason = j.optString("reason").takeIf { it.isNotBlank() }
            code = j.optString("code").takeIf { it.isNotBlank() }
            http = j.optInt("http", 0)
            legacyDm = j.optLong("dm", -1)
        }
    }

    /** Loads the downloads on startup and carries on with the unfinished ones. */
    private fun restore() {
        val restored = ArrayList<Task>()
        val legacy = ArrayList<Pair<String, JSONObject>>()
        for ((key, value) in prefs.all) {
            if (key.startsWith("ua:") || key.startsWith("pref:")) continue
            val j = (value as? String)?.let { try { JSONObject(it) } catch (_: Exception) { null } } ?: continue
            if (j.optInt("v", 1) < 2) {
                legacy.add(key to j)
                continue
            }
            val t = fromJson(key, j)
            // It was downloading when the app went away: carry on.
            if (t.state == RUNNING || t.state == WAITING) t.state = QUEUED
            t.received = bytesOnDisk(t)
            restored.add(t)
        }
        synchronized(lock) { restored.sortedBy { it.createdAt }.forEach { tasks[it.id] = it } }
        legacy.forEach { (id, j) ->
            try {
                migrateLegacy(id, j)
            } catch (_: Exception) {
            }
        }
        watchNetwork()
        pump()
    }

    /** A download an older version handed to the system downloader: keep it if it finished there,
     *  otherwise take it over (it restarts in the app, the system's partial copy is dropped). */
    private fun migrateLegacy(id: String, j: JSONObject) {
        val dmId = j.optLong("dmId", -1)
        val file = j.optString("file").ifBlank { "video.mp4" }
        val ua = prefs.getString("ua:$id", null) ?: userAgent
        var status = -1
        var uri = ""
        var title = ""
        if (dmId >= 0) {
            try {
                dm.query(DownloadManager.Query().setFilterById(dmId))?.use { c ->
                    if (c.moveToFirst()) {
                        status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                        uri = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_URI)) ?: ""
                        title = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)) ?: ""
                    }
                }
            } catch (_: Exception) {
            }
        }
        val t = Task(id, uri, emptyMap(), ua, file, title, QUEUED, System.currentTimeMillis())
        val finalFile = dirFor(id)?.let { File(it, file) }
        when (status) {
            DownloadManager.STATUS_SUCCESSFUL -> {
                t.state = DONE
                t.legacyDm = dmId // removing it there would delete the file; done on delete()
            }
            -1 -> {
                // Not in the system's list any more.
                if (finalFile != null && finalFile.exists() && finalFile.length() > 0) {
                    t.state = DONE
                } else {
                    t.state = ERROR
                    t.reason = "Interrupted. Delete it and download it again."
                }
            }
            else -> {
                // Running, waiting or failed there: take it over.
                removeFromSystemDownloader(dmId)
                if (uri.isBlank()) {
                    t.state = ERROR
                    t.reason = "Interrupted. Delete it and download it again."
                }
            }
        }
        t.received = bytesOnDisk(t)
        if (t.state == DONE) t.total = t.received
        synchronized(lock) { tasks[id] = t }
        persist(t)
    }

    private fun removeFromSystemDownloader(dmId: Long) {
        try {
            dm.remove(dmId)
        } catch (_: Exception) {
        }
    }

    // =========================================================================================
    // Subtitles saved with a download
    // =========================================================================================

    /** Adds addon subtitles to a download (found after it started). */
    fun addSubtitles(id: String, json: String): Boolean {
        val dir = dirFor(id) ?: return false
        if (!dir.exists()) return false
        val subs = try { JSONArray(json) } catch (_: Exception) { return false }
        val ua = prefs.getString("ua:$id", null) ?: userAgent
        background { saveSubtitles(id, dir, subs, ua) }
        return true
    }

    /** Runs subtitle saving off the caller's thread; DownloadService stays up until it's done. */
    private fun background(work: () -> Unit) {
        pendingWork.incrementAndGet()
        DownloadService.ensureRunning(ctx)
        pool.execute {
            try {
                work()
            } finally {
                pendingWork.decrementAndGet()
            }
        }
    }

    /** A subtitle saved next to a download: the local file and the URL it came from. */
    data class SavedSub(val file: File, val src: String, val lang: String?, val label: String?)

    fun savedSubtitles(id: String): List<SavedSub> {
        val dir = dirFor(id) ?: return emptyList()
        val arr = readSubs(dir)
        return (0 until arr.length()).mapNotNull { i ->
            val s = arr.optJSONObject(i) ?: return@mapNotNull null
            val f = File(s.optString("file"))
            if (!f.exists()) return@mapNotNull null
            SavedSub(f, s.optString("url"), s.optString("lang").takeIf { it.isNotBlank() && it != "null" }, s.optString("label").takeIf { it.isNotBlank() && it != "null" })
        }
    }

    /** The player's "save" button on a subtitle: adds it to the download; done(true) once it's there. */
    fun saveSubtitle(id: String, url: String, lang: String?, label: String?, done: (Boolean) -> Unit) {
        val dir = dirFor(id)?.takeIf { it.exists() } ?: return done(false)
        val ua = prefs.getString("ua:$id", null) ?: userAgent
        val one = JSONArray().put(JSONObject().put("url", url).apply {
            if (lang != null) put("lang", lang)
            if (label != null) put("label", label)
        })
        background {
            saveSubtitles(id, dir, one, ua)
            done(savedSubtitles(id).any { it.src == url })
        }
    }

    private fun readSubs(dir: File): JSONArray =
        File(dir, "subs.json").takeIf { it.exists() }?.let { try { JSONArray(it.readText()) } catch (_: Exception) { null } } ?: JSONArray()

    private fun subsCount(id: String): Int = subsCounts.getOrPut(id) { dirFor(id)?.let { readSubs(it).length() } ?: 0 }

    /** Downloads + normalises each subtitle into <dir>/subs and appends it to subs.json.
     *  One writer at a time (the search results and the player's save button can overlap). */
    private fun saveSubtitles(id: String, dir: File, subs: JSONArray, ua: String) {
        synchronized(subsLock) { saveSubtitlesLocked(dir, subs, ua) }
        subsCounts.remove(id)
    }

    private fun saveSubtitlesLocked(dir: File, subs: JSONArray, ua: String) {
        val store = SubtitleStore(File(dir, "subs"))
        val list = readSubs(dir)
        val have = (0 until list.length()).mapNotNull { list.optJSONObject(it)?.optString("url") }.toMutableSet()
        for (i in 0 until subs.length()) {
            val s = subs.optJSONObject(i) ?: continue
            val url = s.optString("url").takeIf { it.isNotBlank() } ?: continue
            if (!have.add(url)) continue
            val lang = s.optString("lang").takeIf { it.isNotBlank() && it != "null" }
            val label = s.optString("label").takeIf { it.isNotBlank() && it != "null" }
            val local = store.fetch("sub${System.currentTimeMillis().toString(36)}${list.length()}", url, lang, label, ua) ?: continue
            list.put(JSONObject().put("file", local.file.absolutePath).put("url", url).put("lang", lang).put("label", label))
            if (!dir.exists()) return // deleted meanwhile
            File(dir, "subs.json").writeText(list.toString())
        }
    }

    // =========================================================================================
    // Offline playback + storage
    // =========================================================================================

    /** Local files for offline playback: {video: "file://…", subtitles: [{url, src, lang, label}]} */
    fun files(id: String): String {
        val out = JSONObject()
        val dir = dirFor(id) ?: return out.toString()
        val t = synchronized(lock) { tasks[id] }
        val video = t?.takeIf { it.state == DONE }?.let { File(dir, it.file) }?.takeIf { it.exists() }
        if (video != null) out.put("video", Uri.fromFile(video).toString())
        val subs = JSONArray()
        savedSubtitles(id).forEach { s ->
            subs.put(JSONObject().put("url", Uri.fromFile(s.file).toString()).put("src", s.src).put("lang", s.lang).put("label", s.label))
        }
        out.put("subtitles", subs)
        return out.toString()
    }

    /** Free space on the downloads volume and how much Harbor's downloads use. */
    fun storage(): String {
        val r = root() ?: return JSONObject().toString()
        r.mkdirs()
        val free = try { StatFs(r.absolutePath).availableBytes } catch (_: Exception) { -1L }
        val used = r.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        return JSONObject().put("free", free).put("used", used).toString()
    }

    companion object {
        private const val QUEUED = "queued"
        private const val RUNNING = "running"
        private const val WAITING = "waiting"
        private const val PAUSED = "paused"
        private const val DONE = "done"
        private const val ERROR = "error"
        private const val WAIT_NETWORK = "network"
        private const val WAIT_WIFI = "wifi"
        private const val WAIT_RETRY = "retry"
        private const val NET_OK = 0
        private const val NET_NONE = 1
        private const val NET_METERED = 2
        private const val PREF_WIFI_ONLY = "pref:wifiOnly"
        private val ID_RX = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")

        fun validId(id: String) = ID_RX.matches(id) && !id.contains("..")

        /** Safe on any filesystem, any script kept; long names lose the middle, not the extension. */
        fun safeFileName(name: String): String {
            val clean = name.replace(Regex("[^\\p{L}\\p{N}._ ()\\[\\]-]"), "_").trim().trimStart('.').ifBlank { "video.mp4" }
            val dot = clean.lastIndexOf('.')
            val ext = if (dot > 0 && clean.length - dot <= 6) clean.substring(dot) else ""
            val stem = if (ext.isEmpty()) clean else clean.substring(0, dot)
            return stem.take(MAX_NAME - ext.length).ifBlank { "video" } + ext
        }

        private const val MAX_NAME = 80

        /** Unfinished downloads straight from storage (no engine start), for the boot notice. */
        fun pendingAtBoot(ctx: Context): Int {
            val prefs = ctx.getSharedPreferences("harbor.downloads", Context.MODE_PRIVATE)
            return prefs.all.count { (k, v) ->
                if (k.startsWith("ua:") || k.startsWith("pref:")) false
                else {
                    val state = (v as? String)?.let { try { JSONObject(it).optString("state") } catch (_: Exception) { null } }
                    state == QUEUED || state == RUNNING || state == WAITING
                }
            }
        }
        private const val PART = ".part"
        private const val MAX_PARALLEL = 2
        private const val MAX_ATTEMPTS = 12
        private const val WAKE_LOCK_MS = 60 * 60_000L
        private val BACKOFF_MS = longArrayOf(3_000, 10_000, 30_000, 60_000, 120_000, 300_000)

        /** Subtitle saves still running (DownloadService waits for them). */
        val pendingWork = AtomicInteger(0)

        @Volatile private var instance: Downloads? = null

        fun get(ctx: Context): Downloads {
            instance?.let { return it }
            synchronized(Downloads::class.java) {
                instance?.let { return it }
                // Handed out only once the saved downloads are loaded: a caller on another thread
                // must not get it while its list is still empty.
                val created = Downloads(ctx.applicationContext)
                created.restore()
                instance = created
                return created
            }
        }
    }
}
