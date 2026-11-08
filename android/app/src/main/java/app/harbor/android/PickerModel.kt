package app.harbor.android

import org.json.JSONArray
import org.json.JSONObject

/*
 * The play picker's other layout (the big card, the qualities, every source) and its full-screen
 * steps (connecting, peer-to-peer, debrid down, nothing played, saving offline, no sources yet), as
 * the page (src/views/play-picker.tsx) describes them: a row of kind "pk" carries one [PkBlock];
 * the page's "stage" is a [PkStage]. Plain JVM (org.json only).
 */

/** A format badge (4K, HDR, Atmos…): its picture (a data: URL) at [w] dp wide, else its [label]. */
class PkBadge(val src: String?, val label: String, val w: Float)

/** An audio language: its flag (an emoji), or its name when it has none ("Multi" is a pill). */
class PkFlag(val emoji: String?, val label: String, val multi: Boolean = false)

/** A coloured line with an icon. [tone]: accent, muted, green, subtle, danger.
 *  [icon]: zap (filled), zap-line, check, download, external. */
class PkStatus(val text: String, val tone: String, val icon: String?, val upper: Boolean = true)

/** A small pill. [style]: accent (same file, edition), plain (close match), remux, group, danger. */
class PkTag(val text: String, val style: String)

/** A button. [style]: ink, accent, outline, green, off, link, white, glass, secondary, amber.
 *  [icon]: play, download, check, external, radio, x, arrow. [copy]: text put on the clipboard by the tap. */
class PkButton(val id: String, val label: String, val style: String, val icon: String?, val busy: Boolean = false, val copy: String? = null)

/** A choice that toggles (Cached only, a language, an addon). [icon]: zap, lang. */
class PkPill(val id: String, val label: String, val on: Boolean, val icon: String? = null, val count: String? = null)

/** An addon's round logo, or its initial. */
class PkLogo(val images: List<String>, val initial: String)

sealed interface PkBlock

/**
 * The source the page picked, as its big card: the picture (16:9 still or backdrop with the
 * title's logo, else the poster) with the format badges, the audio flags, the title it was matched
 * to, the file's name, its facts (size · seeders…), whether it is cached, REMUX / group / edition,
 * the Play button (or Cache / Stream / Not cached), where it plays from and a copy-link button.
 */
class PkPick(
    val images: List<String>,
    val wide: Boolean,
    val logo: String?,
    val badges: List<PkBadge>,
    val flags: List<PkFlag>,
    val moreFlags: String?,
    val noAudio: String?,
    val confirm: String?,
    val match: PkTag?,
    val title: String,
    val file: String?,
    val summary: List<String>,
    val status: PkStatus?,
    val chips: List<PkTag>,
    val button: PkButton,
    val via: PkVia?,
    val copy: String?,
) : PkBlock

/** Where the source plays from: [top] ("plays via TorBox", null = one line "VIA" + the addon),
 *  then [by] ("found by") and the addon's logo and name. */
class PkVia(val top: String?, val tone: String, val zap: Boolean, val by: String, val addon: String, val logo: List<String>)

/** "Switch quality" (with its note on where labels come from), the Cached / language pills and the
 *  best source of each quality as a button (its badge, the quality, Instant / Cached · size). */
class PkTiers(val title: String, val infoTitle: String, val infoBody: String, val pills: List<PkPill>, val tiers: List<PkTier>) : PkBlock

class PkTier(val badge: PkBadge, val label: String, val status: String, val zap: String?, val on: Boolean, val dim: Boolean)

/** Every source, one line each, in one box (the drawer's list). */
class PkStreams(val items: List<PkStream>) : PkBlock

class PkStream(
    val badges: List<PkBadge>,
    val title: String,
    val edition: String?,
    val file: String?,
    val logo: PkLogo,
    val addon: String,
    val summary: String?,
    val flags: List<PkFlag>,
    val moreFlags: Int,
    val match: PkTag?,
    val status: PkStatus?,
    /** play, external, busy. */
    val end: String,
    val copy: String?,
)

/** The drawer's button ("All sources 42", the addons' logos, "3 addons") and, open, the addons
 *  to show one of. */
class PkDrawer(val label: String, val count: String, val logos: List<PkLogo>, val addons: String?, val open: Boolean, val pills: List<PkPill>) : PkBlock

