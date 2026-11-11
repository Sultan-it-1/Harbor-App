package app.harbor.android

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

/**
 * Guided manual sync of an addon subtitle ("live sync"): the maths of the desktop version.
 * The viewer hears a line, finds it in the subtitle's list of lines and taps "Align to now": that
 * is an anchor. One anchor shifts the whole subtitle; a second one far enough from the first also
 * corrects drift (a subtitle made for a copy of the film that runs a little faster or slower).
 *
 * Every time here is in seconds. Kept free of Android so it is unit-tested on the JVM.
 */
object TextSync {
    /** Two anchors closer than this (in the subtitle's own times) can't tell drift from a slip of
     *  the finger, so only the latest one counts. */
    const val MIN_GAP_SEC = 3.0

    /** A drift steeper than this is not a different frame rate, it is a wrong tap: again only the
     *  latest anchor counts. */
    const val MAX_SLOPE = 0.05

    /** The nudge the viewer can add on top, either way. */
    const val MAX_NUDGE_SEC = 600.0

    private const val MAX_SEGMENTS = 20

    /** An anchor: the line whose ORIGINAL start is [t] was heard at playback position [at]. */
    data class Point(val t: Double, val at: Double)

    /** "Fix one section": the lines [startIdx]..[endIdx] (both included) get [offsetSec] more. */
    data class Segment(val startIdx: Int, val endIdx: Int, val offsetSec: Double)

    data class State(
        val points: List<Point> = emptyList(),
        val nudge: Double = 0.0,
        val segments: List<Segment> = emptyList(),
    ) {
        /** Changes nothing: not worth keeping on the device. */
        val isIdentity: Boolean get() = points.isEmpty() && nudge == 0.0 && segments.isEmpty()
    }

    /** What the anchors amount to, for the panel to say. */
    enum class Fit {
        /** No anchor: only the nudge moves the subtitle. */
        NONE,
        /** One anchor: the whole subtitle is shifted. */
        SHIFT,
        /** Two good anchors: shifted and stretched. */
        DRIFT,
        /** Two anchors closer than [MIN_GAP_SEC]: only the latest one is used. */
        TOO_CLOSE,
        /** Two anchors that disagree by more than [MAX_SLOPE]: only the latest one is used. */
        TOO_STEEP,
    }

    /** How much to add to an original time. */
    fun delta(s: State): (Double) -> Double {
        val nudge = s.nudge
        val points = s.points
        if (points.isEmpty()) return { nudge }
        if (points.size == 1) {
            val d = points[0].at - points[0].t
            return { d + nudge }
        }
        val sorted = points.sortedBy { it.t }
        val a = sorted.first()
        val b = sorted.last()
        val d1 = a.at - a.t
        val span = b.t - a.t
        val m = (b.at - b.t - d1) / span
        if (span < MIN_GAP_SEC || !m.isFinite() || abs(m) > MAX_SLOPE) {
            val latest = points.last()
            val d = latest.at - latest.t
            return { d + nudge }
        }
        return { t -> d1 + m * (t - a.t) + nudge }
    }

    fun fit(s: State): Fit {
        val points = s.points
        if (points.isEmpty()) return Fit.NONE
        if (points.size == 1) return Fit.SHIFT
        val sorted = points.sortedBy { it.t }
        val a = sorted.first()
        val b = sorted.last()
        val span = b.t - a.t
        val m = (b.at - b.t - (a.at - a.t)) / span
        return when {
            span < MIN_GAP_SEC -> Fit.TOO_CLOSE
            !m.isFinite() || abs(m) > MAX_SLOPE -> Fit.TOO_STEEP
            else -> Fit.DRIFT
        }
    }

    /** A new anchor: the first one is kept and the second replaced, and the nudge starts over. */
    fun withPoint(s: State, p: Point): State =
        s.copy(points = if (s.points.size < 2) s.points + p else listOf(s.points[0], p), nudge = 0.0)

    fun nudged(s: State, bySec: Double): State = withNudge(s, s.nudge + bySec)

    fun withNudge(s: State, nudgeSec: Double): State =
        s.copy(nudge = round3(nudgeSec.coerceIn(-MAX_NUDGE_SEC, MAX_NUDGE_SEC)))

    /**
     * "Fix one section": the lines [startIdx]..[endIdx] get the extra offset that puts the line
     * starting at [cueStart] (its original time) on playback position [at]. A section with the same
     * range is replaced.
     */
    fun withSegment(s: State, startIdx: Int, endIdx: Int, cueStart: Double, at: Double): State {
        val from = minOf(startIdx, endIdx)
        val to = maxOf(startIdx, endIdx)
        val offset = round3(at - cueStart - delta(s)(cueStart))
        val others = s.segments.filterNot { it.startIdx == from && it.endIdx == to }
        return s.copy(segments = (others + Segment(from, to, offset)).takeLast(MAX_SEGMENTS))
    }

