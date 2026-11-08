package app.harbor.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.util.zip.GZIPOutputStream

class SubtitleDecodeTest {
    private val arabic = "1\n00:00:01,000 --> 00:00:02,000\nمرحبا بكم في هذا الفيلم الجميل جدا\n\n2\n00:00:03,000 --> 00:00:04,000\nكيف حالك اليوم يا صديقي العزيز\n"

    @Test fun utf8IsKept() {
        assertEquals(arabic, SubtitleStore.decodeText(arabic.toByteArray(Charsets.UTF_8), null))
    }

    @Test fun windows1256WithoutLanguageIsGuessed() {
        val bytes = arabic.toByteArray(Charset.forName("windows-1256"))
        assertEquals("windows-1256", SubtitleStore.guessCodePage(bytes))
        assertEquals(arabic, SubtitleStore.decodeText(bytes, null))
        assertEquals(arabic, SubtitleStore.decodeText(bytes, "und"))
    }

    @Test fun kurdishTagUsesArabicCodePage() {
        val bytes = arabic.toByteArray(Charset.forName("windows-1256"))
        assertEquals(arabic, SubtitleStore.decodeText(bytes, "ku"))
    }

    @Test fun latinLegacyStaysWindows1252() {
        val fr = "1\n00:00:01,000 --> 00:00:02,000\nC'est très bien, merci. Où êtes-vous allé hier soir ?\n"
        val bytes = fr.toByteArray(Charset.forName("windows-1252"))
        assertEquals(fr, SubtitleStore.decodeText(bytes, null))
    }

    private fun srt(lines: List<String>, repeat: Int): String {
        val b = StringBuilder()
        var n = 1
        repeat(repeat) { lines.forEach { line -> b.append("$n\n00:00:${(n % 60).toString().padStart(2, '0')},000 --> 00:00:${(n % 60).toString().padStart(2, '0')},900\n$line\n\n"); n++ } }
        return b.toString()
    }

    @Test fun fullSizeFrenchAndSpanishStayLatin() {
        val fr = srt(listOf("Tu es déjà là ? Je pensais que tu étais parti.", "Ça ne fait rien, à demain.", "Où est passée la clé de la Renault ?"), 120)
        val es = srt(listOf("¿Dónde estabas? ¡No lo sé!", "Está aquí, en el salón.", "Mañana vamos a la playa, ¿sí?"), 120)
        val pt = srt(listOf("Você não vai acreditar.", "Não sei o que é isso, coração.", "Está tudo bem, irmão."), 120)
        for (text in listOf(fr, es, pt)) {
            val bytes = text.toByteArray(Charset.forName("windows-1252"))
            assertEquals("windows-1252", SubtitleStore.guessCodePage(bytes))
            assertEquals(text, SubtitleStore.decodeText(bytes, null))
        }
    }

    @Test fun arabicWithRlmMarksAndAStrayLatinLetterIsArabic() {
        val ar = srt(listOf("\u200Fمرحبا بكم في هذا الفيلم الجميل جدا", "\u200Fكيف حالك اليوم يا صديقي العزيز", "قال لي: café"), 80)
        val bytes = ar.toByteArray(Charset.forName("windows-1256"))
        assertEquals("windows-1256", SubtitleStore.guessCodePage(bytes))
        assertEquals(ar, SubtitleStore.decodeText(bytes, ""))
    }

    @Test fun allCapsRussianIsNotReadAsArabic() {
        val caps = srt(listOf("Я НЕ ЗНАЮ, ЧТО ТЕБЕ СКАЗАТЬ.", "[ЗВОНИТ ТЕЛЕФОН]", "ВСЁ БУДЕТ ХОРОШО, ПОВЕРЬ МНЕ."), 60)
        assertEquals("windows-1251", SubtitleStore.guessCodePage(caps.toByteArray(Charset.forName("windows-1251"))))
    }

    @Test fun allCapsGreekIsGreek() {
        val caps = srt(listOf("ΔΕΝ ΞΕΡΩ ΤΙ ΝΑ ΣΟΥ ΠΩ.", "[ΧΤΥΠΑΕΙ ΤΟ ΤΗΛΕΦΩΝΟ]", "ΟΛΑ ΘΑ ΠΑΝΕ ΚΑΛΑ, ΠΙΣΤΕΨΕ ΜΕ."), 60)
        assertEquals("windows-1253", SubtitleStore.guessCodePage(caps.toByteArray(Charset.forName("windows-1253"))))
    }

    @Test fun russianAndGreekAreTheirOwnPages() {
        val ru = srt(listOf("Привет, как дела? Всё хорошо, спасибо.", "Где ты был вчера вечером?", "Мы поедем на море завтра."), 60)
        assertEquals("windows-1251", SubtitleStore.guessCodePage(ru.toByteArray(Charset.forName("windows-1251"))))
        val el = srt(listOf("Γεια σου, τι κάνεις; Καλά, ευχαριστώ.", "Πού ήσουν χθες το βράδυ;", "Θα πάμε στη θάλασσα αύριο."), 60)
        assertEquals("windows-1253", SubtitleStore.guessCodePage(el.toByteArray(Charset.forName("windows-1253"))))
    }

    @Test fun utf16WithoutBomIsDetected() {
        val text = "1\n00:00:01,000 --> 00:00:02,000\nHello there, this is a subtitle line.\n"
        assertEquals(text, SubtitleStore.decodeText(text.toByteArray(Charsets.UTF_16LE), null))
    }

    @Test fun gzipBombIsRefused() {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { gz -> val zeros = ByteArray(1024 * 1024); repeat(20) { gz.write(zeros) } } // 20 MB of zeros
        val bomb = out.toByteArray()
        assertTrue(bomb.size < 200_000)
        try {
            SubtitleStore.unpack(bomb)
            fail("a 20 MB subtitle must be refused")
        } catch (_: java.io.IOException) {
        }
    }

    @Test fun smallGzipUnpacks() {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(arabic.toByteArray(Charsets.UTF_8)) }
        assertEquals(arabic, String(SubtitleStore.unpack(out.toByteArray()), Charsets.UTF_8))
    }
}
