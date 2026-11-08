package app.harbor.android

import org.json.JSONArray
import org.json.JSONObject

/**
 * What a native screen (Home, Discover, Movies, Shows, Library) shows, as the page describes it
 * (src/views/native/native-screens.ts and the pages build the JSON). Plain JVM (org.json only), so
 * it runs in unit tests (HomeModelTest).
 */
class HomeModel(
    /** Which screen this is ("home", "discover", "movies", "shows", "library"). */
    val page: String = "home",
    val rtl: Boolean,
    /** Changes when the page wants Home back at the top (the Home tab tapped again). */
    val top: Int,
    val colors: HomeColors,
    val labels: Map<String, String>,
    val hero: List<HomeSlide>,
    /** Continue Watching first (kind "cw") when there is anything in it, then the catalog rows. */
    val rows: List<HomeRow>,
    /** Continue Watching when it is empty: its title and the text in its box. */
    val cwEmpty: Pair<String, String>?,
    val showCustomize: Boolean,
    val showTogether: Boolean,
    /** Rating badges at the top of the poster instead of the bottom (Settings > badge placement). */
    val badgesTop: Boolean = false,
    /** A heading at the top (Shows, Library). */
    val header: HomeHeader? = null,
    /** Rows of choices under the heading (Library: tab, type, sort). */
    val chips: List<HomeChips> = emptyList(),
    /** Shown when there are no rows (an empty Library tab): optional title, then the text. */
    val empty: Pair<String?, String>? = null,
    /** The page's row editor is open: each row with an [HomeRow.edit] gets its controls. */
    val edit: Boolean = false,
    /** Home's editor offers "Add source" (custom sources). */
    val addSource: Boolean = false,
    /** A page opened over another (a title's grid, a genre…): the Back pill's label, at the top. */
    val back: String? = null,
    /** A search field under the heading that stays at the top while the page scrolls. */
    val search: HomeSearch? = null,
    /** A line of small text over the rows ("Showing the closest matches"). */
    val note: String? = null,
    /** A centred message with an optional button (no search results…): sends {a:"message"}. */
    val message: HomeMessage? = null,
    /** A title's page: its hero (backdrop, logo, pills, Play, More) and synopsis, over the rows. */
    val detail: HomeDetail? = null,
    /** The discovery queue's card and the strip under it. */
    val queue: HomeQueue? = null,
    /** The release calendar's month: its bar (previous / Today / month / next) and its grid. */
    val calendar: HomeCalendar? = null,
    /** The downloads page: where files are kept, its notices, the season searches and the downloads. */
    val downloads: HomeDownloads? = null,
    /** A menu sliding up from the bottom (a title's "…"), while it's open. */
    val sheet: HomeSheet? = null,
    /** A game's scoreboard (the match page's top). */
    val match: HomeMatch? = null,
    /** Live TV's guide: the hours across, the channels down. */
    val guide: HomeGuide? = null,
    /** A full-screen step over everything (the play picker's: connecting, peer-to-peer…). */
    val stage: PkStage? = null,
    /** A short message at the bottom (a toast); shown once per [HomeToast.id]. */
    val toast: HomeToast? = null,
    /** A question with a text field (paste an addon's address); sends {a:"prompt", what:key, text}. */
    val prompt: HomePrompt? = null,
) {
    fun label(key: String, fallback: String): String = labels[key]?.takeIf { it.isNotBlank() } ?: fallback

    companion object {
        const val VERSION = 1

        fun parse(json: String): HomeModel {
            val o = JSONObject(json)
            val labels = HashMap<String, String>()
            o.optJSONObject("labels")?.let { l -> for (k in l.keys()) l.str(k)?.let { labels[k] = it } }
            val cw = o.optJSONObject("cwEmpty")
            val head = o.optJSONObject("header")
            val empty = o.optJSONObject("empty")
            return HomeModel(
                page = o.str("page") ?: "home",
                rtl = o.optBoolean("rtl", false),
                top = o.optInt("top", 0),
                colors = HomeColors.parse(o.optJSONObject("colors")),
                labels = labels,
                hero = o.optJSONArray("hero").objects().map { s ->
                    HomeSlide(
                        title = s.str("title") ?: "",
                        description = s.str("desc"),
                        year = s.str("year"),
                        rating = s.str("rating"),
                        runtime = s.str("runtime"),
                        images = s.optJSONArray("img").strings(),
                        logo = s.str("logo"),
                        rank = s.str("rank"),
                        inList = s.optBoolean("inList", false),
                    )
                },
                rows = o.optJSONArray("rows").objects().mapNotNull { r ->
                    val key = r.str("key") ?: return@mapNotNull null
                    val items = r.optJSONArray("items").objects().map { c ->
                        HomeCard(
                            title = c.str("title") ?: "",
                            images = c.optJSONArray("img").strings(),
                            rating = c.str("rating"),
                            sub = c.str("sub"),
                            progress = c.optDouble("progress", 0.0).toFloat().takeIf { !it.isNaN() }?.coerceIn(0f, 1f) ?: 0f,
                            rank = c.optInt("rank", 0),
                            watched = c.optBoolean("watched", false),
                            tint = HomeColors.parseHex(c.str("tint")),
                            kicker = c.str("kicker"),
                            play = c.optBoolean("play", false),
                            emblem = c.optBoolean("emblem", false),
                            icon = c.str("icon"),
                            tone = c.str("tone"),
                            button = c.str("button"),
                            busy = c.optBoolean("busy", false),
                            logo = c.str("logo"),
                            bar = c.optBoolean("bar", false),
                            tags = c.optJSONArray("tags").strings(),
                            desc = c.str("desc"),
                        )
                    }
                    val ed = r.optJSONObject("ed")?.let { e ->
                        RowEdit(
                            hidden = e.optBoolean("hidden", false),
                            up = e.optBoolean("up", false),
                            down = e.optBoolean("down", false),
                            numerals = tri(e.str("numerals")),
                            hero = tri(e.str("hero")),
                            delete = e.optBoolean("del", false),
                            pinned = e.optBoolean("pinned", false),
                            renamed = e.optBoolean("renamed", false),
                        )
                    }
                    // In the editor a row shows even with nothing in it (hidden, or not loaded); a
                    // row led by a spotlight card shows with only that card; credits have no cards.
                    // A row of only choices or buttons (recent searches, Surprise me) shows too, and
                    // a heading over a grid ("head": an award's winning films and their count).
                    val onlyChoices = r.optJSONObject("chips") != null || (r.optJSONArray("tools")?.length() ?: 0) > 0 || r.optBoolean("head", false)
                    val pk = if (r.str("kind") == "pk") PkParse.block(r.optJSONObject("pk")) ?: return@mapNotNull null else null
                    val ad = if (r.str("kind") == "ad") AdParse.block(r.optJSONObject("ad")) ?: return@mapNotNull null else null
                    if (items.isEmpty() && ed == null && !onlyChoices && pk == null && ad == null && r.optJSONObject("lead") == null && r.str("kind") != "credits" && r.str("kind") != "episodes") return@mapNotNull null
                    HomeRow(
                        key = key,
                        title = r.str("title") ?: "",
                        kind = when (r.str("kind")) {
                            "cw" -> HomeRow.Kind.CW
                            "rank" -> HomeRow.Kind.RANK
                            "tile" -> HomeRow.Kind.TILE
                            "logo" -> HomeRow.Kind.LOGO
                            "feature" -> HomeRow.Kind.FEATURE
                            "critic" -> HomeRow.Kind.CRITIC
                            "credits" -> HomeRow.Kind.CREDITS
                            "episodes" -> HomeRow.Kind.EPISODES
                            "people" -> HomeRow.Kind.PEOPLE
                            "list" -> HomeRow.Kind.LIST
                            "winners" -> HomeRow.Kind.WINNERS
                            "action" -> HomeRow.Kind.ACTION
                            "live" -> HomeRow.Kind.LIVE
                            "guide" -> HomeRow.Kind.GUIDE
                            "channel" -> HomeRow.Kind.CHANNEL
                            "livehero" -> HomeRow.Kind.LIVEHERO
                            "sports" -> HomeRow.Kind.SPORTS
                            "sources" -> HomeRow.Kind.SOURCES
                            "versus" -> HomeRow.Kind.VERSUS
                            "pitch" -> HomeRow.Kind.PITCH
                            "pk" -> HomeRow.Kind.PK
                            "ad" -> HomeRow.Kind.AD
                            else -> HomeRow.Kind.POSTER
                        },
                        seeAll = r.optBoolean("all", false),
                        more = r.optBoolean("more", false),
                        items = items,
                        edit = ed,
                        note = r.str("note"),
                        critic = r.optJSONObject("critic")?.let { parseCritic(it) },
                        sub = r.str("sub"),
                        gallery = r.optBoolean("gallery", false),
                        noInfo = r.optBoolean("noInfo", false),
                        chips = r.optJSONObject("chips")?.let { g ->
                            val ck = g.str("key") ?: return@let null
                            val its = g.optJSONArray("items").objects().mapNotNull { c ->
                                val id = c.str("id") ?: return@mapNotNull null
                                HomeChip(id = id, label = c.str("label") ?: id, on = c.optBoolean("on", false))
                            }
                            if (its.isEmpty()) null else HomeChips(ck, its)
                        },
                        tools = r.optJSONArray("tools").objects().mapNotNull { c ->
                            val id = c.str("id") ?: return@mapNotNull null
                            HomeChip(id = id, label = c.str("label") ?: id, on = c.optBoolean("on", false))
                        },
                        credits = r.optJSONArray("credits").objects().map { g ->
                            CreditGroup(
                                label = g.str("label") ?: "",
                                people = g.optJSONArray("people").objects().mapNotNull { p ->
                                    val id = p.optLong("id", 0L)
                                    val name = p.str("name") ?: return@mapNotNull null
                                    CriticPerson(id = id, name = name, image = null)
                                },
                                value = g.str("value"),
                            )
                        },
                        grid = r.optBoolean("grid", false),
                        min = r.optInt("min", 0),
                        ratio = r.optDouble("ratio", 0.0).toFloat().takeIf { !it.isNaN() && it > 0f } ?: 0f,
                        lead = r.optJSONObject("lead")?.let { l ->
                            HomeCard(title = l.str("title") ?: "", images = l.optJSONArray("img").strings(), rating = null, sub = l.str("sub"), progress = 0f, rank = 0)
                        },
                        pk = pk,
                        ad = ad,
                    )
                },
                cwEmpty = cw?.let { (it.str("title") ?: "") to (it.str("text") ?: "") },
                showCustomize = o.optBoolean("customize", false),
                showTogether = o.optBoolean("together", false),
                badgesTop = o.optBoolean("badgesTop", false),
                header = head?.let { h ->
                    HomeHeader(
                        kicker = h.str("kicker"),
                        title = h.str("title") ?: "",
                        subtitle = h.str("subtitle"),
                        logo = h.str("logo"),
                        tint = HomeColors.parseHex(h.str("tint")),
                        count = h.str("count"),
                        icon = h.str("icon"),
                        size = h.optDouble("size", 0.0).toFloat().takeIf { !it.isNaN() && it > 0f },
                        body = h.str("body"),
                        backdrop = h.optJSONArray("backdrop").strings(),
                        photo = h.str("photo"),
                        badge = h.str("badge"),
                        bodyLines = h.optInt("bodyLines", 3),
                        switch = h.optJSONArray("switch").objects().mapNotNull { c ->
                            val id = c.str("id") ?: return@mapNotNull null
                            HomeChip(id = id, label = c.str("label") ?: id, on = c.optBoolean("on", false))
                        },
                    ).takeIf { it.title.isNotEmpty() || it.kicker != null || it.subtitle != null || it.logo != null }
                },
                chips = o.optJSONArray("chips").objects().mapNotNull { g ->
                    val key = g.str("key") ?: return@mapNotNull null
                    val items = g.optJSONArray("items").objects().mapNotNull { c ->
                        val id = c.str("id") ?: return@mapNotNull null
                        HomeChip(id = id, label = c.str("label") ?: id, on = c.optBoolean("on", false))
                    }
                    if (items.isEmpty()) null else HomeChips(key, items)
                },
                empty = empty?.str("text")?.let { empty.str("title") to it },
                edit = o.optBoolean("edit", false),
                addSource = o.optBoolean("addSource", false),
                back = o.str("back"),
                search = o.optJSONObject("search")?.let { q ->
                    HomeSearch(
                        key = q.str("key") ?: "",
                        hint = q.str("hint") ?: "",
                        text = q.str("text") ?: "",
                        busy = q.optBoolean("busy", false),
                        big = q.optBoolean("big", false),
                        focus = q.optBoolean("focus", false),
                    )
                },
                note = o.str("note"),
                detail = o.optJSONObject("detail")?.let { d ->
                    HomeDetail(
                        backdrop = d.optJSONArray("backdrop").strings(),
                        logo = d.str("logo"),
                        title = d.str("title") ?: "",
                        tagline = d.str("tagline"),
                        pills = d.optJSONArray("pills").objects().mapNotNull { p ->
                            val id = p.str("id") ?: return@mapNotNull null
                            DetailPill(id = id, label = p.str("label") ?: "", kind = p.str("kind") ?: "pill")
                        },
                        awards = d.str("awards"),
                        play = d.str("play"),
                        more = d.optBoolean("more", false),
                        synopsis = d.str("synopsis"),
                        taglineLink = d.optBoolean("taglineLink", false),
                        extra = d.str("extra"),
                        pending = d.optBoolean("pending", false),
                    )
                },
                queue = o.optJSONObject("queue")?.let { q ->
                    val l = q.optJSONObject("labels")
                    HomeQueue(
                        position = q.str("position") ?: "",
                        tag = q.str("tag"),
                        series = q.str("series"),
                        title = q.str("title") ?: "",
                        facts = q.optJSONArray("facts").strings(),
                        rating = q.str("rating"),
                        genres = q.str("genres"),
                        desc = q.str("desc"),
                        backdrop = q.optJSONArray("backdrop").strings(),
                        saved = q.optBoolean("saved", false),
                        canPrev = q.optBoolean("canPrev", false),
                        canNext = q.optBoolean("canNext", false),
                        labels = buildMap {
                            if (l != null) for (k in l.keys()) l.optString(k).takeIf { it.isNotEmpty() }?.let { put(k, it) }
                        },
                        strip = q.optJSONArray("strip").objects().map { t ->
                            QueueTile(img = t.optJSONArray("img").strings(), tag = t.str("tag") ?: "")
                        },
                        active = q.optInt("active", 0),
                        message = q.str("message"),
                    )
                },
                calendar = o.optJSONObject("calendar")?.let { c ->
                    val l = c.optJSONObject("labels")
                    HomeCalendar(
                        month = c.str("month") ?: "",
                        weekdays = c.optJSONArray("weekdays").strings(),
                        cells = c.optJSONArray("cells").objects().map { x ->
                            CalCell(
                                day = x.optInt("day", 0),
                                inMonth = x.optBoolean("inMonth", true),
                                today = x.optBoolean("today", false),
                                count = x.optInt("count", 0),
                                items = x.optJSONArray("items").objects().map { it ->
                                    CalItem(title = it.str("title") ?: "", images = it.optJSONArray("img").strings())
                                },
                                more = x.str("more"),
                            )
                        },
                        labels = buildMap {
                            if (l != null) for (k in l.keys()) l.optString(k).takeIf { it.isNotEmpty() }?.let { put(k, it) }
                        },
                    )
                },
                downloads = o.optJSONObject("downloads")?.let { d ->
                    HomeDownloads(
                        storage = d.str("storage"),
                        notices = d.optJSONArray("notices").objects().map { n ->
                            DlNotice(id = n.str("id") ?: "", icon = n.str("icon") ?: "", text = n.str("text") ?: "", action = n.str("action"), accent = n.optBoolean("accent", false), actionOn = n.optBoolean("actionOn", false))
                        },
                        jobs = d.optJSONArray("jobs").objects().map { j -> DlJob(key = j.str("key") ?: "", text = j.str("text") ?: "", stop = j.str("stop") ?: "Stop") },
                        groups = d.optJSONArray("groups").objects().map { g ->
                            DlGroup(
                                key = g.str("key") ?: "",
                                title = g.str("title"),
                                sub = g.str("sub"),
                                images = g.optJSONArray("img").strings(),
                                items = g.optJSONArray("items").objects().map { x ->
                                    DlItem(
                                        id = x.str("id") ?: "",
                                        title = x.str("title") ?: "",
                                        side = x.str("side"),
                                        images = x.optJSONArray("img").strings(),
                                        compact = x.optBoolean("compact", false),
                                        progress = x.optDouble("progress", -1.0).toFloat(),
                                        paused = x.optBoolean("paused", false),
                                        stats = x.str("stats"),
                                        note = x.str("note"),
                                        status = x.str("status") ?: "",
                                        statusText = x.str("statusText"),
                                        subs = x.str("subs"),
                                        subsAction = x.str("subsAction"),
                                        buttons = x.optJSONArray("buttons").objects().map { b -> DlButton(id = b.str("id") ?: "", label = b.str("label") ?: "") },
                                    )
                                },
                            )
                        },
                    )
                },
                guide = o.optJSONObject("guide")?.let { g ->
                    val l = g.optJSONObject("labels")
                    HomeGuide(
                        start = g.optLong("start"),
                        end = g.optLong("end"),
                        now = g.optLong("now"),
                        day = g.str("day") ?: "",
                        ticks = g.optJSONArray("ticks").objects().map { t -> GuideTick(t.optLong("at"), t.str("label") ?: "") },
                        channels = g.optJSONArray("channels").objects().map { c ->
                            GuideChannel(
                                name = c.str("name") ?: "",
                                number = c.str("number"),
                                logo = c.str("logo"),
                                programs = c.optJSONArray("programs").objects().map { p ->
                                    GuideProgram(p.optLong("s"), p.optLong("e"), p.str("title") ?: "", p.str("from") ?: "", p.str("to") ?: "", p.optBoolean("replay", false))
                                },
                            )
                        },
                        more = g.optBoolean("more", false),
                        labels = buildMap {
                            if (l != null) for (k in l.keys()) l.optString(k).takeIf { it.isNotEmpty() }?.let { put(k, it) }
                        },
                    )
                },
                stage = PkParse.stage(o.optJSONObject("stage")),
                toast = o.optJSONObject("toast")?.let { t -> t.str("text")?.let { HomeToast(t.optInt("id", 0), it) } },
                prompt = o.optJSONObject("prompt")?.let { q ->
                    HomePrompt(
                        key = q.str("key") ?: "prompt",
                        title = q.str("title") ?: "",
                        hint = q.str("hint") ?: "",
                        text = q.str("text") ?: "",
                        ok = q.str("ok") ?: "OK",
                        cancel = q.str("cancel") ?: "Cancel",
                    )
                },
                match = o.optJSONObject("match")?.let { mt ->
                    fun side(k: String) = mt.optJSONObject(k)?.let { s ->
                        MatchSide(name = s.str("name") ?: "", logo = s.str("logo"), score = s.str("score") ?: "0", yellow = s.optInt("yellow", 0), red = s.optInt("red", 0))
                    } ?: MatchSide("", null, "0", 0, 0)
                    HomeMatch(league = mt.str("league") ?: "", live = mt.optBoolean("live", false), status = mt.str("status") ?: "", home = side("home"), away = side("away"))
                },
                sheet = o.optJSONObject("sheet")?.let { sh ->
                    HomeSheet(
                        key = sh.str("key") ?: "",
                        items = sh.optJSONArray("items").objects().map { i ->
                            SheetItem(
                                id = i.str("id") ?: "",
                                label = i.str("label") ?: "",
                                icon = i.str("icon"),
                                active = i.optBoolean("active", false),
                                danger = i.optBoolean("danger", false),
                                indent = i.optBoolean("indent", false),
                                group = i.optBoolean("group", false),
                                open = i.optBoolean("open", false),
                                divider = i.optBoolean("divider", false),
                            )
                        },
                    )
                },
                message = o.optJSONObject("message")?.let { g ->
                    HomeMessage(title = g.str("title"), text = g.str("text"), action = g.str("action"))
                        .takeIf { it.title != null || it.text != null }
                },
            )
        }

        private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k).takeIf { it.isNotEmpty() }

        private fun parseCritic(c: JSONObject): CriticInfo = CriticInfo(
            title = c.str("title") ?: "",
            images = c.optJSONArray("img").strings(),
            logo = c.str("logo"),
            year = c.str("year"),
            rating = c.str("rating"),
            quote = c.str("quote"),
            overview = c.str("overview"),
            reviews = c.optJSONArray("reviews").objects().mapNotNull { r ->
                val text = r.str("text") ?: return@mapNotNull null
                CriticReview(text = text, full = r.str("full") ?: text, author = r.str("author"), score = r.str("score"), url = r.str("url"))
            },
            stills = c.optJSONArray("stills").strings(),
            cast = c.optJSONArray("cast").objects().mapNotNull { p ->
                val id = p.optLong("id", 0L).takeIf { it > 0 } ?: return@mapNotNull null
                CriticPerson(id = id, name = p.str("name") ?: "", image = p.str("img"))
            },
            director = c.optJSONObject("director")?.let { d ->
                d.optLong("id", 0L).takeIf { it > 0 }?.let { CriticPerson(id = it, name = d.str("name") ?: "", image = null) }
            },
            genres = c.optJSONArray("genres").strings(),
            castTitle = c.str("castTitle"),
        )

        /** "on" / "off" / anything else (not offered) as 1 / 0 / -1. */
        private fun tri(v: String?): Int = when (v) {
            "on" -> 1
            "off" -> 0
            else -> -1
        }

        private fun JSONArray?.objects(): List<JSONObject> {
            if (this == null) return emptyList()
            val out = ArrayList<JSONObject>(length())
            for (i in 0 until length()) optJSONObject(i)?.let { out.add(it) }
            return out
        }

        private fun JSONArray?.strings(): List<String> {
            if (this == null) return emptyList()
            val out = ArrayList<String>(length())
            for (i in 0 until length()) {
                if (isNull(i)) continue
                optString(i).takeIf { it.isNotBlank() }?.let { out.add(it) }
            }
            return out
        }
    }
}

