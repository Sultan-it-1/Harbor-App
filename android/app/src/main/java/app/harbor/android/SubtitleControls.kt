package app.harbor.android

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import org.json.JSONObject

/** Subtitle look, saved on the device. First run is seeded from Harbor's subtitle settings. */
data class SubStyle(
    var scale: Float = 1f,
    var background: String = "shadow", // shadow | outline | box | none
    var color: Int = Color.WHITE,
    var bottom: Float = 0.08f,
    var bold: Boolean = false,
    var boxOpacity: Float = 0.6f,
) {
    companion object {
        private const val PREFS = "harbor.substyle"

        fun load(ctx: Context): SubStyle? {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!p.getBoolean("saved", false)) return null
            return SubStyle(
                scale = p.getFloat("scale", 1f),
                background = p.getString("background", "shadow") ?: "shadow",
                color = p.getInt("color", Color.WHITE),
                bottom = p.getFloat("bottom", 0.08f),
                bold = p.getBoolean("bold", false),
                boxOpacity = p.getFloat("boxOpacity", 0.6f),
            )
        }

        /** Harbor web settings: subFontSize (32 = 100%), subFontColor, subStyle, subBold, subMarginY, subBoxOpacity. */
        fun fromHarbor(o: JSONObject?): SubStyle {
            val s = SubStyle()
            if (o == null) return s
            val size = o.optDouble("fontSize", 32.0)
            if (size > 0) s.scale = (size / 32.0).toFloat().coerceIn(0.5f, 2.5f)
            try {
                o.optString("color").takeIf { it.startsWith("#") }?.let { s.color = Color.parseColor(it) }
            } catch (_: Exception) {}
            s.background = when (o.optString("style")) {
                "outline" -> "outline"
                "box" -> "box"
                else -> "shadow"
            }
            s.bold = o.optBoolean("bold", false)
            val margin = o.optDouble("marginY", 12.0)
            s.bottom = (0.04 + margin / 400.0).toFloat().coerceIn(0.02f, 0.4f)
            s.boxOpacity = o.optDouble("boxOpacity", 0.6).toFloat().coerceIn(0.1f, 1f)
            return s
        }
    }

    fun save(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("saved", true)
            .putFloat("scale", scale)
            .putString("background", background)
            .putInt("color", color)
            .putFloat("bottom", bottom)
            .putBoolean("bold", bold)
            .putFloat("boxOpacity", boxOpacity)
            .apply()
    }

    @OptIn(UnstableApi::class)
    fun applyTo(sv: SubtitleView?) {
        if (sv == null) return
        // Our look wins over styling baked into ASS / embedded tracks, like a normal player.
        sv.setApplyEmbeddedStyles(false)
        sv.setApplyEmbeddedFontSizes(false)
        sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * scale)
        sv.setBottomPaddingFraction(bottom)
        val typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        val boxAlpha = (boxOpacity * 255).toInt().coerceIn(0, 255)
        val style = when (background) {
            "box" -> CaptionStyleCompat(color, Color.argb(boxAlpha, 0, 0, 0), Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_NONE, Color.BLACK, typeface)
            "outline" -> CaptionStyleCompat(color, Color.TRANSPARENT, Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, typeface)
            "none" -> CaptionStyleCompat(color, Color.TRANSPARENT, Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_NONE, Color.BLACK, typeface)
            else -> CaptionStyleCompat(color, Color.TRANSPARENT, Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, Color.BLACK, typeface)
        }
        sv.setStyle(style)
    }
}

