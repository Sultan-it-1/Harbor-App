package app.harbor.android

import org.json.JSONArray
import org.json.JSONObject

/*
 * The Addons page (src/views/addons.tsx) and an addon's page, as the page describes them for the
 * native screen: a row of kind "ad" carries one [AdBlock]. Buttons are [PkButton]s (PickerModel.kt).
 * Taps send {a:"ad", row, what, i}. Plain JVM (org.json only).
 */

/** An addon's logo: its pictures (best first), else its initial on the [from]→[to] gradient. */
class AdLogo(val images: List<String>, val initial: String, val from: Int?, val to: Int?)

/** A small pill. [tone]: star (accent stars), rise (rose), new (green), good (accent), warn, neutral.
 *  [icon]: star, trend, sparkles. */
class AdPill(val text: String, val tone: String, val icon: String? = null)

sealed interface AdBlock

/**
 * An addon as a card down the page. [variant]: list (the button at the end), feature (the button
 * beside the name, tags under the text), browse (a chevron at the end), community (its button
 * and a chevron). [art]: its logo, faint behind the card. Sends what "open" / "btn".
 */
class AdCard(
    val variant: String,
    val logo: AdLogo,
    val name: String,
    val pills: List<AdPill>,
    val desc: String?,
    val tags: List<AdPill>,
    val button: PkButton?,
    val chevron: Boolean,
    val art: String?,
    val dim: Boolean,
    /** The last card of a list that loads more: shown, it sends what "more". */
    val more: Boolean = false,
) : AdBlock

/** Addons as tiles: two across (a rail), or a sideways strip ([strip]: an addon's "More like this"). */
class AdTiles(val strip: Boolean, val items: List<AdTile>) : AdBlock

class AdTile(val logo: AdLogo, val name: String, val pills: List<AdPill>, val desc: String?, val button: PkButton, val art: String?)

/** The featured addon: eyebrow and stars, its name, the line under it, Get / Installed, View details. */
class AdHero(
    val eyebrow: String,
    val pills: List<AdPill>,
    val title: String,
    val subtitle: String?,
    val button: PkButton,
    val link: String,
    val from: Int?,
    val to: Int?,
) : AdBlock

/** "Top on stremio-addons.net": its heading, Top rated / Just added, Browse all and its cards. */
class AdCommunity(
    val logo: String?,
    val kicker: String,
    val title: String,
    val site: String,
    val sub: String,
    val tabs: List<PkPill>,
    val browse: String,
    /** loading, error, empty, ok. */
    val state: String,
    val message: String?,
    val cards: List<AdCommunityCard>,
) : AdBlock

class AdCommunityCard(
    val background: String?,
    val stars: String?,
    val logo: String?,
    val name: String,
    val desc: String?,
    val types: List<String>,
    val installed: String?,
    val install: String?,
    val busy: Boolean,
)

/** "Browse by category": six tiles, each its gradient, icon, name and line. Sends what "cat". */
class AdCategories(val title: String, val blurb: String, val tiles: List<AdCategory>) : AdBlock

class AdCategory(val title: String, val blurb: String, val from: Int?, val to: Int?, val icon: String?)

/** A section's heading in the display face, its line, and "See all (n)" / "Show less" (what "more"). */
class AdHead(val title: String, val blurb: String?, val action: String?, val open: Boolean, val size: Float) : AdBlock

/** An installed addon: logo, name and line, its switch, Manage, and Installed / Tap again to remove.
 *  Sends what "open", "toggle", "manage", "remove". */
class AdInstalled(
    val logo: AdLogo,
    val name: String,
    val sub: String,
    val enabled: Boolean,
    val manage: String?,
    val pill: PkButton,
    val dim: Boolean,
) : AdBlock

/** An addon's page, its top: backdrop, logo, stars, the line of facts, name, rising, description
 *  (three lines, "View more"), its buttons (what "btn:<id>") and tags. */
class AdDetail(
    val background: String?,
    val glow: String?,
    val logo: AdLogo,
    val stars: String?,
    val eyebrow: String,
    val name: String,
    val rising: AdPill?,
    val desc: String?,
    val descOpen: Boolean,
    val more: String,
    val less: String,
    val buttons: List<PkButton>,
    val tags: List<AdPill>,
) : AdBlock

/** "Project information": the manifest's facts, its URL (hidden until revealed) and the footnote. */
class AdInfo(
    val title: String,
    val note: String,
    val stats: List<Pair<String, String>>,
    val urlLabel: String,
    val url: String,
    val reveal: String,
    val copy: String?,
    val hint: String?,
    val foot: String,
    val credit: String,
) : AdBlock

/** "Documentation" from stremio-addons.net, as headings, paragraphs and list lines; folded until
 *  "View more" (what "doc"). */
class AdDoc(val title: String, val note: String, val parts: List<Pair<String, String>>, val open: Boolean, val more: String, val less: String) : AdBlock

