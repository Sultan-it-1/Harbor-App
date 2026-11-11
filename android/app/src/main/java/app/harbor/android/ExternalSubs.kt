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
        var lo = 0
        var hi = starts.size - 1
        var last = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (starts[mid] <= t) { last = mid; lo = mid + 1 } else hi = mid - 1
        }
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
}

/**
 * Renders a side-loaded (addon) subtitle in its own SubtitleView on top of the video.
 * Switching tracks or changing the delay is instant: nothing is re-prepared or re-buffered.
 */
@OptIn(UnstableApi::class)
class ExternalSubs(private val view: SubtitleView, private val positionMs: () -> Long?) {
    private var cues: List<List<Cue>> = emptyList()
    private var starts = LongArray(0)
    private var ends = LongArray(0)
    private var maxDur = 0L
    private var shown = IntArray(0)
    private val handler = Handler(Looper.getMainLooper())
    var delayMs = 0L
        set(v) { field = v; tick() }
    val active: Boolean get() = starts.isNotEmpty()

    private val ticker = object : Runnable {
        override fun run() {
            tick()
            handler.postDelayed(this, 40)
        }
    }

    fun set(entries: List<CuesWithTiming>?) {
        handler.removeCallbacks(ticker)
        shown = IntArray(0)
        view.setCues(emptyList())
        if (entries.isNullOrEmpty()) {
            cues = emptyList(); starts = LongArray(0); ends = LongArray(0); maxDur = 0
            return
        }
        val sorted = entries.sortedBy { it.startTimeUs }
        cues = sorted.map { it.cues }
        starts = LongArray(sorted.size) { sorted[it].startTimeUs }
        ends = LongArray(sorted.size) {
            val e = sorted[it]
            if (e.durationUs == C.TIME_UNSET || e.endTimeUs == C.TIME_UNSET) e.startTimeUs + 5_000_000 else e.endTimeUs
        }
        maxDur = (0 until starts.size).maxOfOrNull { ends[it] - starts[it] } ?: 0
        handler.post(ticker)
    }

    fun clear() = set(null)

    /** Paused video: no need to look up cues 25 times a second (call [refresh] after a seek). */
    fun setRunning(on: Boolean) {
        handler.removeCallbacks(ticker)
        if (on && starts.isNotEmpty()) handler.post(ticker) else tick()
    }

    fun refresh() = tick()

    private fun tick() {
        if (starts.isEmpty()) return
        val pos = positionMs() ?: return
        val t = (pos - delayMs) * 1000
        val now = CueTiming.activeAt(starts, ends, t, maxDur)
        if (now.contentEquals(shown)) return
        shown = now
        view.setCues(now.flatMap { cues[it] })
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
