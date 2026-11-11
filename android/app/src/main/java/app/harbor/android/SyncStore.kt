package app.harbor.android

import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The sync the viewer gave each subtitle (TextSync.State), kept on the device so it is there the
 * next time that subtitle is picked, also after the player was closed. The key is the subtitle's
 * address; for one saved with a download, the address it was saved from (its file when that isn't
 * known), so the saved copy and the online one share a sync.
 *
 * One small JSON map in the app's preferences: the [MAX] most recently changed subtitles.
 */
class SyncStore(private val read: () -> String?, private val write: (String) -> Unit) {
    constructor(ctx: Context) : this(
        { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) },
        { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, it).apply() },
    )

    private class Entry(val state: TextSync.State, val changedAt: Long)

    /** Read once, on first use. */
    private var entries: HashMap<String, Entry>? = null

    private fun load(): HashMap<String, Entry> {
        entries?.let { return it }
        val map = HashMap<String, Entry>()
        try {
            val all = JSONObject(read() ?: "{}")
            for (k in all.keys()) {
                val o = all.optJSONObject(k) ?: continue
                val state = TextSync.fromJson(o)
                if (!state.isIdentity) map[k] = Entry(state, o.optLong("u", 0))
            }
        } catch (_: Exception) {
            // Unreadable: start empty rather than fail a subtitle over it.
        }
        entries = map
        return map
    }

    fun get(address: String): TextSync.State? = load()[keyOf(address)]?.state

    /** Keeps [state] for the subtitle at [address]; a state that changes nothing (or none) is
     *  forgotten instead. */
    fun put(address: String, state: TextSync.State?, now: Long = System.currentTimeMillis()) {
        if (address.isBlank()) return
        val map = load()
        val key = keyOf(address)
        if (state == null || state.isIdentity) {
            if (map.remove(key) == null) return
        } else {
            map[key] = Entry(state, now)
            // Over the cap: the ones changed longest ago go.
            while (map.size > MAX) map.remove(map.minByOrNull { it.value.changedAt }?.key ?: break)
        }
        val all = JSONObject()
        map.forEach { (k, e) -> all.put(k, TextSync.toJson(e.state).put("u", e.changedAt)) }
        try {
            write(all.toString())
        } catch (_: Exception) {
        }
    }

    /** The address itself, or its hash when it is very long (some addons pack their whole
     *  configuration into it): the map stays small. */
    private fun keyOf(address: String): String {
        if (address.length <= MAX_KEY_CHARS) return address
        val hash = MessageDigest.getInstance("SHA-256").digest(address.toByteArray(Charsets.UTF_8))
        return "#" + hash.joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val MAX = 200
        private const val MAX_KEY_CHARS = 300
        private const val PREFS = "harbor.subsync"
        private const val KEY = "map"
    }
}
