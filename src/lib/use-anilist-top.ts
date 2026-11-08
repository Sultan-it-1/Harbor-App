import { useEffect, useState } from "react";
import { fetchAnilistTopAnime, fetchAnilistTrendingAnime } from "@/lib/anilist/browse";
import type { Meta } from "@/lib/cinemeta";

const cache: Record<string, Meta[]> = {};
const inflight: Record<string, Promise<Meta[]> | undefined> = {};

/** [retry]: a new value asks again when the last answer was empty (the network failed). */
function useBrowse(key: "top" | "trending", retry: number): Meta[] {
  const [metas, setMetas] = useState<Meta[]>(() => cache[key] ?? []);

  useEffect(() => {
    if (cache[key]) {
      setMetas(cache[key]);
      return;
    }
    let cancelled = false;
    if (!inflight[key]) {
      const fetcher = key === "top" ? fetchAnilistTopAnime(100) : fetchAnilistTrendingAnime(40);
      inflight[key] = fetcher.then((list) => {
        // An empty answer is a failure (each page's error is swallowed): not kept, so a later
        // visit asks again instead of showing nothing for the rest of the session.
        if (list.length > 0) cache[key] = list;
        inflight[key] = undefined;
        return list;
      });
    }
    inflight[key]
      ?.then((list) => {
        if (!cancelled) setMetas(list);
      })
      .catch(() => {
        inflight[key] = undefined;
      });
    return () => {
      cancelled = true;
    };
  }, [key, retry]);

  return metas;
}

export function useAnilistTop(retry = 0): Meta[] {
  return useBrowse("top", retry);
}

export function useAnilistTrending(retry = 0): Meta[] {
  return useBrowse("trending", retry);
}
