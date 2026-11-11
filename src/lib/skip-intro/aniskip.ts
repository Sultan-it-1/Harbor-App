import { safeFetch as fetch } from "@/lib/safe-fetch";
import type { SkipSegment } from "./types";

const malCache = new Map<number, number | null>();
const segmentCache = new Map<string, SkipSegment[]>();
const inflight = new Map<string, Promise<SkipSegment[]>>();

export async function kitsuToMal(kitsuId: number): Promise<number | null> {
  if (malCache.has(kitsuId)) return malCache.get(kitsuId)!;
  const res = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`);
  if (!res.ok) {
    malCache.set(kitsuId, null);
    return null;
  }
  const json = (await res.json()) as {
    data?: Array<{ attributes?: { externalSite?: string; externalId?: string } }>;
  };
  const mal = json.data?.find((d) => d.attributes?.externalSite === "myanimelist/anime");
  const id = mal?.attributes?.externalId ? parseInt(mal.attributes.externalId, 10) : null;
  const out = Number.isFinite(id) ? (id as number) : null;
  malCache.set(kitsuId, out);
  return out;
}

// `episodeLengthSec` is the real length of the file being played. AniSkip stores times per
// release length (a TV cut and a Blu-ray cut of one episode differ), so sending it gets the
// times that fit this file; 0 asks for whatever it has.
export function fetchAniSkipSegments(
  malId: number,
  episode: number,
  episodeLengthSec = 0,
): Promise<SkipSegment[]> {
  const length = Number.isFinite(episodeLengthSec) && episodeLengthSec > 0 ? Math.round(episodeLengthSec) : 0;
  const key = `${malId}:${episode}:${length}`;
  const hit = segmentCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const params = new URLSearchParams();
    for (const t of ["op", "ed", "mixed-op", "mixed-ed", "recap"]) params.append("types", t);
    params.set("episodeLength", String(length));
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      segmentCache.set(key, []);
      return [];
    }
    const json = (await res.json()) as {
      found?: boolean;
      results?: Array<{
        interval?: { startTime?: number; endTime?: number };
        skipType?: string;
      }>;
    };
    if (!json.found || !json.results) {
      segmentCache.set(key, []);
      return [];
    }
    const segments: SkipSegment[] = [];
    for (const r of json.results) {
      const start = r.interval?.startTime;
      const end = r.interval?.endTime;
      const t = r.skipType ?? "";
      if (typeof start !== "number" || typeof end !== "number" || end <= start) continue;
      const kind: SkipSegment["kind"] = t === "ed" || t === "mixed-ed" ? "outro" : t === "recap" ? "recap" : "intro";
      segments.push({ kind, startSec: start, endSec: end, source: "aniskip" });
    }
    segments.sort((a, b) => a.startSec - b.startSec);
    segmentCache.set(key, segments);
    return segments;
  })()
    .catch((): SkipSegment[] => [])
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
