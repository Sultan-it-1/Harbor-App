package app.harbor.android

import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Rational
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.MediaSession
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.extractor.text.CuesWithTiming
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.DefaultTimeBar
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Full-screen ExoPlayer overlay on top of the WebView. Audio formats the phone can't
 * decode in hardware (AC3, E-AC3, DTS, TrueHD) go through the bundled FFmpeg decoder.
 * State is streamed to the web UI so resume points, Stremio sync and auto-next keep working.
 *
 * On top of Media3's controls it adds: gestures (double-tap seek, brightness/volume/seek
 * swipes, pinch, hold for double speed), a top bar (title, streams, subtitles, audio, aspect,
 * lock), a next-episode button, a skip button for intros, recaps and credits, and side panels for
 * streams (with "open in another player"), subtitles (embedded + addon, grouped by language, own
 * renderer with instant delay, and a sync panel that lines an addon subtitle up with the sound by
 * ear) and audio/speed (with the sleep timer).
 *
 * Subtitles saved with a download are listed on their own and are all that shows offline;
 * online, every addon subtitle shows too, each with a button that saves it with the download.
 */
@OptIn(UnstableApi::class)
class NativePlayer(
    private val activity: MainActivity,
    private val root: FrameLayout,
    private val downloads: Downloads,
    private val emit: (String) -> Unit,
) {
    var userAgent: String = "HarborAndroid"
    private var player: ExoPlayer? = null
    private var view: PlayerView? = null
    private var source: JSONObject? = null
    private val handler = Handler(Looper.getMainLooper())
    private val ticker = object : Runnable {
        override fun run() {
            sendState()
            val p = player ?: return
            updateSkip()
            if (sleep.endOfVideo && p.isPlaying && SleepTimer.nearEnd(p.currentPosition, knownDuration(p), p.playbackParameters.speed)) fireSleep()
            // A skip or the sleep timer above can restart this ticker from the player's listeners:
            // keep it to one run a second.
            handler.removeCallbacks(this)
            // Only while something moves: a paused video reports its state from the listeners.
            if (p.isPlaying || p.playbackState == Player.STATE_BUFFERING || reconnecting) handler.postDelayed(this, SleepTimer.CHECK_EVERY_MS)
        }
    }

    // ---- network recovery / media session -------------------------------------------------
    private var reconnecting = false
    private var reconnectSince = 0L
    private var reconnectAttempts = 0
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private val reconnect = Runnable { tryReconnect() }
    private var session: MediaSession? = null
    private var prefAudioLangs: List<String> = emptyList()

    // ---- what's playing --------------------------------------------------------------------
    private var contentKey = ""
    private var title = ""
    private var subtitleLine = ""
    private var hasNext = false
    /** Settings → "Show stream quality under the title"; streamQualityLabel is the stream's
     *  own label, shown until the player knows what it's actually decoding. */
    private var showQuality = false
    private var streamQualityLabel = ""
    private var resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
    private var locked = false

    // ---- subtitles -------------------------------------------------------------------------
    /** A subtitle the user can pick; downloaded only when picked. For one saved with a
     *  download, url is the local file and src the address it was saved from. */
    private data class CatalogSub(val id: String, val url: String, val lang: String?, val label: String, val src: String = url)

    private val subStore = SubtitleStore(activity)
    private val subPool = Executors.newFixedThreadPool(3)
    private val catalog = ArrayList<CatalogSub>()
    private val catalogUrls = HashSet<String>()
    private val parsed = HashMap<String, List<CuesWithTiming>>()
    private val loading = HashSet<String>()
    private var subSeq = 0
    private var prefSubLangs: List<String> = emptyList()
    private var activeExtId: String? = null
    private var subsOff = false
    private var userPickedSub = false
    private var autoSubDone = false
    private var searching = false
    private var subStyle = SubStyle()
    private var shownLangs: MutableSet<String>? = null
    private var extView: SubtitleView? = null
    private var shade: View? = null
    /** Where the shade is heading (shown or hidden), so a fade that is still running is turned
     *  around instead of finishing the wrong way. */
    private var shadeTarget: Boolean? = null
    private var ext: ExternalSubs? = null
    /** The download of what's playing (when there is one): its saved subtitles, and where the
     *  save button puts new ones. */
    private var downloadId: String? = null
    private val saved = ArrayList<CatalogSub>()
    private val saving = HashSet<String>()
    /** The subtitle the viewer picked for this episode the last time it played (the page
     *  remembers it and sends it with play): its address until it turns up in the lists, then
     *  its id while it loads. */
    private var restoreUrl: String? = null
    private var restoringId: String? = null
    /** The sync the viewer gave an addon subtitle by ear (TextSync), kept on the device by the
     *  subtitle's address and put back whenever that subtitle is shown again. */
    private val syncStore = SyncStore(activity)
    private var syncPanel: SyncPanel? = null
    /** The address of the subtitle the open sync panel lists. */
    private var syncPanelFor: String? = null

    // ---- skip intro / recap / credits ------------------------------------------------------
    private var segments: List<SkipSegment> = emptyList()
    /** The title the list was sent for. It can arrive before that title's play(), and it must not
     *  act on the title that is still playing until then. */
    private var segmentsKey = ""
    private var autoSkipIntro = false
    /** Intros already skipped automatically: seeking back into one offers the button instead. */
    private val autoSkipped = HashSet<SkipSegment>()
    /** The segment the skip button is offering right now. */
    private var offeredSkip: SkipSegment? = null
    /** The segment whose button was tapped: it stays hidden until the position has left it. */
    private var dismissedSkip: SkipSegment? = null
    /** Credits that run to the end of an episode with a next one are playing: the next-episode
     *  button shows by itself instead of "Skip credits". */
    private var creditsToEnd = false

    // ---- sleep timer / hold for double speed -----------------------------------------------
    /** Lives as long as the player is open: a rebuilt chrome or another stream of the same title
     *  doesn't lose it. */
    private val sleep = SleepTimer()
    private val sleepFire = Runnable { fireSleep() }
    /** The sleep timer paused during a network drop: reconnecting must not start playback again. */
    private var sleepHeld = false
    private var sleepTitle: TextView? = null
    /** The speed to go back to when the finger lifts; null while no hold is on. */
    private var holdPrevSpeed: Float? = null
    private var holdPlayer: ExoPlayer? = null

    // ---- chrome ----------------------------------------------------------------------------
    private var topBar: LinearLayout? = null
    private var titleView: TextView? = null
    private var subtitleView: TextView? = null
    private var qualityView: TextView? = null
    private var nextButton: View? = null
    private var skipButton: View? = null
    private var skipLabel: TextView? = null
    private var unlockButton: View? = null
    private var indicator: LinearLayout? = null
    private var indicatorIcon: ImageView? = null
    private var indicatorText: TextView? = null
    private var controllerVisible = false
    private var panel: SidePanel? = null
    private var panelKind = ""
    private var streamsPayload: JSONObject? = null
    private var pickingStream: String? = null
    private var streamQuality = "all"
    private var brightnessTouched = false
    private var inPip = false
    /** The camera cutout and gesture bar, as last measured (applyChromeInsets). */
    private var insetSide = 0
    private var insetBottom = 0
    /** The language and direction the chrome was built for. Its texts and sides are set when it
     *  is built, so after a change (Settings > Language) it is built again the next time the
     *  player shows. */
    private var chromeFor = ""

    val isShowing: Boolean get() = view?.visibility == View.VISIBLE

    // =========================================================================================
    // Playback
    // =========================================================================================

    fun play(sourceJson: String) {
        val src = try { JSONObject(sourceJson) } catch (_: Exception) { return }
        if (src.optString("url").isBlank()) {
            // A broken payload from the page must not tear down what is playing.
            emit(JSONObject().put("type", "error").put("code", "source").put("message", "no stream url").put("fatal", true).toString())
            return
        }
        val key = src.optString("contentKey", "")
        if (key.isNotEmpty() && key != contentKey) {
            // A different title/episode: forget subtitles from the previous one.
            contentKey = key
            catalog.clear(); catalogUrls.clear(); parsed.clear(); loading.clear()
            saved.clear(); saving.clear()
            subStore.clear()
            activeExtId = null; subsOff = false; userPickedSub = false; autoSubDone = false
            restoreUrl = null; restoringId = null
            // The sync panel lists the lines of the subtitle that is about to go.
            if (panelKind == "sync") panel?.dismiss()
            ext?.delayMs = 0
            ext?.clear()
            // Skip segments belong to a title too, unless the page already sent this one's.
            if (segmentsKey != key) {
                segments = emptyList()
                segmentsKey = key
                autoSkipped.clear()
            }
            offeredSkip = null; dismissedSkip = null; creditsToEnd = false
            // title / episode line / next-episode come from the "meta" command, which can
            // arrive before this play() — don't wipe them here.
        }
        source = src
        downloadId = src.optString("downloadId").takeIf { it.isNotBlank() }
        loadSaved()
        src.optString("title").takeIf { it.isNotBlank() }?.let { title = it }
        prefSubLangs = jsonStrings(src.optJSONArray("prefSubLangs")).ifEmpty { prefSubLangs }
        prefAudioLangs = jsonStrings(src.optJSONArray("prefAudioLangs")).ifEmpty { prefAudioLangs }
        // Settings > Language > "subtitles off by default", or the viewer turned them off for this
        // title: start without subtitles and pick none automatically. A choice already made in
        // this player's own panel stays (a stream switch plays the same title again).
        if (src.optBoolean("subsOff", false) && !userPickedSub) subsOff = true
        // The exact subtitle picked for this episode last time. A choice made in this player's
        // panel since then stays.
        if (!userPickedSub && !subsOff) {
            src.optJSONObject("restoreSub")?.optString("url")?.takeIf { it.isNotBlank() }?.let { restoreUrl = it }
        }
        subStyle = SubStyle.load(activity) ?: SubStyle.fromHarbor(src.optJSONObject("subStyle"))
        if (pickingStream != null) {
            pickingStream = null
            panel?.dismiss()
            toast(Strings.sourceSwitched)
        }
        start(src, src.optLong("startMs", 0))
        // The same title opened again after the player was closed: closing emptied the subtitle
        // view, so the subtitle that is still marked as chosen goes back on.
        activeExtId?.let { id -> if (ext?.active == false) parsed[id]?.let { ext?.set(it, activeSub()?.let { s -> syncStore.get(s.src) }) } }
        addToCatalog(src.optJSONArray("subtitles"))
        tryRestoreSub()
    }

    private fun buildItem(src: JSONObject): MediaItem {
        val url = src.getString("url")
        val item = MediaItem.Builder().setUri(url)
        val lower = url.lowercase()
        if (lower.contains(".m3u8") || lower.contains("/hlsv2/")) item.setMimeType(MimeTypes.APPLICATION_M3U8)
        else if (lower.contains(".mpd")) item.setMimeType(MimeTypes.APPLICATION_MPD)
        return item.build()
    }

    private fun start(src: JSONObject, startMs: Long) {
        // Parse the new source first: if it is broken, the old player is left alone.
        val item = buildItem(src)
        releasePlayer()
        val ctx = activity
        val headers = HashMap<String, String>()
        src.optJSONObject("headers")?.let { h -> h.keys().forEach { k -> headers[k] = h.getString(k) } }
        val ua = headers.remove("User-Agent") ?: headers.remove("user-agent") ?: userAgent
        // A stream that comes with a login (Authorization / Cookie) goes through our own source:
        // Media3's repeats every header at each redirect, which would hand the login to whatever
        // host a redirect leads to. Streams without one stay on Media3's.
        val http: DataSource.Factory = if (headers.keys.any { RedirectGuard.isCredential(it) }) {
            GuardedHttpDataSource.Factory(ua, headers, HTTP_CONNECT_TIMEOUT_MS, HTTP_READ_TIMEOUT_MS)
        } else {
            DefaultHttpDataSource.Factory()
                .setUserAgent(ua)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(HTTP_CONNECT_TIMEOUT_MS)
                .setReadTimeoutMs(HTTP_READ_TIMEOUT_MS)
                .setDefaultRequestProperties(headers)
        }
        val dataSource = DefaultDataSource.Factory(ctx, http)
        val renderers = DefaultRenderersFactory(ctx)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
            // Hardware MediaCodec decoders first (FFmpeg is only used for audio the phone
            // can't decode); asynchronous queueing keeps high-bitrate 4K/HEVC smooth.
            .setEnableDecoderFallback(true)
            .forceEnableMediaCodecAsynchronousQueueing()
        val p = ExoPlayer.Builder(ctx, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource).setLoadErrorHandlingPolicy(PatientLoadErrorPolicy()))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()

        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED && !sleepAtEnd(p)) emit(JSONObject().put("type", "ended").toString())
                if (state == Player.STATE_READY) onRecovered()
                updateKeepScreenOn()
                restartTicker()
                sendState()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                updateKeepScreenOn()
                ext?.setRunning(isPlaying)
                restartTicker()
                sendState()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                // Play was pressed: whatever the sleep timer held back is the viewer's to start.
                if (playWhenReady) sleepHeld = false
                updateKeepScreenOn()
            }

            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                ext?.refresh()
                // A seek can land in a segment, or leave one, while the video is paused.
                updateSkip()
            }
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                matchRefreshToVideo()
                updateChrome()
                sendState()
            }

            override fun onTracksChanged(tracks: Tracks) {
                matchRefreshToVideo()
                updateChrome()
                maybeAutoSelectSub()
                if (panel?.isOpen == true && (panelKind == "subs" || panelKind == "audio")) refreshPanel()
            }

            override fun onPlayerError(error: PlaybackException) {
                updateKeepScreenOn()
                if (recoverFrom(error)) return
                giveUp(error)
            }
        })
        p.setMediaItem(item, startMs.coerceAtLeast(0))
        applyTextSelection(p)
        p.prepare()
        p.playWhenReady = true
        player = p
        // Headset, Bluetooth and car buttons (play/pause, skip) reach the player.
        session = try {
            MediaSession.Builder(activity, p).setId("harbor-" + System.nanoTime()).build()
        } catch (_: Exception) {
            null
        }
        show(p)
        restartTicker()
    }

    // =========================================================================================
    // Network recovery: mid-film trouble (tunnel, lift, Wi-Fi to mobile data, a CDN hiccup)
    // shows "Reconnecting…" and prepares again at the same position once the network is back,
    // instead of freezing silently. Dead links (403/404/410) and decoder errors go to the page.
    // =========================================================================================

    private fun isNetworkError(e: PlaybackException): Boolean = when (e.errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED -> true
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> {
            val code = (e.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode ?: 0
            code >= 500 || code == 429
        }
        else -> false
    }

    private fun recoverFrom(e: PlaybackException): Boolean {
        val p = player ?: return false
        if (e.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            p.seekToDefaultPosition()
            p.prepare()
            return true
        }
        if (!isNetworkError(e)) return false
        val now = System.currentTimeMillis()
        if (!reconnecting) {
            reconnecting = true
            reconnectSince = now
            reconnectAttempts = 0
        }
        if (now - reconnectSince > RECONNECT_BUDGET_MS) return false
        reconnectAttempts++
        flash(R.drawable.ic_refresh_cw, if (isOnline()) Strings.reconnecting else Strings.waitingForInternetEllipsis, holdMs = RECONNECT_BUDGET_MS)
        watchNetwork()
        updateKeepScreenOn()
        handler.removeCallbacks(reconnect)
        handler.postDelayed(reconnect, minOf(reconnectAttempts * 2000L, 10_000L))
        return true
    }

    private fun tryReconnect() {
        val p = player ?: return
        if (!reconnecting) return
        if (!isOnline()) {
            if (System.currentTimeMillis() - reconnectSince > RECONNECT_BUDGET_MS) giveUp(null)
            else handler.postDelayed(reconnect, 3000)
            return
        }
        // After an error the player keeps its position: prepare() retries from there.
        p.prepare()
        if (!sleepHeld) p.playWhenReady = true
    }

    private fun onRecovered() {
        if (!reconnecting) return
        reconnecting = false
        reconnectAttempts = 0
        handler.removeCallbacks(reconnect)
        unwatchNetwork()
        flash(R.drawable.ic_play, Strings.backOnline, holdMs = 900)
    }

    /** Native gave up: tell the page (fatal) and show the user how to carry on, right here —
     *  the page's own error screen is hidden under this view. */
    private fun giveUp(error: PlaybackException?) {
        val network = reconnecting || error == null || isNetworkError(error)
        reconnecting = false
        handler.removeCallbacks(reconnect)
        unwatchNetwork()
        updateKeepScreenOn()
        emit(
            JSONObject()
                .put("type", "error")
                .put("code", if (error != null) errorCode(error) else "network")
                .put("message", if (error != null) error.errorCodeName + ": " + (error.message ?: "") else "network lost")
                .put("fatal", true)
                .toString(),
        )
        flash(
            R.drawable.ic_refresh_cw,
            if (network) Strings.streamDropped else Strings.sourceFailedRetry,
            holdMs = 8000,
        )
        view?.showController()
    }

    private fun watchNetwork() {
        if (netCallback != null) return
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                handler.post {
                    if (reconnecting) {
                        handler.removeCallbacks(reconnect)
                        handler.postDelayed(reconnect, 800)
                    }
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (_: Exception) {
        }
    }

    private fun unwatchNetwork() {
        val cb = netCallback ?: return
        netCallback = null
        try {
            (activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(cb)
        } catch (_: Exception) {
        }
    }

    /** The screen stays on only while a video plays (or is about to): paused, ended or stopped,
     *  the phone sleeps as usual. */
    private fun updateKeepScreenOn() {
        val p = player
        view?.keepScreenOn = reconnecting ||
            (p != null && p.playWhenReady && (p.playbackState == Player.STATE_READY || p.playbackState == Player.STATE_BUFFERING))
    }

    private fun restartTicker() {
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    // =========================================================================================
    // Picture-in-picture
    // =========================================================================================

    /** Leaving the app (Home) while a video plays keeps it going in a small window. */
    fun onUserLeaveHint() {
        val p = player ?: return
        if (!isShowing || !p.isPlaying || locked || Build.VERSION.SDK_INT < 26) return
        if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return
        val vs = p.videoSize
        val ratio = if (vs.width > 0 && vs.height > 0) vs.width.toFloat() / vs.height else 16f / 9f
        // Android only accepts ratios between 1:2.39 and 2.39:1.
        val r = when {
            ratio > 2.39f -> Rational(239, 100)
            ratio < 1 / 2.39f -> Rational(100, 239)
            vs.width > 0 && vs.height > 0 -> Rational(vs.width, vs.height)
            else -> Rational(16, 9)
        }
        try {
            activity.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(r).build())
        } catch (_: Exception) {
        }
    }

    fun onPictureInPictureChanged(inPip: Boolean) {
        this.inPip = inPip
        val v = view ?: return
        v.useController = !inPip
        if (inPip) {
            // The finger that held the video down for double speed is gone with the full screen.
            endHoldSpeed()
            v.hideController()
            panel?.dismiss()
            listOfNotNull(topBar, nextButton, skipButton, unlockButton, indicator).forEach { it.visibility = View.GONE }
            shade?.animate()?.cancel()
            shade?.visibility = View.GONE
            shadeTarget = false
        } else {
            updateChrome()
        }
    }

    /** Fullscreen draws edge to edge: keep the controls clear of the camera cutout and of the
     *  bottom gesture area (in landscape the cutout sits on the left or right edge). */
    fun applyChromeInsets() {
        val ins = ViewCompat.getRootWindowInsets(root) ?: return
        val cut = ins.getInsets(WindowInsetsCompat.Type.displayCutout())
        val gest = ins.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
        val ctx = activity
        val side = maxOf(cut.left, cut.right)
        insetSide = side
        insetBottom = gest.bottom
        topBar?.setPadding(ctx.dp(20) + cut.left, ctx.dp(14) + cut.top, ctx.dp(20) + cut.right, ctx.dp(28))
        view?.findViewById<View>(androidx.media3.ui.R.id.exo_controller)?.setPadding(cut.left, 0, cut.right, gest.bottom)
        (nextButton?.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
            lp.marginEnd = ctx.dp(28) + side
            lp.bottomMargin = ctx.dp(96) + gest.bottom
            nextButton?.layoutParams = lp
        }
        placeSkipButton(aboveNext = nextButton?.visibility == View.VISIBLE)
        (unlockButton?.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
            lp.marginStart = ctx.dp(32) + side
            unlockButton?.layoutParams = lp
        }
    }

    private fun jsonStrings(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        return (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotBlank() } }
    }

    /** Switch the panel to the best refresh rate for this video's frame rate. */
    private fun matchRefreshToVideo() {
        val fps = player?.videoFormat?.frameRate ?: return
        if (fps > 1f) RefreshRate.apply(activity, fps)
    }

    // =========================================================================================
    // View + chrome
    // =========================================================================================

    private fun show(p: ExoPlayer) {
        val v = view ?: createView()
        if (chromeFor != chromeKey()) buildChrome()
        v.player = p
        v.visibility = View.VISIBLE
        v.bringToFront()
        subStyle.applyTo(v.subtitleView)
        subStyle.applyTo(extView)
        listOfNotNull(topBar, nextButton, skipButton, indicator, unlockButton).forEach { it.bringToFront() }
        updateChrome()
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        activity.setFullscreenMode(true)
        root.post { applyChromeInsets() }
        root.postDelayed({ applyChromeInsets() }, 600) // after the rotation to landscape
    }

    private fun createView(): PlayerView {
        val pv = PlayerView(activity)
        pv.setBackgroundColor(Color.BLACK)
        pv.setShowSubtitleButton(false) // our own subtitle panel replaces it
        pv.setShowNextButton(false)
        pv.setShowPreviousButton(false)
        pv.setShowFastForwardButton(true)
        pv.setShowRewindButton(true)
        pv.keepScreenOn = false // switched on while playing (updateKeepScreenOn)
        pv.resizeMode = resizeMode
        pv.controllerShowTimeoutMs = 3500
        root.addView(pv, FrameLayout.LayoutParams(MainActivity.MATCH, MainActivity.MATCH))
        view = pv

        // Accent-coloured seek bar, like the rest of the app.
        pv.findViewById<DefaultTimeBar>(androidx.media3.ui.R.id.exo_progress)?.apply {
            setPlayedColor(HarborColors.ACCENT)
            setScrubberColor(HarborColors.ACCENT)
            setBufferedColor(Color.argb(110, 255, 255, 255))
        }

        // media3's own shade lives inside the controller, which is padded clear of the camera
        // cutout and the gesture bar, so it stopped short of those edges (bright strips there),
        // and its bottom bar drew a second, almost black box. Both go; our own shade below covers
        // the whole screen instead.
        pv.findViewById<View>(androidx.media3.ui.R.id.exo_controls_background)?.background = null
        pv.findViewById<View>(androidx.media3.ui.R.id.exo_bottom_bar)?.background = null

        // Addon subtitles render in their own view above the video, below the controls.
        val sv = SubtitleView(activity)
        (pv.overlayFrameLayout ?: pv).addView(sv, FrameLayout.LayoutParams(MainActivity.MATCH, MainActivity.MATCH))
        extView = sv
        ext = ExternalSubs(sv) { player?.currentPosition }

        // One even shade over the whole picture while the controls show, edge to edge, a little
        // darker at the top and bottom where the text sits. Above the video and subtitles, below
        // the controls. It follows the controller's visibility (updateChrome), so it also stays
        // through media3's short "progress bar only" phase after the controls time out: the top
        // bar and the progress line never sit on bare video.
        val shadeView = View(activity).apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(
                    Color.argb(165, 0, 0, 0), Color.argb(110, 0, 0, 0), Color.argb(110, 0, 0, 0),
                    Color.argb(110, 0, 0, 0), Color.argb(175, 0, 0, 0),
                ),
            )
            visibility = View.GONE
            alpha = 0f
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        (pv.overlayFrameLayout ?: pv).addView(shadeView, FrameLayout.LayoutParams(MainActivity.MATCH, MainActivity.MATCH))
        shade = shadeView
        shadeTarget = null

        pv.setOnTouchListener(PlayerGestures(activity, gestureCallbacks))
        pv.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { vis ->
            controllerVisible = vis == View.VISIBLE
            updateChrome()
        })
        buildChrome()
        return pv
    }

    private fun chromeKey() = "${Strings.lang}|${activity.uiDirection()}"

    /** Top bar, next-episode and skip buttons, the indicator and the unlock button, in the app's
     *  language and direction (root keeps the phone's direction, so each piece gets its own, and a
     *  side of the screen is worked out here rather than left to root). */
    private fun buildChrome() {
        listOfNotNull(topBar, nextButton, skipButton, indicator, unlockButton).forEach { root.removeView(it) }
        buildTopBar()
        buildNextButton()
        buildSkipButton()
        buildIndicator()
        buildUnlockButton()
        chromeFor = chromeKey()
    }

    private fun side(relative: Int) = Gravity.getAbsoluteGravity(relative, activity.uiDirection())

    private fun buildTopBar() {
        val ctx = activity
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = ctx.uiDirection()
            gravity = Gravity.CENTER_VERTICAL
            setPadding(ctx.dp(20), ctx.dp(14), ctx.dp(20), ctx.dp(28))
            // No shade of its own: it only shows with the controls, whose shade covers the screen.
        }
        bar.addView(ctx.iconButton(R.drawable.ic_arrow_left, Strings.back) { close() }.apply {
            (layoutParams as LinearLayout.LayoutParams).marginStart = 0
            // Right-to-left: the arrow points the other way, like the text.
            if (ctx.uiDirection() == View.LAYOUT_DIRECTION_RTL) scaleX = -1f
        })
        val texts = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(ctx.dp(12), 0, ctx.dp(8), 0)
        }
        titleView = ctx.label("", 16f, bold = true, lines = 1).also { texts.addView(it) }
        subtitleView = ctx.label("", 12.5f, HarborColors.MUTED, lines = 1).also { texts.addView(it) }
        qualityView = ctx.label("", 12f, HarborColors.SUBTLE, lines = 1).also {
            it.fontFeatureSettings = "tnum"
            texts.addView(it)
        }
        bar.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(ctx.iconButton(R.drawable.ic_layers, Strings.sources) { openStreams() })
        bar.addView(ctx.iconButton(R.drawable.ic_captions, Strings.subtitles) { openSubs("tracks") })
        bar.addView(ctx.iconButton(R.drawable.ic_audio_lines, Strings.audioAndSpeed) { openAudio() })
        bar.addView(ctx.iconButton(R.drawable.ic_scan, Strings.pictureSize) { cycleResize() })
        bar.addView(ctx.iconButton(R.drawable.ic_lock, Strings.lockScreen) { setLocked(true) })
        root.addView(bar, FrameLayout.LayoutParams(MainActivity.MATCH, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        topBar = bar
    }

    private fun buildNextButton() {
        val ctx = activity
        val b = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = ctx.uiDirection()
            gravity = Gravity.CENTER
            setPadding(ctx.dp(16), 0, ctx.dp(18), 0)
            background = rounded(Color.WHITE, 999f)
            isClickable = true
            setOnClickListener { emit(JSONObject().put("type", "next").toString()) }
            addView(ctx.icon(R.drawable.ic_skip_forward, 18, Color.BLACK).apply {
                layoutParams = LinearLayout.LayoutParams(ctx.dp(18), ctx.dp(18)).apply { marginEnd = ctx.dp(8) }
            })
            addView(ctx.label(Strings.nextEpisode, 14f, Color.BLACK, bold = true))
        }
        root.addView(b, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ctx.dp(NEXT_BUTTON_DP), Gravity.BOTTOM or side(Gravity.END)).apply {
            marginEnd = ctx.dp(28)
            bottomMargin = ctx.dp(96)
        })
        nextButton = b
    }

    /** "Skip intro" / "Skip recap" / "Skip credits": the next-episode button's look, in its
     *  corner. Its text is set when it shows (showSkipAndNext). */
    private fun buildSkipButton() {
        val ctx = activity
        val text = ctx.label("", 14f, Color.BLACK, bold = true)
        val b = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = ctx.uiDirection()
            gravity = Gravity.CENTER
            setPadding(ctx.dp(16), 0, ctx.dp(18), 0)
            background = rounded(Color.WHITE, 999f)
            isClickable = true
            visibility = View.GONE
            setOnClickListener { skipOffered() }
            addView(ctx.icon(R.drawable.ic_fast_forward, 18, Color.BLACK).apply {
                layoutParams = LinearLayout.LayoutParams(ctx.dp(18), ctx.dp(18)).apply { marginEnd = ctx.dp(8) }
            })
            addView(text)
        }
        root.addView(b, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ctx.dp(SKIP_BUTTON_DP), Gravity.BOTTOM or side(Gravity.END)).apply {
            marginEnd = ctx.dp(28) + insetSide
            bottomMargin = ctx.dp(96) + insetBottom
        })
        skipButton = b
        skipLabel = text
    }

    private fun buildIndicator() {
        val ctx = activity
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = ctx.uiDirection()
            gravity = Gravity.CENTER
            setPadding(ctx.dp(18), ctx.dp(12), ctx.dp(20), ctx.dp(12))
            background = rounded(Color.argb(175, 0, 0, 0), 999f)
            visibility = View.GONE
        }
        indicatorIcon = ctx.icon(R.drawable.ic_sun, 22).also {
            it.layoutParams = LinearLayout.LayoutParams(ctx.dp(22), ctx.dp(22)).apply { marginEnd = ctx.dp(10) }
            box.addView(it)
        }
        indicatorText = ctx.label("", 17f, bold = true).also { box.addView(it) }
        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        indicator = box
    }

    private fun buildUnlockButton() {
        val ctx = activity
        val b = ctx.iconButton(R.drawable.ic_lock_open, Strings.unlock) { setLocked(false) }.apply {
            background = rounded(Color.argb(150, 0, 0, 0), 999f)
            layoutDirection = ctx.uiDirection()
            visibility = View.GONE
        }
        root.addView(b, FrameLayout.LayoutParams(ctx.dp(56), ctx.dp(56), Gravity.CENTER_VERTICAL or side(Gravity.START)).apply {
            marginStart = ctx.dp(32)
        })
        unlockButton = b
    }

    private val hideIndicator = Runnable { indicator?.visibility = View.GONE }
    private val hideUnlock = Runnable { if (locked) unlockButton?.visibility = View.GONE }

    private fun flash(iconRes: Int, text: String, gravity: Int = Gravity.CENTER, holdMs: Long = 700) {
        val box = indicator ?: return
        indicatorIcon?.setImageResource(iconRes)
        indicatorText?.text = text
        (box.layoutParams as FrameLayout.LayoutParams).let { lp ->
            if (lp.gravity != gravity) {
                lp.gravity = gravity
                lp.leftMargin = if (gravity and Gravity.HORIZONTAL_GRAVITY_MASK == Gravity.LEFT) activity.dp(72) else 0
                lp.rightMargin = if (gravity and Gravity.HORIZONTAL_GRAVITY_MASK == Gravity.RIGHT) activity.dp(72) else 0
                lp.topMargin = if (gravity and Gravity.VERTICAL_GRAVITY_MASK == Gravity.TOP) activity.dp(28) else 0
                box.layoutParams = lp
            }
        }
        box.visibility = View.VISIBLE
        box.bringToFront()
        handler.removeCallbacks(hideIndicator)
        handler.postDelayed(hideIndicator, holdMs)
    }

    private fun updateChrome() {
        val showing = isShowing && !locked && controllerVisible && panel?.isOpen != true
        topBar?.visibility = if (showing) View.VISIBLE else View.GONE
        setShade(isShowing && !locked && controllerVisible)
        updateSkip() // the next-episode and skip buttons
        titleView?.text = title
        subtitleView?.text = subtitleLine
        subtitleView?.visibility = if (subtitleLine.isBlank()) View.GONE else View.VISIBLE
        val q = if (showQuality) qualityText() else ""
        qualityView?.text = q
        qualityView?.visibility = if (q.isBlank()) View.GONE else View.VISIBLE
    }

    // =========================================================================================
    // Skip intro / recap / credits. The page works the segments out and sends them ("segments");
    // its own button is hidden under this view, so the button is drawn here.
    // =========================================================================================

    /** Works out what the skip button does at the current position: offer the segment, skip an
     *  intro by itself (Settings), or leave end credits to the next-episode button. */
    private fun updateSkip() {
        val p = player
        // A list sent ahead for the next title waits for that title's play().
        val list = if (segmentsKey.isEmpty() || segmentsKey == contentKey) segments else emptyList()
        val d = if (p == null || !isShowing || list.isEmpty()) SkipSegments.Decision(SkipSegments.Action.NONE)
        else SkipSegments.decide(list, p.currentPosition, knownDuration(p), hasNext, autoSkipIntro, autoSkipped)
        val seg = d.segment
        if (d.action == SkipSegments.Action.AUTO_SKIP && p != null && seg != null) {
            // Remembered first: the look at the new position below must not skip it again.
            autoSkipped.add(seg)
            p.seekTo(SkipSegments.target(seg, knownDuration(p)))
            if (!inPip) flash(R.drawable.ic_fast_forward, Strings.introSkipped, holdMs = 1500)
            updateSkip()
            return
        }
        if (seg != dismissedSkip) dismissedSkip = null
        creditsToEnd = d.action == SkipSegments.Action.NEXT_EPISODE
        offeredSkip = seg.takeIf { d.action == SkipSegments.Action.OFFER && it != dismissedSkip }
        showSkipAndNext()
    }

    /**
     * The next-episode button shows with the controls, and by itself over end credits. The skip
     * button shows whenever a segment is on offer, controls or not, above the next-episode button
     * when both are up. Neither shows on a locked screen, in picture-in-picture or under a panel.
     */
    private fun showSkipAndNext() {
        val free = isShowing && !locked && !inPip && panel?.isOpen != true
        val next = free && hasNext && (controllerVisible || creditsToEnd)
        nextButton?.visibility = if (next) View.VISIBLE else View.GONE
        val b = skipButton ?: return
        val seg = offeredSkip.takeIf { free }
        if (seg == null) {
            b.visibility = View.GONE
            return
        }
        val text = when (seg.kind) {
            SkipSegments.RECAP -> Strings.skipRecap
            SkipSegments.OUTRO -> Strings.skipCredits
            else -> Strings.skipIntro
        }
        // This runs every second while a segment plays: no new layout for the same text.
        if (skipLabel?.text?.toString() != text) skipLabel?.text = text
        placeSkipButton(aboveNext = next)
        b.visibility = View.VISIBLE
    }

    private fun placeSkipButton(aboveNext: Boolean) {
        val b = skipButton ?: return
        val lp = b.layoutParams as? FrameLayout.LayoutParams ?: return
        val ctx = activity
        val bottom = ctx.dp(if (aboveNext) 96 + NEXT_BUTTON_DP + 10 else 96) + insetBottom
        val end = ctx.dp(28) + insetSide
        if (lp.bottomMargin == bottom && lp.marginEnd == end) return
        lp.bottomMargin = bottom
        lp.marginEnd = end
        b.layoutParams = lp
    }

    /** The skip button was tapped. */
    private fun skipOffered() {
        val p = player ?: return
        val seg = offeredSkip ?: return
        // Hidden from the tap on, even when the seek takes a moment (or the stream can't seek).
        dismissedSkip = seg
        p.seekTo(SkipSegments.target(seg, knownDuration(p)))
        updateSkip()
    }

    private fun setShade(on: Boolean) {
        val s = shade ?: return
        if (shadeTarget == on) return
        shadeTarget = on
        s.animate().cancel()
        if (on) {
            if (s.visibility != View.VISIBLE) {
                s.alpha = 0f
                s.visibility = View.VISIBLE
            }
            s.animate().alpha(1f).setDuration(180).start()
        } else {
            // withEndAction only runs when the fade finishes, not when a new show cancels it.
            s.animate().alpha(0f).setDuration(180).withEndAction { s.visibility = View.GONE }.start()
        }
    }

    /** What's actually playing, e.g. "4K · Dolby Vision · TrueHD 7.1" (falls back to the
     *  stream's own label until the formats are known). */
    private fun qualityText(): String {
        val p = player ?: return streamQualityLabel
        val parts = ArrayList<String>()
        p.videoFormat?.takeIf { it.width > 0 && it.height > 0 }?.let { v ->
            parts.add(resolutionLabel(v.width, v.height))
            hdrLabel(v)?.let { parts.add(it) }
        }
        p.audioFormat?.let { a -> audioShort(a)?.let { parts.add(it) } }
        return if (parts.isEmpty()) streamQualityLabel else parts.joinToString(" · ")
    }

    private fun resolutionLabel(w: Int, h: Int): String = when {
        w >= 3200 || h >= 2000 -> "4K"
        w >= 2400 || h >= 1400 -> "1440p"
        w >= 1800 || h >= 1000 -> "1080p"
        w >= 1200 || h >= 700 -> "720p"
        else -> "${h}p"
    }

    private fun hdrLabel(f: Format): String? {
        val codecs = f.codecs ?: ""
        if (f.sampleMimeType == MimeTypes.VIDEO_DOLBY_VISION || codecs.startsWith("dvh") || codecs.startsWith("dva")) return "Dolby Vision"
        return when (f.colorInfo?.colorTransfer) {
            C.COLOR_TRANSFER_ST2084 -> "HDR10"
            C.COLOR_TRANSFER_HLG -> "HLG"
            else -> null
        }
    }

    private fun audioShort(f: Format): String? {
        val codec = when (f.sampleMimeType) {
            MimeTypes.AUDIO_AC3 -> "Dolby Digital"
            MimeTypes.AUDIO_E_AC3 -> "DD+"
            MimeTypes.AUDIO_E_AC3_JOC -> "Dolby Atmos"
            MimeTypes.AUDIO_TRUEHD -> "TrueHD"
            MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_EXPRESS -> "DTS"
            MimeTypes.AUDIO_DTS_HD -> "DTS-HD"
            MimeTypes.AUDIO_AAC -> "AAC"
            MimeTypes.AUDIO_OPUS -> "Opus"
            MimeTypes.AUDIO_FLAC -> "FLAC"
            MimeTypes.AUDIO_MPEG -> "MP3"
            else -> f.sampleMimeType?.substringAfter('/')?.uppercase()
        }
        val ch = when (f.channelCount) {
            1 -> "1.0"
            2 -> "2.0"
            6 -> "5.1"
            8 -> "7.1"
            Format.NO_VALUE -> null
            else -> "${f.channelCount}ch"
        }
        return listOfNotNull(codec, ch).joinToString(" ").ifBlank { null }
    }

    private fun setLocked(on: Boolean) {
        locked = on
        val pv = view ?: return
        pv.useController = !on
        if (on) {
            pv.hideController()
            unlockButton?.visibility = View.VISIBLE
            handler.removeCallbacks(hideUnlock)
            handler.postDelayed(hideUnlock, 2500)
            toast(Strings.screenLocked)
        } else {
            unlockButton?.visibility = View.GONE
            pv.showController()
        }
        updateChrome()
    }

    private fun cycleResize() {
        resizeMode = when (resizeMode) {
            AspectRatioFrameLayout.RESIZE_MODE_FIT -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            AspectRatioFrameLayout.RESIZE_MODE_ZOOM -> AspectRatioFrameLayout.RESIZE_MODE_FILL
            else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
        }
        view?.resizeMode = resizeMode
        flash(R.drawable.ic_scan, when (resizeMode) {
            AspectRatioFrameLayout.RESIZE_MODE_ZOOM -> Strings.fillScreen
            AspectRatioFrameLayout.RESIZE_MODE_FILL -> Strings.stretch
            else -> Strings.originalSize
        }, holdMs = 900)
    }

    // =========================================================================================
    // Gestures
    // =========================================================================================

    private val audio by lazy { activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager }

    private val gestureCallbacks = object : PlayerGestures.Callbacks {
        override val locked: Boolean get() = this@NativePlayer.locked || panel?.isOpen == true

        override fun onTap() {
            val pv = view ?: return
            if (pv.isControllerFullyVisible) pv.hideController() else pv.showController()
        }

        override fun onLockedTap() {
            if (panel?.isOpen == true) return
            unlockButton?.visibility = View.VISIBLE
            unlockButton?.bringToFront()
            handler.removeCallbacks(hideUnlock)
            handler.postDelayed(hideUnlock, 2500)
        }

        override fun onDoubleTapSeek(forward: Boolean, totalSec: Int) {
            val p = player ?: return
            val target = (p.currentPosition + if (forward) 10_000 else -10_000).coerceIn(0, durationOrMax(p))
            p.seekTo(target)
            flash(
                if (forward) R.drawable.ic_fast_forward else R.drawable.ic_rewind,
                (if (forward) "+" else "−") + Strings.seconds(totalSec),
                // The side that was tapped (forward is the right third in every language).
                (if (forward) Gravity.RIGHT else Gravity.LEFT) or Gravity.CENTER_VERTICAL,
            )
        }

        override fun onDoubleTapCenter() {
            val p = player ?: return
            if (p.isPlaying) p.pause() else p.play()
            flash(if (p.playWhenReady) R.drawable.ic_play else R.drawable.ic_pause, if (p.playWhenReady) Strings.play else Strings.pause)
        }

        override fun onBrightnessStart(): Float {
            val cur = activity.window.attributes.screenBrightness
            if (cur >= 0) return cur
            return try {
                Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS) / 255f
            } catch (_: Exception) {
                0.5f
            }
        }

        override fun onBrightness(value: Float) {
            brightnessTouched = true
            val a = activity.window.attributes
            a.screenBrightness = value.coerceIn(0.01f, 1f)
            activity.window.attributes = a
            flash(R.drawable.ic_sun, "${(value * 100).toInt()}%", holdMs = 600)
        }

        override fun onVolumeStart(): Float {
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
            return audio.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / max
        }

        override fun onVolume(value: Float) {
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, (value * max).toInt().coerceIn(0, max), 0)
            flash(if (value <= 0.001f) R.drawable.ic_volume_x else R.drawable.ic_volume_2, "${(value * 100).toInt()}%", holdMs = 600)
        }

        override fun onSeekPreview(deltaMs: Long) {
            val p = player ?: return
            val target = (p.currentPosition + deltaMs).coerceIn(0, durationOrMax(p))
            flash(
                if (deltaMs >= 0) R.drawable.ic_fast_forward else R.drawable.ic_rewind,
                "${if (deltaMs >= 0) "+" else "−"}${formatTime(kotlin.math.abs(deltaMs))}  ·  ${formatTime(target)}",
                holdMs = 900,
            )
        }

        override fun onSeekCommit(deltaMs: Long) {
            val p = player ?: return
            if (kotlin.math.abs(deltaMs) < 1000) return
            p.seekTo((p.currentPosition + deltaMs).coerceIn(0, durationOrMax(p)))
        }

        override fun onPinch(zoomIn: Boolean) {
            val want = if (zoomIn) AspectRatioFrameLayout.RESIZE_MODE_ZOOM else AspectRatioFrameLayout.RESIZE_MODE_FIT
            if (want == resizeMode) return
            resizeMode = want
            view?.resizeMode = want
            flash(R.drawable.ic_scan, if (zoomIn) Strings.fillScreen else Strings.originalSize, holdMs = 900)
        }

        override fun onHoldSpeedStart(): Boolean {
            val p = player ?: return false
            val cur = p.playbackParameters.speed
            // Only a video that is playing, and slower than the hold would make it.
            if (!p.isPlaying || cur >= HOLD_SPEED) return false
            holdPrevSpeed = cur
            holdPlayer = p
            p.setPlaybackSpeed(HOLD_SPEED)
            view?.hideController()
            // Stays up for as long as the finger does (endHoldSpeed takes it down).
            flash(R.drawable.ic_fast_forward, Strings.doubleSpeed, Gravity.TOP or Gravity.CENTER_HORIZONTAL, holdMs = HOLD_INDICATOR_MS)
            return true
        }

        override fun onHoldSpeedEnd() = endHoldSpeed()

        override fun onGestureEnd() {}
    }

    /** The finger lifted (or the hold was cut short): back to the speed from before it. */
    private fun endHoldSpeed() {
        val prev = holdPrevSpeed ?: return
        holdPrevSpeed = null
        val p = holdPlayer
        holdPlayer = null
        if (p != null && p === player) p.setPlaybackSpeed(prev)
        // Unless another message has taken the indicator over meanwhile.
        if (indicatorText?.text?.toString() == Strings.doubleSpeed) {
            handler.removeCallbacks(hideIndicator)
            indicator?.visibility = View.GONE
        }
        sendState()
    }

    private fun durationOrMax(p: ExoPlayer) = if (p.duration == C.TIME_UNSET) Long.MAX_VALUE else p.duration

    /** 0 while the length is not known (still loading, or live). */
    private fun knownDuration(p: ExoPlayer) = if (p.duration == C.TIME_UNSET) 0L else p.duration.coerceAtLeast(0)

    private fun formatTime(ms: Long): String {
        val s = ms / 1000
        val h = s / 3600
        val m = s / 60 % 60
        val sec = s % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, sec) else String.format(Locale.US, "%d:%02d", m, sec)
    }

    // =========================================================================================
    // Panels
    // =========================================================================================

    private fun openPanel(
        kind: String,
        titleText: String,
        dim: Boolean = true,
        onOutsideTap: (() -> Unit)? = null,
        onClose: (() -> Unit)? = null,
    ): SidePanel {
        panel?.dismiss()
        val p = SidePanel(activity, root, titleText, dim, onOutsideTap) {
            onClose?.invoke()
            if (panel?.isOpen != true) {
                panelKind = ""
                updateChrome()
            }
        }
        panel = p
        panelKind = kind
        view?.hideController()
        updateChrome()
        p.show()
        return p
    }

    private fun refreshPanel() {
        when (panelKind) {
            "streams" -> renderStreams()
            "subs" -> renderSubs(subsTab)
            "audio" -> renderAudio()
            // Another subtitle (or none) took over: the lines listed are no longer the ones drawn.
            "sync" -> if (activeSub()?.src != syncPanelFor) panel?.dismiss()
        }
    }

    /** Back gesture: close a panel / unlock first. Returns true when handled. */
    fun handleBack(): Boolean {
        if (panel?.isOpen == true) { panel?.dismiss(); return true }
        if (locked) { setLocked(false); return true }
        return false
    }

    // ---- streams ---------------------------------------------------------------------------

    private fun openStreams() {
        openPanel("streams", Strings.sources)
        streamsPayload = null
        renderStreams()
        emit(JSONObject().put("type", "requestStreams").toString())
    }

    private fun renderStreams() {
        val p = panel ?: return
        p.clear()
        // Not for a download: see ExternalPlayer.canOpen.
        if (ExternalPlayer.canOpen(source?.optString("url"))) {
            p.action(Strings.openInAnotherPlayer, R.drawable.ic_external_link) { openInAnotherPlayer() }
            if (ExternalPlayer.headerExtras(source?.optJSONObject("headers")).isNotEmpty()) p.note(Strings.anotherPlayerHeadersNote)
        }
        val data = streamsPayload
        if (data == null) {
            p.row(Strings.fetchingSources, null, loading = true, onClick = null)
            return
        }
        val items = data.optJSONArray("items") ?: JSONArray()
        if (items.length() == 0) {
            p.note(data.optString("message").ifBlank { Strings.noOtherSources })
            return
        }
        val qualities = linkedSetOf<String>()
        for (i in 0 until items.length()) items.optJSONObject(i)?.optString("quality")?.takeIf { it.isNotBlank() }?.let { qualities.add(it) }
        if (qualities.size > 1) {
            p.chips(listOf(Triple(Strings.all, streamQuality == "all") { streamQuality = "all"; renderStreams() }) +
                qualities.map { q -> Triple(q, streamQuality == q) { streamQuality = q; renderStreams() } })
        }
        var shown = 0
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            if (streamQuality != "all" && it.optString("quality") != streamQuality) continue
            val key = it.optString("key")
            val cached = it.optBoolean("cached")
            val name = (if (cached) "⚡ " else "") + it.optString("name")
            val badges = it.optString("badges")
            p.row(
                name,
                it.optString("desc").takeIf { d -> d.isNotBlank() },
                badges.takeIf { b -> b.isNotBlank() },
                selected = it.optBoolean("current"),
                loading = pickingStream == key,
            ) {
                if (it.optBoolean("current") || pickingStream != null) return@row
                pickingStream = key
                renderStreams()
                emit(JSONObject().put("type", "pickStream").put("key", key).toString())
            }
            shown++
        }
        if (shown == 0) p.note(Strings.noSourcesInQuality)
    }

    /** Hands the stream that is playing to another video app, through the system's chooser. This
     *  player pauses and stays where it is, for when the viewer comes back. */
    private fun openInAnotherPlayer() {
        val src = source ?: return
        val url = src.optString("url")
        if (!ExternalPlayer.canOpen(url)) return
        val view = ExternalPlayer.viewIntent(url, title, ExternalPlayer.headerExtras(src.optJSONObject("headers")))
        // The manifest's <queries> lets this see the installed video players on Android 11+. If
        // the question itself fails, the chooser is still tried.
        val found = try {
            activity.packageManager.queryIntentActivities(view, PackageManager.MATCH_DEFAULT_ONLY).isNotEmpty()
        } catch (_: Exception) {
            true
        }
        if (!found) {
            toast(Strings.noVideoPlayerApp)
            return
        }
        player?.pause()
        panel?.dismiss()
        try {
            // NO_USER_ACTION: this is not "the viewer left the app", which would start
            // picture-in-picture (onUserLeaveHint).
            activity.startActivity(Intent.createChooser(view, Strings.openInAnotherPlayer).addFlags(Intent.FLAG_ACTIVITY_NO_USER_ACTION))
        } catch (_: Exception) {
            toast(Strings.noVideoPlayerApp)
        }
    }

    // ---- subtitles -------------------------------------------------------------------------

    private var subsTab = "tracks"

    private fun openSubs(tab: String) {
        subsTab = tab
        openPanel("subs", Strings.subtitles)
        renderSubs(tab)
    }

    private fun langName(code: String?): String {
        if (code.isNullOrBlank() || code.equals("und", true)) return Strings.unknownLanguage
        val loc = Locale.forLanguageTag(code)
        val name = loc.getDisplayLanguage(Strings.locale)
        return if (name.isNullOrBlank() || name.equals(code, true)) code.uppercase() else name.replaceFirstChar { it.titlecase() }
    }

    private fun baseLang(l: String?) = (l ?: "").lowercase().substringBefore('-').substringBefore('_')

    private fun prefRank(lang: String?): Int {
        val b = baseLang(lang)
        val i = prefSubLangs.indexOfFirst { baseLang(it) == b }
        return if (i < 0) 999 else i
    }

    private fun renderSubs(tab: String) {
        val p = panel ?: return
        subsTab = tab
        p.clear()
        p.chips(listOf(
            Triple(Strings.subtitlesTab, tab == "tracks") { renderSubs("tracks") },
            Triple(Strings.lookAndTiming, tab == "style") { renderSubs("style") },
            // Straight to the list of lines when there is a subtitle to sync; a tab that says why
            // not otherwise.
            Triple(Strings.sync, tab == "sync") { if (canSync()) openSync() else renderSubs("sync") },
        ))
        if (tab == "style") {
            SubtitleControls(
                activity, subStyle,
                onStyle = { applySubStyle() },
                getDelayMs = { subDelayMs() },
                onDelay = { setSubDelay(it) },
                onSync = { openSync() },
            ).build(p, delayWorks = activeExtId != null, synced = ext?.sync?.let { it.points.isNotEmpty() || it.segments.isNotEmpty() } == true)
            return
        }
        if (tab == "sync") {
            when {
                canSync() -> p.action(Strings.syncOpen, R.drawable.ic_audio_lines) { openSync() }
                // Its lines are decoded as the video plays: there is no list of them to pick from.
                player?.let { selectedEmbedded(it) } != null -> p.note(Strings.syncNotForEmbedded)
                else -> p.note(Strings.syncNeedsAddonSubtitle)
            }
            return
        }
        val pl = player
        val embeddedSelected = pl?.let { selectedEmbedded(it) }
        p.row(Strings.noSubtitles, selected = activeExtId == null && embeddedSelected == null) {
            userPickedSub = true
            selectOff()
            reportSubChoice(off = true)
        }

        // Embedded tracks.
        val embedded = pl?.let { textTracks(it) } ?: emptyList()
        if (embedded.isNotEmpty()) {
            p.section(Strings.embedded(embedded.size))
            embedded.forEach { t ->
                val f = t.group.getTrackFormat(t.index)
                val sel = activeExtId == null && t.group.isTrackSelected(t.index)
                val forced = f.selectionFlags and C.SELECTION_FLAG_FORCED != 0
                p.row(
                    f.label?.takeIf { it.isNotBlank() } ?: langName(f.language),
                    listOfNotNull(f.language?.let { langName(it) }.takeIf { f.label != null }, if (forced) Strings.forced else null)
                        .joinToString(" · ").ifBlank { null },
                    selected = sel,
                ) {
                    userPickedSub = true
                    selectEmbedded(t)
                    reportSubChoice(off = false, lang = f.language)
                }
            }
        }

        // Saved with the download: local files, so they also work offline.
        if (saved.isNotEmpty()) {
            p.section(Strings.savedOnDevice(saved.size))
            saved.sortedBy { prefRank(it.lang) }.forEach { s ->
                p.row(
                    s.label,
                    langName(s.lang).takeIf { s.lang != null && !s.label.contains(it) },
                    selected = activeExtId == s.id,
                    loading = s.id in loading,
                ) {
                    userPickedSub = true
                    selectExternal(s)
                    reportSubChoice(off = false, lang = s.lang)
                    reportSubPicked(s)
                }
            }
        }

        // Offline: addon subtitles can't be fetched, so only the saved ones are offered.
        if (!isOnline()) {
            p.section(Strings.fromAddons)
            p.note(if (saved.isEmpty()) Strings.offlineNoSaved else Strings.offlineSavedOnly)
            return
        }

        // Addon subtitles, grouped by language (the saved ones aren't repeated here).
        val online = catalog.filter { !isSaved(it) }
        p.section(if (online.isEmpty()) Strings.fromAddons else Strings.fromAddonsCount(online.size))
        if (online.isEmpty()) {
            p.note(if (searching) Strings.searchingAddons else Strings.noAddonSubtitlesYet)
        } else {
            if (downloadId != null) p.note(Strings.saveButtonHint)
            val byLang = online.groupBy { baseLang(it.lang).ifBlank { "und" } }
            val order = byLang.keys.sortedWith(compareBy<String>({ prefRank(it) }, { langName(it) }))
            val chosen = shownLangs ?: loadShownLangs(order).also { shownLangs = it }
            p.chips(
                listOf(Triple(Strings.all, chosen.containsAll(order)) {
                    shownLangs = if (chosen.containsAll(order)) mutableSetOf() else order.toMutableSet()
                    saveShownLangs(); renderSubs("tracks")
                }) + order.map { l ->
                    Triple("${langName(l)} ${byLang[l]?.size ?: 0}", l in chosen) {
                        val set = shownLangs ?: mutableSetOf()
                        if (!set.add(l)) set.remove(l)
                        shownLangs = set
                        saveShownLangs(); renderSubs("tracks")
                    }
                },
            )
            val visible = order.filter { it in chosen }
            if (visible.isEmpty()) p.note(Strings.pickLanguageAbove)
            visible.forEach { l ->
                val list = byLang[l] ?: return@forEach
                p.section("${langName(l)} (${list.size})")
                list.forEach { s ->
                    val label = s.label.substringAfter(" · ", s.label)
                    p.row(
                        label,
                        selected = activeExtId == s.id,
                        loading = s.id in loading,
                        actionIcon = if (downloadId != null) R.drawable.ic_download else null,
                        actionDesc = Strings.saveSubtitleWithVideo,
                        actionBusy = s.id in saving,
                        onAction = { saveSub(s) },
                    ) {
                        userPickedSub = true
                        selectExternal(s)
                        reportSubChoice(off = false, lang = s.lang)
                        reportSubPicked(s)
                    }
                }
            }
        }
        p.action(if (searching) Strings.searching else Strings.getAddonSubtitles, R.drawable.ic_refresh_cw) {
            if (searching) return@action
            searching = true
            emit(JSONObject().put("type", "subSearch").toString())
            renderSubs("tracks")
        }
    }

    /** The viewer's own choice in this panel (not an automatic pick), so the page can remember
     *  "subtitles off" or the language for this title. */
    private fun reportSubChoice(off: Boolean, lang: String? = null) {
        val e = JSONObject().put("type", "subsChoice").put("off", off)
        if (!off && !lang.isNullOrBlank()) e.put("lang", lang)
        emit(e.toString())
    }

    /** The exact addon (or saved) subtitle the viewer picked, sent after its subsChoice, so the
     *  page can ask for it again the next time this episode plays (play's "restoreSub"). A saved
     *  one goes by the address it was saved from. */
    private fun reportSubPicked(s: CatalogSub) {
        val e = JSONObject().put("type", "subPicked").put("url", s.src).put("label", s.label)
        if (!s.lang.isNullOrBlank()) e.put("lang", s.lang)
        emit(e.toString())
    }

    private fun loadShownLangs(order: List<String>): MutableSet<String> {
        val saved = activity.getSharedPreferences("harbor.player", Context.MODE_PRIVATE).getString("subLangs", null)
        if (saved != null) {
            val set = saved.split(',').filter { it.isNotBlank() }.toMutableSet()
            // Keep saved choices, but always show languages that are in the user's preferences.
            order.filter { prefRank(it) < 999 }.forEach { set.add(it) }
            return set
        }
        val pref = order.filter { prefRank(it) < 999 }
        return (pref.ifEmpty { order }).toMutableSet()
    }

    private fun saveShownLangs() {
        activity.getSharedPreferences("harbor.player", Context.MODE_PRIVATE).edit()
            .putString("subLangs", (shownLangs ?: emptySet()).joinToString(","))
            .apply()
    }

    // ---- saved subtitles ---------------------------------------------------------------

    private fun savedId(key: String) = "v" + Integer.toHexString(key.hashCode())

    /** Reads the subtitles saved with the current download; keeps local ones the page handed
     *  over that aren't in it (e.g. a download the page couldn't match). */
    private fun loadSaved() {
        val id = downloadId
        val list = if (id == null) emptyList() else downloads.savedSubtitles(id)
        val fromDownload = list.map { s ->
            val uri = Uri.fromFile(s.file).toString()
            val src = s.src.ifBlank { uri }
            CatalogSub(savedId(src), uri, s.lang, s.label ?: langName(s.lang), src)
        }
        val extra = saved.filter { old -> fromDownload.none { it.url == old.url } }
        saved.clear()
        saved.addAll(fromDownload)
        saved.addAll(extra)
    }

    private fun isSaved(c: CatalogSub) = saved.any { it.src == c.url || it.url == c.url }

    /** The save button on an addon subtitle: store it with the download for offline use. */
    private fun saveSub(s: CatalogSub) {
        val id = downloadId ?: return
        if (!saving.add(s.id)) return
        refreshPanel()
        val gen = contentKey
        downloads.saveSubtitle(id, s.url, s.lang, s.label.substringAfter(" · ", s.label)) { ok ->
            handler.post {
                saving.remove(s.id)
                if (gen != contentKey || downloadId != id) return@post
                if (ok) {
                    loadSaved()
                    // Showing this one right now: carry on with the saved copy.
                    saved.firstOrNull { it.src == s.url }?.let { copy ->
                        parsed[s.id]?.let { parsed[copy.id] = it }
                        if (activeExtId == s.id) activeExtId = copy.id
                    }
                    toast(Strings.subtitleSaved)
                } else {
                    toast(Strings.subtitleSaveFailed)
                }
                refreshPanel()
            }
        }
    }

    /** Connected with working internet (an unvalidated network counts once addons answered). */
    private fun isOnline(): Boolean {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) } ?: return false
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) || catalog.isNotEmpty()
    }

    private data class TextTrack(val group: Tracks.Group, val index: Int)

    private fun textTracks(p: ExoPlayer): List<TextTrack> =
        p.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
            .flatMap { g -> (0 until g.length).filter { g.isTrackSupported(it) }.map { TextTrack(g, it) } }

    private fun selectedEmbedded(p: ExoPlayer): TextTrack? =
        if (p.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) null
        else textTracks(p).firstOrNull { it.group.isTrackSelected(it.index) }

    private fun applyTextSelection(p: ExoPlayer) {
        val b = p.trackSelectionParameters.buildUpon()
        if (prefSubLangs.isNotEmpty()) b.setPreferredTextLanguages(*prefSubLangs.toTypedArray())
        // A file can mark one of its subtitle tracks "default", and the player then shows it
        // whatever its language. Once the viewer has subtitle languages (Settings), that mark is
        // ignored: only a track in one of those languages shows by itself. Two things are left as
        // they were: a "forced" track still shows when it is in the language of the audio that is
        // playing (it carries the lines spoken in another language), and a track picked in the
        // panel is an override, which this setting doesn't touch.
        b.setIgnoredTextSelectionFlags(if (prefSubLangs.isNotEmpty()) C.SELECTION_FLAG_DEFAULT else 0)
        // Settings > Language > preferred audio (it used to be ignored by the native player).
        if (prefAudioLangs.isNotEmpty()) b.setPreferredAudioLanguages(*prefAudioLangs.toTypedArray())
        b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, activeExtId != null || subsOff)
        p.trackSelectionParameters = b.build()
    }

    private fun selectOff() {
        activeExtId = null
        subsOff = true
        ext?.clear()
        player?.let { applyTextSelection(it) }
        refreshPanel()
    }

    private fun selectEmbedded(t: TextTrack) {
        activeExtId = null
        subsOff = false
        ext?.clear()
        val p = player ?: return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .setOverrideForType(TrackSelectionOverride(t.group.mediaTrackGroup, t.index))
            .build()
        refreshPanel()
    }

    private fun selectExternal(s: CatalogSub, onFail: (() -> Unit)? = null) {
        val cues = parsed[s.id]
        if (cues != null) {
            if (restoringId == s.id) {
                // Last time's subtitle is back: it stands like a pick made in the panel.
                restoringId = null
                userPickedSub = true
            }
            activeExtId = s.id
            subsOff = false
            // With the sync the viewer gave this subtitle before, if any.
            ext?.set(cues, syncStore.get(s.src))
            player?.let { applyTextSelection(it) }
            refreshPanel()
            return
        }
        if (!loading.add(s.id)) return
        refreshPanel()
        val gen = contentKey
        val ua = userAgent
        subPool.execute {
            val local = subStore.fetch(s.id, s.url, s.lang, s.label, ua)
            val list = local?.let { try { ExternalSubs.parse(it) } catch (_: Exception) { null } }
            handler.post {
                loading.remove(s.id)
                if (gen != contentKey) return@post
                if (list.isNullOrEmpty()) {
                    if (onFail != null) onFail() else toast(Strings.subtitleLoadFailed)
                    refreshPanel()
                    return@post
                }
                parsed[s.id] = list
                if (onFail != null && userPickedSub) return@post // the user chose something else meanwhile
                selectExternal(s)
            }
        }
    }

    /** Automatic choice: the best addon subtitle in a preferred language, unless an embedded
     *  track in an equally (or more) preferred language is already showing. */
    private fun maybeAutoSelectSub() {
        if (userPickedSub || autoSubDone || subsOff || prefSubLangs.isEmpty()) return
        if (restoringId != null) return // last time's subtitle is loading; this runs again if it fails
        val p = player ?: return
        if (p.currentTracks.isEmpty) return
        val embeddedRank = selectedEmbedded(p)?.let { prefRank(it.group.getTrackFormat(it.index).language) } ?: 999
        // Saved ones first (local, work offline), then addon ones when online.
        val pool = saved + if (isOnline()) catalog.filter { !isSaved(it) } else emptyList()
        val candidates = pool.filter { prefRank(it.lang) < embeddedRank }.sortedBy { prefRank(it.lang) }.take(4)
        if (candidates.isEmpty()) return
        autoSubDone = true
        autoTry(candidates, 0)
    }

    /** Try the automatic candidates in order until one downloads and parses. */
    private fun autoTry(candidates: List<CatalogSub>, i: Int) {
        if (i >= candidates.size || userPickedSub) return
        selectExternal(candidates[i]) { autoTry(candidates, i + 1) }
    }

    /**
     * Puts back the subtitle the viewer picked for this episode last time, once it is in the
     * lists (it comes with play, or later through addSubs). It takes the place of the automatic
     * choice; if it can no longer be loaded, the automatic choice goes ahead.
     */
    private fun tryRestoreSub() {
        val url = restoreUrl ?: return
        if (userPickedSub || subsOff) {
            restoreUrl = null
            return
        }
        val s = saved.firstOrNull { it.src == url || it.url == url } ?: catalog.firstOrNull { it.url == url } ?: return
        restoreUrl = null
        if (activeExtId == s.id) {
            userPickedSub = true
            return
        }
        restoringId = s.id
        selectExternal(s) {
            if (restoringId == s.id) restoringId = null
            maybeAutoSelectSub()
        }
    }

    private fun addToCatalog(arr: JSONArray?) {
        if (arr == null || arr.length() == 0 || source?.optBoolean("isLive") == true) return
        var added = 0
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val url = o.optString("url").takeIf { it.isNotBlank() } ?: continue
            val lang = o.optString("lang").takeIf { it.isNotBlank() }
            val label = o.optString("label").ifBlank { langName(lang) }
            if (url.startsWith("file:")) {
                // A subtitle saved on the phone (offline playback): list it with the saved ones.
                if (saved.none { it.url == url }) {
                    saved.add(CatalogSub(savedId(url), url, lang, if (lang != null) label.substringAfter(" · ", label) else label))
                    added++
                }
                continue
            }
            if (!catalogUrls.add(url)) continue
            catalog.add(CatalogSub("s${++subSeq}", url, lang, label))
            added++
        }
        if (added == 0) return
        tryRestoreSub()
        maybeAutoSelectSub()
        if (panel?.isOpen == true && panelKind == "subs") refreshPanel()
    }

    private fun applySubStyle() {
        subStyle.applyTo(view?.subtitleView)
        subStyle.applyTo(extView)
    }

    /** The delay the "look and timing" tab shows: a synced subtitle's is its sync's nudge. */
    private fun subDelayMs(): Long {
        val e = ext ?: return 0
        return e.sync?.let { Math.round(it.nudge * 1000) } ?: e.delayMs
    }

    private fun setSubDelay(ms: Long) {
        if (activeExtId == null) {
            toast(Strings.delayAddonOnly)
            return
        }
        val delay = ms.coerceIn(-600_000, 600_000)
        // A subtitle with a sync state is timed by it alone, so its delay is edited there: the
        // plain delay on top would move it twice.
        val sync = ext?.sync
        if (sync != null) applySync(TextSync.withNudge(sync, delay / 1000.0)) else ext?.delayMs = delay
    }

    // ---- subtitle sync ---------------------------------------------------------------------

    /** The addon (or saved) subtitle that is showing. */
    private fun activeSub(): CatalogSub? {
        val id = activeExtId ?: return null
        return saved.firstOrNull { it.id == id } ?: catalog.firstOrNull { it.id == id }
    }

    /** Only a subtitle drawn by this player's own renderer has a list of lines to sync. */
    private fun canSync() = activeSub() != null && ext?.active == true

    /** A new sync state for the subtitle that is showing: drawn at once, and kept on the device
     *  under the subtitle's address (for a saved one, the address it was saved from). */
    private fun applySync(state: TextSync.State) {
        val sub = activeSub() ?: return
        ext?.setSync(state)
        syncStore.put(sub.src, state)
    }

    /**
     * Opens the sync panel for the subtitle that is showing. From here on that subtitle is timed
     * by its sync state alone: the plain delay it had so far becomes the state's nudge, and the
     * plain delay goes back to zero.
     */
    private fun openSync() {
        val e = ext ?: return
        val sub = activeSub() ?: return
        if (!e.active) return
        if (e.sync == null) {
            applySync(TextSync.withNudge(TextSync.State(), e.delayMs / 1000.0))
            e.delayMs = 0
        }
        // The video is watched and listened to beside this panel: no dimming, and a tap on the
        // picture pauses or plays instead of closing it.
        val p = openPanel("sync", Strings.syncSubtitle, dim = false, onOutsideTap = { togglePlay() }, onClose = { closeSync() })
        // Pausing to look for a line would bring the playback controls up by themselves, under
        // the panel and out of reach.
        view?.controllerAutoShow = false
        syncPanelFor = sub.src
        syncPanel = SyncPanel(activity, p, e, syncHost).also { it.build() }
        // The subtitle itself moves into the part of the picture the panel leaves free, so the
        // result of an alignment can be read on the video.
        val rtl = activity.uiDirection() == View.LAYOUT_DIRECTION_RTL
        extView?.setPadding(if (rtl) p.widthPx else 0, 0, if (rtl) 0 else p.widthPx, 0)
    }

    private fun closeSync() {
        syncPanel?.close()
        syncPanel = null
        syncPanelFor = null
        extView?.setPadding(0, 0, 0, 0)
        view?.let { v ->
            v.controllerAutoShow = true
            // Left paused: the controls it would have shown come up now.
            if (isShowing && player?.playWhenReady == false) v.showController()
        }
    }

    private fun togglePlay() {
        val p = player ?: return
        if (p.playWhenReady) p.pause() else p.play()
    }

    private val syncHost = object : SyncPanel.Host {
        override fun positionMs(): Long? = player?.currentPosition
        override fun isPlaying(): Boolean = player?.playWhenReady == true
        override fun togglePlay() = this@NativePlayer.togglePlay()
        override fun seekTo(ms: Long) {
            val p = player ?: return
            p.seekTo(ms.coerceIn(0, durationOrMax(p)))
        }
        override fun setSync(state: TextSync.State) {
            // Not after the subtitle the panel lists has gone.
            if (activeSub()?.src == syncPanelFor) applySync(state)
        }
        override fun close() {
            panel?.dismiss()
        }
        override fun keyboardClosed() {
            // The keyboard can bring the system bars back over the video.
            if (isShowing) activity.setFullscreenMode(true)
        }
    }

    // ---- audio + speed ---------------------------------------------------------------------

    private fun openAudio() {
        openPanel("audio", Strings.audioAndSpeed)
        renderAudio()
    }

    private fun audioName(f: Format): String {
        val codec = when (f.sampleMimeType) {
            MimeTypes.AUDIO_AC3 -> "Dolby Digital"
            MimeTypes.AUDIO_E_AC3 -> "Dolby Digital Plus"
            MimeTypes.AUDIO_E_AC3_JOC -> "Dolby Atmos"
            MimeTypes.AUDIO_TRUEHD -> "Dolby TrueHD"
            MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_EXPRESS -> "DTS"
            MimeTypes.AUDIO_DTS_HD -> "DTS-HD"
            MimeTypes.AUDIO_AAC -> "AAC"
            MimeTypes.AUDIO_OPUS -> "Opus"
            MimeTypes.AUDIO_FLAC -> "FLAC"
            MimeTypes.AUDIO_MPEG -> "MP3"
            MimeTypes.AUDIO_VORBIS -> "Vorbis"
            else -> f.sampleMimeType?.substringAfter('/')?.uppercase()
        }
        val ch = when (f.channelCount) {
            1 -> Strings.mono; 2 -> Strings.stereo; 6 -> "5.1"; 8 -> "7.1"
            Format.NO_VALUE -> null
            else -> "${f.channelCount}ch"
        }
        return listOfNotNull(codec, ch).joinToString(" · ")
    }

    private fun renderAudio() {
        val p = panel ?: return
        val pl = player ?: return
        p.clear()
        val groups = pl.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        p.section(Strings.audioTrack)
        if (groups.isEmpty()) p.note(Strings.noAudioTracks)
        groups.forEach { g ->
            for (i in 0 until g.length) {
                if (!g.isTrackSupported(i)) continue
                val f = g.getTrackFormat(i)
                p.row(
                    f.label?.takeIf { it.isNotBlank() } ?: langName(f.language),
                    audioName(f).ifBlank { null },
                    selected = g.isTrackSelected(i),
                ) {
                    pl.trackSelectionParameters = pl.trackSelectionParameters.buildUpon()
                        .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i))
                        .build()
                    handler.postDelayed({ refreshPanel() }, 250)
                }
            }
        }
        p.section(Strings.playbackSpeed)
        val speeds = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)
        val cur = pl.playbackParameters.speed
        p.chips(speeds.map { s ->
            Triple((if (s == 1f) Strings.normalSpeed else "${s}x"), kotlin.math.abs(cur - s) < 0.01f) {
                pl.playbackParameters = PlaybackParameters(s)
                renderAudio()
            }
        })
        sleepTitle = p.section(sleepTitleText())
        // A live channel has no end to wait for.
        val live = source?.optBoolean("isLive") == true
        p.chips(
            listOf(Triple(Strings.sleepOff, !sleep.armed) { setSleep() }) +
                SleepTimer.PRESETS.map { m -> Triple(Strings.minutes(m), sleep.minutes == m) { setSleep(minutes = m) } } +
                (if (live) emptyList() else listOf(Triple(Strings.sleepEndOfVideo, sleep.endOfVideo) { setSleep(atEnd = true) })),
        )
        handler.removeCallbacks(sleepTitleTick)
        if (sleep.minutes > 0) handler.postDelayed(sleepTitleTick, SLEEP_TITLE_EVERY_MS)
    }

    // ---- sleep timer -----------------------------------------------------------------------

    /** The section heading says how long is left while a countdown runs. */
    private fun sleepTitleText(): String =
        if (sleep.minutes > 0) Strings.sleepTimerLeft(sleep.remainingMinutes(SystemClock.elapsedRealtime())) else Strings.sleepTimer

    /** Keeps the minutes in the heading current while the panel stays open. */
    private val sleepTitleTick = object : Runnable {
        override fun run() {
            if (panel?.isOpen != true || panelKind != "audio" || sleep.minutes == 0) return
            sleepTitle?.text = sleepTitleText()
            handler.postDelayed(this, SLEEP_TITLE_EVERY_MS)
        }
    }

    /** A chip of the sleep timer: so many minutes, the end of this video, or (neither) off. */
    private fun setSleep(minutes: Int = 0, atEnd: Boolean = false) {
        handler.removeCallbacks(sleepFire)
        sleepHeld = false
        when {
            atEnd -> sleep.setEndOfVideo()
            minutes > 0 -> handler.postDelayed(sleepFire, sleep.setMinutes(minutes, SystemClock.elapsedRealtime()))
            else -> sleep.off()
        }
        if (panel?.isOpen == true && panelKind == "audio") renderAudio()
    }

    /** The sleep timer is up: pause where the video is (the player stays open) and say why. */
    private fun fireSleep() {
        handler.removeCallbacks(sleepFire)
        sleep.off()
        player?.let { p ->
            sleepHeld = reconnecting
            p.pause()
        }
        flash(R.drawable.ic_pause, Strings.sleepTimerPaused, holdMs = 6000)
        if (panel?.isOpen == true && panelKind == "audio") renderAudio()
    }

    /**
     * "End of this video", when the video got to its very end before the ticker saw it coming (a
     * seek to the last seconds): pause a few seconds back from the end instead, and keep the end
     * from the page, which would go on to the next episode or close the player. True when it did.
     */
    private fun sleepAtEnd(p: ExoPlayer): Boolean {
        if (!sleep.endOfVideo) return false
        val dur = knownDuration(p)
        fireSleep()
        if (dur <= 0) return false
        p.pause()
        p.seekTo((dur - SleepTimer.END_BACK_OFF_MS).coerceAtLeast(0))
        return true
    }

    // =========================================================================================
    // JS commands
    // =========================================================================================

    fun command(json: String) {
        val c = try { JSONObject(json) } catch (_: Exception) { return }
        when (c.optString("cmd")) {
            "meta" -> {
                c.optString("title").takeIf { it.isNotBlank() }?.let { title = it }
                subtitleLine = c.optString("subtitle", "")
                hasNext = c.optBoolean("hasNext", false)
                showQuality = c.optBoolean("showQuality", false)
                streamQualityLabel = c.optString("quality", "")
                updateChrome()
                return
            }
            "streams" -> {
                streamsPayload = c
                if (panelKind == "streams") renderStreams()
                return
            }
            "streamFailed" -> {
                pickingStream = null
                toast(c.optString("message").ifBlank { Strings.sourceFailedTryAnother })
                if (panelKind == "streams") renderStreams()
                return
            }
            "subSearch" -> {
                searching = false
                val n = c.optInt("count", 0)
                if (c.optBoolean("manual")) toast(if (n == 0) Strings.noAddonSubtitlesFound else Strings.subtitlesFound(n))
                if (panelKind == "subs") refreshPanel()
                return
            }
            "addSubs" -> {
                val langs = jsonStrings(c.optJSONArray("prefLangs"))
                if (langs.isNotEmpty()) prefSubLangs = langs
                addToCatalog(c.optJSONArray("subs"))
                return
            }
            "segments" -> {
                // Intro / recap / credits of the title named by contentKey (an empty list: none).
                val key = c.optString("contentKey", "")
                if (key != segmentsKey) {
                    segmentsKey = key
                    autoSkipped.clear()
                }
                segments = SkipSegments.parse(c.optJSONArray("segments"))
                autoSkipIntro = c.optBoolean("autoSkipIntro", false)
                updateSkip()
                return
            }
        }
        val p = player ?: return
        when (c.optString("cmd")) {
            "play" -> p.play()
            "pause" -> p.pause()
            "seek" -> p.seekTo(c.optLong("ms", 0).coerceAtLeast(0))
            "rate" -> {
                val rate = c.optDouble("rate", 1.0).toFloat().coerceIn(0.25f, 4f)
                // During a hold for double speed it becomes the speed to go back to.
                if (holdPrevSpeed != null) holdPrevSpeed = rate else p.setPlaybackSpeed(rate)
            }
            "volume" -> p.volume = c.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f)
        }
        sendState()
    }

    /** User closed the player: tell the web UI to leave the player view. */
    fun close() = stop(notify = true)

    fun stop(notify: Boolean) {
        val p = player
        if (notify && p != null) {
            sendState()
            emit(
                JSONObject()
                    .put("type", "closed")
                    .put("positionMs", p.currentPosition)
                    .put("durationMs", if (p.duration == C.TIME_UNSET) 0 else p.duration)
                    .toString(),
            )
        }
        panel?.dismiss()
        releasePlayer()
        source = null
        pickingStream = null
        ext?.clear()
        // The sleep timer ends with the player. (The skip segments stay: the page clears them when
        // it leaves the player, and play() does for another title.)
        handler.removeCallbacks(sleepFire)
        handler.removeCallbacks(sleepTitleTick)
        sleep.off()
        sleepHeld = false
        offeredSkip = null; dismissedSkip = null; creditsToEnd = false
        if (locked) setLocked(false)
        view?.let {
            it.player = null
            it.visibility = View.GONE
        }
        listOfNotNull(topBar, nextButton, skipButton, indicator, unlockButton).forEach { it.visibility = View.GONE }
        if (brightnessTouched) {
            val a = activity.window.attributes
            a.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            activity.window.attributes = a
            brightnessTouched = false
        }
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        activity.setFullscreenMode(false)
        RefreshRate.apply(activity)
    }

    fun onHostPause() {
        // In picture-in-picture the activity is paused but still on screen: keep playing.
        if (Build.VERSION.SDK_INT >= 24 && activity.isInPictureInPictureMode) return
        player?.pause()
    }

    /** The app went fully out of sight (also: the picture-in-picture window was closed). */
    fun onHostStop() {
        player?.pause()
    }

    private fun releasePlayer() {
        endHoldSpeed()
        handler.removeCallbacks(ticker)
        handler.removeCallbacks(reconnect)
        reconnecting = false
        unwatchNetwork()
        session?.release()
        session = null
        player?.release()
        player = null
        view?.keepScreenOn = false
    }

    private fun toast(msg: String) = Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()

    private fun sendState() {
        val p = player ?: return
        val dur = if (p.duration == C.TIME_UNSET) 0 else p.duration
        val vs = p.videoSize
        emit(
            JSONObject()
                .put("type", "state")
                .put("positionMs", p.currentPosition)
                .put("durationMs", dur)
                .put("bufferedMs", p.bufferedPosition)
                .put("playing", p.isPlaying)
                .put("playWhenReady", p.playWhenReady)
                .put("buffering", p.playbackState == Player.STATE_BUFFERING)
                .put("ended", p.playbackState == Player.STATE_ENDED)
                .put("ready", p.playbackState == Player.STATE_READY)
                // A hold for double speed is not the viewer's speed setting: the page keeps seeing
                // the speed from before it.
                .put("rate", (holdPrevSpeed ?: p.playbackParameters.speed).toDouble())
                .put("width", vs.width)
                .put("height", vs.height)
                .toString(),
        )
    }

    private fun errorCode(e: PlaybackException): String = when (e.errorCode) {
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED -> "decode"
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED -> "codec"
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
        PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE -> "network"
        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED -> "source"
        else -> "unknown"
    }

    private companion object {
        /** How long a dropped stream keeps trying before the player gives up and says so. */
        const val RECONNECT_BUDGET_MS = 120_000L
        const val HTTP_CONNECT_TIMEOUT_MS = 20_000
        const val HTTP_READ_TIMEOUT_MS = 30_000
        /** Heights of the two pill buttons in the corner, for stacking one above the other. */
        const val NEXT_BUTTON_DP = 42
        const val SKIP_BUTTON_DP = 42
        /** Holding a finger on the video plays at this speed. */
        const val HOLD_SPEED = 2f
        /** Longer than anyone holds: the "2x" indicator is taken down when the finger lifts. */
        const val HOLD_INDICATOR_MS = 30 * 60_000L
        const val SLEEP_TITLE_EVERY_MS = 10_000L
    }
}

/**
 * Network hiccups get more and slower retries before ExoPlayer reports an error (the default is
 * three quick ones). A 4xx answer means the link itself is dead: no retries for that.
 */
@OptIn(UnstableApi::class)
private class PatientLoadErrorPolicy : DefaultLoadErrorHandlingPolicy(6) {
    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val base = super.getRetryDelayMsFor(loadErrorInfo)
        if (base == C.TIME_UNSET) return base
        val e = loadErrorInfo.exception
        if (e is HttpDataSource.InvalidResponseCodeException && e.responseCode in 400..499 && e.responseCode != 429) return C.TIME_UNSET
        return minOf(loadErrorInfo.errorCount * 1500L, 8000L)
    }
}
