import { androidApi, onNativePlayerEvent } from "@/lib/android";
import { emptySnapshot, type PlayerBridge, type PlayerSnapshot } from "../bridge";
import { uiLocale } from "@/lib/i18n/locale";
import { readPlayerPrefs, writePlayerPrefs } from "@/lib/player-prefs";

const MAX_INITIAL_SUBS = 20;
const SUB_BATCH_MS = 700;

// One native player is shared by every bridge instance; only the bridge that loaded
// last may stop it, so a stale bridge being torn down can't kill the new playback.
let owner: object | null = null;

const LANG_CODES = [
  "ar", "en", "fr", "es", "de", "it", "pt", "ru", "tr", "fa", "ur", "hi", "bn", "id", "ms", "ja", "ko", "zh",
  "nl", "sv", "no", "nb", "da", "fi", "pl", "cs", "sk", "hu", "ro", "bg", "el", "he", "uk", "sr", "hr", "sl",
  "lt", "lv", "et", "th", "vi", "tl", "sq", "mk", "bs", "ca", "eu", "gl", "is", "ka", "hy", "az", "kk", "uz",
  "sw", "am", "ta", "te", "ml", "kn", "mr", "pa", "gu", "si", "km", "lo", "my", "ne", "ps", "ku",
];

// ISO 639-2 (what most subtitle addons send) -> ISO 639-1.
const ISO3: Record<string, string> = {
  ara: "ar", eng: "en", fre: "fr", fra: "fr", spa: "es", ger: "de", deu: "de", ita: "it", por: "pt", pob: "pt-br",
  rus: "ru", tur: "tr", per: "fa", fas: "fa", urd: "ur", hin: "hi", ben: "bn", ind: "id", may: "ms", msa: "ms",
  jpn: "ja", kor: "ko", chi: "zh", zho: "zh", dut: "nl", nld: "nl", swe: "sv", nor: "no", nob: "nb", dan: "da",
  fin: "fi", pol: "pl", cze: "cs", ces: "cs", slo: "sk", slk: "sk", hun: "hu", rum: "ro", ron: "ro", bul: "bg",
  gre: "el", ell: "el", heb: "he", ukr: "uk", srp: "sr", scc: "sr", hrv: "hr", slv: "sl", lit: "lt", lav: "lv",
  est: "et", tha: "th", vie: "vi", tgl: "tl", fil: "tl", alb: "sq", sqi: "sq", mac: "mk", mkd: "mk", bos: "bs",
  cat: "ca", baq: "eu", eus: "eu", glg: "gl", ice: "is", isl: "is", geo: "ka", kat: "ka", arm: "hy", hye: "hy",
  aze: "az", kaz: "kk", uzb: "uz", swa: "sw", amh: "am", tam: "ta", tel: "te", mal: "ml", kan: "kn", mar: "mr",
  pan: "pa", guj: "gu", sin: "si", khm: "km", lao: "lo", bur: "my", mya: "my", nep: "ne", pus: "ps", kur: "ku",
};

let nameToCode: Map<string, string> | null = null;
/** "Arabic" / "ara" / "ar" -> "ar" (ExoPlayer wants language codes). */
function toLangCode(lang: string): string {
  const l = lang.trim().toLowerCase().replace("_", "-");
  if (ISO3[l]) return ISO3[l];
  if (/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(l)) return l;
  if (!nameToCode) {
    nameToCode = new Map();
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "language" });
      for (const c of LANG_CODES) {
        const n = dn.of(c);
        if (n) nameToCode.set(n.toLowerCase(), c);
      }
    } catch {
      /* no Intl.DisplayNames */
    }
  }
  return nameToCode.get(l) ?? l;
}

function langDisplayName(lang: string | undefined): string | null {
  if (!lang) return null;
  try {
    const dn = new Intl.DisplayNames([uiLocale()], { type: "language" });
    return dn.of(toLangCode(lang)) ?? lang;
  } catch {
    return lang;
  }
}

function preferredSubLangs(): string[] {
  try {
    const raw = localStorage.getItem("harbor.settings");
    const st = raw ? (JSON.parse(raw) as { preferredSubLangs?: unknown; preferredLanguages?: unknown }) : {};
    const pick = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);
    const langs = pick(st.preferredSubLangs).length > 0 ? pick(st.preferredSubLangs) : pick(st.preferredLanguages);
    return langs.map(toLangCode);
  } catch {
    return [];
  }
}