    class Timed(val starts: DoubleArray, val ends: DoubleArray)

    /** The cue times ([starts] and [ends], as the file has them) with the sync applied. */
    fun apply(starts: DoubleArray, ends: DoubleArray, s: State): Timed {
        val f = delta(s)
        val n = minOf(starts.size, ends.size)
        val outStarts = DoubleArray(n)
        val outEnds = DoubleArray(n)
        for (i in 0 until n) {
            var extra = 0.0
            for (seg in s.segments) if (i >= seg.startIdx && i <= seg.endIdx) extra += seg.offsetSec
            val start = round3(maxOf(0.0, starts[i] + f(starts[i]) + extra))
            outStarts[i] = start
            outEnds[i] = maxOf(start + 0.001, round3(ends[i] + f(ends[i]) + extra))
        }
        return Timed(outStarts, outEnds)
    }

    /** To the millisecond, halves upwards (as JavaScript's Math.round, which the desktop uses). */
    fun round3(v: Double): Double = Math.round(v * 1000.0) / 1000.0

    // ---- kept on the device (SyncStore) ----

    /** {"p":[[t,at],…],"n":nudge,"s":[[from,to,offset],…]}, empty parts left out. */
    fun toJson(s: State): JSONObject {
        val o = JSONObject()
        if (s.points.isNotEmpty()) o.put("p", JSONArray().also { a -> s.points.forEach { a.put(JSONArray().put(it.t).put(it.at)) } })
        if (s.nudge != 0.0) o.put("n", s.nudge)
        if (s.segments.isNotEmpty()) {
            o.put("s", JSONArray().also { a -> s.segments.forEach { a.put(JSONArray().put(it.startIdx).put(it.endIdx).put(it.offsetSec)) } })
        }
        return o
    }

    /** Reads what [toJson] wrote, dropping whatever is not usable. */
    fun fromJson(o: JSONObject?): State {
        if (o == null) return State()
        val points = ArrayList<Point>()
        o.optJSONArray("p")?.let { a ->
            for (i in 0 until a.length()) {
                val p = a.optJSONArray(i) ?: continue
                val t = p.optDouble(0)
                val at = p.optDouble(1)
                if (t.isFinite() && at.isFinite() && points.size < 2) points.add(Point(t, at))
            }
        }
        val segments = ArrayList<Segment>()
        o.optJSONArray("s")?.let { a ->
            for (i in 0 until a.length()) {
                val g = a.optJSONArray(i) ?: continue
                val from = g.optInt(0, -1)
                val to = g.optInt(1, -1)
                val offset = g.optDouble(2)
                if (from >= 0 && to >= from && offset.isFinite() && segments.size < MAX_SEGMENTS) segments.add(Segment(from, to, offset))
            }
        }
        val nudge = o.optDouble("n", 0.0).takeIf { it.isFinite() } ?: 0.0
        return State(points, round3(nudge.coerceIn(-MAX_NUDGE_SEC, MAX_NUDGE_SEC)), segments)
    }
}

/**
 * Finding a line in the sync panel by typing part of it. Arabic is matched the way people type
 * it: without the marks subtitle files often carry (harakat, tatweel) and with the letters that
 * are commonly swapped (أ إ آ ٱ for ا, ى for ي, ة for ه) taken as the same. Only for matching: the
 * line is always shown as it is written.
 */
object CueSearch {
    fun fold(text: CharSequence): String {
        val sb = StringBuilder(text.length)
        var space = true // leading spaces are dropped, runs of them become one
        for (ch in text) {
            val c = when (ch) {
                'أ', 'إ', 'آ', 'ٱ' -> 'ا'
                'ى' -> 'ي'
                'ة' -> 'ه'
                else -> ch
            }
            when {
                // Harakat and the small alef, tatweel.
                c in 'ً'..'ٟ' || c == 'ٰ' || c == 'ـ' -> {}
                // Direction marks (the player adds one itself to some lines, see SubtitleBidi).
                c == '‎' || c == '‏' || c == '؜' || c in '‪'..'‮' || c in '⁦'..'⁩' || c == '﻿' -> {}
                c.isWhitespace() -> if (!space) { sb.append(' '); space = true }
                else -> { sb.append(c.lowercaseChar()); space = false }
            }
        }
        return sb.toString().trimEnd()
    }

    fun matches(foldedLine: String, foldedQuery: String): Boolean = foldedQuery.isEmpty() || foldedLine.contains(foldedQuery)
}
