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

export async function fetchWatchedHistory(limit = 200): Promise<HistoryItem[]> {
  type Raw = {
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
  const rows = await traktRequest<Raw[]>(`/sync/history?limit=${limit}`).catch(
    () => [] as Raw[],
  );
  return rows.map((r) => {
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
  });
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
type RawWatchedShow = {
  show?: { ids?: WatchedIds };
  seasons?: Array<{ number: number; episodes?: Array<{ number: number }> }>;
};
type RawWatchedMovie = { movie?: { ids?: WatchedIds } };

const KEY_SET_TTL_MS = 2 * 60_000;
let keySet: { set: Set<string>; at: number } | null = null;
let keySetInflight: Promise<Set<string>> | null = null;

/**
 * Everything Trakt has as watched, as keys: "imdb:tt…" / "tmdb:123" for films and
 * "imdb:tt…:S:E" / "tmdb:123:S:E" for episodes. Episodes come from the watched list (every
 * episode of every show, however long ago) and the latest history; the answer is shared for two
 * minutes by the pages that ask.
 */
export function fetchWatchedKeySet(): Promise<Set<string>> {
  if (keySet && Date.now() - keySet.at < KEY_SET_TTL_MS) return Promise.resolve(keySet.set);
  if (keySetInflight) return keySetInflight;
  keySetInflight = (async () => {
    const [rows, shows, movies] = await Promise.all([
      fetchWatchedHistory(1000),
      traktRequest<RawWatchedShow[]>("/sync/watched/shows").catch(() => null),
      traktRequest<RawWatchedMovie[]>("/sync/watched/movies").catch(() => null),
    ]);
    const set = new Set<string>();
    const showKeys = (ids: WatchedIds | undefined): string[] => {
      const out: string[] = [];
      if (ids?.imdb) out.push(`imdb:${ids.imdb}`);
      if (ids?.tmdb) out.push(`tmdb:${ids.tmdb}`);
      return out;
    };
    for (const r of rows) {
      if (r.type === "movie") {
        if (r.imdb) set.add(`imdb:${r.imdb}`);
        if (r.tmdb) set.add(`tmdb:${r.tmdb}`);
      } else {
        if (r.showImdb && r.season != null && r.number != null) {
          set.add(`imdb:${r.showImdb}:${r.season}:${r.number}`);
        }
        if (r.showTmdb && r.season != null && r.number != null) {
          set.add(`tmdb:${r.showTmdb}:${r.season}:${r.number}`);
        }
      }
    }
    for (const m of movies ?? []) for (const k of showKeys(m.movie?.ids)) set.add(k);
    for (const sh of shows ?? []) {
      const keys = showKeys(sh.show?.ids);
      if (keys.length === 0) continue;
      for (const season of sh.seasons ?? []) {
        for (const e of season.episodes ?? []) {
          for (const k of keys) set.add(`${k}:${season.number}:${e.number}`);
        }
      }
    }
    if (set.size > 0 || shows != null) keySet = { set, at: Date.now() };
    return set;
  })().finally(() => {
    keySetInflight = null;
  });
  return keySetInflight;
}
