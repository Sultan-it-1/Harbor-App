package app.harbor.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
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

    @Test
    fun theLastCueThatHasStarted() {
        assertEquals(-1, CueTiming.lastStarted(starts, 999_999))
        assertEquals(0, CueTiming.lastStarted(starts, 1_000_000))
        assertEquals(1, CueTiming.lastStarted(starts, 7_000_000))
        assertEquals(2, CueTiming.lastStarted(starts, 99_000_000))
        assertEquals(-1, CueTiming.lastStarted(LongArray(0), 5))
    }

    // ---- the times a synced subtitle is drawn from ----

    @Test
    fun withoutASyncTheFilesOwnTimesAreDrawn() {
        for (sync in listOf(null, TextSync.State())) {
            val d = CueTiming.retime(starts, ends, sync)
            assertSame(starts, d.starts)
            assertSame(ends, d.ends)
            assertSame(starts, d.cueStarts)
            assertNull(d.order)
            assertEquals(4_000_000L, d.maxDur)
        }
    }

    @Test
    fun aSyncMovesTheDrawnTimesAndLeavesTheFilesAlone() {
        // The cue at 2 s was heard at 4.5 s: everything 2.5 s later.
        val d = CueTiming.retime(starts, ends, TextSync.State(listOf(TextSync.Point(2.0, 4.5))))
        assertArrayEquals(longArrayOf(3_500_000, 4_500_000, 12_500_000), d.starts)
        assertArrayEquals(longArrayOf(5_500_000, 8_500_000, 14_500_000), d.ends)
        assertNull(d.order)
        assertArrayEquals(longArrayOf(1_000_000, 2_000_000, 10_000_000), starts)
        assertArrayEquals(intArrayOf(0), CueTiming.activeAt(d.starts, d.ends, 4_000_000, d.maxDur))
        assertArrayEquals(intArrayOf(0, 1), CueTiming.activeAt(d.starts, d.ends, 5_000_000, d.maxDur))
    }

    @Test
    fun aSectionMovedPastItsNeighboursIsDrawnInTheNewOrder() {
        // The last cue (10-12 s) is pulled 9.5 s earlier, in front of the other two.
        val sync = TextSync.State(segments = listOf(TextSync.Segment(2, 2, -9.5)))
        val d = CueTiming.retime(starts, ends, sync)
        // By cue: as in the file, with the one moved.
        assertArrayEquals(longArrayOf(1_000_000, 2_000_000, 500_000), d.cueStarts)
        assertArrayEquals(longArrayOf(3_000_000, 6_000_000, 2_500_000), d.cueEnds)
        // Drawn: ascending again, with the cue each place holds.
        assertArrayEquals(longArrayOf(500_000, 1_000_000, 2_000_000), d.starts)
        assertArrayEquals(longArrayOf(2_500_000, 3_000_000, 6_000_000), d.ends)
        assertArrayEquals(intArrayOf(2, 0, 1), d.order)
        assertEquals(4_000_000L, d.maxDur)
        val shown = CueTiming.activeAt(d.starts, d.ends, 700_000, d.maxDur).map { d.order!![it] }
        assertEquals(listOf(2), shown)
        val all = CueTiming.activeAt(d.starts, d.ends, 2_200_000, d.maxDur).map { d.order!![it] }
        assertEquals(listOf(2, 0, 1), all)
    }

    @Test
    fun aLateSyncOfALongFilmStaysExactToTheMillisecond() {
        // Three hours in, with drift: no rounding noise from working in seconds.
        val s = longArrayOf(10_000_000, 10_800_123_000)
        val e = longArrayOf(12_000_000, 10_802_456_000)
        val d = CueTiming.retime(s, e, TextSync.State(nudge = 0.3))
        assertArrayEquals(longArrayOf(10_300_000, 10_800_423_000), d.starts)
        assertArrayEquals(longArrayOf(12_300_000, 10_802_756_000), d.ends)
    }
}