class HomeSlide(
    val title: String,
    val description: String?,
    val year: String?,
    val rating: String?,
    val runtime: String?,
    val images: List<String>,
    val logo: String?,
    /** "#1 in Movies Today" */
    val rank: String?,
    val inList: Boolean,
)

class HomeRow(
    val key: String,
    val title: String,
    val kind: Kind,
    val seeAll: Boolean,
    /** The page can load more of this row when you near its end. */
    val more: Boolean,
    val items: List<HomeCard>,
    /** The editor's controls for this row (null = none, or the editor is closed). */
    val edit: RowEdit? = null,
    /** A small line at the end of the row's title (Critics' Pick: "Loved by reviewers today"). */
    val note: String? = null,
    /** CRITIC: everything its card shows. */
    val critic: CriticInfo? = null,
    /** A second, small line under the title (a genre page's "TRENDING NOW"). */
    val sub: String? = null,
    /** Pictures (a title's stills): a tap shows them full screen, here. */
    val gallery: Boolean = false,
    /** Episodes without a details page (anime): no details button. */
    val noInfo: Boolean = false,
    /** CREDITS: who made it (names open the person) and facts about it. */
    val credits: List<CreditGroup> = emptyList(),
    /** Choices under the title (a series' seasons): sends {a:"rowchip", row:key, what:id}. */
    val chips: HomeChips? = null,
    /** Buttons under them (Random, Download season…): sends {a:"tool", row:key, what:id}. */
    val tools: List<HomeChip> = emptyList(),
    /** Drawn as a grid down the page (a list's "See all", a collection) instead of a strip. */
    val grid: Boolean = false,
    /** A grid's narrowest card, in dp (as many across as fit). 0 = the usual. */
    val min: Int = 0,
    /** Tiles: height / width (16:9 collection cards = 0.5625). 0 = the usual 4:5. */
    val ratio: Float = 0f,
    /** A wide card before the others (a genre's spotlight on a person): sends {a:"lead"}. */
    val lead: HomeCard? = null,
    /** PK: one of the play picker's blocks (its big card, qualities, sources, messages). */
    val pk: PkBlock? = null,
    /** AD: one of the Addons page's blocks (cards, tiles, the featured one, an addon's page). */
    val ad: AdBlock? = null,
) {
    /** POSTER and RANK: titles; CW: Continue Watching; TILE: a coloured card with its name on it
     *  (genres, languages, awards, collections); LOGO: a streaming service; FEATURE: one wide
     *  card (the discovery queue); CRITIC: Critics' Pick (a title, its reviews, stills and cast). */
    enum class Kind { POSTER, RANK, CW, TILE, LOGO, FEATURE, CRITIC, CREDITS, EPISODES, PEOPLE, LIST, WINNERS, ACTION, LIVE, GUIDE, CHANNEL, LIVEHERO, SPORTS, SOURCES, VERSUS, PITCH, PK, AD }
}

