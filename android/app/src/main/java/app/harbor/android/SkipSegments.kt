package app.harbor.android

import org.json.JSONArray

/** A stretch of the video the viewer may want to jump over. The page works these out and sends
 *  them with the "segments" command. */
data class SkipSegment(val kind: String, val startMs: Long, val endMs: Long)

/** What the skip button does at a position. Kept free of Android so it is unit-tested on the JVM. */
object SkipSegments {
    const val INTRO = "intro"
    const val RECAP = "recap"
    const val OUTRO = "outro"

    /** A segment stops being offered this long before its end, as on the page: nothing worth
     *  skipping is left, and it keeps the button from showing again right after a skip. */
    const val TAIL_MS = 750L

    /** Credits that end this close to the end of the video count as running to the end. */
    const val END_SLACK_MS = 2000L

    private const val MAX_SEGMENTS = 40

    enum class Action {
        NONE,
        /** Show the button for the segment. */
        OFFER,
        /** An intro, with "skip intros automatically" on, that has not been skipped yet. */
        AUTO_SKIP,
        /** Credits that run to the end of an episode with a next one: skipping them would only end
         *  the video, so the next-episode button is shown instead. */
        NEXT_EPISODE,
    }

    data class Decision(val action: Action, val segment: SkipSegment? = null)

    /** Reads the page's list, dropping anything that is not a usable segment. */
    fun parse(arr: JSONArray?): List<SkipSegment> {
        if (arr == null) return emptyList()
        val out = ArrayList<SkipSegment>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val kind = o.optString("kind")
            if (kind != INTRO && kind != RECAP && kind != OUTRO) continue
            val start = o.optLong("startMs", -1)
            val end = o.optLong("endMs", -1)
            if (start < 0 || end <= start) continue
            out.add(SkipSegment(kind, start, end))
            if (out.size >= MAX_SEGMENTS) break
        }
        return out.sortedBy { it.startMs }
    }

    fun activeAt(segments: List<SkipSegment>, positionMs: Long): SkipSegment? =
        segments.firstOrNull { positionMs >= it.startMs && positionMs < it.endMs - TAIL_MS }

    /**
     * [durationMs] is 0 while the length is not known. [autoSkipped] holds the intros already
     * skipped automatically: seeking back into one offers the button instead of skipping again.
     */
    fun decide(
        segments: List<SkipSegment>,
        positionMs: Long,
        durationMs: Long,
        hasNext: Boolean,
        autoSkipIntro: Boolean,
        autoSkipped: Set<SkipSegment>,
    ): Decision {
        val seg = activeAt(segments, positionMs) ?: return Decision(Action.NONE)
        if (hasNext && durationMs > 0 && seg.endMs >= durationMs - END_SLACK_MS) return Decision(Action.NEXT_EPISODE, seg)
        if (seg.kind == INTRO && autoSkipIntro && seg !in autoSkipped) return Decision(Action.AUTO_SKIP, seg)
        return Decision(Action.OFFER, seg)
    }

    /** Where a skip lands: the segment's end, never past the end of the video. */
    fun target(seg: SkipSegment, durationMs: Long): Long = if (durationMs > 0) minOf(seg.endMs, durationMs) else seg.endMs
}
