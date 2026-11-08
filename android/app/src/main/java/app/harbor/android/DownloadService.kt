package app.harbor.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * Keeps Harbor running while something is downloading, so leaving the app doesn't stop it.
 *
 *  - Downloads run in Harbor itself (Downloads + HttpTransfer); a foreground service is what
 *    lets an app keep working, with network and CPU, after you leave it.
 *  - Season downloads and subtitle searches run in the web UI, which only keeps running while
 *    the app's process isn't frozen or killed; the web UI asks for that with keepAlive().
 *
 * Shows one quiet notification with the overall progress and stops itself once idle; a
 * separate notification says when a download finished or failed.
 */
class DownloadService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var downloads: Downloads
    private var idleSince = 0L
    private var lastShown = ""
    private var stopping = false
    private val tick = Runnable { update() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        downloads = Downloads.get(applicationContext)
        createChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must go to the foreground right away (startForegroundService contract), even if
        // there turns out to be nothing left to do; update() stops us shortly after then.
        val s = downloads.summary()
        if (!goForeground(s)) return START_NOT_STICKY
        stopping = false
        instance = this
        idleSince = 0L
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, 1000)
        return START_STICKY
    }

    /** Re-check now (one tick chain only: drop the scheduled one first). */
    private fun poke() {
        handler.removeCallbacks(tick)
        update()
    }

    private fun goForeground(s: Downloads.Summary): Boolean = try {
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, build(s), type)
        true
    } catch (_: Exception) {
        // Not allowed right now (e.g. started from the background on Android 12+).
        stopping = true
        stopSelf()
        false
    }

    private fun update() {
        if (stopping) return
        val s = downloads.summary()
        val now = System.currentTimeMillis()
        val busy = s.active > 0 || now < keepAliveUntil || Downloads.pendingWork.get() > 0
        if (!busy) {
            if (idleSince == 0L) idleSince = now
            if (now - idleSince >= 4000) {
                shutdown()
                return
            }
        } else {
            idleSince = 0L
        }
        val key = "${s.active}|${s.percent()}|${s.note}|${s.received / (1 shl 20)}"
        if (key != lastShown) {
            lastShown = key
            try {
                NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, build(s))
            } catch (_: SecurityException) {
                // No notification permission: the service still runs, just without the card.
            }
        }
        handler.postDelayed(tick, if (s.running > 0) 2000 else 4000)
    }

    private fun build(s: Downloads.Summary) = NotificationCompat.Builder(this, CHANNEL).apply {
        setSmallIcon(R.drawable.ic_download)
        setColor(HarborColors.ACCENT)
        setOngoing(true)
        setOnlyAlertOnce(true)
        setSilent(true)
        setShowWhen(false)
        setPriority(NotificationCompat.PRIORITY_LOW)
        setCategory(NotificationCompat.CATEGORY_PROGRESS)
        setContentIntent(openDownloads(this@DownloadService))
        if (s.active == 0) {
            setContentTitle("Harbor")
            setContentText("يجهّز التحميلات…")
            setProgress(0, 0, true)
        } else {
            setContentTitle("جارٍ تحميل ${countText(s.active)}")
            val pct = s.percent()
            val size = if (s.total > 0) "${fmtSize(s.received)} من ${fmtSize(s.total)}" else fmtSize(s.received)
            setContentText(s.note ?: listOfNotNull(pct?.let { "$it%" }, size.ifBlank { null }).joinToString(" · "))
            setProgress(100, pct ?: 0, pct == null)
        }
    }.build()

    private fun countText(n: Int) = when {
        n == 1 -> "ملف واحد"
        n == 2 -> "ملفين"
        n in 3..10 -> "$n ملفات"
        else -> "$n ملف"
    }

    private fun fmtSize(b: Long): String = when {
        b <= 0 -> ""
        b >= 1L shl 30 -> String.format(Locale.US, "%.2f GB", b / (1L shl 30).toDouble())
        else -> String.format(Locale.US, "%d MB", b / (1L shl 20))
    }

    private fun shutdown() {
        stopping = true
        if (instance === this) instance = null
        handler.removeCallbacks(tick)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Android 15+: a data-sync service may run 6 hours a day. Without it Android may stop the
     *  downloads at any time, so say so instead of letting them stall unnoticed. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        if (Downloads.get(this).hasPendingWork()) notifyPaused(this)
        shutdown()
    }

    override fun onDestroy() {
        stopping = true
        handler.removeCallbacks(tick)
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "downloads"
        private const val NOTIFICATION_ID = 4101

        /** Until when the web UI has background work (season queue, subtitle searches). */
        @Volatile var keepAliveUntil = 0L

        /** The running service; only touched on the main thread. */
        private var instance: DownloadService? = null
        private val main = Handler(Looper.getMainLooper())

        private fun openDownloads(ctx: Context): PendingIntent {
            val i = Intent(ctx, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_DOWNLOADS, true)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(ctx, 1, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        private const val PAUSED_NOTIFICATION_ID = 4102

        /** "Downloads paused — tap to continue": after Android's daily background limit, or a
         *  reboot, unfinished downloads only go on once Harbor is opened again. */
        fun notifyPaused(ctx: Context) {
            createChannel(ctx)
            val n = NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_download)
                .setColor(HarborColors.ACCENT)
                .setContentTitle("توقفت التحميلات مؤقتاً")
                .setContentText("اضغط لمتابعة التحميلات من حيث وقفت")
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openDownloads(ctx))
                .build()
            try {
                NotificationManagerCompat.from(ctx).notify(PAUSED_NOTIFICATION_ID, n)
            } catch (_: SecurityException) {
            }
        }

        fun clearPausedNotice(ctx: Context) {
            try {
                NotificationManagerCompat.from(ctx).cancel(PAUSED_NOTIFICATION_ID)
            } catch (_: Exception) {
            }
        }

        /** "Download finished" / "Download failed" for one title (tapping opens Downloads). */
        fun notifyFinished(ctx: Context, id: String, title: String, ok: Boolean) {
            createChannel(ctx)
            val n = NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_download)
                .setColor(HarborColors.ACCENT)
                .setContentTitle(if (ok) "اكتمل التحميل" else "تعذّر التحميل")
                .setContentText(if (ok) title else "$title · افتح التحميلات واضغط إعادة المحاولة")
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(openDownloads(ctx))
                .build()
            try {
                NotificationManagerCompat.from(ctx).notify(id.hashCode(), n)
            } catch (_: SecurityException) {
            }
        }

        fun createChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
            if (nm.getNotificationChannel(CHANNEL) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "التحميلات", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "تقدّم التحميلات اللي تشتغل في الخلفية"
                    setShowBadge(false)
                },
            )
        }

        /** Starts the service, or wakes it if it's already running. Any thread; the check
         *  runs on the main thread so it can't race the service stopping itself. */
        fun ensureRunning(ctx: Context) {
            val app = ctx.applicationContext
            main.post {
                val s = instance
                if (s != null && !s.stopping) {
                    s.idleSince = 0L
                    s.poke()
                    return@post
                }
                try {
                    ContextCompat.startForegroundService(app, Intent(app, DownloadService::class.java))
                } catch (_: Exception) {
                    // In the background without an exemption (Android 12+): nothing to do; the
                    // system downloader still carries on, just under the normal limits.
                }
            }
        }

        /** The web UI has (or no longer has) background work. Expires on its own after a while
         *  so a page that died mid-job can't keep the service up forever. */
        fun keepAlive(ctx: Context, on: Boolean) {
            keepAliveUntil = if (on) System.currentTimeMillis() + KEEP_ALIVE_MS else 0L
            if (on) ensureRunning(ctx) else main.post { instance?.takeIf { !it.stopping }?.poke() }
        }

        private const val KEEP_ALIVE_MS = 15 * 60_000L
    }
}
