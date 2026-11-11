import { safeFetch as fetch } from "@/lib/safe-fetch";
import { readResumeEntry } from "@/lib/resume";
import { isDetectedAnime } from "./anime-detect";
import { manualWatchedState } from "./manual-watched";

const API = "https://api.strem.io/api";

const CW_FINISHED_RATIO = 0.9;

export type User = {
  _id: string;
  email: string;
  fullname?: string;
  avatar?: string;
};

export type LibraryItem = {
  _id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  state?: {
    timeOffset: number;
    duration: number;
    season?: number;
    episode?: number;
    timeWatched?: number;
    flaggedWatched?: number;
    watched?: string;
    video_id?: string;
    lastWatched?: string;
  };
  removed: boolean;
  temp: boolean;
  _ctime: string;
  _mtime: string;
  external?: "simkl";
  /** The same title's other ids (IMDb, TMDB), used to merge and dismiss Continue Watching copies. */
  altIds?: string[];
  /** Release year, where the source gives one (the trackers do): two titles of one name differ by it. */
  year?: number;
  isAnime?: boolean;
  upNext?: boolean;
  /** The next episode has not aired yet: the card stays and says when it does. */
  waitingForAir?: boolean;
  nextAirDate?: string;
  local?: boolean;
};

export function libraryMetaType(t: string): import("@/lib/cinemeta").MetaType {
  return t === "series" || t === "channel" || t === "tv" || t === "anime" || t === "other"
    ? t
    : "movie";
}

export function isAnimeCwItem(i: LibraryItem): boolean {
  return i._id.startsWith("kitsu:") || i._id.startsWith("mal:") || i.isAnime === true || isDetectedAnime(i._id);
}

export function episodeFromVideoId(
  videoId: string | undefined | null,
): { season: number; episode: number } | null {
  if (!videoId) return null;
  const parts = videoId.split(":");
  if (parts.length < 3) return null;
  const season = Number(parts[parts.length - 2]);
  const episode = Number(parts[parts.length - 1]);
  if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) {
    return null;
  }
  return { season, episode };
}

function resumeForItem(i: LibraryItem): { ms: number; t: number } | null {
  const vid = i.state?.video_id ?? "";
  const kitsuThreeSeg = /^(kitsu|mal|anilist|anidb):/.test(i._id) && vid.split(":").length === 3;
  const se = kitsuThreeSeg ? null : episodeFromVideoId(i.state?.video_id);
  const season = i.state?.season ?? (kitsuThreeSeg ? 1 : se?.season);
  const episode = i.state?.episode ?? (kitsuThreeSeg ? Number(vid.split(":")[2]) : se?.episode);
  return readResumeEntry(i._id, season, episode);
}

export function cwSortKey(i: LibraryItem): number {
  // The latest of the three, not the first one found: a position saved on this device (or synced
  // from an account) is dated in harbor.resume without touching the cloud item's own dates, and a
  // card just played here must not sort by a stale cloud date.
  const lastWatched = Date.parse(i.state?.lastWatched ?? "");
  const m = i._mtime as unknown;
  const mtime = typeof m === "number" ? m : Date.parse(String(m ?? ""));
  let best = resumeForItem(i)?.t ?? 0;
  if (Number.isFinite(lastWatched)) best = Math.max(best, lastWatched);
  if (Number.isFinite(mtime)) best = Math.max(best, mtime);
  return best;
}

/**
 * [advancing]: the caller moves a finished series on to its next episode (Home's row, with that
 * setting on). Only then is a series kept whose episode was watched elsewhere and marked watched
 * here: there is no position to continue, but there may be a next episode to offer. A row that
 * shows cards as they are would show the finished episode at 0 %.
 */