object AdParse {
    fun block(o: JSONObject?): AdBlock? {
        if (o == null) return null
        return when (o.str("type")) {
            "card" -> AdCard(
                variant = o.str("variant") ?: "list",
                logo = logo(o.optJSONObject("logo")),
                name = o.str("name") ?: "",
                pills = pills(o.optJSONArray("pills")),
                desc = o.str("desc"),
                tags = pills(o.optJSONArray("tags")),
                button = button(o.optJSONObject("button")),
                chevron = o.optBoolean("chevron", false),
                art = o.str("art"),
                dim = o.optBoolean("dim", false),
                more = o.optBoolean("more", false),
            )
            "tiles" -> AdTiles(
                strip = o.optBoolean("strip", false),
                items = o.optJSONArray("items").objects().map { t ->
                    AdTile(
                        logo = logo(t.optJSONObject("logo")),
                        name = t.str("name") ?: "",
                        pills = pills(t.optJSONArray("pills")),
                        desc = t.str("desc"),
                        button = button(t.optJSONObject("button")) ?: PkButton("btn", "", "ink", null),
                        art = t.str("art"),
                    )
                },
            )
            "hero" -> AdHero(
                eyebrow = o.str("eyebrow") ?: "",
                pills = pills(o.optJSONArray("pills")),
                title = o.str("title") ?: "",
                subtitle = o.str("subtitle"),
                button = button(o.optJSONObject("button")) ?: PkButton("btn", "", "ink", null),
                link = o.str("link") ?: "",
                from = HomeColors.parseHex(o.str("from")),
                to = HomeColors.parseHex(o.str("to")),
            )
            "community" -> AdCommunity(
                logo = o.str("logo"),
                kicker = o.str("kicker") ?: "",
                title = o.str("title") ?: "",
                site = o.str("site") ?: "",
                sub = o.str("sub") ?: "",
                tabs = o.optJSONArray("tabs").objects().mapNotNull { p ->
                    val id = p.str("id") ?: return@mapNotNull null
                    PkPill(id, p.str("label") ?: id, p.optBoolean("on", false))
                },
                browse = o.str("browse") ?: "",
                state = o.str("state") ?: "loading",
                message = o.str("message"),
                cards = o.optJSONArray("cards").objects().map { c ->
                    AdCommunityCard(
                        background = c.str("bg"),
                        stars = c.str("stars"),
                        logo = c.str("logo"),
                        name = c.str("name") ?: "",
                        desc = c.str("desc"),
                        types = c.optJSONArray("types").strings(),
                        installed = c.str("installed"),
                        install = c.str("install"),
                        busy = c.optBoolean("busy", false),
                    )
                },
            )
            "cats" -> AdCategories(
                title = o.str("title") ?: "",
                blurb = o.str("blurb") ?: "",
                tiles = o.optJSONArray("tiles").objects().map { t ->
                    AdCategory(t.str("title") ?: "", t.str("blurb") ?: "", HomeColors.parseHex(t.str("from")), HomeColors.parseHex(t.str("to")), t.str("icon"))
                },
            )
            "head" -> AdHead(o.str("title") ?: "", o.str("blurb"), o.str("action"), o.optBoolean("open", false), o.optDouble("size", 26.0).toFloat())
            "installed" -> AdInstalled(
                logo = logo(o.optJSONObject("logo")),
                name = o.str("name") ?: "",
                sub = o.str("sub") ?: "",
                enabled = o.optBoolean("enabled", true),
                manage = o.str("manage"),
                pill = button(o.optJSONObject("pill")) ?: PkButton("remove", "", "installed", null),
                dim = o.optBoolean("dim", false),
            )
            "detail" -> AdDetail(
                background = o.str("bg"),
                glow = o.str("glow"),
                logo = logo(o.optJSONObject("logo")),
                stars = o.str("stars"),
                eyebrow = o.str("eyebrow") ?: "",
                name = o.str("name") ?: "",
                rising = o.optJSONObject("rising")?.let { pill(it) },
                desc = o.str("desc"),
                descOpen = o.optBoolean("descOpen", false),
                more = o.str("more") ?: "View more",
                less = o.str("less") ?: "Show less",
                buttons = o.optJSONArray("buttons").objects().mapNotNull { button(it) },
                tags = pills(o.optJSONArray("tags")),
            )
            "info" -> AdInfo(
                title = o.str("title") ?: "",
                note = o.str("note") ?: "",
                stats = o.optJSONArray("stats").objects().map { (it.str("label") ?: "") to (it.str("value") ?: "") },
                urlLabel = o.str("urlLabel") ?: "",
                url = o.str("url") ?: "",
                reveal = o.str("reveal") ?: "",
                copy = o.str("copy"),
                hint = o.str("hint"),
                foot = o.str("foot") ?: "",
                credit = o.str("credit") ?: "",
            )
            "doc" -> AdDoc(
                title = o.str("title") ?: "",
                note = o.str("note") ?: "",
                parts = o.optJSONArray("parts").objects().map { (it.str("k") ?: "p") to (it.str("text") ?: "") },
                open = o.optBoolean("open", false),
                more = o.str("more") ?: "View more",
                less = o.str("less") ?: "Show less",
            )
            else -> null
        }
    }

    private fun logo(o: JSONObject?) = AdLogo(
        images = o?.optJSONArray("img").strings(),
        initial = o?.str("initial") ?: "?",
        from = HomeColors.parseHex(o?.str("from")),
        to = HomeColors.parseHex(o?.str("to")),
    )

    private fun pill(o: JSONObject): AdPill? {
        val text = o.str("text") ?: return null
        return AdPill(text, o.str("tone") ?: "neutral", o.str("icon"))
    }

    private fun pills(a: JSONArray?) = a.objects().mapNotNull { pill(it) }

    private fun button(o: JSONObject?): PkButton? {
        if (o == null) return null
        return PkButton(o.str("id") ?: "btn", o.str("label") ?: "", o.str("style") ?: "ink", o.str("icon"), o.optBoolean("busy", false), o.str("copy"))
    }

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
