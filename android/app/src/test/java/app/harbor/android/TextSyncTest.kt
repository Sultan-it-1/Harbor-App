package app.harbor.android

import app.harbor.android.TextSync.Fit
import app.harbor.android.TextSync.Point
import app.harbor.android.TextSync.Segment
import app.harbor.android.TextSync.State
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The maths of the guided subtitle sync: anchors set by ear, a nudge, and a section offset. */
class TextSyncTest {
    private val eps = 1e-9

    private fun delta(s: State, t: Double) = TextSync.delta(s)(t)

    // Four cues: 1-2.5, 10-12, 100-103, 1000-1004.
    private val starts = doubleArrayOf(1.0, 10.0, 100.0, 1000.0)
    private val ends = doubleArrayOf(2.5, 12.0, 103.0, 1004.0)

    private fun apply(s: State) = TextSync.apply(starts, ends, s)

    @Test
    fun withoutAnchorsOnlyTheNudgeMovesTheSubtitle() {
        assertEquals(0.0, delta(State(), 50.0), eps)
        assertEquals(1.5, delta(State(nudge = 1.5), 50.0), eps)
        assertEquals(1.5, delta(State(nudge = 1.5), 5000.0), eps)
        assertEquals(Fit.NONE, TextSync.fit(State()))
    }

    @Test
    fun oneAnchorShiftsEveryLineBySameAmount() {
        // The line the file puts at 10 s was heard at 12.4 s.
        val s = State(points = listOf(Point(10.0, 12.4)))
        assertEquals(2.4, delta(s, 0.0), eps)
        assertEquals(2.4, delta(s, 10.0), eps)
        assertEquals(2.4, delta(s, 3000.0), eps)
        assertEquals(Fit.SHIFT, TextSync.fit(s))
        val out = apply(s)
        assertArrayEquals(doubleArrayOf(3.4, 12.4, 102.4, 1002.4), out.starts, eps)
        assertArrayEquals(doubleArrayOf(4.9, 14.4, 105.4, 1006.4), out.ends, eps)
    }

    @Test
    fun twoAnchorsFarApartAlsoCorrectDrift() {
        // 2 s late at 10 s, 12 s late at 1010 s: one more second every 100 s.
        val s = State(points = listOf(Point(10.0, 12.0), Point(1010.0, 1022.0)))
        assertEquals(Fit.DRIFT, TextSync.fit(s))
        assertEquals(2.0, delta(s, 10.0), eps)
        assertEquals(7.0, delta(s, 510.0), eps)
        assertEquals(12.0, delta(s, 1010.0), eps)
        // Outside the two anchors the line carries on.
        assertEquals(1.9, delta(s, 0.0), eps)
        assertEquals(22.0, delta(s, 2010.0), eps)
        // Each anchored line lands exactly where it was heard.
        val out = TextSync.apply(doubleArrayOf(10.0, 1010.0), doubleArrayOf(11.0, 1012.0), s)
        assertArrayEquals(doubleArrayOf(12.0, 1022.0), out.starts, eps)
        assertArrayEquals(doubleArrayOf(13.01, 1024.02), out.ends, eps)
    }

    @Test
    fun theOrderTheAnchorsWereSetInDoesNotChangeTheDrift() {
        val early = Point(10.0, 12.0)
        val late = Point(1010.0, 1022.0)
        val a = State(points = listOf(early, late))
        val b = State(points = listOf(late, early))
        for (t in listOf(0.0, 10.0, 333.0, 1010.0, 4000.0)) assertEquals(delta(a, t), delta(b, t), eps)
    }

