package app.harbor.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Hold for double speed against the other gestures of one touch (PlayerGestures). */
class HoldGateTest {
    private var started = 0
    private val start = { started++; true }

    @Test
    fun aLongPressTurnsTheSpeedUpUntilTheFingerLifts() {
        val g = HoldGate()
        g.down(allowed = true)
        assertFalse(g.holding)
        assertTrue(g.longPress(start))
        assertTrue(g.holding)
        assertEquals(1, started)
        assertTrue("the caller puts the speed back", g.release())
        assertFalse(g.holding)
    }

    @Test
    fun aPlainTapPutsNothingBack() {
        val g = HoldGate()
        g.down(allowed = true)
        assertFalse(g.release())
    }

    @Test
    fun onceADragHasStartedALongPressDoesNothing() {
        val g = HoldGate()
        g.down(allowed = true)
        g.claim() // the finger moved far enough for brightness / volume / seek
        assertFalse(g.longPress(start))
        assertEquals(0, started)
        assertFalse(g.holding)
        assertFalse(g.release())
    }

    @Test
    fun whileAHoldIsOnADragCannotTakeTheTouch() {
        val g = HoldGate()
        g.down(allowed = true)
        g.longPress(start)
        g.claim() // the finger moves, or a second one lands
        assertTrue("the listener starts no drag while this is true", g.holding)
        assertTrue(g.release())
    }

    @Test
    fun noHoldWhereItIsNotAllowed() {
        // A locked screen, or the strips along the top and bottom edges.
        val g = HoldGate()
        g.down(allowed = false)
        assertFalse(g.longPress(start))
        assertEquals(0, started)
        assertFalse(g.release())
    }

    @Test
    fun nothingPlayingMeansNoHold() {
        val g = HoldGate()
        g.down(allowed = true)
        assertFalse(g.longPress { false })
        assertFalse(g.holding)
        // And it is not asked again for the same touch.
        assertFalse(g.longPress(start))
        assertEquals(0, started)
        assertFalse(g.release())
    }

    @Test
    fun aLongPressThatArrivesAfterTheFingerLiftedIsIgnored() {
        val g = HoldGate()
        g.down(allowed = true)
        g.release()
        assertFalse(g.longPress(start))
        assertEquals(0, started)
    }

    @Test
    fun aLongPressBeforeAnyTouchIsIgnored() {
        assertFalse(HoldGate().longPress(start))
        assertEquals(0, started)
    }

    @Test
    fun everyTouchStartsFresh() {
        val g = HoldGate()
        g.down(allowed = true)
        g.claim()
        g.release()
        g.down(allowed = true)
        assertTrue(g.longPress(start))
        assertTrue(g.release())
        // A second long press of the same touch can't start a second hold.
        g.down(allowed = true)
        assertTrue(g.longPress(start))
        assertFalse(g.longPress(start))
        assertEquals(2, started)
    }
}
