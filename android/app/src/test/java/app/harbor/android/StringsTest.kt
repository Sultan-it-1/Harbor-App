package app.harbor.android

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The native texts: English when the app is in English, Arabic until the page has said so. */
class StringsTest {
    private val arabicLetters = Regex("[\\u0600-\\u06FF]")

    @After
    fun tearDown() = Strings.forget()

    /** Every text that takes no parameters, by its getter's name. */
    private fun texts(): Map<String, String> = Strings::class.java.methods
        .filter { it.name.startsWith("get") && it.parameterCount == 0 && it.returnType == String::class.java && it.name != "getLang" }
        .associate { it.name to it.invoke(Strings) as String }

    /** The ones that take a number or a name. */
    private fun builtTexts() = listOf(
        Strings.seconds(10), Strings.embedded(2), Strings.savedOnDevice(3), Strings.fromAddonsCount(4),
        Strings.subtitlesFound(1), Strings.subtitlesFound(7), Strings.size(130), Strings.boxOpacity(70),
        Strings.delay("+0.5"), Strings.downloadingFiles(1), Strings.downloadingFiles(4),
        Strings.sizeOf("10 MB", "1.20 GB"), Strings.downloadFailedHint("Film"), Strings.downloadPlaceholderHint("Film"),
        Strings.sleepTimerLeft(23), Strings.minutes(15),
        Strings.syncOffset("+0.5"), Strings.syncAnchors(1), Strings.syncSections(2),
    )

    @Test
    fun arabicUntilThePageHasSaidItsLanguage() {
        Strings.forget()
        assertEquals("ar", Strings.lang)
        assertFalse(Strings.known)
        val all = texts()
        assertTrue("only ${all.size} texts found", all.size > 80)
        all.forEach { (name, text) -> assertTrue("$name has no Arabic: $text", arabicLetters.containsMatchIn(text)) }
        builtTexts().forEach { assertTrue("no Arabic: $it", arabicLetters.containsMatchIn(it)) }
    }

    @Test
    fun englishShowsNoArabicAnywhere() {
        assertTrue(Strings.use("en"))
        assertTrue(Strings.known)
        assertFalse(Strings.arabic)
        texts().forEach { (name, text) ->
            assertTrue("$name is empty", text.isNotBlank())
            assertFalse("$name still has Arabic: $text", arabicLetters.containsMatchIn(text))
        }
        builtTexts().forEach { assertFalse("still has Arabic: $it", arabicLetters.containsMatchIn(it)) }
        assertEquals("Downloading 1 file", Strings.downloadingFiles(1))
        assertEquals("Downloading 3 files", Strings.downloadingFiles(3))
        assertEquals("Found 1 subtitle", Strings.subtitlesFound(1))
        assertEquals("10s", Strings.seconds(10))
    }

    @Test
    fun arabicCountsFilesItsOwnWay() {
        Strings.use("ar")
        assertEquals("جارٍ تحميل ملف واحد", Strings.downloadingFiles(1))
        assertEquals("جارٍ تحميل ملفين", Strings.downloadingFiles(2))
        assertEquals("جارٍ تحميل 5 ملفات", Strings.downloadingFiles(5))
        assertEquals("جارٍ تحميل 11 ملف", Strings.downloadingFiles(11))
    }

    @Test
    fun anyOtherLanguageIsEnglishAndABlankOneChangesNothing() {
        assertTrue(Strings.use("fr"))
        assertEquals("en", Strings.lang)
        assertTrue(Strings.use("ar-SA"))
        assertEquals("ar", Strings.lang)
        assertFalse(Strings.use("  "))
        assertEquals("ar", Strings.lang)
        assertTrue(Strings.use("EN"))
        assertEquals("en", Strings.lang)
    }

    @Test
    fun theEarlyTextsUseTheLanguageTheyAreGiven() {
        Strings.use("ar")
        assertFalse(arabicLetters.containsMatchIn(Strings.swipeBackAgain(arabic = false)))
        assertFalse(arabicLetters.containsMatchIn(Strings.webViewTooOld(arabic = false, needed = 111, has = 90)))
        Strings.use("en")
        assertTrue(arabicLetters.containsMatchIn(Strings.swipeBackAgain(arabic = true)))
        assertTrue(arabicLetters.containsMatchIn(Strings.webViewTooOldTitle(arabic = true)))
    }
}
