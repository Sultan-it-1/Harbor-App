import { useSyncExternalStore } from "react";
import { simklRequest } from "./client";
import { getSession, subscribeSession } from "./session";
import type { SimklTarget } from "./types";

export type WatchlistStatus = "watching" | "plantowatch" | "hold" | "completed" | "dropped";

export const SIMKL_STATUS_LABELS: Record<WatchlistStatus, string> = {
  watching: "Watching",
  plantowatch: "Plan to Watch",
  hold: "On Hold",
  completed: "Completed",
  dropped: "Dropped",
};

export const SHOW_STATUS_ORDER: WatchlistStatus[] = [
  "watching",
  "plantowatch",
  "completed",
  "hold",
  "dropped",
];
export const MOVIE_STATUS_ORDER: WatchlistStatus[] = ["plantowatch", "completed", "dropped"];

type RawIds = {
  simkl?: number;
  imdb?: string;
  tmdb?: number | string;
  mal?: number | string;
  kitsu?: number | string;
};
type RawEpisode = { number?: number; watched_at?: string | null };
type RawSeason = { number?: number; episodes?: RawEpisode[] };
type RawEntry = {
  status?: string;
  movie?: { ids?: RawIds };
  show?: { ids?: RawIds };
  seasons?: RawSeason[];
};
type RawAllItems = { movies?: RawEntry[]; shows?: RawEntry[]; anime?: RawEntry[] };

type SimklData = {
  statuses: Map<string, WatchlistStatus>;
  watched: Map<string, Set<string>>;
};

function isStatus(s: string | undefined): s is WatchlistStatus {
  return (
    s === "watching" || s === "plantowatch" || s === "hold" || s === "completed" || s === "dropped"
  );
}

function idKeys(ids: RawIds | undefined, kind: "movie" | "show"): string[] {
  if (!ids) return [];
  const keys: string[] = [];
  if (ids.imdb) keys.push(ids.imdb);
  if (ids.tmdb != null) keys.push(kind === "movie" ? `tmdb:movie:${ids.tmdb}` : `tmdb:tv:${ids.tmdb}`);
  if (ids.mal != null) keys.push(`mal:${ids.mal}`);
  if (ids.kitsu != null) keys.push(`kitsu:${ids.kitsu}`);
  return keys;
}

function targetKeys(target: SimklTarget): string[] {
  const ids = target.kind === "episode" ? target.show.ids : target.ids;
  return idKeys(ids as RawIds, target.kind === "movie" ? "movie" : "show");
}

let cache: Promise<SimklData> | null = null;
/** Simkl's "last changed" for the account when the list in [cache] was read. */
let pulledStamp: string | null = null;
let lastCheck = 0;
let checking: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** How often, at most, Harbor asks Simkl whether anything changed. */
const CHECK_EVERY_MS = 2 * 60_000;

subscribeSession(() => {
  cache = null;
  pulledStamp = null;
});

/** When anything last changed on the account (a small request); null when Simkl can't be asked. */
async function activityStamp(): Promise<string | null> {
  try {
    const a = await simklRequest<Record<string, unknown> | null>("/sync/activities");
    if (!a) return null;
    return typeof a.all === "string" ? a.all : JSON.stringify(a);
  } catch {
    return null;
  }
}

async function pull(): Promise<SimklData> {
  const [data, stamp] = await Promise.all([
    simklRequest<RawAllItems>("/sync/all-items/all/all?extended=full&episode_watched_at=yes").catch(
      () => null,
    ),
    activityStamp(),
  ]);
  // A list that couldn't be read leaves no stamp, so the next check reads it again.
  pulledStamp = data ? stamp : null;
  return build(data ?? ({} as RawAllItems));
}

