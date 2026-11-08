import { useEffect, useMemo, useState } from "react";
import {
  invalidateAnimeAwardSynonyms,
  uniqueWinnerFranchisesAcrossSources,
  type AwardWin,
} from "@/lib/anime-awards";
import type { Meta } from "@/lib/cinemeta";
import { animeSearchByTitle } from "@/lib/anilist/catalog";

const CACHE_KEY = "harbor.anime_awards.metas.v2";
const NULLS_CLEARED_KEY = "harbor.anime_awards.metas.v2.anilist";

type CacheValue = Meta | null;

let memCache: Record<string, CacheValue> | null = null;
let memLoaded = false;

function loadCache(): Record<string, CacheValue> {
  if (memCache) return memCache;
  if (typeof localStorage === "undefined") {
    memCache = {};
    memLoaded = true;
    return memCache;
  }
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    memCache = raw ? JSON.parse(raw) : {};
    // "No match" from the months Jikan (closed 1 Oct 2026) didn't answer: asked again.
    if (localStorage.getItem(NULLS_CLEARED_KEY) !== "1") {
      for (const [k, v] of Object.entries(memCache ?? {})) if (v == null) delete memCache![k];
      localStorage.setItem(NULLS_CLEARED_KEY, "1");
    }
  } catch {
    memCache = {};
  }
  memLoaded = true;
  return memCache!;
}

let saveTimer: number | null = null;
function scheduleSave() {
  if (typeof window === "undefined" || !memLoaded) return;
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(memCache ?? {}));
    } catch {
      // quota exceeded — drop oldest half
      try {
        const c = memCache ?? {};
        const keys = Object.keys(c);
        const drop = keys.slice(0, Math.floor(keys.length / 2));
        for (const k of drop) delete c[k];
        localStorage.setItem(CACHE_KEY, JSON.stringify(c));
      } catch {
        /* give up */
      }
    }
  }, 500);
}

let resolveAllPromise: Promise<void> | null = null;

/** Titles looked up per request (AniList takes about 18 lists in one). */
const AWARD_GROUP = 18;

async function resolveAll(onProgress: () => void): Promise<void> {
  if (resolveAllPromise) return resolveAllPromise;
  resolveAllPromise = (async () => {
    const cache = loadCache();
    const winners = Array.from(uniqueWinnerFranchisesAcrossSources().entries()).filter(([fk]) => !(fk in cache));
    // AniList answers 30 requests a minute and the anime page's rows come first: the titles go a
    // group at a time (each group one request), a few seconds apart, once the rows have been
    // asked for. What's found is kept, so this happens once. A title AniList couldn't be asked
    // about (no network) isn't kept as "no match", so it is asked again next time.
    for (let i = 0; i < winners.length; i += AWARD_GROUP) {
      await new Promise((r) => setTimeout(r, i === 0 ? 3000 : 4000));
      await Promise.all(
        winners.slice(i, i + AWARD_GROUP).map(async ([fk, win]) => {
          try {
            const results = await animeSearchByTitle(win.title, 1);
            cache[fk] = results[0] ?? null;
          } catch {
            return;
          }
          scheduleSave();
          invalidateAnimeAwardSynonyms();
          onProgress();
        }),
      );
    }
  })().finally(() => {
    // A later visit tries the ones that couldn't be asked.
    resolveAllPromise = null;
  });
  return resolveAllPromise;
}

export type AwardWinnerEntry = { meta: Meta; win: AwardWin };

export function useCrunchyrollAwardMetas(): AwardWinnerEntry[] {
  const winnerMap = useMemo(() => uniqueWinnerFranchisesAcrossSources(), []);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void resolveAll(() => {
      if (cancelled) return;
      setTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const cache = loadCache();
    const out: AwardWinnerEntry[] = [];
    for (const [fk, win] of winnerMap.entries()) {
      const cached = cache[fk];
      if (cached) out.push({ meta: cached, win });
    }
    out.sort((a, b) => {
      if (a.win.isAOTY !== b.win.isAOTY) return a.win.isAOTY ? -1 : 1;
      if (b.win.year !== a.win.year) return b.win.year - a.win.year;
      return 0;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winnerMap, tick]);
}
