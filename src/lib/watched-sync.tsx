import { useEffect } from "react";
import { useSettings } from "@/lib/settings";
import { useTrakt } from "@/lib/trakt/provider";
import {
  fetchTraktWatchedIndex,
  readCachedTraktIndex,
  TRAKT_INDEX_MAX_AGE_MS,
  writeCachedTraktIndex,
} from "@/lib/trakt/watched-index";
import { setTraktWatched, setWatchedMarksEnabled } from "@/lib/watched-marks";

/** Keeps the watched marks' outside sources in step with Settings and the Trakt connection. */
export function WatchedMarksSync() {
  const { settings } = useSettings();
  const { isConnected: traktConnected } = useTrakt();
  const on = settings.showWatchedMarks !== false;

  useEffect(() => {
    setWatchedMarksEnabled(on);
  }, [on]);

  useEffect(() => {
    if (!on || !traktConnected) {
      setTraktWatched(null);
      return;
    }
    // Show the last known answer at once, then refresh it when it's getting old.
    const cached = readCachedTraktIndex();
    if (cached) setTraktWatched(cached);
    if (cached && Date.now() - cached.at < TRAKT_INDEX_MAX_AGE_MS) return;
    let cancelled = false;
    fetchTraktWatchedIndex()
      .then((index) => {
        if (cancelled) return;
        writeCachedTraktIndex(index);
        setTraktWatched(index);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [on, traktConnected]);

  return null;
}
