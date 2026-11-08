package app.harbor.android

import android.text.SpannableStringBuilder

/**
 * Arabic subtitle lines that start with a Latin word ("iPhone الجديد.") get a left-to-right
 * paragraph from Android's text layout (direction = first strong letter), so the final "." or "!"
 * is drawn on the wrong side. A right-to-left mark at the start of such a line fixes it.
 */
object SubtitleBidi {
    private const val RLM = '‏'

    private fun isArabic(c: Char) =
        c in '؀'..'ۿ' || c in 'ݐ'..'ݿ' || c in 'ࢠ'..'ࣿ' || c in 'ﭐ'..'﷿' || c in 'ﹰ'..'﻿'

    private fun strongDir(c: Char): Int = when (Character.getDirectionality(c)) {
        Character.DIRECTIONALITY_LEFT_TO_RIGHT -> 1
        Character.DIRECTIONALITY_RIGHT_TO_LEFT, Character.DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC -> -1
        else -> 0
    }

    /** Line-start offsets (into [s]) where an RLM must go. */
    fun insertionPoints(s: CharSequence): List<Int> {
        val out = ArrayList<Int>()
        var start = 0
        while (start <= s.length) {
            var end = start
            while (end < s.length && s[end] != '\n') end++
            var firstStrong = 0
            var hasArabic = false
            for (i in start until end) {
                val c = s[i]
                if (firstStrong == 0) firstStrong = strongDir(c)
                if (isArabic(c)) hasArabic = true
                if (firstStrong != 0 && hasArabic) break
            }
            if (hasArabic && firstStrong == 1 && (start >= s.length || s[start] != RLM)) out.add(start)
            start = end + 1
        }
        return out
    }

    /** [text] with an RLM before every Arabic line that starts with Latin (styling kept). */
    fun fix(text: CharSequence): CharSequence {
        val points = insertionPoints(text)
        if (points.isEmpty()) return text
        val b = SpannableStringBuilder(text)
        for (i in points.asReversed()) b.insert(i, RLM.toString())
        return b
    }

    /** Same for a plain string (used by tests and by plain-text cues). */
    fun fixString(text: String): String {
        val points = insertionPoints(text)
        if (points.isEmpty()) return text
        val sb = StringBuilder(text)
        for (i in points.asReversed()) sb.insert(i, RLM)
        return sb.toString()
    }
}
