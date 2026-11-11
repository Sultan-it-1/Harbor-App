import { useSyncExternalStore } from "react";
import { clearResume, readResumeEntry } from "./resume";
import { episodeFromVideoId, libraryPut, type LibraryItem } from "./stremio";

/** Removed Continue Watching cards: id -> when, and what was on the card at that moment. */
const KEY = "harbor.cw.dismissed.v1";
/** Before: only Simkl's dismissals were saved (a list of ids), the rest was lost on restart. */
const LEGACY_SIMKL_KEY = "harbor.cw.dismissed.simkl";
const MAX_ENTRIES = 600;

/** [t] when it was removed; [v] its video id, [s]/[e] its episode, [p] how far in (0..1). */
type Dismissal = { t: number; v?: string; s?: number; e?: number; p?: number };

const dismissed = new Map<string, Dismissal>();
const listeners = new Set<() => void>();
let version = 0;
let loaded = false;

function persist(): boolean {
  try {
    // The oldest go first: a card removed long ago is long gone from every source.
    if (dismissed.size > MAX_ENTRIES) {
      const oldest = [...dismissed.entries()].sort((a, b) => a[1].t - b[1].t);
      for (const [key] of oldest.slice(0, dismissed.size - MAX_ENTRIES)) dismissed.delete(key);
    }
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(dismissed)));
    return true;
  } catch {
    return false;
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "number") {
          dismissed.set(key, { t: value });
          continue;
        }
        const o = value as { t?: unknown; v?: unknown; s?: unknown; e?: unknown; p?: unknown } | null;
        const t = num(o?.t);
        if (!o || t === undefined) continue;
        dismissed.set(key, {
          t,
          v: typeof o.v === "string" && o.v ? o.v : undefined,
          s: num(o.s),
          e: num(o.e),
          p: num(o.p),
        });
      }
    }
  } catch {
    /* unreadable: start empty */
  }
  // The old Simkl list, once: dated now, so those cards stay away until Simkl has newer progress.
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_SIMKL_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) {
      const now = Date.now();
      for (const v of raw) {
        if (typeof v !== "string" || !v) continue;
        const key = v.startsWith("simkl|") ? v : `simkl|${v}`;
        if (!dismissed.has(key)) dismissed.set(key, { t: now });
      }
      // The old list goes only once the new one is saved.
      if (persist()) localStorage.removeItem(LEGACY_SIMKL_KEY);
    }
  } catch {
    /* keep the old list for the next start */
  }
}

function emit(): void {
  version += 1;
  listeners.forEach((l) => l());
}

function parseMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const p = Date.parse(String(v ?? ""));
  return Number.isFinite(p) ? p : 0;
}

/** The episode a card is on. An anime's own video id ("kitsu:1:5") has no season: it is season 1. */
function resolveEpisode(item: LibraryItem): { season?: number; episode?: number } {
  const vid = item.state?.video_id ?? "";
  const kitsuThreeSeg = /^(kitsu|mal|anilist|anidb):/.test(item._id) && vid.split(":").length === 3;
  const se = kitsuThreeSeg ? null : episodeFromVideoId(item.state?.video_id);
  return {
    season: item.state?.season ?? (kitsuThreeSeg ? 1 : se?.season),
    episode: item.state?.episode ?? (kitsuThreeSeg ? Number(vid.split(":")[2]) : se?.episode),
  };
}

/** When it was last really played: the item's own date, or a position saved on this device. */
function playbackAt(item: LibraryItem): number {
  const { season, episode } = resolveEpisode(item);
  const resume = readResumeEntry(item._id, season, episode);
  return Math.max(parseMs(item.state?.lastWatched), resume?.t ?? 0);
}

function progressRatio(item: LibraryItem): number {
  const duration = item.state?.duration ?? 0;
  if (!(duration > 0)) return 0;
  const { season, episode } = resolveEpisode(item);
  const entry = readResumeEntry(item._id, season, episode);
  // A saved position is measured against the length the player saw, where it saw one.
  const saved = entry ? entry.ms / (entry.d && entry.d > 0 ? entry.d : duration) : 0;
  return Math.min(1, Math.max((item.state?.timeOffset ?? 0) / duration, saved));
}