    @Test
    fun anchorsCloserThanThreeSecondsUseTheLatestOneAlone() {
        // 2 s apart in the file: too close to tell drift from a slow finger.
        val s = State(points = listOf(Point(10.0, 12.0), Point(12.0, 15.0)))
        assertEquals(Fit.TOO_CLOSE, TextSync.fit(s))
        assertEquals(3.0, delta(s, 0.0), eps)
        assertEquals(3.0, delta(s, 900.0), eps)
        // The latest is the one set last, not the later one in the film.
        val reversed = State(points = listOf(Point(12.0, 15.0), Point(10.0, 12.0)))
        assertEquals(2.0, delta(reversed, 900.0), eps)
        // The same line twice: no slope at all.
        val same = State(points = listOf(Point(10.0, 12.0), Point(10.0, 12.5)))
        assertEquals(Fit.TOO_CLOSE, TextSync.fit(same))
        assertEquals(2.5, delta(same, 900.0), eps)
    }

    @Test
    fun exactlyThreeSecondsApartIsEnough() {
        val s = State(points = listOf(Point(10.0, 12.0), Point(13.0, 15.09)))
        assertEquals(Fit.DRIFT, TextSync.fit(s))
        assertEquals(2.0 + 0.03 * 90, delta(s, 100.0), 1e-6)
    }

    @Test
    fun aSlopeOverTheCapUsesTheLatestAnchorAlone() {
        // 8 s more over 100 s is 8%: no frame rate does that, one of the taps was wrong.
        val s = State(points = listOf(Point(10.0, 12.0), Point(110.0, 120.0)))
        assertEquals(Fit.TOO_STEEP, TextSync.fit(s))
        assertEquals(10.0, delta(s, 0.0), eps)
        assertEquals(10.0, delta(s, 5000.0), eps)
        val reversed = State(points = listOf(Point(110.0, 120.0), Point(10.0, 12.0)))
        assertEquals(2.0, delta(reversed, 5000.0), eps)
        // The other way (the subtitle runs fast) is capped just the same.
        val negative = State(points = listOf(Point(10.0, 12.0), Point(110.0, 104.0)))
        assertEquals(Fit.TOO_STEEP, TextSync.fit(negative))
        assertEquals(-6.0, delta(negative, 5000.0), eps)
        // 4% is a real difference between two cuts of a film (25 against 24 frames a second).
        val real = State(points = listOf(Point(0.0, 0.0), Point(1000.0, 1040.0)))
        assertEquals(Fit.DRIFT, TextSync.fit(real))
        assertEquals(20.0, delta(real, 500.0), eps)
    }

    @Test
    fun theNudgeComesOnTopOfTheAnchors() {
        assertEquals(2.2, delta(State(listOf(Point(10.0, 12.0)), nudge = 0.2), 77.0), eps)
        val drift = State(listOf(Point(10.0, 12.0), Point(1010.0, 1022.0)), nudge = -0.3)
        assertEquals(6.7, delta(drift, 510.0), eps)
        val close = State(listOf(Point(10.0, 12.0), Point(12.0, 15.0)), nudge = 0.5)
        assertEquals(3.5, delta(close, 510.0), eps)
    }

    @Test
    fun nudgingMovesATenthAtATimeWithoutRoundingAway() {
        var s = State()
        repeat(3) { s = TextSync.nudged(s, 0.1) }
        assertEquals(0.3, s.nudge, 0.0)
        repeat(5) { s = TextSync.nudged(s, -0.1) }
        assertEquals(-0.2, s.nudge, 0.0)
        assertEquals(TextSync.MAX_NUDGE_SEC, TextSync.withNudge(s, 5000.0).nudge, 0.0)
        assertEquals(-TextSync.MAX_NUDGE_SEC, TextSync.withNudge(s, -5000.0).nudge, 0.0)
    }

    @Test
    fun aNewAnchorKeepsTheFirstReplacesTheSecondAndStartsTheNudgeOver() {
        val p1 = Point(10.0, 12.0)
        val p2 = Point(500.0, 503.0)
        val p3 = Point(900.0, 905.0)
        // Before any anchor the nudge is the delay the viewer already had.
        var s = State(nudge = 1.5)
        s = TextSync.withPoint(s, p1)
        assertEquals(listOf(p1), s.points)
        assertEquals(0.0, s.nudge, 0.0)
        s = TextSync.withPoint(TextSync.nudged(s, 0.2), p2)
        assertEquals(listOf(p1, p2), s.points)
        assertEquals(0.0, s.nudge, 0.0)
        s = TextSync.withPoint(s, p3)
        assertEquals(listOf(p1, p3), s.points)
    }

