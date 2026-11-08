import { traktRequest } from "./client";

/** What Trakt says you've finished: movie keys and show keys ("imdb:tt…" / "tmdb:123"). */
export type TraktWatchedIndex = { movies: string[]; shows: string[]; at: number };

const CACHE_KEY = "harbor.trakt.watched-index.v1";
export const TRAKT_INDEX_MAX_AGE_MS = 30 * 60_000;

type Ids = { imdb?: string | null; tmdb?: number | null };
type RawMovie = { movie?: { ids?: Ids } };
type RawShow = {
  show?: { ids?: Ids; aired_episodes?: number };
  seasons?: Array<{ number: number; episodes?: Array<{ number: number }> }>;
};

function keysOf(ids: Ids | undefined): string[] {
  const out: string[] = [];
  if (ids?.imdb) out.push(`imdb:${ids.imdb}`);
  if (ids?.tmdb) out.push(`tmdb:${ids.tmdb}`);
  return out;
}

export function readCachedTraktIndex(): TraktWatchedIndex | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const v = raw ? (JSON.parse(raw) as TraktWatchedIndex) : null;
    return v && Array.isArray(v.movies) && Array.isArray(v.shows) && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}

export function writeCachedTraktIndex(index: TraktWatchedIndex): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(index));
  } catch {
    /* too big for storage: it's refetched next time */
  }
}

/** Watched movies, and shows whose every aired episode is watched (specials don't count). */
export async function fetchTraktWatchedIndex(): Promise<TraktWatchedIndex> {
  const [movieRows, showRows] = await Promise.all([
    traktRequest<RawMovie[]>("/sync/watched/movies").catch(() => [] as RawMovie[]),
    traktRequest<RawShow[]>("/sync/watched/shows?extended=full").catch(() => [] as RawShow[]),
  ]);
  const movies = new Set<string>();
  for (const r of movieRows) for (const k of keysOf(r.movie?.ids)) movies.add(k);
  const shows = new Set<string>();
  for (const r of showRows) {
    const aired = r.show?.aired_episodes ?? 0;
    if (aired <= 0) continue;
    const seen = new Set<string>();
    for (const s of r.seasons ?? []) {
      if (s.number < 1) continue;
      for (const e of s.episodes ?? []) seen.add(`${s.number}:${e.number}`);
    }
    if (seen.size >= aired) for (const k of keysOf(r.show?.ids)) shows.add(k);
  }
  return { movies: [...movies], shows: [...shows], at: Date.now() };
}
