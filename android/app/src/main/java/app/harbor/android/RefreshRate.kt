package app.harbor.android

import android.app.Activity
import android.os.Build
import android.view.Display
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Picks the display mode for the window:
 *  - UI: the panel's highest refresh rate (90/120/144 Hz) instead of the 60 Hz many phones
 *    fall back to for WebView content.
 *  - Video: the highest refresh rate that is a whole multiple of the film's frame rate
 *    (24 fps → 120 Hz, 25 fps → 100/50 Hz, 30 fps → 120/60 Hz), so every frame is shown for
 *    the same time and pans don't judder. Same resolution only, so the switch is seamless.
 */
object RefreshRate {
    fun apply(activity: Activity, videoFps: Float? = null) {
        val display = currentDisplay(activity) ?: return
        val current = display.mode
        val modes = display.supportedModes.filter {
            it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight
        }
        if (modes.isEmpty()) return
        val rate = pick(modes.map { it.refreshRate }, videoFps) ?: return
        val best = modes.first { it.refreshRate == rate }
        val attrs = activity.window.attributes
        if (attrs.preferredDisplayModeId == best.modeId) return
        attrs.preferredDisplayModeId = best.modeId
        activity.window.attributes = attrs
    }

    /** Highest rate for the UI; for video the highest whole multiple of [videoFps] (else highest). */
    fun pick(rates: List<Float>, videoFps: Float?): Float? {
        if (rates.isEmpty()) return null
        if (videoFps != null && videoFps > 1f) {
            rates.filter { isMultiple(it, videoFps) }.maxOrNull()?.let { return it }
        }
        return rates.maxOrNull()
    }

    /** 119.88 / 23.976 ≈ 5, 120 / 24 = 5, 60 / 25 = 2.4 (not a multiple). */
    private fun isMultiple(refresh: Float, fps: Float): Boolean {
        val ratio = refresh / fps
        val n = ratio.roundToInt()
        return n >= 1 && abs(ratio - n) < 0.02f * n
    }

    @Suppress("DEPRECATION")
    private fun currentDisplay(activity: Activity): Display? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.display else activity.windowManager.defaultDisplay
}
