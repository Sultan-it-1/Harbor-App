package app.harbor.android

import android.content.Context
import java.util.Locale

/**
 * Every text the native side shows on its own (the player and its panels, the download
 * notifications), in the app's two languages. The language is a setting of the web page, not the
 * phone's: the page says it through HarborAndroid.setLanguage, and it is saved so the download
 * service and the after-boot notice use it while the page isn't running.
 *
 * Until the page has said its language these texts are Arabic, as they always were.
 * (The native Home screens are not here: the page sends their texts with their model.)
 */
object Strings {
    private const val PREFS = "harbor.app"
    private const val KEY = "lang"

    /** "ar" or "en". */
    @Volatile var lang: String = "ar"
        private set

    /** Whether the page has ever said its language (in this run or an earlier one). Until then
     *  the layout direction and language names follow the phone, as before. */
    @Volatile var known: Boolean = false
        private set

    @Volatile private var loaded = false

    val arabic: Boolean get() = lang == "ar"

    /** For names the system translates (subtitle and audio languages). */
    val locale: Locale get() = if (known) Locale.forLanguageTag(lang) else Locale.getDefault()

    /** Reads the saved language once. Called from every way into the app's process: the
     *  activity, the download service and the boot receiver. */
    fun load(ctx: Context) {
        if (loaded) return
        loaded = true
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.let { use(it) }
    }

