package app.harbor.android

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.util.Locale

/**
 * The player's "Sync subtitle" panel: lining an addon subtitle up with the sound by ear.
 *
 * It lists the subtitle's lines and keeps the one being spoken in view. The viewer finds the line
 * they hear, taps it and then "Align to now": that is an anchor (TextSync). A second anchor far
 * from the first also corrects drift, and "Fix one section" moves only a marked run of lines
 * (a subtitle made for another cut of the film, right until a scene it doesn't have). Every
 * change is drawn on the video at once and kept for this subtitle by the player, so there is
 * nothing to save when the panel closes.
 *
 * The list is a RecyclerView: a film has a thousand lines or more, and only the few on screen
 * get views.
 */
class SyncPanel(
    private val ctx: Context,
    private val panel: SidePanel,
    private val subs: ExternalSubs,
    private val host: Host,
) {
    interface Host {
        /** Where playback is, or null while there is no player. */
        fun positionMs(): Long?
        /** Playing, or about to once it has buffered. */
        fun isPlaying(): Boolean
        fun togglePlay()
        fun seekTo(ms: Long)
        /** Draws the subtitle with [state] and keeps it for this subtitle. */
        fun setSync(state: TextSync.State)
        /** "Done": closes the panel. */
        fun close()
        /** The search field's keyboard was sent away. */
        fun keyboardClosed()
    }

    private val handler = Handler(Looper.getMainLooper())
    /** How many lines the subtitle has. Taken once: the list must not change length under the
     *  RecyclerView (the player closes this panel when another subtitle takes over). */
    private val count = subs.count
    private val list = RecyclerView(ctx)
    private val layout = LinearLayoutManager(ctx, RecyclerView.VERTICAL, false)
    private val rows = Rows()
    private val playIcon = ImageView(ctx)
    private val offsetLabel = ctx.label("", 13.5f, bold = true, lines = 1)
    private val anchorsLabel = ctx.label("", 13f, HarborColors.MUTED, lines = 1)
    private val nowChip = panel.chip(Strings.syncNow, false) { followNow() }
    private val sectionChip = panel.chip(Strings.syncSection, false) { toggleSection() }
    private val note = ctx.label("", 12.5f, HarborColors.MUTED, lines = 3)
    private val searchRow = LinearLayout(ctx)
    private val searchField = EditText(ctx)

    private var alive = false
    /** The cue being spoken (by its place in the file), -1 before the first one. */
    private var current = -1
    /** The cue whose two buttons are showing, -1 for none. */
    private var expanded = -1
    /** The list keeps the line being spoken in view, until the viewer scrolls or opens a line. */
    private var follow = true
    private var playing = false
    /** The cues the anchors were set on (to mark them 1 and 2 in the list), -1 when not found. */
    private var anchorCues = IntArray(0)
    /** The search, folded for matching, and the cues it leaves in the list (null: all of them). */
    private var query = ""
    private var matches: IntArray? = null
    /** Every line folded for matching, worked out at the first search. */
    private var folded: Array<String>? = null
    /** "Fix one section": off, or what the next tap on a line means. */
    private var section = Section.OFF
    /** The first and last line of the section being marked, -1 until tapped. */
    private var sectionFrom = -1
    private var sectionTo = -1

    private enum class Section {
        OFF,
        /** The next line tapped is the section's first. */
        FIRST,
        /** The next line tapped is its last. */
        LAST,
        /** Both are marked: "Align to now" on a line inside moves the section alone. */
        ALIGN,
    }

    private val state: TextSync.State get() = subs.sync ?: TextSync.State()

    private val ticker = object : Runnable {
        override fun run() {
            if (!alive) return
            update()
            handler.postDelayed(this, TICK_MS)
        }
    }

    fun build() {
        alive = true
        val top = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        buildSearch()
        top.addView(searchRow, LinearLayout.LayoutParams(MATCH, ctx.dp(40)).apply { bottomMargin = ctx.dp(6) })

        // The search sits in the header, next to the close button.
        panel.header.addView(ctx.iconButton(R.drawable.ic_search, Strings.syncSearch) { toggleSearch() }, panel.header.childCount - 1)

        // Play or pause, the nudge with its value, and "Fix one section". Scrolls sideways on a
        // panel too narrow for all of it.
        val nudgeLine = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        nudgeLine.addView(roundButton(playIcon, Strings.pause) { host.togglePlay(); update() }, chipSize(ctx.dp(36)))
        nudgeLine.addView(panel.chip("−0.1", false) { nudge(-0.1) }, chipSize())
        offsetLabel.gravity = Gravity.CENTER
        offsetLabel.fontFeatureSettings = "tnum"
        offsetLabel.minWidth = ctx.dp(58)
        nudgeLine.addView(offsetLabel, chipSize())
        nudgeLine.addView(panel.chip("+0.1", false) { nudge(0.1) }, chipSize())
        nudgeLine.addView(sectionChip, LinearLayout.LayoutParams(WRAP, ctx.dp(36)))
        val nudgeScroll = HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(nudgeLine)
        }
        top.addView(nudgeScroll, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = ctx.dp(6) })

        // How many anchors are set, and Reset, Now, Done. The count gives way first on a narrow
        // panel, so the buttons are never cut.
        val anchorLine = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        anchorLine.addView(anchorsLabel, LinearLayout.LayoutParams(0, WRAP, 1f).apply { marginStart = ctx.dp(4); marginEnd = ctx.dp(8) })
        nowChip.visibility = View.INVISIBLE
        anchorLine.addView(nowChip, chipSize())
        anchorLine.addView(panel.chip(Strings.syncReset, false) { reset() }, chipSize())
        anchorLine.addView(panel.chip(Strings.done, true) { host.close() }, LinearLayout.LayoutParams(WRAP, ctx.dp(36)))
        top.addView(anchorLine, LinearLayout.LayoutParams(MATCH, WRAP))

        note.setPadding(ctx.dp(4), ctx.dp(6), ctx.dp(4), ctx.dp(4))
        top.addView(note)
        panel.custom(top)

        list.layoutManager = layout
        list.adapter = rows
        // A line's highlight comes and goes several times a minute: no fade for each.
        list.itemAnimator = null
        list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
                if (newState != RecyclerView.SCROLL_STATE_DRAGGING) return
                // The viewer is looking for a line: the list stops moving by itself.
                setFollow(false)
                if (searchField.hasFocus()) hideKeyboard()
            }
        })
        panel.fill(list)

        playing = host.isPlaying()
        showPlaying()
        findAnchors()
        showState()
        current = currentCue()
        scrollToCurrent()
        handler.postDelayed(ticker, TICK_MS)
    }

    /** The panel is gone: nothing more is looked up or drawn. */
    fun close() {
        if (!alive) return
        alive = false
        handler.removeCallbacks(ticker)
        // The search field is already off the screen by now, and may have left its keyboard up.
        if (searchRow.visibility == View.VISIBLE) hideKeyboard()
    }

    // ---- the line being spoken ----

    private fun currentCue(): Int = host.positionMs()?.let { subs.cueAt(it) } ?: -1

    /** A few times a second while the panel is open: the highlight follows the playback. */
    private fun update() {
        val cue = currentCue()
        if (cue != current) {
            val old = current
            current = cue
            rowChanged(old)
            rowChanged(cue)
            if (follow) scrollToCurrent()
        }
        val now = host.isPlaying()
        if (now != playing) {
            playing = now
            showPlaying()
        }
    }

    /** Puts the line being spoken a third of the way down, with the lines to come under it. */
    private fun scrollToCurrent() {
        // A search shows only some lines: the viewer is reading those.
        if (matches != null) return
        val row = rowOf(current)
        if (row < 0) {
            if (current < 0) layout.scrollToPositionWithOffset(0, 0)
            return
        }
        layout.scrollToPositionWithOffset(row, if (list.height > 0) list.height / 3 else ctx.dp(48))
    }

    private fun setFollow(on: Boolean) {
        follow = on
        nowChip.visibility = if (on) View.INVISIBLE else View.VISIBLE
    }

    /** "Now": back to the line being spoken, in the whole list. */
    private fun followNow() {
        closeSearch()
        val old = expanded
        expanded = -1
        rowChanged(old)
        setFollow(true)
        scrollToCurrent()
    }

    // ---- what the buttons do ----

    private fun toggle(cue: Int) {
        if (cue < 0) return
        if (searchField.hasFocus()) hideKeyboard()
        // Marking a section: the tap names its first line, then its last.
        if (section == Section.FIRST) {
            sectionFrom = cue
            section = Section.LAST
            sectionChanged()
            return
        }
        if (section == Section.LAST) {
            val first = minOf(sectionFrom, cue)
            sectionTo = maxOf(sectionFrom, cue)
            sectionFrom = first
            section = Section.ALIGN
            sectionChanged()
            return
        }
        val old = expanded
        expanded = if (old == cue) -1 else cue
        rowChanged(old)
        rowChanged(cue)
        if (expanded < 0) return
        // The list stays put while a line is open: its buttons must not slide from under the finger.
        setFollow(false)
        // A line at the bottom edge: bring its buttons into view.
        list.post { if (alive && expanded == cue) rowOf(cue).takeIf { it >= 0 }?.let { list.smoothScrollToPosition(it) } }
    }

    /** "Align to now": this line is being spoken at this moment. */
    private fun align(cue: Int) {
        val at = host.positionMs() ?: return
        val t = subs.fileStartSec(cue) ?: return
        if (section == Section.ALIGN && cue in sectionFrom..sectionTo) {
            // Inside the marked section: only its lines move, by what puts this one on now.
            host.setSync(TextSync.withSegment(state, sectionFrom, sectionTo, t, at / 1000.0))
            endSection()
        } else {
            host.setSync(TextSync.withPoint(state, TextSync.Point(t, at / 1000.0)))
        }
        expanded = -1
        setFollow(true)
        stateChanged()
    }

    /** "Jump here": play from this line, where the sync puts it now. The line stays open, to be
     *  aligned once it is heard. */
    private fun jump(cue: Int) {
        if (cue < 0 || cue >= count) return
        host.seekTo(subs.startMs(cue))
    }

    private fun nudge(bySec: Double) {
        host.setSync(TextSync.nudged(state, bySec))
        stateChanged()
    }

    private fun reset() {
        host.setSync(TextSync.State())
        expanded = -1
        endSection()
        stateChanged()
    }

    /** The "Fix one section" chip: starts marking a run of lines, or gives the marking up. */
    private fun toggleSection() {
        if (section != Section.OFF) {
            endSection()
            sectionChanged()
            return
        }
        section = Section.FIRST
        lit(sectionChip, true)
        // The viewer is about to pick lines: none open, and the list holds still.
        expanded = -1
        setFollow(false)
        sectionChanged()
    }

    private fun endSection() {
        section = Section.OFF
        sectionFrom = -1
        sectionTo = -1
        lit(sectionChip, false)
    }

    /** A step of the marking: the note says what comes next, the marked lines are tinted. */
    private fun sectionChanged() {
        showState()
        rows.notifyDataSetChanged()
    }

    private fun marked(cue: Int): Boolean = when (section) {
        Section.OFF, Section.FIRST -> false
        Section.LAST -> cue == sectionFrom
        Section.ALIGN -> cue in sectionFrom..sectionTo
    }

    /** The sync changed: every line's time may have moved, and so may the line being spoken. */
    private fun stateChanged() {
        findAnchors()
        showState()
        current = currentCue()
        rows.notifyDataSetChanged()
        if (follow) scrollToCurrent()
    }

    private fun findAnchors() {
        val points = state.points
        anchorCues = IntArray(points.size) { -1 }
        if (points.isEmpty()) return
        for (i in 0 until count) {
            val t = subs.fileStartSec(i) ?: continue
            points.forEachIndexed { k, p -> if (anchorCues[k] < 0 && Math.abs(p.t - t) < 0.0005) anchorCues[k] = i }
        }
    }

    private fun showState() {
        val s = state
        offsetLabel.text = Strings.syncOffset((if (s.nudge > 0) "+" else "") + String.format(Locale.US, "%.1f", s.nudge))
        anchorsLabel.text = Strings.syncAnchors(s.points.size) + if (s.segments.isEmpty()) "" else " · " + Strings.syncSections(s.segments.size)
        // What to do next; in the accent colour when two anchors could not both be used.
        var warn = false
        note.text = when {
            matches?.isEmpty() == true -> Strings.syncNoMatches
            section == Section.FIRST -> Strings.sectionPickFirst
            section == Section.LAST -> Strings.sectionPickLast
            section == Section.ALIGN -> Strings.sectionAlignInside
            else -> when (TextSync.fit(s)) {
                TextSync.Fit.NONE -> Strings.syncHintFirst
                TextSync.Fit.SHIFT -> Strings.syncHintSecond
                TextSync.Fit.DRIFT -> Strings.syncHintBoth
                TextSync.Fit.TOO_CLOSE -> Strings.syncTooClose.also { warn = true }
                TextSync.Fit.TOO_STEEP -> Strings.syncTooSteep.also { warn = true }
            }
        }
        note.setTextColor(if (warn) HarborColors.ACCENT else HarborColors.MUTED)
    }

    private fun showPlaying() {
        playIcon.setImageDrawable(tinted(if (playing) R.drawable.ic_pause else R.drawable.ic_play))
        (playIcon.parent as? View)?.contentDescription = if (playing) Strings.pause else Strings.play
    }

    // ---- search ----

    private fun buildSearch() {
        searchRow.apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(HarborColors.CHIP, ctx.dp(12).toFloat())
            setPaddingRelative(ctx.dp(12), 0, ctx.dp(2), 0)
            visibility = View.GONE
        }
        searchRow.addView(ImageView(ctx).apply { setImageDrawable(tinted(R.drawable.ic_search, HarborColors.MUTED)) }, LinearLayout.LayoutParams(ctx.dp(16), ctx.dp(16)).apply { marginEnd = ctx.dp(8) })
        searchField.apply {
            background = null
            setSingleLine(true)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(HarborColors.TEXT)
            setHintTextColor(HarborColors.SUBTLE)
            hint = Strings.syncSearch
            setPadding(0, 0, 0, 0)
            // The keyboard stays at the bottom: in landscape it would otherwise take the whole
            // screen for a text box of its own, over the video. (The field sits at the top of the
            // panel, clear of it.)
            imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setOnEditorActionListener { _, _, _ ->
                hideKeyboard()
                true
            }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(t: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(t: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(e: Editable?) = search(e?.toString() ?: "")
            })
        }
        searchRow.addView(searchField, LinearLayout.LayoutParams(0, MATCH, 1f))
        val clear = ImageView(ctx).apply { setImageDrawable(tinted(R.drawable.ic_x, HarborColors.MUTED)) }
        searchRow.addView(roundButton(clear, Strings.close, Color.TRANSPARENT) { closeSearch() }, LinearLayout.LayoutParams(ctx.dp(36), ctx.dp(36)))
    }

    private fun toggleSearch() {
        if (searchRow.visibility == View.VISIBLE) {
            closeSearch()
            return
        }
        searchRow.visibility = View.VISIBLE
        searchField.requestFocus()
        // Once the field is laid out and has the focus.
        searchField.postDelayed({
            if (alive && searchRow.visibility == View.VISIBLE && searchField.hasFocus()) keyboard()?.showSoftInput(searchField, InputMethodManager.SHOW_IMPLICIT)
        }, 120)
    }

    private fun closeSearch() {
        if (searchRow.visibility != View.VISIBLE) return
        if (searchField.hasFocus()) hideKeyboard()
        searchField.setText("")
        searchRow.visibility = View.GONE
    }

    /** Leaves in the list the lines that have [text] in them (all of them for an empty one). */
    private fun search(text: String) {
        val q = CueSearch.fold(text)
        if (q == query) return
        query = q
        matches = if (q.isEmpty()) null else {
            val lines = folded ?: Array(count) { CueSearch.fold(subs.text(it)) }.also { folded = it }
            lines.indices.filter { CueSearch.matches(lines[it], q) }.toIntArray()
        }
        rows.notifyDataSetChanged()
        showState()
        // Back in the whole list: at the line that is open, or the one being spoken.
        val back = if (expanded >= 0) expanded else current
        if (matches != null) layout.scrollToPositionWithOffset(0, 0)
        else if (back >= 0) layout.scrollToPositionWithOffset(back, if (list.height > 0) list.height / 3 else ctx.dp(48))
    }

    private fun keyboard() = ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

    private fun hideKeyboard() {
        searchField.clearFocus()
        // The field's own window, or the activity's once the panel has been taken down.
        val token = searchField.windowToken ?: (ctx as? Activity)?.window?.decorView?.windowToken
        if (token != null) keyboard()?.hideSoftInputFromWindow(token, 0)
        host.keyboardClosed()
    }

    // ---- the list ----

    /** The cue in a row of the list, and the row of a cue (-1 when the search has left it out). */
    private fun cueOf(row: Int): Int = matches?.getOrNull(row) ?: if (matches == null) row else -1

    private fun rowOf(cue: Int): Int {
        if (cue < 0) return -1
        val m = matches ?: return if (cue < count) cue else -1
        return m.binarySearch(cue).takeIf { it >= 0 } ?: -1
    }

    private fun rowChanged(cue: Int) {
        val row = rowOf(cue)
        if (row >= 0) rows.notifyItemChanged(row)
    }

    private inner class Row(
        val box: LinearLayout,
        val fill: GradientDrawable,
        val time: TextView,
        val text: TextView,
        val badge: TextView,
        val actions: View,
    ) : RecyclerView.ViewHolder(box) {
        var cue = -1
    }

    private inner class Rows : RecyclerView.Adapter<Row>() {
        override fun getItemCount(): Int = matches?.size ?: count

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Row {
            val fill = rounded(Color.TRANSPARENT, ctx.dp(12).toFloat())
            val time = ctx.label("", 11.5f, HarborColors.MUTED, lines = 1).apply {
                fontFeatureSettings = "tnum"
                minWidth = ctx.dp(50)
                setPadding(0, ctx.dp(2), 0, 0)
            }
            val text = ctx.label("", 14f, lines = 3).apply {
                // As on the video: each line goes by its own first strong letter, so an Arabic
                // line starts at the right and a Latin one at the left, whatever the app's
                // language. (Lines that need a direction mark got it when the file was parsed.)
                textDirection = View.TEXT_DIRECTION_FIRST_STRONG
                textAlignment = View.TEXT_ALIGNMENT_GRAVITY
                gravity = Gravity.START
            }
            val badge = ctx.label("", 11f, Color.BLACK, bold = true).apply {
                gravity = Gravity.CENTER
                background = rounded(HarborColors.ACCENT, 999f)
                visibility = View.GONE
            }
            val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            head.addView(time, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginEnd = ctx.dp(10) })
            head.addView(text, LinearLayout.LayoutParams(0, WRAP, 1f))
            head.addView(badge, LinearLayout.LayoutParams(ctx.dp(20), ctx.dp(20)).apply { marginStart = ctx.dp(8) })

            val buttons = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            val actions = HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(buttons)
                setPadding(0, ctx.dp(8), 0, ctx.dp(2))
                visibility = View.GONE
            }
            val box = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                background = fill
                setPadding(ctx.dp(10), ctx.dp(8), ctx.dp(10), ctx.dp(8))
                isClickable = true
                layoutParams = RecyclerView.LayoutParams(MATCH, WRAP).apply { bottomMargin = ctx.dp(2) }
            }
            box.addView(head)
            box.addView(actions)
            val row = Row(box, fill, time, text, badge, actions)
            box.setOnClickListener { toggle(row.cue) }
            buttons.addView(panel.chip(Strings.alignToNow, true) { align(row.cue) }, chipSize())
            buttons.addView(panel.chip(Strings.jumpHere, false) { jump(row.cue) }, chipSize())
            return row
        }

        override fun onBindViewHolder(row: Row, position: Int) {
            val cue = cueOf(position)
            row.cue = cue
            val spoken = cue == current
            val open = cue == expanded
            val marked = marked(cue)
            row.time.text = clock(subs.startMs(cue))
            row.time.setTextColor(if (marked) HarborColors.ACCENT else HarborColors.MUTED)
            row.text.text = subs.text(cue)
            row.text.setTextColor(if (spoken) HarborColors.ACCENT else HarborColors.TEXT)
            row.text.typeface = if (spoken) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            row.fill.setColor(
                when {
                    spoken -> HarborColors.ROW_ACTIVE
                    open || marked -> HarborColors.CHIP
                    else -> Color.TRANSPARENT
                },
            )
            val anchor = if (cue >= 0) anchorCues.indexOf(cue) else -1
            row.badge.visibility = if (anchor >= 0) View.VISIBLE else View.GONE
            if (anchor >= 0) row.badge.text = (anchor + 1).toString()
            row.actions.visibility = if (open) View.VISIBLE else View.GONE
        }
    }

    // ---- small pieces ----

    private fun tinted(res: Int, color: Int = Color.WHITE) = ContextCompat.getDrawable(ctx, res)?.mutate()?.also { it.setTint(color) }

    /** A round icon button the height of a chip. */
    private fun roundButton(icon: ImageView, desc: String, fill: Int = HarborColors.CHIP, onClick: () -> Unit) = FrameLayout(ctx).apply {
        contentDescription = desc
        background = rounded(fill, 999f)
        isClickable = true
        setOnClickListener { onClick() }
        addView(icon, FrameLayout.LayoutParams(ctx.dp(18), ctx.dp(18), Gravity.CENTER))
    }

    /** A chip's look, on or off (as SidePanel.chip draws it). */
    private fun lit(chip: TextView, on: Boolean) {
        chip.setTextColor(if (on) Color.BLACK else HarborColors.TEXT)
        chip.typeface = if (on) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        chip.background = rounded(if (on) HarborColors.ACCENT else HarborColors.CHIP, 999f)
    }

    private fun chipSize(width: Int = WRAP) = LinearLayout.LayoutParams(width, ctx.dp(36)).apply { marginEnd = ctx.dp(8) }

    private fun clock(ms: Long): String {
        val s = ms / 1000
        val h = s / 3600
        val m = s / 60 % 60
        val sec = s % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, sec) else String.format(Locale.US, "%d:%02d", m, sec)
    }

    private companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        /** How often the line being spoken is looked up while the panel is open. */
        const val TICK_MS = 200L
    }
}