/** Critics' Pick, as the page's own card shows it. */
class CriticInfo(
    val title: String,
    /** The big picture, best first. */
    val images: List<String>,
    val logo: String?,
    val year: String?,
    val rating: String?,
    /** Shown when there is no review (its tagline or first sentence). */
    val quote: String?,
    /** "Read full" when there is no review. */
    val overview: String?,
    val reviews: List<CriticReview>,
    /** Four stills (they open full screen). */
    val stills: List<String>,
    val cast: List<CriticPerson>,
    val director: CriticPerson?,
    val genres: List<String>,
    /** "Cast · 12", in the app's language. */
    val castTitle: String? = null,
)

class CriticReview(val text: String, val full: String, val author: String?, val score: String?, val url: String?)

class CriticPerson(val id: Long, val name: String, val image: String?)

class HomeCard(
    val title: String,
    /** Picture addresses, best first: the next one is tried when one fails. */
    val images: List<String>,
    val rating: String?,
    /** Continue Watching: "S1E2 · 20m left". */
    val sub: String?,
    /** Continue Watching: how far in, 0..1. */
    val progress: Float,
    /** Top 10: the number shown on the card (0 = none). */
    val rank: Int,
    /** Finished: a small check on the poster (when Settings > watched marks is on). */
    val watched: Boolean = false,
    /** Tiles: the card's colour (behind / under its picture). */
    val tint: Int? = null,
    /** The wide card: a label on its top (Critics' Pick). */
    val kicker: String? = null,
    /** The wide card: a Play button (sends {a:"play"}). */
    val play: Boolean = false,
    /** Tiles: the picture is an emblem shown whole in the top part (awards), not a backdrop. */
    val emblem: Boolean = false,
    /** An episode's overview (two lines). */
    val desc: String? = null,
    /** An action card ([HomeRow.Kind.ACTION]): its icon, look ("accent", "plain", "danger"),
     *  the button at its end (sends {a:"play"}) and a spinner while it works. */
    val icon: String? = null,
    val tone: String? = null,
    val button: String? = null,
    val busy: Boolean = false,
    /** Live TV: the channel's logo (beside its name, or in the picture's place) and whether
     *  the programme's bar ([progress]) shows. */
    val logo: String? = null,
    val bar: Boolean = false,
    /** A source's quality and format labels (4K, HDR, Atmos…). */
    val tags: List<String> = emptyList(),
)

