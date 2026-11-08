package app.harbor.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeModelTest {
    @Test
    fun readsWhatThePageSends() {
        val m = HomeModel.parse(
            """
            {"v":1,"rtl":true,"top":3,
             "colors":{"canvas":"#121316","accent":"#e8a45e","ink":"nope"},
             "labels":{"play":"تشغيل","seeAll":"عرض الكل","empty":""},
             "hero":[{"title":"Dune","desc":null,"year":"2021","rating":"8.0","img":["https://a/b.jpg",null,""],"logo":"https://a/l.png","rank":"#1","inList":true}],
             "rows":[
               {"key":"cw","title":"Continue Watching","kind":"cw","items":[{"title":"Show","img":["https://a/c.jpg"],"sub":"S1E2","progress":0.4}]},
               {"key":"top","title":"Top 10","kind":"rank","items":[{"title":"A","rank":1}]},
               {"key":"pop","title":"Popular","kind":"poster","all":true,"more":true,"items":[{"title":"B","img":["https://a/d.jpg"],"rating":"7.1","watched":true},{"title":"D"}]},
               {"key":"empty","title":"Nothing","items":[]},
               {"title":"no key","items":[{"title":"C"}]}
             ],
             "cwEmpty":null,"customize":true,"together":false,"badgesTop":true}
            """.trimIndent(),
        )
        assertTrue(m.rtl)
        assertEquals(3, m.top)
        assertEquals(0xFF121316.toInt(), m.colors.canvas)
        assertEquals(HomeColors.DEFAULT.ink, m.colors.ink) // unreadable colour: the default
        assertEquals("تشغيل", m.label("play", "Play"))
        assertEquals("Customize home", m.label("customize", "Customize home"))
        assertEquals("Fallback", m.label("empty", "Fallback"))

        val s = m.hero.single()
        assertEquals("Dune", s.title)
        assertNull(s.description)
        assertEquals(listOf("https://a/b.jpg"), s.images)
        assertTrue(s.inList)

        // Rows without cards or without a key are left out.
        assertEquals(listOf("cw", "top", "pop"), m.rows.map { it.key })
        assertEquals(HomeRow.Kind.CW, m.rows[0].kind)
        assertEquals(0.4f, m.rows[0].items[0].progress, 0.0001f)
        assertEquals(HomeRow.Kind.RANK, m.rows[1].kind)
        assertEquals(1, m.rows[1].items[0].rank)
        val pop = m.rows[2]
        assertEquals(HomeRow.Kind.POSTER, pop.kind)
        assertTrue(pop.seeAll && pop.more)
        assertEquals("7.1", pop.items[0].rating)
        assertTrue(pop.items[0].watched)
        assertFalse(pop.items[1].watched)
        assertTrue(m.badgesTop)
        assertNull(m.cwEmpty)
        assertTrue(m.showCustomize)
        assertFalse(m.showTogether)
    }

    @Test
    fun progressStaysBetweenZeroAndOne() {
        val m = HomeModel.parse("""{"rows":[{"key":"cw","kind":"cw","items":[{"title":"a","progress":3},{"title":"b","progress":-1},{"title":"c"}]}]}""")
        assertEquals(listOf(1f, 0f, 0f), m.rows[0].items.map { it.progress })
    }

    @Test
    fun emptyContinueWatchingBox() {
        val m = HomeModel.parse("""{"cwEmpty":{"title":"Continue Watching","text":"Nothing yet"}}""")
        assertEquals("Continue Watching" to "Nothing yet", m.cwEmpty)
        assertTrue(m.hero.isEmpty())
        assertTrue(m.rows.isEmpty())
    }

    @Test
    fun libraryScreen() {
        val m = HomeModel.parse(
            """
            {"page":"library","header":{"kicker":"My library","title":"Your collection.","subtitle":null},
             "chips":[{"key":"tab","items":[{"id":"watchlist","label":"Watchlist","on":true},{"id":"history","label":"History"},{"label":"no id"}]},
                      {"key":"empty","items":[]},{"items":[{"id":"x"}]}],
             "rows":[],"empty":{"title":null,"text":"Your watchlist is empty"}}
            """.trimIndent(),
        )
        assertEquals("library", m.page)
        assertEquals("Your collection.", m.header?.title)
        assertNull(m.header?.subtitle)
        // Rows of choices without a key or without choices are left out; so are choices without an id.
        assertEquals(listOf("tab"), m.chips.map { it.key })
        assertEquals(listOf("watchlist", "history"), m.chips[0].items.map { it.id })
        assertTrue(m.chips[0].items[0].on)
        assertFalse(m.chips[0].items[1].on)
        assertEquals(null to "Your watchlist is empty", m.empty)
    }

    @Test
    fun criticsPick() {
        val m = HomeModel.parse(
            """{"page":"discover","rows":[{"key":"x:critics","title":"Critics' Pick","kind":"critic","note":"Loved by reviewers today",
              "items":[{"title":"Yojimbo"}],
              "critic":{"title":"Yojimbo","img":["https://a/b.jpg"],"logo":null,"year":"1961","rating":"8.1","quote":"A standout.",
                "overview":"A ronin…","reviews":[{"text":"Short","full":"Short and long","author":"CRCulver","score":"9/10","url":"https://r"},{"author":"no text"}],
                "stills":["https://s/1.jpg","https://s/2.jpg"],"cast":[{"id":7,"name":"Toshirō","img":"https://p/1.jpg"},{"id":0,"name":"No id"}],
                "director":{"id":9,"name":"Akira Kurosawa"},"genres":["Drama","Thriller"]}}]}""",
        )
        val row = m.rows.single()
        assertEquals(HomeRow.Kind.CRITIC, row.kind)
        assertEquals("Loved by reviewers today", row.note)
        val c = row.critic!!
        assertEquals("1961", c.year)
        assertNull(c.logo)
        // A review without its text, a person without an id: left out.
        assertEquals(listOf("CRCulver"), c.reviews.map { it.author })
        assertEquals("Short and long", c.reviews[0].full)
        assertEquals(listOf(7L), c.cast.map { it.id })
        assertEquals("Akira Kurosawa", c.director?.name)
        assertEquals(listOf("Drama", "Thriller"), c.genres)
        assertEquals(2, c.stills.size)
    }

    @Test
    fun defaultsToHome() {
        val m = HomeModel.parse("{}")
        assertEquals("home", m.page)
        assertNull(m.header)
        assertTrue(m.chips.isEmpty())
        assertNull(m.empty)
    }

    @Test
    fun pickerBlocksAndStage() {
        val m = HomeModel.parse(
            """{"page":"picker","rows":[
              {"key":"pk-pick","kind":"pk","items":[],"pk":{"type":"pick","img":["https://a/b.jpg"],"wide":true,"title":"Film.2160p",
                "badges":[{"src":"https://appassets.androidplatform.net/assets/4k.webp","label":"4K UHD","w":30}],
                "flags":[{"emoji":"🇺🇸","label":"English"},{"emoji":null,"label":"Multi","multi":true}],
                "status":{"text":"Cached on TorBox","tone":"muted","icon":"zap","upper":false},
                "button":{"id":"primary","label":"Play","style":"ink","icon":"play","busy":true},
                "via":{"top":null,"by":"via","addon":"Torrentio","logo":[]},"copy":"https://x/y.mkv"}},
              {"key":"pk-streams","kind":"pk","items":[],"pk":{"type":"streams","items":[{"title":"A","logo":{"img":[],"initial":"T"},"addon":"T","end":"busy"},{"title":"B","logo":null,"addon":"T"}]}},
              {"key":"pk-odd","kind":"pk","items":[],"pk":{"type":"nope"}},
              {"key":"pk-panel","kind":"pk","items":[],"pk":{"type":"panel","look":"warn","title":"Only 1 source","button":{"id":"panel","label":"Show","style":"amber"}}}],
              "stage":{"look":"art","title":"Stream via P2P?","titleSize":40,"toggle":{"label":"Remember","on":true},
                "buttons":[{"id":"p2p","label":"Stream","style":"accent","icon":"radio"}],"cancel":{"id":"cancel","label":"Cancel"}}}""",
        )
        // A block the screen doesn't know is left out.
        assertEquals(listOf("pk-pick", "pk-streams", "pk-panel"), m.rows.map { it.key })
        assertTrue(m.rows.all { it.kind == HomeRow.Kind.PK })
        val pick = m.rows[0].pk as PkPick
        assertTrue(pick.wide)
        assertEquals(30f, pick.badges.single().w)
        assertEquals(listOf(false, true), pick.flags.map { it.multi })
        assertFalse(pick.status!!.upper)
        assertTrue(pick.button.busy)
        assertNull(pick.via!!.top)
        val streams = m.rows[1].pk as PkStreams
        assertEquals(listOf("busy", "play"), streams.items.map { it.end })
        assertEquals("", streams.items[1].logo.initial)
        assertEquals("warn", (m.rows[2].pk as PkPanel).look)
        val st = m.stage!!
        assertEquals(40f, st.titleSize)
        assertTrue(st.toggle!!.on)
        assertEquals("cancel", st.cancel?.id)
        assertTrue(HomeModel.parse("{}").stage == null)
    }

    @Test
    fun addonBlocksToastAndPrompt() {
        val m = HomeModel.parse(
            """{"page":"addons","rows":[
              {"key":"ad-hero","kind":"ad","items":[],"ad":{"type":"hero","eyebrow":"FEATURED","title":"Torrentio","button":{"id":"btn","label":"Get"},"link":"View details","from":"#66f59e0b","to":null}},
              {"key":"ad-c","kind":"ad","items":[],"ad":{"type":"card","variant":"community","logo":{"img":["https://l/1.png"],"initial":"C","from":"#ec78c9","to":"#a83a8a"},"name":"C","pills":[{"text":"100","tone":"star","icon":"star"},{"tone":"rise"}],"chevron":true,"more":true}},
              {"key":"ad-t","kind":"ad","items":[],"ad":{"type":"tiles","strip":true,"items":[{"logo":{},"name":"A","button":{"id":"btn","label":"Install","copy":"x"}}]}},
              {"key":"ad-info","kind":"ad","items":[],"ad":{"type":"info","stats":[{"label":"Version","value":"1"}],"url":"https://a/…/manifest.json"}},
              {"key":"ad-x","kind":"ad","items":[],"ad":{"type":"unknown"}}],
              "toast":{"id":3,"text":"Installed"},"prompt":{"key":"url","title":"Paste","hint":"stremio://"}}""",
        )
        assertEquals(listOf("ad-hero", "ad-c", "ad-t", "ad-info"), m.rows.map { it.key })
        val hero = m.rows[0].ad as AdHero
        assertEquals(0x66F59E0B, hero.from)
        assertNull(hero.to)
        val card = m.rows[1].ad as AdCard
        // A pill without its text is left out.
        assertEquals(1, card.pills.size)
        assertTrue(card.more && card.chevron)
        assertEquals(0xFFEC78C9.toInt(), card.logo.from)
        val tiles = m.rows[2].ad as AdTiles
        assertTrue(tiles.strip)
        assertEquals("?", tiles.items[0].logo.initial)
        assertEquals("x", tiles.items[0].button.copy)
        assertEquals(listOf("Version" to "1"), (m.rows[3].ad as AdInfo).stats)
        assertEquals(3, m.toast?.id)
        assertEquals("url", m.prompt?.key)
        assertEquals("OK", m.prompt?.ok)
    }

    @Test
    fun hexColours() {
        assertEquals(0xFFE8A45E.toInt(), HomeColors.parseHex("#e8a45e"))
        assertEquals(0x80FFFFFF.toInt(), HomeColors.parseHex("#80ffffff"))
        assertNull(HomeColors.parseHex("oklch(0.5 0.1 20)"))
        assertNull(HomeColors.parseHex("#abc"))
        assertNull(HomeColors.parseHex(null))
    }
}
