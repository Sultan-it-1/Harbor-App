package app.harbor.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Hosts the Harbor web UI (bundled from the Vite build) in a WebView and plays video
 * with a native ExoPlayer overlay, so Dolby/DTS audio that the WebView can't decode
 * still plays with sound.
 *
 * JS <-> native contract (see src/lib/android.ts):
 *   window.HarborAndroid.fetch(id, requestJson)   -> window.__harborNativeFetchDone(id, responseJson)
 *   window.HarborAndroid.play(sourceJson) / command(json) / stop()
 *                                                 -> window.__harborNativeEvent(eventJson)
 *   window.HarborAndroid.saveFile(id, name, mime, base64) -> window.__harborFileSaved(id, "1"|"0")
 *   native back button                            -> window.__harborAndroidBack(): boolean
 *   window.HarborAndroid.homeSet(modelJson) / screenShow(page, bottom, width)
 *                                                 -> window.__harborNativeHome(actionJson)  (NativeScreens)
 *
 * Bridge security: the Java object is injected as `__harborNative` into every frame (Android
 * can't limit addJavascriptInterface to one frame), and each method wants a per-launch secret
 * as its first argument. Only the app's own page learns it: WebAssets puts [bridgeScript] at
 * the top of index.html, which wraps the raw object as `window.HarborAndroid` and adds the
 * secret to every call. Third-party frames (addon setup pages, embeds) get nothing done.
 */
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var player: NativePlayer
    private lateinit var fetcher: NativeFetch
    private lateinit var updater: AppUpdater
    private lateinit var downloads: Downloads
    private lateinit var images: ImageCache
    private lateinit var nativeImages: NativeImages
    private lateinit var screens: NativeScreens
    private lateinit var assets: WebAssets
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var fullscreen = false
    private var lastBackAt = 0L
    private var pageLoaded = false
    private var pendingOpenDownloads = false
    private var imeVisible = false
    private var webPaused = false
    /** A stremio:// link that opened the app: kept until the page asks for it (takeLink). */
    @Volatile private var pendingLink: String? = null
    private val bridgeToken: String = newToken()

    // <input type=file> (restore a backup, upload an avatar / theme / subtitle ...)
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cb = fileChooserCallback
        fileChooserCallback = null
        // Several files (bug report attachments, theme screenshots) come back in ClipData;
        // parseResult only reads the single data URI.
        val clip = r.data?.clipData
        val uris = if (r.resultCode == RESULT_OK && clip != null && clip.itemCount > 0) {
            Array(clip.itemCount) { clip.getItemAt(it).uri }.filterNotNull().toTypedArray()
        } else {
            WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data)
        }
        cb?.onReceiveValue(uris)
    }

    // Files the page saves (backup export, images): the user picks where they go.
    private class PendingSave(val id: String, val bytes: ByteArray)
    private var pendingSave: PendingSave? = null
    private val saveDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val job = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        val uri = r.data?.data
        var ok = false
        if (r.resultCode == RESULT_OK && uri != null) {
            ok = try {
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(job.bytes) } != null
            } catch (e: Exception) {
                Log.w(TAG, "saving the file failed", e)
                false
            }
        }
        sendToJs("__harborFileSaved", job.id, if (ok) "1" else "0")
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Draw edge-to-edge on every Android version (15+ forces it anyway) and pad the
        // content ourselves, so the UI never slides under the status bar / notch / nav bar.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            if (fullscreen) {
                v.setPadding(0, 0, 0, 0)
            } else {
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            }
            // The page hides its bottom tab bar while the keyboard is up (it would sit on top of it).
            val imeNow = insets.isVisible(WindowInsetsCompat.Type.ime())
            if (imeNow != imeVisible) {
                imeVisible = imeNow
                if (pageLoaded) {
                    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('harbor:ime',{detail:$imeNow}))", null)
                }
            }
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        RefreshRate.apply(this)

        fetcher = NativeFetch { id, result -> sendToJs("__harborNativeFetchDone", id, result) }
        updater = AppUpdater(this) { json -> sendToJs("__harborUpdateEvent", json) }
        downloads = Downloads.get(this)
        DownloadService.createChannel(this)
        pendingOpenDownloads = intent?.getBooleanExtra(EXTRA_OPEN_DOWNLOADS, false) == true
        // Only a fresh launch: a recreated activity would otherwise replay the link that started it.
        if (savedInstanceState == null) captureLink(intent)

        assets = WebAssets(this, bridgeScript())
        val shortSide = minOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        images = ImageCache(this, shortSide)
        nativeImages = NativeImages(images.store, shortSide)
        nativeImages.appAssets = applicationContext.assets
        webView = buildWebView()
        // A process kept alive by the download service may still have WebView timers paused from
        // an earlier activity (pauseTimers is process-wide): a new page must start with them on.
        webView.resumeTimers()
        root.addView(webView, 0, FrameLayout.LayoutParams(MATCH, MATCH))
        // The native screens (Home, Discover, Movies, Shows, Library) sit over the page and under
        // the player (added next); hidden until the page asks for one.
        screens = NativeScreens(this, nativeImages) { action -> sendToJs("__harborNativeHome", action.toString()) }
        root.addView(screens.root, 1, FrameLayout.LayoutParams(MATCH, MATCH))
        player = NativePlayer(this, root, downloads) { event -> sendToJs("__harborNativeEvent", event) }
        val ua = webView.settings.userAgentString
        fetcher.userAgent = ua
        player.userAgent = ua
        downloads.userAgent = ua
        images.userAgent = ua
        nativeImages.userAgent = ua

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onBack()
        })
        addOnPictureInPictureModeChangedListener { info -> player.onPictureInPictureChanged(info.isInPictureInPictureMode) }

        // Always a fresh page: the app restores its own state from storage. (Restoring the
        // WebView's saved state after Android killed the process could leave a black page, and a
        // large saved state can overflow the activity's state bundle.)
        webView.loadUrl(START_URL)
        warnIfWebViewTooOld()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val wv = WebView(this).apply {
            setBackgroundColor(0xFF000000.toInt())
            overScrollMode = View.OVER_SCROLL_NEVER
            isHorizontalScrollBarEnabled = false
            isVerticalScrollBarEnabled = false
        }
        val ws = wv.settings
        ws.javaScriptEnabled = true
        ws.domStorageEnabled = true
        ws.databaseEnabled = true
        ws.mediaPlaybackRequiresUserGesture = false
        // Streams, logos and addon manifests are often plain http on the user's own network.
        ws.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        ws.allowFileAccess = false
        ws.allowContentAccess = false
        ws.loadWithOverviewMode = true
        ws.useWideViewPort = true
        ws.setSupportMultipleWindows(false)
        // App-like: no pinch zoom. Text follows the phone's font size, but only part of the way
        // (the UI has its own scale setting and fixed-size controls).
        ws.setSupportZoom(false)
        ws.builtInZoomControls = false
        ws.displayZoomControls = false
        ws.textZoom = textZoomFor(resources.configuration)
        ws.userAgentString = ws.userAgentString + " HarborAndroid/" + BuildConfigInfo.versionName(this)

        // The page keeps running when Harbor is in the background (season downloads and
        // subtitle searches happen there), so its renderer keeps the app's priority.
        if (Build.VERSION.SDK_INT >= 26) wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        wv.addJavascriptInterface(JsApi(), BRIDGE_NAME)
        wv.webViewClient = object : WebViewClient() {
            // The app's own files, then posters/backdrops from the phone's image cache.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.intercept(request) ?: images.intercept(request)

            override fun onPageFinished(view: WebView, url: String?) {
                pageLoaded = true
                if (pendingOpenDownloads) openDownloadsPage()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == WebAssets.HOST) return false
                openExternally(uri)
                return true
            }

            // The page's renderer crashed, or Android killed it to free memory. Returning false
            // here takes the whole app down (and the download service with it): build a fresh
            // WebView and load the page again instead.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "WebView renderer gone (crashed=${Build.VERSION.SDK_INT >= 26 && detail.didCrash()}), reloading")
                if (view === webView) root.post { replaceWebView() }
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                hideCustomView()
                customView = view
                customViewCallback = callback
                root.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
                setFullscreenMode(true)
            }

            override fun onHideCustomView() = hideCustomView()

            // window.confirm() / alert() ("Remove playlist?"…) are shown by the host app. Without
            // these the WebView answers "no" to every confirm, so Delete buttons did nothing.
            override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                showJsDialog(message, result, withCancel = true)
                return true
            }

            override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                showJsDialog(message, result, withCancel = false)
                return true
            }

            // <input type="file">: the system file picker (Android has no browser chooser here).
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    val intent = params.createIntent()
                    if (intent.type.isNullOrBlank() || intent.type?.contains('/') != true) intent.type = "*/*"
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    fileChooser.launch(intent)
                    true
                } catch (e: Exception) {
                    Log.w(TAG, "no file picker", e)
                    fileChooserCallback = null
                    false
                }
            }
        }
        return wv
    }

    /** A dead renderer's WebView can't be used again: swap in a new one under the player. */
    private fun replaceWebView() {
        if (isFinishing || isDestroyed) return
        val old = webView
        pageLoaded = false
        val idx = root.indexOfChild(old).coerceAtLeast(0)
        root.removeView(old)
        try {
            old.destroy()
        } catch (_: Exception) {
        }
        screens.show(null, 0)
        webView = buildWebView()
        webView.resumeTimers()
        webPaused = false
        // The new page says again whether it shows a secret; until then nothing is hidden.
        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        root.addView(webView, idx, FrameLayout.LayoutParams(MATCH, MATCH))
        webView.loadUrl(START_URL)
    }

    /** Runs before the page's own scripts in index.html (see the class comment). */
    private fun bridgeScript(): String =
        "(function(){var raw=window.$BRIDGE_NAME;if(!raw)return;var tok=${JSONObject.quote(bridgeToken)};" +
            "var api=new Proxy({},{get:function(_,k){var f=raw[k];return typeof f==='function'?function(){" +
            "return f.apply(raw,[tok].concat(Array.prototype.slice.call(arguments)))}:undefined}," +
            "has:function(_,k){return typeof raw[k]==='function'}});" +
            "Object.defineProperty(window,'HarborAndroid',{value:api,writable:false,configurable:false});})();"

    private fun textZoomFor(c: Configuration): Int = (100 + (c.fontScale - 1f) * 50f).toInt().coerceIn(90, 115)

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Language, font size and dark mode changes no longer recreate the activity (manifest
        // configChanges), so the page and a playing video survive them.
        webView.settings.textZoom = textZoomFor(newConfig)
        if (player.isShowing) root.post { player.applyChromeInsets() }
    }

    /**
     * D-pad / controller (handhelds, TV boxes): while a native screen is up, arrow keys move
     * through its rows instead of going to the page hidden underneath.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.keyCode in DPAD_KEYS &&
            ::screens.isInitialized && screens.isShowing && !screens.root.hasFocus() &&
            !(::player.isInitialized && player.isShowing) && screens.takeFocus()
        ) {
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** Home pressed while a video plays: continue in picture-in-picture. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        player.onUserLeaveHint()
    }

    /** Harbor's UI needs a modern WebView (CSS colour functions); an old one shows empty pages. */
    private fun warnIfWebViewTooOld() {
        if (Build.VERSION.SDK_INT < 26) return
        val pkg = try { WebView.getCurrentWebViewPackage() } catch (_: Exception) { null } ?: return
        val major = pkg.versionName?.substringBefore('.')?.toIntOrNull() ?: return
        if (major >= MIN_WEBVIEW_MAJOR) return
        val ar = resources.configuration.locales[0]?.language == "ar"
        try {
            AlertDialog.Builder(this)
                .setTitle(if (ar) "حدّث Android System WebView" else "Update Android System WebView")
                .setMessage(
                    if (ar) "يحتاج Harbor إصدار $MIN_WEBVIEW_MAJOR أو أحدث من WebView، وجوالك فيه $major. حدّثه من Google Play وإلا قد تظهر الصفحات فاضية."
                    else "Harbor needs Android System WebView $MIN_WEBVIEW_MAJOR or newer (this phone has $major). Update it from Google Play, otherwise pages may show up empty.",
                )
                .setPositiveButton("Google Play") { _, _ -> openExternally(Uri.parse("market://details?id=${pkg.packageName}")) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        } catch (_: Exception) {
        }
    }

    private fun onBack() {
        when {
            player.isShowing -> if (!player.handleBack()) player.close()
            customView != null -> hideCustomView()
            else -> webView.evaluateJavascript(
                "(function(){try{return !!(window.__harborAndroidBack&&window.__harborAndroidBack())}catch(e){return false}})()",
            ) { handled ->
                if (handled != "true") {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        // On Home: a single back swipe shouldn't drop you out of the app.
                        val now = System.currentTimeMillis()
                        if (now - lastBackAt < 2000) {
                            moveTaskToBack(true)
                        } else {
                            lastBackAt = now
                            val ar = resources.configuration.locales[0]?.language == "ar"
                            Toast.makeText(this, if (ar) "اسحب رجوع مرة ثانية للخروج" else "Swipe back again to leave", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            }
        }
    }

    /** Tapped the downloads notification: show the Downloads page (unless a video is playing). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_DOWNLOADS, false)) {
            pendingOpenDownloads = true
            if (pageLoaded) openDownloadsPage()
        }
        captureLink(intent)
        if (pageLoaded && pendingLink != null) {
            webView.evaluateJavascript("window.__harborDeepLinkCheck&&window.__harborDeepLinkCheck()", null)
        }
    }

    /** stremio://… links (addon install buttons) sent to Harbor by Android. */
    private fun captureLink(i: Intent?) {
        val data = i?.data ?: return
        if (i.action == Intent.ACTION_VIEW && data.scheme.equals("stremio", ignoreCase = true)) {
            pendingLink = data.toString()
        }
    }

    private fun openDownloadsPage() {
        pendingOpenDownloads = false
        if (player.isShowing) return
        // The app sets window.harbor once it has mounted; wait for it on a cold start.
        webView.evaluateJavascript(
            "(function t(n){if(window.harbor&&window.harbor.navigate){window.harbor.navigate('downloads')}else if(n>0){setTimeout(function(){t(n-1)},250)}})(60)",
            null,
        )
    }

    /** Asked once, on the first download: lets the progress notification show (Android 13+). */
    private fun askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("harbor.app", MODE_PRIVATE)
        if (prefs.getBoolean("askedNotifications", false)) return
        prefs.edit().putBoolean("askedNotifications", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
    }

    private fun ignoringBatteryOptimizations(): Boolean =
        (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    /** System dialog: "Let Harbor always run in the background?" (falls back to the settings list). */
    @SuppressLint("BatteryLife")
    private fun requestBackgroundRun() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (_: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {
            }
        }
    }

    /** A page dialog (confirm / alert) as a native one. The result must always be answered. */
    private fun showJsDialog(message: String?, result: JsResult, withCancel: Boolean) {
        if (isFinishing || isDestroyed) {
            result.cancel()
            return
        }
        try {
            val b = AlertDialog.Builder(this)
                .setMessage(message ?: "")
                .setCancelable(true)
                .setOnCancelListener { result.cancel() }
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
            if (withCancel) b.setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
            b.show()
        } catch (_: Exception) {
            result.cancel()
        }
    }

    private fun hideCustomView() {
        val v = customView ?: return
        root.removeView(v)
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        if (!player.isShowing) setFullscreenMode(false)
    }

    fun setFullscreenMode(on: Boolean) {
        val ctl = WindowInsetsControllerCompat(window, window.decorView)
        fullscreen = on
        if (on) {
            ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            ctl.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            ctl.show(WindowInsetsCompat.Type.systemBars())
        }
        ViewCompat.requestApplyInsets(root)
    }

    /**
     * Links the page can't show itself (other sites, external players, stremio:// installs).
     * intent: links come from addon data, so they get what a browser allows: a VIEW of a public,
     * browsable activity, without an explicit component, selector or URI grants.
     */
    private fun openExternally(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: return
        if (scheme in BLOCKED_SCHEMES) return
        try {
            val intent = if (scheme == "intent") {
                Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                    flags = flags and URI_GRANT_FLAGS.inv()
                }
            } else {
                Intent(Intent.ACTION_VIEW, uri)
            }
            if (intent.action != Intent.ACTION_VIEW) return
            if (intent.data?.scheme?.lowercase() in BLOCKED_SCHEMES) return
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                startActivity(intent)
            } catch (e: Exception) {
                // intent: links may name a web page to use when no app takes them.
                val fallback = intent.getStringExtra("browser_fallback_url")?.let(Uri::parse)
                if (fallback != null && fallback.scheme?.lowercase() in setOf("http", "https")) {
                    startActivity(Intent(Intent.ACTION_VIEW, fallback).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
        } catch (_: Exception) {
            // No app can handle it (e.g. vlc:// without VLC installed) — ignore.
        }
    }

    /** Calls window[fn](...args) in the page; each arg is passed as a JS string literal. */
    private fun sendToJs(fn: String, vararg args: String) {
        val js = buildString {
            append("window.").append(fn).append("&&window.").append(fn).append("(")
            args.forEachIndexed { i, a ->
                if (i > 0) append(",")
                append(JSONObject.quote(a))
            }
            append(")")
        }
        webView.post { webView.evaluateJavascript(js, null) }
    }

    override fun onResume() {
        super.onResume()
        if (!player.isShowing) RefreshRate.apply(this)
        downloads.kick()
        images.trimSoon()
        DownloadService.clearPausedNotice(this)
        // e.g. back from the battery dialog: let the page re-check what it shows.
        if (pageLoaded) webView.evaluateJavascript("window.dispatchEvent(new Event('harbor:resume'))", null)
    }

    override fun onPause() {
        super.onPause()
        player.onHostPause()
    }

    override fun onStop() {
        super.onStop()
        // Out of sight (incl. the picture-in-picture window being closed): pause the video.
        player.onHostStop()
        // Nothing for the page to do in the background (no season queue or subtitle search
        // running there): stop its timers and rendering until the app is back. Downloads carry on
        // in the service either way.
        if (!player.isShowing && System.currentTimeMillis() > DownloadService.keepAliveUntil) {
            webView.onPause()
            webView.pauseTimers()
            webPaused = true
        }
    }

    override fun onStart() {
        super.onStart()
        if (webPaused) {
            webView.resumeTimers()
            webView.onResume()
            webPaused = false
        }
    }

    /** Android is short of memory: the page drops pages it keeps mounted and its caches. */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        nativeImages.trim(severe = level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE || (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN && !screens.isShowing))
        if (pageLoaded) webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('harbor:trim-memory',{detail:$level}))", null)
    }

    override fun onDestroy() {
        // The page (and any season queue / subtitle search in it) goes away with the activity;
        // system downloads carry on and DownloadService stays up while they run.
        DownloadService.keepAlive(this, false)
        player.stop(notify = false)
        fetcher.shutdown()
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        // pauseTimers() is process-wide: undo it, or a new activity in this process (the download
        // service can keep it alive) would load its page with timers stopped.
        if (webPaused) {
            webView.resumeTimers()
            webPaused = false
        }
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    /**
     * What the page can call. Every method takes the bridge token first (added by the wrapper in
     * [bridgeScript]); calls without it do nothing. A failure inside a call never takes the app
     * down: it is logged, and the page gets a neutral answer (or a player error event).
     */
    inner class JsApi {
        private fun ok(t: String?) = t != null && t == bridgeToken

        private inline fun <T> guard(name: String, fallback: T, block: () -> T): T = try {
            block()
        } catch (e: Throwable) {
            Log.e(TAG, "bridge call $name failed", e)
            fallback
        }

        private fun onUi(name: String, block: () -> Unit) = runOnUiThread {
            try {
                block()
            } catch (e: Throwable) {
                Log.e(TAG, "bridge call $name failed", e)
                if (name == "play") {
                    sendToJs(
                        "__harborNativeEvent",
                        JSONObject().put("type", "error").put("code", "source").put("message", e.javaClass.simpleName + ": " + (e.message ?: "")).toString(),
                    )
                }
            }
        }

        @JavascriptInterface
        fun version(t: String): String = if (ok(t)) BuildConfigInfo.versionName(this@MainActivity) else ""

        /** The build number (Settings > About). */
        @JavascriptInterface
        fun build(t: String): String = if (ok(t)) BuildConfigInfo.versionCode(this@MainActivity).toString() else ""

        @JavascriptInterface
        fun fetch(t: String, id: String, requestJson: String) {
            if (ok(t)) guard("fetch", Unit) { fetcher.enqueue(id, requestJson) }
        }

        /** In-app updates (AppUpdater): may Harbor open Android's installer? */
        @JavascriptInterface
        fun updateCanInstall(t: String): Boolean = ok(t) && guard("updateCanInstall", false) { updater.canInstall() }

        /** Opens Android's "Install unknown apps" switch for Harbor. */
        @JavascriptInterface
        fun updateAllowInstall(t: String) {
            if (ok(t)) onUi("updateAllowInstall") { updater.openInstallPermission() }
        }

        /** Downloads the release APK at [url], checks its SHA-256, and opens the installer. */
        @JavascriptInterface
        fun updateDownload(t: String, url: String, sha256: String) {
            if (ok(t)) guard("updateDownload", Unit) { updater.download(url, sha256) }
        }

        @JavascriptInterface
        fun updateCancel(t: String) {
            if (ok(t)) guard("updateCancel", Unit) { updater.cancel() }
        }

        @JavascriptInterface
        fun fetchCancel(t: String, id: String) {
            if (ok(t)) guard("fetchCancel", Unit) { fetcher.cancel(id) }
        }

        @JavascriptInterface
        fun play(t: String, sourceJson: String) {
            if (ok(t)) onUi("play") { player.play(sourceJson) }
        }

        @JavascriptInterface
        fun command(t: String, json: String) {
            if (ok(t)) onUi("command") { player.command(json) }
        }

        @JavascriptInterface
        fun stop(t: String) {
            if (ok(t)) onUi("stop") { player.stop(notify = false) }
        }

        @JavascriptInterface
        fun openExternal(t: String, url: String) {
            if (ok(t)) onUi("openExternal") { openExternally(Uri.parse(url)) }
        }

        /** Keeps screenshots and the Recents preview out of sensitive screens (PIN, sign-in). */
        @JavascriptInterface
        fun setSecure(t: String, on: Boolean) {
            if (!ok(t)) return
            onUi("setSecure") {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }

        /**
         * Saves bytes made by the page (backup export, an image) to a file the user picks with the
         * system "save as" screen. Answers through window.__harborFileSaved(id, "1"|"0").
         */
        @JavascriptInterface
        fun saveFile(t: String, id: String, name: String, mime: String, base64: String): Boolean {
            if (!ok(t)) return false
            val bytes = try {
                Base64.decode(base64, Base64.DEFAULT)
            } catch (_: Exception) {
                return false
            }
            onUi("saveFile") {
                pendingSave?.let { sendToJs("__harborFileSaved", it.id, "0") }
                pendingSave = PendingSave(id, bytes)
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mime.ifBlank { "application/octet-stream" }
                    putExtra(Intent.EXTRA_TITLE, name.ifBlank { "harbor" })
                }
                try {
                    saveDocument.launch(intent)
                } catch (e: Exception) {
                    Log.w(TAG, "no save screen", e)
                    pendingSave = null
                    sendToJs("__harborFileSaved", id, "0")
                }
            }
            return true
        }

        // ---- downloads (see Downloads.kt) ----
        @JavascriptInterface
        fun dlStart(t: String, json: String): String {
            if (!ok(t)) return REFUSED
            runOnUiThread { askNotificationsOnce() }
            return guard("dlStart", REFUSED) { downloads.start(json) }
        }

        /** The pending stremio:// link, once ("" when there is none). */
        @JavascriptInterface
        fun takeLink(t: String): String {
            if (!ok(t)) return ""
            val l = pendingLink
            pendingLink = null
            return l ?: ""
        }

        /** The page has background work (season queue, subtitle searches) — keep Harbor running. */
        @JavascriptInterface
        fun dlKeepAlive(t: String, on: Boolean) {
            if (ok(t)) guard("dlKeepAlive", Unit) { DownloadService.keepAlive(this@MainActivity, on) }
        }

        @JavascriptInterface
        fun bgAllowed(t: String): Boolean = ok(t) && guard("bgAllowed", false) { ignoringBatteryOptimizations() }

        @JavascriptInterface
        fun bgRequest(t: String) {
            if (ok(t)) onUi("bgRequest") { requestBackgroundRun() }
        }

        @JavascriptInterface
        fun dlStatus(t: String): String = if (ok(t)) guard("dlStatus", "{}") { downloads.status() } else "{}"

        @JavascriptInterface
        fun dlDelete(t: String, id: String): Boolean = ok(t) && guard("dlDelete", false) { downloads.delete(id) }

        @JavascriptInterface
        fun dlPause(t: String, id: String): Boolean = ok(t) && guard("dlPause", false) { downloads.pause(id) }

        /** Resume a paused download, or retry a failed one from where it got to. */
        @JavascriptInterface
        fun dlResume(t: String, id: String): Boolean = ok(t) && guard("dlResume", false) { downloads.resume(id) }

        @JavascriptInterface
        fun dlAddSubs(t: String, id: String, json: String): Boolean = ok(t) && guard("dlAddSubs", false) { downloads.addSubtitles(id, json) }

        @JavascriptInterface
        fun dlFiles(t: String, id: String): String = if (ok(t)) guard("dlFiles", "{}") { downloads.files(id) } else "{}"

        @JavascriptInterface
        fun dlStorage(t: String): String = if (ok(t)) guard("dlStorage", "{}") { downloads.storage() } else "{}"

        /** A fresh link for an expired download; keeps what was already downloaded. */
        @JavascriptInterface
        fun dlRelink(t: String, id: String, url: String, headersJson: String): Boolean =
            ok(t) && guard("dlRelink", false) { downloads.relink(id, url, headersJson) }

        /** Downloads only on Wi-Fi (default) or also on mobile data. */
        @JavascriptInterface
        fun dlSetWifiOnly(t: String, on: Boolean) {
            if (ok(t)) guard("dlSetWifiOnly", Unit) { downloads.wifiOnly = on }
        }

        @JavascriptInterface
        fun dlWifiOnly(t: String): Boolean = ok(t) && guard("dlWifiOnly", true) { downloads.wifiOnly }

        // ---- saved images (ImageStore; Settings > Storage) ----
        /** {"used":bytes,"limit":bytes,"free":bytes}: what the saved images take, their limit
         *  today (it follows the free space) and the phone's free space. */
        @JavascriptInterface
        fun imageCache(t: String): String = if (ok(t)) guard("imageCache", "{}") { imageCacheJson() } else "{}"

        /** Empties the saved images and the WebView's own cache; answers like [imageCache]. */
        @JavascriptInterface
        fun imageCacheClear(t: String): String {
            if (!ok(t)) return "{}"
            return guard("imageCacheClear", "{}") {
                images.store.clear()
                onUi("clearCache") { webView.clearCache(true) }
                imageCacheJson()
            }
        }

        private fun imageCacheJson(): String {
            val s = images.store
            return JSONObject().put("used", s.usedBytes()).put("limit", s.limitBytes()).put("free", s.freeBytes()).toString()
        }

        // ---- native screens (see NativeScreens.kt / NativeHome.kt) ----
        /** What a native screen shows (HomeModel JSON, its "page" says which screen). */
        @JavascriptInterface
        fun homeSet(t: String, json: String) {
            if (ok(t)) onUi("homeSet") { screens.setModel(json) }
        }

        /**
         * Which native screen is on screen ("" = none: the page shows itself). [bottomCss] is the
         * page's tab bar height and [cssWidth] the page's width, both in CSS pixels (to turn them
         * into screen ones).
         */
        @JavascriptInterface
        fun screenShow(t: String, page: String, bottomCss: Double, cssWidth: Double) {
            if (!ok(t)) return
            onUi("screenShow") {
                val scale = if (cssWidth > 0 && webView.width > 0) webView.width / cssWidth else resources.displayMetrics.density.toDouble()
                val hadFocus = screens.root.hasFocus()
                screens.show(page, (bottomCss * scale).toInt())
                if (!screens.isShowing && hadFocus) webView.requestFocus()
            }
        }
    }

    companion object {
        private const val TAG = "Harbor"
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val EXTRA_OPEN_DOWNLOADS = "app.harbor.android.OPEN_DOWNLOADS"
        private const val START_URL = "https://${WebAssets.HOST}/index.html"
        /** The raw bridge object's name; the page only ever uses the wrapped window.HarborAndroid. */
        private const val BRIDGE_NAME = "__harborNative"
        private const val MIN_WEBVIEW_MAJOR = 111
        private val DPAD_KEYS = setOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
        )
        private const val REFUSED = "{\"ok\":false,\"error\":\"refused\"}"
        private val BLOCKED_SCHEMES = setOf("file", "content", "javascript", "data", "about", "blob", "android-app")
        private const val URI_GRANT_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION

        private fun newToken(): String {
            val b = ByteArray(24)
            SecureRandom().nextBytes(b)
            return b.joinToString("") { "%02x".format(it) }
        }
    }
}

object BuildConfigInfo {
    fun versionName(activity: ComponentActivity): String = try {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "0"
    } catch (_: Exception) {
        "0"
    }

    /** The CI build number (the "-88" in a release named android-v0.9.36-88). */
    @Suppress("DEPRECATION")
    fun versionCode(activity: ComponentActivity): Long = try {
        val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    } catch (_: Exception) {
        0L
    }
}