/** A row's controls in the page's editor. [numerals] / [hero]: 1 on, 0 off, -1 not offered. */
class RowEdit(
    val hidden: Boolean,
    val up: Boolean,
    val down: Boolean,
    val numerals: Int,
    val hero: Int,
    val delete: Boolean,
    /** A fixed section (the hero, Top 10…): it can only be hidden or shown. */
    val pinned: Boolean,
    val renamed: Boolean,
)

/** The theme's colours (the page sends what its CSS uses), as ARGB ints. */
class HomeColors(
    val canvas: Int,
    val surface: Int,
    val ink: Int,
    val muted: Int,
    val subtle: Int,
    val accent: Int,
) {
    companion object {
        val DEFAULT = HomeColors(
            canvas = 0xFF141518.toInt(),
            surface = 0xFF1C1D21.toInt(),
            ink = 0xFFF5F5F7.toInt(),
            muted = 0xFFAEAFB3.toInt(),
            subtle = 0xFF6E7075.toInt(),
            accent = 0xFFE8A45E.toInt(),
        )

        fun parse(o: JSONObject?): HomeColors {
            if (o == null) return DEFAULT
            fun c(k: String, d: Int): Int = parseHex(if (o.isNull(k)) null else o.optString(k)) ?: d
            return HomeColors(
                canvas = c("canvas", DEFAULT.canvas),
                surface = c("surface", DEFAULT.surface),
                ink = c("ink", DEFAULT.ink),
                muted = c("muted", DEFAULT.muted),
                subtle = c("subtle", DEFAULT.subtle),
                accent = c("accent", DEFAULT.accent),
            )
        }

        /** "#rrggbb" or "#aarrggbb" (as the page sends them); anything else = null. */
        fun parseHex(s: String?): Int? {
            val h = s?.trim()?.removePrefix("#") ?: return null
            if (h.length != 6 && h.length != 8) return null
            val v = h.toLongOrNull(16) ?: return null
            return if (h.length == 6) (0xFF000000L or v).toInt() else v.toInt()
        }
    }
}

