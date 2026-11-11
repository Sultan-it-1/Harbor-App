package app.harbor.android

import app.harbor.android.DualSubs.Bottom
import app.harbor.android.DualSubs.Pad
import app.harbor.android.DualSubs.Plan
import app.harbor.android.DualSubs.Slot
import app.harbor.android.DualSubs.Syncing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Two subtitles at once: which side each takes, and the padding that puts it there
 *  (NativePlayer applies these to the views). */
class DualSubsTest {
    /** Two subtitles, side by side, in full screen: each test changes what it is about. */
    private fun state(
        firstOn: Boolean = true,
        secondOn: Boolean = true,
        stacked: Boolean = false,
        swapped: Boolean = false,
        firstLang: String? = "en",
        secondLang: String? = "fr",
        portrait: Boolean = false,
        firstIsPicture: Boolean = false,
        inPip: Boolean = false,
        syncing: Syncing = Syncing.NONE,
    ) = DualSubs.State(firstOn, secondOn, stacked, swapped, firstLang, secondLang, portrait, firstIsPicture, inPip, syncing)

    // ---- right-to-left languages ----

    @Test
    fun theRightToLeftLanguages() {
        for (l in listOf("ar", "he", "iw", "fa", "ur", "ps", "ckb", "yi", "dv", "ug", "sd")) assertTrue(l, DualSubs.isRtl(l))
        // As addons and video files write them: three letters, a region, capitals, a name.
        for (l in listOf("ara", "heb", "per", "fas", "urd", "pus", "ar-SA", "AR", "he_IL", " fa ", "Arabic")) assertTrue(l, DualSubs.isRtl(l))
    }

    @Test
    fun everyOtherLanguageIsLeftToRight() {
        for (l in listOf("en", "fr", "tr", "ja", "zh", "hi", "pt-br", "eng", "und", "", "  ")) assertFalse(l, DualSubs.isRtl(l))
        assertFalse(DualSubs.isRtl(null))
        // Not "starts with ar": Armenian and Aragonese are written left to right.
        assertFalse(DualSubs.isRtl("arm"))
        assertFalse(DualSubs.isRtl("an"))
    }

    @Test
    fun aScriptInTheCodeDecides() {
        // Kurdish is mostly written in Latin letters; in Arabic ones only when the code says so.
        assertFalse(DualSubs.isRtl("ku"))
        assertTrue(DualSubs.isRtl("ku-Arab"))
        assertTrue(DualSubs.isRtl("ku_arab_IQ"))
        assertTrue(DualSubs.isRtl("pa-Arab"))
        assertFalse(DualSubs.isRtl("ug-Cyrl"))
        assertFalse(DualSubs.isRtl("ar-Latn"))
    }

    // ---- which side ----

    @Test
    fun theRightToLeftOneGoesOnTheRight() {
        assertTrue(DualSubs.firstOnRight("ar", "en", swapped = false))
        assertFalse(DualSubs.firstOnRight("en", "ar", swapped = false))
    }

    @Test
    fun twoOfAKindKeepTheFirstOnTheLeft() {
        assertFalse(DualSubs.firstOnRight("en", "fr", swapped = false))
        assertFalse(DualSubs.firstOnRight("ar", "he", swapped = false))
        assertFalse(DualSubs.firstOnRight(null, null, swapped = false))
    }

    @Test
    fun swapTurnsEveryAnswerAround() {
        assertFalse(DualSubs.firstOnRight("ar", "en", swapped = true))
        assertTrue(DualSubs.firstOnRight("en", "ar", swapped = true))
        assertTrue(DualSubs.firstOnRight("en", "fr", swapped = true))
        assertTrue(DualSubs.firstOnRight("ar", "fa", swapped = true))
    }

    // ---- where each subtitle goes ----

    @Test
    fun oneSubtitleIsLaidOutAsItAlwaysWas() {
        val whole = Plan(Slot.FULL, Slot.HIDDEN, Bottom.OWN)
        assertEquals(whole, DualSubs.plan(state(secondOn = false)))
        // None of the settings for two subtitles reach it.
        assertEquals(whole, DualSubs.plan(state(secondOn = false, stacked = true, swapped = true, portrait = true, firstLang = "ar")))
        assertEquals(whole, DualSubs.plan(state(secondOn = false, firstOn = false)))
        assertEquals(whole, DualSubs.plan(state(secondOn = false, inPip = true)))
        // The sync panel: beside it.
        assertEquals(Plan(Slot.BESIDE_PANEL, Slot.HIDDEN, Bottom.OWN), DualSubs.plan(state(secondOn = false, syncing = Syncing.FIRST)))
    }

