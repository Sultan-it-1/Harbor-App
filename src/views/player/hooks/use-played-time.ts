import { useEffect, useMemo, useRef } from "react";
import type { PlayerStatus } from "@/lib/player/bridge";

/**
 * How long this source has really been playing (ms, wall clock while the status is "playing"),
 * from its start. Progress isn't saved before a stream has played a while: an attempt that fails
 * (an error, a placeholder clip, a source that never gets going) leaves no trace in Continue
 * Watching.
 */
export function usePlayedTime(status: PlayerStatus, key: string): { readonly current: number } {
  const total = useRef(0);
  const since = useRef<number | null>(null);
  useEffect(() => {
    total.current = 0;
    since.current = null;
  }, [key]);
  useEffect(() => {
    if (status !== "playing") return;
    since.current = Date.now();
    return () => {
      if (since.current != null) total.current += Date.now() - since.current;
      since.current = null;
    };
  }, [status, key]);
  return useMemo(
    () => ({
      get current() {
        return total.current + (since.current != null ? Date.now() - since.current : 0);
      },
    }),
    [],
  );
}

/** Played long enough to count (see [usePlayedTime]). */
export const MIN_PLAYED_MS = 30_000;