class HomeHeader(
    val kicker: String?,
    val title: String,
    val subtitle: String?,
    /** A picture instead of the title (a streaming service's logo). */
    val logo: String? = null,
    /** A glow of this colour behind the heading (the service's colour). */
    val tint: Int? = null,
    /** Small text after the title ("120 titles"). */
    val count: String? = null,
    /** A small icon before the kicker ("tag", "calendar", "clock", "globe", "languages", "building", "tv"). */
    val icon: String? = null,
    /** The title's size in sp (30 when not given). */
    val size: Float? = null,
    /** A paragraph under the subtitle (a collection's overview). */
    val body: String? = null,
    /** A picture behind the heading (a collection's backdrop). */
    val backdrop: List<String> = emptyList(),
    /** The title opens a list of these (a genre page: the other genres): sends {a:"chip", row:"switch", what:id}. */
    val switch: List<HomeChip> = emptyList(),
    /** A portrait above it all (a person's photo). */
    val photo: String? = null,
    /** A small accent badge after the kicker ("Top 12"): sends {a:"chip", row:"badge", what:"badge"}. */
    val badge: String? = null,
    /** How many lines of [body] show until it's tapped (then all of it). */
    val bodyLines: Int = 3,
)

/** A title's hero. [pills]: kind "pill" (a tap sends {a:"pill", what:id}), "imdb" (the IMDb tag), "score". */
class HomeDetail(
    val backdrop: List<String>,
    val logo: String?,
    val title: String,
    val tagline: String?,
    val pills: List<DetailPill>,
    val awards: String?,
    /** The Play button's label (null = none). Sends {a:"d", what:"play"}. */
    val play: String?,
    /** The round "…" button: the page's own menu (watchlist, favourite, trailer, download, Trakt…). */
    val more: Boolean,
    val synopsis: String?,
    /** The tagline opens something (an episode's series): sends {a:"pill", what:"tagline"}. */
    val taglineLink: Boolean = false,
    /** A second, outlined button after Play (a live channel's "Open in TV Shows"): {a:"d", what:"extra"}. */
    val extra: String? = null,
    /** The title's full details are still on their way: its words wait, then come in at once. */
    val pending: Boolean = false,
)

