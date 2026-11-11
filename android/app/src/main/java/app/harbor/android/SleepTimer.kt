package app.harbor.android

/**
 * The player's sleep timer: pause after some minutes, or at the end of the video that is playing.
 * Only what was chosen and the arithmetic live here (unit-tested on the JVM); NativePlayer does
 * the waiting and the pausing. Times are milliseconds of a clock that never goes back
 * (SystemClock.elapsedRealtime).
 */
class SleepTimer {
    /** The minutes that were chosen (the chip that stays lit), 0 when no countdown is running. */
    var minutes = 0
        private set

    /** "End of this video" was chosen. */
    var endOfVideo = false
        private set

    private var deadline = 0L

    val armed: Boolean get() = minutes > 0 || endOfVideo

    /** Starts a countdown; answers how long to wait, in milliseconds. */
    fun setMinutes(m: Int, now: Long): Long {
        val wait = m.coerceAtLeast(1) * 60_000L
        minutes = m.coerceAtLeast(1)
        endOfVideo = false
        deadline = now + wait
        return wait
    }

    fun setEndOfVideo() {
        minutes = 0
        endOfVideo = true
        deadline = 0
    }

    fun off() {
        minutes = 0
        endOfVideo = false
        deadline = 0
    }

    /** Whole minutes left of a countdown, rounded up ("1 min" until the last moment); 0 without one. */
    fun remainingMinutes(now: Long): Int {
        if (minutes == 0) return 0
        val left = (deadline - now).coerceAtLeast(0)
        return ((left + 59_999) / 60_000).toInt().coerceAtLeast(1)
    }

    companion object {
        val PRESETS = listOf(15, 30, 45, 60, 90)

        /** "End of this video" pauses this long before the end. The page takes a video that stops
         *  within a second of its end as finished (and goes to the next episode or closes), so the
         *  pause has to come earlier than that. */
        const val END_LEAD_MS = 2000L

        /** The position is looked at once a second while playing. */
        const val CHECK_EVERY_MS = 1000L

        /** Where the end-of-video pause puts the position if the video got to its very end first. */
        const val END_BACK_OFF_MS = 3000L

        /**
         * Whether this look at the position is the last one before the end comes closer than
         * [END_LEAD_MS]: at [speed] the video moves that many seconds between two looks.
         */
        fun nearEnd(positionMs: Long, durationMs: Long, speed: Float): Boolean {
            if (durationMs <= 0) return false
            val step = (CHECK_EVERY_MS * speed.coerceAtLeast(1f)).toLong()
            return durationMs - positionMs <= END_LEAD_MS + step
        }
    }
}