function build(data: RawAllItems): SimklData {
  const statuses = new Map<string, WatchlistStatus>();
  const watched = new Map<string, Set<string>>();
  const add = (entries: RawEntry[] | undefined, kind: "movie" | "show") => {
    for (const e of entries ?? []) {
      const node = kind === "movie" ? e.movie : e.show;
      const keys = idKeys(node?.ids, kind);
      if (keys.length === 0) continue;
      if (isStatus(e.status)) for (const k of keys) statuses.set(k, e.status);
      if (kind === "show" && e.seasons) {
        const eps = new Set<string>();
        for (const s of e.seasons) {
          for (const ep of s.episodes ?? []) {
            if (ep.watched_at && s.number != null && ep.number != null) {
              eps.add(`${s.number}:${ep.number}`);
            }
          }
        }
        if (eps.size > 0) for (const k of keys) watched.set(k, eps);
      }
    }
  };
  add(data.movies, "movie");
  add(data.shows, "show");
  add(data.anime, "show");
  return { statuses, watched };
}

function loadData(): Promise<SimklData> {
  if (!cache) {
    cache = pull();
    lastCheck = Date.now();
    return cache;
  }
  // What's kept is shown at once; a check for changes runs behind it.
  void checkSimklForChanges();
  return cache;
}

/**
 * Asks Simkl whether anything changed on the account since its list was read (at most every two
 * minutes, unless [force]); when it did, reads the list again and tells the screens that show it.
 * Simkl counts each request against a daily allowance, so the whole list is only read again when
 * something changed.
 */
export function checkSimklForChanges(force = false): Promise<void> {
  if (!cache || !getSession()) return Promise.resolve();
  if (checking) return checking;
  if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) return Promise.resolve();
  lastCheck = Date.now();
  checking = (async () => {
    const stamp = await activityStamp();
    if (stamp == null || (stamp === pulledStamp && pulledStamp != null)) return;
    const next = pull();
    await next;
    cache = next;
    version++;
    for (const fn of listeners) fn();
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/** Changes whenever Simkl's list was read again with something new (re-read what it shows). */
export function useSimklListVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => version,
    () => version,
  );
}

// Back in the app (Android) or back on the tab (web): anything watched elsewhere meanwhile.
if (typeof window !== "undefined") {
  window.addEventListener("harbor:resume", () => void checkSimklForChanges());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkSimklForChanges();
  });
}

export async function loadSimklStatusMap(): Promise<Map<string, WatchlistStatus>> {
  return (await loadData()).statuses;
}

export async function loadSimklWatchedMap(): Promise<Map<string, Set<string>>> {
  return (await loadData()).watched;
}

export function statusForId(
  map: Map<string, WatchlistStatus>,
  id: string,
): WatchlistStatus | null {
  return map.get(id) ?? null;
}

export function simklWatchedForId(
  map: Map<string, Set<string>>,
  ...ids: Array<string | null | undefined>
): Set<string> {
  for (const id of ids) {
    if (!id) continue;
    const set = map.get(id);
    if (set) return set;
  }
  return new Set();
}

export async function setSimklStatus(
  target: SimklTarget,
  status: WatchlistStatus,
): Promise<WatchlistStatus> {
  const ids = target.kind === "episode" ? target.show.ids : target.ids;
  const bucket = target.kind === "movie" ? "movies" : "shows";
  const r = await simklRequest<{ added?: Record<string, Array<{ to?: string }>> }>(
    "/sync/add-to-list",
    { method: "POST", body: { to: status, [bucket]: [{ to: status, ids }] } },
  );
  const echoed = r?.added?.[bucket]?.[0]?.to;
  const final = isStatus(echoed) ? echoed : status;
  const statuses = (await loadData()).statuses;
  for (const k of targetKeys(target)) statuses.set(k, final);
  return final;
}

export async function clearSimklStatus(target: SimklTarget): Promise<void> {
  const ids = target.kind === "episode" ? target.show.ids : target.ids;
  const bucket = target.kind === "movie" ? "movies" : "shows";
  await simklRequest("/sync/history/remove", { method: "POST", body: { [bucket]: [{ ids }] } });
  const statuses = (await loadData()).statuses;
  for (const k of targetKeys(target)) statuses.delete(k);
}
