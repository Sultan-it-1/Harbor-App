package app.harbor.android

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class CueTimingTest {
    // cue 0: 1s-3s, cue 1: 2s-6s (overlaps), cue 2: 10s-12s
    private val starts = longArrayOf(1_000_000, 2_000_000, 10_000_000)
    private val ends = longArrayOf(3_000_000, 6_000_000, 12_000_000)
    private val maxDur = 4_000_000L

    private fun at(t: Long) = CueTiming.activeAt(starts, ends, t, maxDur)

    @Test fun beforeFirstCue() = assertArrayEquals(intArrayOf(), at(500_000))
    @Test fun singleCue() = assertArrayEquals(intArrayOf(0), at(1_500_000))
    @Test fun overlappingCues() = assertArrayEquals(intArrayOf(0, 1), at(2_500_000))
    @Test fun endIsExclusive() = assertArrayEquals(intArrayOf(1), at(3_000_000))
    @Test fun gap() = assertArrayEquals(intArrayOf(), at(7_000_000))
    @Test fun lastCue() = assertArrayEquals(intArrayOf(2), at(11_999_999))
    @Test fun afterLast() = assertArrayEquals(intArrayOf(), at(20_000_000))
}
