package app.harbor.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Future

/** An ImageView that remembers which picture it is waiting for (see [NativeImages.load]). */
class NetImage(context: Context) : ImageView(context) {
    internal var want: String? = null
    internal var job: Future<*>? = null
    /** Asks for the picture it is waiting for again (set while it has none yet). */
    internal var again: (() -> Unit)? = null
}

/**
 * A native screen's outermost view. While it isn't [live] (stepped aside, another screen in
 * front) its pictures still to come wait instead of taking turns from the screen on show; they
 * are asked for again when it comes back ([NativeImages.resume]).
 */
class ScreenRoot(context: Context) : android.widget.FrameLayout(context) {
    @Volatile var live = true
}

/**
 * Pictures for the native screens (NativeHome). They come from the same on-phone cache the
 * WebView uses (ImageStore, so a poster seen once in either shows at once in the other), are
 * decoded at the size they are shown (a poster is a few hundred pixels, not the 2000px file) and
 * kept in memory while there is room.
 */
class NativeImages(private val store: ImageStore, private val screenShortSidePx: Int) {
    @Volatile var userAgent: String = "HarborAndroid"
    /** The app's own files (the web build in assets/www): pictures the page ships with (format
     *  badges, addon logos) are read from there by their https://appassets… address. */
    @Volatile var appAssets: android.content.res.AssetManager? = null

    private val main = Handler(Looper.getMainLooper())
    /** Pictures from the network: newest first (what's on screen now, not what scrolled past). */
    private val net = pool("harbor-native-img", 5)
    /** The app's own pictures and ones carried in their address: never stuck behind the network. */
    private val local = pool("harbor-native-img-local", 2)
    private val memory = object : LruCache<String, Bitmap>(cacheBytes()) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    /** Addresses that failed lately (when): the next candidate is tried straight away. Tried
     *  again after two minutes (a network that was down at the start doesn't leave them blank). */
    private val failed = ConcurrentHashMap<String, Long>()

    private fun recentlyFailed(url: String): Boolean {
        val at = failed[url] ?: return false
        if (System.currentTimeMillis() - at < 120_000L) return true
        failed.remove(url)
        return false
    }
    /** Hosts that timed out or couldn't be reached lately (when): their pictures aren't waited for
     *  for a minute (the network coming back after that gets them again). */
    private val deadHosts = ConcurrentHashMap<String, Long>()

    private fun hostDown(url: String): Boolean {
        val h = host(url) ?: return false
        val at = deadHosts[h] ?: return false
        if (System.currentTimeMillis() - at < 60_000L) return true
        deadHosts.remove(h)
        return false
    }
    /**
     * Pictures being fetched, and the views waiting for each (main thread only). A view asking
     * for one already on its way waits for it instead of fetching it again: a page that redraws
     * its cards (new views each time) no longer piles up copies of the same downloads, which
     * kept every other picture in the app waiting.
     */
    private val inflight = HashMap<String, MutableList<Waiter>>()

    private class Waiter(val view: NetImage, val keep: Boolean, val onResult: ((Boolean) -> Unit)?)

    private fun pool(name: String, threads: Int): java.util.concurrent.ThreadPoolExecutor =
        java.util.concurrent.ThreadPoolExecutor(
            threads,
            threads,
            30L,
            java.util.concurrent.TimeUnit.SECONDS,
            // A stack: the most recent request goes first.
            object : java.util.concurrent.LinkedBlockingDeque<Runnable>() {
                override fun offer(e: Runnable): Boolean = offerFirst(e)
            },
        ) { r ->
            Thread(r, name).apply {
                isDaemon = true
                priority = Thread.NORM_PRIORITY - 1
            }
        }.apply { allowCoreThreadTimeOut(true) }

    private fun host(url: String): String? = try {
        java.net.URI(url).host
    } catch (_: Exception) {
        null
    }

    private fun isLocal(url: String) = url.startsWith("data:") || url.startsWith(APP_ORIGIN)

    /** [view] is on a screen that is showing (or not on a screen at all, e.g. made ahead of time). */
    private fun onLiveScreen(view: android.view.View): Boolean {
        var p = view.parent
        while (p != null) {
            if (p is ScreenRoot) return p.live
            p = p.parent
        }
        return true
    }

