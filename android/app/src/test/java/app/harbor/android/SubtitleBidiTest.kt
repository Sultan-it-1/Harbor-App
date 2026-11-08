package app.harbor.android

import org.junit.Assert.assertEquals
import org.junit.Test

class SubtitleBidiTest {
    private val rlm = "‏"

    @Test fun arabicLineStartingWithLatinGetsRlm() {
        assertEquals("${rlm}iPhone الجديد.", SubtitleBidi.fixString("iPhone الجديد."))
        assertEquals("${rlm}John هنا!", SubtitleBidi.fixString("John هنا!"))
    }

    @Test fun arabicFirstLineIsLeftAlone() {
        assertEquals("مرحبا John.", SubtitleBidi.fixString("مرحبا John."))
        assertEquals("- كيف حالك؟", SubtitleBidi.fixString("- كيف حالك؟"))
    }

    @Test fun latinOnlyIsLeftAlone() {
        assertEquals("Hello there.", SubtitleBidi.fixString("Hello there."))
    }

    @Test fun eachLineIsDecidedOnItsOwn() {
        assertEquals("مرحبا\n${rlm}Netflix هنا.", SubtitleBidi.fixString("مرحبا\nNetflix هنا."))
    }

    @Test fun alreadyFixedIsNotDoubled() {
        assertEquals("${rlm}iPhone الجديد.", SubtitleBidi.fixString("${rlm}iPhone الجديد."))
    }

    @Test fun digitsFirstThenArabicIsRtlAlready() {
        // Digits are not strong characters: the first strong letter is Arabic.
        assertEquals("10 دقائق.", SubtitleBidi.fixString("10 دقائق."))
    }
}
