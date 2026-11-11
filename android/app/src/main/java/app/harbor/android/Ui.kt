package app.harbor.android

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat

/** Colours shared with the web UI (dark theme, warm accent). */
object HarborColors {
    val ACCENT = Color.parseColor("#E8A45E")
    val PANEL = Color.parseColor("#F21A1C21")
    val ROW_ACTIVE = Color.argb(46, 232, 164, 94)
    val TEXT = Color.WHITE
    val MUTED = Color.argb(170, 255, 255, 255)
    val SUBTLE = Color.argb(110, 255, 255, 255)
    val CHIP = Color.argb(30, 255, 255, 255)
    val DIVIDER = Color.argb(22, 255, 255, 255)
}

fun Context.dp(v: Float): Int = (v * resources.displayMetrics.density).toInt()
fun Context.dp(v: Int): Int = dp(v.toFloat())

fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = 0) = GradientDrawable().apply {
    cornerRadius = radius
    setColor(color)
    if (stroke > 0) setStroke(stroke, strokeColor)
}

fun Context.icon(res: Int, sizeDp: Int = 22, tint: Int = Color.WHITE) = ImageView(this).apply {
    setImageDrawable(ContextCompat.getDrawable(this@icon, res)?.mutate()?.also { it.setTint(tint) })
    layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
}

fun Context.label(text: CharSequence, sizeSp: Float = 14f, color: Int = HarborColors.TEXT, bold: Boolean = false, lines: Int = 0) =
    TextView(this).apply {
        this.text = text
        textSize = sizeSp
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        if (lines > 0) {
            maxLines = lines
            ellipsize = TextUtils.TruncateAt.END
        }
    }

/** Round icon button used in the player's top bar. */
fun Context.iconButton(res: Int, desc: String, onClick: () -> Unit) = FrameLayout(this).apply {
    contentDescription = desc
    background = rounded(Color.argb(90, 0, 0, 0), 999f)
    isClickable = true
    isFocusable = true
    setOnClickListener { onClick() }
    val ic = icon(res, 22)
    addView(ic, FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER))
    layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = dp(6) }
}

/**
 * Right-hand sheet over the player (landscape), like streaming apps: dimmed scrim,
 * header with title + close, scrollable body. Tapping the scrim closes it.
 */
class SidePanel(private val ctx: Context, private val host: FrameLayout, title: String, private val onClosed: () -> Unit = {}) {
    private val scrim = FrameLayout(ctx)
    private val panel = LinearLayout(ctx)
    val body = LinearLayout(ctx)
    val header = LinearLayout(ctx)
    private val titleView = ctx.label(title, 17f, bold = true, lines = 1)
    private val scroll = ScrollView(ctx)
    var isOpen = false
        private set

