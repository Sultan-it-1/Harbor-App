import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchAdjacentEpisodes } from "@/lib/series-episodes";
import type { Meta } from "@/lib/cinemeta";
import { getEpisodeProgress } from "@/lib/episode-progress";
import { manualWatchedState, manualWatchedVersion, subscribeManualWatched } from "@/lib/manual-watched";
import { episodeFromVideoId, isAnimeCwItem, libraryMetaType, type LibraryItem } from "@/lib/stremio";
import type { PlayEpisode } from "@/lib/view";

const FINISHED_RATIO = 0.9;
/** How many episodes already marked watched the search for the next one steps over. */
const MAX_WALK = 5;
const NO_TRAKT: Set<string> = new Set();

/** The episode on the card is done: played to the end, or marked watched by hand (or by the
 *  player, which marks one near its end). Marked unwatched by hand, it is not, whatever the bar says. */
function isFinishedSeries(i: LibraryItem, cur: { season: number; episode: number }): boolean {
  if (i.type !== "series" || !i.state) return false;
  const manual = manualWatchedState(i._id, cur.season, cur.episode);
  if (manual !== undefined) return manual;
  const dur = i.state.duration ?? 0;
  const off = i.state.timeOffset ?? 0;
  // Stremio flags an episode from 70 %: the flag alone is not the end of it.
  if ((i.state.flaggedWatched ?? 0) > 0) return dur <= 0 || off / dur >= FINISHED_RATIO;
  return dur > 0 && off / dur >= FINISHED_RATIO;
}

function currentEpisode(i: LibraryItem): { season: number; episode: number } | null {
  const season = i.state?.season;
  const episode = i.state?.episode;
  if (season && episode) return { season, episode };
  const vid = i.state?.video_id ?? "";
  if (/^(kitsu|mal|anilist|anidb):/.test(i._id) && vid.split(":").length === 3) return null;
  return episodeFromVideoId(vid);
}

// Lists name a coming season's first episode before the season is announced. Without an air
// date it is a placeholder, not the next thing to watch. Inside the same season a missing date
// means nothing (lists often leave it out), and anime numbering has no such placeholder.
function isUnannouncedSeason(nextEp: PlayEpisode, isAnime: boolean, currentSeason: number): boolean {
  return !isAnime && !nextEp.airDate && nextEp.season > currentSeason;
}

/** Is the next episode out? [listHasDates]: the episodes around it carry air dates. */
export function isNextAired(isAnime: boolean, airDate: string | undefined, listHasDates: boolean): boolean {
  const t = airDate ? Date.parse(airDate) : NaN;
  if (Number.isFinite(t)) return t <= Date.now();
  // No date. For a series that says nothing. An anime list that has dates leaves them off the
  // episodes not out yet; one with no dates at all cannot say, so the episode is offered as before.
  return !isAnime || !listHasDates;
}

type Adjacent = { prev: PlayEpisode | null; next: PlayEpisode | null };

