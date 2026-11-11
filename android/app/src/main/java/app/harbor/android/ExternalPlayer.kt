package app.harbor.android

import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/** "Open in another player": hands the stream that is playing to a video app the viewer chooses. */
object ExternalPlayer {
    /**
     * Only streams from the web. A download is a file in the app's own storage, which another app
     * can't read unless it is shared through a FileProvider, and the app has none.
     */
    fun canOpen(url: String?): Boolean {
        val u = url?.trim()?.lowercase() ?: return false
        return u.startsWith("http://") || u.startsWith("https://")
    }

    /**
     * The stream's request headers the way MX Player, VLC and others read them from the "headers"
     * extra: one array, each name followed by its value. Empty when the stream needs none.
     */
    fun headerExtras(headers: JSONObject?): Array<String> {
        if (headers == null) return emptyArray()
        val out = ArrayList<String>()
        headers.keys().forEach { name ->
            val value = headers.optString(name)
            if (name.isNotBlank() && value.isNotBlank()) {
                out.add(name)
                out.add(value)
            }
        }
        return out.toTypedArray()
    }

    /** The VIEW intent for the stream; the caller wraps it in a chooser. */
    fun viewIntent(url: String, title: String, headers: Array<String>): Intent {
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(url), "video/*")
        if (title.isNotBlank()) intent.putExtra("title", title)
        if (headers.isNotEmpty()) intent.putExtra("headers", headers)
        return intent
    }
}