    @Test
    fun sideBySideGivesEachAHalf() {
        assertEquals(Plan(Slot.LEFT, Slot.RIGHT, Bottom.OWN), DualSubs.plan(state()))
        assertEquals(Plan(Slot.RIGHT, Slot.LEFT, Bottom.OWN), DualSubs.plan(state(swapped = true)))
        assertEquals(Plan(Slot.RIGHT, Slot.LEFT, Bottom.OWN), DualSubs.plan(state(firstLang = "ar", secondLang = "en")))
        assertEquals(Plan(Slot.LEFT, Slot.RIGHT, Bottom.OWN), DualSubs.plan(state(firstLang = "en", secondLang = "ar")))
        assertEquals(Plan(Slot.LEFT, Slot.RIGHT, Bottom.OWN), DualSubs.plan(state(firstLang = "ar", secondLang = "en", swapped = true)))
    }

    @Test
    fun stackedPutsTheSecondAboveTheFirstAtFullWidth() {
        val stacked = Plan(Slot.FULL, Slot.FULL, Bottom.ABOVE_FIRST)
        assertEquals(stacked, DualSubs.plan(state(stacked = true)))
        // The sides mean nothing then.
        assertEquals(stacked, DualSubs.plan(state(stacked = true, swapped = true, firstLang = "ar")))
    }

    @Test
    fun sideBySideGivesWayToStackedWhenItCantWork() {
        val stacked = Plan(Slot.FULL, Slot.FULL, Bottom.ABOVE_FIRST)
        // Upright, half the width is too narrow to read.
        assertEquals(stacked, DualSubs.plan(state(portrait = true)))
        // A subtitle made of pictures would be squashed into its half.
        assertEquals(stacked, DualSubs.plan(state(firstIsPicture = true)))
        assertTrue(DualSubs.stackedNow(state(portrait = true)))
        assertTrue(DualSubs.stackedNow(state(firstIsPicture = true)))
        assertTrue(DualSubs.stackedNow(state(stacked = true)))
        assertFalse(DualSubs.stackedNow(state()))
    }

    @Test
    fun theSecondIsNeverLeftAloneInAHalf() {
        // No first subtitle (it was an embedded track the new stream doesn't have): full width.
        assertEquals(Plan(Slot.FULL, Slot.FULL, Bottom.OWN), DualSubs.plan(state(firstOn = false)))
        assertEquals(Plan(Slot.FULL, Slot.FULL, Bottom.OWN), DualSubs.plan(state(firstOn = false, swapped = true, firstLang = "ar")))
        // Stacked, it keeps the first one's place.
        assertEquals(Plan(Slot.FULL, Slot.FULL, Bottom.FIRST_LINE), DualSubs.plan(state(firstOn = false, stacked = true)))
    }

    @Test
    fun pictureInPictureShowsOnlyTheFirstAtFullWidth() {
        val small = Plan(Slot.FULL, Slot.HIDDEN, Bottom.OWN)
        assertEquals(small, DualSubs.plan(state(inPip = true)))
        assertEquals(small, DualSubs.plan(state(inPip = true, stacked = true)))
        assertEquals(small, DualSubs.plan(state(inPip = true, swapped = true, firstLang = "ar")))
        // And both are back, as they were, when it ends.
        assertEquals(Plan(Slot.LEFT, Slot.RIGHT, Bottom.OWN), DualSubs.plan(state(inPip = false)))
    }

    @Test
    fun theSyncPanelShowsOnlyTheSubtitleBeingSynced() {
        assertEquals(Plan(Slot.BESIDE_PANEL, Slot.HIDDEN, Bottom.OWN), DualSubs.plan(state(syncing = Syncing.FIRST)))
        assertEquals(Plan(Slot.BESIDE_PANEL, Slot.HIDDEN, Bottom.OWN), DualSubs.plan(state(syncing = Syncing.FIRST, stacked = true)))
        assertEquals(Plan(Slot.HIDDEN, Slot.BESIDE_PANEL, Bottom.OWN), DualSubs.plan(state(syncing = Syncing.SECOND)))
        // Stacked, the second has no position of its own: it takes the hidden first one's.
        assertEquals(Plan(Slot.HIDDEN, Slot.BESIDE_PANEL, Bottom.FIRST_LINE), DualSubs.plan(state(syncing = Syncing.SECOND, stacked = true)))
        // Also when the first is an embedded track that isn't showing a line.
        assertEquals(Plan(Slot.HIDDEN, Slot.BESIDE_PANEL, Bottom.OWN), DualSubs.plan(state(syncing = Syncing.SECOND, firstOn = false)))
        // Closed again: both, as before.
        assertEquals(Plan(Slot.LEFT, Slot.RIGHT, Bottom.OWN), DualSubs.plan(state(syncing = Syncing.NONE)))
    }

