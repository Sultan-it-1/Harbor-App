import { safeFetch as fetch } from "@/lib/safe-fetch";
import type { SkipKind, SkipSegment } from "./types";
import { warnProviderFailure } from "./provider-log";

type RawSpan = { start_ms: number | null; end_ms: number | null };

// v4 answers with a TVDB id where v2 sent a TMDB one. We only read the span arrays,
// which did not change between the two versions.
type RawResponse = {
  tvdb_id?: number;
  type?: string;
  intro?: RawSpan[];
  recap?: RawSpan[];
  credits?: RawSpan[];
  preview?: RawSpan[];
};

const cache = new Map<string, RawResponse | null>();
const inflight = new Map<string, Promise<RawResponse | null>>();

// After a failure that is not "we have nothing for this title" (rate limit, bad key,
// server error) stop asking for a while instead of repeating it for every episode.
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
let coolingUntil = 0;

// Optional personal API key (setting `theIntroDbKey`). Empty means the request goes out
// with no Authorization header at all. `epoch` makes answers fetched with an old key
// harmless: they are returned to their caller but never stored.
let apiKey = "";
let epoch = 0;

export function setTheIntroDbApiKey(key: string): void {
  const next = key.trim();
  if (next === apiKey) return;
  apiKey = next;
  epoch += 1;
  cache.clear();
  inflight.clear();
  coolingUntil = 0;
}

function pickId(metaId: string): { tmdb?: string; imdb?: string } | null {
  if (metaId.startsWith("tmdb:movie:")) return { tmdb: metaId.slice("tmdb:movie:".length) };
  if (metaId.startsWith("tmdb:tv:")) return { tmdb: metaId.slice("tmdb:tv:".length) };
  if (metaId.startsWith("tt")) return { imdb: metaId };
  return null;
}

function spanToSegment(span: RawSpan, kind: SkipKind, durationSec: number): SkipSegment | null {
  const startMs = span.start_ms ?? 0;
  const endMs = span.end_ms ?? (durationSec > 0 ? Math.round(durationSec * 1000) : null);
  if (endMs == null) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;
  return {
    kind,
    startSec: startMs / 1000,
    endSec: endMs / 1000,
    source: "introdb",
  };
}

async function fetchRaw(cacheKey: string): Promise<RawResponse | null> {
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  if (Date.now() < coolingUntil) return null;
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  const gen = epoch;
  const key = apiKey;
  const p = (async () => {
    const res = await fetch(
      `https://api.theintrodb.org/v4/media?${cacheKey}`,
      key ? { headers: { Authorization: `Bearer ${key}` } } : undefined,
    );
    if (!res.ok) {
      if (res.status === 404) {
        // 404 is a real answer: nobody has submitted times for this title yet.
        if (gen === epoch) cache.set(cacheKey, null);
      } else {
        if (gen === epoch) coolingUntil = Date.now() + FAILURE_COOLDOWN_MS;
        warnProviderFailure("theintrodb", res.status, cacheKey);
      }
      return null;
    }
    const json = (await res.json()) as RawResponse;
    if (gen === epoch) cache.set(cacheKey, json);
    return json;
  })()
    .catch(() => null)
    .finally(() => {
      if (gen === epoch) inflight.delete(cacheKey);
    });
  inflight.set(cacheKey, p);
  return p;
}

export async function fetchIntroDbSegments(
  metaId: string,
  episode: { season: number; episode: number } | undefined,
  durationSec: number,
): Promise<SkipSegment[]> {
  const ids = pickId(metaId);
  if (!ids) return [];

  const params = new URLSearchParams();
  if (ids.tmdb) params.set("tmdb_id", ids.tmdb);
  else if (ids.imdb) params.set("imdb_id", ids.imdb);
  if (episode) {
    params.set("season", String(episode.season));
    params.set("episode", String(episode.episode));
  }
  // The file's real length lets the server pick times submitted for a cut of the same length.
  // Rounded to whole seconds so a length that settles by a few milliseconds while the file
  // opens does not turn into a second request for the same episode.
  if (Number.isFinite(durationSec) && durationSec > 0) {
    params.set("duration_ms", String(Math.round(durationSec) * 1000));
  }

  const json = await fetchRaw(params.toString());
  if (!json) return [];
  const out: SkipSegment[] = [];
  const collect = (spans: RawSpan[] | undefined, kind: SkipKind) => {
    if (!spans) return;
    for (const s of spans) {
      const seg = spanToSegment(s, kind, durationSec);
      if (seg) out.push(seg);
    }
  };
  collect(json.intro, "intro");
  collect(json.recap, "recap");
  collect(json.credits, "outro");
  collect(json.preview, "outro");
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}
