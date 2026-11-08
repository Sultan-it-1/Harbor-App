package app.harbor.android

import android.content.Context
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * The native screens (Home, Discover, Movies, Shows, Library): one [NativeHome] per page, each
 * keeping its own scroll position, and at most one on screen, the page the app shows on top.
 * Contract (src/views/native/native-screens.ts):
 *   page -> HarborAndroid.homeSet(modelJson)            a page's model (its "page" field says which)
 *   page -> HarborAndroid.screenShow(page, bottom, w)   which page is on screen ("" = none)
 */
class NativeScreens(private val ctx: Context, private val images: NativeImages, private val onAction: (JSONObject) -> Unit) {
    /** Added over the WebView. Holds nothing that takes touches while no screen is shown. */
    val root = FrameLayout(ctx)
    private val screens = LinkedHashMap<String, NativeHome>()
    private var current: String? = null

    val isShowing: Boolean get() = screens[current]?.isShowing == true

    private fun screen(page: String): NativeHome = screens.getOrPut(page) {
        NativeHome(ctx, images, page, onAction).also {
            root.addView(it.root, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            // Fully in: the screens it replaced (waiting under it) go.
            it.onRevealed = { for ((p, s) in screens) if (p != current) s.dropLinger() }
        }
    }

    fun setModel(json: String) {
        val page = try {
            JSONObject(json).optString("page", "home").ifBlank { "home" }
        } catch (e: Exception) {
            Log.e("HarborScreens", "model rejected", e)
            return
        }
        screen(page).setModel(json)
    }

    /** [page] on screen (null or "" = none), leaving [bottomPx] for the page's tab bar. */
    fun show(page: String?, bottomPx: Int) {
        val want = page?.takeIf { it.isNotBlank() }
        // The new one first (it comes in on top), then the others leave: while it fades in, the
        // one it replaces stays under it instead of the page's dark background flashing between.
        if (want != null) screen(want).show(true, bottomPx)
        for ((p, s) in screens) if (p != want) s.show(false, bottomPx, linger = want != null)
        current = want
    }

    fun takeFocus(): Boolean = screens[current]?.takeFocus() == true
}
