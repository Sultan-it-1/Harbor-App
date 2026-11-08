package app.harbor.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * After a reboot unfinished downloads can't restart on their own (Android 15 doesn't let a
 * data-sync service start at boot), so leave a "tap to continue" notification instead of
 * letting them sit at "downloading" unnoticed.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        try {
            if (Downloads.pendingAtBoot(context) > 0) DownloadService.notifyPaused(context)
        } catch (_: Exception) {
        }
    }
}
