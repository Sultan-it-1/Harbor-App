import { timedFetch } from "@/lib/safe-fetch";

/** How long one search request may take before it's dropped (a dead addon mustn't hold things up). */
export const SEARCH_REQUEST_MS = 5000;
/** Most distinct addon requests one search will make. */
const MAX_REQUESTS = 28;

/**
 * The network side of one search. Every address is fetched once per search (the addon catalogs and
 * the per-addon groups ask the same ones), each request has a short timeout, a new search cancels
 * the previous one's requests, and the number of addon requests is capped so a phone isn't flooded.
 */
export type SearchRun = {
  signal: AbortSignal;
  /** JSON of an address, or null on any failure. Same address twice = the same request. */
  json<T>(url: string): Promise<T | null>;
};

export function createSearchRun(signal: AbortSignal): SearchRun {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    signal,
    json<T>(url: string): Promise<T | null> {
      const have = inflight.get(url);
      if (have) return have as Promise<T | null>;
      if (inflight.size >= MAX_REQUESTS) return Promise.resolve(null);
      const p = timedFetch(url, { headers: { Accept: "application/json" }, signal }, SEARCH_REQUEST_MS)
        .then(async (res) => (res.ok ? ((await res.json().catch(() => null)) as T | null) : null))
        .catch(() => null);
      inflight.set(url, p);
      return p;
    },
  };
}
