import { useEffect, useMemo, useState } from "react";
import { fetchShowWatchedKeys } from "./history";

/**
 * [base] (what Trakt has as watched across the account) with every episode of this one show that
 * Trakt has as watched, however long ago: Trakt's lists no longer say which episodes of a show
 * were watched, so the show's own page asks for them. [metaId] / [imdbId] name the show.
 */
export function useTraktShowWatched(
  base: Set<string>,
  enabled: boolean,
  metaId: string,
  imdbId: string | null,
): Set<string> {
  const [show, setShow] = useState<Set<string>>(() => new Set());
  const imdb = imdbId ?? (/^tt\d+/.test(metaId) ? metaId.split(":")[0] : null);
  const tmdbMatch = metaId.match(/^tmdb:(?:tv:)?(\d+)/);
  const tmdb = tmdbMatch ? Number(tmdbMatch[1]) : null;
  useEffect(() => {
    setShow(new Set());
    if (!enabled || (!imdb && !tmdb)) return;
    let cancelled = false;
    fetchShowWatchedKeys({ imdb, tmdb })
      .then((s) => {
        if (!cancelled) setShow(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, imdb, tmdb]);
  return useMemo(() => {
    if (show.size === 0) return base;
    const all = new Set(base);
    for (const k of show) all.add(k);
    return all;
  }, [base, show]);
}