class DetailPill(val id: String, val label: String, val kind: String)

/**
 * The discovery queue: one title at a time on a big card (its tag, name, year · runtime · IMDb ·
 * genres, overview, Play tonight / Save / Skip / Not interested, details, previous / next), and
 * the queue's pictures in a strip under it (a tap jumps there). Taps send {a:"q", what, i}.
 * With no title yet only [message] shows (loading, no TMDB key…).
 */
class HomeQueue(
    val position: String,
    val tag: String?,
    /** "Series", beside the tag, for a series. */
    val series: String?,
    val title: String,
    /** Year, runtime: dots between them, then the IMDb rating and the genres. */
    val facts: List<String>,
    val rating: String?,
    val genres: String?,
    val desc: String?,
    val backdrop: List<String>,
    val saved: Boolean,
    val canPrev: Boolean,
    val canNext: Boolean,
    /** play, save, saved, skip, block, info, prev, next, queue. */
    val labels: Map<String, String>,
    val strip: List<QueueTile>,
    val active: Int,
    val message: String?,
) {
    fun label(k: String, fallback: String) = labels[k] ?: fallback
}

class QueueTile(val img: List<String>, val tag: String)

/**
 * The release calendar: the month's name, the weekdays' names and the grid's days (the month's
 * and the neighbouring ones that fill its weeks). Taps send {a:"cal", what}: "prev", "next",
 * "today"; "item" (i = the day, text = which title) and "day" (i = the day: all of its titles).
 */
