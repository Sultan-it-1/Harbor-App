import { simklRequest, SimklApiError } from "./client";
import { getSession } from "./session";
import { isCwDismissed } from "@/lib/cw-dismiss";
import { readResumeEntry, saveResumeBatch } from "@/lib/resume";
import type { LibraryItem } from "@/lib/stremio";

type Ids = {
  imdb?: string;
  tmdb?: number | string;
  mal?: number;
  kitsu?: number;
  anilist?: number;
  anidb?: number;
};

type Node = { title?: string; year?: number; ids?: Ids };

type RawSession = {
  progress?: number;
  /** When a paused session was left. Sessions carry this, not watched_at. */
  paused_at?: string;
  watched_at?: string;
  movie?: Node;
  show?: Node;
  anime?: Node;
  episode?: {
    season?: number;
    number?: number;
    episode?: number;
    tvdb_season?: number;
    tvdb_number?: number;
  };
};

const DURATION_MS = { movie: 6_300_000, series: 2_640_000 };

function movieMetaId(ids?: Ids): string | null {
  if (!ids) return null;
  if (ids.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  if (ids.tmdb) return `tmdb:movie:${ids.tmdb}`;
  return null;
}

function seriesMetaId(ids?: Ids): string | null {
  if (!ids) return null;
  if (ids.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  if (ids.tmdb) return `tmdb:tv:${ids.tmdb}`;
  if (ids.mal) return `mal:${ids.mal}`;
  if (ids.kitsu) return `kitsu:${ids.kitsu}`;
  return null;
}

function buildItem(
  id: string,
  type: "movie" | "series",
  node: Node,
  pct: number,
  durMs: number,
  when: string,
  season?: number,
  episode?: number,
  isAnime?: boolean,
): LibraryItem {
  const hasEpisode =
    type === "series" && season != null && season > 0 && episode != null && episode > 0;
  return {
    _id: id,
    type,
    name: node.title ?? "Untitled",
    state: {
      timeOffset: Math.round((pct / 100) * durMs),
      duration: durMs,
      season: hasEpisode ? season : undefined,
      episode: hasEpisode ? episode : undefined,
      // The same shape a Stremio or local card carries, so the copies of one episode can be
      // matched, and a dismissal knows which episode it was for.
      video_id: hasEpisode ? `${id}:${season}:${episode}` : undefined,
      lastWatched: when,
    },
    removed: false,
    temp: false,
    _ctime: when,
    _mtime: when,
    external: "simkl",
    isAnime,
    year: typeof node.year === "number" && node.year > 0 ? node.year : undefined,
  };
}

function toLibraryItem(raw: RawSession): LibraryItem | null {
  const pct = Math.min(100, Math.max(0, raw.progress ?? 0));
  if (pct < 2 || pct > 98) return null;
  // paused_at is what a playback session has. With watched_at alone every card dated from 1970
  // and sorted last.
  const when = raw.paused_at ?? raw.watched_at ?? new Date(0).toISOString();

  if (raw.movie) {
    const id = movieMetaId(raw.movie.ids);
    return id ? buildItem(id, "movie", raw.movie, pct, DURATION_MS.movie, when) : null;
  }

  if (!raw.show && !raw.episode && raw.anime) {
    const movieId = movieMetaId(raw.anime.ids);
    if (movieId) {
      return buildItem(movieId, "movie", raw.anime, pct, DURATION_MS.movie, when, undefined, undefined, true);
    }
  }

  const seriesNode = raw.show ?? raw.anime;
  if (seriesNode) {
    const anime = !!raw.anime && !raw.show;
    const ids = seriesNode.ids;
    // Simkl keeps every season of an anime as its own entry and counts its episodes from 1. Only
    // the anime's own id (Kitsu, MAL, AniList) names that entry; an IMDb id names the whole show.
    const nativeId = anime
      ? ids?.kitsu
        ? `kitsu:${ids.kitsu}`
        : ids?.mal
          ? `mal:${ids.mal}`
          : ids?.anilist
            ? `anilist:${ids.anilist}`
            : null
      : null;
    const mappedAnime = anime && !nativeId;
    const id = nativeId ?? seriesMetaId(ids);
    if (!id) return null;
    const season = mappedAnime
      ? raw.episode?.tvdb_season
      : (raw.episode?.season ?? (anime ? 1 : undefined));
    const episode = mappedAnime
      ? raw.episode?.tvdb_number
      : (raw.episode?.number ?? raw.episode?.episode);
    // An anime known only by its show-wide id needs the show-wide (TVDB) numbering: the entry's
    // own "episode 3" would open episode 3 of season 1.
    if (mappedAnime && (season == null || episode == null)) return null;
    return buildItem(id, "series", seriesNode, pct, DURATION_MS.series, when, season, episode, anime);
  }
  return null;
}

/** The title's other ids (IMDb, TMDB), so the same title from another source is seen as a copy. */
function otherIds(ids: Ids | undefined, type: string, own: string): string[] {
  const out: string[] = [];
  if (ids?.imdb && /^tt\d+$/.test(ids.imdb)) out.push(ids.imdb);
  if (ids?.tmdb) out.push(`${type === "movie" ? "tmdb:movie" : "tmdb:tv"}:${ids.tmdb}`);
  return out.filter((id) => id !== own);
}

/** One viewing reaches the device's own save and the tracker seconds apart. */
const SAME_VIEWING_MS = 2 * 60_000;

/**
 * Saves a tracker's paused position (Simkl's, Trakt's) as this device's resume point, where it
 * is the newer one. Before, it was only written where the device had none, so an episode
 * continued elsewhere still resumed from the old place here.
 */
export function backfillTrackerResume(item: LibraryItem): void {
  const st = item.state;
  if (!st || !(st.duration > 0)) return;
  // A dismissed card keeps no saved position: writing one back would undo part of the dismissal.
  if (isCwDismissed(item)) return;
  const existing = readResumeEntry(item._id, st.season, st.episode);
  const remoteT = Date.parse(st.lastWatched ?? "");
  const remoteValid = Number.isFinite(remoteT) && remoteT > 0;
  const ratio = st.timeOffset / st.duration;
  // A tracker only knows a percentage. Where this device measured the real length, use it, and
  // leave a position that already agrees alone: it is the exact one, the tracker's an estimate.
  const measured = existing?.d && existing.d > 0 ? existing.d : 0;
  if (existing && measured > 0 && Math.abs(existing.ms / measured - ratio) < 0.02) return;
  const ms = measured > 0 ? Math.round(ratio * measured) : st.timeOffset;
  // Newer by more than a moment: the pause this device itself just reported comes back dated a
  // second later, and must not replace the exact position with its estimate.
  const shouldWrite =
    !existing || (remoteValid && remoteT > existing.t + SAME_VIEWING_MS) || (!existing.t && ms > existing.ms);
  if (!shouldWrite) return;
  // Dated when it was paused, not now: a sync is not a viewing and must not move the card up.
  saveResumeBatch([{ id: item._id, ms, season: st.season, episode: st.episode, t: remoteValid ? remoteT : 0 }]);
}

export async function fetchSimklPlaybackItems(): Promise<LibraryItem[]> {
  if (!getSession()) return [];
  let raw: RawSession[];
  try {
    raw = await simklRequest<RawSession[]>("/sync/playback?hide_watched=true&limit=40");
  } catch (e) {
    if (e instanceof SimklApiError && e.status === 404) return [];
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
    const node = r.movie ?? r.show ?? r.anime;
    const altIds = otherIds(node?.ids, item.type, item._id);
    if (altIds.length > 0) item.altIds = altIds;
    items.push(item);
    backfillTrackerResume(item);
  }
  return items;
}