function sameMap(a: Map<string, LibraryItem>, b: Map<string, LibraryItem>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * For every finished series in [items]: the card for its next episode ([next], by id), or that
 * nothing is left to show ([remove]). Null when [cancelled] says the answer is no longer wanted.
 */
export async function advanceFinished(
  items: LibraryItem[],
  opts: { tmdbKey: string; traktWatched: Set<string>; cache: Map<string, Adjacent>; cancelled: () => boolean },
): Promise<{ next: Map<string, LibraryItem>; remove: Set<string> } | null> {
  const next = new Map<string, LibraryItem>();
  const remove = new Set<string>();
  for (const i of items) {
    const cur = currentEpisode(i);
    if (!cur || !isFinishedSeries(i, cur)) continue;
    const meta: Meta = {
      id: i._id,
      type: libraryMetaType(i.type),
      name: i.name,
      poster: i.poster,
      background: i.background,
    };
    const adjacent = async (at: { season: number; episode: number }): Promise<Adjacent> => {
      const key = `${i._id}:${at.season}:${at.episode}`;
      const hit = opts.cache.get(key);
      if (hit) return hit;
      let failed = false;
      const adj = await fetchAdjacentEpisodes(meta, at, { tmdbKey: opts.tmdbKey }).catch(() => {
        failed = true;
        return { prev: null, next: null };
      });
      // A lookup that failed is asked again next time; an answer (even "nothing") is kept.
      if (!failed) opts.cache.set(key, adj);
      return adj;
    };
    const ids = [i._id, ...(i.altIds ?? [])];
    const imdbId = ids.find((id) => /^tt\d+$/.test(id)) ?? null;
    const tmdbId = ids.find((id) => id.startsWith("tmdb:")) ?? null;
    const watched = (s: number, e: number) =>
      getEpisodeProgress(i._id, s, e, null, imdbId, opts.traktWatched, undefined, undefined, undefined, undefined, tmdbId)
        .watched;

    // The first episode after this one that is not already watched.
    let at = cur;
    let nx: PlayEpisode | null = null;
    let listHasDates = false;
    for (let step = 0; step <= MAX_WALK; step++) {
      const adj = await adjacent(at);
      if (opts.cancelled()) return null;
      if (adj.prev?.airDate) listHasDates = true;
      nx = adj.next;
      if (!nx || step === MAX_WALK || !watched(nx.season, nx.episode)) break;
      at = { season: nx.season, episode: nx.episode };
    }
    const isAnime = isAnimeCwItem(i);
    if (nx && isUnannouncedSeason(nx, isAnime, cur.season)) nx = null;
    if (!nx) {
      // Nothing follows. A card with a position of its own stays as it was; one that is here
      // only because its episode was marked watched has nothing left to show.
      if ((i.state?.timeOffset ?? 0) <= 5_000) remove.add(i._id);
      continue;
    }
    const aired = isNextAired(isAnime, nx.airDate, listHasDates);
    next.set(i._id, {
      ...i,
      state: {
        ...i.state!,
        season: nx.season,
        episode: nx.episode,
        video_id: `${i._id}:${nx.season}:${nx.episode}`,
        timeOffset: 0,
        flaggedWatched: 0,
      },
      upNext: true,
      // Not out yet: the card stays, and says when instead of "Up Next".
      ...(aired ? {} : { waitingForAir: true, nextAirDate: nx.airDate }),
    });
  }
  return { next, remove };
}

export function useCwAdvance(
  items: LibraryItem[],
  tmdbKey: string,
  enabled: boolean,
  /** Episodes Trakt has as watched (see fetchWatchedKeySet), stepped over like the marked ones. */
  traktWatched: Set<string> = NO_TRAKT,
): LibraryItem[] {
  const [advanced, setAdvanced] = useState<Map<string, LibraryItem>>(new Map());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const cacheRef = useRef<Map<string, Adjacent>>(new Map());
  // Marking an episode watched (or not) changes which one is next.
  const manualVer = useSyncExternalStore(subscribeManualWatched, manualWatchedVersion);

  useEffect(() => {
    if (!enabled) {
      setAdvanced((prev) => (prev.size === 0 ? prev : new Map()));
      setRemoved((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    let cancelled = false;
    void advanceFinished(items, { tmdbKey, traktWatched, cache: cacheRef.current, cancelled: () => cancelled }).then(
      (res) => {
        if (!res || cancelled) return;
        setAdvanced((prev) => (sameMap(prev, res.next) ? prev : res.next));
        setRemoved((prev) => (sameSet(prev, res.remove) ? prev : res.remove));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [items, tmdbKey, enabled, traktWatched, manualVer]);

  if (!enabled || (advanced.size === 0 && removed.size === 0)) return items;
  return items.filter((i) => !removed.has(i._id)).map((i) => advanced.get(i._id) ?? i);
}
