package app.harbor.android

import android.content.Context
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Parcelable
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.PagerSnapHelper
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * The Home screen drawn with Android's own views instead of in the WebView: the featured hero,
 * Continue Watching, Top 10 and the catalog poster rows. Some devices (Android 13 handhelds such
 * as the Anbernic RG 476H) ship a WebView that can't lay out the poster rows; here the system
 * draws them, whatever the WebView.
 *
 * The page still decides WHAT is on Home (addons, TMDB, Trakt, row order, hidden rows…) and
 * handles every tap, so nothing of that is written twice. Contract (src/views/home/native-home.ts):
 *   page   -> HarborAndroid.homeSet(modelJson)   what to show (HomeModel)
 *   page   -> HarborAndroid.homeShow(on, …)       shown only while Home is on screen with nothing over it
 *   native -> window.__harborNativeHome(json)    {p:page, a:"hero",i,what:"open"|"play"|"list"}
 *                                                {a:"open"|"hold"|"play",row,i} {a:"all",row} {a:"more",row}
 *                                                {a:"chip",row,what} {a:"customize"} {a:"together"} {a:"failed"}
 * The same screen serves Discover, Movies, Shows and the Library (NativeScreens keeps one per page).
 */
class NativeHome(
    private val ctx: Context,
    private val images: NativeImages,
    /** Which screen this draws ("home", "discover", "movies", "shows", "library"); sent with every tap. */
    val page: String,
    private val onAction: (JSONObject) -> Unit,
) {
    val root = ScreenRoot(ctx)
    private val list = RecyclerView(ctx)
    private val sections = SectionsAdapter()
    private val togetherButton = FrameLayout(ctx)
    /** A page opened over another: "Back" at the top (like the page's own pill). */
    private val backButton = LinearLayout(ctx)
    /** Fades in at the top once the page scrolls, so what scrolls under Back and Watch together doesn't show through them. */
    private val topScrim = View(ctx)
    /** A full-screen step over everything (the play picker's: connecting, peer-to-peer…). */
    private val stageView = FrameLayout(ctx)
    private val backText = label("", 13.5f, lines = 1)
    private val backIcon = ImageView(ctx)
    /** The search field: under the heading, then held at the top while the page scrolls. */
    private val searchBar = FrameLayout(ctx)
    private val searchBox = LinearLayout(ctx)
    private val searchIcon = ImageView(ctx)
    private val searchField = android.widget.EditText(ctx)
    private val searchBusy = android.widget.ProgressBar(ctx, null, android.R.attr.progressBarStyleSmall)
    private val searchClear = ImageView(ctx)
    private var searchKey: String? = null
    private var searchQuiet = false
    /** What the field last told the page: other text from the page was set by the page itself. */
    private var searchSent = ""
    private val searchSend = Runnable { sendQuery() }
    private val cardPool = RecyclerView.RecycledViewPool()
    private val rowScroll = HashMap<String, Parcelable?>()
    private val askedMore = HashMap<String, Int>()
    private var model: HomeModel? = null
    private var colors = HomeColors.DEFAULT
    private var lastJson: String? = null
    private var lastTop = Int.MIN_VALUE
    private var heroPage = 0
    /** What the page last asked for (it may ask before the first model arrives). */
    private var wanted = false
    private var laidOutWidth = 0
    private var laidOutHeight = 0

    val isShowing: Boolean get() = root.visibility == View.VISIBLE

    init {
        root.visibility = View.GONE
        root.live = false
        root.isClickable = true // taps never fall through to the page underneath
        list.layoutManager = LinearLayoutManager(ctx, RecyclerView.VERTICAL, false).apply { initialPrefetchItemCount = 3 }
        list.adapter = sections
        list.overScrollMode = View.OVER_SCROLL_NEVER
        list.isVerticalScrollBarEnabled = false
        list.clipToPadding = false
        list.itemAnimator = null
        cardPool.setMaxRecycledViews(C_POSTER, 40)
        cardPool.setMaxRecycledViews(C_RANK, 16)
        cardPool.setMaxRecycledViews(C_CW, 12)
        cardPool.setMaxRecycledViews(C_TILE, 16)
        cardPool.setMaxRecycledViews(C_LOGO, 12)
        cardPool.setMaxRecycledViews(C_FEATURE, 2)
        cardPool.setMaxRecycledViews(C_LEAD, 2)
        root.addView(list, FrameLayout.LayoutParams(MATCH, MATCH))
        topScrim.alpha = 0f
        topScrim.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        root.addView(topScrim, FrameLayout.LayoutParams(MATCH, dp(104), Gravity.TOP))

        togetherButton.apply {
            visibility = View.GONE
            isClickable = true
            isFocusable = true
            setOnClickListener { act("together") }
            val ic = ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_users, Color.WHITE)) }
            addView(ic, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER))
        }
        root.addView(togetherButton, FrameLayout.LayoutParams(dp(44), dp(44), Gravity.TOP or Gravity.END).apply {
            topMargin = dp(12)
            marginEnd = dp(12)
        })

        backButton.apply {
            visibility = View.GONE
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isClickable = true
            isFocusable = true
            setPaddingRelative(dp(12), 0, dp(20), 0)
            setOnClickListener { act("back") }
            addView(backIcon, LinearLayout.LayoutParams(dp(15), dp(15)).apply { marginEnd = dp(8) })
            addView(backText)
        }
        root.addView(backButton, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40), Gravity.TOP or Gravity.START).apply {
            topMargin = dp(14)
            marginStart = dp(16)
        })

        searchBox.apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPaddingRelative(dp(14), 0, dp(6), 0)
            addView(searchIcon, LinearLayout.LayoutParams(dp(16), dp(16)).apply { marginEnd = dp(10) })
            searchField.background = null
            searchField.setSingleLine(true)
            searchField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f)
            searchField.setPadding(0, 0, 0, 0)
            searchField.imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH
            searchField.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            searchField.setOnEditorActionListener { v, _, _ ->
                // Search on the keyboard: what's typed now, then the page's Enter (its top match).
                root.removeCallbacks(searchSend)
                sendQuery()
                act("submit")
                hideKeyboard(v)
                true
            }
            searchField.addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(t: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(t: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(e: android.text.Editable?) {
                    searchClear.visibility = if (e.isNullOrEmpty()) View.GONE else View.VISIBLE
                    if (searchQuiet) return
                    // Sent once typing pauses (the page filters the whole list each time).
                    root.removeCallbacks(searchSend)
                    root.postDelayed(searchSend, 220)
                }
            })
            addView(searchField, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
            addView(searchBusy, LinearLayout.LayoutParams(dp(16), dp(16)).apply { marginStart = dp(6) })
            searchClear.setPadding(dp(6), dp(6), dp(6), dp(6))
            searchClear.isClickable = true
            searchClear.isFocusable = true
            searchClear.visibility = View.GONE
            searchClear.setOnClickListener { searchField.setText("") }
            addView(searchClear, LinearLayout.LayoutParams(dp(30), dp(30)).apply { marginStart = dp(2) })
        }
        searchBar.visibility = View.GONE
        searchBar.setPadding(dp(16), dp(8), dp(16), dp(8))
        searchBar.addView(searchBox, FrameLayout.LayoutParams(MATCH, dp(44)))
        root.addView(searchBar, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        stageView.visibility = View.GONE
        root.addView(stageView, FrameLayout.LayoutParams(MATCH, MATCH))
        list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                placeSearch()
                placeScrim()
            }
        })

        // New width (rotation, split screen): card sizes follow it.
        root.addOnLayoutChangeListener { _, l, t, r, b, _, _, _, _ ->
            val w = r - l
            val h = b - t
            if (w > 0 && (w != laidOutWidth || abs(h - laidOutHeight) > dp(80))) {
                val first = laidOutWidth == 0
                laidOutWidth = w
                laidOutHeight = h
                if (!first) root.post { sections.notifyDataSetChanged() }
            }
        }
    }

    /** The top shade: none at the top of the page, full once it has scrolled a little. */
    private fun placeScrim() {
        topScrim.alpha = (list.computeVerticalScrollOffset() / dp(64).toFloat()).coerceIn(0f, 1f)
    }

    /** A new description of Home from the page. Nothing changed = nothing redrawn. */
    fun setModel(json: String) {
        if (json == lastJson) return
        val m = try {
            HomeModel.parse(json)
        } catch (e: Exception) {
            Log.e(TAG, "home model rejected", e)
            act("failed")
            return
        }
        lastJson = json
        try {
            model = m
            colors = m.colors
            root.layoutDirection = if (m.rtl) View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
            root.setBackgroundColor(colors.canvas)
            topScrim.background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(colors.canvas, colors.canvas, withAlpha(colors.canvas, 0.9f), Color.TRANSPARENT),
            )
            togetherButton.background = rounded(withAlpha(colors.canvas, 0.72f), dp(22).toFloat())
            togetherButton.contentDescription = m.label("together", "Watch together")
            togetherButton.visibility = if (m.showTogether) View.VISIBLE else View.GONE
            backButton.visibility = if (m.back != null) View.VISIBLE else View.GONE
            if (m.back != null) {
                backText.text = m.back
                backText.setTextColor(colors.muted)
                backIcon.setImageDrawable(icon(R.drawable.ic_arrow_left, colors.muted))
                backIcon.scaleX = if (m.rtl) -1f else 1f
                backButton.contentDescription = m.back
                backButton.background = focusable(rounded(withAlpha(colors.canvas, 0.85f), dp(20).toFloat(), dp(1), withAlpha(colors.ink, 0.1f)))
            }
            bindSearch(m)
            bindSheet(m.sheet)
            bindStage(m.stage)
            bindToast(m.toast)
            bindPrompt(m.prompt)
            sections.submit(m)
            if (lastTop != Int.MIN_VALUE && m.top != lastTop) list.scrollToPosition(0)
            lastTop = m.top
            applyVisibility()
            list.post { placeScrim() }
        } catch (e: Exception) {
            Log.e(TAG, "home model failed to show", e)
            show(false, 0)
            act("failed")
        }
    }

    private fun bindSearch(m: HomeModel) {
        val q = m.search
        if (q == null) {
            searchBar.visibility = View.GONE
            searchKey = null
            if (searchField.hasFocus()) hideKeyboard(searchField)
            return
        }
        searchBar.visibility = View.VISIBLE
        searchBar.setBackgroundColor(withAlpha(colors.canvas, 0.9f))
        // The search screen's field: bigger, rounder (like the page's).
        val blp = searchBox.layoutParams
        val bh = if (q.big) dp(56) else dp(44)
        if (blp.height != bh) {
            blp.height = bh
            searchBox.layoutParams = blp
        }
        searchField.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (q.big) 18f else 14.5f)
        val ilp = searchIcon.layoutParams
        val isz = if (q.big) dp(20) else dp(16)
        if (ilp.width != isz) {
            ilp.width = isz
            ilp.height = isz
            searchIcon.layoutParams = ilp
        }
        searchBox.background = rounded(
            if (q.big) withAlpha(colors.surface, 0.85f) else colors.surface,
            if (q.big) dp(16).toFloat() else dp(12).toFloat(),
            dp(1),
            withAlpha(colors.ink, 0.1f),
        )
        searchIcon.setImageDrawable(icon(R.drawable.ic_search, if (q.big) colors.muted else colors.subtle))
        searchClear.setImageDrawable(icon(R.drawable.ic_x, colors.subtle))
        searchClear.contentDescription = m.label("clear", "Clear")
        searchField.setTextColor(colors.ink)
        searchField.setHintTextColor(colors.subtle)
        searchField.hint = q.hint
        searchField.textAlignment = View.TEXT_ALIGNMENT_VIEW_START
        searchBusy.visibility = if (q.busy) View.VISIBLE else View.GONE
        // Another list: its own text. The same one: what's typed stays (the page answers late).
        if (q.key != searchKey) {
            searchKey = q.key
            root.removeCallbacks(searchSend)
            searchSent = q.text
            searchQuiet = true
            searchField.setText(q.text)
            searchField.setSelection(searchField.text?.length ?: 0)
            searchQuiet = false
            if (q.focus) {
                root.postDelayed({
                    if (!isShowing || searchKey != q.key) return@postDelayed
                    searchField.requestFocus()
                    (ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)
                        ?.showSoftInput(searchField, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
                }, 150)
            }
        } else if (q.text != searchSent && q.text != (searchField.text?.toString() ?: "")) {
            // The page set the text itself (a recent search, Clear): show it. An old echo of what
            // was typed matches searchSent and leaves the field alone.
            root.removeCallbacks(searchSend)
            searchSent = q.text
            searchQuiet = true
            searchField.setText(q.text)
            searchField.setSelection(searchField.text?.length ?: 0)
            searchQuiet = false
        }
    }

    private fun sendQuery() {
        val text = searchField.text?.toString() ?: ""
        searchSent = text
        act("query", text = text)
    }

    /** The search field under the heading, or held at the top once the heading has scrolled away. */
    private fun placeSearch() {
        if (searchBar.visibility != View.VISIBLE) return
        val pos = sections.positionOf(T_SEARCH)
        if (pos < 0) return
        val m = model
        val pinned = (if (m != null && m.back == null && !m.showTogether) dp(4) else dp(60)).toFloat()
        val v = list.findViewHolderForAdapterPosition(pos)?.itemView
        val first = (list.layoutManager as LinearLayoutManager).findFirstVisibleItemPosition()
        searchBar.translationY = when {
            v != null -> max(pinned, v.top.toFloat())
            first != RecyclerView.NO_POSITION && first > pos -> pinned
            else -> list.height.toFloat()
        }
    }

    private fun hideKeyboard(v: View) {
        v.clearFocus()
        (ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)
            ?.hideSoftInputFromWindow(v.windowToken, 0)
    }

    /** On (Home on screen, nothing over it) or off; [bottomPx] = room kept for the page's tab bar. */
    /**
     * On screen or not. [linger]: another native screen is coming in over this one, so this one
     * stays (under it) until that one has faded in, rather than leaving the page's dark background
     * showing between them.
     */
    fun show(on: Boolean, bottomPx: Int, linger: Boolean = false) {
        val lp = root.layoutParams as? ViewGroup.MarginLayoutParams
        if (lp != null && lp.bottomMargin != bottomPx.coerceAtLeast(0)) {
            lp.bottomMargin = bottomPx.coerceAtLeast(0)
            root.layoutParams = lp
        }
        wanted = on
        applyVisibility(linger)
    }

    private var lingering = false
    private val hideLater = Runnable {
        lingering = false
        if (!(wanted && model != null)) root.visibility = View.GONE
    }

    /** Told once this screen, coming in, is fully on screen (the one it replaced can go). */
    var onRevealed: (() -> Unit)? = null

    /** A screen leaving under another: it goes now (the other is fully in). */
    fun dropLinger() {
        if (!lingering) return
        root.removeCallbacks(hideLater)
        hideLater.run()
    }

    private var revealFrom = 0L
    /** Coming in: it fades in once its first pictures are in (0.4 s at most), so the screen it
     *  replaces stays until then instead of an empty one (dark, then its picture) flashing. */
    private val revealTick = object : Runnable {
        override fun run() {
            val waited = android.os.SystemClock.uptimeMillis() - revealFrom
            if (waited < 400 && (list.childCount == 0 || images.pendingIn(root))) {
                root.postDelayed(this, 40)
                return
            }
            root.animate().alpha(1f).setDuration(140).withEndAction { onRevealed?.invoke() }.start()
        }
    }

    private fun applyVisibility(linger: Boolean = false) {
        val want = wanted && model != null
        if (lingering) {
            if (!want) return // on its way out already
            // Back before it left (a quick Back): on top again.
            root.removeCallbacks(hideLater)
            root.removeCallbacks(revealTick)
            lingering = false
            root.animate().cancel()
            root.alpha = 1f
            root.bringToFront()
            root.live = true
            root.post { images.resume(root) }
            return
        }
        if (want == isShowing) return
        root.animate().cancel()
        root.removeCallbacks(revealTick)
        if (want) {
            // Over the screen it replaces (which waits under it), fading in when its first
            // pictures are in.
            root.bringToFront()
            root.alpha = 0f
            root.visibility = View.VISIBLE
            root.live = true
            bindSheet(model?.sheet)
            // Pictures it was still waiting for when it stepped aside.
            root.post { images.resume(root) }
            revealFrom = android.os.SystemClock.uptimeMillis()
            root.postDelayed(revealTick, 16)
        } else {
            // Its pictures still to come wait (the screen on show goes first).
            root.live = false
            if (searchField.hasFocus()) hideKeyboard(searchField)
            // The screen stepping aside closes its menu (and the page hears it closed).
            sheetDialog?.dismiss()
            promptDialog?.dismiss()
            if (linger) {
                // Until the screen coming in is fully in (it says so), at most a moment.
                lingering = true
                root.postDelayed(hideLater, 900)
            } else {
                root.visibility = View.GONE
            }
        }
    }

    /** A D-pad / controller key while the focus is elsewhere (the page underneath): bring it here. */
    fun takeFocus(): Boolean = isShowing && (list.requestFocus() || root.requestFocus())

    private fun act(a: String, row: String? = null, i: Int? = null, what: String? = null, text: String? = null) {
        val o = JSONObject().put("p", page).put("a", a)
        if (row != null) o.put("row", row)
        if (i != null) o.put("i", i)
        if (what != null) o.put("what", what)
        if (text != null) o.put("text", text)
        onAction(o)
    }

    // ---- sizes ---------------------------------------------------------------------------------

    private fun width(): Int = (if (laidOutWidth > 0) laidOutWidth else ctx.resources.displayMetrics.widthPixels)
    private fun height(): Int = (if (laidOutHeight > 0) laidOutHeight else ctx.resources.displayMetrics.heightPixels)
    private val gutter get() = dp(20)
    private val gap get() = dp(12)

    /** About 3.3 posters across a phone (like the web layout), never bigger than 150dp. */
    private fun posterWidth(): Int = min(((width() - gutter) / 3.3f).toInt(), dp(150))
    /** Top 10 posters: a little bigger than the others. */
    private fun rankWidth(): Int = (posterWidth() * 1.15f).toInt()
    private fun cwWidth(): Int = min(((width() - gutter) / 1.7f).toInt(), dp(300))
    private fun heroHeight(): Int = max(min((height() * 0.76f).toInt(), dp(640)), dp(320))
    /** Genre / language / award / collection tiles: about 2.3 across, 5:4. */
    private fun tileWidth(): Int = min(((width() - gutter) / 2.3f).toInt(), dp(220))
    private fun logoWidth(): Int = min(((width() - gutter) / 2.6f).toInt(), dp(172))
    /** One card the width of the screen (Critics' Pick). */
    private fun featureWidth(): Int = width() - 2 * gutter
    /** Live TV's landscape cards: most of the width, the next one peeking. */
    private fun liveWidth(): Int = min(((width() - 2 * dp(16)) * 0.88f).toInt(), dp(360))

    // ---- outer list: hero, Customize, rows -----------------------------------------------------

    private class Section(val type: Int, val id: Long, val row: HomeRow? = null, val chipsIndex: Int = -1, val start: Int = 0)

    /** How many of [row]'s cards fit across a grid line. */
    private fun gridCols(row: HomeRow): Int {
        val tile = row.kind == HomeRow.Kind.TILE
        val min = if (row.min > 0) dp(row.min) else if (tile) dp(260) else dp(140)
        val gapX = dp(16)
        val avail = width() - 2 * dp(16)
        return max(if (tile) 1 else 2, (avail + gapX) / (min + gapX))
    }

    private inner class SectionsAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        private var items: List<Section> = emptyList()

        init {
            setHasStableIds(true)
        }

        fun submit(m: HomeModel) {
            val out = ArrayList<Section>()
            if (m.detail != null) out.add(Section(T_DETAIL, -11))
            if (m.header != null) out.add(Section(T_HEADER, -6))
            if (m.calendar != null) out.add(Section(T_CALBAR, -13))
            if (m.match != null) out.add(Section(T_MATCH, -16))
            if (m.search != null) out.add(Section(T_SEARCH, -8))
            if (m.hero.isNotEmpty()) out.add(Section(T_HERO, -1))
            if (m.showCustomize || m.edit) out.add(Section(T_TOOLS, -2))
            else if (m.hero.isNotEmpty()) out.add(Section(T_GAP, -5))
            m.chips.forEachIndexed { i, _ -> out.add(Section(T_CHIPS, -100L - i, chipsIndex = i)) }
            if (m.note != null) out.add(Section(T_NOTE, -9))
            if (m.cwEmpty != null) out.add(Section(T_CW_EMPTY, -3))
            // Live TV's guide: under the page's bar (playlist, search, Home / Grid / Guide, categories).
            m.guide?.let { g ->
                out.add(Section(T_GUIDE_RULER, -17))
                g.channels.forEachIndexed { i, _ -> out.add(Section(T_GUIDE_ROW, (-1000L - i), start = i)) }
            }
            for (r in m.rows) {
                if (r.kind == HomeRow.Kind.VERSUS) {
                    // Two sides' figures, a line each, in a card (the match's stats).
                    val base = stableId(r.key) shl 20
                    if (r.title.isNotBlank()) out.add(Section(T_ROW, stableId(r.key), r))
                    r.items.forEachIndexed { i, _ -> out.add(Section(T_VERSUS, base + i, r, start = i)) }
                    continue
                }
                if (r.kind == HomeRow.Kind.PITCH) {
                    if (r.items.isNotEmpty()) out.add(Section(T_PITCH, stableId(r.key), r))
                    continue
                }
                if (r.kind == HomeRow.Kind.PK) {
                    // The play picker's blocks: one each, the sources' box a line per source.
                    val base = stableId(r.key) shl 20
                    when (val b = r.pk) {
                        is PkStreams -> b.items.forEachIndexed { i, _ -> out.add(Section(T_PK_STREAM, base + i, r, start = i)) }
                        is PkPick -> out.add(Section(T_PK_PICK, base, r))
                        is PkTiers -> out.add(Section(T_PK_TIERS, base, r))
                        is PkDrawer -> out.add(Section(T_PK_DRAWER, base, r))
                        is PkDiag -> out.add(Section(T_PK_DIAG, base, r))
                        is PkPanel -> out.add(Section(T_PK_PANEL, base, r))
                        is PkLoader -> out.add(Section(T_PK_LOADER, base, r))
                        null -> {}
                    }
                    continue
                }
                if (r.kind == HomeRow.Kind.AD) {
                    // The Addons page's blocks: one each.
                    val type = when (r.ad) {
                        is AdCard -> T_AD_CARD
                        is AdTiles -> T_AD_TILES
                        is AdHero -> T_AD_HERO
                        is AdCommunity -> T_AD_COMM
                        is AdHead -> T_AD_HEAD
                        is AdCategories -> T_AD_CATS
                        is AdInstalled -> T_AD_INST
                        is AdDetail -> T_AD_DETAIL
                        is AdInfo -> T_AD_INFO
                        is AdDoc -> T_AD_DOC
                        null -> -1
                    }
                    if (type > 0) out.add(Section(type, stableId(r.key) shl 20, r))
                    continue
                }
                if (r.kind == HomeRow.Kind.SOURCES) {
                    // A title's sources to play: a card each, down the page.
                    val base = stableId(r.key) shl 20
                    r.items.forEachIndexed { i, _ -> out.add(Section(T_SOURCE, base + i, r, start = i)) }
                    continue
                }
                if (r.kind == HomeRow.Kind.ACTION) {
                    // Cards that do one thing (Browse a genre, Ask AI, play a link), no heading.
                    val base = stableId(r.key) shl 20
                    r.items.forEachIndexed { i, _ -> out.add(Section(T_ACTION, base + i, r, start = i)) }
                    continue
                }
                if (r.kind == HomeRow.Kind.WINNERS) {
                    // An award's category: its heading, then a line for each winner (year, title).
                    out.add(Section(T_ROW, stableId(r.key), r))
                    val base = stableId(r.key) shl 20
                    r.items.forEachIndexed { i, _ -> out.add(Section(T_WINNER, base + i, r, start = i)) }
                    continue
                }
                if (r.kind == HomeRow.Kind.LIST) {
                    // Titles listed down the page (search results): the heading, then one a line.
                    out.add(Section(T_ROW, stableId(r.key), r))
                    val base = stableId(r.key) shl 20
                    r.items.forEachIndexed { i, _ -> out.add(Section(T_LISTITEM, base + i, r, start = i)) }
                    continue
                }
                if (r.kind == HomeRow.Kind.EPISODES) {
                    // A series' episodes: the heading (seasons, tools), then one episode a line.
                    out.add(Section(T_ROW, stableId(r.key), r))
                    val base = stableId(r.key) shl 20
                    if (r.edit?.hidden != true) r.items.forEachIndexed { i, _ -> out.add(Section(T_EPISODE, base + i, r, start = i)) }
                    continue
                }
                if (r.kind == HomeRow.Kind.LIVEHERO) {
                    // Live TV's spotlight: one big card at a time.
                    if (r.items.isNotEmpty()) out.add(Section(T_LIVEHERO, stableId(r.key), r))
                    continue
                }
                if (!r.grid) {
                    out.add(Section(T_ROW, stableId(r.key), r))
                    continue
                }
                // A grid: its title, then one line of cards after another.
                val base = stableId(r.key) shl 20
                if (r.title.isNotBlank() || !r.note.isNullOrBlank()) out.add(Section(T_GRID_TITLE, base - 1, r))
                val cols = gridCols(r)
                val type = when (r.kind) {
                    HomeRow.Kind.TILE -> T_GRID_TILE
                    HomeRow.Kind.CHANNEL -> T_GRID_CHANNEL
                    else -> T_GRID_POSTER
                }
                var start = 0
                var line = 0L
                while (start < r.items.size) {
                    out.add(Section(type, base + line, r, start = start))
                    start += cols
                    line++
                }
            }
            if (m.queue != null) out.add(Section(T_QUEUE, -12))
            if (m.calendar?.cells?.isNotEmpty() == true) out.add(Section(T_CALENDAR, -14))
            m.downloads?.let { d ->
                if (d.storage != null || d.notices.isNotEmpty() || d.jobs.isNotEmpty()) out.add(Section(T_DL_TOP, -15))
                d.groups.forEachIndexed { i, g -> out.add(Section(T_DL_GROUP, stableId("dl:" + g.key), start = i)) }
            }
            if (m.message != null) out.add(Section(T_MESSAGE, -10))
            if (m.rows.isEmpty() && m.message == null && m.empty != null) out.add(Section(T_EMPTY, -7))
            out.add(Section(T_END, -4))
            items = out
            // Text at the top (no hero, or a heading above it): keep it clear of the floating
            // Watch together and Back buttons. A heading with a picture behind it starts at the
            // very top itself.
            val top = when {
                m.detail != null -> 0
                // Nothing floats at the top (the search screen): its field starts right there.
                m.search?.big == true && m.back == null && !m.showTogether && m.header == null -> dp(4)
                m.header?.backdrop?.isNotEmpty() == true -> 0
                m.hero.isEmpty() || m.header != null -> dp(64)
                else -> 0
            }
            if (list.paddingTop != top) list.setPadding(0, top, 0, 0)
            notifyDataSetChanged()
            list.post { placeSearch() }
        }

        fun positionOf(type: Int): Int = items.indexOfFirst { it.type == type }

        override fun getItemCount() = items.size
        override fun getItemViewType(position: Int) = items[position].type
        override fun getItemId(position: Int) = items[position].id

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder = when (viewType) {
            T_HERO -> HeroHolder()
            T_TOOLS -> ToolsHolder()
            T_CW_EMPTY, T_EMPTY -> CwEmptyHolder()
            T_HEADER -> HeaderHolder()
            T_CHIPS -> ChipsHolder()
            T_ROW -> RowHolder()
            T_GAP -> SpacerHolder(dp(28))
            T_SEARCH -> SpacerHolder(dp(60))
            T_NOTE, T_GRID_TITLE -> NoteHolder()
            T_MESSAGE -> MessageHolder()
            T_GRID_POSTER -> GridLineHolder(C_POSTER)
            T_GRID_TILE -> GridLineHolder(C_TILE)
            T_GRID_CHANNEL -> GridLineHolder(C_CHANNEL)
            T_LIVEHERO -> LiveHeroHolder()
            T_DETAIL -> DetailHolder()
            T_EPISODE -> EpisodeHolder()
            T_LISTITEM -> ListItemHolder()
            T_QUEUE -> QueueHolder()
            T_WINNER -> WinnerHolder()
            T_ACTION -> ActionHolder()
            T_SOURCE -> SourceHolder()
            T_MATCH -> MatchHolder()
            T_VERSUS -> VersusHolder()
            T_PITCH -> PitchHolder()
            T_GUIDE_RULER -> GuideRulerHolder()
            T_GUIDE_ROW -> GuideRowHolder()
            T_CALBAR -> CalendarBarHolder()
            T_CALENDAR -> CalendarHolder()
            T_DL_TOP -> DownloadsTopHolder()
            T_DL_GROUP -> DownloadGroupHolder()
            T_PK_PICK -> PkPickHolder()
            T_PK_TIERS -> PkTiersHolder()
            T_PK_STREAM -> PkStreamHolder()
            T_PK_DRAWER -> PkDrawerHolder()
            T_PK_DIAG -> PkDiagHolder()
            T_PK_PANEL -> PkPanelHolder()
            T_PK_LOADER -> PkLoaderHolder()
            T_AD_CARD -> AdCardHolder()
            T_AD_TILES -> AdTilesHolder()
            T_AD_HERO -> AdHeroHolder()
            T_AD_COMM -> AdCommunityHolder()
            T_AD_HEAD -> AdHeadHolder()
            T_AD_CATS -> AdCatsHolder()
            T_AD_INST -> AdInstalledHolder()
            T_AD_DETAIL -> AdDetailHolder()
            T_AD_INFO -> AdInfoHolder()
            T_AD_DOC -> AdDocHolder()
            else -> SpacerHolder(dp(28))
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            val m = model ?: return
            when (holder) {
                is HeroHolder -> holder.bind(m)
                is ToolsHolder -> holder.bind(m)
                is CwEmptyHolder -> if (items[position].type == T_EMPTY) {
                    m.empty?.let { holder.bind(it.first, it.second) }
                } else {
                    m.cwEmpty?.let { holder.bind(it.first, it.second) }
                }
                is HeaderHolder -> m.header?.let { holder.bind(it) }
                is ChipsHolder -> m.chips.getOrNull(items[position].chipsIndex)?.let { holder.bind(it) }
                is RowHolder -> items[position].row?.let { holder.bind(it) }
                is NoteHolder -> if (items[position].type == T_NOTE) {
                    holder.bindNote(m.note ?: "")
                } else {
                    items[position].row?.let { r -> r.note?.takeIf { it.isNotBlank() }?.let { holder.bindNote(it) } ?: holder.bindTitle(r.title) }
                }
                is MessageHolder -> m.message?.let { holder.bind(it) }
                is GridLineHolder -> items[position].row?.let { holder.bind(it, items[position].start) }
                is DetailHolder -> m.detail?.let { holder.bind(it) }
                is QueueHolder -> m.queue?.let { holder.bind(it) }
                is LiveHeroHolder -> items[position].row?.let { holder.bind(it) }
                is CalendarBarHolder -> m.calendar?.let { holder.bind(it) }
                is CalendarHolder -> m.calendar?.let { holder.bind(it) }
                is DownloadsTopHolder -> m.downloads?.let { holder.bind(it) }
                is DownloadGroupHolder -> m.downloads?.groups?.getOrNull(items[position].start)?.let { holder.bind(it) }
                is EpisodeHolder -> items[position].row?.let { r -> r.items.getOrNull(items[position].start)?.let { holder.bind(r, items[position].start, it) } }
                is ListItemHolder -> items[position].row?.let { r -> r.items.getOrNull(items[position].start)?.let { holder.bind(r, items[position].start, it) } }
                is MatchHolder -> m.match?.let { holder.bind(it) }
                is GuideRulerHolder -> m.guide?.let { holder.bind(it) }
                is GuideRowHolder -> m.guide?.let { g -> g.channels.getOrNull(items[position].start)?.let { holder.bind(g, items[position].start, it) } }
                is VersusHolder -> items[position].row?.let { r -> r.items.getOrNull(items[position].start)?.let { holder.bind(r, items[position].start, it) } }
                is PitchHolder -> items[position].row?.let { holder.bind(it) }
                is SourceHolder -> items[position].row?.let { r -> r.items.getOrNull(items[position].start)?.let { holder.bind(r, items[position].start, it) } }
                is ActionHolder -> items[position].row?.let { r -> r.items.getOrNull(items[position].start)?.let { holder.bind(r, items[position].start, it) } }
                is WinnerHolder -> items[position].row?.let { r -> r.items.getOrNull(items[position].start)?.let { holder.bind(r, items[position].start, it) } }
                is PkPickHolder -> items[position].row?.let { r -> (r.pk as? PkPick)?.let { holder.bind(r, it) } }
                is PkTiersHolder -> items[position].row?.let { r -> (r.pk as? PkTiers)?.let { holder.bind(r, it) } }
                is PkDrawerHolder -> items[position].row?.let { r -> (r.pk as? PkDrawer)?.let { holder.bind(r, it) } }
                is PkDiagHolder -> items[position].row?.let { r -> (r.pk as? PkDiag)?.let { holder.bind(r, it) } }
                is PkPanelHolder -> items[position].row?.let { r -> (r.pk as? PkPanel)?.let { holder.bind(r, it) } }
                is PkLoaderHolder -> items[position].row?.let { r -> (r.pk as? PkLoader)?.let { holder.bind(it) } }
                is AdCardHolder -> items[position].row?.let { r -> (r.ad as? AdCard)?.let { holder.bind(r, it) } }
                is AdTilesHolder -> items[position].row?.let { r -> (r.ad as? AdTiles)?.let { holder.bind(r, it) } }
                is AdHeroHolder -> items[position].row?.let { r -> (r.ad as? AdHero)?.let { holder.bind(r, it) } }
                is AdCommunityHolder -> items[position].row?.let { r -> (r.ad as? AdCommunity)?.let { holder.bind(r, it) } }
                is AdHeadHolder -> items[position].row?.let { r -> (r.ad as? AdHead)?.let { holder.bind(r, it) } }
                is AdCatsHolder -> items[position].row?.let { r -> (r.ad as? AdCategories)?.let { holder.bind(r, it) } }
                is AdInstalledHolder -> items[position].row?.let { r -> (r.ad as? AdInstalled)?.let { holder.bind(r, it) } }
                is AdDetailHolder -> items[position].row?.let { r -> (r.ad as? AdDetail)?.let { holder.bind(r, it) } }
                is AdInfoHolder -> items[position].row?.let { r -> (r.ad as? AdInfo)?.let { holder.bind(r, it) } }
                is AdDocHolder -> items[position].row?.let { r -> (r.ad as? AdDoc)?.let { holder.bind(r, it) } }
                is PkStreamHolder -> items[position].row?.let { r ->
                    val list = (r.pk as? PkStreams)?.items ?: return@let
                    list.getOrNull(items[position].start)?.let { holder.bind(r, items[position].start, list.size, it) }
                }
            }
        }

        override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
            if (holder is RowHolder) holder.saveScroll()
        }
    }

    private inner class SpacerHolder(h: Int) : RecyclerView.ViewHolder(View(ctx).apply {
        layoutParams = RecyclerView.LayoutParams(MATCH, h)
    })

    /** "Customize home" under the hero (the editor itself is the page's). */
    /** "Customize" under the hero; while the editor is open: Done, Reset (and Add source on Home). */
    private inner class ToolsHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val bar = itemView as LinearLayout

        init {
            bar.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            bar.orientation = LinearLayout.HORIZONTAL
            bar.gravity = Gravity.END or Gravity.CENTER_VERTICAL
            bar.setPaddingRelative(gutter, dp(10), gutter, dp(14))
        }

        fun bind(m: HomeModel) {
            bar.removeAllViews()
            if (!m.edit) {
                bar.addView(pill(m.label("customize", "Customize home"), R.drawable.ic_pencil, primary = false) { act("customize") })
                return
            }
            if (m.addSource) bar.addView(pill(m.label("addSource", "Add Source"), R.drawable.ic_plus, primary = false) { act("addsource") })
            bar.addView(pill(m.label("reset", "Reset"), R.drawable.ic_rotate_ccw, primary = false) { act("reset") })
            bar.addView(pill(m.label("done", "Done editing"), R.drawable.ic_check, primary = true) { act("done") })
        }

        private fun pill(text: String, ic: Int, primary: Boolean, onTap: () -> Unit): View = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPaddingRelative(dp(12), 0, dp(14), 0)
            isClickable = true
            isFocusable = true
            setOnClickListener { onTap() }
            val fg = if (primary) colors.canvas else colors.muted
            addView(ImageView(ctx).apply { setImageDrawable(icon(ic, fg)) }, LinearLayout.LayoutParams(dp(15), dp(15)).apply { marginEnd = dp(8) })
            addView(label(text, 13f, bold = primary, lines = 1).apply { setTextColor(fg) })
            background = focusable(
                if (primary) rounded(colors.ink, dp(10).toFloat())
                else rounded(withAlpha(colors.surface, 0.9f), dp(10).toFloat(), dp(1), withAlpha(colors.ink, 0.08f)),
            )
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply { marginStart = dp(8) }
        }
    }

    private inner class CwEmptyHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val title = label("", 17f, bold = true)
        private val box = label("", 15f)

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPaddingRelative(gutter, dp(8), gutter, dp(24))
            col.addView(title, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })
            box.gravity = Gravity.CENTER
            box.setPadding(dp(20), dp(36), dp(20), dp(36))
            col.addView(box, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        fun bind(t: String?, text: String) {
            title.text = t ?: ""
            title.visibility = if (t.isNullOrBlank()) View.GONE else View.VISIBLE
            title.setTextColor(colors.ink)
            box.text = text
            box.setTextColor(colors.muted)
            val dash = withAlpha(colors.ink, 0.22f) // (inside apply, "colors" would be the drawable's own)
            box.background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(Color.TRANSPARENT)
                setStroke(dp(1), dash, dp(5).toFloat(), dp(4).toFloat())
            }
        }
    }

    /** A page's heading (Shows, Library): small kicker, big title, a line under it. */
    private inner class HeaderHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        /** A collection's backdrop behind it, darkened towards the text. */
        private val backdrop = NetImage(ctx)
        private val shadeUp = View(ctx)
        private val shadeSide = View(ctx)
        private val col = LinearLayout(ctx)
        private val kickerLine = LinearLayout(ctx)
        private val iconBox = FrameLayout(ctx)
        private val iconView = ImageView(ctx)
        private val kicker = label("", 11f, bold = true)
        private val titleLine = LinearLayout(ctx)
        private val logo = NetImage(ctx)
        private val title = label("", 30f, lines = 2)
        private val chevron = FrameLayout(ctx)
        private val chevronIcon = ImageView(ctx)
        private val count = label("", 14f, lines = 1)
        private val subtitle = label("", 14f, lines = 3)
        private val body = label("", 15f, lines = 3)
        private val photo = NetImage(ctx)
        private val badge = label("", 11f, bold = true, lines = 1)
        private var bodyKey = ""

        init {
            frame.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            backdrop.scaleType = ImageView.ScaleType.CENTER_CROP
            frame.addView(backdrop, FrameLayout.LayoutParams(MATCH, MATCH))
            frame.addView(shadeUp, FrameLayout.LayoutParams(MATCH, MATCH))
            frame.addView(shadeSide, FrameLayout.LayoutParams(MATCH, MATCH))
            col.orientation = LinearLayout.VERTICAL
            frame.addView(col, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))

            kickerLine.orientation = LinearLayout.HORIZONTAL
            kickerLine.gravity = Gravity.CENTER_VERTICAL
            iconBox.addView(iconView, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER))
            kickerLine.addView(iconBox, LinearLayout.LayoutParams(dp(36), dp(36)).apply { marginEnd = dp(10) })
            kickerLine.addView(kicker)
            badge.setPaddingRelative(dp(8), dp(2), dp(8), dp(2))
            badge.isClickable = true
            badge.isFocusable = true
            badge.setOnClickListener { act("chip", row = "badge", what = "badge") }
            kickerLine.addView(badge, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(12) })
            photo.scaleType = ImageView.ScaleType.CENTER_CROP
            photo.clipToOutline = true
            photo.outlineProvider = roundOutline(dp(16).toFloat())
            col.addView(photo, LinearLayout.LayoutParams(dp(200), dp(300)).apply { bottomMargin = dp(24) })
            col.addView(kickerLine)

            titleLine.orientation = LinearLayout.HORIZONTAL
            titleLine.gravity = Gravity.CENTER_VERTICAL
            title.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            titleLine.addView(logo, LinearLayout.LayoutParams(0, dp(56)))
            titleLine.addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            chevron.addView(chevronIcon, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
            titleLine.addView(chevron, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginStart = dp(12) })
            titleLine.addView(count, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(14) })
            col.addView(titleLine, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            subtitle.setLineSpacing(0f, 1.2f)
            col.addView(subtitle, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            body.setLineSpacing(0f, 1.25f)
            body.setOnClickListener {
                // A long biography: all of it on a tap, back to its first lines on another.
                if (!headerBodyOpen.add(bodyKey)) headerBodyOpen.remove(bodyKey)
                model?.header?.let { bind(it) }
            }
            col.addView(body, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
        }

        fun bind(h: HomeHeader) {
            val rtl = model?.rtl == true
            // A picture behind: it starts at the very top (the list has no top room then).
            val hasBackdrop = h.backdrop.isNotEmpty()
            col.setPaddingRelative(gutter, if (hasBackdrop) dp(150) else 0, gutter, dp(18))
            backdrop.visibility = if (hasBackdrop) View.VISIBLE else View.GONE
            shadeUp.visibility = backdrop.visibility
            shadeSide.visibility = backdrop.visibility
            if (hasBackdrop) {
                images.load(backdrop, h.backdrop, width(), dp(420))
                shadeUp.background = GradientDrawable(
                    GradientDrawable.Orientation.BOTTOM_TOP,
                    intArrayOf(colors.canvas, withAlpha(colors.canvas, 0.7f), withAlpha(colors.canvas, 0.1f)),
                )
                shadeSide.background = GradientDrawable(
                    if (rtl) GradientDrawable.Orientation.RIGHT_LEFT else GradientDrawable.Orientation.LEFT_RIGHT,
                    intArrayOf(withAlpha(colors.canvas, 0.9f), withAlpha(colors.canvas, 0.25f), Color.TRANSPARENT),
                )
            } else {
                images.clear(backdrop)
            }
            // A glow of the service's colour from the top (like the page's).
            val tint = h.tint
            frame.background = if (tint != null && !hasBackdrop) {
                GradientDrawable().apply {
                    gradientType = GradientDrawable.RADIAL_GRADIENT
                    gradientRadius = width() * 0.9f
                    setGradientCenter(if (rtl) 0.7f else 0.3f, 0f)
                    colors = intArrayOf(withAlpha(tint, 0.22f), Color.TRANSPARENT)
                }
            } else {
                null
            }

            val iconRes = when (h.icon) {
                "tag" -> R.drawable.ic_tag
                "calendar" -> R.drawable.ic_calendar
                "clock" -> R.drawable.ic_clock
                "globe" -> R.drawable.ic_globe
                "languages" -> R.drawable.ic_languages
                "building" -> R.drawable.ic_building_2
                "tv" -> R.drawable.ic_tv
                else -> 0
            }
            iconBox.visibility = if (iconRes != 0) View.VISIBLE else View.GONE
            if (iconRes != 0) {
                iconView.setImageDrawable(icon(iconRes, colors.muted))
                iconBox.background = rounded(withAlpha(colors.surface, 0.7f), dp(12).toFloat())
            }
            kicker.text = h.kicker?.let { if (rtl) it else it.uppercase() } ?: ""
            kicker.setTextColor(colors.subtle)
            // Arabic has no letter case and its letters must stay joined.
            kicker.letterSpacing = if (rtl) 0f else if (iconRes != 0) 0.22f else 0.28f
            kicker.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (iconRes != 0) 12.5f else 11f)
            kickerLine.visibility = if (h.kicker.isNullOrBlank() && iconRes == 0) View.GONE else View.VISIBLE

            // The title, or the service's logo in its place.
            val logoUrl = h.logo
            if (logoUrl != null) {
                val llp = logo.layoutParams as LinearLayout.LayoutParams
                val lw = (width() * 0.6f).toInt()
                if (llp.width != lw) {
                    llp.width = lw
                    logo.layoutParams = llp
                }
                logo.visibility = View.VISIBLE
                logo.scaleType = if (rtl) ImageView.ScaleType.FIT_END else ImageView.ScaleType.FIT_START
                images.load(logo, listOf(logoUrl), lw, dp(56), alpha = true) { ok ->
                    title.visibility = if (ok) View.GONE else View.VISIBLE
                }
            } else {
                logo.visibility = View.GONE
                images.clear(logo)
            }
            title.text = h.title
            title.visibility = if (h.title.isBlank() || logoUrl != null) View.GONE else View.VISIBLE
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, h.size ?: 30f)
            title.setTextColor(colors.ink)
            title.maxWidth = ((width() - 2 * gutter) * if (h.switch.isNotEmpty() || h.count != null) 0.72f else 1f).toInt()

            // A genre page: the title opens the other genres.
            val switching = h.switch.isNotEmpty()
            chevron.visibility = if (switching) View.VISIBLE else View.GONE
            if (switching) {
                chevronIcon.setImageDrawable(icon(R.drawable.ic_chevron_down, colors.muted))
                chevron.background = rounded(Color.TRANSPARENT, dp(20).toFloat(), dp(1), withAlpha(colors.ink, 0.12f))
            }
            titleLine.isClickable = switching
            titleLine.isFocusable = switching
            titleLine.setOnClickListener(if (switching) View.OnClickListener { pickSwitch(h) } else null)

            count.text = h.count ?: ""
            count.visibility = if (h.count.isNullOrBlank()) View.GONE else View.VISIBLE
            count.setTextColor(colors.subtle)
            subtitle.text = h.subtitle ?: ""
            subtitle.visibility = if (h.subtitle.isNullOrBlank()) View.GONE else View.VISIBLE
            subtitle.setTextColor(colors.muted)
            body.text = h.body ?: ""
            body.visibility = if (h.body.isNullOrBlank()) View.GONE else View.VISIBLE
            body.setTextColor(colors.muted)
            bodyKey = h.title
            val open = bodyKey in headerBodyOpen
            body.maxLines = if (open) Int.MAX_VALUE else h.bodyLines
            body.ellipsize = if (open) null else TextUtils.TruncateAt.END

            photo.visibility = if (h.photo != null) View.VISIBLE else View.GONE
            if (h.photo != null) {
                photo.background = rounded(plate(h.title), dp(16).toFloat())
                images.load(photo, listOf(h.photo), dp(200), dp(300))
            } else {
                images.clear(photo)
            }
            badge.text = h.badge?.let { if (rtl) it else it.uppercase() } ?: ""
            badge.visibility = if (h.badge.isNullOrBlank()) View.GONE else View.VISIBLE
            badge.letterSpacing = if (rtl) 0f else 0.14f
            badge.setTextColor(colors.accent)
            badge.background = rounded(withAlpha(colors.accent, 0.1f), dp(6).toFloat(), dp(1), withAlpha(colors.accent, 0.3f))
            if (!h.badge.isNullOrBlank()) kickerLine.visibility = View.VISIBLE
        }

        /** The other genres, to switch to one. */
        private fun pickSwitch(h: HomeHeader) {
            val names = h.switch.map { it.label }.toTypedArray()
            val on = h.switch.indexOfFirst { it.on }
            try {
                android.app.AlertDialog.Builder(ctx)
                    .setSingleChoiceItems(names, on) { d, i ->
                        d.dismiss()
                        h.switch.getOrNull(i)?.let { act("chip", row = "switch", what = it.id) }
                    }
                    .show()
            } catch (_: Exception) {
            }
        }
    }

    /** A row of choices (Library tab, type, sort); the chosen one is filled. Scrolls sideways. */
    private inner class ChipsHolder : RecyclerView.ViewHolder(android.widget.HorizontalScrollView(ctx)) {
        private val scroller = itemView as android.widget.HorizontalScrollView
        private val strip = LinearLayout(ctx)

        init {
            scroller.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            scroller.isHorizontalScrollBarEnabled = false
            scroller.overScrollMode = View.OVER_SCROLL_NEVER
            scroller.clipToPadding = false
            strip.orientation = LinearLayout.HORIZONTAL
            strip.setPaddingRelative(gutter, dp(2), gutter, dp(12))
            scroller.addView(strip)
        }

        fun bind(g: HomeChips) {
            strip.removeAllViews()
            for (c in g.items) {
                val chip = label(c.label, 13f, bold = c.on, lines = 1).apply {
                    gravity = Gravity.CENTER
                    setPaddingRelative(dp(14), 0, dp(14), 0)
                    isClickable = true
                    isFocusable = true
                    setTextColor(if (c.on) colors.canvas else colors.muted)
                    background = focusable(
                        if (c.on) rounded(colors.ink, dp(18).toFloat())
                        else rounded(withAlpha(colors.surface, 0.9f), dp(18).toFloat(), dp(1), withAlpha(colors.ink, 0.1f)),
                    )
                    setOnClickListener { act("chip", row = g.key, what = c.id) }
                }
                strip.addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply { marginEnd = dp(8) })
            }
        }
    }

    /** A line of small text (a note over the rows), or a grid's title in small capitals. */
    private inner class NoteHolder : RecyclerView.ViewHolder(TextView(ctx)) {
        private val text = itemView as TextView

        init {
            text.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            text.textAlignment = View.TEXT_ALIGNMENT_VIEW_START
        }

        fun bindNote(s: String) {
            text.text = s
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            text.typeface = Typeface.DEFAULT
            text.letterSpacing = 0f
            text.setTextColor(colors.muted)
            text.setPaddingRelative(dp(16), 0, dp(16), dp(16))
        }

        fun bindTitle(s: String) {
            val rtl = model?.rtl == true
            text.text = if (rtl) s else s.uppercase()
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            text.typeface = Typeface.DEFAULT_BOLD
            text.letterSpacing = if (rtl) 0f else 0.2f
            text.setTextColor(colors.subtle)
            text.setPaddingRelative(dp(16), dp(4), dp(16), dp(14))
        }
    }

    /** A centred message (no search results…) with an optional button. */
    private inner class MessageHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val title = label("", 15f, bold = true)
        private val text = label("", 13f)
        private val button = label("", 13.5f, bold = true, lines = 1)

        init {
            col.orientation = LinearLayout.VERTICAL
            col.gravity = Gravity.CENTER_HORIZONTAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPadding(dp(24), dp(48), dp(24), dp(48))
            for (v in listOf(title, text)) {
                v.gravity = Gravity.CENTER
                v.textAlignment = View.TEXT_ALIGNMENT_CENTER
            }
            col.addView(title, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
            col.addView(text, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
            button.gravity = Gravity.CENTER
            button.setPaddingRelative(dp(16), 0, dp(16), 0)
            button.isClickable = true
            button.isFocusable = true
            button.setOnClickListener { act("message") }
            col.addView(button, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)).apply { topMargin = dp(16) })
        }

        fun bind(g: HomeMessage) {
            title.text = g.title ?: ""
            title.visibility = if (g.title.isNullOrBlank()) View.GONE else View.VISIBLE
            title.setTextColor(colors.ink)
            text.text = g.text ?: ""
            text.visibility = if (g.text.isNullOrBlank()) View.GONE else View.VISIBLE
            text.setTextColor(colors.subtle)
            button.text = g.action ?: ""
            button.visibility = if (g.action.isNullOrBlank()) View.GONE else View.VISIBLE
            button.setTextColor(colors.ink)
            button.background = focusable(rounded(colors.surface, dp(20).toFloat(), dp(1), withAlpha(colors.ink, 0.1f)))
        }
    }

    /** One line of a grid: as many cards across as fit, the same cards as the rows'. */
    private inner class GridLineHolder(private val cardKind: Int) : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val line = itemView as LinearLayout
        private val cells = ArrayList<CardHolder>()

        init {
            line.orientation = LinearLayout.HORIZONTAL
            line.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            line.setPaddingRelative(dp(16), 0, dp(16), if (cardKind == C_POSTER) dp(22) else dp(16))
        }

        fun bind(row: HomeRow, start: Int) {
            val cols = gridCols(row)
            val gapX = dp(16)
            val w = (width() - 2 * dp(16) - (cols - 1) * gapX) / cols
            while (cells.size < cols) {
                val h = CardHolder(cardKind)
                cells.add(h)
                line.addView(h.itemView)
            }
            while (cells.size > cols) {
                line.removeViewAt(cells.size - 1)
                cells.removeAt(cells.size - 1)
            }
            for (i in 0 until cols) {
                val h = cells[i]
                val idx = start + i
                h.itemView.layoutParams = LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    marginEnd = if (i < cols - 1) gapX else 0
                }
                if (idx < row.items.size) {
                    h.fixedPos = idx
                    h.fixedWidth = w
                    h.itemView.visibility = View.VISIBLE
                    h.bind(row, row.items[idx])
                } else {
                    h.itemView.visibility = View.INVISIBLE
                    images.clear(h.image)
                }
            }
            // Near the end: the next page (once per length, like the rows).
            if (row.more && start + cols * 4 >= row.items.size && askedMore[row.key] != row.items.size) {
                askedMore[row.key] = row.items.size
                act("more", row = row.key)
            }
        }
    }

    /** A person: a round photo (their initial until it comes), the name, what they're known for. */
    private fun personChip(name: String, image: String?, sub: String?, onTap: () -> Unit): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        isClickable = true
        isFocusable = true
        contentDescription = name
        setOnClickListener { onTap() }
        val face = FrameLayout(ctx).apply {
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) = outline.setOval(0, 0, view.width, view.height)
            }
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL }.also {
                it.setColor(withAlpha(colors.surface, 0.9f))
                it.setStroke(dp(1), withAlpha(colors.ink, 0.12f))
            }
        }
        val initial = label(name.take(1), 18f, lines = 1).apply {
            gravity = Gravity.CENTER
            setTextColor(colors.subtle)
        }
        face.addView(initial, FrameLayout.LayoutParams(MATCH, MATCH))
        if (image != null) {
            val img = NetImage(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            face.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
            images.load(img, listOf(image), dp(84), dp(84)) { ok -> initial.visibility = if (ok) View.GONE else View.VISIBLE }
        }
        addView(face, LinearLayout.LayoutParams(dp(84), dp(84)))
        addView(label(name, 13f, bold = true, lines = 2).apply {
            gravity = Gravity.CENTER
            textAlignment = View.TEXT_ALIGNMENT_CENTER
            setTextColor(colors.ink)
        }, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
        if (!sub.isNullOrBlank()) {
            addView(label(sub, 11.5f, lines = 1).apply {
                gravity = Gravity.CENTER
                textAlignment = View.TEXT_ALIGNMENT_CENTER
                setTextColor(colors.subtle)
            }, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) })
        }
        layoutParams = LinearLayout.LayoutParams(dp(100), ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(10) }
    }

    /** A title in a list (search results): its small poster, the name, the line under it. */
    private inner class ListItemHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val line = itemView as LinearLayout
        private val thumb = FrameLayout(ctx)
        val image = NetImage(ctx)
        private val title = label("", 16f, bold = true, lines = 1)
        private val sub = label("", 12.5f, lines = 1)
        private var rowKey = ""
        private var index = -1

        init {
            line.orientation = LinearLayout.HORIZONTAL
            line.gravity = Gravity.CENTER_VERTICAL
            line.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            line.setPaddingRelative(dp(16), dp(8), dp(16), dp(8))
            line.isClickable = true
            line.isFocusable = true
            line.setOnClickListener { act("open", row = rowKey, i = index) }
            line.setOnLongClickListener {
                act("hold", row = rowKey, i = index)
                true
            }
            thumb.clipToOutline = true
            thumb.outlineProvider = roundOutline(dp(12).toFloat())
            image.scaleType = ImageView.ScaleType.CENTER_CROP
            thumb.addView(image, FrameLayout.LayoutParams(MATCH, MATCH))
            line.addView(thumb, LinearLayout.LayoutParams(dp(64), dp(96)))
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(title)
            texts.addView(sub, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            line.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(16) })
        }

        fun bind(r: HomeRow, i: Int, c: HomeCard) {
            rowKey = r.key
            index = i
            line.contentDescription = c.title
            thumb.background = rounded(plate(c.title), dp(12).toFloat())
            images.load(image, c.images, dp(64), dp(96))
            title.text = c.title
            title.setTextColor(colors.ink)
            sub.text = c.sub ?: ""
            sub.visibility = if (c.sub.isNullOrBlank()) View.GONE else View.VISIBLE
            sub.setTextColor(colors.muted)
        }
    }

    /**
     * A winner in an award's category, as the page lists them: the year in the award's colour
     * ([HomeCard.sub], [HomeCard.tint]), the title (a tap opens it), a faint line under it.
     */
    private inner class WinnerHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val line = LinearLayout(ctx)
        private val year = label("", 14f, bold = true, lines = 1)
        private val title = label("", 14f, lines = 2)
        /** Who won it (an award's recipients), under the title. */
        private val desc = label("", 13f, lines = 2)
        /** The faint line under it (the page's border). */
        private val rule = View(ctx)
        private var rowKey = ""
        private var index = -1

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPaddingRelative(gutter, 0, gutter, 0)
            col.isClickable = true
            col.isFocusable = true
            col.setOnClickListener { act("open", row = rowKey, i = index) }
            line.orientation = LinearLayout.HORIZONTAL
            line.gravity = Gravity.CENTER_VERTICAL
            line.minimumHeight = dp(44)
            line.setPadding(0, dp(10), 0, dp(10))
            year.fontFeatureSettings = "tnum"
            line.addView(year, LinearLayout.LayoutParams(dp(56), ViewGroup.LayoutParams.WRAP_CONTENT))
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(title)
            texts.addView(desc, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(3) })
            line.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(16) })
            col.setOnLongClickListener {
                act("hold", row = rowKey, i = index)
                true
            }
            col.addView(line, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
            col.addView(rule, LinearLayout.LayoutParams(MATCH, dp(1)))
        }

        fun bind(r: HomeRow, i: Int, c: HomeCard) {
            rowKey = r.key
            index = i
            col.contentDescription = listOfNotNull(c.sub, c.title).joinToString(" ")
            col.background = focusable(rounded(Color.TRANSPARENT, dp(8).toFloat()))
            rule.setBackgroundColor(withAlpha(colors.ink, 0.06f))
            year.text = c.sub ?: ""
            year.setTextColor(c.tint ?: colors.accent)
            title.text = c.title
            title.setTextColor(colors.ink)
            desc.text = c.desc ?: ""
            desc.visibility = if (c.desc.isNullOrBlank()) View.GONE else View.VISIBLE
            desc.setTextColor(colors.muted)
        }
    }

    /**
     * A card that does one thing, as the search page draws them: a round icon, a small label in
     * the accent colour, the title, a line under it, and a button at the end (Play) or a spinner.
     * A tap on the card sends {a:"open"}, on its button {a:"play"}.
     */
    private inner class ActionHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val card = itemView as LinearLayout
        private val iconBox = FrameLayout(ctx)
        private val iconView = ImageView(ctx)
        private val kicker = label("", 11f, bold = true, lines = 1)
        private val title = label("", 15f, bold = true, lines = 1)
        private val sub = label("", 12.5f, lines = 2)
        private val button = LinearLayout(ctx)
        private val buttonIcon = ImageView(ctx)
        private val buttonText = label("", 15f, bold = true, lines = 1)
        private val spinner = android.widget.ProgressBar(ctx).apply { isIndeterminate = true }
        private var rowKey = ""
        private var index = -1

        init {
            card.orientation = LinearLayout.HORIZONTAL
            card.gravity = Gravity.CENTER_VERTICAL
            card.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = gutter
                marginEnd = gutter
                bottomMargin = dp(20)
            }
            card.minimumHeight = dp(56)
            card.setPaddingRelative(dp(20), dp(12), dp(16), dp(12))
            card.isClickable = true
            card.isFocusable = true
            card.setOnClickListener { act("open", row = rowKey, i = index) }
            iconBox.addView(iconView, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
            card.addView(iconBox, LinearLayout.LayoutParams(dp(40), dp(40)))
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(kicker)
            texts.addView(title, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) })
            texts.addView(sub, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) })
            card.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(14); marginEnd = dp(12) })
            button.orientation = LinearLayout.HORIZONTAL
            button.gravity = Gravity.CENTER
            button.setPaddingRelative(dp(20), 0, dp(22), 0)
            button.isClickable = true
            button.isFocusable = true
            button.setOnClickListener { act("play", row = rowKey, i = index) }
            button.addView(buttonIcon, LinearLayout.LayoutParams(dp(17), dp(17)).apply { marginEnd = dp(8) })
            button.addView(buttonText)
            card.addView(button, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)))
            card.addView(spinner, LinearLayout.LayoutParams(dp(20), dp(20)))
        }

        fun bind(r: HomeRow, i: Int, c: HomeCard) {
            rowKey = r.key
            index = i
            val rtl = model?.rtl == true
            val tone = c.tone ?: "accent"
            val toneColor = when (tone) {
                "danger" -> 0xFFE5484D.toInt()
                "plain" -> colors.ink
                else -> colors.accent
            }
            card.background = focusable(
                when (tone) {
                    "plain" -> rounded(withAlpha(colors.surface, 0.4f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
                    else -> rounded(withAlpha(toneColor, 0.1f), dp(16).toFloat(), dp(1), withAlpha(toneColor, 0.4f))
                },
            )
            card.contentDescription = listOfNotNull(c.kicker, c.title).joinToString(" ")
            val res = when (c.icon) {
                "magnet" -> R.drawable.ic_magnet
                "link" -> R.drawable.ic_link_2
                "alert" -> R.drawable.ic_circle_alert
                "sparkles" -> R.drawable.ic_sparkles
                "calendar" -> R.drawable.ic_calendar
                "tag" -> R.drawable.ic_tag
                "crown" -> R.drawable.ic_crown
                "download" -> R.drawable.ic_download
                else -> 0
            }
            iconBox.visibility = if (res != 0) View.VISIBLE else View.GONE
            if (res != 0) {
                iconView.setImageDrawable(icon(res, if (tone == "plain") colors.subtle else toneColor))
                val disc = if (tone == "plain") withAlpha(colors.ink, 0.06f) else withAlpha(toneColor, 0.2f)
                iconBox.background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(disc)
                }
            }
            kicker.text = c.kicker?.let { if (rtl) it else it.uppercase() } ?: ""
            kicker.visibility = if (c.kicker.isNullOrBlank()) View.GONE else View.VISIBLE
            kicker.letterSpacing = if (rtl) 0f else 0.18f
            kicker.setTextColor(if (tone == "danger") colors.ink else colors.accent)
            title.text = c.title
            title.visibility = if (c.title.isBlank()) View.GONE else View.VISIBLE
            title.setTextColor(colors.ink)
            title.setTypeface(null, if (c.kicker.isNullOrBlank() && tone == "plain") Typeface.NORMAL else Typeface.BOLD)
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (c.kicker.isNullOrBlank() && tone == "plain") 14f else 15f)
            sub.text = c.sub ?: ""
            sub.visibility = if (c.sub.isNullOrBlank()) View.GONE else View.VISIBLE
            sub.setTextColor(if (tone == "danger") colors.muted else colors.subtle)
            button.visibility = if (c.button != null) View.VISIBLE else View.GONE
            button.isEnabled = !c.busy
            button.alpha = if (c.busy) 0.6f else 1f
            button.background = focusable(rounded(colors.ink, dp(22).toFloat()))
            buttonIcon.setImageDrawable(icon(R.drawable.ic_play, colors.canvas))
            buttonIcon.visibility = if (c.busy) View.GONE else View.VISIBLE
            buttonText.text = c.button ?: ""
            buttonText.setTextColor(colors.canvas)
            spinner.visibility = if (c.busy && c.button == null) View.VISIBLE else View.GONE
            spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(colors.muted)
        }
    }

    /**
     * A source to play, as the page lists them (Stremio style): the addon's round logo (or its
     * initial), the source's name, its description, its format labels, "Unavailable" when it
     * failed, and the round Play button. A tap anywhere plays it.
     * Card: title = name, desc = description, images = the addon's logo, kicker = the addon's
     * name, tags = labels, sub = the failure line, tone "danger" = failed.
     */
    private inner class SourceHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val card = itemView as LinearLayout
        private val logoBox = FrameLayout(ctx)
        private val logo = NetImage(ctx)
        private val initial = label("", 13f, bold = true, lines = 1)
        private val title = label("", 14.5f, bold = true, lines = 3)
        private val desc = label("", 12.5f, lines = 4)
        private val tags = FlowRow(ctx, dp(6), dp(6))
        private val failed = label("", 13f, lines = 2)
        private val play = FrameLayout(ctx)
        private var rowKey = ""
        private var index = -1

        init {
            card.orientation = LinearLayout.HORIZONTAL
            card.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(16)
                marginEnd = dp(16)
                bottomMargin = dp(8)
            }
            card.setPadding(dp(14), dp(14), dp(14), dp(14))
            card.isClickable = true
            card.isFocusable = true
            card.setOnClickListener { act("open", row = rowKey, i = index) }
            logoBox.clipToOutline = true
            logoBox.outlineProvider = roundOutline(dp(18).toFloat())
            logo.scaleType = ImageView.ScaleType.CENTER_CROP
            logoBox.addView(initial, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
            logoBox.addView(logo, FrameLayout.LayoutParams(MATCH, MATCH))
            card.addView(logoBox, LinearLayout.LayoutParams(dp(36), dp(36)))
            val mid = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            title.setLineSpacing(0f, 1.15f)
            mid.addView(title)
            desc.setLineSpacing(0f, 1.2f)
            mid.addView(desc, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            mid.addView(tags, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            mid.addView(failed, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            card.addView(mid, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(12); marginEnd = dp(12) })
            play.isClickable = true
            play.isFocusable = true
            play.setOnClickListener { act("open", row = rowKey, i = index) }
            play.addView(ImageView(ctx).apply { tag = "ic" }, FrameLayout.LayoutParams(dp(19), dp(19), Gravity.CENTER))
            card.addView(play, LinearLayout.LayoutParams(dp(44), dp(44)).apply { gravity = Gravity.CENTER_VERTICAL })
        }

        fun bind(r: HomeRow, i: Int, c: HomeCard) {
            rowKey = r.key
            index = i
            val bad = c.tone == "danger"
            card.contentDescription = c.title
            card.background = focusable(
                rounded(
                    if (bad) withAlpha(0xFFE5484D.toInt(), 0.05f) else withAlpha(colors.surface, 0.4f),
                    dp(16).toFloat(),
                    dp(1),
                    if (bad) withAlpha(0xFFE5484D.toInt(), 0.4f) else withAlpha(colors.ink, 0.08f),
                ),
            )
            logoBox.background = rounded(colors.surface, dp(18).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            initial.text = (c.kicker ?: c.title).trim().take(1).uppercase()
            initial.setTextColor(colors.muted)
            if (c.images.isNotEmpty()) {
                logo.visibility = View.VISIBLE
                images.load(logo, c.images, dp(36), dp(36)) { ok -> logo.visibility = if (ok) View.VISIBLE else View.GONE }
            } else {
                images.clear(logo)
                logo.visibility = View.GONE
            }
            title.text = c.title
            title.setTextColor(colors.ink)
            desc.text = c.desc ?: ""
            desc.visibility = if (c.desc.isNullOrBlank()) View.GONE else View.VISIBLE
            desc.setTextColor(colors.muted)
            tags.removeAllViews()
            for (tg in c.tags) {
                tags.addView(label(tg, 10.5f, bold = true, lines = 1).apply {
                    setTextColor(colors.ink)
                    setPaddingRelative(dp(7), dp(2), dp(7), dp(2))
                    background = rounded(withAlpha(colors.canvas, 0.6f), dp(5).toFloat(), dp(1), withAlpha(colors.ink, 0.14f))
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                })
            }
            tags.visibility = if (c.tags.isEmpty()) View.GONE else View.VISIBLE
            failed.text = c.sub ?: ""
            failed.visibility = if (bad && !c.sub.isNullOrBlank()) View.VISIBLE else View.GONE
            failed.setTextColor(0xFFE5484D.toInt())
            play.background = focusable(GradientDrawable().also { it.shape = GradientDrawable.OVAL; it.setColor(colors.accent) })
            play.contentDescription = model?.label("play", "Play")
            play.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(R.drawable.ic_play, colors.canvas))
        }
    }

    // ---- The play picker's other layout (its big card, qualities, every source, messages) -----

    /** Empties a container its holder redraws, letting go of the pictures its old views waited for. */
    private fun ViewGroup.dropAll() {
        images.release(this)
        removeAllViews()
    }

    private val pkGreen = 0xFF6EE7B7.toInt()
    private val pkDanger = 0xFFE5484D.toInt()
    private val pkAmber100 = 0xFFFEF3C7.toInt()
    private val pkAmber200 = 0xFFFDE68A.toInt()
    private val pkAmber300 = 0xFFFCD34D.toInt()
    private val wrap = ViewGroup.LayoutParams.WRAP_CONTENT

    private fun pkTone(tone: String): Int = when (tone) {
        "accent" -> colors.accent
        "green" -> pkGreen
        "subtle" -> colors.subtle
        "danger" -> pkDanger
        "ink" -> colors.ink
        else -> colors.muted
    }

    private fun pkIconRes(name: String?): Int = when (name) {
        "zap", "zap-line" -> R.drawable.ic_zap
        "check" -> R.drawable.ic_check
        "download" -> R.drawable.ic_download
        "external" -> R.drawable.ic_external_link
        "play" -> R.drawable.ic_play
        "radio" -> R.drawable.ic_radio
        "x" -> R.drawable.ic_x
        "arrow" -> R.drawable.ic_arrow_right
        "lang" -> R.drawable.ic_languages
        "users" -> R.drawable.ic_users
        "crown" -> R.drawable.ic_crown
        "copy" -> R.drawable.ic_copy
        "info" -> R.drawable.ic_info
        "settings" -> R.drawable.ic_settings_2
        "plus" -> R.drawable.ic_plus
        "trash" -> R.drawable.ic_trash_2
        "star" -> R.drawable.ic_star
        "eye" -> R.drawable.ic_eye
        "eye-off" -> R.drawable.ic_eye_off
        "link" -> R.drawable.ic_link_2
        else -> 0
    }

    /** The page's small capitals with their letter spacing (Arabic has neither). */
    private fun caps(t: TextView, text: String, spacing: Float) {
        val rtl = model?.rtl == true
        t.text = if (rtl) text else text.uppercase()
        t.letterSpacing = if (rtl) 0f else spacing
    }

    private fun mono(t: TextView) {
        t.typeface = Typeface.MONOSPACE
    }

    /** A format badge: its picture [b.w] dp wide (as tall as its shape, at most [maxH] dp), or its name. */
    private fun pkBadge(b: PkBadge, maxH: Float): View {
        val box = FrameLayout(ctx)
        val d = ctx.resources.displayMetrics.density
        val w = (b.w * d).toInt()
        // The page's badges are at most about as tall as they are wide (the size's height scales with it).
        val maxPx = (max(maxH, b.w * 0.94f) * d).toInt()
        val text = label(b.label, 10.5f, bold = true, lines = 1).apply {
            setTextColor(colors.ink)
            setPaddingRelative(dp(6), dp(2), dp(6), dp(2))
            background = rounded(withAlpha(colors.canvas, 0.6f), dp(5).toFloat(), dp(1), withAlpha(colors.ink, 0.14f))
        }
        box.addView(text, FrameLayout.LayoutParams(wrap, wrap, Gravity.CENTER_VERTICAL))
        val src = b.src ?: return box
        val img = NetImage(ctx)
        img.scaleType = ImageView.ScaleType.FIT_CENTER
        img.visibility = View.INVISIBLE
        box.addView(img, FrameLayout.LayoutParams(w, min(maxPx, w)))
        images.load(img, listOf(src), w, maxPx, alpha = true) { ok ->
            if (!ok) {
                box.removeView(img)
                return@load
            }
            val dr = img.drawable
            val h = if (dr != null && dr.intrinsicWidth > 0) min(maxPx, (w * dr.intrinsicHeight.toFloat() / dr.intrinsicWidth).toInt()) else maxPx
            img.layoutParams = FrameLayout.LayoutParams(w, max(h, dp(8)))
            img.visibility = View.VISIBLE
            text.visibility = View.GONE
        }
        return box
    }

    /** An audio language: its flag (an emoji) and, when [named], its name; "Multi" as a pill. */
    private fun pkFlag(f: PkFlag, big: Boolean, named: Boolean): View {
        if (f.emoji == null) {
            val multi = f.multi
            return label(if (named || multi) f.label else f.label.take(2), if (big) 11f else 9.5f, bold = true, lines = 1).apply {
                if (!model!!.rtl) {
                    text = text.toString().uppercase()
                    letterSpacing = 0.16f
                }
                setTextColor(if (multi) colors.accent else colors.subtle)
                setPaddingRelative(dp(5), dp(1), dp(5), dp(1))
                background = if (multi) rounded(withAlpha(colors.accent, 0.15f), dp(3).toFloat(), dp(1), withAlpha(colors.accent, 0.35f))
                else if (named) null else rounded(withAlpha(colors.canvas, 0.7f), dp(3).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            }
        }
        val line = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        line.addView(label(f.emoji, if (big) 19f else 14f, lines = 1).apply { includeFontPadding = false })
        if (named) {
            line.addView(label(f.label, if (big) 15f else 13f, bold = true, lines = 1).apply { setTextColor(colors.muted) },
                LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(6) })
        }
        return line
    }

    /** A coloured line with its icon (cached, queued, in your library…). */
    private fun pkStatusView(s: PkStatus, size: Float, spacing: Float): View {
        val c = pkTone(s.tone)
        val line = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val res = pkIconRes(s.icon)
        if (res != 0) line.addView(ImageView(ctx).apply { setImageDrawable(icon(res, c)) }, LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(5) })
        line.addView(label("", size, bold = true, lines = 1).apply {
            if (s.upper) caps(this, s.text, spacing) else {
                text = s.text
                letterSpacing = if (model?.rtl == true) 0f else spacing
            }
            setTextColor(c)
        })
        return line
    }

    /** A small pill: REMUX, a release group, an edition, "Same file as host". */
    private fun pkTagView(t: PkTag): View = label("", 10.5f, bold = true, lines = 1).apply {
        caps(this, t.text, 0.14f)
        setPaddingRelative(dp(9), dp(4), dp(9), dp(4))
        when (t.style) {
            "remux" -> {
                setTextColor(colors.ink)
                background = rounded(withAlpha(colors.canvas, 0.95f), dp(13).toFloat(), dp(1), withAlpha(colors.ink, 0.16f))
            }
            "group" -> {
                setTextColor(colors.muted)
                background = rounded(withAlpha(colors.canvas, 0.45f), dp(13).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            }
            "accent" -> {
                setTextColor(colors.accent)
                background = rounded(withAlpha(colors.accent, 0.15f), dp(6).toFloat(), dp(1), withAlpha(colors.accent, 0.3f))
            }
            "danger" -> {
                setTextColor(pkDanger)
                background = rounded(withAlpha(pkDanger, 0.2f), dp(13).toFloat(), dp(1), withAlpha(pkDanger, 0.4f))
            }
            else -> {
                setTextColor(colors.muted)
                background = rounded(withAlpha(colors.surface, 0.9f), dp(6).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            }
        }
    }

    /** A round-ended button in one of the page's looks; [onTap] does what it says. */
    private fun pkButtonView(b: PkButton, height: Int, radius: Float, onTap: () -> Unit): View {
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPaddingRelative(dp(24), 0, dp(26), 0)
            minimumHeight = height
        }
        val (bg, fg) = when (b.style) {
            "accent" -> Pair(rounded(colors.accent, radius), colors.canvas)
            "outline" -> Pair(rounded(withAlpha(colors.ink, 0.04f), radius, dp(1), withAlpha(colors.ink, 0.3f)), colors.ink)
            "green" -> Pair(rounded(withAlpha(pkGreen, 0.15f), radius, dp(1), withAlpha(pkGreen, 0.4f)), pkGreen)
            "cache" -> Pair(rounded(withAlpha(colors.accent, 0.12f), radius, dp(1), withAlpha(colors.accent, 0.55f)), colors.accent)
            "off" -> Pair(rounded(withAlpha(colors.canvas, 0.6f), radius, dp(1), withAlpha(colors.ink, 0.08f)), colors.subtle)
            "white" -> Pair(rounded(Color.WHITE, radius), Color.BLACK)
            "glass" -> Pair(rounded(withAlpha(Color.WHITE, 0.05f), radius, dp(1), withAlpha(Color.WHITE, 0.15f)), withAlpha(Color.WHITE, 0.75f))
            "secondary" -> Pair(rounded(colors.surface, radius, dp(1), withAlpha(colors.ink, 0.08f)), colors.ink)
            "amber" -> Pair(rounded(withAlpha(pkAmber300, 0.1f), radius, dp(1), withAlpha(pkAmber300, 0.4f)), pkAmber100)
            "installed" -> Pair(rounded(withAlpha(colors.surface, 0.7f), radius, dp(1), withAlpha(colors.ink, 0.08f)), colors.ink)
            "danger" -> Pair(rounded(withAlpha(pkDanger, 0.15f), radius, dp(1), withAlpha(pkDanger, 0.3f)), pkDanger)
            "soft" -> Pair(rounded(Color.TRANSPARENT, radius, dp(1), withAlpha(colors.ink, 0.1f)), colors.muted)
            "rate" -> Pair(rounded(withAlpha(colors.accent, 0.12f), radius, dp(1), withAlpha(colors.accent, 0.4f)), colors.accent)
            "accentpill" -> Pair(rounded(withAlpha(colors.accent, 0.15f), radius), colors.accent)
            "raised" -> Pair(rounded(toward(colors.surface, colors.ink, 0.05f), radius, dp(1), withAlpha(colors.ink, 0.08f)), colors.muted)
            "busy" -> Pair(rounded(withAlpha(colors.ink, 0.8f), radius), colors.canvas)
            "link" -> Pair(null, colors.subtle)
            else -> Pair(rounded(colors.ink, radius), colors.canvas)
        }
        box.background = if (bg != null) focusable(bg) else null
        val res = pkIconRes(b.icon)
        if (b.busy) {
            box.addView(android.widget.ProgressBar(ctx).apply {
                isIndeterminate = true
                indeterminateTintList = android.content.res.ColorStateList.valueOf(fg)
            }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(10) })
        } else if (res != 0 && b.icon != "arrow") {
            // An installed addon's check is in the accent colour, its text not.
            val tint = if (b.style == "installed" && b.icon == "check") colors.accent else fg
            val sz = if (height < dp(40)) dp(14) else dp(18)
            box.addView(ImageView(ctx).apply { setImageDrawable(icon(res, tint)) }, LinearLayout.LayoutParams(sz, sz).apply { marginEnd = if (height < dp(40)) dp(6) else dp(10) })
        }
        box.addView(label(b.label, if (b.style == "link") 13f else if (height < dp(34)) 12f else if (height < dp(46)) 13.5f else 14.5f, bold = b.style != "link", lines = 1).apply { setTextColor(fg) })
        if (b.icon == "arrow") {
            box.addView(ImageView(ctx).apply {
                setImageDrawable(icon(res, fg))
                scaleX = if (model?.rtl == true) -1f else 1f
            }, LinearLayout.LayoutParams(dp(14), dp(14)).apply { marginStart = dp(6) })
        }
        val enabled = b.style != "off" && b.style != "green" && b.style != "busy" && b.style != "accentpill" && !b.busy
        box.isClickable = enabled
        box.isFocusable = enabled
        box.alpha = if (b.busy) 0.6f else 1f
        if (enabled) box.setOnClickListener {
            b.copy?.let { copyLink(it, toast = false) }
            onTap()
        }
        box.contentDescription = b.label
        return box
    }

    /** An addon's round logo (or its initial on a plate), [size] dp across. */
    private fun pkLogoView(l: PkLogo, size: Int, ring: Int = 0): View {
        val box = FrameLayout(ctx)
        box.clipToOutline = true
        box.outlineProvider = roundOutline(dp(size).toFloat() / 2f)
        box.background = rounded(colors.surface, dp(size).toFloat() / 2f, ring, colors.canvas)
        box.addView(label(l.initial.take(1).uppercase(), size * 0.45f, bold = true, lines = 1).apply { setTextColor(colors.muted) },
            FrameLayout.LayoutParams(wrap, wrap, Gravity.CENTER))
        if (l.images.isNotEmpty()) {
            val img = NetImage(ctx)
            img.scaleType = ImageView.ScaleType.CENTER_CROP
            box.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
            images.load(img, l.images, dp(size), dp(size), alpha = true) { ok -> img.visibility = if (ok) View.VISIBLE else View.GONE }
        }
        return box
    }

    private fun copyLink(url: String, toast: Boolean = true) {
        try {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("link", url))
            if (toast) android.widget.Toast.makeText(ctx, model?.label("copied", "Link copied") ?: "Link copied", android.widget.Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
        }
    }

    private fun pkCopyButton(url: String, size: Int): View = FrameLayout(ctx).apply {
        background = focusable(rounded(withAlpha(colors.canvas, 0.6f), dp(size).toFloat() / 2f, dp(1), withAlpha(colors.ink, 0.1f)))
        isClickable = true
        isFocusable = true
        contentDescription = model?.label("copyLink", "Copy link")
        setOnClickListener { copyLink(url) }
        addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_copy, colors.muted)) }, FrameLayout.LayoutParams(dp(15), dp(15), Gravity.CENTER))
    }

    private fun pkCard(card: View, bottom: Int = 20) {
        card.layoutParams = RecyclerView.LayoutParams(MATCH, wrap).apply {
            marginStart = dp(16)
            marginEnd = dp(16)
            bottomMargin = dp(bottom)
        }
    }

    /** The source the page picked, as its big card (see [PkPick]). Its button sends {a:"pk", what:"primary"}. */
    private inner class PkPickHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val card = itemView as LinearLayout
        private val art = FrameLayout(ctx)
        private val pic = NetImage(ctx)
        private val logoShade = View(ctx)
        private val logo = NetImage(ctx)
        private val badgeShade = View(ctx)
        private val badges = LinearLayout(ctx)
        private val flags = FlowRow(ctx, dp(12), dp(8))
        private val confirm = label("", 12f, bold = true, lines = 2)
        private val match = FrameLayout(ctx)
        private val title = label("", 15.5f)
        private val file = label("", 12.5f)
        private val summary = label("", 13f, bold = true)
        private val chips = FlowRow(ctx, dp(10), dp(8))
        private val actions = FlowRow(ctx, dp(18), dp(14))
        private var rowKey = ""

        init {
            card.orientation = LinearLayout.VERTICAL
            pkCard(card)
            card.setPadding(dp(18), dp(18), dp(18), dp(20))
            art.clipToOutline = true
            art.outlineProvider = roundOutline(dp(16).toFloat())
            pic.scaleType = ImageView.ScaleType.CENTER_CROP
            art.addView(pic, FrameLayout.LayoutParams(MATCH, MATCH))
            logoShade.background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(withAlpha(Color.BLACK, 0.75f), withAlpha(Color.BLACK, 0.3f), Color.TRANSPARENT))
            art.addView(logoShade, FrameLayout.LayoutParams(MATCH, MATCH))
            logo.scaleType = ImageView.ScaleType.FIT_START
            logo.alpha = 0.7f
            art.addView(logo, FrameLayout.LayoutParams(MATCH, MATCH))
            badgeShade.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(withAlpha(Color.BLACK, 0.65f), withAlpha(Color.BLACK, 0.2f), Color.TRANSPARENT))
            art.addView(badgeShade, FrameLayout.LayoutParams(MATCH, MATCH))
            badges.orientation = LinearLayout.VERTICAL
            badges.gravity = Gravity.END
            art.addView(badges, FrameLayout.LayoutParams(wrap, wrap, Gravity.TOP or Gravity.END).apply {
                topMargin = dp(8)
                marginEnd = dp(8)
            })
            card.addView(art)
            card.addView(flags, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(18) })
            card.addView(confirm, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(14) })
            card.addView(match, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(12) })
            mono(title)
            title.setLineSpacing(0f, 1.3f)
            card.addView(title, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(14) })
            mono(file)
            file.setLineSpacing(0f, 1.3f)
            card.addView(file, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
            summary.setLineSpacing(0f, 1.3f)
            card.addView(summary, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(14) })
            chips.middle = true
            card.addView(chips, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(14) })
            actions.middle = true
            card.addView(actions, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(22) })
        }

        fun bind(r: HomeRow, p: PkPick) {
            rowKey = r.key
            card.background = rounded(withAlpha(colors.canvas, 0.85f), dp(24).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            val inner = width() - dp(32) - dp(36)
            val aw = if (p.wide) inner else min(inner, dp(170))
            val ah = if (p.wide) aw * 9 / 16 else aw * 3 / 2
            art.layoutParams = LinearLayout.LayoutParams(aw, ah)
            art.background = rounded(withAlpha(colors.canvas, 0.5f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            if (p.images.isNotEmpty()) images.load(pic, p.images, aw, ah) else images.clear(pic)
            val showLogo = p.wide && p.logo != null
            logoShade.visibility = if (showLogo) View.VISIBLE else View.GONE
            logo.visibility = if (showLogo) View.VISIBLE else View.GONE
            if (showLogo) {
                val lw = (aw * 0.58f).toInt()
                val lh = (ah * 0.26f).toInt()
                logo.layoutParams = FrameLayout.LayoutParams(lw, lh, Gravity.BOTTOM or Gravity.START).apply {
                    marginStart = dp(14)
                    bottomMargin = dp(12)
                }
                logo.scaleType = ImageView.ScaleType.FIT_END
                images.load(logo, listOf(p.logo!!), lw, lh, alpha = true)
            } else {
                images.clear(logo)
            }
            badges.dropAll()
            for (b in p.badges) badges.addView(pkBadge(b, 28f), LinearLayout.LayoutParams(wrap, wrap).apply { bottomMargin = dp(4) })
            badgeShade.visibility = if (p.badges.isEmpty()) View.GONE else View.VISIBLE
            badgeShade.layoutParams = FrameLayout.LayoutParams(MATCH, ah / 3)

            flags.dropAll()
            flags.middle = true
            if (p.flags.isNotEmpty()) {
                for (f in p.flags) flags.addView(pkFlag(f, big = true, named = true))
                p.moreFlags?.let { flags.addView(label(it, 13f, bold = true, lines = 1).apply { setTextColor(colors.subtle) }) }
            } else if (p.noAudio != null) {
                flags.addView(label("", 11f, bold = true, lines = 1).apply {
                    caps(this, p.noAudio, 0.18f)
                    setTextColor(colors.subtle)
                    setPaddingRelative(dp(10), dp(4), dp(10), dp(4))
                    background = rounded(withAlpha(colors.canvas, 0.6f), dp(13).toFloat(), dp(1), withAlpha(colors.ink, 0.1f))
                })
            }
            flags.visibility = if (flags.childCount == 0) View.GONE else View.VISIBLE
            confirm.visibility = if (p.confirm == null) View.GONE else View.VISIBLE
            p.confirm?.let { caps(confirm, it, 0.28f) }
            confirm.setTextColor(colors.subtle)
            match.dropAll()
            p.match?.let { match.addView(pkTagView(it)) }
            match.visibility = if (p.match == null) View.GONE else View.VISIBLE
            title.text = p.title
            title.setTextColor(colors.ink)
            file.text = p.file ?: ""
            file.visibility = if (p.file == null) View.GONE else View.VISIBLE
            file.setTextColor(withAlpha(colors.subtle, 0.8f))
            caps(summary, p.summary.joinToString("  ·  "), 0.16f)
            summary.visibility = if (p.summary.isEmpty()) View.GONE else View.VISIBLE
            summary.setTextColor(colors.muted)

            chips.dropAll()
            p.status?.let { chips.addView(pkStatusView(it, 12.5f, 0.04f)) }
            for (c in p.chips) chips.addView(pkTagView(c))
            chips.visibility = if (chips.childCount == 0) View.GONE else View.VISIBLE

            actions.dropAll()
            actions.addView(pkButtonView(p.button, dp(52), dp(26).toFloat()) { act("pk", row = rowKey, what = "primary") })
            p.via?.let { actions.addView(viaView(it)) }
            p.copy?.let { url -> actions.addView(pkCopyButton(url, 36), ViewGroup.LayoutParams(dp(36), dp(36))) }
        }

        private fun viaView(v: PkVia): View {
            val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            fun addonLine(prefix: String, size: Float, color: Int, spacing: Float): View {
                val line = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                if (prefix.isNotEmpty()) line.addView(label("", size, bold = true, lines = 1).apply {
                    caps(this, prefix, spacing)
                    setTextColor(color)
                }, LinearLayout.LayoutParams(wrap, wrap).apply { marginEnd = dp(6) })
                line.addView(pkLogoView(PkLogo(v.logo, v.addon), 16), LinearLayout.LayoutParams(dp(16), dp(16)).apply { marginEnd = dp(6) })
                line.addView(label("", size, bold = true, lines = 1).apply {
                    caps(this, v.addon, spacing)
                    setTextColor(color)
                })
                return line
            }
            if (v.top == null) {
                box.addView(addonLine(v.by, 11f, colors.subtle, 0.28f))
                return box
            }
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val c = if (v.tone == "danger") withAlpha(pkDanger, 0.8f) else colors.muted
            if (v.zap) top.addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_zap, colors.accent)) }, LinearLayout.LayoutParams(dp(11), dp(11)).apply { marginEnd = dp(5) })
            top.addView(label("", 11f, bold = true, lines = 1).apply {
                caps(this, v.top, 0.28f)
                setTextColor(c)
            })
            box.addView(top)
            box.addView(addonLine(v.by, 10f, withAlpha(colors.subtle, 0.7f), 0.18f), LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(4) })
            return box
        }
    }

    /** "Switch quality", its note, the Cached / language pills and a button per quality. */
    private inner class PkTiersHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val box = itemView as LinearLayout
        private val head = LinearLayout(ctx)
        private val title = label("", 12f, bold = true, lines = 1)
        private val info = ImageView(ctx)
        private val pills = LinearLayout(ctx)
        private val note = LinearLayout(ctx)
        private val noteTitle = label("", 10.5f, bold = true)
        private val noteBody = label("", 12.5f)
        private val tiers = FlowRow(ctx, dp(10), dp(10))
        private var rowKey = ""

        init {
            box.orientation = LinearLayout.VERTICAL
            pkCard(box, 24)
            head.orientation = LinearLayout.HORIZONTAL
            head.gravity = Gravity.CENTER_VERTICAL
            head.addView(title)
            info.setPadding(dp(6), dp(6), dp(6), dp(6))
            info.isClickable = true
            info.isFocusable = true
            info.setOnClickListener {
                pkInfoOpen = !pkInfoOpen
                note.visibility = if (pkInfoOpen) View.VISIBLE else View.GONE
            }
            head.addView(info, LinearLayout.LayoutParams(dp(26), dp(26)).apply { marginStart = dp(2) })
            pills.orientation = LinearLayout.HORIZONTAL
            pills.gravity = Gravity.END or Gravity.CENTER_VERTICAL
            head.addView(pills, LinearLayout.LayoutParams(0, wrap, 1f).apply { marginStart = dp(8) })
            box.addView(head)
            note.orientation = LinearLayout.VERTICAL
            note.setPadding(dp(16), dp(14), dp(16), dp(14))
            note.addView(noteTitle)
            noteBody.setLineSpacing(0f, 1.25f)
            note.addView(noteBody, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
            box.addView(note, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(10) })
            box.addView(tiers, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(14) })
        }

        fun bind(r: HomeRow, t: PkTiers) {
            rowKey = r.key
            caps(title, t.title, 0.32f)
            title.setTextColor(colors.subtle)
            info.setImageDrawable(icon(R.drawable.ic_info, withAlpha(colors.subtle, 0.7f)))
            info.contentDescription = t.infoTitle
            note.background = rounded(colors.surface, dp(12).toFloat(), dp(1), withAlpha(colors.ink, 0.1f))
            caps(noteTitle, t.infoTitle, 0.18f)
            noteTitle.setTextColor(colors.accent)
            noteBody.text = t.infoBody
            noteBody.setTextColor(colors.muted)
            note.visibility = if (pkInfoOpen) View.VISIBLE else View.GONE
            pills.dropAll()
            for (p in t.pills) {
                val on = p.on
                val c = if (on) (if (p.icon == "zap") colors.accent else colors.muted) else withAlpha(colors.subtle, 0.8f)
                val pill = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPaddingRelative(dp(10), dp(5), dp(10), dp(5))
                    background = focusable(rounded(if (on) withAlpha(if (p.icon == "zap") colors.accent else colors.ink, if (p.icon == "zap") 0.15f else 0.08f) else Color.TRANSPARENT, dp(14).toFloat()))
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { act("pk", row = rowKey, what = "pill:" + p.id) }
                }
                val res = pkIconRes(p.icon)
                if (res != 0) pill.addView(ImageView(ctx).apply { setImageDrawable(icon(res, c)) }, LinearLayout.LayoutParams(dp(11), dp(11)).apply { marginEnd = dp(5) })
                pill.addView(label("", 10.5f, bold = true, lines = 1).apply {
                    caps(this, p.label, 0.18f)
                    setTextColor(c)
                })
                pills.addView(pill, LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(4) })
            }
            tiers.dropAll()
            t.tiers.forEachIndexed { i, tier -> tiers.addView(tierView(tier, i)) }
        }

        private fun tierView(t: PkTier, i: Int): View {
            val b = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(56)
                setPaddingRelative(dp(14), dp(9), dp(16), dp(9))
                background = focusable(
                    if (t.on) rounded(withAlpha(colors.ink, 0.05f), dp(14).toFloat(), dp(1), withAlpha(colors.ink, 0.35f))
                    else rounded(Color.TRANSPARENT, dp(14).toFloat(), dp(1), withAlpha(colors.ink, 0.08f)),
                )
                alpha = if (t.dim) 0.65f else 1f
                isClickable = true
                isFocusable = true
                contentDescription = t.label
                setOnClickListener { act("pk", row = rowKey, what = "tier", i = i) }
            }
            b.addView(pkBadge(t.badge, 56f))
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(label("", 12.5f, bold = true, lines = 1).apply {
                caps(this, t.label, 0.16f)
                setTextColor(if (t.on) colors.ink else colors.muted)
            }, LinearLayout.LayoutParams(wrap, wrap))
            val st = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            if (t.zap != null) st.addView(ImageView(ctx).apply {
                setImageDrawable(icon(R.drawable.ic_zap, if (t.zap == "fill") withAlpha(colors.accent, 0.8f) else withAlpha(colors.muted, 0.7f)))
            }, LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(5) })
            st.addView(label(t.status, 12f, bold = true, lines = 1).apply { setTextColor(colors.subtle) })
            texts.addView(st, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(2) })
            b.addView(texts, LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(12) })
            return b
        }
    }

    /** The quality note under "Switch quality" is open. */
    private var pkInfoOpen = false

    /** The drawer's button ("All sources 42", logos, "3 addons") and, open, the addon pills. */
    private inner class PkDrawerHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val box = itemView as LinearLayout
        private val toggle = LinearLayout(ctx)
        private val chevron = ImageView(ctx)
        private val text = label("", 11.5f, bold = true, lines = 1)
        private val count = label("", 11.5f, bold = true, lines = 1)
        private val logos = FrameLayout(ctx)
        private val addons = label("", 11.5f, bold = true, lines = 1)
        private val pills = FlowRow(ctx, dp(6), dp(6))
        private var rowKey = ""

        init {
            box.orientation = LinearLayout.VERTICAL
            pkCard(box, 16)
            toggle.orientation = LinearLayout.HORIZONTAL
            toggle.gravity = Gravity.CENTER_VERTICAL
            toggle.setPaddingRelative(dp(16), dp(9), dp(16), dp(9))
            toggle.isClickable = true
            toggle.isFocusable = true
            toggle.setOnClickListener { act("pk", row = rowKey, what = "drawer") }
            toggle.addView(chevron, LinearLayout.LayoutParams(dp(14), dp(14)).apply { marginEnd = dp(10) })
            toggle.addView(text)
            toggle.addView(count, LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(10) })
            toggle.addView(logos, LinearLayout.LayoutParams(wrap, dp(20)).apply { marginStart = dp(10) })
            toggle.addView(addons, LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(8) })
            box.addView(toggle, LinearLayout.LayoutParams(wrap, wrap))
            box.addView(pills, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(14) })
        }

        fun bind(r: HomeRow, d: PkDrawer) {
            rowKey = r.key
            toggle.background = focusable(rounded(withAlpha(colors.canvas, 0.7f), dp(20).toFloat(), dp(1), withAlpha(colors.ink, 0.1f)))
            chevron.setImageDrawable(icon(R.drawable.ic_chevron_down, colors.muted))
            chevron.rotation = if (d.open) 180f else 0f
            caps(text, d.label, 0.22f)
            text.setTextColor(colors.muted)
            count.text = d.count
            count.setTextColor(withAlpha(colors.subtle, 0.8f))
            toggle.contentDescription = d.label + " " + d.count
            logos.dropAll()
            d.logos.take(5).forEachIndexed { i, l ->
                logos.addView(pkLogoView(l, 20, dp(2)), FrameLayout.LayoutParams(dp(20), dp(20)).apply { marginStart = i * dp(13) })
            }
            logos.visibility = if (d.logos.isEmpty()) View.GONE else View.VISIBLE
            addons.text = d.addons ?: ""
            addons.visibility = if (d.addons == null) View.GONE else View.VISIBLE
            addons.setTextColor(withAlpha(colors.subtle, 0.8f))
            pills.dropAll()
            for (p in d.pills) {
                val pill = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPaddingRelative(dp(12), dp(6), dp(12), dp(6))
                    background = focusable(
                        if (p.on) rounded(colors.ink, dp(16).toFloat())
                        else rounded(withAlpha(colors.surface, 0.5f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f)),
                    )
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { act("pk", row = rowKey, what = "filter:" + p.id) }
                }
                pill.addView(label(p.label, 12f, bold = true, lines = 1).apply {
                    setTextColor(if (p.on) colors.canvas else colors.muted)
                    maxWidth = dp(180)
                })
                p.count?.let {
                    pill.addView(label(it, 12f, bold = true, lines = 1).apply { setTextColor(if (p.on) withAlpha(colors.canvas, 0.7f) else withAlpha(colors.subtle, 0.8f)) },
                        LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(6) })
                }
                pills.addView(pill)
            }
            pills.visibility = if (d.open && d.pills.size > 1) View.VISIBLE else View.GONE
        }
    }

    /** One source in the drawer's box: badges, its name, file, addon and facts, languages, cached, Play. */
    private inner class PkStreamHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val outer = itemView as LinearLayout
        private val divider = View(ctx)
        private val line = LinearLayout(ctx)
        private val badges = LinearLayout(ctx)
        private val title = label("", 14f, lines = 2)
        private val edition = FrameLayout(ctx)
        private val file = label("", 11f, lines = 2)
        private val addonLine = LinearLayout(ctx)
        private val addonLogo = FrameLayout(ctx)
        private val addon = label("", 12f, bold = true, lines = 2)
        private val meta = FlowRow(ctx, dp(10), dp(6))
        private val end = FrameLayout(ctx)
        private val endIcon = ImageView(ctx)
        private val spinner = android.widget.ProgressBar(ctx).apply { isIndeterminate = true }
        private val copyBox = FrameLayout(ctx)
        private var rowKey = ""
        private var index = -1

        init {
            outer.orientation = LinearLayout.VERTICAL
            outer.layoutParams = RecyclerView.LayoutParams(MATCH, wrap).apply {
                marginStart = dp(16)
                marginEnd = dp(16)
            }
            outer.addView(divider, LinearLayout.LayoutParams(MATCH, max(1, dp(1) / 2 + 1)))
            line.orientation = LinearLayout.HORIZONTAL
            line.setPaddingRelative(dp(16), dp(14), dp(12), dp(14))
            line.isClickable = true
            line.isFocusable = true
            line.setOnClickListener { act("pk", row = rowKey, what = "stream", i = index) }
            badges.orientation = LinearLayout.VERTICAL
            line.addView(badges, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(2) })
            val mid = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            mono(title)
            mid.addView(title)
            mid.addView(edition, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(4) })
            mono(file)
            mid.addView(file, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(4) })
            addonLine.orientation = LinearLayout.HORIZONTAL
            addonLine.gravity = Gravity.CENTER_VERTICAL
            addonLine.addView(addonLogo, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(8) })
            addonLine.addView(addon, LinearLayout.LayoutParams(0, wrap, 1f))
            mid.addView(addonLine, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(6) })
            meta.middle = true
            mid.addView(meta, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
            line.addView(mid, LinearLayout.LayoutParams(0, wrap, 1f).apply {
                marginStart = dp(12)
                marginEnd = dp(8)
            })
            val side = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
            }
            end.addView(endIcon, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER))
            end.addView(spinner, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER))
            side.addView(end, LinearLayout.LayoutParams(dp(32), dp(32)))
            side.addView(copyBox, LinearLayout.LayoutParams(dp(32), dp(32)).apply { topMargin = dp(6) })
            line.addView(side, LinearLayout.LayoutParams(wrap, wrap))
            outer.addView(line, LinearLayout.LayoutParams(MATCH, wrap))
        }

        fun bind(r: HomeRow, i: Int, count: Int, s: PkStream) {
            rowKey = r.key
            index = i
            val first = i == 0
            val last = i == count - 1
            (outer.layoutParams as RecyclerView.LayoutParams).bottomMargin = if (last) dp(20) else 0
            outer.background = segment(first, last)
            divider.visibility = if (first) View.GONE else View.VISIBLE
            divider.setBackgroundColor(withAlpha(colors.ink, 0.05f))
            line.background = focusable(rounded(Color.TRANSPARENT, dp(16).toFloat()))
            line.contentDescription = s.title
            badges.dropAll()
            for (b in s.badges) badges.addView(pkBadge(b, 40f), LinearLayout.LayoutParams(wrap, wrap).apply { bottomMargin = dp(4) })
            badges.visibility = if (s.badges.isEmpty()) View.GONE else View.VISIBLE
            title.text = s.title
            title.setTextColor(colors.ink)
            edition.dropAll()
            s.edition?.let { edition.addView(pkTagView(PkTag(it, "accent"))) }
            edition.visibility = if (s.edition == null) View.GONE else View.VISIBLE
            file.text = s.file ?: ""
            file.visibility = if (s.file == null) View.GONE else View.VISIBLE
            file.setTextColor(withAlpha(colors.subtle, 0.75f))
            addonLogo.dropAll()
            addonLogo.addView(pkLogoView(s.logo, 18), FrameLayout.LayoutParams(MATCH, MATCH))
            caps(addon, s.addon + (s.summary?.let { "  ·  $it" } ?: ""), 0.14f)
            addon.setTextColor(colors.subtle)
            meta.dropAll()
            s.match?.let { meta.addView(pkTagView(it)) }
            if (s.flags.isNotEmpty()) {
                val fl = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                for (f in s.flags) fl.addView(pkFlag(f, big = false, named = false), LinearLayout.LayoutParams(wrap, wrap).apply { marginEnd = dp(4) })
                if (s.moreFlags > 0) fl.addView(label("+${s.moreFlags}", 10f, bold = true, lines = 1).apply { setTextColor(colors.subtle) })
                meta.addView(fl)
            }
            s.status?.let { meta.addView(pkStatusView(it, 12f, 0.14f)) }
            meta.visibility = if (meta.childCount == 0) View.GONE else View.VISIBLE
            val busy = s.end == "busy"
            spinner.visibility = if (busy) View.VISIBLE else View.GONE
            spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(colors.muted)
            endIcon.visibility = if (busy) View.GONE else View.VISIBLE
            endIcon.setImageDrawable(icon(if (s.end == "external") R.drawable.ic_external_link else R.drawable.ic_play, withAlpha(colors.muted, 0.6f)))
            endIcon.scaleX = if (model?.rtl == true && s.end != "external") -1f else 1f
            line.isEnabled = !busy
            line.alpha = if (busy) 0.6f else 1f
            copyBox.dropAll()
            s.copy?.let { url -> copyBox.addView(pkCopyButton(url, 30), FrameLayout.LayoutParams(dp(30), dp(30), Gravity.CENTER)) }
            copyBox.visibility = if (s.copy == null) View.GONE else View.VISIBLE
        }

        /** This line's part of the box around them all: rounded at its ends, edged at the sides. */
        private fun segment(first: Boolean, last: Boolean): Drawable {
            val r = dp(16).toFloat()
            val stroke = max(1, dp(1))
            val fill = withAlpha(colors.canvas, 0.8f)
            val edge = withAlpha(colors.ink, 0.08f)
            val shape = GradientDrawable().apply {
                setColor(fill)
                setStroke(stroke, edge)
                cornerRadii = floatArrayOf(
                    if (first) r else 0f, if (first) r else 0f, if (first) r else 0f, if (first) r else 0f,
                    if (last) r else 0f, if (last) r else 0f, if (last) r else 0f, if (last) r else 0f,
                )
            }
            // The edge between two lines is drawn by neither (the divider shows there).
            return android.graphics.drawable.InsetDrawable(shape, 0, if (first) 0 else -stroke, 0, if (last) 0 else -stroke)
        }
    }

    /** "12 cached · 40 found across 3 sources" and, open, each source's count. */
    private inner class PkDiagHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val box = itemView as LinearLayout
        private val head = LinearLayout(ctx)
        private val lead = label("", 12f, bold = true, lines = 1)
        private val text = label("", 12f, lines = 2)
        private val chevron = ImageView(ctx)
        private val more = label("", 11f)
        private var rowKey = ""

        init {
            box.orientation = LinearLayout.VERTICAL
            pkCard(box, 18)
            head.orientation = LinearLayout.HORIZONTAL
            head.gravity = Gravity.CENTER_VERTICAL
            head.isClickable = true
            head.isFocusable = true
            head.setPadding(0, dp(4), 0, dp(4))
            head.setOnClickListener { act("pk", row = rowKey, what = "diag") }
            head.addView(lead)
            head.addView(text, LinearLayout.LayoutParams(0, wrap, 1f).apply { marginStart = dp(8) })
            head.addView(chevron, LinearLayout.LayoutParams(dp(13), dp(13)).apply { marginStart = dp(8) })
            box.addView(head, LinearLayout.LayoutParams(MATCH, wrap))
            more.setLineSpacing(0f, 1.3f)
            box.addView(more, LinearLayout.LayoutParams(MATCH, wrap).apply {
                topMargin = dp(6)
                marginStart = dp(4)
            })
        }

        fun bind(r: HomeRow, d: PkDiag) {
            rowKey = r.key
            head.background = focusable(rounded(Color.TRANSPARENT, dp(8).toFloat()))
            lead.text = d.lead
            lead.setTextColor(colors.muted)
            text.text = "·  " + d.text
            text.setTextColor(withAlpha(colors.subtle, 0.8f))
            chevron.setImageDrawable(icon(R.drawable.ic_chevron_down, withAlpha(colors.subtle, 0.8f)))
            chevron.rotation = if (d.open) 180f else 0f
            more.text = d.more.joinToString("  ·  ")
            more.setTextColor(withAlpha(colors.subtle, 0.7f))
            more.visibility = if (d.open && d.more.isNotEmpty()) View.VISIBLE else View.GONE
        }
    }

    /** A message in a box (see [PkPanel]); its button sends {a:"pk", what:"panel"}. */
    private inner class PkPanelHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        private val art = NetImage(ctx)
        private val shade = View(ctx)
        private val col = LinearLayout(ctx)
        private val kicker = label("", 10.5f, bold = true)
        private val title = label("", 28f)
        private val body = label("", 14f)
        private val pills = FlowRow(ctx, dp(8), dp(8))
        private val mono = label("", 10.5f)
        private val button = FrameLayout(ctx)
        private val note = label("", 11f, bold = true)
        private var rowKey = ""

        init {
            pkCard(frame, 20)
            frame.clipToOutline = true
            art.scaleType = ImageView.ScaleType.CENTER_CROP
            art.alpha = 0.25f
            art.colorFilter = android.graphics.ColorMatrixColorFilter(android.graphics.ColorMatrix().apply { setSaturation(0f) })
            frame.addView(art, FrameLayout.LayoutParams(MATCH, MATCH))
            frame.addView(shade, FrameLayout.LayoutParams(MATCH, MATCH))
            col.orientation = LinearLayout.VERTICAL
            frame.addView(col, FrameLayout.LayoutParams(MATCH, wrap))
            col.addView(kicker)
            title.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            title.setLineSpacing(0f, 1.05f)
            col.addView(title, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(16) })
            body.setLineSpacing(0f, 1.35f)
            col.addView(body, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(16) })
            col.addView(pills, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(16) })
            mono(mono)
            col.addView(mono, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(16) })
            col.addView(button, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(20) })
            col.addView(note, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(18) })
        }

        fun bind(r: HomeRow, p: PkPanel) {
            rowKey = r.key
            val warn = p.look == "warn"
            val dashed = p.look == "dashed"
            val plain = p.look == "plain"
            val center = !warn
            val radius = dp(if (warn || dashed) 16 else 24).toFloat()
            frame.outlineProvider = roundOutline(radius)
            frame.background = when {
                plain -> null
                warn -> rounded(withAlpha(pkAmber300, 0.06f), radius, dp(1), withAlpha(pkAmber300, 0.3f))
                dashed -> {
                    val fill = withAlpha(colors.canvas, 0.7f)
                    val edge = withAlpha(colors.ink, 0.16f)
                    GradientDrawable().apply {
                        cornerRadius = radius
                        setColor(fill)
                        setStroke(dp(1), edge, dp(6).toFloat(), dp(4).toFloat())
                    }
                }
                else -> rounded(withAlpha(colors.canvas, if (p.look == "art") 0.6f else 0.8f), radius, dp(1), withAlpha(colors.ink, 0.08f))
            }
            val showArt = p.look == "art" && p.art.isNotEmpty()
            art.visibility = if (showArt) View.VISIBLE else View.GONE
            shade.visibility = if (showArt) View.VISIBLE else View.GONE
            if (showArt) {
                images.load(art, p.art, width() - dp(32), dp(360))
                shade.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(withAlpha(colors.canvas, 0.6f), withAlpha(colors.canvas, 0.8f), colors.canvas))
            } else {
                images.clear(art)
            }
            when {
                plain -> col.setPadding(dp(16), dp(4), dp(16), dp(8))
                warn -> col.setPadding(dp(20), dp(14), dp(20), dp(16))
                dashed -> col.setPadding(dp(24), dp(44), dp(24), dp(44))
                p.look == "art" -> col.setPadding(dp(28), dp(52), dp(28), dp(52))
                else -> col.setPadding(dp(26), dp(40), dp(26), dp(40))
            }
            val g = if (center) Gravity.CENTER_HORIZONTAL else Gravity.START
            col.gravity = g
            for (v in listOf(kicker, title, body, mono, note)) {
                v.gravity = if (center) Gravity.CENTER_HORIZONTAL else Gravity.START
                v.textAlignment = if (center) View.TEXT_ALIGNMENT_CENTER else View.TEXT_ALIGNMENT_VIEW_START
            }
            (button.layoutParams as LinearLayout.LayoutParams).gravity = g
            kicker.visibility = if (p.kicker == null) View.GONE else View.VISIBLE
            p.kicker?.let { caps(kicker, it, 0.42f) }
            kicker.setTextColor(colors.subtle)
            title.visibility = if (p.title == null) View.GONE else View.VISIBLE
            title.text = p.title ?: ""
            if (warn) {
                title.typeface = Typeface.DEFAULT_BOLD
                title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                title.setTextColor(pkAmber200)
                (title.layoutParams as LinearLayout.LayoutParams).topMargin = 0
            } else {
                title.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                title.setTextSize(TypedValue.COMPLEX_UNIT_SP, p.titleSize)
                title.setTextColor(colors.ink)
                (title.layoutParams as LinearLayout.LayoutParams).topMargin = if (p.kicker == null) 0 else dp(16)
            }
            body.visibility = if (p.body == null) View.GONE else View.VISIBLE
            body.text = p.body ?: ""
            body.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (plain) 11.5f else if (warn) 12.5f else if (dashed) 14f else 13.5f)
            body.setTextColor(if (plain) colors.subtle else colors.muted)
            (body.layoutParams as LinearLayout.LayoutParams).topMargin = if (p.title == null && p.kicker == null) 0 else dp(if (warn) 2 else 16)
            pills.center = center
            pills.dropAll()
            for (t in p.pills) pills.addView(label(t, 12f, bold = true, lines = 1).apply {
                setTextColor(colors.muted)
                setPaddingRelative(dp(12), dp(4), dp(12), dp(4))
                background = rounded(withAlpha(colors.canvas, 0.6f), dp(14).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            })
            pills.visibility = if (p.pills.isEmpty()) View.GONE else View.VISIBLE
            mono.visibility = if (p.mono == null) View.GONE else View.VISIBLE
            p.mono?.let { caps(mono, it, 0.18f) }
            mono.setTextColor(withAlpha(colors.subtle, 0.7f))
            button.dropAll()
            p.button?.let { b ->
                val h = when (b.style) {
                    "amber" -> dp(36)
                    "outline" -> dp(44)
                    else -> if (dashed) dp(40) else dp(48)
                }
                button.addView(pkButtonView(b, h, if (dashed) dp(12).toFloat() else h / 2f) { act("pk", row = rowKey, what = "panel") })
            }
            button.visibility = if (p.button == null) View.GONE else View.VISIBLE
            (button.layoutParams as LinearLayout.LayoutParams).topMargin = dp(if (warn) 12 else 20)
            note.visibility = if (p.note == null) View.GONE else View.VISIBLE
            p.note?.let { caps(note, it, 0.32f) }
            note.setTextColor(colors.subtle)
        }
    }

    /** Searching: the title's logo (or name) breathing, and the caption under it. */
    private inner class PkLoaderHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val logo = NetImage(ctx)
        private val name = label("", 40f, lines = 3)
        private val caption = label("", 11f, bold = true, lines = 2)
        private var pulse: android.animation.ObjectAnimator? = null

        init {
            col.orientation = LinearLayout.VERTICAL
            col.gravity = Gravity.CENTER_HORIZONTAL
            pkCard(col, 0)
            col.setPadding(0, dp(72), 0, dp(80))
            logo.scaleType = ImageView.ScaleType.FIT_CENTER
            col.addView(logo)
            name.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            name.gravity = Gravity.CENTER_HORIZONTAL
            name.textAlignment = View.TEXT_ALIGNMENT_CENTER
            col.addView(name, LinearLayout.LayoutParams(MATCH, wrap))
            caption.gravity = Gravity.CENTER_HORIZONTAL
            caption.textAlignment = View.TEXT_ALIGNMENT_CENTER
            col.addView(caption, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(32) })
            col.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(v: View) {
                    if (pulse?.isStarted != true) pulse?.start()
                }
                override fun onViewDetachedFromWindow(v: View) {
                    pulse?.cancel()
                }
            })
        }

        fun bind(l: PkLoader) {
            val lw = (width() * 0.7f).toInt()
            val lh = dp(150)
            logo.layoutParams = LinearLayout.LayoutParams(lw, lh)
            name.text = l.text
            name.setTextColor(colors.ink)
            if (l.logo.isNotEmpty()) {
                logo.visibility = View.VISIBLE
                name.visibility = View.GONE
                images.load(logo, l.logo, lw, lh, alpha = true) { ok ->
                    logo.visibility = if (ok) View.VISIBLE else View.GONE
                    name.visibility = if (ok) View.GONE else View.VISIBLE
                }
            } else {
                images.clear(logo)
                logo.visibility = View.GONE
                name.visibility = View.VISIBLE
            }
            caps(caption, l.caption, 0.42f)
            caption.setTextColor(colors.subtle)
            if (pulse == null) {
                pulse = android.animation.ObjectAnimator.ofFloat(col, View.ALPHA, 1f, 0.55f).apply {
                    duration = 1100
                    repeatMode = android.animation.ValueAnimator.REVERSE
                    repeatCount = android.animation.ValueAnimator.INFINITE
                }
            }
            if (col.isAttachedToWindow && pulse?.isStarted != true) pulse?.start()
        }
    }

    // ---- The Addons page (its cards, rails, the featured addon, an addon's page) --------------

    private val adRose300 = 0xFFFDA4AF.toInt()
    private val adRose500 = 0xFFF43F5E.toInt()
    private val adEmerald500 = 0xFF10B981.toInt()
    private val adEdge get() = withAlpha(colors.ink, 0.08f)

    /** An addon's logo: a rounded square (its picture, else its initial on its gradient). */
    private fun adLogoView(l: AdLogo, size: Int): View {
        val px = dp(size)
        val r = max(dp(4), (px * 0.22f).toInt()).toFloat()
        val box = FrameLayout(ctx)
        box.clipToOutline = true
        box.outlineProvider = roundOutline(r)
        val bg = if (l.from != null && l.to != null) {
            GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(l.from, l.to)).apply { cornerRadius = r }
        } else {
            rounded(colors.surface, r)
        }
        box.background = bg
        box.addView(label(l.initial.take(1).uppercase(), 10f, bold = true, lines = 1).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_PX, px * 0.5f)
            setTextColor(withAlpha(Color.WHITE, 0.95f))
            includeFontPadding = false
        }, FrameLayout.LayoutParams(wrap, wrap, Gravity.CENTER))
        if (l.images.isNotEmpty()) {
            val img = NetImage(ctx)
            img.scaleType = ImageView.ScaleType.CENTER_CROP
            img.background = rounded(withAlpha(Color.WHITE, 0.06f), r)
            box.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
            images.load(img, l.images, px, px, alpha = true) { ok -> img.visibility = if (ok) View.VISIBLE else View.GONE }
        }
        box.foreground = rounded(Color.TRANSPARENT, r, max(1, dp(1) / 2), withAlpha(Color.WHITE, 0.08f))
        return box
    }

    /** A small pill: community stars, rising, new, a curated tag. */
    private fun adPillView(p: AdPill, small: Boolean = true): View {
        val (fg, bg, ring) = when (p.tone) {
            "star" -> Triple(colors.accent, withAlpha(colors.canvas, 0.7f), withAlpha(colors.accent, 0.3f))
            "rise" -> Triple(adRose300, withAlpha(adRose500, 0.15f), withAlpha(adRose500, 0.4f))
            "new" -> Triple(pkGreen, withAlpha(adEmerald500, 0.15f), withAlpha(adEmerald500, 0.3f))
            "good" -> Triple(colors.accent, withAlpha(colors.accent, 0.15f), 0)
            "warn" -> Triple(colors.muted, withAlpha(colors.ink, 0.1f), 0)
            else -> Triple(colors.subtle, withAlpha(colors.ink, 0.1f), 0)
        }
        val upper = p.tone == "new" || p.tone == "good" || p.tone == "warn" || p.tone == "neutral"
        val line = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPaddingRelative(dp(6), dp(2), dp(7), dp(2))
            background = rounded(bg, dp(10).toFloat(), if (ring != 0) max(1, dp(1)) else 0, ring)
        }
        val res = when (p.icon) {
            "star" -> R.drawable.ic_star
            "trend" -> R.drawable.ic_trending_up
            "sparkles" -> R.drawable.ic_sparkles
            else -> 0
        }
        if (res != 0) line.addView(ImageView(ctx).apply { setImageDrawable(icon(res, fg)) }, LinearLayout.LayoutParams(dp(9), dp(9)).apply { marginEnd = dp(4) })
        line.addView(label("", if (small) 10.5f else 11f, bold = true, lines = 1).apply {
            if (upper) caps(this, p.text, if (p.tone == "new") 0.14f else 0.1f) else text = p.text
            setTextColor(fg)
        })
        return line
    }

    /** The faint logo behind a card and the canvas fading over it (the page's CardArtBackdrop).
     *  It is the card's own logo at the logo's size: one load serves both. */
    private fun adArt(frame: FrameLayout, art: String?, logo: AdLogo, size: Int) {
        if (art == null || logo.images.isEmpty()) return
        val img = NetImage(ctx)
        img.scaleType = ImageView.ScaleType.CENTER_CROP
        frame.addView(img, 0, FrameLayout.LayoutParams(MATCH, MATCH))
        images.load(img, logo.images, dp(size), dp(size), alpha = true) { ok -> if (ok) img.alpha = 0.1f }
        val c = colors.canvas
        val rtl = model?.rtl == true
        frame.addView(View(ctx).apply {
            background = GradientDrawable(
                if (rtl) GradientDrawable.Orientation.RIGHT_LEFT else GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(c, c, withAlpha(c, 0.78f), withAlpha(c, 0.42f)),
            )
        }, 1, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    /** An addon as a card down the page (see [AdCard]). */
    private inner class AdCardHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        private var rowKey = ""

        init {
            pkCard(frame, 10)
            frame.clipToOutline = true
            frame.outlineProvider = roundOutline(dp(16).toFloat())
            frame.isClickable = true
            frame.isFocusable = true
            frame.setOnClickListener { act("ad", row = rowKey, what = "open") }
        }

        fun bind(r: HomeRow, c: AdCard) {
            rowKey = r.key
            if (c.more) act("ad", row = r.key, what = "more")
            frame.dropAll()
            frame.background = focusable(rounded(colors.surface, dp(16).toFloat(), max(1, dp(1)), adEdge))
            frame.alpha = if (c.dim) 0.6f else 1f
            frame.contentDescription = c.name
            adArt(frame, c.art, c.logo, 56)
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(dp(18), dp(18), dp(16), dp(18))
            }
            row.addView(adLogoView(c.logo, 56), LinearLayout.LayoutParams(dp(56), dp(56)))
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            val nameLine = FlowRow(ctx, dp(8), dp(4)).apply { middle = true }
            nameLine.addView(label(c.name, 16f, bold = true, lines = 2).apply { setTextColor(colors.ink) })
            for (p in c.pills) nameLine.addView(adPillView(p))
            if (c.variant == "feature" && c.button != null) {
                val top = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                top.addView(nameLine, LinearLayout.LayoutParams(0, wrap, 1f))
                top.addView(adButton(c.button, dp(36)), LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(10) })
                texts.addView(top)
            } else {
                texts.addView(nameLine)
            }
            c.desc?.let {
                texts.addView(label(it, if (c.variant == "feature") 13f else 13.5f, lines = 3).apply {
                    setTextColor(colors.muted)
                    setLineSpacing(0f, 1.3f)
                }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(6) })
            }
            if (c.tags.isNotEmpty()) {
                val tags = FlowRow(ctx, dp(6), dp(6))
                for (t in c.tags) tags.addView(adPillView(t))
                texts.addView(tags, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
            }
            row.addView(texts, LinearLayout.LayoutParams(0, wrap, 1f).apply {
                marginStart = dp(16)
                marginEnd = dp(10)
            })
            if (c.variant != "feature" && c.button != null) {
                row.addView(adButton(c.button, dp(36)), LinearLayout.LayoutParams(wrap, wrap).apply { gravity = Gravity.CENTER_VERTICAL })
            }
            if (c.chevron) {
                row.addView(ImageView(ctx).apply {
                    setImageDrawable(icon(R.drawable.ic_chevron_right, colors.subtle))
                    scaleX = if (model?.rtl == true) -1f else 1f
                }, LinearLayout.LayoutParams(dp(16), dp(16)).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    marginStart = dp(6)
                })
            }
            frame.addView(row, FrameLayout.LayoutParams(MATCH, wrap))
        }

        private fun adButton(b: PkButton, h: Int): View = pkButtonView(b, h, h / 2f) { act("ad", row = rowKey, what = "btn") }.apply {
            setPaddingRelative(dp(14), 0, dp(16), 0)
        }
    }

    /** Addons as tiles, two across or a sideways strip (see [AdTiles]). */
    private inner class AdTilesHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        private var rowKey = ""

        init {
            pkCard(frame, 12)
        }

        fun bind(r: HomeRow, t: AdTiles) {
            val keepX = if (rowKey == r.key) (frame.getChildAt(0) as? android.widget.HorizontalScrollView)?.scrollX ?: 0 else 0
            rowKey = r.key
            frame.dropAll()
            val lp = frame.layoutParams as RecyclerView.LayoutParams
            if (t.strip) {
                lp.marginStart = 0
                lp.marginEnd = 0
                val scroll = android.widget.HorizontalScrollView(ctx).apply {
                    isHorizontalScrollBarEnabled = false
                    overScrollMode = View.OVER_SCROLL_NEVER
                    clipToPadding = false
                    setPadding(dp(16), 0, dp(16), dp(8))
                }
                val line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                t.items.forEachIndexed { i, it ->
                    line.addView(tile(it, i, dp(236)), LinearLayout.LayoutParams(dp(236), MATCH).apply { if (i > 0) marginStart = dp(12) })
                }
                scroll.addView(line, FrameLayout.LayoutParams(wrap, wrap))
                frame.addView(scroll, FrameLayout.LayoutParams(MATCH, wrap))
                // Redrawn (an addon installed, its stars in): where it was scrolled to.
                if (keepX > 0) scroll.post { scroll.scrollTo(keepX, 0) }
                return
            }
            lp.marginStart = dp(16)
            lp.marginEnd = dp(16)
            val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            val w = (width() - dp(32) - dp(12)) / 2
            var i = 0
            while (i < t.items.size) {
                val line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                for (k in 0 until 2) {
                    val idx = i + k
                    val v = if (idx < t.items.size) tile(t.items[idx], idx, w) else View(ctx)
                    line.addView(v, LinearLayout.LayoutParams(0, MATCH, 1f).apply { if (k > 0) marginStart = dp(12) })
                }
                col.addView(line, LinearLayout.LayoutParams(MATCH, wrap).apply { if (i > 0) topMargin = dp(12) })
                i += 2
            }
            frame.addView(col, FrameLayout.LayoutParams(MATCH, wrap))
        }

        private fun tile(t: AdTile, i: Int, w: Int): View {
            val card = FrameLayout(ctx).apply {
                clipToOutline = true
                outlineProvider = roundOutline(dp(16).toFloat())
                background = focusable(rounded(colors.surface, dp(16).toFloat(), max(1, dp(1)), adEdge))
                isClickable = true
                isFocusable = true
                contentDescription = t.name
                setOnClickListener { act("ad", row = rowKey, what = "open", i = i) }
            }
            adArt(card, t.art, t.logo, 48)
            val col = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(18), dp(16), dp(16))
            }
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            top.addView(adLogoView(t.logo, 48), LinearLayout.LayoutParams(dp(48), dp(48)))
            val names = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            names.addView(label(t.name, 15f, bold = true, lines = 2).apply { setTextColor(colors.ink) })
            if (t.pills.isNotEmpty()) {
                val pl = FlowRow(ctx, dp(4), dp(4))
                for (p in t.pills) pl.addView(adPillView(p))
                names.addView(pl, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(4) })
            }
            top.addView(names, LinearLayout.LayoutParams(0, wrap, 1f).apply { marginStart = dp(12) })
            col.addView(top)
            t.desc?.let {
                col.addView(label(it, 13f, lines = 3).apply {
                    setTextColor(colors.muted)
                    setLineSpacing(0f, 1.3f)
                }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(14) })
            }
            col.addView(View(ctx), LinearLayout.LayoutParams(MATCH, 0, 1f))
            col.addView(pkButtonView(t.button, dp(44), dp(22).toFloat()) { act("ad", row = rowKey, what = "btn", i = i) }.apply {
                setPaddingRelative(dp(12), 0, dp(12), 0)
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(16) })
            card.addView(col, FrameLayout.LayoutParams(MATCH, MATCH))
            return card
        }
    }

    /** The featured addon (see [AdHero]). */
    private inner class AdHeroHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        private var rowKey = ""

        init {
            pkCard(frame, 40)
            frame.clipToOutline = true
            frame.outlineProvider = roundOutline(dp(24).toFloat())
            frame.minimumHeight = dp(240)
            frame.isClickable = true
            frame.isFocusable = true
            frame.setOnClickListener { act("ad", row = rowKey, what = "open") }
        }

        fun bind(r: HomeRow, h: AdHero) {
            rowKey = r.key
            frame.dropAll()
            frame.background = focusable(rounded(colors.surface, dp(24).toFloat(), max(1, dp(1)), adEdge))
            frame.contentDescription = h.title
            val rtl = model?.rtl == true
            if (h.from != null && h.to != null) {
                // The accent's glow on the end half, fading into the card toward the text.
                val toStart = if (rtl) GradientDrawable.Orientation.LEFT_RIGHT else GradientDrawable.Orientation.RIGHT_LEFT
                frame.addView(View(ctx).apply {
                    alpha = 0.6f
                    background = GradientDrawable(toStart, intArrayOf(h.from, h.to))
                }, FrameLayout.LayoutParams((width() - dp(32)) / 2, MATCH, Gravity.END))
                val s = colors.surface
                frame.addView(View(ctx).apply {
                    background = GradientDrawable(toStart, intArrayOf(Color.TRANSPARENT, s))
                }, FrameLayout.LayoutParams((width() - dp(32)) * 2 / 3, MATCH, Gravity.END))
            }
            val col = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(28), dp(32), dp(28), dp(32))
            }
            val eyebrow = FlowRow(ctx, dp(8), dp(4)).apply { middle = true }
            eyebrow.addView(label("", 10.5f, bold = true, lines = 1).apply {
                caps(this, h.eyebrow, 0.32f)
                setTextColor(colors.subtle)
            })
            for (p in h.pills) eyebrow.addView(adPillView(p, small = false))
            col.addView(eyebrow)
            col.addView(label(h.title, 42f, lines = 2).apply {
                typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                setTextColor(colors.ink)
                setLineSpacing(0f, 1.05f)
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(12) })
            h.subtitle?.let {
                col.addView(label(it, 14.5f).apply {
                    setTextColor(colors.muted)
                    setLineSpacing(0f, 1.35f)
                }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(12) })
            }
            val actions = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            actions.addView(pkButtonView(h.button, dp(36), dp(18).toFloat()) { act("ad", row = rowKey, what = "btn") }.apply {
                setPaddingRelative(dp(20), 0, dp(20), 0)
            })
            val link = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPaddingRelative(dp(16), dp(8), dp(12), dp(8))
            }
            link.addView(label(h.link, 12.5f, lines = 1).apply { setTextColor(colors.muted) })
            link.addView(ImageView(ctx).apply {
                setImageDrawable(icon(R.drawable.ic_chevron_right, colors.muted))
                scaleX = if (rtl) -1f else 1f
            }, LinearLayout.LayoutParams(dp(13), dp(13)).apply { marginStart = dp(4) })
            actions.addView(link)
            col.addView(actions, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(28) })
            frame.addView(col, FrameLayout.LayoutParams(MATCH, wrap, Gravity.CENTER_VERTICAL))
        }
    }

    /** "Top on stremio-addons.net" and its cards (see [AdCommunity]). */
    private inner class AdCommunityHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private var rowKey = ""

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, wrap).apply { bottomMargin = dp(44) }
        }

        private var strip: android.widget.HorizontalScrollView? = null

        fun bind(r: HomeRow, c: AdCommunity) {
            val keepX = if (rowKey == r.key) strip?.scrollX ?: 0 else 0
            strip = null
            rowKey = r.key
            col.dropAll()
            val head = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPaddingRelative(dp(16), 0, dp(16), 0)
            }
            val logoBox = FrameLayout(ctx).apply {
                clipToOutline = true
                outlineProvider = roundOutline(dp(28).toFloat())
                background = rounded(colors.surface, dp(28).toFloat(), max(1, dp(1)), adEdge)
                isClickable = true
                isFocusable = true
                contentDescription = c.site
                setOnClickListener { act("ad", row = rowKey, what = "site") }
            }
            c.logo?.let { u ->
                val img = NetImage(ctx)
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                logoBox.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, listOf(u), dp(56), dp(56))
            }
            head.addView(logoBox, LinearLayout.LayoutParams(dp(56), dp(56)))
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(label("", 10.5f, bold = true, lines = 1).apply {
                caps(this, c.kicker, 0.22f)
                setTextColor(colors.accent)
            })
            texts.addView(label("", 22f, lines = 2).apply {
                val sb = android.text.SpannableStringBuilder(c.title + " ")
                val at = sb.length
                sb.append(c.site)
                sb.setSpan(android.text.style.StyleSpan(Typeface.BOLD), at, sb.length, 0)
                sb.setSpan(android.text.style.UnderlineSpan(), at, sb.length, 0)
                text = sb
                setTextColor(colors.ink)
                isClickable = true
                setOnClickListener { act("ad", row = rowKey, what = "site") }
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(4) })
            texts.addView(label(c.sub, 12.5f, lines = 2).apply { setTextColor(colors.muted) }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(4) })
            head.addView(texts, LinearLayout.LayoutParams(0, wrap, 1f).apply { marginStart = dp(16) })
            col.addView(head)
            val bar = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPaddingRelative(dp(16), 0, dp(16), 0)
            }
            val tabs = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(dp(4), dp(4), dp(4), dp(4))
                background = rounded(withAlpha(colors.canvas, 0.4f), dp(20).toFloat(), max(1, dp(1)), adEdge)
            }
            for (tb in c.tabs) {
                tabs.addView(label(tb.label, 12f, bold = true, lines = 1).apply {
                    gravity = Gravity.CENTER
                    setPaddingRelative(dp(12), 0, dp(12), 0)
                    setTextColor(if (tb.on) colors.canvas else colors.muted)
                    background = focusable(rounded(if (tb.on) colors.ink else Color.TRANSPARENT, dp(16).toFloat()))
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { act("ad", row = rowKey, what = "tab:" + tb.id) }
                }, LinearLayout.LayoutParams(wrap, dp(32)))
            }
            bar.addView(tabs)
            bar.addView(pkButtonView(PkButton("site", c.browse, "soft", "external"), dp(36), dp(18).toFloat()) { act("ad", row = rowKey, what = "site") }.apply {
                setPaddingRelative(dp(12), 0, dp(14), 0)
            }, LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(8) })
            col.addView(bar, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(16) })
            val body: View = when (c.state) {
                "ok" -> {
                    val scroll = android.widget.HorizontalScrollView(ctx).apply {
                        isHorizontalScrollBarEnabled = false
                        overScrollMode = View.OVER_SCROLL_NEVER
                        clipToPadding = false
                        setPadding(dp(16), 0, dp(16), 0)
                    }
                    val line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                    c.cards.forEachIndexed { i, cc -> line.addView(card(cc, i), LinearLayout.LayoutParams(dp(280), MATCH).apply { if (i > 0) marginStart = dp(12) }) }
                    scroll.addView(line)
                    strip = scroll
                    if (keepX > 0) scroll.post { scroll.scrollTo(keepX, 0) }
                    scroll
                }
                "loading" -> LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    setPaddingRelative(dp(16), 0, 0, 0)
                    for (i in 0 until 3) addView(View(ctx).apply { background = rounded(withAlpha(colors.surface, 0.4f), dp(16).toFloat(), max(1, dp(1)), adEdge) },
                        LinearLayout.LayoutParams(dp(280), dp(216)).apply { if (i > 0) marginStart = dp(12) })
                }
                else -> label(c.message ?: "", 13f).apply {
                    setTextColor(colors.muted)
                    gravity = Gravity.CENTER
                    textAlignment = View.TEXT_ALIGNMENT_CENTER
                    setPadding(dp(20), dp(28), dp(20), dp(28))
                    background = rounded(withAlpha(colors.canvas, 0.3f), dp(16).toFloat(), max(1, dp(1)), adEdge)
                }
            }
            col.addView(body, LinearLayout.LayoutParams(MATCH, wrap).apply {
                topMargin = dp(16)
                if (c.state != "ok" && c.state != "loading") {
                    marginStart = dp(16)
                    marginEnd = dp(16)
                }
            })
        }

        private fun card(c: AdCommunityCard, i: Int): View {
            val card = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                clipToOutline = true
                outlineProvider = roundOutline(dp(16).toFloat())
                background = focusable(rounded(colors.surface, dp(16).toFloat(), max(1, dp(1)), adEdge))
                isClickable = true
                isFocusable = true
                contentDescription = c.name
                setOnClickListener { act("ad", row = rowKey, what = "card", i = i) }
            }
            val top = FrameLayout(ctx)
            val s = colors.surface
            top.background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(s, toward(s, colors.ink, 0.06f)))
            c.background?.let { u ->
                val img = NetImage(ctx)
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                top.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, listOf(u), dp(280), dp(96))
            }
            top.addView(View(ctx).apply {
                background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(s, withAlpha(s, 0.3f), Color.TRANSPARENT))
            }, FrameLayout.LayoutParams(MATCH, MATCH))
            c.stars?.let { st ->
                top.addView(adPillView(AdPill(st, "star", "star"), small = false), FrameLayout.LayoutParams(wrap, wrap, Gravity.TOP or Gravity.END).apply {
                    topMargin = dp(10)
                    marginEnd = dp(10)
                })
            }
            c.logo?.let { u ->
                val box = FrameLayout(ctx).apply {
                    clipToOutline = true
                    outlineProvider = roundOutline(dp(8).toFloat())
                    background = rounded(withAlpha(colors.canvas, 0.8f), dp(8).toFloat(), max(1, dp(1)), adEdge)
                    setPadding(dp(4), dp(4), dp(4), dp(4))
                }
                val img = NetImage(ctx)
                img.scaleType = ImageView.ScaleType.FIT_CENTER
                box.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, listOf(u), dp(32), dp(32), alpha = true) { ok -> if (!ok) box.visibility = View.GONE }
                top.addView(box, FrameLayout.LayoutParams(dp(40), dp(40), Gravity.BOTTOM or Gravity.START).apply {
                    marginStart = dp(10)
                    bottomMargin = dp(10)
                })
            }
            card.addView(top, LinearLayout.LayoutParams(MATCH, dp(96)))
            val body = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                minimumHeight = dp(120)
            }
            body.addView(label(c.name, 14f, bold = true, lines = 2).apply { setTextColor(colors.ink) })
            c.desc?.let { body.addView(label(it, 11.5f, lines = 2).apply { setTextColor(colors.subtle) }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(2) }) }
            body.addView(View(ctx), LinearLayout.LayoutParams(MATCH, 0, 1f))
            val foot = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val types = FlowRow(ctx, dp(4), dp(4))
            for (t in c.types) types.addView(label("", 9.5f, bold = true, lines = 1).apply {
                caps(this, t, 0.14f)
                setTextColor(colors.subtle)
                setPaddingRelative(dp(6), dp(2), dp(6), dp(2))
                background = rounded(withAlpha(colors.surface, 0.6f), dp(8).toFloat())
            })
            foot.addView(types, LinearLayout.LayoutParams(0, wrap, 1f))
            val btn = if (c.installed != null) PkButton("installed", c.installed, "accentpill", "check")
            else PkButton("install", c.install ?: "", "ink", "plus", c.busy)
            foot.addView(pkButtonView(btn, dp(32), dp(16).toFloat()) { act("ad", row = rowKey, what = "install", i = i) }.apply {
                setPaddingRelative(dp(10), 0, dp(12), 0)
            })
            body.addView(foot, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
            card.addView(body, LinearLayout.LayoutParams(MATCH, 0, 1f))
            return card
        }
    }

    /** A section's heading (see [AdHead]). */
    private fun adHeading(title: String, blurb: String?, action: String?, open: Boolean, size: Float, onAction: (() -> Unit)?): View {
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(12))
        }
        val line = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
        }
        val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(label(title, size, lines = 2).apply {
            typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            setTextColor(colors.ink)
        })
        blurb?.let { texts.addView(label(it, 14f).apply { setTextColor(colors.muted); setLineSpacing(0f, 1.3f) }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(6) }) }
        line.addView(texts, LinearLayout.LayoutParams(0, wrap, 1f))
        if (action != null && onAction != null) {
            val a = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPaddingRelative(dp(10), dp(6), 0, dp(4))
                isClickable = true
                isFocusable = true
                background = focusable(rounded(Color.TRANSPARENT, dp(10).toFloat()))
                setOnClickListener { onAction() }
            }
            a.addView(label(action, 12.5f, bold = true, lines = 1).apply { setTextColor(colors.accent) })
            a.addView(ImageView(ctx).apply {
                setImageDrawable(icon(R.drawable.ic_chevron_right, colors.accent))
                rotation = if (open) 90f else 0f
                scaleX = if (!open && model?.rtl == true) -1f else 1f
            }, LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginStart = dp(2) })
            line.addView(a)
        }
        box.addView(line)
        box.addView(View(ctx).apply { setBackgroundColor(withAlpha(colors.ink, 0.07f)) }, LinearLayout.LayoutParams(MATCH, max(1, dp(1))).apply { topMargin = dp(12) })
        return box
    }

    private inner class AdHeadHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        private var rowKey = ""

        init {
            pkCard(frame, 20)
        }

        fun bind(r: HomeRow, h: AdHead) {
            rowKey = r.key
            frame.dropAll()
            frame.addView(adHeading(h.title, h.blurb, h.action, h.open, h.size) { act("ad", row = rowKey, what = "more") })
        }
    }

    /** "Browse by category": six coloured tiles (see [AdCategories]). */
    private inner class AdCatsHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private var rowKey = ""

        init {
            col.orientation = LinearLayout.VERTICAL
            pkCard(col, 44)
        }

        fun bind(r: HomeRow, c: AdCategories) {
            rowKey = r.key
            col.dropAll()
            col.addView(adHeading(c.title, c.blurb, null, false, 26f, null), LinearLayout.LayoutParams(MATCH, wrap).apply { bottomMargin = dp(20) })
            var i = 0
            while (i < c.tiles.size) {
                val line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                for (k in 0 until 2) {
                    val idx = i + k
                    val v = if (idx < c.tiles.size) tile(c.tiles[idx], idx) else View(ctx)
                    line.addView(v, LinearLayout.LayoutParams(0, dp(120), 1f).apply { if (k > 0) marginStart = dp(12) })
                }
                col.addView(line, LinearLayout.LayoutParams(MATCH, wrap).apply { if (i > 0) topMargin = dp(12) })
                i += 2
            }
        }

        private fun tile(t: AdCategory, i: Int): View {
            val f = FrameLayout(ctx).apply {
                clipToOutline = true
                outlineProvider = roundOutline(dp(16).toFloat())
                isClickable = true
                isFocusable = true
                contentDescription = t.title
                setOnClickListener { act("ad", row = rowKey, what = "cat", i = i) }
            }
            val base = colors.canvas
            f.background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(t.from ?: colors.surface, t.to ?: colors.surface)).apply {
                cornerRadius = dp(16).toFloat()
            }
            f.addView(View(ctx).apply {
                background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(withAlpha(base, 0.85f), withAlpha(base, 0.3f), Color.TRANSPARENT))
            }, FrameLayout.LayoutParams(MATCH, MATCH))
            t.icon?.let { u ->
                val img = NetImage(ctx)
                img.scaleType = ImageView.ScaleType.FIT_CENTER
                img.alpha = 0.55f
                f.addView(img, FrameLayout.LayoutParams(dp(56), dp(56), Gravity.TOP or Gravity.END).apply {
                    topMargin = dp(14)
                    marginEnd = dp(14)
                })
                images.load(img, listOf(u), dp(56), dp(56), alpha = true)
            }
            val texts = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), 0, dp(16), dp(14))
            }
            texts.addView(label(t.title, 19f, lines = 1).apply {
                typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                setTextColor(colors.ink)
            })
            texts.addView(label(t.blurb, 12f, lines = 2).apply { setTextColor(colors.muted) })
            f.addView(texts, FrameLayout.LayoutParams(MATCH, wrap, Gravity.BOTTOM))
            f.foreground = rounded(Color.TRANSPARENT, dp(16).toFloat(), max(1, dp(1)), adEdge)
            return f
        }
    }

    /** An installed addon, as the page's phone row: its logo and name, then its controls. */
    private inner class AdInstalledHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val card = itemView as LinearLayout
        private var rowKey = ""

        init {
            card.orientation = LinearLayout.VERTICAL
            pkCard(card, 8)
            card.setPadding(dp(14), dp(12), dp(14), dp(12))
            card.isClickable = true
            card.isFocusable = true
            card.setOnClickListener { act("ad", row = rowKey, what = "open") }
        }

        fun bind(r: HomeRow, a: AdInstalled) {
            rowKey = r.key
            card.dropAll()
            card.background = focusable(rounded(colors.surface, dp(12).toFloat(), max(1, dp(1)), adEdge))
            card.alpha = if (a.dim) 0.6f else 1f
            card.contentDescription = a.name
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            top.addView(adLogoView(a.logo, 36).apply { alpha = if (a.enabled) 1f else 0.45f }, LinearLayout.LayoutParams(dp(36), dp(36)))
            val texts = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                alpha = if (a.enabled) 1f else 0.55f
            }
            texts.addView(label(a.name, 14f, lines = 2).apply { setTextColor(colors.ink) })
            texts.addView(label(a.sub, 11.5f, lines = 1).apply { setTextColor(colors.subtle) }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(2) })
            top.addView(texts, LinearLayout.LayoutParams(0, wrap, 1f).apply { marginStart = dp(12) })
            card.addView(top)
            val controls = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            if (!a.dim) {
                // The switch: on (accent) or off.
                val sw = FrameLayout(ctx).apply {
                    background = focusable(rounded(if (a.enabled) colors.accent else withAlpha(colors.ink, 0.18f), dp(11).toFloat()))
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { act("ad", row = rowKey, what = "toggle") }
                }
                val knob = colors.ink
                sw.addView(View(ctx).apply {
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(knob) }
                }, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER_VERTICAL or (if (a.enabled) Gravity.END else Gravity.START)).apply {
                    marginStart = dp(3)
                    marginEnd = dp(3)
                })
                controls.addView(sw, LinearLayout.LayoutParams(dp(40), dp(22)))
                a.manage?.let { m ->
                    controls.addView(pkButtonView(PkButton("manage", m, "raised", "settings"), dp(30), dp(15).toFloat()) { act("ad", row = rowKey, what = "manage") }.apply {
                        setPaddingRelative(dp(12), 0, dp(14), 0)
                    }, LinearLayout.LayoutParams(wrap, wrap).apply { marginStart = dp(8) })
                }
            }
            controls.addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
            controls.addView(pkButtonView(a.pill, dp(30), dp(15).toFloat()) { act("ad", row = rowKey, what = "remove") }.apply {
                setPaddingRelative(dp(12), 0, dp(14), 0)
            })
            card.addView(controls, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(12) })
        }
    }

    /** An addon's page, its top (see [AdDetail]). */
    private inner class AdDetailHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        private var rowKey = ""

        init {
            frame.layoutParams = RecyclerView.LayoutParams(MATCH, wrap)
        }

        fun bind(r: HomeRow, d: AdDetail) {
            rowKey = r.key
            frame.dropAll()
            val c = colors.canvas
            frame.background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(colors.surface, c, c))
            if (d.background != null) {
                val img = NetImage(ctx)
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                img.alpha = 0.55f
                frame.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, listOf(d.background), width(), dp(420))
                frame.addView(View(ctx).apply {
                    background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(c, withAlpha(c, 0.88f), withAlpha(c, 0.6f), withAlpha(c, 0.3f)))
                }, FrameLayout.LayoutParams(MATCH, MATCH))
            } else if (d.glow != null) {
                // The logo, stretched huge and faint: the page's blurred glow.
                val img = NetImage(ctx)
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                img.alpha = 0.28f
                if (android.os.Build.VERSION.SDK_INT >= 31) {
                    img.setRenderEffect(android.graphics.RenderEffect.createBlurEffect(dp(40).toFloat(), dp(40).toFloat(), android.graphics.Shader.TileMode.CLAMP))
                }
                frame.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, listOf(d.glow), dp(12), dp(12), alpha = true)
                frame.addView(View(ctx).apply {
                    background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.TRANSPARENT, withAlpha(c, 0.24f)))
                }, FrameLayout.LayoutParams(MATCH, MATCH))
            }
            frame.addView(View(ctx).apply {
                background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, withAlpha(c, 0.28f)))
            }, FrameLayout.LayoutParams(MATCH, MATCH))
            val col = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(20), dp(96), dp(20), dp(24))
            }
            col.addView(adLogoView(d.logo, 96), LinearLayout.LayoutParams(dp(96), dp(96)))
            col.addView(label("", 11f, bold = true, lines = 3).apply {
                caps(this, d.eyebrow, 0.2f)
                setTextColor(colors.subtle)
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(20) })
            col.addView(label(d.name, 28f).apply {
                typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                setTextColor(colors.ink)
                setLineSpacing(0f, 1.1f)
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
            d.rising?.let { col.addView(adPillView(it, small = false), LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(8) }) }
            d.desc?.let { text ->
                val desc = label(text, 14f).apply {
                    setTextColor(colors.muted)
                    setLineSpacing(0f, 1.4f)
                    if (!d.descOpen) {
                        maxLines = 3
                        ellipsize = TextUtils.TruncateAt.END
                    }
                }
                col.addView(desc, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(10) })
                val toggle = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(6), dp(8), dp(4))
                    isClickable = true
                    isFocusable = true
                    visibility = View.GONE
                    setOnClickListener { act("ad", row = rowKey, what = "desc") }
                }
                toggle.addView(label("", 11.5f, bold = true, lines = 1).apply {
                    caps(this, if (d.descOpen) d.less else d.more, 0.18f)
                    setTextColor(colors.accent)
                })
                toggle.addView(ImageView(ctx).apply {
                    setImageDrawable(icon(R.drawable.ic_chevron_down, colors.accent))
                    rotation = if (d.descOpen) 180f else 0f
                }, LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginStart = dp(4) })
                col.addView(toggle, LinearLayout.LayoutParams(wrap, wrap))
                // "View more" only when the text runs past its three lines.
                desc.post {
                    val l = desc.layout ?: return@post
                    val cut = l.lineCount > 0 && l.getEllipsisCount(l.lineCount - 1) > 0
                    toggle.visibility = if (d.descOpen || cut) View.VISIBLE else View.GONE
                }
            }
            val buttons = FlowRow(ctx, dp(8), dp(8)).apply { middle = true }
            for (b in d.buttons) {
                buttons.addView(pkButtonView(b, dp(44), dp(22).toFloat()) { act("ad", row = rowKey, what = "btn:" + b.id) }.apply {
                    setPaddingRelative(dp(16), 0, dp(18), 0)
                })
            }
            col.addView(buttons, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(16) })
            if (d.tags.isNotEmpty()) {
                val tags = FlowRow(ctx, dp(6), dp(6))
                for (t in d.tags) tags.addView(adPillView(t))
                col.addView(tags, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(12) })
            }
            frame.addView(col, FrameLayout.LayoutParams(MATCH, wrap))
            d.stars?.let { st ->
                val s = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    isClickable = true
                    isFocusable = true
                    setPadding(dp(6), dp(4), dp(6), dp(4))
                    background = focusable(rounded(Color.TRANSPARENT, dp(10).toFloat()))
                    setOnClickListener { act("ad", row = rowKey, what = "btn:rate") }
                }
                s.addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_star, colors.accent)) }, LinearLayout.LayoutParams(dp(22), dp(22)).apply { marginEnd = dp(8) })
                s.addView(label(st, 26f, bold = true, lines = 1).apply { setTextColor(colors.ink) })
                frame.addView(s, FrameLayout.LayoutParams(wrap, wrap, Gravity.TOP or Gravity.END).apply {
                    topMargin = dp(92)
                    marginEnd = dp(16)
                })
            }
        }
    }

    /** "Project information" (see [AdInfo]). */
    private inner class AdInfoHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private var rowKey = ""

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, wrap)
            col.setPadding(dp(20), dp(32), dp(20), dp(32))
        }

        fun bind(r: HomeRow, a: AdInfo) {
            rowKey = r.key
            col.dropAll()
            col.setBackgroundColor(withAlpha(colors.surface, 0.15f))
            val head = FlowRow(ctx, dp(16), dp(4)).apply { middle = true }
            head.addView(label(a.title, 22f, lines = 1).apply {
                typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                setTextColor(colors.ink)
            })
            head.addView(label("", 10.5f, lines = 1).apply {
                caps(this, a.note, 0.22f)
                setTextColor(colors.subtle)
            })
            col.addView(head, LinearLayout.LayoutParams(MATCH, wrap).apply { bottomMargin = dp(24) })
            val line = withAlpha(colors.ink, 0.08f)
            col.addView(View(ctx).apply { setBackgroundColor(line) }, LinearLayout.LayoutParams(MATCH, max(1, dp(1))))
            for ((k, v) in a.stats) {
                val row = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(12), 0, dp(12))
                }
                row.addView(label("", 12f, lines = 1).apply {
                    caps(this, k, 0.16f)
                    setTextColor(colors.subtle)
                })
                row.addView(label(v, 13.5f, lines = 1).apply {
                    setTextColor(colors.ink)
                    gravity = Gravity.END
                    textAlignment = View.TEXT_ALIGNMENT_VIEW_END
                }, LinearLayout.LayoutParams(0, wrap, 1f).apply { marginStart = dp(24) })
                col.addView(row)
                col.addView(View(ctx).apply { setBackgroundColor(line) }, LinearLayout.LayoutParams(MATCH, max(1, dp(1))))
            }
            val urlHead = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            urlHead.addView(label("", 12f, lines = 1).apply {
                caps(this, a.urlLabel, 0.16f)
                setTextColor(colors.subtle)
            }, LinearLayout.LayoutParams(0, wrap, 1f))
            a.copy?.let { cp ->
                urlHead.addView(pkButtonView(PkButton("copy", cp, "soft", "copy", copy = a.url), dp(28), dp(14).toFloat()) { act("ad", row = rowKey, what = "copyurl") }.apply {
                    setPaddingRelative(dp(10), 0, dp(10), 0)
                }, LinearLayout.LayoutParams(wrap, wrap).apply { marginEnd = dp(6) })
            }
            urlHead.addView(pkButtonView(PkButton("reveal", a.reveal, "soft", if (a.copy != null) "eye-off" else "eye"), dp(28), dp(14).toFloat()) { act("ad", row = rowKey, what = "reveal") }.apply {
                setPaddingRelative(dp(10), 0, dp(10), 0)
            })
            col.addView(urlHead, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(32) })
            col.addView(label(a.url, 12.5f).apply {
                mono(this)
                setTextColor(colors.muted)
                setLineSpacing(0f, 1.35f)
                setPadding(dp(16), dp(16), dp(16), dp(16))
                background = rounded(withAlpha(colors.canvas, 0.6f), dp(12).toFloat(), max(1, dp(1)), line)
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(12) })
            a.hint?.let { col.addView(label(it, 11.5f).apply { setTextColor(colors.subtle); setLineSpacing(0f, 1.3f) }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(12) }) }
            col.addView(View(ctx).apply { setBackgroundColor(line) }, LinearLayout.LayoutParams(MATCH, max(1, dp(1))).apply { topMargin = dp(40) })
            col.addView(label(a.foot, 12f).apply {
                setTextColor(colors.subtle)
                gravity = Gravity.CENTER_HORIZONTAL
                textAlignment = View.TEXT_ALIGNMENT_CENTER
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(24) })
            col.addView(label(a.credit, 11.5f).apply {
                setTextColor(colors.subtle)
                gravity = Gravity.CENTER_HORIZONTAL
                textAlignment = View.TEXT_ALIGNMENT_CENTER
                setLineSpacing(0f, 1.35f)
                isClickable = true
                setOnClickListener { act("ad", row = rowKey, what = "site") }
            }, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
        }
    }

    /** "Documentation" (see [AdDoc]). */
    private inner class AdDocHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private var rowKey = ""

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, wrap)
            col.setPadding(dp(20), dp(32), dp(20), dp(8))
        }

        fun bind(r: HomeRow, d: AdDoc) {
            rowKey = r.key
            col.dropAll()
            col.setBackgroundColor(withAlpha(colors.surface, 0.15f))
            val head = FlowRow(ctx, dp(16), dp(4)).apply { middle = true }
            head.addView(label(d.title, 22f, lines = 1).apply {
                typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                setTextColor(colors.ink)
            })
            head.addView(label("", 10.5f, lines = 1).apply {
                caps(this, d.note, 0.22f)
                setTextColor(colors.subtle)
            })
            col.addView(head, LinearLayout.LayoutParams(MATCH, wrap).apply { bottomMargin = dp(24) })
            val body = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            for ((k, text) in d.parts) {
                val v = when (k) {
                    "h1" -> label(text, 20f).apply { typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL); setTextColor(colors.ink) }
                    "h2" -> label(text, 17f).apply { typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL); setTextColor(colors.ink) }
                    "h3" -> label("", 14f, bold = true).apply { caps(this, text, 0.14f); setTextColor(colors.subtle) }
                    "li" -> label("•  $text", 14f).apply { setTextColor(colors.muted); setLineSpacing(0f, 1.4f) }
                    "code" -> label(text, 12.5f).apply {
                        mono(this)
                        setTextColor(colors.muted)
                        setPadding(dp(12), dp(10), dp(12), dp(10))
                        background = rounded(withAlpha(colors.canvas, 0.6f), dp(10).toFloat())
                    }
                    else -> label(text, 14f).apply { setTextColor(colors.muted); setLineSpacing(0f, 1.4f) }
                }
                val top = when (k) {
                    "h1" -> dp(20)
                    "h2" -> dp(16)
                    "h3" -> dp(14)
                    "li" -> dp(4)
                    else -> dp(10)
                }
                body.addView(v, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = if (body.childCount == 0) 0 else top })
            }
            if (!d.open) {
                // Folded at about the page's 420px, the text fading out at the fold.
                val fold = FrameLayout(ctx)
                fold.addView(body, FrameLayout.LayoutParams(MATCH, wrap))
                val under = toward(colors.canvas, colors.surface, 0.15f)
                fold.addView(View(ctx).apply {
                    background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(under, Color.TRANSPARENT))
                }, FrameLayout.LayoutParams(MATCH, dp(64), Gravity.BOTTOM))
                col.addView(fold, LinearLayout.LayoutParams(MATCH, dp(420)))
            } else {
                col.addView(body)
            }
            val toggle = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(12), dp(8), dp(8))
                isClickable = true
                isFocusable = true
                setOnClickListener { act("ad", row = rowKey, what = "doc") }
            }
            toggle.addView(label("", 11.5f, bold = true, lines = 1).apply {
                caps(this, if (d.open) d.less else d.more, 0.18f)
                setTextColor(colors.accent)
            })
            toggle.addView(ImageView(ctx).apply {
                setImageDrawable(icon(R.drawable.ic_chevron_down, colors.accent))
                rotation = if (d.open) 180f else 0f
            }, LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginStart = dp(4) })
            col.addView(toggle, LinearLayout.LayoutParams(wrap, wrap))
            col.addView(View(ctx).apply { setBackgroundColor(withAlpha(colors.ink, 0.08f)) }, LinearLayout.LayoutParams(MATCH, max(1, dp(1))).apply { topMargin = dp(24) })
        }
    }

    // ---- A toast and a question with a text field --------------------------------------------

    private var toastShown = -1
    private var promptDialog: android.app.AlertDialog? = null
    private var promptKey: String? = null

    private fun bindToast(t: HomeToast?) {
        if (t == null || t.id == toastShown) return
        toastShown = t.id
        if (!isShowing && !wanted) return
        android.widget.Toast.makeText(ctx, t.text, android.widget.Toast.LENGTH_SHORT).show()
    }

    private fun bindPrompt(p: HomePrompt?) {
        if (p == null) {
            promptKey = null
            promptDialog?.let {
                promptDialog = null
                it.dismiss()
            }
            return
        }
        if (p.key == promptKey && promptDialog?.isShowing == true) return
        promptDialog?.dismiss()
        promptKey = p.key
        val field = android.widget.EditText(ctx).apply {
            setText(p.text)
            hint = p.hint
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setSelection(text.length)
        }
        val box = FrameLayout(ctx).apply {
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(field)
        }
        var sent = false
        val dlg = android.app.AlertDialog.Builder(ctx, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(p.title)
            .setView(box)
            .setPositiveButton(p.ok) { _, _ ->
                sent = true
                act("prompt", what = p.key, text = field.text?.toString() ?: "")
            }
            .setNegativeButton(p.cancel, null)
            .create()
        dlg.setOnDismissListener {
            if (promptDialog === dlg) {
                promptDialog = null
                if (!sent) act("prompt", what = p.key)
            }
        }
        promptDialog = dlg
        dlg.show()
        field.requestFocus()
        dlg.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
    }

    // ---- A full-screen step over everything (the picker's: connecting, peer-to-peer…) -----------

    private var stageKey: String? = null
    private var stagePulse: android.animation.ObjectAnimator? = null

    private fun bindStage(s: PkStage?) {
        stagePulse?.cancel()
        stagePulse = null
        if (s == null) {
            stageView.visibility = View.GONE
            stageView.dropAll()
            stageKey = null
            return
        }
        val focusWas = stageView.findFocus()?.tag as? String
        stageView.dropAll()
        stageView.visibility = View.VISIBLE
        stageView.isClickable = true
        stageView.setBackgroundColor(Color.BLACK)
        val art = s.look == "art"
        if (art && s.backdrop.isNotEmpty()) {
            // Small and stretched: the page's blur, on any Android.
            val bg = NetImage(ctx)
            bg.scaleType = ImageView.ScaleType.CENTER_CROP
            bg.alpha = 0.35f
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                bg.setRenderEffect(android.graphics.RenderEffect.createBlurEffect(dp(28).toFloat(), dp(28).toFloat(), android.graphics.Shader.TileMode.CLAMP))
            }
            stageView.addView(bg, FrameLayout.LayoutParams(MATCH, MATCH))
            images.load(bg, s.backdrop, dp(48), dp(27))
            stageView.addView(View(ctx).apply {
                background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(withAlpha(Color.BLACK, 0.68f), withAlpha(Color.BLACK, 0.58f), withAlpha(Color.BLACK, 0.85f)))
            }, FrameLayout.LayoutParams(MATCH, MATCH))
        }
        val scroll = android.widget.ScrollView(ctx).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        val holder = FrameLayout(ctx)
        scroll.addView(holder, FrameLayout.LayoutParams(MATCH, wrap))
        stageView.addView(scroll, FrameLayout.LayoutParams(MATCH, MATCH))
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = if (art) Gravity.CENTER_HORIZONTAL else Gravity.START
        }
        val white = Color.WHITE
        fun text(t: String, size: Float, color: Int, bold: Boolean = false, center: Boolean = art): TextView = label(t, size, bold = bold).apply {
            setTextColor(color)
            if (center) {
                gravity = Gravity.CENTER_HORIZONTAL
                textAlignment = View.TEXT_ALIGNMENT_CENTER
            }
            setLineSpacing(0f, 1.3f)
        }
        fun add(v: View, top: Int, w: Int = MATCH) = col.addView(v, LinearLayout.LayoutParams(w, wrap).apply {
            topMargin = if (col.childCount == 0) 0 else top
            if (art) gravity = Gravity.CENTER_HORIZONTAL
        })
        if (art) {
            s.pill?.let { p ->
                add(label("", 11f, bold = true, lines = 1).apply {
                    caps(this, p.text, 0.24f)
                    setTextColor(pkDanger)
                    setPaddingRelative(dp(12), dp(4), dp(12), dp(4))
                    background = rounded(withAlpha(pkDanger, 0.2f), dp(13).toFloat(), dp(1), withAlpha(pkDanger, 0.4f))
                }, dp(28), wrap)
            }
            if (s.check) {
                val ring = FrameLayout(ctx).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(withAlpha(pkGreen, 0.12f)); setStroke(dp(1), withAlpha(pkGreen, 0.35f)) } }
                val disc = FrameLayout(ctx).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(withAlpha(0xFF34D399.toInt(), 0.9f)) } }
                disc.addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_check, Color.BLACK)) }, FrameLayout.LayoutParams(dp(30), dp(30), Gravity.CENTER))
                ring.addView(disc, FrameLayout.LayoutParams(dp(56), dp(56), Gravity.CENTER))
                col.addView(ring, LinearLayout.LayoutParams(dp(80), dp(80)).apply { gravity = Gravity.CENTER_HORIZONTAL })
            }
            if (s.logo.isNotEmpty() || s.logoText != null) {
                val lw = (width() * 0.72f).toInt()
                val lh = dp(150)
                val wrapBox = FrameLayout(ctx)
                val name = text(s.logoText ?: "", 36f, white).apply { typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL) }
                wrapBox.addView(name, FrameLayout.LayoutParams(MATCH, wrap, Gravity.CENTER))
                if (s.logo.isNotEmpty()) {
                    val img = NetImage(ctx)
                    img.scaleType = ImageView.ScaleType.FIT_CENTER
                    wrapBox.addView(img, FrameLayout.LayoutParams(lw, lh, Gravity.CENTER))
                    name.visibility = View.INVISIBLE
                    images.load(img, s.logo, lw, lh, alpha = true) { ok ->
                        img.visibility = if (ok) View.VISIBLE else View.GONE
                        name.visibility = if (ok) View.GONE else View.VISIBLE
                    }
                }
                add(wrapBox, dp(28))
                stagePulse = android.animation.ObjectAnimator.ofFloat(wrapBox, View.ALPHA, 1f, 0.55f).apply {
                    duration = 1100
                    repeatMode = android.animation.ValueAnimator.REVERSE
                    repeatCount = android.animation.ValueAnimator.INFINITE
                    start()
                }
            }
            s.line?.let { add(text("", 12.5f, withAlpha(white, 0.7f), bold = true).apply { caps(this, it, 0.32f) }, dp(24)) }
            s.title?.let { add(text(it, s.titleSize, white).apply { typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL); setLineSpacing(0f, 1.06f) }, dp(24)) }
            s.body?.let { add(text(it, 14.5f, withAlpha(white, 0.75f)), dp(20)) }
            s.box?.let { b ->
                val box = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER_HORIZONTAL
                    setPadding(dp(18), dp(14), dp(18), dp(14))
                    background = rounded(withAlpha(white, 0.06f), dp(16).toFloat(), dp(1), withAlpha(white, 0.1f))
                }
                box.addView(text(b.title, 13f, withAlpha(white, 0.9f)).apply {
                    mono(this)
                    maxLines = 2
                    ellipsize = TextUtils.TruncateAt.END
                }, LinearLayout.LayoutParams(MATCH, wrap))
                val meta = FlowRow(ctx, dp(12), dp(4)).apply {
                    center = true
                    middle = true
                }
                b.seeders?.let { sd ->
                    val l = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                    l.addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_users, withAlpha(white, 0.8f))) }, LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(5) })
                    l.addView(label(sd, 12f, lines = 1).apply { setTextColor(withAlpha(white, 0.8f)) })
                    meta.addView(l)
                }
                for (m in b.meta) meta.addView(label(m, 12f, lines = 1).apply { setTextColor(withAlpha(white, 0.6f)) })
                if (meta.childCount > 0) box.addView(meta, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = dp(8) })
                add(box, dp(24))
            }
            s.toggle?.let { tg ->
                val l = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    isClickable = true
                    isFocusable = true
                    tag = "toggle"
                    setPadding(dp(8), dp(6), dp(10), dp(6))
                    background = focusable(rounded(Color.TRANSPARENT, dp(10).toFloat()))
                    setOnClickListener { act("stage", what = "toggle") }
                }
                val box = FrameLayout(ctx).apply {
                    background = if (tg.on) rounded(colors.accent, dp(4).toFloat()) else rounded(Color.TRANSPARENT, dp(4).toFloat(), dp(2), withAlpha(white, 0.5f))
                }
                if (tg.on) box.addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_check, colors.canvas)) }, FrameLayout.LayoutParams(dp(12), dp(12), Gravity.CENTER))
                l.addView(box, LinearLayout.LayoutParams(dp(17), dp(17)).apply { marginEnd = dp(10) })
                l.addView(label(tg.label, 13f).apply { setTextColor(withAlpha(white, 0.7f)) })
                l.contentDescription = tg.label
                add(l, dp(20), wrap)
            }
            s.spinner?.let { cap ->
                add(android.widget.ProgressBar(ctx).apply {
                    isIndeterminate = true
                    indeterminateTintList = android.content.res.ColorStateList.valueOf(withAlpha(white, 0.85f))
                }, dp(28), dp(40))
                add(text("", 12.5f, withAlpha(white, 0.7f), bold = true).apply { caps(this, cap, 0.18f) }, dp(10))
            }
            s.notice?.let { add(text(it, 13f, withAlpha(pkAmber200, 0.8f)), dp(20)) }
            s.sub?.let { add(text(it, 14f, withAlpha(white, 0.75f)), dp(10)) }
            s.label?.let { add(text("", 12f, withAlpha(white, 0.45f), bold = true).apply { caps(this, it, 0.2f) }, dp(8)) }
            s.foot?.let { add(text(it, 13f, withAlpha(white, 0.55f)), dp(24)) }
            if (s.buttons.isNotEmpty()) {
                val row = FlowRow(ctx, dp(12), dp(12)).apply {
                    center = true
                    middle = true
                }
                for (b in s.buttons) row.addView(pkButtonView(b, dp(48), dp(12).toFloat()) { act("stage", what = b.id) }.apply { tag = b.id })
                add(row, dp(28))
            }
            col.setPadding(dp(28), dp(56), dp(28), if (s.cancel != null) dp(120) else dp(56))
            holder.addView(col, FrameLayout.LayoutParams(min(width(), dp(640)), wrap, Gravity.CENTER))
            s.cancel?.let { c ->
                val b = pkButtonView(PkButton(c.id, c.label, "glass", "x"), dp(44), dp(22).toFloat()) { act("stage", what = c.id) }
                b.tag = c.id
                b.background = focusable(rounded(withAlpha(Color.BLACK, 0.45f), dp(22).toFloat(), dp(1), withAlpha(white, 0.15f)))
                stageView.addView(b, FrameLayout.LayoutParams(wrap, wrap, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(40) })
            }
        } else {
            // A card on black: "Harbor", the heading, the text, the reasons, then the buttons.
            val card = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(28), dp(28), dp(28), dp(24))
                background = rounded(colors.surface, dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            }
            fun cadd(v: View, top: Int) = card.addView(v, LinearLayout.LayoutParams(MATCH, wrap).apply { topMargin = if (card.childCount == 0) 0 else top })
            s.kicker?.let { cadd(label("", 11f, bold = true, lines = 1).apply { caps(this, it, 0.28f); setTextColor(colors.subtle) }, 0) }
            s.title?.let { cadd(label(it, s.titleSize, bold = true).apply { setTextColor(colors.ink); setLineSpacing(0f, 1.15f) }, dp(12)) }
            s.body?.let { cadd(label(it, 14f).apply { setTextColor(colors.muted); setLineSpacing(0f, 1.35f) }, dp(12)) }
            s.bullets.forEachIndexed { i, b -> cadd(label(b, 13.5f).apply { setTextColor(colors.muted); setLineSpacing(0f, 1.3f) }, if (i == 0) dp(12) else dp(6)) }
            s.buttons.forEachIndexed { i, b ->
                val v = pkButtonView(b, dp(if (b.style == "link") 40 else 44), dp(22).toFloat()) { act("stage", what = b.id) }
                v.tag = b.id
                cadd(v, if (i == 0) dp(28) else if (b.style == "link") dp(4) else dp(10))
            }
            holder.addView(card, FrameLayout.LayoutParams(min(width() - dp(48), dp(448)), wrap, Gravity.CENTER).apply {
                topMargin = dp(32)
                bottomMargin = dp(32)
            })
        }
        // The D-pad starts on the first button (or where it was, when the step only changed).
        val key = (s.title ?: "") + "|" + (s.spinner ?: "")
        val again = key == stageKey
        stageKey = key
        stageView.post {
            val target = (if (again && focusWas != null) stageView.findViewWithTag<View>(focusWas) else null)
                ?: s.buttons.firstOrNull()?.let { stageView.findViewWithTag<View>(it.id) }
                ?: s.cancel?.let { stageView.findViewWithTag<View>(it.id) }
            if (isShowing) target?.requestFocus()
        }
    }

    // ---- Live TV's guide ------------------------------------------------------------------------

    /** How far the guide's hours are scrolled (px), shared by its ruler and every row. */
    private var guideX = -1f
    private var guideKey = 0L
    private val guideStrips = java.util.Collections.newSetFromMap(java.util.WeakHashMap<View, Boolean>())
    private val guidePxPerMs get() = dp(5) / 60_000f
    private val guideCol get() = dp(124)
    private val guideRowH get() = dp(76)
    private var guideAskedMore = -1

    private fun guideScrollBy(g: HomeGuide, dx: Float, viewW: Int) {
        val total = (g.end - g.start) * guidePxPerMs
        val max = (total - viewW).coerceAtLeast(0f)
        val next = (guideX + dx).coerceIn(0f, max)
        if (next != guideX) {
            guideX = next
            guideStrips.forEach { it.invalidate() }
        }
    }

    /** The programmes' area of a row (or the ruler's): drawn here, scrolled sideways together. */
    private inner class GuideStrip(private val ruler: Boolean) : View(ctx) {
        var guide: HomeGuide? = null
        var row = -1
        private fun dpf(v: Float) = v * ctx.resources.displayMetrics.density
        private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        private val text = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        private val rect = android.graphics.RectF()
        private val scroller = android.widget.OverScroller(ctx)
        private var lastFlingX = 0
        private val detector = android.view.GestureDetector(ctx, object : android.view.GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: android.view.MotionEvent): Boolean {
                scroller.forceFinished(true)
                return true
            }

            override fun onScroll(e1: android.view.MotionEvent?, e2: android.view.MotionEvent, dx: Float, dy: Float): Boolean {
                if (kotlin.math.abs(dx) < kotlin.math.abs(dy)) return false
                parent?.requestDisallowInterceptTouchEvent(true)
                guide?.let { guideScrollBy(it, if (layoutDirection == LAYOUT_DIRECTION_RTL) -dx else dx, width) }
                return true
            }

            override fun onFling(e1: android.view.MotionEvent?, e2: android.view.MotionEvent, vx: Float, vy: Float): Boolean {
                if (kotlin.math.abs(vx) < kotlin.math.abs(vy)) return false
                lastFlingX = 0
                scroller.fling(0, 0, (if (layoutDirection == LAYOUT_DIRECTION_RTL) vx else -vx).toInt(), 0, Int.MIN_VALUE, Int.MAX_VALUE, 0, 0)
                postInvalidateOnAnimation()
                return true
            }

            override fun onSingleTapUp(e: android.view.MotionEvent): Boolean {
                val g = guide ?: return false
                if (ruler || row < 0) return false
                val ch = g.channels.getOrNull(row) ?: return false
                val x = guideX + (if (layoutDirection == LAYOUT_DIRECTION_RTL) width - e.x else e.x)
                val at = g.start + (x / guidePxPerMs).toLong()
                val pi = ch.programs.indexOfFirst { at >= it.s && at < it.e }
                if (pi >= 0) act("guide", what = "pg", i = row, text = pi.toString()) else act("guide", what = "ch", i = row)
                return true
            }
        })

        init {
            guideStrips.add(this)
        }

        @android.annotation.SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(event: android.view.MotionEvent): Boolean {
            if (event.actionMasked == android.view.MotionEvent.ACTION_UP || event.actionMasked == android.view.MotionEvent.ACTION_CANCEL) {
                parent?.requestDisallowInterceptTouchEvent(false)
            }
            return detector.onTouchEvent(event) || super.onTouchEvent(event)
        }

        override fun onDraw(canvas: android.graphics.Canvas) {
            val g = guide ?: return
            if (scroller.computeScrollOffset()) {
                val cx = scroller.currX
                guideScrollBy(g, (cx - lastFlingX).toFloat(), width)
                lastFlingX = cx
                postInvalidateOnAnimation()
            }
            val rtl = layoutDirection == LAYOUT_DIRECTION_RTL
            fun sx(ms: Long): Float {
                val x = (ms - g.start) * guidePxPerMs - guideX
                return if (rtl) width - x else x
            }
            if (ruler) {
                text.textSize = dp(11).toFloat()
                text.color = colors.subtle
                text.typeface = Typeface.DEFAULT_BOLD
                for (t in g.ticks) {
                    val x = sx(t.at)
                    if (x < -dp(80) || x > width + dp(80)) continue
                    paint.color = withAlpha(colors.ink, 0.12f)
                    canvas.drawRect(x, height - dp(10).toFloat(), x + dp(1), height.toFloat(), paint)
                    canvas.drawText(t.label, if (rtl) x - dp(6) - text.measureText(t.label) else x + dp(6), height / 2f + dp(4), text)
                }
            } else {
                val ch = g.channels.getOrNull(row) ?: return
                paint.color = withAlpha(colors.ink, 0.05f)
                canvas.drawRect(0f, height - dp(1).toFloat(), width.toFloat(), height.toFloat(), paint)
                if (ch.programs.isEmpty()) {
                    text.textSize = dpf(11.5f)
                    text.color = colors.subtle
                    text.typeface = Typeface.DEFAULT
                    val s = g.label("none", "No program info")
                    canvas.drawText(s, if (rtl) width - dp(12) - text.measureText(s) else dp(12).toFloat(), height / 2f + dp(4), text)
                }
                for (p in ch.programs) {
                    val a = sx(p.s)
                    val b = sx(p.e)
                    val l = minOf(a, b) + dp(3)
                    val r = maxOf(a, b) - dp(3)
                    if (r < 0 || l > width || r - l < dp(4)) continue
                    val past = p.e <= g.now
                    val live = !past && p.s <= g.now
                    rect.set(l, dp(4).toFloat(), r, height - dp(4).toFloat())
                    val red = liveRed
                    paint.style = android.graphics.Paint.Style.FILL
                    paint.color = when {
                        live -> withAlpha(red, 0.15f)
                        p.replay -> withAlpha(colors.surface, 0.7f)
                        past -> withAlpha(colors.surface, 0.18f)
                        else -> withAlpha(colors.surface, 0.85f)
                    }
                    canvas.drawRoundRect(rect, dp(8).toFloat(), dp(8).toFloat(), paint)
                    paint.style = android.graphics.Paint.Style.STROKE
                    paint.strokeWidth = dp(1).toFloat()
                    paint.color = when {
                        live -> withAlpha(red, 0.45f)
                        p.replay -> withAlpha(colors.accent, 0.35f)
                        past -> withAlpha(colors.ink, 0.04f)
                        else -> withAlpha(colors.ink, 0.1f)
                    }
                    canvas.drawRoundRect(rect, dp(8).toFloat(), dp(8).toFloat(), paint)
                    paint.style = android.graphics.Paint.Style.FILL
                    val w = r - l
                    val pad = dp(10)
                    val inner = (w - 2 * pad).coerceAtLeast(0f)
                    canvas.save()
                    canvas.clipRect(rect)
                    text.typeface = Typeface.DEFAULT_BOLD
                    text.textSize = (if (w < dp(40)) dp(11) else dpf(12.5f)).toFloat()
                    text.color = if (past && !p.replay) withAlpha(colors.muted, 0.6f) else if (past) colors.muted else colors.ink
                    val title = TextUtils.ellipsize(p.title, text, inner, TextUtils.TruncateAt.END).toString()
                    val tx = if (rtl) r - pad - text.measureText(title) else l + pad
                    canvas.drawText(title, tx, dp(24).toFloat(), text)
                    if (w >= dp(70)) {
                        text.typeface = Typeface.DEFAULT
                        text.textSize = dpf(10.5f)
                        text.color = colors.subtle
                        val times = "${p.from}  ${p.to}"
                        val ttx = if (rtl) r - pad - text.measureText(times) else l + pad
                        canvas.drawText(times, ttx, height - dp(16).toFloat(), text)
                        val badge = when {
                            live -> g.label("live", "Live")
                            p.replay -> g.label("replay", "Replay")
                            past -> g.label("ended", "Ended")
                            else -> null
                        }
                        if (badge != null && w >= dp(140)) {
                            text.typeface = Typeface.DEFAULT_BOLD
                            text.textSize = dpf(8.5f)
                            val bw = text.measureText(badge.uppercase()) + dp(10)
                            val br = if (rtl) l + pad + bw else r - pad
                            val bl = br - bw
                            rect.set(bl, height - dp(28).toFloat(), br, height - dp(14).toFloat())
                            paint.color = when {
                                live -> withAlpha(red, 0.8f)
                                p.replay -> withAlpha(colors.accent, 0.2f)
                                else -> withAlpha(colors.canvas, 0.55f)
                            }
                            canvas.drawRoundRect(rect, dp(7).toFloat(), dp(7).toFloat(), paint)
                            text.color = when {
                                live -> colors.canvas
                                p.replay -> colors.accent
                                else -> colors.subtle
                            }
                            canvas.drawText(badge.uppercase(), bl + dp(5), height - dp(18).toFloat(), text)
                        }
                    }
                    canvas.restore()
                }
            }
            // Now.
            if (g.now in g.start until g.end) {
                val x = sx(g.now)
                paint.color = liveRed
                canvas.drawRect(x, 0f, x + dp(1), height.toFloat(), paint)
            }
        }
    }

    /** The guide's top: the day, then the hours. */
    private inner class GuideRulerHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val line = itemView as LinearLayout
        private val day = label("", 11f, bold = true, lines = 1)
        private val strip = GuideStrip(true)

        init {
            line.orientation = LinearLayout.HORIZONTAL
            line.layoutParams = RecyclerView.LayoutParams(MATCH, dp(52))
            day.gravity = Gravity.CENTER_VERTICAL
            day.setPaddingRelative(dp(12), 0, dp(8), 0)
            line.addView(day, LinearLayout.LayoutParams(guideCol, MATCH))
            line.addView(strip, LinearLayout.LayoutParams(0, MATCH, 1f))
        }

        fun bind(g: HomeGuide) {
            val rtl = model?.rtl == true
            line.setBackgroundColor(colors.surface)
            day.text = if (rtl) g.day else g.day.uppercase()
            day.letterSpacing = if (rtl) 0f else 0.2f
            day.setTextColor(colors.subtle)
            day.background = GradientDrawable().also { it.setColor(colors.surface); it.setStroke(0, 0) }
            // A new window (or the first): "now" a little in from the start.
            if (guideX < 0f || guideKey != g.start) {
                guideKey = g.start
                guideX = ((g.now - g.start) * guidePxPerMs - (width() - guideCol) / 4f).coerceAtLeast(0f)
            }
            strip.guide = g
            strip.invalidate()
        }
    }

    /** A channel's line: its number, logo and name (a tap plays it), then its programmes. */
    private inner class GuideRowHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val line = itemView as LinearLayout
        private val cell = LinearLayout(ctx)
        private val logo = NetImage(ctx)
        private val number = label("", 10.5f, bold = true, lines = 1)
        private val name = label("", 12f, bold = true, lines = 2)
        private val strip = GuideStrip(false)
        private var index = -1

        init {
            line.orientation = LinearLayout.HORIZONTAL
            line.layoutParams = RecyclerView.LayoutParams(MATCH, guideRowH)
            cell.orientation = LinearLayout.HORIZONTAL
            cell.gravity = Gravity.CENTER_VERTICAL
            cell.setPaddingRelative(dp(10), 0, dp(8), 0)
            cell.isClickable = true
            cell.isFocusable = true
            cell.setOnClickListener { if (index >= 0) act("guide", what = "ch", i = index) }
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            logo.scaleType = ImageView.ScaleType.FIT_START
            texts.addView(logo, LinearLayout.LayoutParams(dp(56), dp(22)))
            texts.addView(name, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            cell.addView(number, LinearLayout.LayoutParams(dp(26), ViewGroup.LayoutParams.WRAP_CONTENT))
            cell.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            line.addView(cell, LinearLayout.LayoutParams(guideCol, MATCH))
            line.addView(strip, LinearLayout.LayoutParams(0, MATCH, 1f))
        }

        fun bind(g: HomeGuide, i: Int, ch: GuideChannel) {
            index = i
            cell.background = focusable(GradientDrawable().also { it.setColor(colors.surface) })
            cell.contentDescription = ch.name
            number.text = ch.number ?: ""
            number.setTextColor(colors.subtle)
            name.text = ch.name
            name.setTextColor(colors.ink)
            if (ch.logo != null) {
                logo.visibility = View.VISIBLE
                images.load(logo, listOf(ch.logo), dp(56), dp(22), alpha = true) { ok -> logo.visibility = if (ok) View.VISIBLE else View.GONE }
            } else {
                images.clear(logo)
                logo.visibility = View.GONE
            }
            strip.guide = g
            strip.row = i
            strip.invalidate()
            // Near the end of the list: the next channels.
            if (g.more && i >= g.channels.size - 8 && guideAskedMore != g.channels.size) {
                guideAskedMore = g.channels.size
                act("guide", what = "more")
            }
        }
    }

    // ---- a game ----------------------------------------------------------------------------------

    /** The match page's top: the league, each side's logo, name and cards, the score, the state. */
    private inner class MatchHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout

        init {
            col.orientation = LinearLayout.VERTICAL
            col.gravity = Gravity.CENTER_HORIZONTAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPadding(dp(16), dp(72), dp(16), dp(24))
        }

        fun bind(mt: HomeMatch) {
            col.removeAllViews()
            col.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(withAlpha(colors.accent, 0.1f), withAlpha(colors.accent, 0.04f), Color.TRANSPARENT))
            val pill = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPaddingRelative(dp(16), dp(6), dp(16), dp(6))
                background = rounded(withAlpha(colors.accent, 0.1f), dp(16).toFloat(), dp(1), withAlpha(colors.accent, 0.2f))
            }
            if (mt.live) {
                pill.addView(View(ctx).apply { background = GradientDrawable().also { it.shape = GradientDrawable.OVAL; it.setColor(colors.accent) } },
                    LinearLayout.LayoutParams(dp(8), dp(8)).apply { marginEnd = dp(8) })
            }
            pill.addView(label(mt.league.uppercase(), 12f, bold = true, lines = 1).apply { setTextColor(colors.accent); letterSpacing = 0.2f })
            col.addView(pill, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            val line = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                layoutDirection = View.LAYOUT_DIRECTION_LTR
            }
            line.addView(side(mt.home), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            val mid = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
            }
            val score = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(20), dp(12), dp(20), dp(12))
                background = rounded(withAlpha(colors.surface, 0.5f), dp(28).toFloat(), dp(1), withAlpha(colors.ink, 0.06f))
            }
            score.addView(label(mt.home.score, 44f, bold = true, lines = 1).apply { setTextColor(colors.ink); fontFeatureSettings = "tnum" })
            score.addView(label("-", 28f, bold = true, lines = 1).apply { setTextColor(colors.subtle); setPadding(dp(12), 0, dp(12), 0) })
            score.addView(label(mt.away.score, 44f, bold = true, lines = 1).apply { setTextColor(colors.ink); fontFeatureSettings = "tnum" })
            mid.addView(score, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            mid.addView(label(mt.status, 13f, bold = true, lines = 1).apply {
                setTextColor(colors.canvas)
                setPaddingRelative(dp(16), dp(6), dp(16), dp(6))
                background = rounded(colors.ink, dp(16).toFloat())
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })
            line.addView(mid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8); marginEnd = dp(8) })
            line.addView(side(mt.away), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            col.addView(line, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(28) })
        }

        private fun side(s: MatchSide): View = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            val box = FrameLayout(ctx).apply {
                background = rounded(withAlpha(colors.surface, 0.4f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.06f))
                setPadding(dp(12), dp(12), dp(12), dp(12))
            }
            val img = NetImage(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
            box.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
            s.logo?.let { images.load(img, listOf(it), dp(72), dp(72), alpha = true) }
            addView(box, LinearLayout.LayoutParams(dp(88), dp(88)))
            addView(label(s.name, 17f, bold = true, lines = 2).apply {
                setTextColor(colors.ink)
                gravity = Gravity.CENTER
                textAlignment = View.TEXT_ALIGNMENT_CENTER
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) })
            if (s.yellow > 0 || s.red > 0) {
                val cards = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                repeat(s.yellow) { cards.addView(View(ctx).apply { background = rounded(0xFFFACC15.toInt(), dp(2).toFloat()) }, LinearLayout.LayoutParams(dp(10), dp(14)).apply { marginEnd = dp(4) }) }
                repeat(s.red) { cards.addView(View(ctx).apply { background = rounded(0xFFEF4444.toInt(), dp(2).toFloat()) }, LinearLayout.LayoutParams(dp(10), dp(14)).apply { marginEnd = dp(4) }) }
                addView(cards, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            }
        }
    }

    /**
     * Two sides' figures on a line (a match's stats, a fight's tale of the tape): the home side's
     * figure, the label, the away side's; the larger one bold (green with tone "accent").
     * Card: title = label, sub = home, desc = away, rank 1 = home larger, 2 = away larger.
     */
    private inner class VersusHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val line = itemView as LinearLayout
        private val home = label("", 14f, bold = true, lines = 1)
        private val what = label("", 12f, lines = 2)
        private val away = label("", 14f, bold = true, lines = 1)

        init {
            line.orientation = LinearLayout.HORIZONTAL
            line.gravity = Gravity.CENTER_VERTICAL
            line.layoutDirection = View.LAYOUT_DIRECTION_LTR
            line.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(16)
                marginEnd = dp(16)
            }
            line.setPadding(dp(16), dp(12), dp(16), dp(12))
            home.fontFeatureSettings = "tnum"
            away.fontFeatureSettings = "tnum"
            away.textAlignment = View.TEXT_ALIGNMENT_VIEW_END
            what.gravity = Gravity.CENTER
            what.textAlignment = View.TEXT_ALIGNMENT_CENTER
            line.addView(home, LinearLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.WRAP_CONTENT))
            line.addView(what, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            line.addView(away, LinearLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        fun bind(r: HomeRow, i: Int, c: HomeCard) {
            val first = i == 0
            val last = i == r.items.size - 1
            val rad = dp(16).toFloat()
            line.background = GradientDrawable().also {
                it.setColor(withAlpha(colors.surface, 0.2f))
                it.cornerRadii = floatArrayOf(if (first) rad else 0f, if (first) rad else 0f, if (first) rad else 0f, if (first) rad else 0f, if (last) rad else 0f, if (last) rad else 0f, if (last) rad else 0f, if (last) rad else 0f)
            }
            val green = c.tone == "accent"
            val win = 0xFF22C55E.toInt()
            home.text = c.sub ?: "-"
            away.text = c.desc ?: "-"
            what.text = c.title
            what.setTextColor(colors.subtle)
            home.setTextColor(if (c.rank == 1) (if (green) win else colors.ink) else if (green) colors.ink else colors.subtle)
            away.setTextColor(if (c.rank == 2) (if (green) win else colors.ink) else if (green) colors.ink else colors.subtle)
            home.setTypeface(null, if (c.rank == 1 || green) Typeface.BOLD else Typeface.NORMAL)
            away.setTypeface(null, if (c.rank == 2 || green) Typeface.BOLD else Typeface.NORMAL)
        }
    }

    /**
     * A team's starting eleven on a half pitch, as the page draws it: the forwards at the top, the
     * keeper at the bottom, each player's photo or shirt number in a circle with their surname
     * under it, the team's short name in the corner. Row: title = team, sub = short name; cards:
     * title = surname, sub = number, images = photo, rank = the line, tint = the team's colour.
     */
    private inner class PitchHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val wrap = itemView as FrameLayout

        init {
            wrap.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            wrap.setPadding(dp(16), 0, dp(16), dp(24))
        }

        fun bind(r: HomeRow) {
            wrap.removeAllViews()
            val w = min(width() - dp(32), dp(384))
            val h = w * 4 / 3
            val pitch = FrameLayout(ctx).apply {
                background = rounded(0xFF2B4C30.toInt(), dp(24).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
                clipToOutline = true
                outlineProvider = roundOutline(dp(24).toFloat())
            }
            val lines = 0x33FFFFFF
            // The pitch's lines: its edge, the box at the top, the box and goal at the bottom.
            pitch.addView(View(ctx).apply { background = rounded(Color.TRANSPARENT, dp(12).toFloat(), dp(2), lines) },
                FrameLayout.LayoutParams(MATCH, MATCH).apply { setMargins(dp(16), dp(16), dp(16), dp(16)) })
            pitch.addView(View(ctx).apply { background = rounded(Color.TRANSPARENT, dp(12).toFloat(), dp(2), lines) },
                FrameLayout.LayoutParams(dp(192), dp(96), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(4) })
            pitch.addView(View(ctx).apply { background = rounded(Color.TRANSPARENT, dp(12).toFloat(), dp(2), lines) },
                FrameLayout.LayoutParams(min(dp(256), w - dp(64)), dp(128), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(4) })
            pitch.addView(View(ctx).apply { background = rounded(Color.TRANSPARENT, dp(8).toFloat(), dp(2), lines) },
                FrameLayout.LayoutParams(dp(96), dp(48), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(4) })
            pitch.addView(label((r.sub ?: "").uppercase(), 10f, bold = true, lines = 1).apply {
                setTextColor(withAlpha(Color.WHITE, 0.8f))
                setPaddingRelative(dp(8), dp(4), dp(8), dp(4))
                background = rounded(0x66000000, dp(4).toFloat())
            }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                marginStart = dp(8)
                topMargin = dp(8)
            })
            val rows = r.items.groupBy { it.rank }.toSortedMap()
            val col = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(8), dp(28), dp(8), dp(28))
            }
            rows.values.forEachIndexed { i, players ->
                val line = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER
                }
                for (p in players) line.addView(player(p, p.tint), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                col.addView(line, LinearLayout.LayoutParams(MATCH, 0, 1f))
                if (i < rows.size - 1) col.addView(View(ctx), LinearLayout.LayoutParams(MATCH, dp(4)))
            }
            pitch.addView(col, FrameLayout.LayoutParams(MATCH, MATCH))
            wrap.addView(pitch, FrameLayout.LayoutParams(w, h, Gravity.CENTER_HORIZONTAL))
        }

        private fun player(p: HomeCard, tint: Int?): View = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            val dot = FrameLayout(ctx).apply {
                clipToOutline = true
                outlineProvider = roundOutline(dp(18).toFloat())
                background = GradientDrawable().also { it.shape = GradientDrawable.OVAL; it.setColor(tint ?: colors.accent); it.setStroke(dp(2), withAlpha(colors.canvas, 0.8f)) }
            }
            dot.addView(label(p.sub ?: "-", 12f, bold = true, lines = 1).apply {
                setTextColor(if (tint == Color.WHITE) Color.BLACK else colors.canvas)
            }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
            if (p.images.isNotEmpty()) {
                val img = NetImage(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
                dot.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, p.images, dp(36), dp(36))
            }
            addView(dot, LinearLayout.LayoutParams(dp(36), dp(36)))
            addView(label(p.title, 10f, bold = true, lines = 1).apply {
                setTextColor(Color.WHITE)
                setPaddingRelative(dp(6), dp(2), dp(6), dp(2))
                background = rounded(0x66000000, dp(4).toFloat())
                maxWidth = dp(72)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
        }
    }

    // ---- a series' episodes ------------------------------------------------------------------------

    /**
     * One episode as the page's list shows it: the still (number, watched check, rating, how far
     * in) and beside it the name, the line under it (S1 E3 · 45 min · date · watched…) and the
     * overview; then its info and download buttons. Tap: play; long-press: the page's menu.
     */
    private inner class EpisodeHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val line = itemView as LinearLayout
        private val thumb = FrameLayout(ctx)
        val image = NetImage(ctx)
        private val number = label("", 11f, bold = true, lines = 1)
        private val check = FrameLayout(ctx)
        private val rating = LinearLayout(ctx)
        private val track = FrameLayout(ctx)
        private val bar = View(ctx)
        private val texts = LinearLayout(ctx)
        private val title = label("", 14f, bold = true, lines = 1)
        private val badge = label("", 10f, bold = true, lines = 1)
        private val sub = label("", 12f, lines = 2)
        private val desc = label("", 13.5f, lines = 2)
        private val info = FrameLayout(ctx)
        private val download = FrameLayout(ctx)
        private var rowKey = ""
        private var index = -1

        init {
            line.orientation = LinearLayout.HORIZONTAL
            line.gravity = Gravity.CENTER_VERTICAL
            line.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            line.setPaddingRelative(dp(16), dp(10), dp(8), dp(10))
            line.isClickable = true
            line.isFocusable = true
            line.setOnClickListener { act("open", row = rowKey, i = index) }
            line.setOnLongClickListener {
                act("hold", row = rowKey, i = index)
                true
            }
            thumb.clipToOutline = true
            thumb.outlineProvider = roundOutline(dp(8).toFloat())
            image.scaleType = ImageView.ScaleType.CENTER_CROP
            thumb.addView(image, FrameLayout.LayoutParams(MATCH, MATCH))
            number.setPaddingRelative(dp(6), dp(2), dp(6), dp(2))
            thumb.addView(number, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                marginStart = dp(6)
                topMargin = dp(6)
            })
            check.addView(ImageView(ctx).apply { tag = "ic" }, FrameLayout.LayoutParams(dp(12), dp(12), Gravity.CENTER))
            thumb.addView(check, FrameLayout.LayoutParams(dp(22), dp(22), Gravity.TOP or Gravity.END).apply {
                marginEnd = dp(6)
                topMargin = dp(6)
            })
            thumb.addView(rating, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
                marginStart = dp(6)
                bottomMargin = dp(7)
            })
            track.addView(bar, FrameLayout.LayoutParams(0, MATCH, Gravity.START))
            thumb.addView(track, FrameLayout.LayoutParams(MATCH, dp(3), Gravity.BOTTOM))
            line.addView(thumb, LinearLayout.LayoutParams(dp(132), dp(132) * 9 / 16))

            texts.orientation = LinearLayout.VERTICAL
            val titleLine = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                badge.setPaddingRelative(dp(6), dp(1), dp(6), dp(1))
                addView(badge, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(6) })
            }
            texts.addView(titleLine, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
            texts.addView(sub, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            desc.setLineSpacing(0f, 1.2f)
            texts.addView(desc, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            line.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(12) })

            for ((b, what) in listOf(info to "info", download to "dl")) {
                b.isClickable = true
                b.isFocusable = true
                b.addView(ImageView(ctx).apply { tag = "ic" }, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
                b.setOnClickListener { act(what, row = rowKey, i = index) }
                line.addView(b, LinearLayout.LayoutParams(dp(40), dp(40)))
            }
        }

        fun bind(r: HomeRow, i: Int, c: HomeCard) {
            val m = model ?: return
            rowKey = r.key
            index = i
            line.contentDescription = c.title
            thumb.background = rounded(plate(c.title), dp(8).toFloat())
            images.load(image, c.images, dp(132), dp(132) * 9 / 16)
            number.text = if (c.rank > 0) c.rank.toString() else ""
            number.visibility = if (c.rank > 0) View.VISIBLE else View.GONE
            number.setTextColor(colors.ink)
            number.background = rounded(withAlpha(colors.canvas, 0.95f), dp(6).toFloat())
            check.visibility = if (c.watched) View.VISIBLE else View.GONE
            if (c.watched) {
                check.background = GradientDrawable().apply { shape = GradientDrawable.OVAL }.also {
                    it.setColor(0x3834D399)
                    it.setStroke(dp(1), 0x6634D399)
                }
                check.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(R.drawable.ic_check, 0xFFA7F3D0.toInt()))
            }
            rating.removeAllViews()
            c.rating?.let { rating.addView(imdbBadge(it, 9.5f, trailing = 0)) }
            rating.visibility = if (c.rating != null) View.VISIBLE else View.GONE
            track.visibility = if (c.progress > 0.01f) View.VISIBLE else View.GONE
            track.setBackgroundColor(0x8C000000.toInt())
            bar.setBackgroundColor(colors.accent)
            val blp = bar.layoutParams
            blp.width = (dp(132) * c.progress.coerceIn(0.02f, 1f)).toInt()
            bar.layoutParams = blp

            title.text = c.title
            title.setTextColor(colors.ink)
            badge.text = c.kicker ?: ""
            badge.visibility = if (c.kicker.isNullOrBlank()) View.GONE else View.VISIBLE
            badge.setTextColor(colors.canvas)
            badge.background = rounded(colors.accent, dp(6).toFloat())
            sub.text = c.sub ?: ""
            sub.visibility = if (c.sub.isNullOrBlank()) View.GONE else View.VISIBLE
            sub.setTextColor(colors.subtle)
            desc.text = c.desc ?: ""
            desc.visibility = if (c.desc.isNullOrBlank()) View.GONE else View.VISIBLE
            desc.setTextColor(colors.muted)
            info.visibility = if (r.noInfo) View.GONE else View.VISIBLE
            info.contentDescription = m.label("episodeInfo", "Episode details")
            info.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(R.drawable.ic_eye, colors.subtle))
            info.background = focusable(rounded(Color.TRANSPARENT, dp(20).toFloat()))
            download.visibility = if (c.play) View.VISIBLE else View.GONE
            download.contentDescription = m.label("download", "Download")
            download.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(R.drawable.ic_download, colors.subtle))
            download.background = focusable(rounded(Color.TRANSPARENT, dp(20).toFloat()))
        }
    }

    // ---- a title's page --------------------------------------------------------------------------

    /** Which titles' synopses are open in full. */
    private val synopsisOpen = HashSet<String>()
    /** Which headings' paragraphs (a person's biography) are open in full. */
    private val headerBodyOpen = HashSet<String>()

    /**
     * A title's hero as the page draws it: the backdrop darkened from the bottom and the start, the
     * tagline, the logo (or the name), the pills (year, ratings, runtime, genres), the awards, Play
     * and the round "…" (the page's own menu); then the synopsis, four lines until opened.
     */
    private inner class DetailHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val frame = FrameLayout(ctx)
        private val backdrop = NetImage(ctx)
        private val shadeUp = View(ctx)
        private val shadeSide = View(ctx)
        private val content = LinearLayout(ctx)
        private val tagline = label("", 13f, bold = true, lines = 2)
        private val logo = NetImage(ctx)
        private val title = label("", 36f, lines = 3)
        private val pills = FlowRow(ctx, dp(10), dp(10))
        private val awards = label("", 13f, lines = 2)
        private val actions = LinearLayout(ctx)
        private val play = LinearLayout(ctx)
        private val playIcon = ImageView(ctx)
        private val playText = label("", 15f, bold = true, lines = 1)
        private val more = FrameLayout(ctx)
        private val moreIcon = ImageView(ctx)
        private val extra = label("", 14f, lines = 1)
        private val synopsis = label("", 16f)
        private val synopsisToggle = label("", 13.5f, bold = true, lines = 1)
        /** The gap under the synopsis, which stays when there is no "Read more" under it. */
        private val synopsisGap = View(ctx)
        private var key = ""
        /** The hero's words (tagline, logo or name, pills, awards): hidden while the details load. */
        private val words = LinearLayout(ctx)
        private var shownFor = ""
        private val reveal = Runnable { showWords() }
        /** The logo is on its way: the name waits for it (a while at most). */
        private val nameFallback = Runnable { if (logo.visibility != View.VISIBLE) title.visibility = View.VISIBLE }

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            backdrop.scaleType = ImageView.ScaleType.CENTER_CROP
            frame.addView(backdrop, FrameLayout.LayoutParams(MATCH, MATCH))
            frame.addView(shadeUp, FrameLayout.LayoutParams(MATCH, MATCH))
            frame.addView(shadeSide, FrameLayout.LayoutParams(MATCH, MATCH))
            content.orientation = LinearLayout.VERTICAL
            content.setPaddingRelative(gutter, 0, gutter, dp(28))
            words.orientation = LinearLayout.VERTICAL
            words.addView(tagline, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(14) })
            logo.scaleType = ImageView.ScaleType.FIT_START
            words.addView(logo, LinearLayout.LayoutParams((width() * 0.72f).toInt(), dp(96)))
            title.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            title.setShadowLayer(dp(12).toFloat(), 0f, dp(3).toFloat(), 0x73000000)
            words.addView(title)
            words.addView(pills, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(20) })
            words.addView(awards, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
            content.addView(words, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))

            actions.orientation = LinearLayout.HORIZONTAL
            actions.gravity = Gravity.CENTER_VERTICAL
            play.orientation = LinearLayout.HORIZONTAL
            play.gravity = Gravity.CENTER
            play.isClickable = true
            play.isFocusable = true
            play.setPaddingRelative(dp(24), 0, dp(28), 0)
            play.setOnClickListener { act("d", what = "play") }
            play.addView(playIcon, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(10) })
            play.addView(playText)
            actions.addView(play, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
            extra.gravity = Gravity.CENTER
            extra.setPaddingRelative(dp(20), 0, dp(20), 0)
            extra.isClickable = true
            extra.isFocusable = true
            extra.setOnClickListener { act("d", what = "extra") }
            actions.addView(extra, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)).apply { marginStart = dp(12) })
            more.isClickable = true
            more.isFocusable = true
            more.setOnClickListener { act("d", what = "more") }
            more.addView(moreIcon, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER))
            actions.addView(more, LinearLayout.LayoutParams(dp(48), dp(48)).apply { marginStart = dp(12) })
            content.addView(actions, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(30) })
            frame.addView(content, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            col.addView(frame, LinearLayout.LayoutParams(MATCH, heroHeight()))

            synopsis.setLineSpacing(0f, 1.4f)
            synopsis.setOnClickListener { toggleSynopsis() }
            col.addView(synopsis, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = gutter
                marginEnd = gutter
                topMargin = dp(20)
            })
            synopsisToggle.isClickable = true
            synopsisToggle.isFocusable = true
            synopsisToggle.setPadding(0, dp(8), dp(8), dp(8))
            synopsisToggle.setOnClickListener { toggleSynopsis() }
            col.addView(synopsisToggle, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = gutter
                marginEnd = gutter
            })
            col.addView(synopsisGap, LinearLayout.LayoutParams(MATCH, dp(28)))
        }

        private fun toggleSynopsis() {
            if (!synopsisOpen.add(key)) synopsisOpen.remove(key)
            model?.detail?.let { bind(it) }
        }

        private fun showWords() {
            words.removeCallbacks(reveal)
            for (v in listOf(words, synopsis, synopsisToggle)) {
                if (v.alpha < 1f) v.animate().alpha(1f).setDuration(220).start()
            }
        }

        fun bind(d: HomeDetail) {
            val m = model ?: return
            val rtl = m.rtl
            key = d.title
            val flp = frame.layoutParams
            if (flp.height != heroHeight()) {
                flp.height = heroHeight()
                frame.layoutParams = flp
            }
            frame.setBackgroundColor(colors.canvas)
            images.load(backdrop, d.backdrop, width(), heroHeight(), crop = true, keep = shownFor == m.top.toString())
            shadeUp.background = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(colors.canvas, withAlpha(colors.canvas, 0.55f), Color.TRANSPARENT),
            )
            shadeSide.background = GradientDrawable(
                if (rtl) GradientDrawable.Orientation.RIGHT_LEFT else GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(withAlpha(colors.canvas, 0.85f), withAlpha(colors.canvas, 0.35f), Color.TRANSPARENT),
            )
            tagline.text = d.tagline?.let { if (rtl) it else it.uppercase() } ?: ""
            tagline.visibility = if (d.tagline.isNullOrBlank()) View.GONE else View.VISIBLE
            tagline.letterSpacing = if (rtl) 0f else 0.2f
            tagline.setTextColor(if (d.taglineLink) colors.muted else colors.subtle)
            tagline.isClickable = d.taglineLink
            tagline.isFocusable = d.taglineLink
            tagline.setOnClickListener(if (d.taglineLink) View.OnClickListener { act("pill", what = "tagline") } else null)

            title.text = d.title
            title.setTextColor(colors.ink)
            logo.scaleType = if (rtl) ImageView.ScaleType.FIT_END else ImageView.ScaleType.FIT_START
            words.removeCallbacks(nameFallback)
            if (d.logo != null) {
                // The logo takes the name's place: the name doesn't show first and then swap.
                if (logo.visibility == View.GONE) logo.visibility = View.INVISIBLE
                if (logo.visibility != View.VISIBLE) {
                    title.visibility = View.GONE
                    words.postDelayed(nameFallback, 900)
                }
                images.load(logo, listOf(d.logo), (width() * 0.72f).toInt(), dp(96), alpha = true) { ok ->
                    words.removeCallbacks(nameFallback)
                    logo.visibility = if (ok) View.VISIBLE else View.GONE
                    title.visibility = if (ok) View.GONE else View.VISIBLE
                }
            } else {
                images.clear(logo)
                logo.visibility = View.GONE
                title.visibility = View.VISIBLE
            }
            // While the details load (another title, its name only): its words wait, then fade in
            // together, instead of the year, genres, text and logo changing one after another.
            // (A page showing another title has another "top": see HomeModel.top.)
            val ident = m.top.toString()
            if (ident != shownFor) {
                shownFor = ident
                words.removeCallbacks(reveal)
                if (d.pending) {
                    words.animate().cancel()
                    words.alpha = 0f
                    synopsis.alpha = 0f
                    synopsisToggle.alpha = 0f
                    words.postDelayed(reveal, 1200)
                } else {
                    words.alpha = 1f
                    synopsis.alpha = 1f
                    synopsisToggle.alpha = 1f
                }
            } else if (!d.pending && words.alpha < 1f) {
                showWords()
            }

            pills.removeAllViews()
            for (p in d.pills) pills.addView(pill(p))
            pills.visibility = if (d.pills.isEmpty()) View.GONE else View.VISIBLE
            awards.text = d.awards ?: ""
            awards.visibility = if (d.awards.isNullOrBlank()) View.GONE else View.VISIBLE
            awards.setTextColor(colors.accent)

            play.visibility = if (d.play == null) View.GONE else View.VISIBLE
            play.background = focusable(rounded(colors.ink, dp(24).toFloat()))
            playIcon.setImageDrawable(icon(R.drawable.ic_play, colors.canvas))
            playText.text = d.play ?: ""
            playText.setTextColor(colors.canvas)
            extra.visibility = if (d.extra.isNullOrBlank()) View.GONE else View.VISIBLE
            extra.text = d.extra ?: ""
            extra.setTextColor(colors.muted)
            extra.background = focusable(rounded(withAlpha(colors.canvas, 0.8f), dp(24).toFloat(), dp(1), withAlpha(colors.ink, 0.18f)))
            more.visibility = if (d.more) View.VISIBLE else View.GONE
            more.background = focusable(rounded(withAlpha(colors.canvas, 0.8f), dp(24).toFloat(), dp(1), withAlpha(colors.ink, 0.18f)))
            more.contentDescription = m.label("moreActions", "More actions")
            moreIcon.setImageDrawable(icon(R.drawable.ic_ellipsis, colors.ink))

            val text = d.synopsis
            synopsis.visibility = if (text.isNullOrBlank()) View.GONE else View.VISIBLE
            synopsisGap.visibility = synopsis.visibility
            synopsis.text = text ?: ""
            synopsis.setTextColor(colors.muted)
            val open = key in synopsisOpen
            synopsis.maxLines = if (open) Int.MAX_VALUE else 4
            synopsis.ellipsize = if (open) null else TextUtils.TruncateAt.END
            synopsisToggle.text = if (open) m.label("less", "Show less") else m.label("more", "Read more")
            synopsisToggle.setTextColor(colors.ink)
            synopsisToggle.visibility = View.GONE
            if (!text.isNullOrBlank()) {
                synopsis.post {
                    val lay = synopsis.layout ?: return@post
                    val cut = lay.lineCount > 0 && lay.getEllipsisCount(lay.lineCount - 1) > 0
                    synopsisToggle.visibility = if (open || cut) View.VISIBLE else View.GONE
                }
            }
        }

        /** Year / runtime / genre (a tap opens that list), the IMDb tag with its score, other scores. */
        private fun pill(p: DetailPill): View {
            if (p.kind == "imdb") {
                return imdbBadge(p.label, 13f, trailing = 0).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                }
            }
            return label(p.label, 13f, bold = p.kind == "score", lines = 1).apply {
                setTextColor(colors.muted)
                gravity = Gravity.CENTER
                setPaddingRelative(dp(12), dp(5), dp(12), dp(5))
                background = rounded(withAlpha(colors.canvas, 0.5f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.14f))
                if (p.kind == "pill") {
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { act("pill", what = p.id) }
                }
            }
        }
    }

    // ---- the release calendar ------------------------------------------------------------------

    /** Previous month, Today, the month's name, next month (the page's bar under its title). */
    private inner class CalendarBarHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val bar = itemView as LinearLayout
        private val prev = FrameLayout(ctx)
        private val today = label("", 13f, bold = true, lines = 1)
        private val month = LinearLayout(ctx)
        private val monthIcon = ImageView(ctx)
        private val monthText = label("", 14f, bold = true, lines = 1)
        private val next = FrameLayout(ctx)

        init {
            bar.orientation = LinearLayout.HORIZONTAL
            bar.gravity = Gravity.CENTER_VERTICAL
            bar.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            bar.setPaddingRelative(dp(16), 0, dp(16), dp(16))
            for ((v, what) in listOf(prev to "prev", next to "next")) {
                v.isClickable = true
                v.isFocusable = true
                v.setOnClickListener { act("cal", what = what) }
                v.addView(ImageView(ctx).apply { tag = "ic" }, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER))
            }
            today.gravity = Gravity.CENTER
            today.setPaddingRelative(dp(16), 0, dp(16), 0)
            today.isClickable = true
            today.isFocusable = true
            today.setOnClickListener { act("cal", what = "today") }
            month.orientation = LinearLayout.HORIZONTAL
            month.gravity = Gravity.CENTER
            month.setPaddingRelative(dp(12), 0, dp(12), 0)
            month.addView(monthIcon, LinearLayout.LayoutParams(dp(14), dp(14)).apply { marginEnd = dp(8) })
            month.addView(monthText)
            bar.addView(prev, LinearLayout.LayoutParams(dp(40), dp(40)))
            bar.addView(today, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)).apply { marginStart = dp(8) })
            bar.addView(month, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)).apply { marginStart = dp(8) })
            bar.addView(next, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginStart = dp(8) })
        }

        fun bind(c: HomeCalendar) {
            val rtl = model?.rtl == true
            val edge = withAlpha(colors.ink, 0.1f)
            for (v in listOf(prev, next)) {
                v.background = focusable(rounded(Color.TRANSPARENT, dp(20).toFloat(), dp(1), edge))
                val left = (v === prev) != rtl
                v.contentDescription = if (v === prev) c.label("prev", "Previous month") else c.label("next", "Next month")
                v.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(if (left) R.drawable.ic_chevron_left else R.drawable.ic_chevron_right, colors.muted))
            }
            today.text = c.label("today", "Today")
            today.setTextColor(colors.muted)
            today.background = focusable(rounded(Color.TRANSPARENT, dp(20).toFloat(), dp(1), edge))
            month.background = rounded(Color.TRANSPARENT, dp(20).toFloat(), dp(1), edge)
            monthIcon.setImageDrawable(icon(R.drawable.ic_calendar, colors.subtle))
            monthText.text = c.month
            monthText.setTextColor(colors.ink)
        }
    }

    /**
     * The month as the page draws it: the weekdays, then a week a line, each day a box with its
     * number, how many titles, the first three (a small poster and the name; a tap opens it) and
     * "+2 more" (all of that day's). Today is outlined; the neighbouring months' days are faded.
     */
    private inner class CalendarHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val head = LinearLayout(ctx)
        private val weeks = LinearLayout(ctx)
        private val days = ArrayList<LinearLayout>()

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPaddingRelative(dp(12), dp(4), dp(12), dp(24))
            head.orientation = LinearLayout.HORIZONTAL
            col.addView(head, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })
            weeks.orientation = LinearLayout.VERTICAL
            col.addView(weeks, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        fun bind(c: HomeCalendar) {
            val rtl = model?.rtl == true
            // The weekdays.
            if (head.childCount != c.weekdays.size) {
                head.removeAllViews()
                c.weekdays.forEachIndexed { i, _ ->
                    head.addView(label("", 11f, bold = true, lines = 1).apply { setPaddingRelative(dp(4), 0, 0, 0) },
                        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) marginStart = dp(8) })
                }
            }
            c.weekdays.forEachIndexed { i, d ->
                (head.getChildAt(i) as? TextView)?.apply {
                    text = if (rtl) d else d.uppercase()
                    letterSpacing = if (rtl) 0f else 0.16f
                    setTextColor(colors.subtle)
                }
            }
            // A box for each day, seven to a line.
            if (days.size != c.cells.size) {
                weeks.removeAllViews()
                days.clear()
                var line: LinearLayout? = null
                for (i in c.cells.indices) {
                    if (i % 7 == 0) {
                        line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                        weeks.addView(line, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (i > 0) topMargin = dp(8) })
                    }
                    val day = LinearLayout(ctx).apply {
                        orientation = LinearLayout.VERTICAL
                        minimumHeight = dp(112)
                        setPadding(dp(8), dp(8), dp(8), dp(8))
                    }
                    line!!.addView(day, LinearLayout.LayoutParams(0, MATCH, 1f).apply { if (i % 7 > 0) marginStart = dp(8) })
                    days.add(day)
                }
            }
            c.cells.forEachIndexed { i, cell -> bindDay(days[i], i, cell) }
        }

        private fun bindDay(box: LinearLayout, index: Int, d: CalCell) {
            box.removeAllViews()
            box.alpha = if (d.inMonth) 1f else 0.5f
            box.background = when {
                !d.inMonth -> rounded(withAlpha(colors.canvas, 0.3f), dp(12).toFloat(), dp(1), withAlpha(colors.ink, 0.04f))
                d.today -> rounded(withAlpha(colors.surface, 0.4f), dp(12).toFloat(), dp(1), withAlpha(colors.ink, 0.6f))
                else -> rounded(withAlpha(colors.surface, 0.15f), dp(12).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            }
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.BOTTOM
            }
            // The day's number whole, then how many: on a phone's narrow box the two may run into
            // the box's padding (as the page's do), never cut to "…".
            top.addView(label(d.day.toString(), 12.5f, bold = true).apply {
                fontFeatureSettings = "tnum"
                setTextColor(if (d.today) colors.ink else if (d.inMonth) colors.muted else colors.subtle)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            top.addView(View(ctx), LinearLayout.LayoutParams(0, 0, 1f))
            if (d.count > 0) {
                top.addView(label(d.count.toString(), 10.5f, bold = true, lines = 1).apply { setTextColor(colors.subtle) },
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(2) })
            }
            box.clipToPadding = false
            box.addView(top, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = -dp(5) })
            d.items.forEachIndexed { k, it ->
                val chip = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPaddingRelative(dp(4), dp(4), dp(8), dp(4))
                    background = focusable(rounded(withAlpha(colors.canvas, 0.5f), dp(6).toFloat()))
                    isClickable = true
                    isFocusable = true
                    contentDescription = it.title
                    setOnClickListener { act("cal", what = "item", i = index, text = k.toString()) }
                }
                val pic = NetImage(ctx).apply {
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    clipToOutline = true
                    outlineProvider = roundOutline(dp(3).toFloat())
                    background = rounded(withAlpha(colors.surface, 0.5f), dp(3).toFloat())
                }
                chip.addView(pic, LinearLayout.LayoutParams(dp(20), dp(28)))
                if (it.images.isNotEmpty()) images.load(pic, it.images, dp(20), dp(28))
                chip.addView(label(it.title, 11.5f, lines = 1).apply { setTextColor(colors.ink) },
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) })
                box.addView(chip, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            }
            d.more?.let { more ->
                // "+2 more", or "+2" when the box is too narrow for the words.
                box.addView(FitText(ctx, more, more.substringBefore(' ')).apply {
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    maxLines = 1
                    setTextColor(colors.subtle)
                    setPaddingRelative(dp(4), dp(2), dp(4), dp(2))
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { act("cal", what = "day", i = index) }
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            }
        }
    }

    // ---- downloads -----------------------------------------------------------------------------

    private val danger get() = 0xFFE5484D.toInt()
    private val amber get() = withAlpha(0xFFFCD34D.toInt(), 0.85f)

    /** Where files are kept and how much is free, the Wi-Fi / battery cards, the season searches. */
    private inner class DownloadsTopHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPaddingRelative(dp(20), 0, dp(20), dp(4))
        }

        fun bind(d: HomeDownloads) {
            col.removeAllViews()
            d.storage?.let {
                col.addView(label(it, 12.5f).apply { setTextColor(colors.subtle) },
                    LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(20) })
            }
            for (n in d.notices) {
                val card = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPaddingRelative(dp(16), dp(12), dp(16), dp(12))
                    background = if (n.accent) rounded(withAlpha(colors.accent, 0.1f), dp(16).toFloat(), dp(1), withAlpha(colors.accent, 0.25f))
                    else rounded(withAlpha(colors.surface, 0.3f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
                }
                val res = if (n.icon == "battery") R.drawable.ic_battery_charging else R.drawable.ic_wifi
                card.addView(ImageView(ctx).apply { setImageDrawable(icon(res, colors.accent)) }, LinearLayout.LayoutParams(dp(19), dp(19)))
                card.addView(label(n.text, 12.5f).apply { setTextColor(colors.muted); setLineSpacing(0f, 1.15f) },
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(12); marginEnd = dp(12) })
                n.action?.let { a ->
                    card.addView(label(a, 12.5f, bold = true, lines = 1).apply {
                        gravity = Gravity.CENTER
                        setPaddingRelative(dp(12), 0, dp(12), 0)
                        setTextColor(if (n.actionOn) colors.canvas else colors.ink)
                        background = focusable(rounded(if (n.actionOn) colors.accent else withAlpha(colors.ink, 0.1f), dp(8).toFloat()))
                        isClickable = true
                        isFocusable = true
                        setOnClickListener { act("dl", what = "notice", text = n.id) }
                    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)))
                }
                col.addView(card, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(20) })
            }
            for (j in d.jobs) {
                val card = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPaddingRelative(dp(16), dp(6), dp(8), dp(6))
                    background = rounded(withAlpha(colors.surface, 0.4f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
                }
                card.addView(android.widget.ProgressBar(ctx).apply {
                    isIndeterminate = true
                    indeterminateTintList = android.content.res.ColorStateList.valueOf(colors.subtle)
                }, LinearLayout.LayoutParams(dp(16), dp(16)))
                card.addView(label(j.text, 12.5f, lines = 1).apply { setTextColor(colors.muted) },
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(12) })
                card.addView(iconButton(R.drawable.ic_x, j.stop) { act("dl", what = "stopjob", text = j.key) })
                col.addView(card, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(16) })
            }
        }
    }

    /** A 36dp icon button (the page's row buttons). */
    private fun iconButton(res: Int, desc: String, tint: Int = colors.subtle, onTap: () -> Unit): View = FrameLayout(ctx).apply {
        isClickable = true
        isFocusable = true
        contentDescription = desc
        background = focusable(rounded(Color.TRANSPARENT, dp(8).toFloat()))
        addView(ImageView(ctx).apply { setImageDrawable(icon(res, tint)) }, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER))
        setOnClickListener { onTap() }
        layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
    }

    /** A film's download, or a show's card: its poster, name and count over its episodes' rows. */
    private inner class DownloadGroupHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(20)
                marginEnd = dp(20)
                bottomMargin = dp(10)
            }
        }

        fun bind(g: DlGroup) {
            col.removeAllViews()
            if (g.title == null) {
                col.background = null
                col.setPadding(0, 0, 0, 0)
                g.items.firstOrNull()?.let { col.addView(row(it), LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)) }
                return
            }
            col.background = rounded(withAlpha(colors.surface, 0.25f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            col.clipToOutline = true
            col.outlineProvider = roundOutline(dp(16).toFloat())
            val head = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPaddingRelative(dp(12), dp(10), dp(12), dp(10))
            }
            head.addView(poster(g.images, g.title, dp(36), dp(52), dp(6)))
            val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(label(g.title, 14f, bold = true, lines = 1).apply { setTextColor(colors.ink) })
            g.sub?.let { texts.addView(label(it, 11.5f, lines = 1).apply { setTextColor(colors.subtle) }) }
            head.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(12) })
            col.addView(head, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
            col.addView(View(ctx).apply { setBackgroundColor(withAlpha(colors.ink, 0.05f)) }, LinearLayout.LayoutParams(MATCH, dp(1)))
            val list = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(8), dp(8), dp(8), dp(8))
            }
            g.items.forEachIndexed { i, it ->
                list.addView(row(it), LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (i > 0) topMargin = dp(6) })
            }
            col.addView(list, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        private fun poster(urls: List<String>, seed: String, w: Int, h: Int, r: Int): View = NetImage(ctx).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            clipToOutline = true
            outlineProvider = roundOutline(r.toFloat())
            background = rounded(plate(seed), r.toFloat())
            layoutParams = LinearLayout.LayoutParams(w, h)
            if (urls.isNotEmpty()) images.load(this, urls, w, h)
        }

        private fun row(d: DlItem): View {
            val line = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(12), dp(12), dp(12))
                background = rounded(withAlpha(colors.surface, 0.4f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            }
            line.addView(if (d.compact) poster(d.images, d.title, dp(30), dp(44), dp(8)) else poster(d.images, d.title, dp(46), dp(68), dp(8)))
            val mid = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.BOTTOM
            }
            top.addView(label(d.title, 14.5f, bold = true, lines = 1).apply { setTextColor(colors.ink) },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            d.side?.let {
                top.addView(label(it, 12f, lines = 1).apply { setTextColor(colors.subtle) },
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
            }
            mid.addView(top, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
            val info = FlowRow(ctx, dp(6), dp(2))
            if (d.progress >= 0f) {
                // The bar: the done part (at least a sliver) and the rest, by weight.
                val done = d.progress.coerceIn(0.02f, 1f)
                val track = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    background = rounded(withAlpha(colors.ink, 0.1f), dp(3).toFloat())
                    clipToOutline = true
                    outlineProvider = roundOutline(dp(3).toFloat())
                    weightSum = 1f
                }
                track.addView(View(ctx).apply { background = rounded(if (d.paused) withAlpha(colors.ink, 0.35f) else colors.accent, dp(3).toFloat()) },
                    LinearLayout.LayoutParams(0, MATCH, done))
                mid.addView(track, LinearLayout.LayoutParams(MATCH, dp(6)).apply { topMargin = dp(8) })
                d.stats?.let { info.addView(label(it, 11.5f, lines = 1).apply { setTextColor(colors.muted); fontFeatureSettings = "tnum" }) }
                d.note?.let { info.addView(label("· $it", 11.5f, lines = 1).apply { setTextColor(amber) }) }
            } else {
                if (d.status == "done") {
                    info.addView(ImageView(ctx).apply {
                        setImageDrawable(icon(R.drawable.ic_check, colors.accent))
                        layoutParams = ViewGroup.LayoutParams(dp(13), dp(13))
                    })
                }
                d.statusText?.let {
                    info.addView(label(it, 12f).apply {
                        setTextColor(
                            when (d.status) {
                                "error" -> danger
                                "canceled" -> colors.subtle
                                "interrupted" -> amber
                                else -> colors.muted
                            },
                        )
                    })
                }
            }
            d.subs?.let { info.addView(label("· $it", 11.5f, lines = 1).apply { setTextColor(colors.subtle) }) }
            d.subsAction?.let { a ->
                info.addView(label(a, 11.5f, bold = true, lines = 1).apply {
                    setTextColor(colors.accent)
                    setPaddingRelative(dp(8), dp(2), dp(8), dp(2))
                    background = focusable(rounded(withAlpha(colors.accent, 0.15f), dp(6).toFloat()))
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { act("dl", what = "subs", text = d.id) }
                })
            }
            for (k in 0 until info.childCount) {
                val c = info.getChildAt(k)
                if (c.layoutParams == null) c.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            if (info.childCount > 0) mid.addView(info, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            line.addView(mid, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(16); marginEnd = dp(8) })
            for (b in d.buttons) {
                if (b.id == "confirm") {
                    line.addView(label(b.label, 12.5f, bold = true, lines = 1).apply {
                        gravity = Gravity.CENTER
                        setPaddingRelative(dp(12), 0, dp(12), 0)
                        setTextColor(Color.WHITE)
                        background = focusable(rounded(withAlpha(danger, 0.9f), dp(8).toFloat()))
                        isClickable = true
                        isFocusable = true
                        setOnClickListener { act("dl", what = "confirm", text = d.id) }
                    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)))
                    continue
                }
                val res = when (b.id) {
                    "pause" -> R.drawable.ic_pause
                    "resume", "play" -> R.drawable.ic_play
                    "cancel" -> R.drawable.ic_x
                    "retry" -> R.drawable.ic_rotate_cw
                    else -> R.drawable.ic_trash_2
                }
                line.addView(iconButton(res, b.label) { act("dl", what = b.id, text = d.id) })
            }
            return line
        }
    }

    // ---- the "…" menu -----------------------------------------------------------------------------

    private var sheetDialog: android.app.Dialog? = null
    private var sheetKey = ""
    private var sheetList: LinearLayout? = null
    /** Closed because the page said so (not by the person): don't tell the page back. */
    private var sheetQuiet = false

    /**
     * The page's menu sliding up from the bottom over a dimmed screen (as a phone's own menus
     * do): it scrolls when it's long, a tap outside or Back closes it, the page keeps its place.
     */
    private fun bindSheet(s: HomeSheet?) {
        if (s == null) {
            sheetDialog?.let {
                sheetQuiet = true
                it.dismiss()
            }
            sheetDialog = null
            sheetKey = ""
            return
        }
        // Opened once the screen is up (see applyVisibility).
        if (!isShowing) return
        if (sheetDialog == null || s.key != sheetKey) {
            sheetDialog?.let {
                sheetQuiet = true
                it.dismiss()
            }
            sheetKey = s.key
            openSheet()
        }
        fillSheet(s)
    }

    private fun openSheet() {
        val d = android.app.Dialog(ctx, android.R.style.Theme_Translucent_NoTitleBar)
        val shade = FrameLayout(ctx).apply {
            setBackgroundColor(0x99000000.toInt())
            isClickable = true
            setOnClickListener { d.cancel() }
        }
        val panel = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            isClickable = true
            background = GradientDrawable().also {
                it.setColor(colors.surface)
                val r = dp(22).toFloat()
                it.cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
            }
            setPadding(0, dp(10), 0, dp(18))
        }
        panel.addView(View(ctx).apply { background = rounded(withAlpha(colors.ink, 0.25f), dp(2).toFloat()) },
            LinearLayout.LayoutParams(dp(36), dp(4)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                bottomMargin = dp(8)
            })
        val scroll = android.widget.ScrollView(ctx).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        val list = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(list)
        panel.addView(scroll, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
        shade.addView(panel, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        // At most about three quarters of the screen; longer menus scroll.
        panel.addOnLayoutChangeListener { _, _, top, _, bottom, _, _, _, _ ->
            val max = (height() * 0.75f).toInt()
            if (bottom - top > max) {
                (scroll.layoutParams as LinearLayout.LayoutParams).let {
                    if (it.height != max - dp(40)) {
                        it.height = max - dp(40)
                        scroll.post { scroll.requestLayout() }
                    }
                }
            }
        }
        d.setContentView(shade)
        d.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        d.setOnDismissListener {
            if (sheetDialog === d) {
                sheetDialog = null
                sheetKey = ""
            }
            if (sheetQuiet) sheetQuiet = false else act("sheet", what = "")
        }
        sheetDialog = d
        sheetList = list
        try {
            d.show()
            panel.translationY = dp(320).toFloat()
            shade.alpha = 0f
            shade.animate().alpha(1f).setDuration(160).start()
            panel.animate().translationY(0f).setDuration(220).setInterpolator(android.view.animation.DecelerateInterpolator()).start()
        } catch (_: Exception) {
            sheetDialog = null
        }
    }

    private fun fillSheet(s: HomeSheet) {
        val list = sheetList ?: return
        val rtl = model?.rtl == true
        list.layoutDirection = if (rtl) View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
        list.removeAllViews()
        for (it in s.items) {
            if (it.divider) {
                list.addView(View(ctx).apply { setBackgroundColor(withAlpha(colors.ink, 0.08f)) },
                    LinearLayout.LayoutParams(MATCH, dp(1)).apply { setMargins(dp(16), dp(6), dp(16), dp(6)) })
                continue
            }
            val fg = when {
                it.danger -> 0xFFE5484D.toInt()
                it.active -> colors.accent
                it.indent -> colors.muted
                else -> colors.ink
            }
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(if (it.indent) 46 else 54)
                setPaddingRelative(if (it.indent) dp(58) else dp(24), 0, dp(20), 0)
                isClickable = true
                isFocusable = true
                background = focusable(rounded(Color.TRANSPARENT, dp(12).toFloat()))
                contentDescription = it.label
                val id = it.id
                setOnClickListener { act("sheet", what = id) }
            }
            val res = when (it.icon) {
                "bookmark" -> R.drawable.ic_bookmark
                "bookmark-check" -> R.drawable.ic_bookmark_check
                "info" -> R.drawable.ic_info
                "list-checks" -> R.drawable.ic_list_checks
                "list-plus" -> R.drawable.ic_list_plus
                "users" -> R.drawable.ic_users
                "pencil" -> R.drawable.ic_pencil
                "calendar" -> R.drawable.ic_calendar
                "plus" -> R.drawable.ic_plus
                "eye" -> R.drawable.ic_eye
                "eye-off" -> R.drawable.ic_eye_off
                "check" -> R.drawable.ic_check
                "star" -> R.drawable.ic_star
                "play" -> R.drawable.ic_play
                "x" -> R.drawable.ic_x
                "retry" -> R.drawable.ic_rotate_cw
                "download" -> R.drawable.ic_download
                else -> if (it.danger) R.drawable.ic_trash_2 else 0
            }
            if (res != 0) {
                row.addView(ImageView(ctx).apply { setImageDrawable(icon(res, if (it.active || it.danger) fg else colors.muted)) },
                    LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(18) })
            }
            row.addView(label(it.label, if (it.indent) 14f else 16f, lines = 1).apply { setTextColor(fg) },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (it.group) {
                row.addView(ImageView(ctx).apply {
                    setImageDrawable(icon(R.drawable.ic_chevron_down, colors.muted))
                    rotation = if (it.open) 180f else 0f
                }, LinearLayout.LayoutParams(dp(18), dp(18)))
            } else if (it.active && (it.indent || res == 0)) {
                row.addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_check, colors.ink)) }, LinearLayout.LayoutParams(dp(16), dp(16)))
            }
            list.addView(row, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(dp(8), 0, dp(8), 0) })
        }
    }

    // ---- Live TV ---------------------------------------------------------------------------------

    private val liveRed get() = 0xFFE5484D.toInt()

    /** "● LIVE": the page's red label (on a dark pill over pictures). */
    private fun liveLabel(sizeSp: Float, pill: Boolean): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        if (pill) {
            setPaddingRelative(dp(9), 0, dp(10), 0)
            background = rounded(withAlpha(colors.canvas, 0.9f), dp(11).toFloat())
        }
        addView(View(ctx).apply {
            background = GradientDrawable().also { it.shape = GradientDrawable.OVAL; it.setColor(liveRed) }
        }, LinearLayout.LayoutParams(dp(6), dp(6)).apply { marginEnd = dp(6) })
        addView(label((model?.label("live", "Live") ?: "Live").let { if (model?.rtl == true) it else it.uppercase() }, sizeSp, bold = true, lines = 1).apply {
            setTextColor(liveRed)
            letterSpacing = if (model?.rtl == true) 0f else 0.16f
        })
    }

    /** A programme's thin red bar (how far in), weighted like the downloads' bar. */
    private fun liveBar(progress: Float, heightDp: Int, track: Int): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        weightSum = 1f
        background = rounded(track, dp(2).toFloat())
        clipToOutline = true
        outlineProvider = roundOutline(dp(2).toFloat())
        addView(View(ctx).apply { setBackgroundColor(liveRed) }, LinearLayout.LayoutParams(0, MATCH, progress.coerceIn(0f, 1f)))
        layoutParams = LinearLayout.LayoutParams(MATCH, dp(heightDp))
    }

    /**
     * Live TV's cards, as the page draws them:
     * - [C_LIVE] a channel now (16:9): the programme's picture (or the channel's logo), "● LIVE",
     *   the number, logo and name, the programme, its bar and the time left;
     * - [C_GUIDE] On now: the logo, "● LIVE", the number and name, the programme and its bar,
     *   "Next 21:00 · …";
     * - [C_CHANNEL] the channel grid: the title's poster or the logo, "● LIVE", the name, the
     *   programme with the time left and its bar (or the channel's group).
     * Card fields: title, sub (channel name / programme), kicker (number), images (picture),
     * logo, progress + bar, desc (time left / next / group).
     */
    private inner class LiveFace(private val kind: Int) {
        val root: ViewGroup = if (kind == C_GUIDE || kind == C_CHANNEL || kind == C_SPORT) LinearLayout(ctx) else FrameLayout(ctx)

        fun bind(c: HomeCard, w: Int) {
            root.removeAllViews()
            when (kind) {
                C_GUIDE -> guide(c, w)
                C_CHANNEL -> channel(c, w)
                C_SPORT -> sport(c, w)
                else -> now(c, w)
            }
        }

        /**
         * A game, as the page's score card: the state (red "● 2nd 12:31" while live, "Final",
         * or the start time) and the league, then each side's logo, short name and score
         * (the loser dimmed). Fields: title / sub = away / home, rating / desc = their scores,
         * images / logo = their logos, kicker = state text, tone = accent (live) / plain (final)
         * / otherwise not started, button = league,
         * rank = 1 away dimmed, 2 home dimmed.
         */
        private fun sport(c: HomeCard, w: Int) {
            val col = root as LinearLayout
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = LinearLayout.LayoutParams(w, dp(96))
            col.setPadding(dp(12), dp(12), dp(12), dp(12))
            col.background = rounded(colors.surface, dp(12).toFloat(), dp(1), withAlpha(colors.ink, 0.07f))
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            // (accent = live, plain = final, otherwise not started)
            val state = when (c.tone) {
                "accent" -> "in"
                "plain" -> "post"
                else -> "pre"
            }
            top.addView(when (state) {
                "in" -> LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPaddingRelative(dp(6), 0, dp(6), 0)
                    background = rounded(liveRed, dp(4).toFloat())
                    addView(View(ctx).apply { background = GradientDrawable().also { it.shape = GradientDrawable.OVAL; it.setColor(Color.WHITE) } }, LinearLayout.LayoutParams(dp(6), dp(6)).apply { marginEnd = dp(4) })
                    addView(label((c.kicker ?: "").uppercase(), 10.5f, bold = true, lines = 1).apply { setTextColor(Color.WHITE) })
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(18))
                }
                else -> label(if (state == "post") (c.kicker ?: "").uppercase() else c.kicker ?: "", 11f, bold = true, lines = 1).apply {
                    setTextColor(if (state == "post") colors.muted else colors.subtle)
                }
            })
            top.addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
            top.addView(label((c.button ?: "").uppercase(), 10f, bold = true, lines = 1).apply { setTextColor(colors.subtle) })
            col.addView(top)
            col.addView(View(ctx), LinearLayout.LayoutParams(MATCH, 0, 1f))
            val active = state == "in" || state == "post"
            listOf(Triple(c.title, c.rating, (c.rank and 1) != 0), Triple(c.sub ?: "", c.desc, (c.rank and 2) != 0)).forEachIndexed { i, (name, score, dim) ->
                val line = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                val logo = NetImage(ctx).apply {
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    background = GradientDrawable().also { it.shape = GradientDrawable.OVAL; it.setColor(withAlpha(colors.canvas, 0.6f)) }
                }
                line.addView(logo, LinearLayout.LayoutParams(dp(20), dp(20)))
                (if (i == 0) c.images.firstOrNull() else c.logo)?.takeIf { it.isNotBlank() }?.let { u ->
                    images.load(logo, listOf(u), dp(20), dp(20), alpha = true) { ok -> if (ok) logo.background = null }
                }
                line.addView(label(name.uppercase(), 13f, bold = true, lines = 1).apply { setTextColor(if (dim) colors.subtle else colors.ink) },
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) })
                val position = score != null && Regex("^\\d+(st|nd|rd|th)$").matches(score)
                line.addView(label(score ?: "", if (position) 13f else 20f, bold = true, lines = 1).apply {
                    fontFeatureSettings = "tnum"
                    textAlignment = View.TEXT_ALIGNMENT_VIEW_END
                    setTextColor(if (active) (if (dim) colors.muted else colors.ink) else colors.subtle)
                }, LinearLayout.LayoutParams(if (position) ViewGroup.LayoutParams.WRAP_CONTENT else dp(36), ViewGroup.LayoutParams.WRAP_CONTENT))
                col.addView(line, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (i > 0) topMargin = dp(2) })
            }
        }

        private fun tvIcon(sizeDp: Int): ImageView = ImageView(ctx).apply {
            setImageDrawable(icon(R.drawable.ic_tv, colors.subtle))
            layoutParams = FrameLayout.LayoutParams(dp(sizeDp), dp(sizeDp), Gravity.CENTER)
        }

        private fun now(c: HomeCard, w: Int) {
            val box = root as FrameLayout
            val h = w * 9 / 16
            box.layoutParams = LinearLayout.LayoutParams(w, h)
            box.clipToOutline = true
            box.outlineProvider = roundOutline(dp(8).toFloat())
            box.background = rounded(colors.surface, dp(8).toFloat())
            box.foreground = rounded(Color.TRANSPARENT, dp(8).toFloat(), dp(1), withAlpha(colors.ink, 0.07f))
            val logoBox = FrameLayout(ctx).apply {
                setBackgroundColor(withAlpha(colors.surface, 0.7f))
                visibility = View.GONE
            }
            val bigLogo = NetImage(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
            logoBox.addView(bigLogo, FrameLayout.LayoutParams((w * 0.78f).toInt(), (h * 0.64f).toInt(), Gravity.CENTER))
            box.addView(logoBox, FrameLayout.LayoutParams(MATCH, MATCH))
            val art = NetImage(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            box.addView(art, FrameLayout.LayoutParams(MATCH, MATCH))
            val showLogo = {
                art.visibility = View.GONE
                logoBox.visibility = View.VISIBLE
                if (c.logo != null) {
                    images.load(bigLogo, listOf(c.logo), (w * 0.78f).toInt(), (h * 0.64f).toInt(), alpha = true) { ok ->
                        if (!ok) logoBox.addView(tvIcon(34))
                    }
                } else {
                    logoBox.addView(tvIcon(34))
                }
            }
            if (c.images.isNotEmpty()) images.load(art, c.images, w, h) { ok -> if (!ok) showLogo() } else showLogo()
            box.addView(View(ctx).apply {
                background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(colors.canvas, withAlpha(colors.canvas, 0.35f), Color.TRANSPARENT))
            }, FrameLayout.LayoutParams(MATCH, MATCH))
            box.addView(liveLabel(10.5f, true), FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(22), Gravity.TOP or Gravity.START).apply {
                marginStart = dp(12)
                topMargin = dp(12)
            })
            val bottom = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(14), dp(14), dp(14))
            }
            val line = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            c.kicker?.let { line.addView(label(it, 11.5f, lines = 1).apply { setTextColor(colors.subtle); fontFeatureSettings = "tnum" }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(6) }) }
            if (c.images.isNotEmpty() && c.logo != null) {
                val small = NetImage(ctx).apply { scaleType = ImageView.ScaleType.FIT_START }
                line.addView(small, LinearLayout.LayoutParams(dp(40), dp(16)).apply { marginEnd = dp(6) })
                images.load(small, listOf(c.logo), dp(52), dp(16), alpha = true) { ok -> if (!ok) small.visibility = View.GONE }
            }
            line.addView(label(c.sub ?: "", 11.5f, lines = 1).apply { setTextColor(colors.muted) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            bottom.addView(line)
            bottom.addView(label(c.title, 14.5f, bold = true, lines = 1).apply { setTextColor(colors.ink) }, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            if (c.bar) {
                val row = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                row.addView(liveBar(c.progress, 3, withAlpha(colors.canvas, 0.55f)).apply { layoutParams = LinearLayout.LayoutParams(0, dp(3), 1f) })
                c.desc?.let { row.addView(label(it, 10.5f, lines = 1).apply { setTextColor(colors.subtle) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) }) }
                bottom.addView(row, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            }
            box.addView(bottom, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }

        private fun guide(c: HomeCard, w: Int) {
            val col = root as LinearLayout
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = LinearLayout.LayoutParams(w, dp(132))
            col.setPadding(dp(14), dp(14), dp(14), dp(14))
            col.background = rounded(colors.surface, dp(8).toFloat(), dp(1), withAlpha(colors.ink, 0.07f))
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val logoBox = FrameLayout(ctx).apply { background = rounded(withAlpha(colors.canvas, 0.6f), dp(4).toFloat()) }
            if (c.logo != null) {
                val lg = NetImage(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
                logoBox.addView(lg, FrameLayout.LayoutParams(dp(40), dp(20), Gravity.CENTER))
                images.load(lg, listOf(c.logo), dp(40), dp(20), alpha = true) { ok -> if (!ok) logoBox.addView(tvIcon(14)) }
            } else {
                logoBox.addView(tvIcon(14))
            }
            top.addView(logoBox, LinearLayout.LayoutParams(dp(48), dp(28)))
            top.addView(liveLabel(10.5f, false), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
            top.addView(label(listOfNotNull(c.kicker, c.sub).joinToString(" "), 11.5f, lines = 1).apply {
                setTextColor(colors.subtle)
                textAlignment = View.TEXT_ALIGNMENT_VIEW_END
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) })
            col.addView(top)
            col.addView(View(ctx), LinearLayout.LayoutParams(MATCH, 0, 1f))
            col.addView(label(c.title, 14f, bold = true, lines = 1).apply { setTextColor(colors.ink) })
            if (c.bar) col.addView(liveBar(c.progress, 3, withAlpha(colors.canvas, 0.55f)).apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(6) })
            col.addView(View(ctx), LinearLayout.LayoutParams(MATCH, 0, 1f))
            col.addView(label(c.desc ?: "", 11.5f, lines = 1).apply { setTextColor(colors.subtle) })
        }

        private fun channel(c: HomeCard, w: Int) {
            val col = root as LinearLayout
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.clipToOutline = true
            col.outlineProvider = roundOutline(dp(16).toFloat())
            col.background = rounded(colors.surface, dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.07f))
            val poster = c.images.isNotEmpty()
            val top = FrameLayout(ctx).apply {
                setBackgroundColor(if (poster) colors.canvas else withAlpha(colors.surface, 0.7f))
            }
            val topH = if (poster) dp(160) else dp(90)
            if (poster) {
                val img = NetImage(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
                top.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                top.addView(View(ctx).apply {
                    background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(withAlpha(colors.canvas, 0.85f), Color.TRANSPARENT, Color.TRANSPARENT))
                }, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, c.images, w, topH)
            } else if (c.logo != null) {
                val lg = NetImage(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
                top.addView(lg, FrameLayout.LayoutParams(MATCH, MATCH).apply { setMargins(dp(12), dp(12), dp(12), dp(12)) })
                images.load(lg, listOf(c.logo), w, topH, alpha = true) { ok -> if (!ok) top.addView(tvIcon(22)) }
            } else {
                top.addView(tvIcon(22))
            }
            top.addView(liveLabel(10f, true), FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(20), Gravity.TOP or Gravity.START).apply {
                marginStart = dp(10)
                topMargin = dp(10)
            })
            col.addView(top, LinearLayout.LayoutParams(MATCH, topH))
            val body = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
            }
            body.addView(label(c.title, 14.5f, bold = true, lines = 1).apply { setTextColor(colors.ink) })
            if (c.sub != null) {
                val row = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.BOTTOM
                }
                row.addView(label(c.sub, 12.5f, lines = 1).apply { setTextColor(colors.muted) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                c.desc?.let { row.addView(label(it, 10.5f, lines = 1).apply { setTextColor(colors.subtle) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) }) }
                body.addView(row, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
                if (c.bar) body.addView(liveBar(c.progress, 3, withAlpha(colors.canvas, 0.55f)).apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(6) })
            } else {
                body.addView(label(c.desc ?: "", 12.5f, lines = 1).apply { setTextColor(colors.subtle) }, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            }
            col.addView(body)
        }
    }

    /**
     * Live TV's spotlight, as the page shows it: one channel at a time (every 9 s the next), its
     * programme's picture (or its logo, large), the channel's logo in the corner, the dots,
     * "LIVE" with the time left, the programme in large type, "channel · group", the red bar
     * along the bottom. A tap plays it.
     */
    private inner class LiveHeroHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val wrap = itemView as FrameLayout
        private val card = FrameLayout(ctx)
        private var row: HomeRow? = null
        private var idx = 0
        private var key = ""
        private val turn = Runnable { advance() }

        init {
            wrap.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            wrap.setPaddingRelative(dp(16), 0, dp(16), dp(32))
            card.clipToOutline = true
            card.outlineProvider = roundOutline(dp(8).toFloat())
            card.isClickable = true
            card.isFocusable = true
            card.setOnClickListener { row?.let { act("open", row = it.key, i = idx) } }
            wrap.addView(card, FrameLayout.LayoutParams(MATCH, dp(420)))
            wrap.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(v: View) = schedule()
                override fun onViewDetachedFromWindow(v: View) {
                    wrap.removeCallbacks(turn)
                }
            })
        }

        private fun schedule() {
            wrap.removeCallbacks(turn)
            if ((row?.items?.size ?: 0) > 1) wrap.postDelayed(turn, 9000)
        }

        private fun advance() {
            val r = row ?: return
            if (r.items.size < 2) return
            idx = (idx + 1) % r.items.size
            draw(true)
            schedule()
        }

        fun bind(r: HomeRow) {
            val k = r.items.joinToString("|") { it.sub + it.title }
            if (k != key) {
                if (r.items.map { it.sub } != row?.items?.map { it.sub }) idx = 0
                key = k
            }
            row = r
            if (idx >= r.items.size) idx = 0
            draw(false)
            schedule()
        }

        private fun draw(fade: Boolean) {
            val r = row ?: return
            val c = r.items.getOrNull(idx) ?: return
            val rtl = model?.rtl == true
            val w = width() - 2 * dp(16)
            val h = dp(420)
            card.removeAllViews()
            card.setBackgroundColor(colors.canvas)
            card.contentDescription = listOfNotNull(c.title, c.sub).joinToString(" · ")
            val art = NetImage(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            val big = NetImage(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
            card.addView(big, FrameLayout.LayoutParams((w * 0.4f).toInt(), (h * 0.42f).toInt(), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = (h * 0.38f - h * 0.21f).toInt() })
            card.addView(art, FrameLayout.LayoutParams(MATCH, MATCH))
            val logoInstead = {
                art.visibility = View.GONE
                if (c.logo != null) images.load(big, listOf(c.logo), (w * 0.4f).toInt(), (h * 0.42f).toInt(), alpha = true)
            }
            if (c.images.isNotEmpty()) images.load(art, c.images, w, h, crop = true) { ok -> if (!ok) logoInstead() } else logoInstead()
            card.addView(View(ctx).apply {
                background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(colors.canvas, withAlpha(colors.canvas, 0.35f), Color.TRANSPARENT))
            }, FrameLayout.LayoutParams(MATCH, MATCH))
            card.addView(View(ctx).apply {
                background = GradientDrawable(
                    if (rtl) GradientDrawable.Orientation.RIGHT_LEFT else GradientDrawable.Orientation.LEFT_RIGHT,
                    intArrayOf(withAlpha(colors.canvas, 0.65f), Color.TRANSPARENT, Color.TRANSPARENT),
                )
            }, FrameLayout.LayoutParams(MATCH, MATCH))
            // The channel's logo in the corner.
            if (c.logo != null) {
                val bug = FrameLayout(ctx).apply {
                    background = rounded(withAlpha(colors.canvas, 0.85f), dp(8).toFloat())
                    setPadding(dp(12), 0, dp(12), 0)
                }
                val lg = NetImage(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
                bug.addView(lg, FrameLayout.LayoutParams(dp(92), dp(28), Gravity.CENTER))
                images.load(lg, listOf(c.logo), dp(92), dp(28), alpha = true) { ok -> if (!ok) bug.visibility = View.GONE }
                card.addView(bug, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48), Gravity.TOP or Gravity.START).apply {
                    marginStart = dp(24)
                    topMargin = dp(24)
                })
            }
            // The dots (a tap shows that one).
            if (r.items.size > 1) {
                val dots = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                r.items.indices.forEach { i ->
                    dots.addView(View(ctx).apply {
                        background = rounded(if (i == idx) colors.ink else withAlpha(colors.muted, 0.6f), dp(3).toFloat())
                        isClickable = true
                        setOnClickListener {
                            idx = i
                            draw(true)
                            schedule()
                        }
                    }, LinearLayout.LayoutParams(if (i == idx) dp(32) else dp(16), dp(6)).apply { marginStart = dp(8) })
                }
                card.addView(dots, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
                    marginEnd = dp(24)
                    topMargin = dp(24)
                })
            }
            val text = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(24), 0, dp(24), dp(28))
            }
            val badges = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            badges.addView(label((model?.label("live", "Live") ?: "Live").let { if (rtl) it else it.uppercase() }, 11f, bold = true, lines = 1).apply {
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                letterSpacing = if (rtl) 0f else 0.16f
                setPaddingRelative(dp(10), 0, dp(10), 0)
                background = rounded(liveRed, dp(6).toFloat())
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(24)))
            c.desc?.let {
                badges.addView(ImageView(ctx).apply { setImageDrawable(icon(R.drawable.ic_rotate_ccw, colors.ink)) }, LinearLayout.LayoutParams(dp(14), dp(14)).apply { marginStart = dp(12) })
                badges.addView(label(it, 13f, bold = true, lines = 1).apply { setTextColor(colors.ink) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(6) })
            }
            text.addView(badges)
            text.addView(label(c.title, 34f, bold = true, lines = 2).apply {
                setTextColor(colors.ink)
                typeface = Typeface.create(Typeface.SERIF, Typeface.BOLD)
                setLineSpacing(0f, 1.04f)
                maxWidth = (w * 0.88f).toInt()
            }, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
            c.sub?.let { text.addView(label(it, 14f, bold = true, lines = 1).apply { setTextColor(colors.muted) }, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }) }
            card.addView(text, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            if (c.bar) {
                card.addView(liveBar(c.progress, 5, 0x59000000).apply {
                    background = null
                    setBackgroundColor(0x59000000)
                    clipToOutline = false
                    layoutParams = FrameLayout.LayoutParams(MATCH, dp(5), Gravity.BOTTOM)
                })
            }
            if (fade) {
                text.alpha = 0f
                text.translationY = dp(8).toFloat()
                text.animate().alpha(1f).translationY(0f).setDuration(420).start()
            }
        }
    }

    // ---- The discovery queue -------------------------------------------------------------------

    /**
     * Lays out [lead] at its own height and every other child exactly over it (a card's picture
     * and shades take the size of its text, never their own).
     */
    private class BackedBox(ctx: Context) : FrameLayout(ctx) {
        var lead: View? = null

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val c = lead ?: return super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            val w = MeasureSpec.getSize(widthMeasureSpec)
            c.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            val h = c.measuredHeight
            for (i in 0 until childCount) {
                val v = getChildAt(i)
                if (v !== c) v.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
            }
            setMeasuredDimension(w, h)
        }
    }

    /**
     * Lets [target] follow a finger sideways; let go past a quarter of the width (or flung) and
     * [onTurn] is told which way: forward is toward the reading direction's start (a swipe to the
     * left, to the right in Arabic), as when turning a page. Taps still reach the buttons inside.
     */
    private inner class SwipeFrame : FrameLayout(ctx) {
        var target: View? = null
        var onTurn: ((forward: Boolean) -> Unit)? = null
        var canPrev = false
        var canNext = false
        private val slop = android.view.ViewConfiguration.get(ctx).scaledTouchSlop
        private var downX = 0f
        private var downY = 0f
        private var dragging = false
        private var tracker: android.view.VelocityTracker? = null
        /** Where the card went (px, signed) on the last turn, until the next title takes it back. */
        private var turnedTo = 0f
        private val settle = Runnable {
            if (turnedTo != 0f) {
                turnedTo = 0f
                target?.animate()?.translationX(0f)?.alpha(1f)?.setDuration(180)?.start()
            }
        }

        fun takeTurnedFrom(): Float {
            val v = turnedTo
            turnedTo = 0f
            removeCallbacks(settle)
            return v
        }

        private fun forward(dx: Float) = if (layoutDirection == View.LAYOUT_DIRECTION_RTL) dx > 0 else dx < 0

        private fun allowed(dx: Float) = if (forward(dx)) canNext else canPrev

        override fun onInterceptTouchEvent(e: android.view.MotionEvent): Boolean {
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    downX = e.x
                    downY = e.y
                    dragging = false
                    tracker?.recycle()
                    tracker = android.view.VelocityTracker.obtain().also { it.addMovement(e) }
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    tracker?.addMovement(e)
                    if (!dragging && startDrag(e)) return true
                }
            }
            return dragging
        }

        private fun startDrag(e: android.view.MotionEvent): Boolean {
            val dx = e.x - downX
            val dy = e.y - downY
            if (target?.visibility != View.VISIBLE || abs(dx) < slop || abs(dx) < abs(dy) * 1.5f) return false
            dragging = true
            parent?.requestDisallowInterceptTouchEvent(true)
            target?.animate()?.cancel()
            return true
        }

        override fun onTouchEvent(e: android.view.MotionEvent): Boolean {
            val t = target ?: return false
            tracker?.addMovement(e)
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> return true
                android.view.MotionEvent.ACTION_MOVE -> {
                    if (!dragging && !startDrag(e)) return true
                    val dx = e.x - downX
                    // Toward an end of the queue it gives only a little.
                    t.translationX = if (allowed(dx)) dx else dx * 0.25f
                    t.alpha = 1f - min(0.35f, abs(t.translationX) / max(1, width).toFloat())
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    val wasDragging = dragging
                    dragging = false
                    val dx = e.x - downX
                    val vt = tracker
                    vt?.computeCurrentVelocity(1000)
                    val vx = vt?.xVelocity ?: 0f
                    vt?.recycle()
                    tracker = null
                    if (!wasDragging) return true
                    val flung = abs(vx) > dp(700) && (vx > 0) == (dx > 0)
                    val go = e.actionMasked == android.view.MotionEvent.ACTION_UP && allowed(dx) && (abs(dx) > width * 0.25f || flung)
                    if (go) {
                        val to = (if (dx > 0) 1 else -1) * width.toFloat()
                        t.animate().translationX(to).alpha(0f).setDuration(160).withEndAction {
                            turnedTo = to
                            onTurn?.invoke(forward(dx))
                            // No new title after all (the end of the queue): back in place.
                            postDelayed(settle, 700)
                        }.start()
                    } else {
                        t.animate().translationX(0f).alpha(1f).setDuration(180).start()
                    }
                }
            }
            return true
        }
    }

    /**
     * The discovery queue, like the page: a big card for the title up now (its tag, name, year ·
     * runtime · IMDb · genres, overview; Play tonight, Save, Skip, Not interested; details at the
     * top; previous / next at the sides), then the queue's pictures in a strip (a tap jumps there,
     * the one up now ringed in the accent colour, the ones already passed faded).
     * The card turns to the next / previous title with a swipe (no arrows).
     */
    private inner class QueueHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val wrap = SwipeFrame()
        private val card = BackedBox(ctx)
        private val backdrop = NetImage(ctx)
        private val shadeUp = View(ctx)
        private val shadeSide = View(ctx)
        private val content = LinearLayout(ctx)
        private val position = label("", 12f, bold = true, lines = 1)
        private val info = FrameLayout(ctx)
        private val infoIcon = ImageView(ctx)
        private val tags = LinearLayout(ctx)
        private val tagPill = label("", 11.5f, bold = true, lines = 1)
        private val seriesPill = label("", 11.5f, bold = true, lines = 1)
        private val title = label("", 34f, lines = 2)
        private val facts = FlowRow(ctx, dp(10), dp(4))
        private val desc = label("", 15.5f, lines = 3)
        private val buttons = FlowRow(ctx, dp(12), dp(8))
        private val message = label("", 15f)
        private val stripLabel = label("", 11f, bold = true, lines = 1)
        /** The queue's pictures: a list of its own, so only those in sight are made and loaded. */
        private val strip = RecyclerView(ctx)
        private val stripLayout = LinearLayoutManager(ctx, RecyclerView.HORIZONTAL, false)
        private val stripAdapter = QueueStripAdapter()
        private var stripKey = ""
        private var shownTitle = ""

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPadding(0, dp(4), 0, dp(28))
            val dark = Color.rgb(10, 12, 19)

            backdrop.scaleType = ImageView.ScaleType.CENTER_CROP
            card.addView(backdrop)
            shadeUp.background = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(withAlpha(dark, 0.96f), withAlpha(dark, 0.55f), Color.TRANSPARENT, Color.TRANSPARENT),
            )
            card.addView(shadeUp)
            card.addView(shadeSide)
            content.orientation = LinearLayout.VERTICAL
            content.minimumHeight = dp(480)
            content.setPaddingRelative(dp(24), dp(28), dp(24), dp(48))
            card.addView(content)
            card.lead = content
            card.clipToOutline = true
            card.outlineProvider = roundOutline(dp(28).toFloat())

            // The top: where in the queue, and the details button.
            val top = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            top.addView(position, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            info.isClickable = true
            info.isFocusable = true
            info.setOnClickListener { act("q", what = "info") }
            info.addView(infoIcon, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
            top.addView(info, LinearLayout.LayoutParams(dp(44), dp(44)))
            content.addView(top, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
            content.addView(View(ctx), LinearLayout.LayoutParams(MATCH, dp(24), 1f))

            tags.orientation = LinearLayout.HORIZONTAL
            tags.gravity = Gravity.CENTER_VERTICAL
            tagPill.setPaddingRelative(dp(12), dp(4), dp(12), dp(4))
            seriesPill.setPaddingRelative(dp(12), dp(4), dp(12), dp(4))
            tags.addView(tagPill)
            tags.addView(seriesPill, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
            content.addView(tags, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
            title.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            title.setShadowLayer(dp(14).toFloat(), 0f, dp(2).toFloat(), 0x8C000000.toInt())
            title.setLineSpacing(0f, 1.05f)
            content.addView(title, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(20) })
            content.addView(facts, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })
            desc.setLineSpacing(0f, 1.4f)
            content.addView(desc, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18) })
            content.addView(buttons, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(26) })

            wrap.clipChildren = false
            wrap.addView(card, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(24)
                marginEnd = dp(24)
            })
            wrap.target = card
            wrap.onTurn = { forward -> act("q", what = if (forward) "next" else "prev") }
            message.gravity = Gravity.CENTER
            message.textAlignment = View.TEXT_ALIGNMENT_CENTER
            message.setPadding(dp(32), dp(48), dp(32), dp(48))
            message.minHeight = dp(480)
            wrap.addView(message, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                marginStart = dp(24)
                marginEnd = dp(24)
            })
            col.addView(wrap, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))

            col.addView(stripLabel, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(24)
                marginStart = dp(24)
                marginEnd = dp(24)
            })
            strip.layoutManager = stripLayout
            strip.adapter = stripAdapter
            strip.itemAnimator = null
            strip.overScrollMode = View.OVER_SCROLL_NEVER
            strip.clipToPadding = false
            strip.setPaddingRelative(dp(24), dp(12), dp(24), dp(4))
            col.addView(strip, LinearLayout.LayoutParams(MATCH, dp(112 + 16)))
        }

        fun bind(q: HomeQueue) {
            val rtl = model?.rtl == true
            val has = q.title.isNotBlank()
            card.visibility = if (has) View.VISIBLE else View.GONE
            wrap.canPrev = has && q.canPrev
            wrap.canNext = has && q.canNext
            message.visibility = if (has || q.message.isNullOrBlank()) View.GONE else View.VISIBLE
            message.text = q.message ?: ""
            message.setTextColor(colors.muted)
            message.background = rounded(withAlpha(colors.surface, 0.3f), dp(28).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            if (has) bindCard(q, rtl)
            bindStrip(q, rtl)
        }

        private fun bindCard(q: HomeQueue, rtl: Boolean) {
            card.background = rounded(colors.canvas, dp(28).toFloat())
            card.foreground = rounded(Color.TRANSPARENT, dp(28).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            val dark = Color.rgb(10, 12, 19)
            shadeSide.background = GradientDrawable(
                if (rtl) GradientDrawable.Orientation.RIGHT_LEFT else GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(withAlpha(dark, 0.62f), withAlpha(dark, 0.25f), Color.TRANSPARENT, Color.TRANSPARENT),
            )
            images.load(backdrop, q.backdrop, width() - dp(48), dp(560), crop = true)

            position.text = q.position
            position.letterSpacing = 0.22f
            position.setTextColor(withAlpha(colors.ink, 0.85f))
            info.background = focusable(rounded(withAlpha(colors.canvas, 0.35f), dp(22).toFloat(), dp(1), withAlpha(colors.ink, 0.15f)))
            info.contentDescription = q.label("info", "See details")
            infoIcon.setImageDrawable(icon(R.drawable.ic_info, withAlpha(colors.ink, 0.85f)))

            tagPill.text = q.tag?.let { if (rtl) it else it.uppercase() } ?: ""
            tagPill.visibility = if (q.tag.isNullOrBlank()) View.GONE else View.VISIBLE
            tagPill.letterSpacing = if (rtl) 0f else 0.22f
            tagPill.setTextColor(colors.canvas)
            tagPill.background = rounded(withAlpha(colors.accent, 0.9f), dp(14).toFloat())
            seriesPill.text = q.series?.let { if (rtl) it else it.uppercase() } ?: ""
            seriesPill.visibility = if (q.series.isNullOrBlank()) View.GONE else View.VISIBLE
            seriesPill.letterSpacing = tagPill.letterSpacing
            seriesPill.setTextColor(withAlpha(colors.ink, 0.85f))
            seriesPill.background = rounded(Color.TRANSPARENT, dp(14).toFloat(), dp(1), withAlpha(colors.ink, 0.3f))
            tags.visibility = if (tagPill.visibility == View.VISIBLE || seriesPill.visibility == View.VISIBLE) View.VISIBLE else View.GONE

            title.text = q.title
            title.setTextColor(colors.ink)

            // Year · runtime · IMDb rating · genres.
            facts.removeAllViews()
            val parts = ArrayList<View>()
            for (f in q.facts) parts.add(label(f, 14f, lines = 1).apply { setTextColor(withAlpha(colors.ink, 0.85f)) })
            q.rating?.let { parts.add(imdbBadge(it, 13f, trailing = 0)) }
            q.genres?.let { parts.add(label(it, 14f, lines = 1).apply { setTextColor(withAlpha(colors.ink, 0.85f)) }) }
            parts.forEachIndexed { i, v ->
                if (i > 0) facts.addView(label("·", 14f, lines = 1).apply { setTextColor(withAlpha(colors.ink, 0.4f)) })
                v.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                facts.addView(v)
            }
            facts.visibility = if (parts.isEmpty()) View.GONE else View.VISIBLE

            desc.text = q.desc ?: ""
            desc.visibility = if (q.desc.isNullOrBlank()) View.GONE else View.VISIBLE
            desc.setTextColor(withAlpha(colors.ink, 0.8f))

            buttons.removeAllViews()
            buttons.addView(button(R.drawable.ic_play, q.label("play", "Play tonight"), "play", filled = true))
            buttons.addView(
                button(
                    if (q.saved) R.drawable.ic_bookmark_check else R.drawable.ic_bookmark,
                    if (q.saved) q.label("saved", "Saved") else q.label("save", "Save"),
                    "save",
                    on = q.saved,
                ),
            )
            buttons.addView(button(R.drawable.ic_skip_forward, q.label("skip", "Skip"), "skip"))
            buttons.addView(button(R.drawable.ic_thumbs_down, q.label("block", "Not interested"), "block"))

            // Another title: it slides in (the page's 200 ms change); after a swipe the whole card
            // comes in from the side it was swiped toward's other side.
            if (shownTitle.isNotEmpty() && shownTitle != q.title + q.position) {
                val from = wrap.takeTurnedFrom()
                if (from != 0f) {
                    card.animate().cancel()
                    card.translationX = -from * 0.35f
                    card.alpha = 0f
                    card.animate().translationX(0f).alpha(1f).setDuration(220).start()
                } else {
                    content.alpha = 0f
                    content.translationX = dp(if (rtl) -24 else 24).toFloat()
                    content.animate().alpha(1f).translationX(0f).setDuration(200).start()
                }
            }
            shownTitle = q.title + q.position
        }

        private fun button(res: Int, text: String, what: String, filled: Boolean = false, on: Boolean = false): View =
            LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                isClickable = true
                isFocusable = true
                contentDescription = text
                setPaddingRelative(dp(if (filled) 28 else 20), 0, dp(if (filled) 28 else 20), 0)
                val fg = when {
                    filled -> colors.canvas
                    on -> colors.accent
                    else -> withAlpha(colors.ink, 0.85f)
                }
                background = focusable(
                    when {
                        filled -> rounded(colors.ink, dp(24).toFloat())
                        on -> rounded(withAlpha(colors.accent, 0.15f), dp(24).toFloat(), dp(1), withAlpha(colors.accent, 0.6f))
                        else -> rounded(withAlpha(colors.canvas, 0.3f), dp(24).toFloat(), dp(1), withAlpha(colors.ink, 0.15f))
                    },
                )
                addView(ImageView(ctx).apply { setImageDrawable(icon(res, fg)) }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(if (filled) 10 else 8) })
                addView(label(text, if (filled) 15f else 14f, bold = filled, lines = 1).apply { setTextColor(fg) })
                // The flow row measures by content: the height comes from here.
                minimumHeight = dp(48)
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48))
                setOnClickListener { act("q", what = what) }
            }

        private fun bindStrip(q: HomeQueue, rtl: Boolean) {
            stripLabel.text = q.label("queue", "Queue").let { if (rtl) it else it.uppercase() }
            stripLabel.letterSpacing = if (rtl) 0f else 0.24f
            stripLabel.setTextColor(colors.subtle)
            stripLabel.visibility = if (q.strip.isEmpty()) View.GONE else View.VISIBLE
            strip.visibility = stripLabel.visibility
            val key = q.strip.joinToString("|") { it.tag + it.img.firstOrNull() }
            val fresh = stripKey.isEmpty()
            val was = stripAdapter.active
            val changed = key != stripKey
            stripAdapter.active = q.active
            if (changed) {
                stripKey = key
                stripAdapter.tiles = q.strip
                stripAdapter.notifyDataSetChanged()
            } else if (was != q.active) {
                stripAdapter.notifyItemChanged(was)
                stripAdapter.notifyItemChanged(q.active)
            }
            if (q.active !in q.strip.indices) return
            // The one up now, in the middle of the strip.
            if (fresh) {
                stripLayout.scrollToPositionWithOffset(q.active, max(0, (width() - dp(200)) / 2 - dp(24)))
            } else if (was != q.active || changed) {
                val centre = object : androidx.recyclerview.widget.LinearSmoothScroller(ctx) {
                    override fun calculateDtToFit(viewStart: Int, viewEnd: Int, boxStart: Int, boxEnd: Int, snapPreference: Int): Int =
                        (boxStart + (boxEnd - boxStart) / 2) - (viewStart + (viewEnd - viewStart) / 2)
                }
                centre.targetPosition = q.active
                strip.post { stripLayout.startSmoothScroll(centre) }
            }
        }
    }

    /** The discovery queue's strip: [tiles], the one up now ([active]) ringed, those before it faded. */
    private inner class QueueStripAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        var tiles: List<QueueTile> = emptyList()
        var active = 0

        override fun getItemCount(): Int = tiles.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder = QueueTileHolder()

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            tiles.getOrNull(position)?.let { (holder as QueueTileHolder).bind(it, position, active) }
        }

        override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
            images.clear((holder as QueueTileHolder).img)
        }
    }

    private inner class QueueTileHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val tile = itemView as FrameLayout
        val img = NetImage(ctx)
        private val glow = View(ctx)
        private val tag = label("", 9.5f, bold = true, lines = 1)
        private var index = -1

        init {
            tile.layoutParams = RecyclerView.LayoutParams(dp(200), dp(112)).apply { marginEnd = dp(12) }
            tile.isClickable = true
            tile.isFocusable = true
            tile.clipToOutline = true
            tile.outlineProvider = roundOutline(dp(10).toFloat())
            tile.setOnClickListener { if (index >= 0) act("q", what = "jump", i = index) }
            img.scaleType = ImageView.ScaleType.CENTER_CROP
            tile.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
            tile.addView(glow, FrameLayout.LayoutParams(MATCH, MATCH))
            tag.setPaddingRelative(dp(6), dp(2), dp(6), dp(2))
            tile.addView(tag, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                marginStart = dp(6)
                topMargin = dp(6)
            })
        }

        fun bind(t: QueueTile, i: Int, active: Int) {
            index = i
            val rtl = model?.rtl == true
            tile.background = rounded(plate(t.tag + i), dp(10).toFloat())
            tile.contentDescription = t.tag
            images.load(img, t.img, dp(200), dp(112))
            tag.text = if (rtl) t.tag else t.tag.uppercase()
            tag.visibility = if (t.tag.isBlank()) View.GONE else View.VISIBLE
            tag.letterSpacing = if (rtl) 0f else 0.12f
            tag.setTextColor(colors.ink)
            tag.background = rounded(withAlpha(colors.canvas, 0.85f), dp(6).toFloat())
            val on = i == active
            tile.alpha = if (i < active) 0.5f else 1f
            tile.foreground = if (on) rounded(Color.TRANSPARENT, dp(10).toFloat(), dp(2), colors.accent) else null
            glow.background = if (on) {
                GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(withAlpha(colors.accent, 0.18f), withAlpha(colors.accent, 0.28f)))
            } else {
                null
            }
        }
    }

    /** Children side by side, onto the next line when one doesn't fit (the hero's pills). */
    private class FlowRow(ctx: Context, private val gapX: Int, private val gapY: Int) : ViewGroup(ctx) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val maxW = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
            var x = 0
            var y = 0
            var lineH = 0
            for (i in 0 until childCount) {
                val c = getChildAt(i)
                if (c.visibility == View.GONE) continue
                c.measure(MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
                if (x > 0 && x + c.measuredWidth > maxW) {
                    x = 0
                    y += lineH + gapY
                    lineH = 0
                }
                x += c.measuredWidth + gapX
                lineH = max(lineH, c.measuredHeight)
            }
            setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), y + lineH + paddingTop + paddingBottom)
        }

        /** Each line centred (a message's pills) instead of starting at the side. */
        var center = false
        /** Each child centred on its line's height (a badge beside a text). */
        var middle = false

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            val maxW = r - l - paddingLeft - paddingRight
            val rtl = layoutDirection == View.LAYOUT_DIRECTION_RTL
            // The lines first (which children, how wide, how tall), then each laid out.
            val lines = ArrayList<IntArray>()
            var x = 0
            var lineH = 0
            var from = 0
            for (i in 0 until childCount) {
                val c = getChildAt(i)
                if (c.visibility == View.GONE) continue
                val w = c.measuredWidth
                if (x > 0 && x + w > maxW) {
                    lines.add(intArrayOf(from, i, x - gapX, lineH))
                    from = i
                    x = 0
                    lineH = 0
                }
                x += w + gapX
                lineH = max(lineH, c.measuredHeight)
            }
            lines.add(intArrayOf(from, childCount, (x - gapX).coerceAtLeast(0), lineH))
            var y = paddingTop
            for (ln in lines) {
                var cx = if (center) ((maxW - ln[2]) / 2).coerceAtLeast(0) else 0
                for (i in ln[0] until ln[1]) {
                    val c = getChildAt(i)
                    if (c.visibility == View.GONE) continue
                    val w = c.measuredWidth
                    val h = c.measuredHeight
                    val top = if (middle) y + (ln[3] - h) / 2 else y
                    val left = if (rtl) r - l - paddingRight - cx - w else paddingLeft + cx
                    c.layout(left, top, left + w, top + h)
                    cx += w + gapX
                }
                y += ln[3] + gapY
            }
        }
    }

    // ---- hero ----------------------------------------------------------------------------------

    private inner class HeroHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        private val pager = RecyclerView(ctx)
        private val dots = LinearLayout(ctx)
        private val slides = SlidesAdapter()
        private val pagerLayout = LinearLayoutManager(ctx, RecyclerView.HORIZONTAL, false)
        private val snap = PagerSnapHelper()
        /** The next slide on its own, every [HERO_TURN_MS] (like the page's carousel). */
        private val turn = Runnable { autoTurn() }

        init {
            frame.layoutParams = RecyclerView.LayoutParams(MATCH, heroHeight())
            pager.layoutManager = pagerLayout
            pager.adapter = slides
            pager.overScrollMode = View.OVER_SCROLL_NEVER
            pager.itemAnimator = null
            snap.attachToRecyclerView(pager)
            pager.addOnScrollListener(object : RecyclerView.OnScrollListener() {
                override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
                    // A swipe by hand: the next turn waits a full interval from now.
                    if (newState == RecyclerView.SCROLL_STATE_DRAGGING) scheduleTurn()
                    if (newState != RecyclerView.SCROLL_STATE_IDLE) return
                    val v = snap.findSnapView(pagerLayout) ?: return
                    val p = pagerLayout.getPosition(v)
                    if (p != RecyclerView.NO_POSITION) {
                        heroPage = p
                        paintDots()
                    }
                }
            })
            frame.addView(pager, FrameLayout.LayoutParams(MATCH, MATCH))
            dots.orientation = LinearLayout.HORIZONTAL
            dots.gravity = Gravity.CENTER
            frame.addView(dots, FrameLayout.LayoutParams(MATCH, dp(10), Gravity.BOTTOM).apply { bottomMargin = dp(18) })
            frame.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(v: View) = scheduleTurn()
                override fun onViewDetachedFromWindow(v: View) {
                    frame.removeCallbacks(turn)
                }
            })
        }

        private fun scheduleTurn() {
            frame.removeCallbacks(turn)
            frame.postDelayed(turn, HERO_TURN_MS)
        }

        /** Only while the screen shows, nobody is swiping it and the D-pad isn't on its buttons. */
        private fun autoTurn() {
            val n = model?.hero?.size ?: 0
            if (n > 1 && isShowing && pager.scrollState == RecyclerView.SCROLL_STATE_IDLE && !frame.hasFocus()) {
                val next = (heroPage + 1) % n
                if (next == 0) {
                    // Back to the first: a quick fade rather than sliding past every slide.
                    pager.animate().alpha(0f).setDuration(220).withEndAction {
                        pagerLayout.scrollToPosition(0)
                        heroPage = 0
                        paintDots()
                        pager.animate().alpha(1f).setDuration(320).start()
                    }.start()
                } else {
                    val slide = object : androidx.recyclerview.widget.LinearSmoothScroller(ctx) {
                        override fun calculateSpeedPerPixel(dm: android.util.DisplayMetrics): Float = 160f / dm.densityDpi
                    }
                    slide.targetPosition = next
                    pagerLayout.startSmoothScroll(slide)
                }
            }
            scheduleTurn()
        }

        fun bind(m: HomeModel) {
            val lp = frame.layoutParams
            val h = heroHeight()
            if (lp.height != h) {
                lp.height = h
                frame.layoutParams = lp
            }
            slides.submit(m.hero)
            pager.alpha = 1f
            if (heroPage >= m.hero.size) heroPage = 0
            pagerLayout.scrollToPosition(heroPage)
            paintDots()
        }

        private fun paintDots() {
            val n = model?.hero?.size ?: 0
            if (dots.childCount != n) {
                dots.removeAllViews()
                repeat(n) { dots.addView(View(ctx)) }
            }
            dots.visibility = if (n > 1) View.VISIBLE else View.GONE
            for (i in 0 until n) {
                val on = i == heroPage
                val d = dots.getChildAt(i)
                d.layoutParams = LinearLayout.LayoutParams(if (on) dp(22) else dp(6), dp(6)).apply {
                    marginStart = dp(3)
                    marginEnd = dp(3)
                }
                d.background = rounded(if (on) colors.ink else withAlpha(colors.ink, 0.35f), dp(3).toFloat())
            }
        }
    }

    private inner class SlidesAdapter : RecyclerView.Adapter<SlideHolder>() {
        private var items: List<HomeSlide> = emptyList()

        fun submit(s: List<HomeSlide>) {
            items = s
            notifyDataSetChanged()
        }

        override fun getItemCount() = items.size
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = SlideHolder()
        override fun onBindViewHolder(holder: SlideHolder, position: Int) = holder.bind(items[position])
        override fun onViewRecycled(holder: SlideHolder) {
            images.clear(holder.backdrop)
            images.clear(holder.logo)
        }
    }

    private inner class SlideHolder : RecyclerView.ViewHolder(FrameLayout(ctx)) {
        private val frame = itemView as FrameLayout
        val backdrop = NetImage(ctx)
        val logo = NetImage(ctx)
        private val topShade = View(ctx)
        private val bottomShade = View(ctx)
        private val content = LinearLayout(ctx)
        private val rank = label("", 12f, bold = true)
        private val title = label("", 34f, lines = 2)
        private val desc = label("", 14f, lines = 2)
        private val stats = LinearLayout(ctx)
        private val playBtn = LinearLayout(ctx)
        private val listBtn = LinearLayout(ctx)
        private val playText = label("", 14f, bold = true)
        private val listText = label("", 14f)
        private val playIcon = ImageView(ctx)
        private val listIcon = ImageView(ctx)

        init {
            frame.layoutParams = RecyclerView.LayoutParams(MATCH, MATCH)
            frame.isClickable = true
            frame.setOnClickListener { pos()?.let { act("hero", i = it, what = "open") } }
            backdrop.scaleType = ImageView.ScaleType.CENTER_CROP
            frame.addView(backdrop, FrameLayout.LayoutParams(MATCH, MATCH))
            frame.addView(topShade, FrameLayout.LayoutParams(MATCH, dp(112), Gravity.TOP))
            frame.addView(bottomShade, FrameLayout.LayoutParams(MATCH, MATCH, Gravity.BOTTOM))

            content.orientation = LinearLayout.VERTICAL
            content.gravity = Gravity.BOTTOM
            content.setPaddingRelative(gutter, 0, gutter, dp(40))
            frame.addView(content, FrameLayout.LayoutParams(MATCH, MATCH))

            rank.setPaddingRelative(dp(10), dp(4), dp(10), dp(4))
            content.addView(rank, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10) })

            logo.scaleType = ImageView.ScaleType.FIT_START
            logo.adjustViewBounds = true
            logo.maxHeight = dp(84)
            content.addView(logo, LinearLayout.LayoutParams((width() * 0.7f).toInt(), dp(84)))
            title.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            title.setShadowLayer(dp(12).toFloat(), 0f, dp(3).toFloat(), 0x73000000)
            content.addView(title)
            content.addView(desc, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            stats.orientation = LinearLayout.HORIZONTAL
            stats.gravity = Gravity.CENTER_VERTICAL
            content.addView(stats, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })

            val buttons = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            for ((b, ic, t) in listOf(Triple(playBtn, playIcon, playText), Triple(listBtn, listIcon, listText))) {
                b.orientation = LinearLayout.HORIZONTAL
                b.gravity = Gravity.CENTER
                b.isClickable = true
                b.isFocusable = true
                b.addView(ic, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(8) })
                t.maxLines = 1
                t.ellipsize = TextUtils.TruncateAt.END
                b.addView(t)
            }
            playBtn.setOnClickListener { pos()?.let { act("hero", i = it, what = "play") } }
            listBtn.setOnClickListener { pos()?.let { act("hero", i = it, what = "list") } }
            buttons.addView(playBtn, LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginEnd = dp(10) })
            buttons.addView(listBtn, LinearLayout.LayoutParams(0, dp(44), 1f))
            content.addView(buttons, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18) })
        }

        private fun pos(): Int? = bindingAdapterPosition.takeIf { it != RecyclerView.NO_POSITION }

        fun bind(s: HomeSlide) {
            val m = model ?: return
            frame.setBackgroundColor(colors.canvas)
            frame.contentDescription = s.title
            topShade.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(withAlpha(colors.canvas, 0.8f), Color.TRANSPARENT))
            bottomShade.background = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(colors.canvas, withAlpha(colors.canvas, 0.85f), withAlpha(colors.canvas, 0.35f), Color.TRANSPARENT),
            )
            backdrop.alpha = 1f
            images.load(backdrop, s.images, width(), heroHeight(), crop = true)

            rank.visibility = if (s.rank != null) View.VISIBLE else View.GONE
            rank.text = s.rank ?: ""
            rank.setTextColor(colors.ink)
            rank.background = rounded(withAlpha(colors.canvas, 0.85f), dp(6).toFloat())

            title.text = s.title
            title.setTextColor(colors.ink)
            title.visibility = View.VISIBLE
            logo.scaleType = if (m.rtl) ImageView.ScaleType.FIT_END else ImageView.ScaleType.FIT_START
            logo.visibility = View.GONE
            if (s.logo != null) {
                logo.visibility = View.INVISIBLE
                images.load(logo, listOf(s.logo), (width() * 0.7f).toInt(), dp(84), alpha = true) { ok ->
                    logo.visibility = if (ok) View.VISIBLE else View.GONE
                    title.visibility = if (ok) View.GONE else View.VISIBLE
                }
            }
            desc.text = s.description ?: ""
            desc.visibility = if (s.description.isNullOrBlank()) View.GONE else View.VISIBLE
            desc.setTextColor(colors.muted)

            stats.removeAllViews()
            s.year?.let { stats.addView(stat(m.label("year", "Year"), it)) }
            s.rating?.let { stats.addView(imdbBadge(it, 13f)) }
            s.runtime?.let { stats.addView(stat(m.label("runtime", "Runtime"), it)) }
            stats.visibility = if (stats.childCount > 0) View.VISIBLE else View.GONE

            playBtn.background = focusable(rounded(colors.ink, dp(22).toFloat()))
            playIcon.setImageDrawable(icon(R.drawable.ic_play, colors.canvas))
            playText.text = m.label("play", "Play")
            playText.setTextColor(colors.canvas)
            listBtn.background = focusable(rounded(withAlpha(colors.canvas, 0.55f), dp(22).toFloat(), dp(1), withAlpha(colors.ink, 0.25f)))
            listIcon.setImageDrawable(icon(if (s.inList) R.drawable.ic_check else R.drawable.ic_plus, colors.ink))
            listText.text = if (s.inList) m.label("inList", "In Watchlist") else m.label("add", "Add to Watchlist")
            listText.setTextColor(colors.ink)
        }

        private fun stat(name: String, value: String): View = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(label("$name: ", 13f).apply { setTextColor(colors.subtle) })
            addView(label(value, 13f).apply { setTextColor(colors.ink) })
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(18) }
        }
    }

    // ---- a row: title + sideways cards -----------------------------------------------------------

    private inner class RowHolder : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val header = LinearLayout(ctx)
        private val title = label("", 17f, bold = true, lines = 1)
        private val seeAll = label("", 12.5f, lines = 1)
        /** The small line under the title (a genre page's "TRENDING NOW"). */
        private val sub = label("", 11f, bold = true, lines = 1)
        private val strip = RecyclerView(ctx)
        private val layout = LinearLayoutManager(ctx, RecyclerView.HORIZONTAL, false).apply { initialPrefetchItemCount = 5 }
        private val cards = CardsAdapter()
        private var boundKey: String? = null
        /** The editor's controls for the row (up, down, hide, Top 10 look, hero, rename, delete). */
        private val controls = LinearLayout(ctx)
        /** Critics' Pick: its own card instead of the strip (made the first time one is shown). */
        private var critic: CriticCard? = null
        /** Credits: lines of names and facts instead of the strip. */
        private var creditsBox: LinearLayout? = null
        /** People (search): round photos and names instead of the strip. */
        private var peopleScroll: android.widget.HorizontalScrollView? = null
        /** The row's own choices (seasons) and buttons (Random, Download season…). */
        private val rowChips = android.widget.HorizontalScrollView(ctx)
        private val rowChipsStrip = LinearLayout(ctx)
        private val rowTools = android.widget.HorizontalScrollView(ctx)
        private val rowToolsStrip = LinearLayout(ctx)

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT)
            col.setPadding(0, 0, 0, dp(26))
            header.orientation = LinearLayout.HORIZONTAL
            header.gravity = Gravity.CENTER_VERTICAL
            header.setPaddingRelative(gutter, 0, gutter, 0)
            header.minimumHeight = dp(40)
            val titles = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            titles.addView(title)
            sub.visibility = View.GONE
            titles.addView(sub, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) })
            header.addView(titles, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            header.addView(seeAll)
            header.setOnClickListener { boundKey?.let { k -> act("all", row = k) } }
            col.addView(header, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(6) })
            controls.orientation = LinearLayout.HORIZONTAL
            controls.gravity = Gravity.CENTER_VERTICAL
            controls.visibility = View.GONE
            col.addView(controls, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)).apply {
                marginStart = gutter
                marginEnd = gutter
                bottomMargin = dp(10)
            })
            for ((scroller, strip) in listOf(rowChips to rowChipsStrip, rowTools to rowToolsStrip)) {
                scroller.isHorizontalScrollBarEnabled = false
                scroller.overScrollMode = View.OVER_SCROLL_NEVER
                scroller.clipToPadding = false
                scroller.visibility = View.GONE
                strip.orientation = LinearLayout.HORIZONTAL
                strip.setPaddingRelative(gutter, 0, gutter, 0)
                scroller.addView(strip)
                col.addView(scroller, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })
            }

            strip.layoutManager = layout
            strip.adapter = cards
            strip.setRecycledViewPool(cardPool)
            strip.clipToPadding = false
            strip.setPaddingRelative(gutter, dp(4), gutter - gap, dp(4))
            strip.overScrollMode = View.OVER_SCROLL_NEVER
            strip.isHorizontalScrollBarEnabled = false
            strip.isNestedScrollingEnabled = false
            strip.itemAnimator = null
            strip.addOnScrollListener(object : RecyclerView.OnScrollListener() {
                override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) = maybeAskMore()
            })
            col.addView(strip, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        fun bind(row: HomeRow) {
            val m = model ?: return
            if (boundKey != row.key) {
                saveScroll()
                boundKey = row.key
                cards.submit(row)
                val saved = rowScroll[row.key]
                if (saved != null) layout.onRestoreInstanceState(saved) else layout.scrollToPosition(0)
            } else {
                cards.submit(row)
            }
            title.text = row.title
            title.setTextColor(colors.ink)
            sub.text = row.sub?.let { if (m.rtl) it else it.uppercase() } ?: ""
            sub.visibility = if (row.sub.isNullOrBlank()) View.GONE else View.VISIBLE
            sub.letterSpacing = if (m.rtl) 0f else 0.18f
            sub.setTextColor(colors.subtle)
            val ed = if (m.edit) row.edit else null
            val hidden = ed?.hidden == true
            // The end of the title line: "See all", or the row's small note (Critics' Pick).
            val note = row.note
            if (row.seeAll && ed == null) {
                seeAll.text = m.label("seeAll", "See all") + " ›"
                seeAll.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                seeAll.letterSpacing = 0f
                seeAll.visibility = View.VISIBLE
            } else if (note != null && ed == null) {
                // Small capitals like the page's (Arabic has no case, and its letters stay joined).
                seeAll.text = if (m.rtl) note else note.uppercase()
                seeAll.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f)
                seeAll.letterSpacing = if (m.rtl) 0f else 0.14f
                seeAll.visibility = View.VISIBLE
            } else {
                seeAll.visibility = View.GONE
            }
            seeAll.setTextColor(colors.subtle)
            header.isClickable = row.seeAll && ed == null
            header.isFocusable = row.seeAll && ed == null
            // A hidden row in the editor: its name dimmed and its controls, no cards.
            title.alpha = if (hidden) 0.45f else 1f
            bindRowChips(m, row, if (ed == null) row else null)
            val info = row.critic
            val isCritic = row.kind == HomeRow.Kind.CRITIC
            val isCredits = row.kind == HomeRow.Kind.CREDITS
            val isEpisodes = row.kind == HomeRow.Kind.EPISODES || row.kind == HomeRow.Kind.LIST || row.kind == HomeRow.Kind.WINNERS
            val isPeople = row.kind == HomeRow.Kind.PEOPLE
            strip.visibility = if (hidden || isCritic || isCredits || isEpisodes || isPeople || row.items.isEmpty()) View.GONE else View.VISIBLE
            if (isPeople && !hidden) {
                val sc = peopleScroll ?: android.widget.HorizontalScrollView(ctx).apply {
                    isHorizontalScrollBarEnabled = false
                    overScrollMode = View.OVER_SCROLL_NEVER
                    clipToPadding = false
                    addView(LinearLayout(ctx).apply {
                        orientation = LinearLayout.HORIZONTAL
                        setPaddingRelative(gutter, 0, gutter, 0)
                        tag = "strip"
                    })
                    peopleScroll = this
                    col.addView(this, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
                }
                sc.visibility = View.VISIBLE
                val st = sc.findViewWithTag<LinearLayout>("strip")
                st.removeAllViews()
                row.items.forEachIndexed { i, c -> st.addView(personChip(c.title, c.images.firstOrNull(), c.sub) { act("open", row = row.key, i = i) }) }
            } else {
                peopleScroll?.visibility = View.GONE
            }
            // A row without a title (a title's credits): no heading line at all.
            header.visibility = if (row.title.isBlank() && !row.seeAll && row.note == null && ed == null) View.GONE else View.VISIBLE
            if (isCredits && !hidden) {
                val box = creditsBox ?: LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    setPaddingRelative(gutter, 0, gutter, dp(8))
                    creditsBox = this
                    col.addView(this, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
                }
                box.visibility = View.VISIBLE
                fillCredits(box, m, row)
            } else {
                creditsBox?.visibility = View.GONE
            }
            if (isCritic && info != null && !hidden) {
                val card = critic ?: CriticCard().also {
                    critic = it
                    col.addView(it.view, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT))
                }
                card.view.visibility = View.VISIBLE
                card.bind(m, row.key, info)
            } else {
                critic?.view?.visibility = View.GONE
            }
            bindControls(m, row, ed)
            strip.post { maybeAskMore() }
        }

        private fun bindControls(m: HomeModel, row: HomeRow, ed: RowEdit?) {
            controls.removeAllViews()
            if (ed == null) {
                controls.visibility = View.GONE
                return
            }
            controls.visibility = View.VISIBLE
            controls.background = rounded(withAlpha(colors.surface, 0.9f), dp(12).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            controls.setPaddingRelative(dp(4), 0, dp(4), 0)
            fun button(ic: Int, desc: String, enabled: Boolean = true, on: Boolean = false, what: String, extra: (() -> Unit)? = null) {
                val b = FrameLayout(ctx).apply {
                    isClickable = enabled
                    isFocusable = enabled
                    contentDescription = desc
                    alpha = if (enabled) 1f else 0.3f
                    background = if (on) rounded(withAlpha(colors.accent, 0.22f), dp(10).toFloat()) else null
                    addView(ImageView(ctx).apply { setImageDrawable(icon(ic, if (on) colors.accent else colors.muted)) }, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
                    setOnClickListener { if (extra != null) extra() else act("edit", row = row.key, what = what) }
                }
                controls.addView(b, LinearLayout.LayoutParams(dp(40), dp(40)))
            }
            if (!ed.pinned) {
                button(R.drawable.ic_arrow_up, m.label("up", "Move up"), enabled = ed.up, what = "up")
                button(R.drawable.ic_arrow_down, m.label("down", "Move down"), enabled = ed.down, what = "down")
            }
            button(
                if (ed.hidden) R.drawable.ic_eye_off else R.drawable.ic_eye,
                if (ed.hidden) m.label("show", "Show row") else m.label("hide", "Hide row"),
                on = ed.hidden,
                what = "hide",
            )
            if (!ed.pinned) {
                if (ed.numerals >= 0) button(R.drawable.ic_list_ordered, m.label("numerals", "Top 10 look"), on = ed.numerals == 1, what = "num")
                if (ed.hero >= 0) button(R.drawable.ic_sparkles, m.label("heroSource", "Feature in the hero"), on = ed.hero == 1, what = "hero")
                button(R.drawable.ic_pencil, m.label("rename", "Rename row"), on = ed.renamed, what = "rename") { rename(m, row, ed) }
                if (ed.delete) button(R.drawable.ic_trash_2, m.label("delete", "Delete"), what = "del")
            }
        }

        private fun bindRowChips(m: HomeModel, row: HomeRow, shown: HomeRow?) {
            val chips = shown?.chips
            rowChips.visibility = if (chips == null) View.GONE else View.VISIBLE
            rowChipsStrip.removeAllViews()
            chips?.items?.forEach { c ->
                rowChipsStrip.addView(label(c.label, 13f, bold = c.on, lines = 1).apply {
                    gravity = Gravity.CENTER
                    setPaddingRelative(dp(14), 0, dp(14), 0)
                    isClickable = true
                    isFocusable = true
                    setTextColor(if (c.on) colors.canvas else colors.muted)
                    background = focusable(
                        if (c.on) rounded(colors.ink, dp(18).toFloat())
                        else rounded(withAlpha(colors.surface, 0.9f), dp(18).toFloat(), dp(1), withAlpha(colors.ink, 0.1f)),
                    )
                    setOnClickListener { act("rowchip", row = row.key, what = c.id) }
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply { marginEnd = dp(8) })
            }
            val tools = shown?.tools ?: emptyList()
            rowTools.visibility = if (tools.isEmpty()) View.GONE else View.VISIBLE
            rowToolsStrip.removeAllViews()
            for (tl in tools) {
                val ic = when (tl.id) {
                    "random" -> R.drawable.ic_shuffle
                    "download" -> R.drawable.ic_download
                    "watched" -> R.drawable.ic_check
                    "unwatched" -> R.drawable.ic_rotate_ccw
                    else -> 0
                }
                rowToolsStrip.addView(LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPaddingRelative(dp(12), 0, dp(14), 0)
                    isClickable = true
                    isFocusable = true
                    contentDescription = tl.label
                    background = focusable(rounded(withAlpha(colors.surface, 0.9f), dp(18).toFloat(), dp(1), withAlpha(colors.ink, 0.1f)))
                    if (ic != 0) addView(ImageView(ctx).apply { setImageDrawable(icon(ic, colors.muted)) }, LinearLayout.LayoutParams(dp(15), dp(15)).apply { marginEnd = dp(8) })
                    addView(label(tl.label, 13f, lines = 1).apply { setTextColor(colors.muted) })
                    setOnClickListener { act("tool", row = row.key, what = tl.id) }
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply { marginEnd = dp(8) })
            }
        }

        /** The row's new name; empty (or "Reset") = its own name again. */
        private fun rename(m: HomeModel, row: HomeRow, ed: RowEdit) {
            val input = android.widget.EditText(ctx).apply {
                setText(row.title)
                setSelection(text.length)
                setSingleLine(true)
            }
            val frame = FrameLayout(ctx).apply {
                setPadding(dp(20), dp(8), dp(20), 0)
                addView(input)
            }
            val b = android.app.AlertDialog.Builder(ctx)
                .setTitle(m.label("rename", "Rename row"))
                .setView(frame)
                .setPositiveButton(m.label("save", "Save")) { _, _ ->
                    act("edit", row = row.key, what = "rename", text = input.text.toString().trim())
                }
                .setNegativeButton(m.label("cancel", "Cancel"), null)
            if (ed.renamed) b.setNeutralButton(m.label("resetName", "Reset name")) { _, _ -> act("edit", row = row.key, what = "rename", text = "") }
            try {
                b.show()
            } catch (_: Exception) {
            }
        }

        fun saveScroll() {
            val k = boundKey ?: return
            rowScroll[k] = layout.onSaveInstanceState()
        }

        private fun maybeAskMore() {
            val row = cards.row ?: return
            if (!row.more) return
            val last = layout.findLastVisibleItemPosition()
            if (last == RecyclerView.NO_POSITION || last < row.items.size - 6) return
            if (askedMore[row.key] == row.items.size) return
            askedMore[row.key] = row.items.size
            act("more", row = row.key)
        }
    }

    // ---- cards -----------------------------------------------------------------------------------

    private inner class CardsAdapter : RecyclerView.Adapter<CardHolder>() {
        var row: HomeRow? = null
            private set

        fun submit(r: HomeRow) {
            row = r
            notifyDataSetChanged()
        }

        override fun getItemCount() = (row?.items?.size ?: 0) + (if (row?.lead != null) 1 else 0)
        override fun getItemViewType(position: Int) = if (row?.lead != null && position == 0) C_LEAD else when (row?.kind) {
            HomeRow.Kind.CW -> C_CW
            HomeRow.Kind.RANK -> C_RANK
            HomeRow.Kind.TILE -> C_TILE
            HomeRow.Kind.LOGO -> C_LOGO
            HomeRow.Kind.FEATURE -> C_FEATURE
            HomeRow.Kind.LIVE -> C_LIVE
            HomeRow.Kind.GUIDE -> C_GUIDE
            HomeRow.Kind.CHANNEL -> C_CHANNEL
            HomeRow.Kind.SPORTS -> C_SPORT
            else -> C_POSTER
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = CardHolder(viewType)
        override fun onBindViewHolder(holder: CardHolder, position: Int) {
            val r = row ?: return
            val lead = r.lead
            if (lead == null) holder.bind(r, r.items[position])
            else if (position == 0) holder.bind(r, lead)
            else holder.bind(r, r.items[position - 1])
        }

        override fun onViewRecycled(holder: CardHolder) = images.clear(holder.image)
    }

    private inner class CardHolder(private val kind: Int) : RecyclerView.ViewHolder(LinearLayout(ctx)) {
        private val col = itemView as LinearLayout
        private val box = FrameLayout(ctx)
        val image = NetImage(ctx)
        private val title = label("", 13f, lines = if (kind == C_CW) 1 else 2)
        private val badge = LinearLayout(ctx)
        private val rankNumber = label("", 32f, bold = true, lines = 1)
        /** Top 10: the number and the title, side by side under the poster. */
        private val rankLine = LinearLayout(ctx)
        private val sub = label("", 11f, lines = 1)
        private val track = FrameLayout(ctx)
        private val bar = View(ctx)
        private val play = FrameLayout(ctx)
        private val shade = View(ctx)
        /** The "watched" check (as on the page's posters). */
        private val check = FrameLayout(ctx)
        /** Tiles and the feature card: their name (and a line under it) on the picture. */
        private val overlay = LinearLayout(ctx)
        private val bigTitle = label("", if (kind == C_FEATURE) 24f else if (kind == C_LEAD) 26f else 17f, lines = 2)
        /** A person's part under their name (a title's cast). */
        private val posterSub = label("", 12f, lines = 1)
        /** In a grid line (not a strip): which card this is, and its width. */
        var fixedPos = -1
        var fixedWidth = 0
        private val bigSub = label("", if (kind == C_FEATURE) 13.5f else 11.5f, lines = if (kind == C_FEATURE) 3 else 1)
        private var row: HomeRow? = null
        private val titleBelow get() = kind == C_POSTER || kind == C_RANK || kind == C_CW
        /** The picture's rounded frame. */
        private val frame: FrameLayout = box
        /** The wide card: a label on top, the rating, a Play button. */
        private val kicker = label("", 11.5f, bold = true, lines = 1)
        private val stats = LinearLayout(ctx)
        private val featurePlay = LinearLayout(ctx)
        /** Live TV's card (a channel now, On now, the channel grid), when this is one. */
        private var live: LiveFace? = null

        init {
            col.orientation = LinearLayout.VERTICAL
            col.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = gap }
            col.isClickable = true
            col.isFocusable = true
            col.setOnClickListener { tap("open") }
            col.setOnLongClickListener {
                tap("hold")
                true
            }
            col.setOnFocusChangeListener { _, has -> frame.foreground = if (has) ring() else null }

            frame.clipToOutline = true
            frame.outlineProvider = roundOutline(dp(12).toFloat())
            image.scaleType = ImageView.ScaleType.CENTER_CROP
            col.addView(box)
            frame.addView(image, FrameLayout.LayoutParams(MATCH, MATCH))

            when (kind) {
                C_CW -> {
                    box.addView(shade, FrameLayout.LayoutParams(MATCH, MATCH, Gravity.BOTTOM))
                    sub.setPaddingRelative(dp(8), dp(3), dp(8), dp(3))
                    box.addView(sub, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
                        marginStart = dp(8)
                        bottomMargin = dp(10)
                    })
                    track.addView(bar, FrameLayout.LayoutParams(0, MATCH, Gravity.START))
                    box.addView(track, FrameLayout.LayoutParams(MATCH, dp(3), Gravity.BOTTOM))
                    play.isClickable = true
                    play.isFocusable = true
                    play.setOnClickListener { tap("play") }
                    play.addView(ImageView(ctx).apply { tag = "ic" }, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER))
                    box.addView(play, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.CENTER))
                }
                C_RANK -> Unit
                C_LEAD -> {
                    // A spotlight on a person (a genre page): the photo, a small label over the name.
                    box.addView(shade, FrameLayout.LayoutParams(MATCH, MATCH))
                    overlay.orientation = LinearLayout.VERTICAL
                    overlay.setPaddingRelative(dp(16), 0, dp(16), dp(14))
                    bigSub.typeface = Typeface.DEFAULT_BOLD
                    overlay.addView(bigSub)
                    bigTitle.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                    bigTitle.setShadowLayer(dp(10).toFloat(), 0f, dp(2).toFloat(), 0x66000000)
                    overlay.addView(bigTitle, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
                    box.addView(overlay, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
                }
                C_TILE, C_FEATURE -> {
                    box.addView(shade, FrameLayout.LayoutParams(MATCH, MATCH))
                    overlay.orientation = LinearLayout.VERTICAL
                    val pad = if (kind == C_FEATURE) dp(18) else dp(14)
                    overlay.setPaddingRelative(pad, 0, pad, if (kind == C_FEATURE) dp(16) else dp(12))
                    bigTitle.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
                    bigTitle.setShadowLayer(dp(10).toFloat(), 0f, dp(2).toFloat(), 0x99000000.toInt())
                    overlay.addView(bigTitle)
                    if (kind == C_FEATURE) {
                        stats.orientation = LinearLayout.HORIZONTAL
                        stats.gravity = Gravity.CENTER_VERTICAL
                        overlay.addView(stats, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
                    }
                    overlay.addView(bigSub, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
                    if (kind == C_TILE) {
                        // A collection's "7 FILMS" pill in its corner.
                        kicker.setPaddingRelative(dp(9), dp(3), dp(9), dp(3))
                        kicker.visibility = View.GONE
                        box.addView(kicker, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                            marginStart = dp(12)
                            topMargin = dp(10)
                        })
                    }
                    if (kind == C_FEATURE) {
                        featurePlay.orientation = LinearLayout.HORIZONTAL
                        featurePlay.gravity = Gravity.CENTER
                        featurePlay.isClickable = true
                        featurePlay.isFocusable = true
                        featurePlay.setPaddingRelative(dp(18), 0, dp(20), 0)
                        featurePlay.setOnClickListener { tap("play") }
                        featurePlay.addView(ImageView(ctx).apply { tag = "ic" }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { marginEnd = dp(8) })
                        featurePlay.addView(label("", 14f, bold = true, lines = 1).apply { tag = "tx" })
                        overlay.addView(featurePlay, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42)).apply { topMargin = dp(14) })
                        kicker.setPaddingRelative(dp(10), dp(4), dp(10), dp(4))
                        box.addView(kicker, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                            marginStart = dp(16)
                            topMargin = dp(16)
                        })
                    }
                    box.addView(overlay, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
                }
                C_LOGO -> {
                    image.scaleType = ImageView.ScaleType.FIT_CENTER
                    val pad = dp(22)
                    image.setPadding(pad, pad, pad, pad)
                    bigTitle.gravity = Gravity.CENTER
                    box.addView(bigTitle, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
                }
                else -> {
                    badge.orientation = LinearLayout.HORIZONTAL
                    badge.gravity = Gravity.CENTER_VERTICAL
                    box.addView(badge, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                        marginEnd = dp(6)
                        bottomMargin = dp(6)
                        topMargin = dp(6)
                    })
                    if (kind == C_POSTER) {
                        // A small pill in the top corner (an award's "3×" on a winner's photo).
                        kicker.setPaddingRelative(dp(6), dp(2), dp(6), dp(2))
                        kicker.visibility = View.GONE
                        box.addView(kicker, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
                            marginEnd = dp(8)
                            topMargin = dp(8)
                        })
                    }
                }
            }
            if (kind == C_POSTER || kind == C_RANK) {
                check.visibility = View.GONE
                check.addView(ImageView(ctx).apply { tag = "ic" }, FrameLayout.LayoutParams(dp(13), dp(13), Gravity.CENTER))
                // Bottom-start, like the page's posters.
                frame.addView(check, FrameLayout.LayoutParams(dp(22), dp(22), Gravity.BOTTOM or Gravity.START).apply {
                    marginStart = dp(6)
                    marginEnd = dp(6)
                    topMargin = dp(6)
                    bottomMargin = dp(6)
                })
            }
            if (kind == C_RANK) {
                // Top 10: the whole poster clear; under it the number, big and bold in the
                // accent colour (two digits read as easily as one), the title beside it.
                rankNumber.includeFontPadding = false
                rankNumber.typeface = Typeface.create("sans-serif-condensed", Typeface.BOLD)
                rankNumber.maxLines = 1
                rankNumber.ellipsize = null
                rankLine.orientation = LinearLayout.HORIZONTAL
                rankLine.gravity = Gravity.CENTER_VERTICAL
                rankLine.addView(rankNumber, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                rankLine.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) })
                col.addView(rankLine, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            } else {
                col.addView(title, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
                if (kind == C_POSTER) {
                    posterSub.visibility = View.GONE
                    col.addView(posterSub, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) })
                }
            }
            if (!titleBelow) title.visibility = View.GONE
            if (kind == C_LIVE || kind == C_GUIDE || kind == C_CHANNEL || kind == C_SPORT) {
                // Live TV's cards are drawn by their own face, in the poster's place.
                box.visibility = View.GONE
                title.visibility = View.GONE
                live = LiveFace(kind).also { col.addView(it.root, 0) }
            }
        }


        private fun tap(what: String) {
            val r = row ?: return
            if (kind == C_LEAD) {
                if (what == "open") act("lead", row = r.key)
                return
            }
            val p = if (fixedPos >= 0) fixedPos else bindingAdapterPosition.let {
                if (it == RecyclerView.NO_POSITION) return else it - (if (r.lead != null) 1 else 0)
            }
            if (p < 0) return
            // A title's stills: full screen, here.
            if (r.gallery) {
                if (what == "open") showStills(r.items.mapNotNull { it.images.firstOrNull() }, p)
                return
            }
            act(what, row = r.key, i = p)
        }

        fun bind(r: HomeRow, c: HomeCard) {
            row = r
            live?.let {
                it.bind(c, if (fixedWidth > 0) fixedWidth else if (kind == C_SPORT) dp(260) else liveWidth())
                col.contentDescription = listOfNotNull(c.sub, c.title).joinToString(" · ")
                return
            }
            val w = if (fixedWidth > 0) fixedWidth else when (kind) {
                C_CW -> cwWidth()
                C_RANK -> rankWidth()
                C_TILE -> tileWidth()
                C_LOGO -> logoWidth()
                C_FEATURE -> featureWidth()
                C_LEAD -> dp(280)
                else -> posterWidth()
            }
            val posterW = w
            val h = when (kind) {
                C_CW -> w * 9 / 16
                C_LEAD -> dp(216)
                C_TILE -> if (r.ratio > 0f) (w * r.ratio).toInt() else w * 4 / 5
                C_LOGO -> dp(80)
                C_FEATURE -> max(min(w * 10 / 16, dp(440)), dp(300))
                else -> w * 3 / 2
            }
            val lp = box.layoutParams as LinearLayout.LayoutParams
            if (lp.width != w || lp.height != h) {
                lp.width = w
                lp.height = h
                box.layoutParams = lp
            }
            if (kind == C_RANK) {
                rankNumber.setTextSize(TypedValue.COMPLEX_UNIT_PX, (w * 0.3f).coerceIn(dp(26).toFloat(), dp(48).toFloat()))
            } else {
                val tlp = title.layoutParams as LinearLayout.LayoutParams
                if (tlp.width != posterW) {
                    tlp.width = posterW
                    title.layoutParams = tlp
                }
            }
            col.contentDescription = c.title
            val tint = c.tint
            frame.background = if (kind == C_TILE && c.emblem && tint != null) {
                // An award: its colour lit from the top corner, deep at the bottom (like the page's).
                GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(tint, toward(tint, Color.BLACK, 0.6f))).apply {
                    cornerRadius = dp(12).toFloat()
                }
            } else {
                rounded(
                    when (kind) {
                        C_LOGO -> withAlpha(colors.surface, 0.9f)
                        else -> if (kind == C_POSTER && c.kicker != null) plate(c.title) else tint ?: plate(c.title)
                    },
                    dp(12).toFloat(),
                )
            }
            frame.foreground = if (col.isFocused) ring() else null
            // Award tiles: the emblem whole in the top part; other tiles: the picture fills them.
            if (kind == C_TILE) {
                val ilp = image.layoutParams as FrameLayout.LayoutParams
                val wantH = if (c.emblem) (h * 0.66f).toInt() else MATCH
                if (ilp.height != wantH) {
                    ilp.height = wantH
                    ilp.gravity = Gravity.TOP
                    image.layoutParams = ilp
                }
                image.scaleType = if (c.emblem) ImageView.ScaleType.FIT_CENTER else ImageView.ScaleType.CENTER_CROP
                val pad = if (c.emblem) dp(14) else 0
                image.setPadding(pad, pad, pad, 0)
            }
            if (kind == C_LEAD) image.scaleType = ImageView.ScaleType.CENTER_CROP
            images.load(image, c.images, posterW, h, alpha = kind == C_LOGO || c.emblem) { ok ->
                // A logo that didn't come: its name instead.
                if (kind == C_LOGO) bigTitle.visibility = if (ok) View.GONE else View.VISIBLE
                // A face: framed from its upper part (the page's "center 22%").
                if (kind == C_LEAD && ok) image.post { cropAt(image, 0.22f) }
            }
            title.text = c.title
            title.setTextColor(colors.ink)
            if (kind == C_POSTER) {
                posterSub.text = c.sub ?: ""
                posterSub.visibility = if (c.sub.isNullOrBlank()) View.GONE else View.VISIBLE
                posterSub.setTextColor(colors.muted)
                // A person's name fits on one line; their part goes under it.
                title.minLines = if (c.sub.isNullOrBlank()) 2 else 1
            }
            if (kind == C_POSTER || kind == C_RANK) {
                if (kind == C_RANK || c.sub.isNullOrBlank()) title.minLines = 2
                check.visibility = if (c.watched) View.VISIBLE else View.GONE
                if (c.watched) {
                    check.background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                    }.also { it.setColor(colors.accent); it.setStroke(dp(2), withAlpha(colors.canvas, 0.7f)) }
                    check.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(R.drawable.ic_check, colors.canvas))
                    check.contentDescription = model?.label("watched", "Watched")
                }
            }

            when (kind) {
                C_CW -> {
                    shade.background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(withAlpha(colors.canvas, 0.8f), Color.TRANSPARENT))
                    sub.text = c.sub ?: ""
                    sub.visibility = if (c.sub.isNullOrBlank()) View.GONE else View.VISIBLE
                    sub.setTextColor(colors.ink)
                    sub.background = rounded(withAlpha(colors.canvas, 0.95f), dp(6).toFloat())
                    track.setBackgroundColor(withAlpha(colors.canvas, 0.4f))
                    bar.setBackgroundColor(colors.accent)
                    val blp = bar.layoutParams
                    blp.width = (w * c.progress).toInt()
                    bar.layoutParams = blp
                    play.background = focusable(rounded(withAlpha(colors.canvas, 0.85f), dp(24).toFloat(), dp(1), withAlpha(colors.ink, 0.15f)))
                    play.contentDescription = model?.label("play", "Play")
                    play.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(R.drawable.ic_play, colors.ink))
                }
                C_RANK -> {
                    rankNumber.text = if (c.rank > 0) c.rank.toString() else ""
                    rankNumber.setTextColor(colors.accent)
                }
                C_LEAD -> {
                    shade.background = GradientDrawable(
                        GradientDrawable.Orientation.BOTTOM_TOP,
                        intArrayOf(colors.canvas, withAlpha(colors.canvas, 0.65f), Color.TRANSPARENT, Color.TRANSPARENT),
                    )
                    frame.background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(colors.surface, colors.canvas)).apply {
                        cornerRadius = dp(12).toFloat()
                    }
                    val rtl = model?.rtl == true
                    bigSub.text = c.sub?.let { if (rtl) it else it.uppercase() } ?: ""
                    bigSub.visibility = if (c.sub.isNullOrBlank()) View.GONE else View.VISIBLE
                    bigSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    bigSub.letterSpacing = if (rtl) 0f else 0.22f
                    bigSub.setTextColor(colors.accent)
                    bigTitle.text = c.title
                    bigTitle.setTextColor(colors.ink)
                }
                C_TILE, C_FEATURE -> {
                    // Tiles: the picture washed with the tile's colour all over (more at the bottom,
                    // under the name); an emblem stays clear. The feature card: like the hero, the
                    // picture clear at the top and dark under its text.
                    val base = c.tint ?: colors.canvas
                    shade.background = GradientDrawable(
                        GradientDrawable.Orientation.BOTTOM_TOP,
                        when {
                            kind == C_FEATURE -> intArrayOf(colors.canvas, withAlpha(colors.canvas, 0.85f), withAlpha(colors.canvas, 0.25f), Color.TRANSPARENT)
                            c.emblem -> intArrayOf(withAlpha(toward(base, Color.BLACK, 0.6f), 0.7f), Color.TRANSPARENT)
                            else -> intArrayOf(withAlpha(base, 0.95f), withAlpha(base, 0.6f), withAlpha(base, 0.45f))
                        },
                    )
                    if (kind == C_TILE) {
                        val rtl = model?.rtl == true
                        kicker.text = c.kicker?.let { if (rtl) it else it.uppercase() } ?: ""
                        kicker.visibility = if (c.kicker.isNullOrBlank()) View.GONE else View.VISIBLE
                        kicker.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
                        kicker.letterSpacing = if (rtl) 0f else 0.16f
                        kicker.setTextColor(withAlpha(Color.WHITE, 0.85f))
                        kicker.background = rounded(0x66000000, dp(12).toFloat())
                    }
                    bigTitle.text = c.title
                    bigTitle.setTextColor(Color.WHITE)
                    bigSub.text = c.sub ?: ""
                    bigSub.visibility = if (c.sub.isNullOrBlank()) View.GONE else View.VISIBLE
                    bigSub.setTextColor(withAlpha(Color.WHITE, 0.75f))
                    if (kind == C_FEATURE) {
                        kicker.text = c.kicker ?: ""
                        kicker.visibility = if (c.kicker.isNullOrBlank()) View.GONE else View.VISIBLE
                        kicker.setTextColor(colors.ink)
                        kicker.background = rounded(withAlpha(colors.canvas, 0.85f), dp(6).toFloat())
                        stats.removeAllViews()
                        c.rating?.let { stats.addView(imdbBadge(it, 13f, trailing = 0)) }
                        stats.visibility = if (stats.childCount > 0) View.VISIBLE else View.GONE
                        featurePlay.visibility = if (c.play) View.VISIBLE else View.GONE
                        featurePlay.background = focusable(rounded(colors.ink, dp(21).toFloat()))
                        featurePlay.findViewWithTag<ImageView>("ic")?.setImageDrawable(icon(R.drawable.ic_play, colors.canvas))
                        featurePlay.findViewWithTag<TextView>("tx")?.apply {
                            text = model?.label("play", "Play")
                            setTextColor(colors.canvas)
                        }
                    }
                }
                C_LOGO -> {
                    bigTitle.text = c.title
                    bigTitle.setTextColor(colors.ink)
                }
                else -> {
                    if (kind == C_POSTER) {
                        kicker.text = c.kicker ?: ""
                        kicker.visibility = if (c.kicker.isNullOrBlank()) View.GONE else View.VISIBLE
                        kicker.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
                        kicker.setTextColor(colors.canvas)
                        kicker.background = rounded(c.tint ?: colors.accent, dp(10).toFloat())
                    }
                    badge.removeAllViews()
                    if (c.rating != null) {
                        badge.visibility = View.VISIBLE
                        // In the poster's corner (bottom, or top per Settings), nothing pushing it in.
                        badge.addView(imdbBadge(c.rating, 9.5f, trailing = 0))
                        val blp = badge.layoutParams as FrameLayout.LayoutParams
                        val g = (if (model?.badgesTop == true) Gravity.TOP else Gravity.BOTTOM) or Gravity.END
                        if (blp.gravity != g) {
                            blp.gravity = g
                            badge.layoutParams = blp
                        }
                    } else {
                        badge.visibility = View.GONE
                    }
                }
            }
        }
    }

    // ---- Critics' Pick ---------------------------------------------------------------------------

    /** Which review each Critics' Pick shows (its arrows page through them). */
    private val criticReview = HashMap<String, Int>()

    /**
     * Critics' Pick, like the page's card: the title's picture with its logo (or name), year and
     * IMDb rating; under it the review (paged, "Read full"), four stills (full screen on a tap),
     * the cast, the director, the genres and Play.
     */
    private inner class CriticCard {
        val view = LinearLayout(ctx)
        private var rowKey = ""
        private var info: CriticInfo? = null
        private val poster = FrameLayout(ctx)
        private val backdrop = NetImage(ctx)
        private val shade = View(ctx)
        private val logo = NetImage(ctx)
        private val bigTitle = label("", 28f, lines = 2)
        private val posterStats = LinearLayout(ctx)
        private val panel = LinearLayout(ctx)
        private val quoteIcon = ImageView(ctx)
        private val quote = label("", 15f, lines = 5)
        private val byline = LinearLayout(ctx)
        private val author = label("", 11f, lines = 1)
        private val source = ImageView(ctx)
        private val pager = LinearLayout(ctx)
        private val prev = ImageView(ctx)
        private val count = label("", 10.5f, lines = 1)
        private val next = ImageView(ctx)
        private val readFull = label("", 11.5f, bold = true, lines = 1)
        private val stills = LinearLayout(ctx)
        private val stillViews = List(4) { NetImage(ctx) }
        private val castLabel = label("", 10.5f, lines = 1)
        private val castScroll = android.widget.HorizontalScrollView(ctx)
        private val castStrip = LinearLayout(ctx)
        private val directorRow = LinearLayout(ctx)
        private val directorLabel = label("", 10.5f, lines = 1)
        private val directorName = label("", 13f, lines = 1)
        private val genres = LinearLayout(ctx)
        private val play = LinearLayout(ctx)
        private val playIcon = ImageView(ctx)
        private val playText = label("", 13.5f, bold = true, lines = 1)

        init {
            view.orientation = LinearLayout.VERTICAL
            view.setPaddingRelative(gutter, dp(4), gutter, 0)

            // The title's picture.
            poster.isClickable = true
            poster.isFocusable = true
            poster.setOnClickListener { act("open", row = rowKey, i = 0) }
            poster.setOnFocusChangeListener { _, has -> poster.foreground = if (has) ring() else null }
            poster.clipToOutline = true
            poster.outlineProvider = roundOutline(dp(16).toFloat())
            backdrop.scaleType = ImageView.ScaleType.CENTER_CROP
            poster.addView(backdrop, FrameLayout.LayoutParams(MATCH, MATCH))
            poster.addView(shade, FrameLayout.LayoutParams(MATCH, MATCH))
            val text = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPaddingRelative(dp(20), 0, dp(20), dp(20))
            }
            logo.scaleType = ImageView.ScaleType.FIT_START
            text.addView(logo, LinearLayout.LayoutParams(MATCH, dp(72)))
            bigTitle.typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            bigTitle.setShadowLayer(dp(12).toFloat(), 0f, dp(2).toFloat(), 0x8C000000.toInt())
            text.addView(bigTitle)
            posterStats.orientation = LinearLayout.HORIZONTAL
            posterStats.gravity = Gravity.CENTER_VERTICAL
            text.addView(posterStats, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
            poster.addView(text, FrameLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            view.addView(poster, LinearLayout.LayoutParams(MATCH, dp(300)))

            // The panel under it.
            panel.orientation = LinearLayout.VERTICAL
            panel.setPadding(dp(20), dp(20), dp(20), dp(20))
            view.addView(panel, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
            panel.addView(quoteIcon, LinearLayout.LayoutParams(dp(22), dp(22)))
            quote.typeface = Typeface.create(Typeface.SERIF, Typeface.ITALIC)
            quote.setLineSpacing(0f, 1.25f)
            quote.setOnClickListener { showFull() }
            panel.addView(quote, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })

            byline.orientation = LinearLayout.HORIZONTAL
            byline.gravity = Gravity.CENTER_VERTICAL
            byline.addView(author, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            source.setPadding(dp(4), dp(4), dp(4), dp(4))
            source.isClickable = true
            source.isFocusable = true
            source.setOnClickListener { currentReview()?.url?.let { act("link", row = rowKey, text = it) } }
            byline.addView(source, LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginStart = dp(2) })
            pager.orientation = LinearLayout.HORIZONTAL
            pager.gravity = Gravity.CENTER_VERTICAL
            for (b in listOf(prev, next)) {
                b.setPadding(dp(5), dp(5), dp(5), dp(5))
                b.isClickable = true
                b.isFocusable = true
            }
            prev.setOnClickListener { step(-1) }
            next.setOnClickListener { step(1) }
            pager.addView(prev, LinearLayout.LayoutParams(dp(26), dp(26)))
            pager.addView(count)
            pager.addView(next, LinearLayout.LayoutParams(dp(26), dp(26)))
            byline.addView(pager, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
            readFull.isClickable = true
            readFull.isFocusable = true
            readFull.setPaddingRelative(dp(8), dp(6), 0, dp(6))
            readFull.setOnClickListener { showFull() }
            byline.addView(readFull)
            panel.addView(byline, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })

            stills.orientation = LinearLayout.VERTICAL
            for (r in 0 until 2) {
                val line = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                for (c in 0 until 2) {
                    val i = r * 2 + c
                    val v = stillViews[i]
                    v.scaleType = ImageView.ScaleType.CENTER_CROP
                    v.clipToOutline = true
                    v.outlineProvider = roundOutline(dp(10).toFloat())
                    v.isClickable = true
                    v.isFocusable = true
                    v.setOnClickListener { info?.let { showStills(it.stills.ifEmpty { it.images.take(1) }, i) } }
                    line.addView(v, LinearLayout.LayoutParams(0, dp(80), 1f).apply { if (c == 0) marginEnd = dp(6) })
                }
                stills.addView(line, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (r == 0) bottomMargin = dp(6) })
            }
            panel.addView(stills, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

            panel.addView(castLabel, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18) })
            castScroll.isHorizontalScrollBarEnabled = false
            castScroll.overScrollMode = View.OVER_SCROLL_NEVER
            castStrip.orientation = LinearLayout.HORIZONTAL
            castScroll.addView(castStrip)
            panel.addView(castScroll, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })

            directorRow.orientation = LinearLayout.HORIZONTAL
            directorRow.gravity = Gravity.CENTER_VERTICAL
            directorRow.addView(directorLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            directorName.isClickable = true
            directorName.isFocusable = true
            directorRow.addView(directorName)
            panel.addView(directorRow, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18) })
            genres.orientation = LinearLayout.HORIZONTAL
            panel.addView(genres, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })

            play.orientation = LinearLayout.HORIZONTAL
            play.gravity = Gravity.CENTER
            play.isClickable = true
            play.isFocusable = true
            play.setPaddingRelative(dp(20), 0, dp(24), 0)
            play.setOnClickListener { act("play", row = rowKey, i = 0) }
            play.addView(playIcon, LinearLayout.LayoutParams(dp(15), dp(15)).apply { marginEnd = dp(8) })
            play.addView(playText)
            panel.addView(play, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42)).apply {
                topMargin = dp(20)
                gravity = Gravity.END
            })
        }

        private fun reviews() = info?.reviews ?: emptyList()
        private fun index(): Int = (criticReview[rowKey] ?: 0).coerceIn(0, max(0, reviews().size - 1))
        private fun currentReview(): CriticReview? = reviews().getOrNull(index())

        private fun step(d: Int) {
            val n = reviews().size
            if (n < 2) return
            criticReview[rowKey] = (index() + d + n) % n
            model?.let { paintReview(it) }
        }

        fun bind(m: HomeModel, key: String, c: CriticInfo) {
            rowKey = key
            info = c
            val cardW = width() - 2 * gutter
            val posterH = max(dp(300), min(cardW * 9 / 16, dp(460)))
            val plp = poster.layoutParams
            if (plp.height != posterH) {
                plp.height = posterH
                poster.layoutParams = plp
            }
            poster.background = rounded(colors.surface, dp(16).toFloat())
            poster.contentDescription = c.title
            shade.background = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(withAlpha(colors.canvas, 0.92f), withAlpha(colors.canvas, 0.3f), Color.TRANSPARENT),
            )
            images.load(backdrop, c.images, cardW, posterH)
            bigTitle.text = c.title
            bigTitle.setTextColor(colors.ink)
            bigTitle.visibility = View.VISIBLE
            logo.scaleType = if (m.rtl) ImageView.ScaleType.FIT_END else ImageView.ScaleType.FIT_START
            logo.visibility = View.GONE
            if (c.logo != null) {
                logo.visibility = View.INVISIBLE
                images.load(logo, listOf(c.logo), (cardW * 0.6f).toInt(), dp(72), alpha = true) { ok ->
                    logo.visibility = if (ok) View.VISIBLE else View.GONE
                    bigTitle.visibility = if (ok) View.GONE else View.VISIBLE
                }
            }
            posterStats.removeAllViews()
            c.year?.let {
                posterStats.addView(label(it, 13f, lines = 1).apply { setTextColor(withAlpha(colors.ink, 0.8f)) },
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(10) })
            }
            c.rating?.let { posterStats.addView(imdbBadge(it, 12.5f, trailing = 0)) }
            posterStats.visibility = if (posterStats.childCount > 0) View.VISIBLE else View.GONE

            panel.background = rounded(withAlpha(colors.surface, 0.55f), dp(16).toFloat(), dp(1), withAlpha(colors.ink, 0.08f))
            quoteIcon.setImageDrawable(icon(R.drawable.ic_quote, colors.accent))
            paintReview(m)

            // Four stills, two by two (the title's picture where there are fewer).
            val inner = cardW - dp(40)
            val stillH = (inner - dp(6)) / 2 * 9 / 16
            val shots = c.stills
            stills.visibility = if (shots.isEmpty()) View.GONE else View.VISIBLE
            stillViews.forEachIndexed { i, v ->
                val lp = v.layoutParams
                if (lp.height != stillH) {
                    lp.height = stillH
                    v.layoutParams = lp
                }
                v.background = rounded(colors.surface, dp(10).toFloat())
                val src = shots.getOrNull(i) ?: c.images.firstOrNull()
                if (shots.isNotEmpty() && src != null) images.load(v, listOf(src), inner / 2, stillH) else images.clear(v)
            }

            castLabel.text = caps(m, c.castTitle ?: m.label("cast", "Cast"))
            castLabel.setTextColor(colors.subtle)
            castLabel.letterSpacing = if (m.rtl) 0f else 0.2f
            castStrip.removeAllViews()
            for (p in c.cast) castStrip.addView(castChip(p))
            castLabel.visibility = if (c.cast.isEmpty()) View.GONE else View.VISIBLE
            castScroll.visibility = castLabel.visibility

            val d = c.director
            directorRow.visibility = if (d == null) View.GONE else View.VISIBLE
            directorLabel.text = caps(m, m.label("director", "Director"))
            directorLabel.setTextColor(colors.subtle)
            directorLabel.letterSpacing = if (m.rtl) 0f else 0.2f
            directorName.text = d?.name ?: ""
            directorName.setTextColor(colors.ink)
            directorName.setOnClickListener { d?.let { act("person", row = rowKey, what = it.id.toString()) } }

            genres.removeAllViews()
            for (g in c.genres.take(3)) {
                genres.addView(label(g, 11.5f, lines = 1).apply {
                    setTextColor(colors.muted)
                    setPaddingRelative(dp(10), dp(3), dp(10), dp(3))
                    background = rounded(Color.TRANSPARENT, dp(12).toFloat(), dp(1), withAlpha(colors.ink, 0.12f))
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(6) })
            }
            genres.visibility = if (genres.childCount > 0) View.VISIBLE else View.GONE

            play.background = focusable(rounded(colors.ink, dp(21).toFloat()))
            playIcon.setImageDrawable(icon(R.drawable.ic_play, colors.canvas))
            playText.text = m.label("play", "Play")
            playText.setTextColor(colors.canvas)
        }

        private fun paintReview(m: HomeModel) {
            val c = info ?: return
            val r = currentReview()
            quote.text = r?.text ?: c.quote ?: ""
            quote.setTextColor(withAlpha(colors.ink, 0.9f))
            quote.visibility = if (quote.text.isNullOrBlank()) View.GONE else View.VISIBLE
            author.text = if (r == null) "" else caps(m, listOfNotNull(r.author, r.score).joinToString(" · "))
            author.setTextColor(colors.muted)
            author.letterSpacing = if (m.rtl) 0f else 0.12f
            source.visibility = if (r?.url != null) View.VISIBLE else View.GONE
            source.setImageDrawable(icon(R.drawable.ic_external_link, colors.subtle))
            source.contentDescription = m.label("source", "Open review source")
            val n = reviews().size
            pager.visibility = if (n > 1) View.VISIBLE else View.GONE
            prev.setImageDrawable(icon(R.drawable.ic_chevron_left, colors.subtle))
            next.setImageDrawable(icon(R.drawable.ic_chevron_right, colors.subtle))
            // The arrows point the way they move in a right-to-left page too.
            prev.scaleX = if (m.rtl) -1f else 1f
            next.scaleX = if (m.rtl) -1f else 1f
            count.text = "${index() + 1}/$n"
            count.setTextColor(colors.subtle)
            val full = r?.full ?: c.overview
            readFull.visibility = if (full.isNullOrBlank()) View.GONE else View.VISIBLE
            readFull.text = caps(m, m.label("readFull", "Read full"))
            readFull.setTextColor(colors.accent)
            readFull.letterSpacing = if (m.rtl) 0f else 0.12f
        }

        /** The whole review (or the overview), in a box that scrolls. */
        private fun showFull() {
            val c = info ?: return
            val m = model ?: return
            val r = currentReview()
            val text = r?.full ?: c.overview ?: return
            val body = TextView(ctx).apply {
                this.text = text
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                setLineSpacing(0f, 1.3f)
                setPadding(dp(22), dp(10), dp(22), dp(10))
                setTextIsSelectable(true)
            }
            val scroll = android.widget.ScrollView(ctx).apply { addView(body) }
            val b = android.app.AlertDialog.Builder(ctx)
                .setTitle(r?.author ?: c.title)
                .setView(scroll)
                .setPositiveButton(m.label("close", "Close"), null)
            r?.url?.let { url -> b.setNeutralButton(m.label("source", "Open review source")) { _, _ -> act("link", row = rowKey, text = url) } }
            try {
                b.show()
            } catch (_: Exception) {
            }
        }

        private fun castChip(p: CriticPerson): View = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isClickable = true
            isFocusable = true
            contentDescription = p.name
            setOnClickListener { act("person", row = rowKey, what = p.id.toString()) }
            val face = FrameLayout(ctx).apply {
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: Outline) = outline.setOval(0, 0, view.width, view.height)
                }
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                }.also { it.setColor(withAlpha(colors.surface, 0.9f)); it.setStroke(dp(1), withAlpha(colors.ink, 0.12f)) }
            }
            val initial = label(p.name.take(1), 13f, lines = 1).apply {
                gravity = Gravity.CENTER
                setTextColor(colors.subtle)
            }
            face.addView(initial, FrameLayout.LayoutParams(MATCH, MATCH))
            if (p.image != null) {
                val img = NetImage(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
                face.addView(img, FrameLayout.LayoutParams(MATCH, MATCH))
                images.load(img, listOf(p.image), dp(52), dp(52)) { ok -> initial.visibility = if (ok) View.GONE else View.VISIBLE }
            }
            addView(face, LinearLayout.LayoutParams(dp(52), dp(52)))
            addView(label(p.name, 11f, lines = 1).apply {
                gravity = Gravity.CENTER
                setTextColor(colors.ink)
            }, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            layoutParams = LinearLayout.LayoutParams(dp(68), ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(6) }
        }
    }

    /** A title's credits as the page writes them: a small label, then the names (a tap opens one). */
    private fun fillCredits(box: LinearLayout, m: HomeModel, row: HomeRow) {
        box.removeAllViews()
        row.credits.forEachIndexed { gi, g ->
            val group = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
            group.addView(label(caps(m, g.label), 12f, lines = 1).apply {
                setTextColor(colors.subtle)
                letterSpacing = if (m.rtl) 0f else 0.18f
            })
            val names = TextView(ctx).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                setTextColor(colors.ink)
                setLineSpacing(0f, 1.2f)
                textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            }
            if (g.people.isNotEmpty()) {
                val sb = android.text.SpannableStringBuilder()
                g.people.forEachIndexed { i, p ->
                    val start = sb.length
                    sb.append(p.name)
                    if (p.id > 0) {
                        val id = p.id
                        val ink = colors.ink
                        sb.setSpan(object : android.text.style.ClickableSpan() {
                            override fun onClick(widget: View) = act("person", row = row.key, what = id.toString())
                            override fun updateDrawState(ds: android.text.TextPaint) {
                                ds.color = ink
                                ds.isUnderlineText = false
                            }
                        }, start, sb.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    }
                    if (i < g.people.size - 1) sb.append(", ")
                }
                names.text = sb
                names.movementMethod = android.text.method.LinkMovementMethod.getInstance()
                names.highlightColor = Color.TRANSPARENT
            } else {
                names.text = g.value ?: ""
            }
            group.addView(names, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
            box.addView(group, LinearLayout.LayoutParams(MATCH, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (gi > 0) topMargin = dp(20) })
        }
    }

    /** Small capitals (Arabic has no case). */
    private fun caps(m: HomeModel, s: String): String = if (m.rtl) s else s.uppercase()

    /** Pictures full screen, swiped through; a tap (or Back) closes them. */
    private fun showStills(urls: List<String>, start: Int) {
        if (urls.isEmpty()) return
        val d = android.app.Dialog(ctx, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        val rv = RecyclerView(ctx)
        val lm = LinearLayoutManager(ctx, RecyclerView.HORIZONTAL, false)
        rv.layoutManager = lm
        rv.setBackgroundColor(Color.BLACK)
        rv.overScrollMode = View.OVER_SCROLL_NEVER
        rv.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = urls.size
            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
                object : RecyclerView.ViewHolder(NetImage(ctx).apply {
                    layoutParams = RecyclerView.LayoutParams(MATCH, MATCH)
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    setOnClickListener { d.dismiss() }
                }) {}
            override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                images.load(holder.itemView as NetImage, listOf(urls[position]), width(), height())
            }
            override fun onViewRecycled(holder: RecyclerView.ViewHolder) = images.clear(holder.itemView as NetImage)
        }
        PagerSnapHelper().attachToRecyclerView(rv)
        lm.scrollToPosition(start.coerceIn(0, urls.size - 1))
        d.setContentView(rv)
        try {
            d.show()
        } catch (_: Exception) {
        }
    }

    // ---- small pieces ----------------------------------------------------------------------------

    /** IMDb's yellow tag and the score, on a dark pill. */
    /** The rating badge: "8.1" is IMDb's (yellow IMDb label); "★7.5" is another site's score (a star). */
    private fun imdbBadge(value: String, sizeSp: Float, trailing: Int = dp(14)): View = LinearLayout(ctx).apply {
        val star = value.startsWith("★")
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPaddingRelative(dp(5), dp(3), dp(7), dp(3))
        background = rounded(withAlpha(colors.canvas, 0.92f), dp(7).toFloat())
        addView(TextView(ctx).apply {
            typeface = Typeface.DEFAULT_BOLD
            includeFontPadding = false
            if (star) {
                text = "★"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
                setTextColor(0xFFFBBF24.toInt())
            } else {
                text = "IMDb"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp * 0.72f)
                setTextColor(Color.BLACK)
                setPadding(dp(3), dp(1), dp(3), dp(1))
                background = rounded(0xFFF5C518.toInt(), dp(2).toFloat())
            }
        })
        addView(TextView(ctx).apply {
            text = value.removePrefix("★").trim()
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(colors.ink)
            includeFontPadding = false
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(5) })
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = trailing }
    }

    private fun label(text: String, sizeSp: Float, bold: Boolean = false, lines: Int = 0) = TextView(ctx).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        textAlignment = View.TEXT_ALIGNMENT_VIEW_START
        if (lines > 0) {
            maxLines = lines
            ellipsize = TextUtils.TruncateAt.END
        }
    }

    private fun icon(res: Int, tint: Int): Drawable? = ctx.getDrawable(res)?.mutate()?.also { it.setTint(tint) }

    private fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = 0) = GradientDrawable().apply {
        cornerRadius = radius
        setColor(color)
        if (stroke > 0) setStroke(stroke, strokeColor)
    }

    /** A button's background that shows when the D-pad / a controller is on it. */
    private fun focusable(base: Drawable): Drawable {
        val ring = rounded(Color.TRANSPARENT, dp(22).toFloat(), dp(2), colors.accent)
        return android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), android.graphics.drawable.LayerDrawable(arrayOf(base, ring)))
            addState(intArrayOf(), base)
        }
    }

    private fun ring(): Drawable = rounded(Color.TRANSPARENT, dp(12).toFloat(), dp(3), colors.accent)

    private fun roundOutline(radius: Float) = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
            outline.setRoundRect(0, 0, view.width, view.height, radius)
        }
    }

    /** The coloured plate behind a poster that is still loading (or has none). */
    private fun plate(seed: String): Int {
        val hue = ((seed.hashCode() % 360) + 360) % 360
        return Color.HSVToColor(floatArrayOf(hue.toFloat(), 0.45f, 0.28f))
    }

    /** Fills [v] with its picture like CENTER_CROP, but lined up at [fy] of its height (0 = top). */
    private fun cropAt(v: ImageView, fy: Float) {
        val d = v.drawable ?: return
        val vw = v.width.toFloat()
        val vh = v.height.toFloat()
        val dw = d.intrinsicWidth.toFloat()
        val dh = d.intrinsicHeight.toFloat()
        if (vw <= 0f || vh <= 0f || dw <= 0f || dh <= 0f) return
        val scale = max(vw / dw, vh / dh)
        val m = android.graphics.Matrix()
        m.setScale(scale, scale)
        m.postTranslate((vw - dw * scale) / 2f, (vh - dh * scale) * fy)
        v.scaleType = ImageView.ScaleType.MATRIX
        v.imageMatrix = m
    }

    private fun withAlpha(color: Int, a: Float): Int = (color and 0x00FFFFFF) or ((a.coerceIn(0f, 1f) * 255).toInt() shl 24)

    /** [color] moved [f] of the way to [other]. */
    private fun toward(color: Int, other: Int, f: Float): Int {
        fun ch(shift: Int): Int {
            val x = (color shr shift) and 0xFF
            val y = (other shr shift) and 0xFF
            return ((x + (y - x) * f).toInt().coerceIn(0, 255)) shl shift
        }
        return (0xFF shl 24) or ch(16) or ch(8) or ch(0)
    }

    private fun dp(v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    private fun stableId(key: String): Long = key.hashCode().toLong() and 0xFFFFFFFFL

    companion object {
        private const val TAG = "HarborHome"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val T_HERO = 1
        private const val T_TOOLS = 2
        private const val T_CW_EMPTY = 3
        private const val T_ROW = 4
        private const val T_END = 5
        private const val T_GAP = 6
        private const val T_HEADER = 7
        private const val T_CHIPS = 8
        private const val T_EMPTY = 9
        private const val T_SEARCH = 10
        private const val T_NOTE = 11
        private const val T_MESSAGE = 12
        private const val T_GRID_TITLE = 13
        private const val T_GRID_POSTER = 14
        private const val T_GRID_TILE = 15
        private const val T_DETAIL = 16
        private const val T_EPISODE = 17
        private const val T_LISTITEM = 18
        private const val T_QUEUE = 19
        private const val T_WINNER = 20
        private const val T_CALBAR = 21
        private const val T_CALENDAR = 22
        private const val T_DL_TOP = 23
        private const val T_DL_GROUP = 24
        private const val T_ACTION = 25
        private const val T_GRID_CHANNEL = 26
        private const val T_LIVEHERO = 27
        private const val T_SOURCE = 28
        private const val T_MATCH = 29
        private const val T_VERSUS = 30
        private const val T_PITCH = 31
        private const val T_GUIDE_RULER = 32
        private const val T_GUIDE_ROW = 33
        private const val T_PK_PICK = 34
        private const val T_PK_TIERS = 35
        private const val T_PK_STREAM = 36
        private const val T_PK_DRAWER = 37
        private const val T_PK_DIAG = 38
        private const val T_PK_PANEL = 39
        private const val T_PK_LOADER = 40
        private const val T_AD_CARD = 41
        private const val T_AD_TILES = 42
        private const val T_AD_HERO = 43
        private const val T_AD_COMM = 44
        private const val T_AD_HEAD = 45
        private const val T_AD_CATS = 46
        private const val T_AD_INST = 47
        private const val T_AD_DETAIL = 48
        private const val T_AD_INFO = 49
        private const val T_AD_DOC = 50
        // Card kinds: shared by every row's strip (one RecycledViewPool), so they must differ from
        // the outer list's.
        private const val C_POSTER = 101
        private const val C_RANK = 102
        private const val C_CW = 103
        private const val C_TILE = 104
        private const val C_LOGO = 105
        private const val C_FEATURE = 106
        private const val C_LEAD = 107
        private const val C_LIVE = 108
        private const val C_GUIDE = 109
        private const val C_CHANNEL = 110
        private const val C_SPORT = 111
        /** The hero turns to its next slide after this long. */
        private const val HERO_TURN_MS = 15_000L
    }
}

/** A one-line text that shows [short] in place of [full] when [full] does not fit its width. */
private class FitText(ctx: Context, private val full: String, private val short: String) : TextView(ctx) {
    init {
        text = full
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
            val room = MeasureSpec.getSize(widthMeasureSpec) - compoundPaddingLeft - compoundPaddingRight
            val want = if (paint.measureText(full) <= room) full else short
            if (text.toString() != want) text = want
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}
