package app.harbor.android

import android.annotation.SuppressLint
import android.content.Context
import android.os.SystemClock
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewConfiguration
import kotlin.math.abs

/**
 * Touch gestures on the video, like the big Android players:
 *  - tap: show / hide controls
 *  - double tap left / right third: seek -10 s / +10 s (keep tapping to add more), middle: play / pause
 *  - swipe up/down on the left half: brightness, on the right half: volume
 *  - swipe sideways: scrub (applied when the finger lifts)
 *  - pinch: fill the screen / fit the picture
 * Touches that land on the player's own buttons and seek bar never reach this listener.
 */
class PlayerGestures(context: Context, private val cb: Callbacks) : View.OnTouchListener {
    interface Callbacks {
        val locked: Boolean
        fun onTap()
        fun onLockedTap()
        fun onDoubleTapSeek(forward: Boolean, totalSec: Int)
        fun onDoubleTapCenter()
        fun onBrightnessStart(): Float
        fun onBrightness(value: Float)
        fun onVolumeStart(): Float
        fun onVolume(value: Float)
        fun onSeekPreview(deltaMs: Long)
        fun onSeekCommit(deltaMs: Long)
        fun onPinch(zoomIn: Boolean)
        fun onGestureEnd()
    }

    private enum class Mode { NONE, BRIGHTNESS, VOLUME, SEEK, PINCH }

    private var mode = Mode.NONE
    private var width = 1
    private var height = 1
    private var downX = 0f
    private var downY = 0f
    private var startValue = 0f
    private var seekDelta = 0L
    private var pinchScale = 1f
    private var seekSide = 0 // -1 back, +1 forward, 0 none
    private var seekSteps = 0
    private var seekModeUntil = 0L
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

    private val scale = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(d: ScaleGestureDetector): Boolean {
            if (cb.locked) return false
            mode = Mode.PINCH
            pinchScale = 1f
            return true
        }

        override fun onScale(d: ScaleGestureDetector): Boolean {
            pinchScale *= d.scaleFactor
            if (pinchScale > 1.12f) { cb.onPinch(true); pinchScale = 1f }
            else if (pinchScale < 0.89f) { cb.onPinch(false); pinchScale = 1f }
            return true
        }
    })

    private val taps = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        override fun onSingleTapUp(e: MotionEvent): Boolean {
            // While a double-tap seek is "hot", every extra tap on the same side adds 10 s at once.
            if (!cb.locked && SystemClock.uptimeMillis() < seekModeUntil) {
                val side = sideOf(e.x)
                if (side != 0 && side == seekSide) { stepSeek(side); return true }
            }
            return false
        }

        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            if (SystemClock.uptimeMillis() < seekModeUntil) return true
            if (cb.locked) cb.onLockedTap() else cb.onTap()
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (cb.locked) { cb.onLockedTap(); return true }
            val side = sideOf(e.x)
            if (side == 0) { cb.onDoubleTapCenter(); return true }
            if (side != seekSide || SystemClock.uptimeMillis() >= seekModeUntil) seekSteps = 0
            stepSeek(side)
            return true
        }
    })

    private fun sideOf(x: Float) = when {
        x < width * 0.35f -> -1
        x > width * 0.65f -> 1
        else -> 0
    }

    private fun stepSeek(side: Int) {
        seekSide = side
        seekSteps++
        seekModeUntil = SystemClock.uptimeMillis() + 750
        cb.onDoubleTapSeek(side > 0, seekSteps * 10)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouch(v: View, ev: MotionEvent): Boolean {
        width = v.width.coerceAtLeast(1)
        height = v.height.coerceAtLeast(1)
        scale.onTouchEvent(ev)
        if (mode != Mode.PINCH && ev.pointerCount == 1) taps.onTouchEvent(ev)

        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                mode = Mode.NONE
                downX = ev.x
                downY = ev.y
                seekDelta = 0
            }
            MotionEvent.ACTION_MOVE -> if (!cb.locked && ev.pointerCount == 1 && mode != Mode.PINCH) {
                val dx = ev.x - downX
                val dy = ev.y - downY
                if (mode == Mode.NONE && (abs(dx) > touchSlop * 2 || abs(dy) > touchSlop * 2)) {
                    // Leave the strips near the top/bottom edges to the system gesture areas and bars.
                    val inEdge = downY < height * 0.08f || downY > height * 0.9f
                    mode = when {
                        inEdge -> Mode.NONE
                        abs(dx) > abs(dy) -> Mode.SEEK
                        downX < width / 2f -> Mode.BRIGHTNESS.also { startValue = cb.onBrightnessStart() }
                        else -> Mode.VOLUME.also { startValue = cb.onVolumeStart() }
                    }
                }
                when (mode) {
                    Mode.BRIGHTNESS -> cb.onBrightness((startValue - dy / (height * 0.8f)).coerceIn(0f, 1f))
                    Mode.VOLUME -> cb.onVolume((startValue - dy / (height * 0.8f)).coerceIn(0f, 1f))
                    Mode.SEEK -> {
                        // A full-width swipe moves two minutes.
                        seekDelta = (dx / width * 120_000).toLong()
                        cb.onSeekPreview(seekDelta)
                    }
                    else -> {}
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (mode == Mode.SEEK && ev.actionMasked == MotionEvent.ACTION_UP) cb.onSeekCommit(seekDelta)
                if (mode != Mode.NONE) cb.onGestureEnd()
                mode = Mode.NONE
            }
        }
        return true
    }
}
