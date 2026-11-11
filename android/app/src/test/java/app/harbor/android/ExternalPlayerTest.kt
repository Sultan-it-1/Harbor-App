package app.harbor.android

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** "Open in another player": which streams can be handed over, and their headers. */
class ExternalPlayerTest {
    @Test
    fun onlyWebStreamsCanBeHandedOver() {
        assertTrue(ExternalPlayer.canOpen("https://cdn.example/film.mkv?token=1"))
        assertTrue(ExternalPlayer.canOpen("http://192.168.1.5:11470/abc/0"))
        assertTrue(ExternalPlayer.canOpen("  HTTPS://CDN.EXAMPLE/a.m3u8"))
        // A download lives in the app's own storage: another app can't read it.
        assertFalse(ExternalPlayer.canOpen("file:///data/user/0/app.harbor.android/files/dl/a.mkv"))
        assertFalse(ExternalPlayer.canOpen("/storage/emulated/0/a.mkv"))
        assertFalse(ExternalPlayer.canOpen("content://media/external/video/1"))
        assertFalse(ExternalPlayer.canOpen("magnet:?xt=urn:btih:abc"))
        assertFalse(ExternalPlayer.canOpen(""))
        assertFalse(ExternalPlayer.canOpen(null))
    }

    @Test
    fun headersGoAsNameThenValue() {
        val h = JSONObject().put("Referer", "https://site.example/").put("User-Agent", "Mozilla/5.0")
        val out = ExternalPlayer.headerExtras(h).toList().chunked(2).sortedBy { it[0] }.flatten().toTypedArray()
        assertArrayEquals(arrayOf("Referer", "https://site.example/", "User-Agent", "Mozilla/5.0"), out)
    }

    @Test
    fun noHeadersMeansNoExtraAndNoNote() {
        assertArrayEquals(emptyArray<String>(), ExternalPlayer.headerExtras(null))
        assertArrayEquals(emptyArray<String>(), ExternalPlayer.headerExtras(JSONObject()))
        // A header without a value is not a header.
        assertArrayEquals(emptyArray<String>(), ExternalPlayer.headerExtras(JSONObject().put("Referer", "")))
    }
}