/** "tt123|1|2" (title | season | episode) -> the title's id, which the per-title choices are kept under. */
function metaIdOf(contentKey: string): string {
  return contentKey.split("|")[0] ?? "";
}

/**
 * Should this title start with subtitles off? The viewer's own choice for the title, else
 * Settings > "subtitles off by default" (the rule the other players use).
 */
function startSubsOff(contentKey: string): boolean {
  const prefs = readPlayerPrefs(metaIdOf(contentKey));
  if (prefs?.subsOff != null) return prefs.subsOff;
  try {
    const raw = localStorage.getItem("harbor.settings");
    return raw ? (JSON.parse(raw) as { subtitlesOffByDefault?: unknown }).subtitlesOffByDefault === true : false;
  } catch {
    return false;
  }
}

/** Settings > Language > preferred audio languages, as codes for the native player. */
function preferredAudioLangs(): string[] {
  try {
    const raw = localStorage.getItem("harbor.settings");
    const st = raw ? (JSON.parse(raw) as { preferredAudioLangs?: unknown }) : {};
    const v = st.preferredAudioLangs;
    // Not set yet: the defaults (src/lib/settings/defaults.ts).
    const langs = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : ["English", "Japanese"];
    return langs.map(toLangCode);
  } catch {
    return [];
  }
}

/** Harbor's subtitle look, used to seed the native player's style the first time. */
function harborSubStyle(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem("harbor.settings");
    if (!raw) return null;
    const st = JSON.parse(raw) as Record<string, unknown>;
    return {
      fontSize: st.subFontSize,
      color: st.subFontColor,
      style: st.subStyle,
      bold: st.subBold,
      marginY: st.subMarginY,
      boxOpacity: st.subBoxOpacity,
    };
  } catch {
    return null;
  }
}

type NativeSub = { url: string; lang?: string; label?: string };

/** "OpenSubtitles · OpenSubtitles V3 #1" -> "OpenSubtitles V3 #1" */
function tidyLabel(title?: string): string | undefined {
  if (!title) return title;
  const parts = title.split(" · ").map((p) => p.trim()).filter(Boolean);
  const out = parts.filter((p, i) => !(i + 1 < parts.length && parts[i + 1].toLowerCase().startsWith(p.toLowerCase())));
  return out.join(" · ");
}

function nativeSub(url: string, lang?: string, rawTitle?: string): NativeSub {
  const title = tidyLabel(rawTitle);
  const name = langDisplayName(lang);
  const label = name && title ? `${name} · ${title}` : name ?? title;
  return { url, lang: lang ? toLangCode(lang) : undefined, label: label ?? undefined };
}

// The exact addon subtitle the viewer picked for an episode, kept per content key
// (title | season | episode), so the same one comes back the next time that episode plays.
const SUB_MEMORY_KEY = "harbor.subtitle.memory.v1";
const SUB_MEMORY_MAX = 500;
type RememberedSub = NativeSub & { at: number };

function readSubMemory(): Record<string, RememberedSub> {
  try {
    const raw = localStorage.getItem(SUB_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, RememberedSub>) : {};
  } catch {
    return {};
  }
}

/** The subtitle remembered for this episode, in the shape the native player takes. */
function rememberedSub(contentKey: string): NativeSub | null {
  if (!contentKey) return null;
  const hit = readSubMemory()[contentKey];
  if (!hit || typeof hit.url !== "string" || !hit.url) return null;
  return {
    url: hit.url,
    lang: typeof hit.lang === "string" && hit.lang ? hit.lang : undefined,
    label: typeof hit.label === "string" && hit.label ? hit.label : undefined,
  };
}