/** "12 cached · 40 found across 3 sources" and, open, what each source found. */
class PkDiag(val lead: String, val text: String, val open: Boolean, val more: List<String>) : PkBlock

/**
 * A message in a box: nothing found, filtered out, not out yet, no debrid, only one or two left.
 * [look]: dashed (a plain message and a button), card (a heading in the display face), art (over
 * the title's grey picture), warn (amber: a few sources left).
 */
class PkPanel(
    val look: String,
    val kicker: String?,
    val title: String?,
    val titleSize: Float,
    val body: String?,
    val pills: List<String>,
    val mono: String?,
    val button: PkButton?,
    val note: String?,
    val art: List<String>,
) : PkBlock

/** Searching: the title's logo (or name) breathing, then the caption. */
class PkLoader(val logo: List<String>, val text: String, val caption: String) : PkBlock

/**
 * A full-screen step. [look]: dialog (a card on black: no sources yet, nothing played) or art (over
 * the title's blurred picture: connecting, peer-to-peer, debrid down, saving offline).
 * Buttons send {a:"stage", what:id}; the box's checkbox sends what "toggle".
 */
class PkStage(
    val look: String,
    val backdrop: List<String>,
    val kicker: String?,
    val pill: PkTag?,
    val logo: List<String>,
    val logoText: String?,
    val line: String?,
    val check: Boolean,
    val title: String?,
    val titleSize: Float,
    val body: String?,
    val bullets: List<String>,
    val box: PkBox?,
    val toggle: PkToggle?,
    val spinner: String?,
    val notice: String?,
    val sub: String?,
    val label: String?,
    val foot: String?,
    val buttons: List<PkButton>,
    val cancel: PkButton?,
)

/** The source a step is about: its name, seeders and facts. */
class PkBox(val title: String, val seeders: String?, val meta: List<String>)

class PkToggle(val label: String, val on: Boolean)

object PkParse {
    fun block(o: JSONObject?): PkBlock? {
        if (o == null) return null
        return when (o.str("type")) {
            "pick" -> PkPick(
                images = o.optJSONArray("img").strings(),
                wide = o.optBoolean("wide", false),
                logo = o.str("logo"),
                badges = badges(o.optJSONArray("badges")),
                flags = flags(o.optJSONArray("flags")),
                moreFlags = o.str("moreFlags"),
                noAudio = o.str("noAudio"),
                confirm = o.str("confirm"),
                match = tag(o.optJSONObject("match")),
                title = o.str("title") ?: "",
                file = o.str("file"),
                summary = o.optJSONArray("summary").strings(),
                status = status(o.optJSONObject("status")),
                chips = o.optJSONArray("chips").objects().mapNotNull { tag(it) },
                button = button(o.optJSONObject("button")) ?: PkButton("primary", "", "off", null),
                via = o.optJSONObject("via")?.let { v ->
                    PkVia(
                        top = v.str("top"),
                        tone = v.str("tone") ?: "muted",
                        zap = v.optBoolean("zap", false),
                        by = v.str("by") ?: "",
                        addon = v.str("addon") ?: "",
                        logo = v.optJSONArray("logo").strings(),
                    )
                },
                copy = o.str("copy"),
            )
            "tiers" -> PkTiers(
                title = o.str("title") ?: "",
                infoTitle = o.str("infoTitle") ?: "",
                infoBody = o.str("infoBody") ?: "",
                pills = pills(o.optJSONArray("pills")),
                tiers = o.optJSONArray("tiers").objects().map { t ->
                    PkTier(
                        badge = badge(t.optJSONObject("badge")) ?: PkBadge(null, "", 60f),
                        label = t.str("label") ?: "",
                        status = t.str("status") ?: "",
                        zap = t.str("zap"),
                        on = t.optBoolean("on", false),
                        dim = t.optBoolean("dim", false),
                    )
                },
            )
            "streams" -> PkStreams(
                o.optJSONArray("items").objects().map { s ->
                    PkStream(
                        badges = badges(s.optJSONArray("badges")),
                        title = s.str("title") ?: "",
                        edition = s.str("edition"),
                        file = s.str("file"),
                        logo = logo(s.optJSONObject("logo")),
                        addon = s.str("addon") ?: "",
                        summary = s.str("summary"),
                        flags = flags(s.optJSONArray("flags")),
                        moreFlags = s.optInt("moreFlags", 0),
                        match = tag(s.optJSONObject("match")),
                        status = status(s.optJSONObject("status")),
                        end = s.str("end") ?: "play",
                        copy = s.str("copy"),
                    )
                },
            )
            "drawer" -> PkDrawer(
                label = o.str("label") ?: "",
                count = o.str("count") ?: "",
                logos = o.optJSONArray("logos").objects().map { logo(it) },
                addons = o.str("addons"),
                open = o.optBoolean("open", false),
                pills = pills(o.optJSONArray("pills")),
            )
            "diag" -> PkDiag(
                lead = o.str("lead") ?: "",
                text = o.str("text") ?: "",
                open = o.optBoolean("open", false),
                more = o.optJSONArray("more").strings(),
            )
            "panel" -> PkPanel(
                look = o.str("look") ?: "card",
                kicker = o.str("kicker"),
                title = o.str("title"),
                titleSize = o.optDouble("titleSize", 28.0).toFloat(),
                body = o.str("body"),
                pills = o.optJSONArray("pills").strings(),
                mono = o.str("mono"),
                button = button(o.optJSONObject("button")),
                note = o.str("note"),
                art = o.optJSONArray("art").strings(),
            )
            "loader" -> PkLoader(
                logo = o.optJSONArray("logo").strings(),
                text = o.str("text") ?: "",
                caption = o.str("caption") ?: "",
            )
            else -> null
        }
    }

