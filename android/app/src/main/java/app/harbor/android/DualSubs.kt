package app.harbor.android

/**
 * Two subtitles at once: the decisions about where each one goes.
 *
 * The first subtitle is whatever it is with one subtitle (a track inside the file, or one from
 * the addons or saved on the device). The second always comes from the addons or the saved ones
 * and has a view of its own. They are laid out in one of two ways:
 *  - side by side: both at the bottom, each in its own half of the width, so the picture is
 *    covered as little as possible;
 *  - stacked: the second right above the first, both at full width.
 *
 * Nothing in here touches an Android view, so it is unit-tested on the JVM (DualSubsTest).
 * NativePlayer.layoutSubtitles asks [plan] and [pad] and applies the answers.
 */
object DualSubs {
    /** The two layouts, as they are saved on the device. */
    const val SIDE_BY_SIDE = "side"
    const val STACKED = "stacked"

    /** Which subtitle the open sync panel is lining up with the sound. */
    enum class Syncing { NONE, FIRST, SECOND }

    /** The part of the picture's width a subtitle's text is laid out in. */
    enum class Slot {
        FULL,
        LEFT,
        RIGHT,
        /** The part the sync panel leaves free. */
        BESIDE_PANEL,
        /** Not drawn at all. */
        HIDDEN,
    }

    /** What the second subtitle's distance from the bottom follows. */
    enum class Bottom {
        /** Its own position setting. */
        OWN,
        /** The first one's position: stacked, while the first isn't drawn. */
        FIRST_LINE,
        /** Right above what the first is showing at the moment. */
        ABOVE_FIRST,
    }

    data class State(
        /** A first subtitle is chosen (it may be between two lines right now). */
        val firstOn: Boolean,
        val secondOn: Boolean,
        /** The saved layout is "stacked". */
        val stacked: Boolean,
        /** "Swap sides" is on. */
        val swapped: Boolean,
        val firstLang: String?,
        val secondLang: String?,
        /** The player's view is taller than it is wide. */
        val portrait: Boolean,
        /** The first subtitle is made of pictures (PGS, VobSub), which a narrower view would squash. */
        val firstIsPicture: Boolean,
        val inPip: Boolean,
        val syncing: Syncing,
    )

    data class Plan(val first: Slot, val second: Slot, val secondBottom: Bottom)

    /** Left and right padding of a subtitle's view, in pixels: its text is laid out between them. */
    data class Pad(val left: Int, val right: Int)

    /** Languages written right to left, by their codes (two- and three-letter) and English names. */
    private val RTL_LANGS = setOf(
        "ar", "ara", "arabic",
        "he", "iw", "heb", "hebrew",
        "fa", "fas", "per", "persian", "farsi",
        "ur", "urd", "urdu",
        "ps", "pus", "pashto",
        "ckb", // Kurdish in Arabic letters (Sorani); plain "ku" is mostly written in Latin ones
        "yi", "ji", "yid", "yiddish",
        "dv", "div",
        "ug", "uig",
        "sd", "snd",
    )
    private val RTL_SCRIPTS = setOf("arab", "hebr", "thaa", "syrc", "nkoo")
    private val LTR_SCRIPTS = setOf("latn", "cyrl")

    /** Whether [lang] ("ar", "he-IL", "ku-Arab", "per", …) is written right to left. A script in
     *  the code decides when there is one: "ku-Arab" is, "ug-Cyrl" is not. */
    fun isRtl(lang: String?): Boolean {
        val parts = (lang ?: "").trim().lowercase().split('-', '_')
        val rest = parts.drop(1)
        if (rest.any { it in RTL_SCRIPTS }) return true
        if (rest.any { it in LTR_SCRIPTS }) return false
        return parts[0] in RTL_LANGS
    }

    /**
     * Side by side: whether the first subtitle takes the right half. When exactly one of the two
     * is in a right-to-left language, that one goes on the right, where its lines start. Otherwise
     * the first is on the left. [swapped] turns either answer around.
     */
    fun firstOnRight(firstLang: String?, secondLang: String?, swapped: Boolean): Boolean {
        val first = isRtl(firstLang)
        val second = isRtl(secondLang)
        val right = first && !second
        return right != swapped
    }

