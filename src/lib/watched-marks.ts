// "Watched" marks on posters: which movies / shows you have finished.
//
// Sources, any one is enough:
//  - Harbor's own history: movies finished in the player (or marked watched), and series whose every
//    aired episode is flagged watched (the player flags an episode at 85%; episode totals are
//    recorded when a series page loads)
//  - your Stremio library (movies flagged watched)
//  - Trakt, when connected (watched movies; shows with every aired episode watched)
import { useMemo, useSyncExternalStore } from "react";
import { manualWatchedVersion, subscribeManualWatched, watchedEpisodeCounts } from "@/lib/manual-watched";

const MOVIES_KEY = "harbor.watched.v1";
const TOTALS_KEY = "harbor.series-totals.v1";

const subs = new Set<() => void>();
let version = 0;
let movies: Record<string, number> | null = null;
let totals: Record<string, number> | null = null;

const trakt = { movies: new Set<string>(), shows: new Set<string>() };
let stremioMovies = new Set<string>();
let enabled = true;

function bump(): void {
  version += 1;
  for (const fn of subs) fn();
}

// Flagging an episode in Harbor can complete a series.
subscribeManualWatched(bump);

function load(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function save(key: string, value: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full: the marks just won't persist */
  }
}

function localMovies(): Record<string, number> {
  if (!movies) movies = load(MOVIES_KEY);
  return movies;
}

function localTotals(): Record<string, number> {
  if (!totals) totals = load(TOTALS_KEY);
  return totals;
}

/** A movie finished in Harbor (the player reached the end, or "Mark watched"). */
export function markTitleWatched(id: string | null | undefined, ...alsoIds: Array<string | null | undefined>): void {
  const m = { ...localMovies() };
  let changed = false;
  for (const x of [id, ...alsoIds]) {
    if (!x || m[x]) continue;
    m[x] = Date.now();
    changed = true;
  }
  if (!changed) return;
  movies = m;
  save(MOVIES_KEY, m);
  bump();
}

export function unmarkTitleWatched(id: string | null | undefined, ...alsoIds: Array<string | null | undefined>): void {
  const m = { ...localMovies() };
  let changed = false;
  for (const x of [id, ...alsoIds]) {
    if (x && m[x]) {
      delete m[x];
      changed = true;
    }
  }
  if (!changed) return;
  movies = m;
  save(MOVIES_KEY, m);
  bump();
}

/** How many episodes a series has aired, learned when its page loads (needed to tell "finished"). */
export function recordSeriesTotal(id: string | null | undefined, total: number, opts: { onlyIfMissing?: boolean } = {}): void {
  if (!id || !Number.isFinite(total) || total < 1) return;
  const t = localTotals();
  if (t[id] === total || (opts.onlyIfMissing && t[id])) return;
  totals = { ...t, [id]: Math.floor(total) };
  save(TOTALS_KEY, totals);
  bump();
}

export function setWatchedMarksEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  bump();
}

export function setTraktWatched(index: { movies: Iterable<string>; shows: Iterable<string> } | null): void {
  trakt.movies = new Set(index?.movies ?? []);
  trakt.shows = new Set(index?.shows ?? []);
  bump();
}

export function setStremioWatchedMovies(ids: Iterable<string>): void {
  stremioMovies = new Set(ids);
  bump();
}

function traktHas(id: string): boolean {
  if (/^tt\d+$/.test(id)) return trakt.movies.has(`imdb:${id}`) || trakt.shows.has(`imdb:${id}`);
  const m = /^tmdb:(movie|tv):(\d+)/.exec(id);
  if (!m) return false;
  return (m[1] === "movie" ? trakt.movies : trakt.shows).has(`tmdb:${m[2]}`);
}

export function isTitleWatched(id: string, altIds?: ReadonlyArray<string | null | undefined>): boolean {
  if (!enabled) return false;
  const lm = localMovies();
  const lt = localTotals();
  const counts = watchedEpisodeCounts();
  for (const c of [id, ...(altIds ?? [])]) {
    if (!c) continue;
    if (lm[c] || stremioMovies.has(c) || traktHas(c)) return true;
    const total = lt[c];
    if (total && (counts.get(c) ?? 0) >= total) return true;
  }
  return false;
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

const getVersion = () => version + manualWatchedVersion();

/** Changes whenever any title's watched state may have changed (for lists that check many at once). */
export function useWatchedMarksVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** True when this title counts as watched (and the marks are turned on). */
export function useIsWatched(id: string | undefined, altIds?: ReadonlyArray<string | null | undefined>): boolean {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  const key = altIds ? altIds.join("|") : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (id ? isTitleWatched(id, altIds) : false), [v, id, key]);
}
