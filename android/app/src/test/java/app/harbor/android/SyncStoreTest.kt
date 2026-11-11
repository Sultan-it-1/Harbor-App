package app.harbor.android

import app.harbor.android.TextSync.Point
import app.harbor.android.TextSync.State
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sync of each subtitle, kept on the device by the subtitle's address. */
class SyncStoreTest {
    /** Stands in for the app's preferences: one string that outlives a store. */
    private var kept: String? = null
    private var writes = 0

    private fun store() = SyncStore({ kept }, { kept = it; writes++ })

    private val url = "https://subs.example/ar/123.srt"
    private val synced = State(listOf(Point(10.0, 12.5), Point(900.0, 904.0)), nudge = 0.2)

    @Test
    fun aSyncIsThereAgainAfterThePlayerWasClosed() {
        assertNull(store().get(url))
        store().put(url, synced)
        // A new store reads what the last one wrote, like the next run of the app.
        assertEquals(synced, store().get(url))
        assertNull(store().get("https://subs.example/ar/124.srt"))
    }

    @Test
    fun aSavedSubtitleGoesByItsFile() {
        val file = "file:///storage/emulated/0/Android/data/app.harbor.android/files/Movies/x/subs/sub1.srt"
        store().put(file, State(nudge = -1.5))
        assertEquals(State(nudge = -1.5), store().get(file))
    }

    @Test
    fun aSyncThatChangesNothingIsForgotten() {
        val s = store()
        s.put(url, synced)
        s.put(url, State())
        assertNull(s.get(url))
        assertNull(store().get(url))
        assertEquals("{}", kept)
        // Forgetting what was never kept writes nothing.
        val before = writes
        s.put(url, null)
        s.put("https://other.example/a.srt", State())
        assertEquals(before, writes)
    }

    @Test
    fun onlyTheMostRecentlyChangedSubtitlesAreKept() {
        val s = store()
        for (i in 1..SyncStore.MAX + 5) s.put("https://subs.example/$i.srt", State(nudge = i / 10.0), now = i.toLong())
        // The five oldest went; the rest are all there, also for the next run.
        for (i in 1..5) assertNull(s.get("https://subs.example/$i.srt"))
        for (i in 6..SyncStore.MAX + 5) assertEquals(i / 10.0, s.get("https://subs.example/$i.srt")!!.nudge, 1e-9)
        assertEquals(SyncStore.MAX, JSONObject(kept!!).length())
        assertNull(store().get("https://subs.example/5.srt"))
        assertEquals(0.6, store().get("https://subs.example/6.srt")!!.nudge, 1e-9)
        // Changing an old one again makes it recent.
        s.put("https://subs.example/6.srt", State(nudge = 9.0), now = 1000)
        s.put("https://subs.example/new.srt", State(nudge = 1.0), now = 1001)
        assertEquals(9.0, s.get("https://subs.example/6.srt")!!.nudge, 1e-9)
        assertNull(s.get("https://subs.example/7.srt"))
    }

    @Test
    fun aVeryLongAddressIsKeptByItsHash() {
        val long = "https://addon.example/" + "config".repeat(200) + "/subtitles/1.srt"
        val other = "https://addon.example/" + "config".repeat(200) + "/subtitles/2.srt"
        store().put(long, synced)
        assertEquals(synced, store().get(long))
        assertNull(store().get(other))
        assertTrue(kept!!.length < 400)
        assertFalse(kept!!.contains("configconfig"))
    }

    @Test
    fun unreadablePreferencesStartEmpty() {
        kept = "not json at all"
        val s = store()
        assertNull(s.get(url))
        s.put(url, synced)
        assertEquals(synced, store().get(url))
        // An entry that is not a sync is skipped, the others are read.
        kept = """{"a":7,"b":{"n":0.5,"u":3},"c":{"u":4}}"""
        assertNull(store().get("a"))
        assertEquals(State(nudge = 0.5), store().get("b"))
        assertNull(store().get("c"))
    }

    @Test
    fun aBlankAddressIsNotKept() {
        store().put("", synced)
        assertNull(kept)
    }
}