    // ---- padding ----

    private fun pad(slot: Slot, width: Int = 2400, edge: Int = 100, gutter: Int = 20, panel: Int = 900, panelOnLeft: Boolean = false) =
        DualSubs.pad(slot, width, edge, gutter, panel, panelOnLeft)

    @Test
    fun fullWidthAndHiddenHaveNoPadding() {
        assertEquals(Pad(0, 0), pad(Slot.FULL))
        assertEquals(Pad(0, 0), pad(Slot.HIDDEN))
    }

    @Test
    fun theHalvesMeetInTheMiddleAndKeepClearOfTheEdges() {
        // Left: from the edge to just short of the middle. Right: the mirror image.
        assertEquals(Pad(100, 1220), pad(Slot.LEFT))
        assertEquals(Pad(1220, 100), pad(Slot.RIGHT))
        // What is left for the text is the same on both sides.
        val left = pad(Slot.LEFT)
        val right = pad(Slot.RIGHT)
        assertEquals(2400 - left.left - left.right, 2400 - right.left - right.right)
        // Nothing of one half reaches into the other.
        assertTrue(2400 - left.right <= right.left)
    }

    @Test
    fun anOddWidthStillLeavesNoOverlap() {
        val left = pad(Slot.LEFT, width = 2401, edge = 0, gutter = 0)
        val right = pad(Slot.RIGHT, width = 2401, edge = 0, gutter = 0)
        assertEquals(Pad(0, 1201), left)
        assertEquals(Pad(1200, 0), right)
        assertEquals(2401 - left.right, right.left)
    }

    @Test
    fun aViewTooNarrowToDivideKeepsItsWidth() {
        assertEquals(Pad(0, 0), pad(Slot.LEFT, width = 200, edge = 100, gutter = 20))
        assertEquals(Pad(0, 0), pad(Slot.RIGHT, width = 200, edge = 100, gutter = 20))
        // A view that has not been measured yet is given its padding all the same.
        assertEquals(Pad(100, 20), pad(Slot.LEFT, width = 0))
    }

    @Test
    fun besideTheSyncPanelIsThePartItLeavesFree() {
        // The panel sits on the right, or on the left in a right-to-left language.
        assertEquals(Pad(0, 900), pad(Slot.BESIDE_PANEL))
        assertEquals(Pad(900, 0), pad(Slot.BESIDE_PANEL, panelOnLeft = true))
        // The edge and the gutter belong to the halves only.
        assertEquals(Pad(0, 900), pad(Slot.BESIDE_PANEL, edge = 300, gutter = 300))
    }

    // ---- stacked: how high the second sits ----

    @Test
    fun theSecondSitsJustAboveTheFirstOnesText() {
        // The first reaches from 86 to 206 px above the bottom; a gap of 10 on top of that.
        assertEquals(216, DualSubs.stackedLift(firstLow = 86, firstHigh = 206, secondText = 120, boxHeight = 1080, gap = 10))
        // One more line on the first lifts the second by that line.
        assertEquals(276, DualSubs.stackedLift(firstLow = 86, firstHigh = 266, secondText = 120, boxHeight = 1080, gap = 10))
    }

    @Test
    fun whileTheFirstShowsNothingTheSecondTakesItsPlace() {
        assertEquals(86, DualSubs.stackedLift(firstLow = 86, firstHigh = 86, secondText = 120, boxHeight = 1080, gap = 10))
        assertEquals(0, DualSubs.stackedLift(firstLow = -40, firstHigh = -40, secondText = 120, boxHeight = 1080, gap = 10))
    }

    @Test
    fun aFirstSetToTheTopHasTheSecondUnderIt() {
        // The first at the top limit (0.8 of 1080) with two lines: above it the second would
        // leave the picture, so it goes underneath.
        assertEquals(864 - 10 - 120, DualSubs.stackedLift(firstLow = 864, firstHigh = 984, secondText = 120, boxHeight = 1080, gap = 10))
        // With room for it above, it stays above.
        assertEquals(934, DualSubs.stackedLift(firstLow = 864, firstHigh = 924, secondText = 60, boxHeight = 1080, gap = 10))
    }

    @Test
    fun withNoRoomEitherWayTheSecondStaysAbove() {
        // Text so large that it fits neither over nor under the first.
        assertEquals(1010, DualSubs.stackedLift(firstLow = 100, firstHigh = 1000, secondText = 400, boxHeight = 1080, gap = 10))
    }
}
