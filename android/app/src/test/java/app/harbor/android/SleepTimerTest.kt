package app.harbor.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sleep timer's choices and arithmetic (NativePlayer does the waiting and the pausing). */
class SleepTimerTest {
    private val t0 = 5_000_000L

    @Test
    fun startsOff() {
        val s = SleepTimer()
        assertFalse(s.armed)
        assertEquals(0, s.minutes)
        assertFalse(s.endOfVideo)
        assertEquals(0, s.remainingMinutes(t0))
    }

    @Test
    fun aCountdownSaysHowLongToWaitAndHowMuchIsLeft() {
        val s = SleepTimer()
        assertEquals(30 * 60_000L, s.setMinutes(30, t0))
        assertTrue(s.armed)
        assertEquals(30, s.minutes)
        assertEquals(30, s.remainingMinutes(t0))
        // Rounded up: a minute and a second left reads "2 min", the last second "1 min".
        assertEquals(30, s.remainingMinutes(t0 + 1))
        assertEquals(29, s.remainingMinutes(t0 + 60_000))
        assertEquals(2, s.remainingMinutes(t0 + 28 * 60_000 + 59_000))
        assertEquals(1, s.remainingMinutes(t0 + 30 * 60_000 - 1))
        // Late (the phone slept): still "1 min" until it fires, never a negative number.
        assertEquals(1, s.remainingMinutes(t0 + 31 * 60_000))
        // The chip that was chosen stays the same while the time runs down.
        assertEquals(30, s.minutes)
    }

    @Test
    fun choosingAgainReplacesWhatWasChosen() {
        val s = SleepTimer()
        s.setMinutes(90, t0)
        s.setEndOfVideo()
        assertTrue(s.armed)
        assertTrue(s.endOfVideo)
        assertEquals(0, s.minutes)
        assertEquals(0, s.remainingMinutes(t0))
        s.setMinutes(15, t0)
        assertFalse(s.endOfVideo)
        assertEquals(15, s.minutes)
        s.off()
        assertFalse(s.armed)
        assertEquals(0, s.remainingMinutes(t0))
    }

    @Test
    fun theChipsAreTheOnesInThePanel() = assertEquals(listOf(15, 30, 45, 60, 90), SleepTimer.PRESETS)

    @Test
    fun endOfVideoPausesBeforeThePageWouldCallItFinished() {
        val dur = 1_400_000L
        // One look a second: the last look before the end comes within two seconds of it.
        assertFalse(SleepTimer.nearEnd(dur - 3_001, dur, 1f))
        assertTrue(SleepTimer.nearEnd(dur - 3_000, dur, 1f))
        assertTrue(SleepTimer.nearEnd(dur - 2_100, dur, 1f))
        // The look after a "not yet" is at most a second of video later: still two seconds short.
        val next = dur - 3_001 + SleepTimer.CHECK_EVERY_MS
        assertTrue(dur - next > SleepTimer.END_LEAD_MS)
    }

    @Test
    fun fasterPlaybackLooksFurtherAhead() {
        val dur = 1_400_000L
        assertFalse(SleepTimer.nearEnd(dur - 4_001, dur, 2f))
        assertTrue(SleepTimer.nearEnd(dur - 4_000, dur, 2f))
        // Two seconds of video pass between looks at 2x: the pause still comes two seconds early.
        assertTrue(dur - (dur - 4_001 + 2 * SleepTimer.CHECK_EVERY_MS) > SleepTimer.END_LEAD_MS)
        // Slow motion looks no less far ahead than normal speed.
        assertTrue(SleepTimer.nearEnd(dur - 3_000, dur, 0.5f))
    }

    @Test
    fun withoutAKnownLengthThereIsNoEndToWaitFor() {
        assertFalse(SleepTimer.nearEnd(10_000, 0, 1f))
        assertFalse(SleepTimer.nearEnd(10_000, -1, 1f))
    }

    @Test
    fun theFallbackLandsOutsideThePagesFinishedWindow() {
        // The page takes "stopped within a second of the end" as finished.
        assertTrue(SleepTimer.END_BACK_OFF_MS > 1_000)
        assertTrue(SleepTimer.END_LEAD_MS > 1_000)
    }
}