    /**
     * Whether the two are stacked right now, whatever the saved layout says: a view that is
     * taller than wide leaves half-width columns too narrow to read, and a subtitle made of
     * pictures would be squashed into its half.
     */
    fun stackedNow(s: State): Boolean = s.stacked || s.portrait || s.firstIsPicture

    fun plan(s: State): Plan {
        // One subtitle: the whole width, or the part the sync panel leaves free. As it always was.
        if (!s.secondOn) {
            val first = if (s.syncing == Syncing.FIRST && !s.inPip) Slot.BESIDE_PANEL else Slot.FULL
            return Plan(first, Slot.HIDDEN, Bottom.OWN)
        }
        val alone = if (stackedNow(s)) Bottom.FIRST_LINE else Bottom.OWN
        return when {
            // The small window has room for one: the first, at full width.
            s.inPip -> Plan(Slot.FULL, Slot.HIDDEN, Bottom.OWN)
            // The sync panel: only the subtitle being synced, beside the panel.
            s.syncing == Syncing.FIRST -> Plan(Slot.BESIDE_PANEL, Slot.HIDDEN, Bottom.OWN)
            s.syncing == Syncing.SECOND -> Plan(Slot.HIDDEN, Slot.BESIDE_PANEL, alone)
            // No first subtitle (yet): the second is never left by itself in half the width.
            !s.firstOn -> Plan(Slot.FULL, Slot.FULL, alone)
            stackedNow(s) -> Plan(Slot.FULL, Slot.FULL, Bottom.ABOVE_FIRST)
            firstOnRight(s.firstLang, s.secondLang, s.swapped) -> Plan(Slot.RIGHT, Slot.LEFT, Bottom.OWN)
            else -> Plan(Slot.LEFT, Slot.RIGHT, Bottom.OWN)
        }
    }

    /**
     * The padding that puts a view's text in [slot]. [width] is the view's own width. [edge] is
     * kept clear at the screen's side of a half (the camera cutout, the rounded corners) and
     * [gutter] on each side of the middle. [panelWidth] is the sync panel's, on the left when
     * [panelOnLeft].
     */
    fun pad(slot: Slot, width: Int, edge: Int, gutter: Int, panelWidth: Int, panelOnLeft: Boolean): Pad {
        val half = width / 2
        return when (slot) {
            Slot.LEFT -> Pad(edge, width - half + gutter).orNone(width)
            Slot.RIGHT -> Pad(half + gutter, edge).orNone(width)
            Slot.BESIDE_PANEL -> if (panelOnLeft) Pad(panelWidth, 0) else Pad(0, panelWidth)
            Slot.FULL, Slot.HIDDEN -> Pad(0, 0)
        }
    }

    /** A view too narrow to be divided keeps its whole width rather than lose its text. */
    private fun Pad.orNone(width: Int) = if (width > 0 && left + right >= width) Pad(0, 0) else this

    /**
     * Stacked: how far above the bottom of its box (pixels) the second subtitle's text ends.
     *
     * The first one's text reaches from [firstLow] up to [firstHigh] above that same bottom (the
     * two are equal while it shows nothing: the second then takes its place). The second sits
     * [gap] above it. When the first is set so high that the second ([secondText] tall) would
     * leave the picture at the top, the second goes under it instead.
     */
    fun stackedLift(firstLow: Int, firstHigh: Int, secondText: Int, boxHeight: Int, gap: Int): Int {
        if (firstHigh <= firstLow) return firstLow.coerceAtLeast(0)
        val above = firstHigh + gap
        if (above + secondText <= boxHeight) return above.coerceAtLeast(0)
        val below = firstLow - gap - secondText
        // No room either way (very large text): above, where it covers nothing of the first.
        return if (below >= 0) below else above.coerceAtLeast(0)
    }
}
