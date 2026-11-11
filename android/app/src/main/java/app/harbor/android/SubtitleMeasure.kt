package app.harbor.android

import android.content.Context
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView

/**
 * Works out where Media3 draws a subtitle's lines, without drawing them. Two stacked subtitles
 * need it: the second sits right above the first, however many lines the first has at the moment.
 *
 * Media3 doesn't say where it drew, so the text is laid out here the way its SubtitlePainter does
 * it: the same text size (a part of the height of the view inside its padding), typeface, line
 * spacing and width (the view inside its padding, less an eighth of the text size on each side).
 * Embedded styles and sizes are off in this player (SubStyle.applyTo), so a line's own spans
 * don't change its height.
 */
@OptIn(UnstableApi::class)
class SubtitleMeasure(ctx: Context) {
    private val paint = TextPaint().apply {
        isAntiAlias = true
        isSubpixelText = true
    }
    private val spacingAdd: Float
    private val spacingMult: Float

    init {
        // The line spacing the painter reads from the theme (none, unless a theme sets one).
        val a = ctx.obtainStyledAttributes(null, intArrayOf(android.R.attr.lineSpacingExtra, android.R.attr.lineSpacingMultiplier), 0, 0)
        spacingAdd = a.getDimensionPixelSize(0, 0).toFloat()
        spacingMult = a.getFloat(1, 1f)
        a.recycle()
    }

    /** From where to where a subtitle's lines reach, in pixels above the bottom of its box. */
    class Extent(val low: Int, val high: Int)

    private fun layout(cue: Cue, style: SubStyle, boxWidth: Int, boxHeight: Int): StaticLayout? {
        val text = cue.text?.toString()
        if (text.isNullOrEmpty()) return null
        val size = SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * style.scale * boxHeight
        if (size <= 0f) return null
        paint.textSize = size
        paint.typeface = if (style.bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        val sidePadding = (size * INNER_PADDING_RATIO + 0.5f).toInt()
        var width = boxWidth - sidePadding * 2
        if (cue.size != Cue.DIMEN_UNSET) width = (width * cue.size).toInt()
        if (width <= 0) return null
        @Suppress("DEPRECATION") // the constructor the painter itself uses
        return StaticLayout(text, paint, width, Layout.Alignment.ALIGN_CENTER, spacingMult, spacingAdd, true)
    }

    /** The height of the tallest of [cues], drawn with [style] in a box of this size. */
    fun tallest(cues: List<Cue>?, style: SubStyle, boxWidth: Int, boxHeight: Int): Int {
        var max = 0
        cues?.forEach { c -> if (c.bitmap == null) layout(c, style, boxWidth, boxHeight)?.let { max = maxOf(max, it.height) } }
        return max
    }

    /**
     * Where [cues] are drawn in a box of this size, or null when nothing is. A line with no place
     * of its own sits [SubStyle.bottom] above the box's bottom; one the file places itself (every
     * line of an ASS file, a picture subtitle) is where the painter puts it. Of those, only the
     * ones in the lower half count: a sign at the top of the picture is not what a second
     * subtitle has to stay clear of.
     */
    fun extent(cues: List<Cue>?, style: SubStyle, boxWidth: Int, boxHeight: Int): Extent? {
        if (cues.isNullOrEmpty() || boxWidth <= 0 || boxHeight <= 0) return null
        var low = Int.MAX_VALUE
        var high = Int.MIN_VALUE
        for (cue in cues) {
            var top: Int
            val height: Int
            // Whether the file itself says where this line goes.
            val placed = cue.line != Cue.DIMEN_UNSET
            val bitmap = cue.bitmap
            if (bitmap != null) {
                // A picture: the painter's setupBitmapLayout.
                if (!placed || cue.size == Cue.DIMEN_UNSET || bitmap.width <= 0) continue
                val width = Math.round(boxWidth * cue.size)
                height = if (cue.bitmapHeight != Cue.DIMEN_UNSET) Math.round(boxHeight * cue.bitmapHeight)
                else Math.round(width * (bitmap.height.toFloat() / bitmap.width))
                val anchor = boxHeight * cue.line
                top = Math.round(
                    when (cue.lineAnchor) {
                        Cue.ANCHOR_TYPE_END -> anchor - height
                        Cue.ANCHOR_TYPE_MIDDLE -> anchor - height / 2
                        else -> anchor
                    },
                )
            } else {
                // Text: the painter's setupTextLayout.
                val l = layout(cue, style, boxWidth, boxHeight) ?: continue
                height = l.height
                if (!placed) {
                    top = boxHeight - height - (boxHeight * style.bottom).toInt()
                } else {
                    if (cue.lineType == Cue.LINE_TYPE_FRACTION) {
                        val anchor = Math.round(boxHeight * cue.line)
                        top = when (cue.lineAnchor) {
                            Cue.ANCHOR_TYPE_END -> anchor - height
                            Cue.ANCHOR_TYPE_MIDDLE -> (anchor * 2 - height) / 2
                            else -> anchor
                        }
                    } else {
                        val firstLine = l.getLineBottom(0) - l.getLineTop(0)
                        top = if (cue.line >= 0) Math.round(cue.line * firstLine)
                        else Math.round((cue.line + 1) * firstLine) + boxHeight - height
                    }
                    if (top + height > boxHeight) top = boxHeight - height else if (top < 0) top = 0
                }
            }
            if (height <= 0) continue
            if (placed && top + height / 2 < boxHeight / 2) continue
            low = minOf(low, boxHeight - (top + height))
            high = maxOf(high, boxHeight - top)
        }
        return if (high > low) Extent(low, high) else null
    }

    private companion object {
        /** SubtitlePainter.INNER_PADDING_RATIO: the room left on each side of the text. */
        const val INNER_PADDING_RATIO = 0.125f
    }
}
