// Android app downloads: thin wrapper over the app's own downloader
// (android/app/src/main/java/app/harbor/android/Downloads.kt, which keeps running in the
// background) plus the subtitle gathering that saves addon subtitles next to each video
// for offline viewing.
import { androidApi } from "@/lib/android";
import type { Meta } from "@/lib/cinemeta";
import type { PlayEpisode } from "@/lib/view";
import { searchSubtitles } from "@/lib/subtitles/search";
import { langScore } from "@/lib/subtitles/language";
import { gatherSubtitleAddons } from "@/lib/subtitles/addon-source";
import { tmdbImdbId } from "@/lib/providers/tmdb";

export type NativeStatus = {
  status: "pending" | "downloading" | "waiting" | "paused" | "done" | "error" | "missing";
  received?: number;
  total?: number | null;
  reason?: string;
  /** What the note/error says, as a code the page translates (Downloads.kt codeFor/failCode). */
  code?: string;
  http?: number;
  /** "retry_in": seconds until the next try. */
  sec?: number;
  title?: string;
  /** Subtitles saved next to the video so far. */
  subs?: number;
};

export function androidDownloadsAvailable(): boolean {
  return typeof androidApi()?.dlStart === "function";
}

function parse<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function nativeStart(args: {
  id: string;
  url: string;
  headers?: Record<string, string>;
  fileName: string;
  title: string;
  description?: string | null;
  subtitles?: { url: string; lang?: string; label?: string }[];
}): { ok: boolean; error?: string } {
  const api = androidApi();
  if (!api?.dlStart) return { ok: false, error: "downloads unavailable" };
  return parse(api.dlStart(JSON.stringify(args)), { ok: false, error: "bad response" });
}

export function nativeStatus(): Record<string, NativeStatus> {
  return parse(androidApi()?.dlStatus?.(), {});
}

export function nativeDelete(id: string): void {
  androidApi()?.dlDelete?.(id);
}

export function nativeRelink(id: string, url: string, headers?: Record<string, string>): boolean {
  return androidApi()?.dlRelink?.(id, url, JSON.stringify(headers ?? {})) === true;
}

/** null on shells without the setting. */
export function nativeWifiOnly(): boolean | null {
  const api = androidApi();
  if (!api?.dlWifiOnly) return null;
  try {
    return api.dlWifiOnly();
  } catch {
    return null;
  }
}

export function nativeSetWifiOnly(on: boolean): void {
  androidApi()?.dlSetWifiOnly?.(on);
}

export function nativePause(id: string): boolean {
  return androidApi()?.dlPause?.(id) === true;
}

/** Resume a paused download, or retry a failed one. */
export function nativeResume(id: string): boolean {
  return androidApi()?.dlResume?.(id) === true;
}

/** Adds subtitles to a download that already started (saved next to the video). */
export function nativeAddSubs(id: string, subs: { url: string; lang?: string; label?: string }[]): boolean {
  const api = androidApi();
  if (!api?.dlAddSubs || subs.length === 0) return false;
  return api.dlAddSubs(id, JSON.stringify(subs)) === true;
}

export function nativeFiles(id: string): { video?: string; subtitles: { url: string; lang?: string; label?: string }[] } {
  return parse(androidApi()?.dlFiles?.(id), { subtitles: [] });
}

export function nativeStorage(): { free?: number; used?: number } {
  return parse(androidApi()?.dlStorage?.(), {});
}

/** Tells the app the page has background work, so it keeps running after you leave it. */
export function nativeKeepAlive(on: boolean): void {
  try {
    androidApi()?.dlKeepAlive?.(on);
  } catch {
    /* older shell */
  }
}

/** null when the shell can't tell (older version). */
export function nativeBgAllowed(): boolean | null {
  const api = androidApi();
  if (typeof api?.bgAllowed !== "function") return null;
  try {
    return api.bgAllowed() === true;
  } catch {
    return null;
  }
}

export function nativeBgRequest(): void {
  androidApi()?.bgRequest?.();
}

function readSettings(): { preferredSubLangs?: string[]; preferredLanguages?: string[]; tmdbKey?: string } {
  try {
    return JSON.parse(localStorage.getItem("harbor.settings") || "{}");
  } catch {
    return {};
  }
}

function readAuthKey(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("harbor.auth.")) continue;
      const v = JSON.parse(localStorage.getItem(k) || "null") as { authKey?: string } | null;
      if (v?.authKey) return v.authKey;
    }
  } catch {
    /* signed out */
  }
  return null;
}

/**
 * Picks addon subtitles to save with a download: the best two per preferred subtitle
 * language (max six). Empty when the title can't be matched or nothing is found.
 */
export async function gatherDownloadSubtitles(
  meta: Meta,
  episode: PlayEpisode | undefined,
): Promise<{ url: string; lang?: string; label?: string }[]> {
  const settings = readSettings();
  const langs =
    (settings.preferredSubLangs?.length ? settings.preferredSubLangs : settings.preferredLanguages) ?? ["English"];
  let imdbId: string | null = meta.id.startsWith("tt") ? meta.id : null;
  if (!imdbId && settings.tmdbKey) imdbId = await tmdbImdbId(settings.tmdbKey, meta.id).catch(() => null);
  if (!imdbId) return [];
  const addons = await gatherSubtitleAddons(readAuthKey()).catch(() => []);
  const results = await searchSubtitles(
    {
      imdbId,
      stremioId: meta.id,
      type: meta.type === "series" || episode ? "series" : "movie",
      season: episode?.imdbSeason ?? episode?.season,
      episode: episode?.imdbEpisode ?? episode?.episode,
      langs,
    },
    // Every provider: this is the only chance to get subtitles for offline viewing.
    { providers: { opensubtitles: true, addons: true, wyzie: true }, addons, preferredLangs: langs },
  ).catch(() => []);
  const out: { url: string; lang?: string; label?: string }[] = [];
  for (const want of langs) {
    const hits = results.filter((r) => langScore(r.lang ?? "", [want]) > 0).slice(0, 2);
    for (const r of hits) {
      if (out.length >= 6) break;
      if (out.some((o) => o.url === r.url)) continue;
      out.push({ url: r.url, lang: r.lang, label: [r.source === "opensubtitles" ? "OpenSubtitles" : r.title, r.release].filter(Boolean).join(" · ") });
    }
  }
  return out;
}