    /** [root]'s pictures are gone for good (a card redrawn with new views): stop waiting for them. */
    fun release(root: android.view.View) {
        val stack = ArrayDeque<android.view.View>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val v = stack.removeLast()
            if (v is NetImage) {
                v.want = null
                v.again = null
            } else if (v is android.view.ViewGroup) {
                for (i in 0 until v.childCount) stack.add(v.getChildAt(i))
            }
        }
    }

    /** Some picture shown in [root] is still on its way (a screen about to fade in waits a moment). */
    fun pendingIn(root: android.view.View): Boolean {
        val stack = ArrayDeque<android.view.View>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val v = stack.removeLast()
            if (v.visibility != android.view.View.VISIBLE) continue
            if (v is NetImage) {
                if (v.again != null && v.drawable == null) return true
            } else if (v is android.view.ViewGroup) {
                for (i in 0 until v.childCount) stack.add(v.getChildAt(i))
            }
        }
        return false
    }

    /** A screen came back: its pictures that never arrived are asked for again. */
    fun resume(root: android.view.ViewGroup) {
        val stack = ArrayDeque<android.view.View>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val v = stack.removeLast()
            if (v is NetImage) {
                if (v.drawable == null) v.again?.invoke()
            } else if (v is android.view.ViewGroup) {
                for (i in 0 until v.childCount) stack.add(v.getChildAt(i))
            }
        }
    }

    /**
     * Shows the first of [urls] that loads in [view], decoded for about [widthPx] x [heightPx].
     * A view that is bound to something else before the picture arrives never gets it.
     * [onResult] (main thread) says whether a picture is shown. [crop]: the view shows it
     * centre-cropped to [widthPx] x [heightPx] (a hero): its largest version is fetched and only
     * that middle part is decoded, at full sharpness. [keep]: the picture shown now stays until the
     * new one is ready (a hero whose picture is swapped for a better one doesn't go blank between).
     */
    fun load(view: NetImage, urls: List<String>, widthPx: Int, heightPx: Int, alpha: Boolean = false, crop: Boolean = false, keep: Boolean = false, onResult: ((Boolean) -> Unit)? = null) {
        val list = urls.filter {
            (it.startsWith("https://") || it.startsWith("http://") || it.startsWith("data:image/")) &&
                !recentlyFailed(it) &&
                (isLocal(it) || !hostDown(it))
        }.distinct()
        val w = widthPx.coerceAtLeast(1)
        val h = heightPx.coerceAtLeast(1)
        val sig = list.joinToString("|") + "@" + w + "x" + h + (if (crop) "c" else "")
        if (view.want == sig && view.drawable != null) {
            onResult?.invoke(true)
            return
        }
        view.job = null
        view.want = sig
        view.again = null
        if (list.isEmpty()) {
            view.setImageDrawable(null)
            onResult?.invoke(false)
            return
        }
        memory.get(memKey(list[0], w, h, crop))?.let {
            view.animate().cancel()
            view.alpha = 1f
            view.setImageBitmap(it)
            onResult?.invoke(true)
            return
        }
        if (!(keep && view.drawable != null)) view.setImageDrawable(null)
        view.again = { if (view.want == sig) load(view, urls, widthPx, heightPx, alpha, crop, keep, onResult) }
        val waiter = Waiter(view, keep, onResult)
        synchronized(inflight) {
            inflight[sig]?.let {
                it.add(waiter)
                return
            }
            inflight[sig] = mutableListOf(waiter)
        }
        val lane = if (list.all { isLocal(it) }) local else net
        lane.execute {
            // Nobody wants it any more (the card was redrawn or scrolled away), or only a screen
            // that stepped aside does: skip the work (that screen asks again when it's back).
            val wanted = synchronized(inflight) { inflight[sig]?.any { it.view.want == sig && onLiveScreen(it.view) } == true }
            var bmp: Bitmap? = null
            if (wanted) {
                for (u in list) {
                    val key = memKey(u, w, h, crop)
                    bmp = memory.get(key) ?: decode(u, w, h, alpha, crop)?.also { memory.put(key, it) }
                    if (bmp != null) break
                    failed[u] = System.currentTimeMillis()
                }
            }
            val result = bmp
            main.post {
                val waiting = synchronized(inflight) { inflight.remove(sig) } ?: return@post
                for (wt in waiting) {
                    val v = wt.view
                    if (v.want != sig) continue
                    if (!wanted) {
                        // Skipped while nobody on screen wanted it, wanted on screen since: ask
                        // once more (else its screen asks when it's back).
                        if (onLiveScreen(v)) load(v, urls, widthPx, heightPx, alpha, crop, wt.keep, wt.onResult)
                        continue
                    }
                    v.again = null
                    if (result != null) {
                        if (wt.keep && v.drawable != null) {
                            v.animate().cancel()
                            v.alpha = 1f
                            v.setImageBitmap(result)
                        } else {
                            v.alpha = 0f
                            v.setImageBitmap(result)
                            v.animate().alpha(1f).setDuration(180).start()
                        }
                    }
                    wt.onResult?.invoke(result != null)
                }
            }
        }
    }

    /** Forget what [view] was showing or waiting for (it scrolled away for good). */
    fun clear(view: NetImage) {
        view.job = null
        view.want = null
        view.setImageDrawable(null)
    }

    /** Android is short of memory: keep only what the screen shows right now. */
    fun trim(severe: Boolean) {
        if (severe) memory.evictAll() else memory.trimToSize(memory.maxSize() / 2)
    }

    private fun decode(url: String, w: Int, h: Int, alpha: Boolean, crop: Boolean = false): Bitmap? {
        val target = if (crop) ImageStore.heroSized(url) else ImageStore.phoneSized(url, screenShortSidePx)
        val headers = mapOf("User-Agent" to userAgent, "Accept" to "image/webp,image/png,image/jpeg,image/*;q=0.8")
        val bytes = try {
            if (url.startsWith("data:")) {
                // A picture the page drew itself (a service logo): carried in the address.
                android.util.Base64.decode(url.substringAfter(','), android.util.Base64.DEFAULT)
            } else if (url.startsWith(APP_ORIGIN)) {
                val path = url.removePrefix(APP_ORIGIN).substringBefore('?').substringBefore('#')
                if (path.isEmpty() || path.contains("..")) return null
                (appAssets ?: return null).open("www/$path").use { it.readBytes() }
            } else {
                val hit = store.cached(target)
                if (hit != null) {
                    if (hit.stale) store.recheck(target, hit.meta, headers)
                    hit.file.readBytes()
                } else {
                    store.download(target, headers).use { it.readBytes() }
                }
            }
        } catch (e: Exception) {
            // A host that doesn't answer (or can't be found) isn't waited for again this session.
            if (e is java.net.SocketTimeoutException || e is java.net.UnknownHostException || e is java.net.ConnectException) {
                host(url)?.let { deadHosts[it] = System.currentTimeMillis() }
            }
            return null
        }
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            if (crop) cropped(bytes, bounds.outWidth, bounds.outHeight, w, h)?.let { return it }
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= w && bounds.outHeight / (sample * 2) >= h) sample *= 2
            // Full colour: 16-bit (RGB_565) halved the memory but banded and softened the
            // pictures, most visibly the full-width hero.
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        } catch (_: OutOfMemoryError) {
            memory.evictAll()
            null
        } catch (_: Exception) {
            null
        }
    }

    /**
     * The middle of the picture that a centre-crop to [w] x [h] shows, decoded on its own (a 4K
     * backdrop's middle for a tall hero is ~1300 x 2160, not the whole 3840 x 2160), halved
     * while it stays at least as sharp as the screen.
     */
    private fun cropped(bytes: ByteArray, ow: Int, oh: Int, w: Int, h: Int): Bitmap? {
        val scale = maxOf(w.toFloat() / ow, h.toFloat() / oh)
        val rw = minOf(ow, Math.ceil(w / scale.toDouble()).toInt()).coerceAtLeast(1)
        val rh = minOf(oh, Math.ceil(h / scale.toDouble()).toInt()).coerceAtLeast(1)
        val left = (ow - rw) / 2
        val top = (oh - rh) / 2
        var sample = 1
        while (rw / (sample * 2) >= w && rh / (sample * 2) >= h) sample *= 2
        return try {
            @Suppress("DEPRECATION")
            val dec = BitmapRegionDecoder.newInstance(bytes, 0, bytes.size, false) ?: return null
            try {
                dec.decodeRegion(
                    Rect(left, top, left + rw, top + rh),
                    BitmapFactory.Options().apply {
                        inSampleSize = sample
                        inPreferredConfig = Bitmap.Config.ARGB_8888
                    },
                )
            } finally {
                dec.recycle()
            }
        } catch (_: OutOfMemoryError) {
            memory.evictAll()
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun memKey(url: String, w: Int, h: Int, crop: Boolean = false) = "$url@${w / 64}x${h / 64}${if (crop) "c" else ""}"

    companion object {
        private const val APP_ORIGIN = "https://${WebAssets.HOST}/"

        private fun cacheBytes(): Int {
            val max = Runtime.getRuntime().maxMemory()
            return (max / 6).coerceIn(16L * 1024 * 1024, 96L * 1024 * 1024).toInt()
        }
    }
}
