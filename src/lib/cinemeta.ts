import { lruGet, lruSet } from "@/lib/cache";
import { registerEvictable } from "@/lib/maintenance";
import { safeFetch as fetch } from "@/lib/safe-fetch";

const CINEMETA = "https://v3-cinemeta.strem.io";

export type MetaType = "movie" | "series" | "channel" | "tv" | "anime" | "other";

export function narrowMediaType(t: MetaType | string | undefined): "movie" | "series" {
  return t === "series" ? "series" : "movie";
}

export type Meta = {
  id: string;
  type: MetaType;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  originalLanguage?: string;
  releaseInfo?: string;
  releaseDate?: string;
  inTheaters?: boolean;
  imdbRating?: string;
  runtime?: string;
  genres?: string[];
  trailers?: Array<{ source: string; type?: string }>;
  trailerStreams?: Array<{ ytId?: string; title?: string }>;
  addonOrigin?: { id: string; name: string; logo?: string; base?: string };
  behaviorHints?: { defaultVideoId?: string | null };
  videos?: Array<{
    id?: string;
    season?: number;
    episode?: number;
    number?: number;
    released?: string;
    firstAired?: string;
    name?: string;
    title?: string;
    thumbnail?: string;
    streams?: Array<Record<string, unknown>>;
  }>;
};

export function isAddonNativeMeta(meta: Meta): boolean {
  if (meta.type === "tv" || meta.type === "channel") return true;
  if (!meta.addonOrigin) return false;
  const id = meta.id || "";
  const resolvable =
    /^tt\d/.test(id) ||
    id.startsWith("tmdb:") ||
    id.startsWith("kitsu:") ||
    id.startsWith("mal:");
  return !resolvable;
}

async function catalog(path: string): Promise<Meta[]> {
  // Offline, or a captive portal / proxy answering with an HTML page: an empty row, not an
  // unhandled rejection ("Unexpected token '<'").
  try {
    const res = await fetch(`${CINEMETA}/catalog/${path}.json`);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.metas) ? json.metas : [];
  } catch (e) {
    console.warn("[cinemeta] catalog failed", path, e);
    return [];
  }
}

function cinemetaTopPath(type: "movie" | "series", genre?: string, skip = 0): string {
  const parts = [`${type}/top`];
  if (genre) parts.push(`genre=${encodeURIComponent(genre)}`);
  if (skip > 0) parts.push(`skip=${skip}`);
  return parts.join("/");
}

export const topMovies = (genre?: string, skip = 0) =>
  catalog(cinemetaTopPath("movie", genre, skip));

export const topSeries = (genre?: string, skip = 0) =>
  catalog(cinemetaTopPath("series", genre, skip));

// The card, the hero, the detail page and the rating of one title all ask for the same meta
// within moments of each other: an answer is kept for five minutes, and a request already on
// its way is shared. Failures are not kept, so the next call tries again.
const META_TTL_MS = 5 * 60 * 1000;
const META_CACHE_MAX = 48;
const metaCache = new Map<string, { v: Meta; t: number }>();
const metaInflight = new Map<string, Promise<Meta | null>>();

registerEvictable("cinemeta-meta", (aggressive) => {
  if (aggressive) return metaCache.clear();
  const now = Date.now();
  for (const [k, e] of metaCache) if (now - e.t > META_TTL_MS) metaCache.delete(k);
});

export async function meta(type: "movie" | "series", id: string): Promise<Meta | null> {
  const key = `${type}/${id}`;
  const hit = lruGet(metaCache, key);
  if (hit && Date.now() - hit.t < META_TTL_MS) return hit.v;
  const pending = metaInflight.get(key);
  if (pending) return pending;
  const p = fetchMeta(type, id)
    .then((m) => {
      if (m) lruSet(metaCache, key, { v: m, t: Date.now() }, META_CACHE_MAX);
      return m;
    })
    .finally(() => metaInflight.delete(key));
  metaInflight.set(key, p);
  return p;
}

async function fetchMeta(type: "movie" | "series", id: string): Promise<Meta | null> {
  try {
    const res = await fetch(`${CINEMETA}/meta/${type}/${id}.json`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.meta ?? null;
  } catch (e) {
    console.warn("[cinemeta] meta failed", type, id, e);
    return null;
  }
}
