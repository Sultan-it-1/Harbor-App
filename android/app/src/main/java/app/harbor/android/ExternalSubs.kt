package app.harbor.android

import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.text.CuesWithTiming
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.extractor.text.ssa.SsaParser
import androidx.media3.extractor.text.subrip.SubripParser
import androidx.media3.extractor.text.webvtt.WebvttParser
import androidx.media3.ui.SubtitleView

/** Pure cue lookup, kept separate so it can be unit-tested on the JVM. */
object CueTiming {
    /**
     * Indices of the cues active at [t] (µs). [starts] must be sorted ascending; [maxDur] is the
     * longest cue duration, which bounds how far back an active cue can start.
     */
    fun activeAt(starts: LongArray, ends: LongArray, t: Long, maxDur: Long): IntArray {
        val last = lastStarted(starts, t)
        if (last < 0) return IntArray(0)
        val out = ArrayList<Int>(2)
        var i = last
        while (i >= 0 && starts[i] >= t - maxDur) {
            if (ends[i] > t) out.add(i)
            i--
        }
        out.reverse()
        return out.toIntArray()
    }

    /** The place of the last cue that has started at [t] (µs) in [starts] (ascending), or -1. */
    fun lastStarted(starts: LongArray, t: Long): Int {
        var lo = 0
        var hi = starts.size - 1
        var last = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (starts[mid] <= t) { last = mid; lo = mid + 1 } else hi = mid - 1
        }
        return last
    }

    /**
     * The times a subtitle is drawn from. [cueStarts] / [cueEnds] are each cue's times with the
     * sync applied, by the cue's place in the file. [starts] / [ends] are the same in ascending
     * order, which is what [activeAt] needs: a "fix one section" offset can move lines past their
     * neighbours, and [order] then says which cue each place holds (null while the cues are still
     * in the file's order).
     */
    class Drawn(
        val cueStarts: LongArray,
        val cueEnds: LongArray,
        val starts: LongArray,
        val ends: LongArray,
        val order: IntArray?,
        val maxDur: Long,
    )

    /** Works the drawn times (µs) out from the file's times and a sync state. Without one (or
     *  with one that changes nothing) they are the file's own. */
    fun retime(fileStarts: LongArray, fileEnds: LongArray, sync: TextSync.State?): Drawn {
        val n = minOf(fileStarts.size, fileEnds.size)
        var cueStarts = fileStarts
        var cueEnds = fileEnds
        if (sync != null && !sync.isIdentity && n > 0) {
            val timed = TextSync.apply(DoubleArray(n) { fileStarts[it] / 1e6 }, DoubleArray(n) { fileEnds[it] / 1e6 }, sync)
            cueStarts = LongArray(n) { Math.round(timed.starts[it] * 1e6) }
            cueEnds = LongArray(n) { Math.round(timed.ends[it] * 1e6) }
        }
        var inOrder = true
        for (i in 1 until n) if (cueStarts[i] < cueStarts[i - 1]) { inOrder = false; break }
        var starts = cueStarts
        var ends = cueEnds
        var order: IntArray? = null
        if (!inOrder) {
            val o = (0 until n).sortedBy { cueStarts[it] }.toIntArray()
            order = o
            starts = LongArray(n) { cueStarts[o[it]] }
            ends = LongArray(n) { cueEnds[o[it]] }
        }
        val maxDur = (0 until n).maxOfOrNull { ends[it] - starts[it] } ?: 0
        return Drawn(cueStarts, cueEnds, starts, ends, order, maxDur)
    }
}

/**
 * Renders a side-loaded (addon) subtitle in its own SubtitleView on top of the video.
 * Switching tracks or changing the delay is instant: nothing is re-prepared or re-buffered.
 *
 * Two things can move a subtitle in time, never both at once: the plain [delayMs], and a sync
 * state (TextSync: anchors the viewer set by ear, plus a nudge). A subtitle that has a sync state
 * is timed by it alone, its nudge being its delay; the plain delay is for the ones that have none.
 */
@OptIn(UnstableApi::class)
class ExternalSubs(private val view: SubtitleView, private val positionMs: () -> Long?) {
    private var cues: List<List<Cue>> = emptyList()
    /** The cue times as the subtitle's file has them (µs, sorted by start). Never changed: a sync
     *  is always worked out from these. */
    private var fileStarts = LongArray(0)
    private var fileEnds = LongArray(0)
    /** What is drawn from: the file's times with the sync applied. */
    private var drawn = CueTiming.retime(fileStarts, fileEnds, null)
    /** The cues on screen, by their place in the file. */
    private var shown = IntArray(0)
    private val handler = Handler(Looper.getMainLooper())
    var delayMs = 0L
        set(v) { field = v; tick() }
    var sync: TextSync.State? = null
        private set
    val active: Boolean get() = fileStarts.isNotEmpty()