/** Subtitle look + timing, rendered inside the player's subtitle side panel. */
class SubtitleControls(
    private val ctx: Context,
    private val style: SubStyle,
    private val onStyle: () -> Unit,
    private val getDelayMs: () -> Long,
    private val onDelay: (Long) -> Unit,
) {
    private lateinit var panel: SidePanel
    private var delayWorks = true

    fun build(p: SidePanel, delayWorks: Boolean) {
        panel = p
        this.delayWorks = delayWorks
        render()
    }

    private fun changed() {
        style.save(ctx)
        onStyle()
        render()
    }

    private fun render() {
        val p = panel
        // Keep the two tab chips at the top (first child), rebuild everything below them.
        while (p.body.childCount > 1) p.body.removeViewAt(1)

        p.section(Strings.size((style.scale * 100).toInt()))
        p.chips(listOf(
            Triple(Strings.smaller, false) { style.scale = (style.scale - 0.1f).coerceAtLeast(0.5f); changed() },
            Triple(Strings.bigger, false) { style.scale = (style.scale + 0.1f).coerceAtMost(2.5f); changed() },
            Triple("90%", kotlin.math.abs(style.scale - 0.9f) < 0.05f) { style.scale = 0.9f; changed() },
            Triple("100%", kotlin.math.abs(style.scale - 1f) < 0.05f) { style.scale = 1f; changed() },
            Triple("130%", kotlin.math.abs(style.scale - 1.3f) < 0.05f) { style.scale = 1.3f; changed() },
            Triple("160%", kotlin.math.abs(style.scale - 1.6f) < 0.05f) { style.scale = 1.6f; changed() },
        ))

        p.section(Strings.background)
        p.chips(listOf("shadow" to Strings.shadow, "outline" to Strings.outline, "box" to Strings.box, "none" to Strings.none).map { (k, n) ->
            Triple(n, style.background == k) { style.background = k; changed() }
        })
        if (style.background == "box") {
            p.section(Strings.boxOpacity((style.boxOpacity * 100).toInt()))
            p.chips(listOf(0.3f, 0.5f, 0.7f, 0.9f).map { o ->
                Triple("${(o * 100).toInt()}%", kotlin.math.abs(style.boxOpacity - o) < 0.05f) { style.boxOpacity = o; changed() }
            })
        }

        p.section(Strings.color)
        p.chips(listOf(
            Color.WHITE to Strings.white, Color.parseColor("#FFE14D") to Strings.yellow,
            Color.parseColor("#7FE7FF") to Strings.cyan, Color.parseColor("#8CFF8C") to Strings.green,
        ).map { (c, n) -> Triple(n, style.color == c) { style.color = c; changed() } })

        p.section(Strings.position)
        p.chips(listOf(
            Triple(Strings.lower, false) { style.bottom = (style.bottom - 0.03f).coerceAtLeast(0f); changed() },
            Triple(Strings.higher, false) { style.bottom = (style.bottom + 0.03f).coerceAtMost(0.45f); changed() },
            Triple(Strings.defaultValue, kotlin.math.abs(style.bottom - 0.08f) < 0.01f) { style.bottom = 0.08f; changed() },
        ))

        p.section(Strings.font)
        p.chips(listOf(Triple(Strings.bold, style.bold) { style.bold = !style.bold; changed() }))

        val d = getDelayMs()
        p.section(Strings.delay((if (d > 0) "+" else "") + String.format(java.util.Locale.US, "%.1f", d / 1000.0)))
        if (!delayWorks) {
            p.note(Strings.delayNeedsAddonSubtitle)
        } else {
            p.chips(listOf(
                Triple("−1", false) { onDelay(getDelayMs() - 1000); render() },
                Triple("−0.1", false) { onDelay(getDelayMs() - 100); render() },
                Triple("0", d == 0L) { onDelay(0); render() },
                Triple("+0.1", false) { onDelay(getDelayMs() + 100); render() },
                Triple("+1", false) { onDelay(getDelayMs() + 1000); render() },
            ))
            p.note(Strings.delayHint)
        }

        p.action(Strings.resetLook) {
            val def = SubStyle()
            style.scale = def.scale; style.background = def.background; style.color = def.color
            style.bottom = def.bottom; style.bold = def.bold; style.boxOpacity = def.boxOpacity
            changed()
        }
    }
}
