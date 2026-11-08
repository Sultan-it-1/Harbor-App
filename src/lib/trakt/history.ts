import { traktRequest } from "./client";
import type { TraktTarget } from "./types";

export type HistoryItem = {
  id: number;
  watchedAt: string;
  type: "movie" | "episode";
  imdb?: string;
  tmdb?: number;
  title: string;
  year: number | null;
  showImdb?: string;
  showTmdb?: number;
  season?: number;
  number?: number;
};

type RawHistoryRow = {
  id: number;
  watched_at: string;
  type: "movie" | "episode";
  movie?: {
    title: string;
    year: number | null;
    ids: { imdb?: string; tmdb?: number };
  };
  episode?: {
    season: number;
    number: number;
    title?: string;
    ids: { imdb?: string; tmdb?: number };
  };
  show?: {
    title: string;
    year: number | null;
    ids: { imdb?: string; tmdb?: number };
  };
};

function historyItem(r: RawHistoryRow): HistoryItem {
  if (r.type === "movie" && r.movie) {
    return {
      id: r.id,
      watchedAt: r.watched_at,
      type: "movie" as const,
      title: r.movie.title,
      year: r.movie.year,
      imdb: r.movie.ids.imdb,
      tmdb: r.movie.ids.tmdb,
    };
  }
  return {
    id: r.id,
    watchedAt: r.watched_at,
    type: "episode" as const,
    title: r.show?.title ?? "",
    year: r.show?.year ?? null,
    showImdb: r.show?.ids.imdb,
    showTmdb: r.show?.ids.tmdb,
    season: r.episode?.season,
    number: r.episode?.number,
  };
}

/** The latest of your Trakt history, newest first (Trakt gives 250 at most a page). */
export async function fetchWatchedHistory(limit = 200): Promise<HistoryItem[]> {
  const rows = await traktRequest<RawHistoryRow[]>(`/sync/history?limit=${limit}`).catch(
    () => [] as RawHistoryRow[],
  );
  return rows.map(historyItem);
}

export async function pushWatched(target: TraktTarget): Promise<boolean> {
  try {
    if (target.kind === "movie") {
      await traktRequest("/sync/history", {
        method: "POST",
        body: { movies: [{ ids: target.ids }] },
      });
      return true;
    }
    if (target.kind === "episode") {
      await traktRequest("/sync/history", {
        method: "POST",
        body: {
          shows: [
            {
              ids: target.show.ids,
              seasons: [
                { number: target.season, episodes: [{ number: target.number }] },
              ],
            },
          ],
        },
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

type WatchedIds = { imdb?: string | null; tmdb?: number | null };
type RawWatchedMovie = { movie?: { ids?: WatchedIds } };

/** Trakt's largest page (asking for more still gets 250). */
const PAGE = 250;

/** Every page of a Trakt list (up to [maxPages]); null when the first page can't be had. */
async function allPages<T>(path: string, maxPages: number): Promise<T[] | null> {
  const out: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    let rows: T[];
    try {
      rows = await traktRequest<T[]>(`${path}${sep}limit=${PAGE}&page=${page}`);
    } catch {
      if (page === 1) return null;
      break;
    }
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function addEpisodeKeys(set: Set<string>, rows: HistoryItem[]): void {
  for (const r of rows) {
    if (r.type === "movie") {
      if (r.imdb) set.add(`imdb:${r.imdb}`);
      if (r.tmdb) set.add(`tmdb:${r.tmdb}`);
    } else if (r.season != null && r.number != null) {
      if (r.showImdb) set.add(`imdb:${r.showImdb}:${r.season}:${r.number}`);
      if (r.showTmdb) set.add(`tmdb:${r.showTmdb}:${r.season}:${r.number}`);
    }
  }
}

const KEY_SET_TTL_MS = 2 * 60_000;
let keySet: { set: Set<string>; at: number } | null = null;
let keySetInflight: Promise<Set<string>> | null = null;

/**
 * What Trakt has as watched, as keys: "imdb:tt…" / "tmdb:123" for films (every one, page after
 * page) and "imdb:tt…:S:E" / "tmdb:123:S:E" for the episodes of the latest history. Trakt's
 * watched-shows list no longer says which episodes, so a show's own page asks for its episodes
 * with fetchShowWatchedKeys. Shared for two minutes by the pages that ask.
 */
export function fetchWatchedKeySet(): Promise<Set<string>> {
  if (keySet && Date.now() - keySet.at < KEY_SET_TTL_MS) return Promise.resolve(keySet.set);
  if (keySetInflight) return keySetInflight;
  keySetInflight = (async () => {
    const [rows, movies] = await Promise.all([
      fetchWatchedHistory(PAGE),
      allPages<RawWatchedMovie>("/sync/watched/movies", 40),
    ]);
    const set = new Set<string>();
    addEpisodeKeys(set, rows);
    for (const m of movies ?? []) {
      if (m.movie?.ids?.imdb) set.add(`imdb:${m.movie.ids.imdb}`);
      if (m.movie?.ids?.tmdb) set.add(`tmdb:${m.movie.ids.tmdb}`);
    }
    if (set.size > 0 || movies != null) keySet = { set, at: Date.now() };
    return set;
  })().finally(() => {
    keySetInflight = null;
  });
  return keySetInflight;
}

const showKeys = new Map<string, { set: Set<string>; at: number }>();

/**
 * Every episode of one show that Trakt has as watched, however long ago (its whole history,
 * page after page), as "imdb:tt…:S:E" / "tmdb:123:S:E" keys. [imdb] or [tmdb] names the show.
 * Empty when Trakt can't be asked.
 */
export async function fetchShowWatchedKeys(show: { imdb?: string | null; tmdb?: number | null }): Promise<Set<string>> {
  let id = show.imdb && /^tt\d+$/.test(show.imdb) ? show.imdb : null;
  if (!id && show.tmdb) {
    // Trakt's own number for a show only known by its TMDB one.
    const found = await traktRequest<Array<{ show?: { ids?: { trakt?: number } } }>>(
      `/search/tmdb/${show.tmdb}?type=show`,
    ).catch(() => []);
    const trakt = found[0]?.show?.ids?.trakt;
    if (trakt) id = String(trakt);
  }
  if (!id) return new Set();
  const hit = showKeys.get(id);
  if (hit && Date.now() - hit.at < KEY_SET_TTL_MS) return hit.set;
  const raw = await allPages<RawHistoryRow>(`/sync/history/shows/${encodeURIComponent(id)}`, 20);
  const set = new Set<string>();
  if (raw) {
    addEpisodeKeys(set, raw.map(historyItem));
    showKeys.set(id, { set, at: Date.now() });
  }
  return set;
}