    private val ticker = object : Runnable {
        override fun run() {
            tick()
            handler.postDelayed(this, 40)
        }
    }

    /** Shows a subtitle, with the sync the viewer gave it before (if any). */
    fun set(entries: List<CuesWithTiming>?, sync: TextSync.State? = null) {
        handler.removeCallbacks(ticker)
        shown = IntArray(0)
        view.setCues(emptyList())
        if (entries.isNullOrEmpty()) {
            cues = emptyList(); fileStarts = LongArray(0); fileEnds = LongArray(0)
            this.sync = null
            drawn = CueTiming.retime(fileStarts, fileEnds, null)
            return
        }
        val sorted = entries.sortedBy { it.startTimeUs }
        cues = sorted.map { it.cues }
        fileStarts = LongArray(sorted.size) { sorted[it].startTimeUs }
        fileEnds = LongArray(sorted.size) {
            val e = sorted[it]
            if (e.durationUs == C.TIME_UNSET || e.endTimeUs == C.TIME_UNSET) e.startTimeUs + 5_000_000 else e.endTimeUs
        }
        this.sync = sync
        drawn = CueTiming.retime(fileStarts, fileEnds, sync)
        handler.post(ticker)
    }

    fun clear() = set(null)

    /** A new sync state for the subtitle that is showing (null: back to the plain delay). Cheap:
     *  only the times it draws from are worked out again, nothing is parsed or re-buffered. */
    fun setSync(state: TextSync.State?) {
        sync = state
        drawn = CueTiming.retime(fileStarts, fileEnds, state)
        tick()
    }

    /** Paused video: no need to look up cues 25 times a second (call [refresh] after a seek). */
    fun setRunning(on: Boolean) {
        handler.removeCallbacks(ticker)
        if (on && active) handler.post(ticker) else tick()
    }

    fun refresh() = tick()

    /** The plain delay, unless a sync state has taken the timing over. */
    private fun plainDelayMs() = if (sync == null) delayMs else 0L

    private fun tick() {
        if (!active) return
        val pos = positionMs() ?: return
        val d = drawn
        val at = CueTiming.activeAt(d.starts, d.ends, (pos - plainDelayMs()) * 1000, d.maxDur)
        val now = if (d.order == null) at else IntArray(at.size) { d.order[at[it]] }
        if (now.contentEquals(shown)) return
        shown = now
        view.setCues(now.flatMap { cues[it] })
    }

    // ---- the sync panel's list of lines (a cue is named by its place in the file) ----

    val count: Int get() = cues.size

    /** A cue's words as plain text, broken into lines as the subtitle is (and with the same
     *  direction fix: it was applied when the file was parsed). */
    fun text(i: Int): String =
        cues.getOrNull(i)?.mapNotNull { c -> c.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } }?.joinToString("\n") ?: ""

    /** A cue's start as the file has it, in seconds: what an anchor is made from. */
    fun fileStartSec(i: Int): Double? = fileStarts.getOrNull(i)?.let { it / 1e6 }

    /** When a cue shows now (ms): its time with the sync, or with the plain delay. */
    fun startMs(i: Int): Long = ((drawn.cueStarts.getOrNull(i) ?: 0L) / 1000 + plainDelayMs()).coerceAtLeast(0)

    /** The cue being spoken at [posMs]: the last one that has started, -1 before the first. */
    fun cueAt(posMs: Long): Int {
        val d = drawn
        val last = CueTiming.lastStarted(d.starts, (posMs - plainDelayMs()) * 1000)
        if (last < 0) return -1
        return d.order?.get(last) ?: last
    }

    companion object {
        /** Parses a normalised (UTF-8) subtitle file with Media3's own parsers. */
        fun parse(sub: SubtitleStore.LocalSub): List<CuesWithTiming> {
            val bytes = sub.file.readBytes()
            val parser: SubtitleParser = when (sub.mime) {
                MimeTypes.TEXT_VTT -> WebvttParser()
                MimeTypes.TEXT_SSA -> SsaParser()
                else -> SubripParser()
            }
            val out = ArrayList<CuesWithTiming>()
            parser.parse(bytes, SubtitleParser.OutputOptions.allCues()) { c ->
                // Arabic lines that start with a Latin word: keep their punctuation on the right side.
                val fixed = c.cues.map { cue ->
                    val t = cue.text
                    if (t == null) cue else {
                        val f = SubtitleBidi.fix(t)
                        if (f === t) cue else cue.buildUpon().setText(f).build()
                    }
                }
                out.add(CuesWithTiming(fixed, c.startTimeUs, c.durationUs))
            }
            return out
        }
    }
}