export function isCwMember(i: LibraryItem, opts?: { advancing?: boolean }): boolean {
  if (i.removed && !i.temp) return false;
  if (!i.state) {
    const local = resumeForItem(i)?.ms ?? 0;
    return local > 0;
  }
  // An attempt that never was the title (a placeholder or error clip under 90 s, as a source that
  // fails plays) isn't something being watched: no card with a made-up progress and time left.
  const dur = i.state.duration ?? 0;
  if (dur > 0 && dur < 90_000) return false;
  // A start mark of a few milliseconds (written as a source began) isn't progress either.
  if (i.state.timeOffset > 5_000) return true;
  if ((i.state.flaggedWatched ?? 0) > 0) {
    if (opts?.advancing === true && i.type === "series") {
      const se = episodeFromVideoId(i.state.video_id);
      const season = i.state.season ?? se?.season;
      const episode = i.state.episode ?? se?.episode;
      if (season != null && season > 0 && episode != null && episode > 0) {
        return manualWatchedState(i._id, season, episode) === true;
      }
    }
    return false;
  }
  const local = resumeForItem(i)?.ms ?? 0;
  if (local <= 0) return false;
  const duration = i.state.duration ?? 0;
  if (duration > 0 && local / duration >= CW_FINISHED_RATIO) return false;
  return true;
}

async function call<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) {
    // A revoked or expired key used to look like an empty library. Tell the app once, so it can
    // sign out and say so.
    const msg = String(json.error.message ?? "");
    if (path !== "login" && /session does not exist|invalid auth|not logged in|session expired/i.test(msg)) {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("harbor:stremio-session-expired"));
    }
    throw new Error(msg || "Request failed");
  }
  return json.result as T;
}

export function login(email: string, password: string) {
  return call<{ authKey: string; user: User }>("login", {
    email,
    password,
    facebook: false,
  });
}

export function getUser(authKey: string) {
  return call<User>("getUser", { authKey });
}

export function logout(authKey: string) {
  return call<unknown>("logout", { authKey });
}

export async function library(authKey: string): Promise<LibraryItem[]> {
  const ids = await call<Array<[string, string]>>("datastoreMeta", {
    authKey,
    collection: "libraryItem",
  });
  if (!ids?.length) return [];
  return call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: ids.map(([id]) => id),
    all: true,
  });
}

export async function libraryGetOne(authKey: string, id: string): Promise<LibraryItem | null> {
  const items = await call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: [id],
    all: false,
  }).catch(() => [] as LibraryItem[]);
  return items?.find((it) => it._id === id) ?? null;
}

export async function libraryPut(authKey: string, item: LibraryItem): Promise<void> {
  await call<unknown>("datastorePut", {
    authKey,
    collection: "libraryItem",
    changes: [item],
  });
}

export async function removeStremioLibraryItem(authKey: string, id: string): Promise<void> {
  const items = await call<LibraryItem[]>("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: [id],
    all: false,
  });
  const item = items?.find((it) => it._id === id);
  if (!item) return;
  await libraryPut(authKey, {
    ...item,
    removed: true,
    temp: false,
    _mtime: new Date().toISOString(),
  });
}

export const CLOUD_OK = /^(tt\d|kitsu:|mal:|anilist:|anidb:|tmdb:)/;

export function cloudWriteId(metaId: string, resolved: string | null, verified: boolean): string | null {
  if (metaId.startsWith("tt")) return metaId;
  if (verified && resolved && resolved.startsWith("tt")) return resolved;
  return CLOUD_OK.test(metaId) ? metaId : null;
}

export async function saveStremioBookmark(
  authKey: string,
  id: string,
  input: { type?: string; name?: string; poster?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await libraryGetOne(authKey, id).catch(() => null);
  if (existing) {
    await libraryPut(authKey, { ...existing, removed: false, temp: false, _mtime: now });
    return;
  }
  const type =
    input.type === "series" || input.type === "tv" || input.type === "channel" ? "series" : "movie";
  const item = {
    _id: id,
    name: input.name ?? "",
    type,
    poster: input.poster ?? null,
    posterShape: "poster",
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: null,
      watched: null,
      lastVidReleased: null,
      noNotif: false,
    },
    behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
  };
  await libraryPut(authKey, item as unknown as LibraryItem);
}

export async function removeStremioBookmark(authKey: string, id: string): Promise<void> {
  const existing = await libraryGetOne(authKey, id).catch(() => null);
  if (!existing) return;
  const hasProgress =
    (existing.state?.timeOffset ?? 0) > 0 || (existing.state?.flaggedWatched ?? 0) > 0;
  await libraryPut(authKey, {
    ...existing,
    removed: true,
    temp: hasProgress,
    _mtime: new Date().toISOString(),
  });
}