    /** The page's language; saved for the next run. True when the texts changed. */
    fun set(ctx: Context, language: String): Boolean {
        val before = lang
        val wasKnown = known
        if (!use(language)) return false
        loaded = true
        if (lang == before && wasKnown) return false
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, lang).apply()
        return true
    }

    /** "ar" (or a regional "ar-…") is Arabic; any other language is English, like on the page.
     *  A blank value changes nothing. */
    internal fun use(language: String): Boolean {
        val l = language.trim().lowercase()
        if (l.isEmpty()) return false
        lang = if (l == "ar" || l.startsWith("ar-") || l.startsWith("ar_")) "ar" else "en"
        known = true
        return true
    }

    /** Back to the state of a first launch (unit tests). */
    internal fun forget() {
        lang = "ar"
        known = false
        loaded = false
    }

    private fun t(en: String, ar: String, arabic: Boolean = this.arabic): String = if (arabic) ar else en

    // ---- player: messages over the video ----
    val sourceSwitched get() = t("Source switched", "تم تبديل المصدر")
    val reconnecting get() = t("Reconnecting…", "جارٍ إعادة الاتصال…")
    val waitingForInternetEllipsis get() = t("Waiting for internet…", "بانتظار الإنترنت…")
    val backOnline get() = t("Back online", "رجع الاتصال")
    val streamDropped get() = t("The stream dropped. Press ▶ to try again", "انقطع البث. اضغط ▶ للمحاولة مرة ثانية")
    val sourceFailedRetry get() = t("This source couldn't be played. Press ▶ to try again or pick another source", "تعذّر تشغيل هذا المصدر. اضغط ▶ للمحاولة أو اختر مصدراً آخر")
    val sourceFailedTryAnother get() = t("This source couldn't be played, try another", "تعذّر تشغيل هذا المصدر، جرّب غيره")
    val screenLocked get() = t("Screen locked", "الشاشة مقفلة")
    val play get() = t("Play", "تشغيل")
    val pause get() = t("Pause", "إيقاف مؤقت")
    val fillScreen get() = t("Fill screen", "ملء الشاشة")
    val stretch get() = t("Stretch", "تمديد")
    val originalSize get() = t("Original size", "الحجم الأصلي")
    fun seconds(n: Int) = t("${n}s", "$n ث")
    val introSkipped get() = t("Intro skipped", "تم تخطّي المقدمة")
    val sleepTimerPaused get() = t("Sleep timer: paused", "مؤقت الإيقاف: توقف التشغيل")
    /** Shown while a finger holds the video down. */
    val doubleSpeed get() = t("2x speed", "سرعة 2x")
    val noVideoPlayerApp get() = t("No video player app found", "ما فيه تطبيق لتشغيل الفيديو")

    // ---- player: top bar ----
    val back get() = t("Back", "رجوع")
    val sources get() = t("Sources", "المصادر")
    val subtitles get() = t("Subtitles", "الترجمة")
    val audioAndSpeed get() = t("Audio & speed", "الصوت والسرعة")
    val pictureSize get() = t("Picture size", "حجم الصورة")
    val lockScreen get() = t("Lock screen", "قفل الشاشة")
    val unlock get() = t("Unlock", "فتح القفل")
    val nextEpisode get() = t("Next episode", "الحلقة التالية")
    val skipIntro get() = t("Skip intro", "تخطّي المقدمة")
    val skipRecap get() = t("Skip recap", "تخطّي الملخص")
    val skipCredits get() = t("Skip credits", "تخطّي الشارة")
    val close get() = t("Close", "إغلاق")

    // ---- player: sources panel ----
    val fetchingSources get() = t("Fetching sources…", "جارٍ جلب المصادر…")
    val noOtherSources get() = t("There are no other sources for this title.", "ما فيه مصادر ثانية لهذا العنوان.")
    val noSourcesInQuality get() = t("No sources in this quality.", "ما فيه مصادر بهذه الجودة.")
    val all get() = t("All", "الكل")
    val openInAnotherPlayer get() = t("Open in another player", "فتح في مشغّل آخر")
    val anotherPlayerHeadersNote get() = t(
        "This source needs extra request headers. Some players ignore them, so it may not play there.",
        "هذا المصدر يحتاج ترويسات طلب إضافية. بعض المشغّلات تتجاهلها، فممكن ما يشتغل فيها.",
    )

    // ---- player: subtitles panel ----
    val unknownLanguage get() = t("Unknown", "غير محددة")
    val subtitlesTab get() = t("Subtitles", "الترجمات")
    val lookAndTiming get() = t("Look & timing", "المظهر والتوقيت")
    val noSubtitles get() = t("No subtitles", "بدون ترجمة")
    fun embedded(n: Int) = t("In the file ($n)", "مدمجة في الملف ($n)")
    val forced get() = t("Forced", "إجبارية")
    fun savedOnDevice(n: Int) = t("Saved on this device ($n)", "محفوظة على الجهاز ($n)")
    val fromAddons get() = t("From addons", "من الإضافات")
    fun fromAddonsCount(n: Int) = t("From addons ($n)", "من الإضافات ($n)")
    val offlineNoSaved get() = t(
        "You're offline. Addon subtitles need internet, and no subtitles are saved with this video.",
        "أنت بدون إنترنت. ترجمات الإضافات تحتاج إنترنت، وما فيه ترجمات محفوظة مع هذا الفيديو.",
    )
    val offlineSavedOnly get() = t(
        "You're offline, so only the subtitles saved on this device are shown.",
        "أنت بدون إنترنت، فتظهر الترجمات المحفوظة على الجهاز فقط.",
    )
    val searchingAddons get() = t("Searching the addons…", "جارٍ البحث في الإضافات…")
    val noAddonSubtitlesYet get() = t("No subtitles have come from the addons yet.", "ما وصلت ترجمات من الإضافات بعد.")
    val saveButtonHint get() = t(
        "The download button next to a subtitle saves it with the video, so it works offline.",
        "زر التحميل جنب كل ترجمة يحفظها مع الفيديو عشان تشتغل بدون إنترنت.",
    )
    val pickLanguageAbove get() = t("Pick a language above to see its subtitles.", "اختر لغة من فوق عشان تظهر ترجماتها.")
    val saveSubtitleWithVideo get() = t("Save this subtitle with the video", "حفظ الترجمة مع الفيديو")
    val searching get() = t("Searching…", "جارٍ البحث…")
    val getAddonSubtitles get() = t("Get subtitles from the addons", "جلب ترجمات من الإضافات")
    val subtitleSaved get() = t("Subtitle saved with the video", "انحفظت الترجمة مع الفيديو")
    val subtitleSaveFailed get() = t("Couldn't save this subtitle, try another", "تعذّر حفظ هذه الترجمة، جرّب غيرها")
    val subtitleLoadFailed get() = t("Couldn't load this subtitle, try another", "تعذّر تحميل هذه الترجمة، جرّب غيرها")
    val noAddonSubtitlesFound get() = t("No subtitles found in the addons", "ما لقيت ترجمات من الإضافات")
    fun subtitlesFound(n: Int) = t(if (n == 1) "Found 1 subtitle" else "Found $n subtitles", "لقيت $n ترجمة")
    val delayAddonOnly get() = t("Delay works on addon subtitles", "التأخير يشتغل على ترجمات الإضافات")

    // ---- player: subtitle look and timing ----
    fun size(percent: Int) = t("Size · $percent%", "الحجم · $percent%")
    val smaller get() = t("Smaller −", "أصغر −")
    val bigger get() = t("Bigger +", "أكبر +")
    val background get() = t("Background", "الخلفية")
    val shadow get() = t("Shadow", "ظل")
    val outline get() = t("Outline", "إطار")
    val box get() = t("Box", "خلفية")
    val none get() = t("None", "بدون")
    fun boxOpacity(percent: Int) = t("Box opacity · $percent%", "شفافية الخلفية · $percent%")
    val color get() = t("Color", "اللون")
    val white get() = t("White", "أبيض")
    val yellow get() = t("Yellow", "أصفر")
    val cyan get() = t("Cyan", "سماوي")
    val green get() = t("Green", "أخضر")
    val position get() = t("Position", "المكان")
    val lower get() = t("Lower ↓", "أنزل ↓")
    val higher get() = t("Higher ↑", "أرفع ↑")
    val defaultValue get() = t("Default", "الافتراضي")
    val font get() = t("Font", "الخط")
    val bold get() = t("Bold", "عريض")
    /** [seconds] comes ready-made, e.g. "+0.5". */
    fun delay(seconds: String) = t("Delay · ${seconds}s", "التأخير · $seconds ث")
    val delayNeedsAddonSubtitle get() = t(
        "Delay works on addon subtitles. Pick a subtitle from the addons first.",
        "التأخير يشتغل على ترجمات الإضافات. اختر ترجمة من الإضافات أول.",
    )
    val delayHint get() = t("Positive = the subtitle comes later, negative = earlier.", "موجب = الترجمة تتأخر، سالب = تطلع أبكر.")
    val resetLook get() = t("Reset the look", "رجّع المظهر الافتراضي")
    /** Under the delay of a subtitle that has been synced: the delay is the sync's own nudge. */
    val delayOnSyncedSubtitle get() = t(
        "This subtitle is synced. The delay here is a fine adjustment on top of the sync.",
        "هذه الترجمة مضبوطة بالمزامنة. التأخير هنا تعديل دقيق فوق المزامنة.",
    )

    // ---- player: subtitle sync (aligning an addon subtitle to the sound by ear) ----
    val sync get() = t("Sync", "مزامنة")
    val syncSubtitle get() = t("Sync subtitle", "مزامنة الترجمة")
    val syncNeedsAddonSubtitle get() = t(
        "Syncing works on addon subtitles. Pick a subtitle from the addons first.",
        "المزامنة تشتغل على ترجمات الإضافات. اختر ترجمة من الإضافات أول.",
    )
    val syncNotForEmbedded get() = t(
        "The lines of a subtitle that is part of the video file can't be listed, so it can't be synced here. Pick a subtitle from the addons instead.",
        "سطور الترجمة المدمجة في ملف الفيديو ما تنعرض في قائمة، فما تنضبط من هنا. اختر ترجمة من الإضافات بدالها.",
    )
    val syncOpen get() = t("Sync the subtitle to the sound", "مزامنة الترجمة مع الصوت")
    val alignToNow get() = t("Align to now", "حاذِ مع الآن")
    val jumpHere get() = t("Jump here", "انتقل إلى هنا")
    val syncReset get() = t("Reset", "إعادة ضبط")
    val done get() = t("Done", "تم")
    /** Back to the line being spoken, and keep following it. */
    val syncNow get() = t("Now", "الآن")
    /** [seconds] comes ready-made, e.g. "+0.5". */
    fun syncOffset(seconds: String) = t("${seconds}s", "$seconds ث")
    fun syncAnchors(set: Int) = t("Anchors: $set of 2", "نقاط الضبط: $set من 2")
    val syncHintFirst get() = t(
        "When you hear a line, tap it in the list, then “Align to now”.",
        "لما تسمع جملة، اضغط سطرها في القائمة ثم «حاذِ مع الآن».",
    )
    val syncHintSecond get() = t(
        "If it drifts again later in the film, jump to a line far from the first and align that one too.",
        "إذا رجعت الترجمة تنحرف بعدين، انتقل إلى سطر بعيد عن الأول وحاذِه أيضاً.",
    )
    val syncHintBoth get() = t(
        "Both anchors are set. Aligning another line replaces the second one.",
        "انضبطت النقطتان. محاذاة سطر آخر تأخذ مكان الثانية.",
    )
    val syncTooClose get() = t(
        "The two anchors are too close together, so only the last one counts. Pick the second far from the first.",
        "النقطتان قريبتان من بعض، فانحسبت الأخيرة فقط. اختر الثانية بعيدة عن الأولى.",
    )
    val syncTooSteep get() = t(
        "The two anchors disagree too much, so only the last one counts. One of them may be on the wrong line.",
        "النقطتان ما تتفقان، فانحسبت الأخيرة فقط. يمكن واحدة منهما على سطر غلط.",
    )
    /** A run of lines that is off by itself (another cut of the film): marked, then aligned. */
    val syncSection get() = t("Fix one section", "تصحيح مقطع واحد")
    fun syncSections(n: Int) = t("Sections: $n", "المقاطع: $n")
    val sectionPickFirst get() = t("Only one part is off? Tap its first line.", "جزء واحد فقط غلط؟ اضغط أول سطر فيه.")
    val sectionPickLast get() = t("Now tap its last line.", "والآن اضغط آخر سطر فيه.")
    val sectionAlignInside get() = t(
        "Open the line you hear inside the marked part and tap “Align to now”. Only that part moves.",
        "افتح السطر اللي تسمعه داخل الجزء المحدد واضغط «حاذِ مع الآن». هذا الجزء فقط يتحرك.",
    )
    val syncSearch get() = t("Search the lines", "ابحث في السطور")
    val syncNoMatches get() = t("No line has these words.", "ما فيه سطر بهذه الكلمات.")

    // ---- player: audio and speed ----
    val mono get() = t("Mono", "أحادي")
    val stereo get() = t("Stereo", "ستيريو")
    val audioTrack get() = t("Audio track", "المسار الصوتي")
    val noAudioTracks get() = t("There are no audio tracks.", "ما فيه مسارات صوت.")
    val playbackSpeed get() = t("Playback speed", "سرعة التشغيل")
    val normalSpeed get() = t("Normal", "عادي")
    val sleepTimer get() = t("Sleep timer", "مؤقت الإيقاف")
    fun sleepTimerLeft(minutes: Int) = t("Sleep timer · $minutes min left", "مؤقت الإيقاف · باقي $minutes دقيقة")
    val sleepOff get() = t("Off", "إيقاف")
    fun minutes(n: Int) = t("$n min", "$n دقيقة")
    val sleepEndOfVideo get() = t("End of this video", "نهاية هذا الفيديو")

    // ---- download notifications ----
    val downloadsChannel get() = t("Downloads", "التحميلات")
    val downloadsChannelAbout get() = t("Progress of the downloads running in the background", "تقدّم التحميلات اللي تشتغل في الخلفية")
    val preparingDownloads get() = t("Preparing the downloads…", "يجهّز التحميلات…")
    fun downloadingFiles(n: Int) = t(
        if (n == 1) "Downloading 1 file" else "Downloading $n files",
        "جارٍ تحميل " + when {
            n == 1 -> "ملف واحد"
            n == 2 -> "ملفين"
            n in 3..10 -> "$n ملفات"
            else -> "$n ملف"
        },
    )
    fun sizeOf(received: String, total: String) = t("$received of $total", "$received من $total")
    val waitingForInternet get() = t("Waiting for internet", "بانتظار الإنترنت")
    val waitingForWifi get() = t("Waiting for Wi-Fi", "بانتظار الواي فاي")
    val retryingSoon get() = t("Retrying shortly…", "يعيد المحاولة بعد شوي…")
    val queued get() = t("Queued", "في الانتظار")
    val downloadsPaused get() = t("Downloads paused", "توقفت التحميلات مؤقتاً")
    val tapToContinueDownloads get() = t("Tap to carry on with the downloads from where they stopped", "اضغط لمتابعة التحميلات من حيث وقفت")
    val downloadFinished get() = t("Download finished", "اكتمل التحميل")
    val downloadFailed get() = t("Download failed", "تعذّر التحميل")
    fun downloadFailedHint(title: String) = t("$title · Open Downloads and tap Retry", "$title · افتح التحميلات واضغط إعادة المحاولة")
    /** Why a download ended as failed when the source answered with its short "not ready" clip
     *  (HttpTransfer.Problem.TOO_SMALL); the Downloads page says the same from the code "placeholder". */
    val downloadPlaceholder get() = t(
        "This source wasn't ready: it sent a short placeholder, not the video. Delete it and pick another source.",
        "هذا المصدر لم يكن جاهزاً: أرسل مقطعاً قصيراً بدل الفيديو. احذفه واختر مصدراً آخر.",
    )
    fun downloadPlaceholderHint(title: String) = t("$title · The source wasn't ready. Pick another source", "$title · المصدر لم يكن جاهزاً. اختر مصدراً آخر")

    // ---- the app's own window ----
    // These can show before the page has ever run (a first launch, a WebView too old to draw the
    // page), so the caller says which language: the app's once it is known, the phone's until then.
    fun swipeBackAgain(arabic: Boolean) = t("Swipe back again to leave", "اسحب رجوع مرة ثانية للخروج", arabic)
    fun webViewTooOldTitle(arabic: Boolean) = t("Update Android System WebView", "حدّث Android System WebView", arabic)
    fun webViewTooOld(arabic: Boolean, needed: Int, has: Int) = t(
        "Harbor needs Android System WebView $needed or newer (this phone has $has). Update it from Google Play, otherwise pages may show up empty.",
        "يحتاج Harbor إصدار $needed أو أحدث من WebView، وجوالك فيه $has. حدّثه من Google Play وإلا قد تظهر الصفحات فاضية.",
        arabic,
    )
}