// Only moving forward lifts a dismissal. A copy on an earlier episode than the one removed (a
// tracker that is behind, a second entry under the same id) is not new progress.
function isEpisodeAhead(
  current: { season?: number; episode?: number },
  was: { season?: number; episode?: number },
): boolean | null {
  const { season: cs, episode: ce } = current;
  const { season: ds, episode: de } = was;
  if (cs == null || ce == null || ds == null || de == null) return null;
  if (![cs, ce, ds, de].every(Number.isFinite)) return null;
  if (cs !== ds) return cs > ds;
  return ce > de;
}

// A title can come under more than one id (IMDb from one source, TMDB from another): removing
// the card under one of them keeps it away under the others.
function itemIds(item: LibraryItem): string[] {
  const ids = [item._id];
  for (const id of item.altIds ?? []) {
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Every key a card's dismissal is kept under: its ids, and the same again for its tracker. */
function dismissalKeys(item: LibraryItem): string[] {
  const ids = itemIds(item);
  return item.external ? [...ids, ...ids.map((id) => `${item.external}|${id}`)] : ids;
}

/** Does this dismissal still hide the card as it is now? */
function stillHides(item: LibraryItem, d: Dismissal): boolean {
  const checkpoint = d.p != null;
  // Only real playback lifts a dismissal. The item's _mtime also moves for upkeep (a repaired
  // name, a re-save from another device): that brought removed cards back. It only counts for
  // an old dismissal that kept nothing to compare with.
  const played = playbackAt(item);
  const activity = checkpoint ? played : Math.max(played, parseMs(item._mtime));
  if (activity > d.t) return false;
  const cur = resolveEpisode(item);
  // Further into the same episode counts, even dated before the dismissal (watched elsewhere).
  if (checkpoint && cur.season === d.s && cur.episode === d.e && progressRatio(item) > d.p! + 0.01) {
    return false;
  }
  const ahead = isEpisodeAhead(cur, { season: d.s, episode: d.e });
  if (ahead) return false;
  // No episode numbers to compare (a movie, an odd video id): another video is another card.
  const curVid = item.state?.video_id;
  if (ahead === null && d.v && curVid && d.v !== curVid) return false;
  return true;
}

export function isCwDismissed(item: LibraryItem): boolean {
  load();
  if (dismissed.size === 0) return false;
  for (const key of dismissalKeys(item)) {
    const d = dismissed.get(key);
    if (d && stillHides(item, d)) return true;
  }
  return false;
}

/** The further of two checkpoints, with the later date: a copy that is behind, removed
 *  afterwards, must not pull the mark back and let the further episode return. */
function furthest(prev: Dismissal | undefined, next: Dismissal): Dismissal {
  if (!prev) return next;
  const rank = (d: Dismissal) => (d.s != null && d.e != null ? d.s * 100_000 + d.e : -1);
  const keepPrev = rank(prev) > rank(next) || (rank(prev) === rank(next) && (prev.p ?? -1) > (next.p ?? -1));
  return { ...(keepPrev ? prev : next), t: Math.max(prev.t, next.t) };
}

export function dismissCw(item: LibraryItem, authKey: string | null): void {
  load();
  const id = item._id;
  const { season, episode } = resolveEpisode(item);
  // Never dated before the card's own last play: a tracker's clock ahead of this device's would
  // otherwise bring the card straight back.
  const now = Math.max(Date.now(), playbackAt(item));
  const mark: Dismissal = { t: now };
  if (item.state) {
    if (typeof item.state.video_id === "string" && item.state.video_id) mark.v = item.state.video_id;
    if (season != null && Number.isFinite(season)) mark.s = season;
    if (episode != null && Number.isFinite(episode)) mark.e = episode;
    mark.p = progressRatio(item);
  }
  for (const key of dismissalKeys(item)) dismissed.set(key, furthest(dismissed.get(key), mark));
  persist();
  emit();
  // The saved position goes with the card, whatever source it came from.
  clearResume(id, season, episode);
  // Only a Stremio library item has a cloud copy to reset. A tracker's or a local card's id put
  // there would add a title to the library that was never in it.
  if (!authKey || !item.state || item.external || item.local) return;
  // What the page added to the card (Up Next, the air date, other ids) is not the cloud's.
  const { upNext: _u, waitingForAir: _w, nextAirDate: _n, altIds: _a, isAnime: _i, ...cloud } = item;
  void libraryPut(authKey, {
    ...cloud,
    state: { ...item.state, timeOffset: 0 },
    _mtime: new Date(now).toISOString(),
  }).catch(() => {});
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useCwDismissVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