    @Test
    fun timesAreClampedAtZeroAndACueNeverEndsBeforeItStarts() {
        // Everything 3 s earlier: the first cue (1-2.5) would start and end before the film does.
        val out = apply(State(nudge = -3.0))
        assertArrayEquals(doubleArrayOf(0.0, 7.0, 97.0, 997.0), out.starts, eps)
        assertArrayEquals(doubleArrayOf(0.001, 9.0, 100.0, 1001.0), out.ends, eps)
        // A cue that straddles zero keeps the part that is left.
        val straddling = TextSync.apply(doubleArrayOf(2.0), doubleArrayOf(4.0), State(nudge = -3.0))
        assertEquals(0.0, straddling.starts[0], eps)
        assertEquals(1.0, straddling.ends[0], eps)
    }

    @Test
    fun timesAreRoundedToTheMillisecond() {
        val up = TextSync.apply(doubleArrayOf(1.0), doubleArrayOf(2.0), State(listOf(Point(0.0, 0.0006))))
        assertEquals(1.001, up.starts[0], 0.0)
        assertEquals(2.001, up.ends[0], 0.0)
        val down = TextSync.apply(doubleArrayOf(1.0), doubleArrayOf(2.0), State(listOf(Point(0.0, 0.0004))))
        assertEquals(1.0, down.starts[0], 0.0)
        assertEquals(2.0, down.ends[0], 0.0)
        assertEquals(-0.001, TextSync.round3(-0.0006), 0.0)
        // A half goes upwards, as on the desktop (JavaScript's Math.round).
        assertEquals(0.063, TextSync.round3(0.0625), 0.0)
        assertEquals(-0.062, TextSync.round3(-0.0625), 0.0)
    }

    @Test
    fun aSectionOffsetMovesOnlyItsOwnLines() {
        // The two middle cues 5 s later, on top of a shift of 2 s for everything.
        val s = State(points = listOf(Point(10.0, 12.0)), segments = listOf(Segment(1, 2, 5.0)))
        val out = apply(s)
        assertArrayEquals(doubleArrayOf(3.0, 17.0, 107.0, 1002.0), out.starts, eps)
        assertArrayEquals(doubleArrayOf(4.5, 19.0, 110.0, 1006.0), out.ends, eps)
        // A line in two sections gets both offsets.
        val two = State(segments = listOf(Segment(0, 2, 1.0), Segment(2, 3, -0.5)))
        assertArrayEquals(doubleArrayOf(2.0, 11.0, 100.5, 999.5), apply(two).starts, eps)
    }

    @Test
    fun fixingOneSectionPutsTheChosenLineOnThePlaybackPosition() {
        // Everything is 2 s late; inside cues 1..2 the line at 100 s was heard at 110 s.
        val base = State(points = listOf(Point(10.0, 12.0)))
        val s = TextSync.withSegment(base, 1, 2, cueStart = 100.0, at = 110.0)
        assertEquals(listOf(Segment(1, 2, 8.0)), s.segments)
        assertEquals(110.0, apply(s).starts[2], eps)
        assertEquals(3.0, apply(s).starts[0], eps)
        assertEquals(1002.0, apply(s).starts[3], eps)
        // The same range again replaces it; the range can be marked from either end.
        val again = TextSync.withSegment(s, 2, 1, cueStart = 100.0, at = 104.25)
        assertEquals(listOf(Segment(1, 2, 2.25)), again.segments)
        // Another range is kept next to it.
        val more = TextSync.withSegment(again, 3, 3, cueStart = 1000.0, at = 1001.0)
        assertEquals(listOf(Segment(1, 2, 2.25), Segment(3, 3, -1.0)), more.segments)
    }