class HomeCalendar(
    val month: String,
    val weekdays: List<String>,
    val cells: List<CalCell>,
    /** prev, next, today. */
    val labels: Map<String, String>,
) {
    fun label(k: String, fallback: String) = labels[k] ?: fallback
}

/** A day: its number, its first titles ([items], three at most), how many in all, "+2 more". */
class CalCell(val day: Int, val inMonth: Boolean, val today: Boolean, val count: Int, val items: List<CalItem>, val more: String?)

class CalItem(val title: String, val images: List<String>)

/**
 * The downloads page as it lists them. Taps send {a:"dl", what, text}: a button's id with the
 * download's id ("pause", "resume", "cancel", "retry", "play", "delete", "confirm", "subs"),
 * "notice" with a notice's id, "stopjob" with a season search's key.
 */
class HomeDownloads(val storage: String?, val notices: List<DlNotice>, val jobs: List<DlJob>, val groups: List<DlGroup>)

/** A card over the list (Wi-Fi only, battery limits): its icon ("wifi", "battery"), text, button. */
class DlNotice(val id: String, val icon: String, val text: String, val action: String?, val accent: Boolean, val actionOn: Boolean)

/** A "Download season" still finding sources ("Finding sources · Show S1 · 3/10"), with Stop. */
class DlJob(val key: String, val text: String, val stop: String)