    init {
        scrim.setBackgroundColor(Color.argb(110, 0, 0, 0))
        scrim.isClickable = true
        scrim.setOnClickListener { dismiss() }

        val metrics = ctx.resources.displayMetrics
        // Right-to-left (Arabic): the panel sits at the left edge, so round the other corners and
        // slide in from the left.
        val rtl = ctx.resources.configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL
        val r = ctx.dp(22).toFloat()
        val width = minOf(ctx.dp(460), (metrics.widthPixels * 0.62f).toInt()).coerceAtLeast(minOf(ctx.dp(320), metrics.widthPixels))
        panel.orientation = LinearLayout.VERTICAL
        panel.isClickable = true // don't let taps fall through to the scrim
        panel.background = GradientDrawable().apply {
            setColor(HarborColors.PANEL)
            cornerRadii = if (rtl) floatArrayOf(0f, 0f, r, r, r, r, 0f, 0f) else floatArrayOf(r, r, 0f, 0f, 0f, 0f, r, r)
        }
        panel.setPadding(ctx.dp(18), ctx.dp(14), ctx.dp(14), ctx.dp(10))

        header.orientation = LinearLayout.HORIZONTAL
        header.gravity = Gravity.CENTER_VERTICAL
        header.addView(titleView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(ctx.iconButton(R.drawable.ic_x, "إغلاق") { dismiss() })
        panel.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        body.orientation = LinearLayout.VERTICAL
        scroll.isFillViewport = true
        scroll.addView(body, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        panel.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = ctx.dp(6) })

        scrim.addView(panel, FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END))
    }

    fun setTitle(t: String) { titleView.text = t }

    fun show() {
        if (isOpen) return
        isOpen = true
        host.addView(scrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val rtl = ctx.resources.configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL
        panel.translationX = (if (rtl) -1 else 1) * ctx.dp(80).toFloat()
        panel.alpha = 0f
        panel.animate().translationX(0f).alpha(1f).setDuration(180).start()
    }

    fun dismiss() {
        if (!isOpen) return
        isOpen = false
        host.removeView(scrim)
        onClosed()
    }

    fun clear() = body.removeAllViews()

    fun scrollToTop() = scroll.scrollTo(0, 0)

    // ---- content builders ---------------------------------------------------------------

    fun section(text: String) {
        body.addView(ctx.label(text, 12.5f, HarborColors.SUBTLE, bold = true).apply {
            setPadding(ctx.dp(4), ctx.dp(16), 0, ctx.dp(6))
            letterSpacing = 0.06f
        })
    }

    fun note(text: String) {
        body.addView(ctx.label(text, 13f, HarborColors.MUTED).apply { setPadding(ctx.dp(4), ctx.dp(10), ctx.dp(4), ctx.dp(10)) })
    }

    /** A tappable list row: title, optional subtitle, optional right text, check when selected,
     *  and an optional small round button at the end (e.g. "save for offline"). */
    fun row(
        title: String,
        subtitle: String? = null,
        trailing: String? = null,
        selected: Boolean = false,
        loading: Boolean = false,
        actionIcon: Int? = null,
        actionDesc: String? = null,
        actionBusy: Boolean = false,
        onAction: (() -> Unit)? = null,
        onClick: (() -> Unit)?,
    ): View {
        val r = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(ctx.dp(12), ctx.dp(10), ctx.dp(10), ctx.dp(10))
            background = rounded(if (selected) HarborColors.ROW_ACTIVE else Color.TRANSPARENT, ctx.dp(14).toFloat())
            if (onClick != null) {
                isClickable = true
                setOnClickListener { onClick() }
            }
        }
        val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(ctx.label(title, 14.5f, if (selected) HarborColors.ACCENT else HarborColors.TEXT, bold = selected, lines = 2))
        if (!subtitle.isNullOrBlank()) texts.addView(ctx.label(subtitle, 12.5f, HarborColors.MUTED, lines = 3).apply { setPadding(0, ctx.dp(2), 0, 0) })
        r.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (!trailing.isNullOrBlank()) {
            r.addView(ctx.label(trailing, 11.5f, HarborColors.MUTED, bold = true).apply {
                setPadding(ctx.dp(8), ctx.dp(3), ctx.dp(8), ctx.dp(3))
                background = rounded(HarborColors.CHIP, ctx.dp(8).toFloat())
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = ctx.dp(8) })
        }
        when {
            loading -> r.addView(ProgressBar(ctx).apply { isIndeterminate = true }, LinearLayout.LayoutParams(ctx.dp(20), ctx.dp(20)).apply { marginStart = ctx.dp(10) })
            selected -> r.addView(ctx.icon(R.drawable.ic_check, 20, HarborColors.ACCENT).apply {
                layoutParams = LinearLayout.LayoutParams(ctx.dp(20), ctx.dp(20)).apply { marginStart = ctx.dp(10) }
            })
        }
        if (actionIcon != null && onAction != null) {
            val b = FrameLayout(ctx).apply {
                contentDescription = actionDesc
                background = rounded(HarborColors.CHIP, 999f)
                isClickable = true
                setOnClickListener { if (!actionBusy) onAction() }
                if (actionBusy) {
                    addView(ProgressBar(ctx).apply { isIndeterminate = true }, FrameLayout.LayoutParams(ctx.dp(16), ctx.dp(16), Gravity.CENTER))
                } else {
                    addView(ctx.icon(actionIcon, 18, HarborColors.MUTED), FrameLayout.LayoutParams(ctx.dp(18), ctx.dp(18), Gravity.CENTER))
                }
            }
            r.addView(b, LinearLayout.LayoutParams(ctx.dp(38), ctx.dp(38)).apply { marginStart = ctx.dp(10) })
        }
        body.addView(r, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = ctx.dp(2) })
        return r
    }

    /** Horizontally scrolling chips. */
    fun chips(items: List<Triple<String, Boolean, () -> Unit>>) {
        val line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        items.forEach { (text, on, click) ->
            line.addView(chip(text, on, click), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ctx.dp(36)).apply { marginEnd = ctx.dp(8) })
        }
        body.addView(HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(line)
            setPadding(0, ctx.dp(4), 0, ctx.dp(4))
        })
    }

    fun chip(text: String, on: Boolean, click: () -> Unit) = ctx.label(text, 13.5f, if (on) Color.BLACK else HarborColors.TEXT, bold = on).apply {
        gravity = Gravity.CENTER
        setPadding(ctx.dp(14), 0, ctx.dp(14), 0)
        background = rounded(if (on) HarborColors.ACCENT else HarborColors.CHIP, 999f)
        isClickable = true
        setOnClickListener { click() }
    }

    /** Full-width pill action button. */
    fun action(text: String, iconRes: Int? = null, onClick: () -> Unit): View {
        val b = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            background = rounded(HarborColors.CHIP, 999f, ctx.dp(1), Color.argb(40, 255, 255, 255))
            isClickable = true
            setOnClickListener { onClick() }
            if (iconRes != null) addView(ctx.icon(iconRes, 18).apply { layoutParams = LinearLayout.LayoutParams(ctx.dp(18), ctx.dp(18)).apply { marginEnd = ctx.dp(8) } })
            addView(ctx.label(text, 14f, bold = true))
        }
        body.addView(b, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ctx.dp(44)).apply { topMargin = ctx.dp(10); bottomMargin = ctx.dp(4) })
        return b
    }

    fun custom(v: View) = body.addView(v)
}