    fun stage(o: JSONObject?): PkStage? {
        if (o == null) return null
        return PkStage(
            look = o.str("look") ?: "art",
            backdrop = o.optJSONArray("backdrop").strings(),
            kicker = o.str("kicker"),
            pill = tag(o.optJSONObject("pill")),
            logo = o.optJSONArray("logo").strings(),
            logoText = o.str("logoText"),
            line = o.str("line"),
            check = o.optBoolean("check", false),
            title = o.str("title"),
            titleSize = o.optDouble("titleSize", 24.0).toFloat(),
            body = o.str("body"),
            bullets = o.optJSONArray("bullets").strings(),
            box = o.optJSONObject("box")?.let { b -> PkBox(b.str("title") ?: "", b.str("seeders"), b.optJSONArray("meta").strings()) },
            toggle = o.optJSONObject("toggle")?.let { t -> PkToggle(t.str("label") ?: "", t.optBoolean("on", false)) },
            spinner = o.str("spinner"),
            notice = o.str("notice"),
            sub = o.str("sub"),
            label = o.str("label"),
            foot = o.str("foot"),
            buttons = o.optJSONArray("buttons").objects().mapNotNull { button(it) },
            cancel = button(o.optJSONObject("cancel")),
        )
    }

    private fun badge(o: JSONObject?): PkBadge? {
        if (o == null) return null
        return PkBadge(o.str("src"), o.str("label") ?: "", o.optDouble("w", 42.0).toFloat())
    }

    private fun badges(a: JSONArray?) = a.objects().mapNotNull { badge(it) }

    private fun flags(a: JSONArray?) = a.objects().map { PkFlag(it.str("emoji"), it.str("label") ?: "", it.optBoolean("multi", false)) }

    private fun tag(o: JSONObject?): PkTag? {
        val text = o?.str("text") ?: return null
        return PkTag(text, o.str("style") ?: "plain")
    }

    private fun status(o: JSONObject?): PkStatus? {
        val text = o?.str("text") ?: return null
        return PkStatus(text, o.str("tone") ?: "muted", o.str("icon"), o.optBoolean("upper", true))
    }

    private fun button(o: JSONObject?): PkButton? {
        if (o == null) return null
        return PkButton(o.str("id") ?: "", o.str("label") ?: "", o.str("style") ?: "ink", o.str("icon"), o.optBoolean("busy", false), o.str("copy"))
    }

    private fun pills(a: JSONArray?) = a.objects().mapNotNull { p ->
        val id = p.str("id") ?: return@mapNotNull null
        PkPill(id, p.str("label") ?: id, p.optBoolean("on", false), p.str("icon"), p.str("count"))
    }

    private fun logo(o: JSONObject?) = PkLogo(o?.optJSONArray("img").strings(), o?.str("initial") ?: "")

    private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k).takeIf { it.isNotEmpty() }

    private fun JSONArray?.objects(): List<JSONObject> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { optJSONObject(it) }
    }

    private fun JSONArray?.strings(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { i -> if (isNull(i)) null else optString(i).takeIf { it.isNotEmpty() } }
    }
}