    @Test
    fun aStateThatChangesNothingIsRecognised() {
        assertTrue(State().isIdentity)
        assertFalse(State(nudge = 0.1).isIdentity)
        assertFalse(State(points = listOf(Point(1.0, 1.0))).isIdentity)
        assertFalse(State(segments = listOf(Segment(0, 1, 0.0))).isIdentity)
        val out = apply(State())
        assertArrayEquals(starts, out.starts, 0.0)
        assertArrayEquals(ends, out.ends, 0.0)
    }

    @Test
    fun theStateSurvivesBeingWrittenAndReadBack() {
        val s = State(listOf(Point(10.5, 12.25), Point(1010.0, 1022.125)), nudge = -0.3, segments = listOf(Segment(4, 9, 1.75)))
        assertEquals(s, TextSync.fromJson(JSONObject(TextSync.toJson(s).toString())))
        assertEquals(State(), TextSync.fromJson(JSONObject(TextSync.toJson(State()).toString())))
        assertEquals("{}", TextSync.toJson(State()).toString())
    }

    @Test
    fun whatCannotBeUsedIsDroppedWhenReading() {
        assertEquals(State(), TextSync.fromJson(null))
        assertEquals(State(), TextSync.fromJson(JSONObject("""{"p":"nonsense","n":"x","s":7}""")))
        val read = TextSync.fromJson(
            JSONObject("""{"p":[[1,2],["a",3],[4],[5,6],[7,8]],"n":99999,"s":[[3,1,1.0],[-1,2,1.0],[2,5,0.5],[1,2]]}"""),
        )
        // Two anchors at most; a section must run forwards from a real line.
        assertEquals(listOf(Point(1.0, 2.0), Point(5.0, 6.0)), read.points)
        assertEquals(TextSync.MAX_NUDGE_SEC, read.nudge, 0.0)
        assertEquals(listOf(Segment(2, 5, 0.5)), read.segments)
    }
}

/** Finding a line by typing it: Arabic as people type it, not as subtitle files spell it. */
class CueSearchTest {
    private fun found(line: String, typed: String) = CueSearch.matches(CueSearch.fold(line), CueSearch.fold(typed))

    @Test
    fun harakatAndTatweelAreIgnored() {
        assertEquals("مرحبا", CueSearch.fold("مَرْحَبًا"))
        assertEquals("جميل", CueSearch.fold("جـمـيـل"))
        assertEquals("هذا", CueSearch.fold("هٰذا"))
        assertTrue(found("قالَ الرَّجُلُ: مَرْحَبًا", "الرجل"))
    }

    @Test
    fun lettersThatAreCommonlySwappedCountAsTheSame() {
        assertEquals(CueSearch.fold("احمد"), CueSearch.fold("أحمد"))
        assertEquals(CueSearch.fold("الى"), CueSearch.fold("إلى"))
        assertEquals(CueSearch.fold("الان"), CueSearch.fold("الآن"))
        assertEquals(CueSearch.fold("اسم"), CueSearch.fold("ٱسم"))
        assertTrue(found("ذهبتُ إلى المدرسة", "الي المدرسه"))
        assertTrue(found("مستشفى", "مستشفي"))
        assertFalse(found("ذهبتُ إلى المدرسة", "البيت"))
    }

    @Test
    fun latinIsMatchedWhateverTheCase() {
        assertTrue(found("I'll be BACK.", "be back"))
        assertFalse(found("I'll be back.", "front"))
    }

    @Test
    fun lineBreaksAndDirectionMarksDoNotGetInTheWay() {
        // The mark the player adds to an Arabic line that starts with a Latin word.
        assertEquals("iphone الجديد", CueSearch.fold("‏iPhone الجديد"))
        assertTrue(found("- كيف حالك؟\n- بخير", "حالك؟ - بخير"))
        assertEquals("a b", CueSearch.fold("  a \n\n b  "))
    }

    @Test
    fun anEmptySearchMatchesEveryLine() {
        assertTrue(found("anything", ""))
        assertTrue(found("anything", "   "))
    }
}
