import { traktRequest } from "./client";
import { getSession } from "./session";
import { backfillTrackerResume } from "@/lib/simkl/playback";
import type { LibraryItem } from "@/lib/stremio";
import type { TraktIds } from "./types";

type Node = { title?: string; year?: number | null; ids?: TraktIds };

/** One entry of Trakt's /sync/playback: a movie or an episode left part-way. */
type RawPlayback = {
  progress?: number;
  paused_at?: string;
  type?: "movie" | "episode";
  movie?: Node;
  show?: Node;
  episode?: { season?: number; number?: number };
};

// Trakt gives a percentage, not a length: these stand in for it (a film, an episode).
const DURATION_MS = { movie: 6_300_000, series: 2_640_000 };

function imdbOf(ids?: TraktIds): string | null {
  const imdb = ids?.imdb ? String(ids.imdb).trim().toLowerCase() : "";
  return /^tt\d+$/.test(imdb) ? imdb : null;
}

function tmdbOf(ids: TraktIds | undefined, type: "movie" | "series"): string | null {
  return ids?.tmdb ? `${type === "movie" ? "tmdb:movie" : "tmdb:tv"}:${ids.tmdb}` : null;
}

function toLibraryItem(raw: RawPlayback): LibraryItem | null {
  const pct = Math.min(100, Math.max(0, raw.progress ?? 0));
  // Barely started or as good as finished: nothing to continue (the same bounds as Simkl's).
  if (pct < 2 || pct > 98) return null;
  const type: "movie" | "series" | null = raw.movie && !raw.episode ? "movie" : raw.show ? "series" : null;
  const node = type === "movie" ? raw.movie : raw.show;
  if (!type || !node) return null;
  const imdb = imdbOf(node.ids);
  const tmdb = tmdbOf(node.ids, type);
  const id = imdb ?? tmdb;
  if (!id) return null;
  const season = raw.episode?.season;
  const episode = raw.episode?.number;
  const hasEpisode = type === "series" && season != null && season >= 0 && episode != null && episode >= 1;
  // An episode entry that doesn't say which episode can't be resumed.
  if (type === "series" && !hasEpisode) return null;
  const when = raw.paused_at ?? new Date(0).toISOString();
  const durMs = DURATION_MS[type];
  const altIds = [imdb, tmdb].filter((x): x is string => !!x && x !== id);
  return {
    _id: id,
    type,
    name: node.title ?? "Untitled",
    state: {
      timeOffset: Math.round((pct / 100) * durMs),
      duration: durMs,
      season: hasEpisode ? season : undefined,
      episode: hasEpisode ? episode : undefined,
      video_id: hasEpisode ? `${id}:${season}:${episode}` : undefined,
      lastWatched: when,
    },
    removed: false,
    temp: false,
    _ctime: when,
    _mtime: when,
    external: "trakt",
    altIds: altIds.length > 0 ? altIds : undefined,
    year: typeof node.year === "number" && node.year > 0 ? node.year : undefined,
  };
}

/**
 * What is paused on Trakt, as Continue Watching cards. Empty when signed out or when Trakt can't
 * be reached: the row then simply has no Trakt cards.
 */
export async function fetchTraktPlaybackItems(): Promise<LibraryItem[]> {
  if (!getSession()) return [];
  let raw: RawPlayback[];
  try {
    raw = await traktRequest<RawPlayback[]>("/sync/playback?limit=40");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const items: LibraryItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const item = toLibraryItem(r);
    if (!item?.state) continue;
    const key = `${item._id}|${item.state.season ?? ""}|${item.state.episode ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    backfillTrackerResume(item);
  }
  return items;
}
