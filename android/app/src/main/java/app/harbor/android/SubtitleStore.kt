package app.harbor.android

import android.content.Context
import android.os.Environment
import androidx.media3.common.MimeTypes
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.zip.GZIPInputStream
import java.util.zip.ZipInputStream

/**
 * Downloads an addon subtitle to a local file (only when it's picked), normalising it on the
 * way: gzip/zip unpacking, legacy encodings (Arabic windows-1256 etc.) re-encoded as UTF-8,
 * and format sniffing (SRT / VTT / ASS) since addon URLs often have no file extension.
 */
class SubtitleStore(private val dir: File, private val fileRoots: List<File> = listOf(dir)) {
    /** file: subtitles are only read from Harbor's own folders (saved downloads, this cache). */
    constructor(context: Context) : this(
        File(context.cacheDir, "subs"),
        listOfNotNull(File(context.cacheDir, "subs"), context.getExternalFilesDir(Environment.DIRECTORY_MOVIES), context.filesDir),
    )
    init {
        dir.mkdirs()
    }

    data class LocalSub(val id: String, val file: File, val mime: String, val lang: String?, val label: String?, val sourceUrl: String)

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }

    fun fetch(id: String, url: String, lang: String?, label: String?, userAgent: String): LocalSub? = try {
        val raw = unpack(download(url, userAgent))
        val text = decodeText(raw, lang).trimStart('﻿')
        val head = text.trimStart()
        val (mime, ext) = when {
            head.startsWith("WEBVTT") -> MimeTypes.TEXT_VTT to "vtt"
            head.contains("[Script Info]", ignoreCase = true) || head.contains("[Events]", ignoreCase = true) -> MimeTypes.TEXT_SSA to "ass"
            text.contains("-->") -> MimeTypes.APPLICATION_SUBRIP to "srt"
            else -> null to null
        }
        if (mime == null) {
            null
        } else {
            val f = File(dir, "$id.$ext")
            f.writeText(if (ext == "srt") text.replace("\r\n", "\n") else text, Charsets.UTF_8)
            LocalSub(id, f, mime, lang, label, url)
        }
    } catch (_: Throwable) {
        // Includes OutOfMemoryError: a bad subtitle from a third-party server must never take the
        // app down mid-film; the player just skips it.
        null
    }

    private fun download(url: String, userAgent: String): ByteArray {
        // Offline: subtitles saved next to a downloaded video — only from Harbor's own folders.
        if (url.startsWith("file:")) {
            val f = File(java.net.URI(url)).canonicalFile
            if (fileRoots.none { root -> f.path.startsWith(root.canonicalPath + File.separator) }) error("file outside Harbor's folders")
            if (f.length() > MAX_BYTES) error("subtitle too large")
            return f.readBytes()
        }
        var u = URL(url)
        repeat(6) {
            val c = u.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = 8_000
            c.readTimeout = 10_000
            c.setRequestProperty("User-Agent", userAgent)
            val code = c.responseCode
            if (code in 300..399) {
                val loc = c.getHeaderField("Location") ?: error("redirect without location")
                u = URL(u, loc)
                c.disconnect()
                return@repeat
            }
            if (code !in 200..299) error("HTTP $code")
            val bytes = c.inputStream.use { s ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(32 * 1024)
                while (true) {
                    val n = s.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > MAX_BYTES) error("subtitle too large")
                }
                out.toByteArray()
            }
            c.disconnect()
            return bytes
        }
        error("too many redirects")
    }

    companion object {
        /** Largest subtitle we accept, downloaded or after unpacking (a real one is < 1 MB). */
        const val MAX_BYTES = 8 * 1024 * 1024

        /** gzip / zip unpacking with a size cap: a tiny archive must not inflate into gigabytes. */
        fun unpack(b: ByteArray): ByteArray {
            if (b.size > 2 && b[0] == 0x1f.toByte() && b[1] == 0x8b.toByte()) {
                return GZIPInputStream(ByteArrayInputStream(b)).use { readCapped(it) }
            }
            if (b.size > 4 && b[0] == 'P'.code.toByte() && b[1] == 'K'.code.toByte()) {
                ZipInputStream(ByteArrayInputStream(b)).use { z ->
                    while (true) {
                        val e = z.nextEntry ?: break
                        val n = e.name.lowercase()
                        if (!e.isDirectory && (n.endsWith(".srt") || n.endsWith(".vtt") || n.endsWith(".ass") || n.endsWith(".ssa"))) {
                            return readCapped(z)
                        }
                    }
                }
            }
            return b
        }

        private fun readCapped(s: java.io.InputStream): ByteArray {
            val out = ByteArrayOutputStream()
            val buf = ByteArray(32 * 1024)
            while (true) {
                val n = s.read(buf)
                if (n < 0) break
                if (out.size() + n > MAX_BYTES) throw java.io.IOException("subtitle too large after unpacking")
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }

        /** UTF-16 without a BOM: one byte of nearly every pair is zero for Latin/ASCII text. */
        private fun utf16WithoutBom(b: ByteArray): Charset? {
            if (b.size < 64) return null
            var evenZero = 0
            var oddZero = 0
            val n = minOf(b.size, 4096) and 1.inv()
            for (i in 0 until n step 2) {
                if (b[i].toInt() == 0) evenZero++
                if (b[i + 1].toInt() == 0) oddZero++
            }
            val pairs = n / 2
            return when {
                oddZero > pairs * 0.4 && evenZero < pairs * 0.05 -> Charsets.UTF_16LE
                evenZero > pairs * 0.4 && oddZero < pairs * 0.05 -> Charsets.UTF_16BE
                else -> null
            }
        }

        /**
         * No usable language tag: guess the legacy code page from the text itself.
         * - Latin text (French, Spanish…) keeps windows-1252: its accented letters sit inside
         *   words made of ASCII letters ("déjà", "¿Dónde"), while Cyrillic, Greek and Arabic
         *   words are made of high bytes only.
         * - windows-1251 reads every byte from 0xC0 up as a Cyrillic letter, so Arabic text scores
         *   the same in both: Arabic wins when its own reading is (nearly) as good, counting the
         *   RLM/LRM marks subtitle editors add. Russian read as windows-1256 turns many of its
         *   most common letters into Latin ones and falls far behind.
         * - Greek and Cyrillic both fill 0xC0-0xFF: Greek's accented small letters (ά έ ή ί) read
         *   as capitals in the middle of words in windows-1251, which Russian never has.
         */
        fun guessCodePage(b: ByteArray): String {
            var high = 0
            var nextToLatin = 0
            // Read as windows-1251: a capital right after a small letter, inside a word. Never in
            // Russian; in Greek (windows-1253) these bytes are accented small letters (ά έ ή ί).
            var midWordCaps = 0
            // ل م ن ه و ى ي in windows-1256 (bytes E1, E3-E6, EC, ED): about 40% of the letters of
            // Arabic, Persian or Urdu text. Capital Cyrillic or Greek never uses these bytes, though
            // windows-1256 reads every other capital byte (C0-DF) as an Arabic letter.
            var arabicCore = 0
            // Capitals (C0-DF) and small letters (E0-FF) as windows-1251 sees them, and the capital
            // bytes Greek has no use for: D2 is undefined in windows-1253 and C0/DA/DB are only
            // ΐ Ϊ Ϋ, while Russian capitals use А Т Ъ Ы all the time.
            var capitals = 0
            var smalls = 0
            var nonGreekCapitals = 0
            fun u(i: Int) = if (i in b.indices) b[i].toInt() and 0xFF else 0
            fun asciiLetter(i: Int) = u(i).let { it in 0x41..0x5A || it in 0x61..0x7A }
            for (i in b.indices) {
                val c = u(i)
                if (c and 0x80 == 0) continue
                high++
                if (asciiLetter(i - 1) || asciiLetter(i + 1)) nextToLatin++
                if (c in 0xC0..0xDF && u(i - 1) in 0xE0..0xFF) midWordCaps++
                if (c == 0xE1 || c in 0xE3..0xE6 || c == 0xEC || c == 0xED) arabicCore++
                if (c in 0xC0..0xDF) capitals++ else if (c >= 0xE0) smalls++
                if (c == 0xC0 || c == 0xD2 || c == 0xDA || c == 0xDB) nonGreekCapitals++
            }
            if (high < 16 || high < b.size / 50) return "windows-1252"
            if (nextToLatin * 2 > high) return "windows-1252"
            fun score(cs: String, inScript: (Char) -> Boolean) = String(b, Charset.forName(cs)).count(inScript)
            val arabic = score("windows-1256") { it in '\u0600'..'\u06FF' || it == '\u200E' || it == '\u200F' }
            val cyrillic = score("windows-1251") { it in '\u0400'..'\u04FF' }
            val greek = score("windows-1253") { it in '\u0370'..'\u03FF' }
            val floor = high / 3
            if (arabic > floor && arabic * 100 >= cyrillic * 85 && arabicCore * 100 >= high * 15) return "windows-1256"
            if (greek > floor && midWordCaps * 50 >= high) return "windows-1253"
            // Mostly capitals (sign tracks, hard-of-hearing tags): Greek when its capitals never
            // use the bytes only Russian capitals need.
            if (greek > floor && smalls * 4 < high && nonGreekCapitals * 100 < capitals * 2) return "windows-1253"
            if (cyrillic > floor) return "windows-1251"
            if (greek > floor) return "windows-1253"
            return "windows-1252"
        }

        fun decodeText(b: ByteArray, lang: String?): String {
        if (b.size >= 2 && b[0] == 0xFF.toByte() && b[1] == 0xFE.toByte()) return String(b, Charsets.UTF_16LE)
        if (b.size >= 2 && b[0] == 0xFE.toByte() && b[1] == 0xFF.toByte()) return String(b, Charsets.UTF_16BE)
        // Before UTF-8: zero bytes are valid UTF-8, so UTF-16 text would "decode" as UTF-8.
        utf16WithoutBom(b)?.let { return String(b, it) }
        try {
            return Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(b))
                .toString()
        } catch (_: CharacterCodingException) {
            // Not UTF-8: pick the usual legacy code page for the language.
        }
        val l = (lang ?: "").lowercase()
        val cs = when {
            l.startsWith("ar") || l.startsWith("fa") || l.startsWith("per") || l.startsWith("ur") ||
                l.startsWith("ku") || l.startsWith("ps") || l.startsWith("pus") -> "windows-1256"
            l.startsWith("he") || l.startsWith("heb") -> "windows-1255"
            l.startsWith("ru") || l.startsWith("uk") || l.startsWith("bg") || l.startsWith("sr") -> "windows-1251"
            l.startsWith("el") || l.startsWith("gre") -> "windows-1253"
            l.startsWith("tr") -> "windows-1254"
            l.startsWith("pl") || l.startsWith("cs") || l.startsWith("cz") || l.startsWith("hu") || l.startsWith("ro") || l.startsWith("hr") || l.startsWith("sk") -> "windows-1250"
            l.isBlank() || l == "und" || l == "unknown" || l == "mul" -> guessCodePage(b)
            else -> "windows-1252"
        }
        return String(b, Charset.forName(cs))
        }
    }
}