/** A film's download alone ([title] null), or a show's episodes under its poster, name and count. */
class DlGroup(val key: String, val title: String?, val sub: String?, val images: List<String>, val items: List<DlItem>)

/**
 * A download: its poster, name ([side] beside it), then either the bar ([progress] 0..1, grey
 * while [paused]) with [stats] and [note], or its state ([status]: done, error, canceled,
 * interrupted; [statusText]); [subs] (how many subtitles) or [subsAction] ("Get subtitles");
 * the [buttons] at its end.
 */
class DlItem(
    val id: String,
    val title: String,
    val side: String?,
    val images: List<String>,
    val compact: Boolean,
    val progress: Float,
    val paused: Boolean,
    val stats: String?,
    val note: String?,
    val status: String,
    val statusText: String?,
    val subs: String?,
    val subsAction: String?,
    val buttons: List<DlButton>,
)

class DlButton(val id: String, val label: String)

/**
 * A menu sliding up from the bottom: its rows (an icon, the label; [SheetItem.active] in the
 * accent colour, [SheetItem.danger] red, [SheetItem.indent] under a [SheetItem.group] that
 * opens and closes them, a [SheetItem.divider] line). A tap sends {a:"sheet", what:id}; closing it
 * (outside, Back) sends {a:"sheet", what:""}. Another [key] is another menu.
 */
class HomeSheet(val key: String, val items: List<SheetItem>)

/** A game's scoreboard: the league (pulsing while [live]), each side's logo, name, cards and score, the state. */
class HomeMatch(val league: String, val live: Boolean, val status: String, val home: MatchSide, val away: MatchSide)

class MatchSide(val name: String, val logo: String?, val score: String, val yellow: Int, val red: Int)

/**
 * Live TV's guide, as the page's: the window's hours ([start]..[end], ms) with the [ticks] to label,
 * the channels (number, logo, name) and their programmes. Taps send {a:"guide", what}: "ch" (i =
 * the channel), "pg" (i = the channel, text = the programme), "more" (near the end of the list).
 */
class HomeGuide(
    val start: Long,
    val end: Long,
    val now: Long,
    val day: String,
    val ticks: List<GuideTick>,
    val channels: List<GuideChannel>,
    val more: Boolean,
    /** live, replay, ended, none (no programme info). */
    val labels: Map<String, String>,
) {
    fun label(k: String, fallback: String) = labels[k] ?: fallback
}

class GuideTick(val at: Long, val label: String)

class HomeToast(val id: Int, val text: String)

class HomePrompt(val key: String, val title: String, val hint: String, val text: String, val ok: String, val cancel: String)

class GuideChannel(val name: String, val number: String?, val logo: String?, val programs: List<GuideProgram>)

/** A programme: its start and end (ms), title and times; [replay]: it has ended and can be watched again. */
class GuideProgram(val s: Long, val e: Long, val title: String, val from: String, val to: String, val replay: Boolean)

class SheetItem(
    val id: String,
    val label: String,
    val icon: String?,
    val active: Boolean,
    val danger: Boolean,
    val indent: Boolean,
    val group: Boolean,
    val open: Boolean,
    val divider: Boolean,
)

/** A line of credits: a label and the people (a tap opens one), or a label and a [value]. */
class CreditGroup(val label: String, val people: List<CriticPerson>, val value: String?)

/** A search field; typing sends {a:"query", text}. A new [key] (another list) starts it afresh. */
class HomeSearch(
    val key: String,
    val hint: String,
    val text: String,
    val busy: Boolean,
    /** The search screen's own field: bigger, at the very top. */
    val big: Boolean = false,
    /** Typing straight away when it opens (the keyboard comes up). */
    val focus: Boolean = false,
)

/** A centred message; [action] is a button's label (sends {a:"message"}). */
class HomeMessage(val title: String?, val text: String?, val action: String?)

/** One row of choices; tapping one sends {a:"chip", row:key, what:id}. */
class HomeChips(val key: String, val items: List<HomeChip>)

class HomeChip(val id: String, val label: String, val on: Boolean)