/** Remembers the pick for this episode; null forgets it. Only the newest entries are kept. */
function rememberSub(contentKey: string, sub: NativeSub | null) {
  if (!contentKey) return;
  try {
    const all = readSubMemory();
    if (!sub) {
      if (!(contentKey in all)) return;
      delete all[contentKey];
    } else {
      all[contentKey] = { url: sub.url, lang: sub.lang, label: sub.label, at: Date.now() };
    }
    const entries = Object.entries(all);
    const kept =
      entries.length > SUB_MEMORY_MAX
        ? Object.fromEntries(entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, SUB_MEMORY_MAX))
        : all;
    localStorage.setItem(SUB_MEMORY_KEY, JSON.stringify(kept));
  } catch {
    /* storage full or unavailable: the pick just isn't remembered */
  }
}

/** Plays through the Android shell's native ExoPlayer (FFmpeg audio decoders included). */
/** Lets the native player say "no subtitles found" instead of staying silent. */
export function notifyAndroidSubSearch(found: number, manual = false) {
  androidApi()?.command(JSON.stringify({ cmd: "subSearch", count: found, manual }));
}

export function createAndroidBridge(): PlayerBridge {
  const api = androidApi();
  let snap: PlayerSnapshot = { ...emptySnapshot };
  const listeners = new Set<(s: PlayerSnapshot) => void>();
  let title = "";
  let active = false;
  const token = {};
  let pendingSubs: NativeSub[] = [];
  let subTimer: number | null = null;
  const sentSubUrls = new Set<string>();
  // A stream switch inside the player loads without these: keep the title's identity (its
  // subtitles stay) and its download (saved subtitles + the save button stay).
  let lastContentKey = "";
  let lastDownloadId = "";
  const flushSubs = () => {
    subTimer = null;
    if (!active || owner !== token || pendingSubs.length === 0) return;
    const batch = pendingSubs;
    pendingSubs = [];
    api?.command(JSON.stringify({ cmd: "addSubs", subs: batch, prefLangs: preferredSubLangs() }));
  };

  const emit = () => {
    const next = { ...snap };
    listeners.forEach((l) => l(next));
  };

  const off = onNativePlayerEvent((e) => {
    if (!active || owner !== token) return;
    if (e.type === "subsChoice") {
      // Remembered for the title, as the other players do: "off" stays off next time, and a
      // subtitle picked by hand turns them back on for it.
      const id = metaIdOf(lastContentKey);
      if (id) writePlayerPrefs(id, e.off ? { subsOff: true } : { subsOff: false, ...(e.lang ? { subLang: e.lang } : {}) });
      // "Off", or a track inside the file: the addon subtitle remembered for this episode no
      // longer stands. (A pick from the addons says so itself right after, with subPicked.)
      rememberSub(lastContentKey, null);
      return;
    }
    if (e.type === "subPicked") {
      if (e.url) rememberSub(lastContentKey, { url: e.url, lang: e.lang, label: e.label });
      return;
    }
    if (e.type === "state") {
      snap.positionSec = e.positionMs / 1000;
      snap.durationSec = e.durationMs / 1000;
      snap.bufferedSec = Math.max(0, (e.bufferedMs - e.positionMs) / 1000);
      snap.buffering = e.buffering;
      snap.rate = e.rate;
      snap.videoWidth = e.width;
      snap.videoHeight = e.height;
      // Playing again after an error (the native player reconnected, or the user pressed play
      // on its retry prompt): the error is over.
      if (snap.status === "error" && (e.playing || (e.ready && e.playWhenReady))) {
        snap.status = "playing";
        snap.errorCode = null;
        snap.errorMessage = null;
      }
      if (snap.status !== "error") {
        snap.status = e.ended ? "ended" : e.playing ? "playing" : e.ready || !e.playWhenReady ? "paused" : "loading";
      }
      emit();
    } else if (e.type === "ended") {
      snap.status = "ended";
      emit();
    } else if (e.type === "error") {
      snap.status = "error";
      const code = e.code as PlayerSnapshot["errorCode"];
      snap.errorCode = code === "decode" || code === "codec" || code === "network" || code === "source" ? code : "unknown";
      snap.errorMessage = e.message;
      emit();
    } else if (e.type === "closed") {
      snap.positionSec = e.positionMs / 1000;
      if (e.durationMs > 0) snap.durationSec = e.durationMs / 1000;
      snap.status = "paused";
      active = false;
      emit();
    }
  });

  const cmd = (c: Record<string, unknown>) => api?.command(JSON.stringify(c));

  return {
    attach() {},
    detach() {},
    async load(src) {
      snap = { ...emptySnapshot, status: "loading", volume: snap.volume, rate: snap.rate };
      active = true;
      owner = token;
      pendingSubs = [];
      if (subTimer != null) window.clearTimeout(subTimer);
      subTimer = null;
      sentSubUrls.clear();
      const initialSubs = (src.subtitles ?? []).slice(0, MAX_INITIAL_SUBS).map((x) => {
        sentSubUrls.add(x.url);
        return nativeSub(x.url, x.lang, x.label);
      });
      emit();
      if (src.contentKey != null) {
        lastContentKey = src.contentKey;
        lastDownloadId = src.downloadId ?? "";
      }
      const contentKey = src.contentKey ?? lastContentKey;
      const subsOff = startSubsOff(contentKey);
      // The subtitle picked for this episode last time: the native player puts it back in place
      // of its automatic choice. It has to be in the list it is given (it may sit past the first
      // few, or come from a search that has not run yet). Not when subtitles start off.
      const restoreSub = !subsOff && src.isLive !== true ? rememberedSub(contentKey) : null;
      if (restoreSub && !sentSubUrls.has(restoreSub.url)) {
        sentSubUrls.add(restoreSub.url);
        initialSubs.push(restoreSub);
      }
      api?.play(
        JSON.stringify({
          url: src.url,
          headers: src.headers ?? {},
          startMs: Math.max(0, Math.round((src.startAtSec ?? 0) * 1000)),
          subtitles: initialSubs,
          prefSubLangs: preferredSubLangs(),
          prefAudioLangs: preferredAudioLangs(),
          subStyle: harborSubStyle(),
          title,
          isLive: src.isLive === true,
          contentKey,
          downloadId: src.contentKey != null ? (src.downloadId ?? "") : lastDownloadId,
          subsOff,
          ...(restoreSub ? { restoreSub } : {}),
        }),
      );
    },
    async play() {
      cmd({ cmd: "play" });
    },
    pause() {
      cmd({ cmd: "pause" });
    },
    seek(sec) {
      cmd({ cmd: "seek", ms: Math.max(0, Math.round(sec * 1000)) });
    },
    setVolume(v) {
      snap.volume = v;
      cmd({ cmd: "volume", volume: v });
    },
    setMuted(m) {
      snap.muted = m;
      cmd({ cmd: "volume", volume: m ? 0 : snap.volume });
    },
    setRate(r) {
      cmd({ cmd: "rate", rate: r });
    },
    setAudioTrack() {},
    setSubtitleTrack() {},
    setSubVisible() {},
    setSubDelay() {},
    setAudioDelay() {},
    setPanscan() {},
    setVideoZoom() {},
    setAspectOverride() {},
    setAnime4kShaders() {},
    // Addon / OpenSubtitles results arrive one by one after playback starts; batch them
    // so the native player re-prepares once instead of once per subtitle.
    async addSubtitle(url, lang, title) {
      if (!active || owner !== token || !url) return false;
      if (sentSubUrls.has(url)) return true;
      sentSubUrls.add(url);
      pendingSubs.push(nativeSub(url, lang, title));
      if (subTimer != null) window.clearTimeout(subTimer);
      subTimer = window.setTimeout(flushSubs, SUB_BATCH_MS);
      return true;
    },
    getSelectedTrackCues: () => null,
    getSelectedTrackUrl: () => null,
    setAudioNormalize() {},
    setMediaInfo(info) {
      title = info.title;
    },
    async screenshot() {
      return { ok: false, error: "not supported" };
    },
    setAbLoop() {},
    async requestPiP() {},
    async exitPiP() {},
    async requestFullscreen() {},
    async exitFullscreen() {},
    capabilities: () => ({
      engine: "html5",
      pictureInPicture: false,
      airplay: false,
      chromecast: false,
      hdrPassthrough: true,
      hardwareDecode: true,
    }),
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...snap });
      return () => listeners.delete(listener);
    },
    destroy() {
      if (subTimer != null) window.clearTimeout(subTimer);
      off();
      listeners.clear();
      if (owner === token) {
        api?.stop();
        owner = null;
      }
      active = false;
    },
  };
}
