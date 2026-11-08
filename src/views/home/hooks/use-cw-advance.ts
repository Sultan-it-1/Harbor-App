import { useEffect, useRef, useState } from "react";
import { fetchAdjacentEpisodes } from "@/lib/series-episodes";
import type { Meta } from "@/lib/cinemeta";
import { episodeFromVideoId, libraryMetaType, type LibraryItem } from "@/lib/stremio";

const FINISHED_RATIO = 0.9;

function isFinishedSeries(i: LibraryItem): boolean {
  if (i.type !== "series" || !i.state) return false;
  if ((i.state.flaggedWatched ?? 0) <= 0) return false;
  const dur = i.state.duration ?? 0;
  const off = i.state.timeOffset ?? 0;
  return dur <= 0 || off / dur >= FINISHED_RATIO;
}

function currentEpisode(i: LibraryItem): { season: number; episode: number } | null {
  const season = i.state?.season;
  const episode = i.state?.episode;
  if (season && episode) return { season, episode };
  const vid = i.state?.video_id ?? "";
  if (/^(kitsu|mal|anilist|anidb):/.test(i._id) && vid.split(":").length === 3) return null;
  return episodeFromVideoId(vid);
}

function sameMap(a: Map<string, LibraryItem>, b: Map<string, LibraryItem>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function useCwAdvance(
  items: LibraryItem[],
  tmdbKey: string,
  enabled: boolean,
): LibraryItem[] {
  const [advanced, setAdvanced] = useState<Map<string, LibraryItem>>(new Map());
  const cacheRef = useRef<Map<string, { season: number; episode: number } | null>>(new Map());

  useEffect(() => {
    if (!enabled) {
      setAdvanced((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    const targets = items.filter((i) => currentEpisode(i) && isFinishedSeries(i));
    void (async () => {
      const next = new Map<string, LibraryItem>();
      for (const i of targets) {
        const cur = currentEpisode(i)!;
        const key = `${i._id}:${cur.season}:${cur.episode}`;
        let nx = cacheRef.current.get(key);
        if (nx === undefined) {
          const meta: Meta = {
            id: i._id,
            type: libraryMetaType(i.type),
            name: i.name,
            poster: i.poster,
            background: i.background,
          };
          const adj = await fetchAdjacentEpisodes(meta, cur, { tmdbKey }).catch(() => ({
            prev: null,
            next: null,
          }));
          if (cancelled) return;
          nx = adj.next ? { season: adj.next.season, episode: adj.next.episode } : null;
          cacheRef.current.set(key, nx);
        }
        if (nx) {
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
          });
        }
      }
      if (!cancelled) setAdvanced((prev) => (sameMap(prev, next) ? prev : next));
    })();
    return () => {
      cancelled = true;
    };
  }, [items, tmdbKey, enabled]);

  if (!enabled || advanced.size === 0) return items;
  return items.map((i) => advanced.get(i._id) ?? i);
}
