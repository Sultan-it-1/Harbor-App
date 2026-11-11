package app.harbor.android

import app.harbor.android.SkipSegments.Action
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What the native skip button does at a position (the page sends the segments). */
class SkipSegmentsTest {
    private val recap = SkipSegment(SkipSegments.RECAP, 0, 30_000)
    private val intro = SkipSegment(SkipSegments.INTRO, 60_000, 150_000)
    private val midCredits = SkipSegment(SkipSegments.OUTRO, 1_200_000, 1_260_000)
    private val endCredits = SkipSegment(SkipSegments.OUTRO, 1_300_000, 1_399_000)
    private val all = listOf(recap, intro, midCredits, endCredits)
    private val duration = 1_400_000L

    private fun decide(
        pos: Long,
        hasNext: Boolean = false,
        auto: Boolean = false,
        skipped: Set<SkipSegment> = emptySet(),
        dur: Long = duration,
    ) = SkipSegments.decide(all, pos, dur, hasNext, auto, skipped)

    @Test
    fun readsThePagesListAndDropsWhatIsNotASegment() {
        val arr = JSONArray(
            """[
              {"kind":"outro","startMs":900000,"endMs":960000},
              {"kind":"intro","startMs":60000,"endMs":150000},
              {"kind":"advert","startMs":0,"endMs":5000},
              {"kind":"recap","startMs":40000,"endMs":40000},
              {"kind":"recap","startMs":-5,"endMs":2000},
              {"kind":"intro"},
              "nonsense"
            ]""",
        )
        assertEquals(
            listOf(SkipSegment("intro", 60_000, 150_000), SkipSegment("outro", 900_000, 960_000)),
            SkipSegments.parse(arr),
        )
        assertEquals(emptyList<SkipSegment>(), SkipSegments.parse(null))
        assertEquals(emptyList<SkipSegment>(), SkipSegments.parse(JSONArray()))
    }

    @Test
    fun aSegmentIsOnFromItsStartUntilJustBeforeItsEnd() {
        assertNull(SkipSegments.activeAt(all, 59_999))
        assertEquals(intro, SkipSegments.activeAt(all, 60_000))
        assertEquals(intro, SkipSegments.activeAt(all, 149_000))
        assertNull(SkipSegments.activeAt(all, 150_000 - SkipSegments.TAIL_MS))
        assertNull(SkipSegments.activeAt(all, 150_000))
        assertNull(SkipSegments.activeAt(emptyList(), 70_000))
    }

    @Test
    fun offersTheSegmentThatIsPlaying() {
        assertEquals(SkipSegments.Decision(Action.OFFER, recap), decide(5_000))
        assertEquals(SkipSegments.Decision(Action.OFFER, intro), decide(70_000))
        assertEquals(SkipSegments.Decision(Action.NONE), decide(40_000))
        // The skip itself lands at the segment's end, where nothing is offered any more.
        assertEquals(Action.NONE, decide(SkipSegments.target(intro, duration)).action)
    }

    @Test
    fun skipsAnIntroByItselfOnlyOnceAndOnlyWhenAskedTo() {
        assertEquals(SkipSegments.Decision(Action.AUTO_SKIP, intro), decide(70_000, auto = true))
        // Seeking back into it afterwards offers the button instead.
        assertEquals(SkipSegments.Decision(Action.OFFER, intro), decide(70_000, auto = true, skipped = setOf(intro)))
        // Recaps and credits are never skipped by themselves.
        assertEquals(Action.OFFER, decide(5_000, auto = true).action)
        assertEquals(Action.OFFER, decide(1_210_000, auto = true).action)
    }

    @Test
    fun theSamePlaceInAListSentAgainCountsAsAlreadySkipped() {
        // The page sends the list again whenever it changes; segments compare by what they are.
        val again = SkipSegments.parse(JSONArray("""[{"kind":"intro","startMs":60000,"endMs":150000}]"""))
        assertEquals(Action.OFFER, SkipSegments.decide(again, 70_000, duration, false, true, setOf(intro)).action)
    }

    @Test
    fun creditsThatRunToTheEndLeaveTheButtonToTheNextEpisode() {
        assertEquals(SkipSegments.Decision(Action.NEXT_EPISODE, endCredits), decide(1_310_000, hasNext = true))
        // No next episode (a film, the last episode): "Skip credits" it is.
        assertEquals(SkipSegments.Decision(Action.OFFER, endCredits), decide(1_310_000, hasNext = false))
        // Credits followed by more of the episode are skipped as usual.
        assertEquals(SkipSegments.Decision(Action.OFFER, midCredits), decide(1_210_000, hasNext = true))
        // The length isn't known yet: nothing says they run to the end.
        assertEquals(Action.OFFER, decide(1_310_000, hasNext = true, dur = 0).action)
    }

    @Test
    fun exactlyTwoSecondsFromTheEndStillCountsAsTheEnd() {
        val seg = SkipSegment(SkipSegments.OUTRO, 1_000_000, duration - SkipSegments.END_SLACK_MS)
        assertEquals(Action.NEXT_EPISODE, SkipSegments.decide(listOf(seg), 1_100_000, duration, true, false, emptySet()).action)
        val earlier = seg.copy(endMs = seg.endMs - 1)
        assertEquals(Action.OFFER, SkipSegments.decide(listOf(earlier), 1_100_000, duration, true, false, emptySet()).action)
    }

    @Test
    fun anIntroIsNotSkippedStraightToTheEndOfAnEpisode() {
        // Bad data: an "intro" covering the whole episode must not end it by itself.
        val whole = SkipSegment(SkipSegments.INTRO, 0, duration)
        assertEquals(Action.NEXT_EPISODE, SkipSegments.decide(listOf(whole), 10_000, duration, true, true, emptySet()).action)
    }

    @Test
    fun aSkipNeverLandsPastTheEnd() {
        assertEquals(150_000L, SkipSegments.target(intro, duration))
        assertEquals(duration, SkipSegments.target(SkipSegment(SkipSegments.OUTRO, 1_300_000, 1_500_000), duration))
        assertEquals(1_500_000L, SkipSegments.target(SkipSegment(SkipSegments.OUTRO, 1_300_000, 1_500_000), 0))
    }
}
