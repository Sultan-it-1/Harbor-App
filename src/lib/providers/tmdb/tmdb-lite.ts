import { get, IMG } from "./tmdb-client";

export type TmdbLiteMeta = {
  name: string | null;
  poster: string | null;
  background: string | null;
};

const cache = new Map<string, TmdbLiteMeta | null>();
const inflight = new Map<string, Promise<TmdbLiteMeta | null>>();

type RawLite = {
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
};

export async function tmdbLiteMeta(key: string, metaId: string): Promise<TmdbLiteMeta | null> {
  if (!key) return null;
  const match = metaId.match(/^tmdb:(movie|tv):(\d+)$/);
  if (!match) return null;
  const hit = cache.get(metaId);
  if (hit !== undefined) return hit;
  const existing = inflight.get(metaId);
  if (existing) return existing;
  const p = (async () => {
    try {
      const raw = await get<RawLite>(key, `${match[1]}/${match[2]}`);
      const out: TmdbLiteMeta | null = raw
        ? {
            name: (raw.title ?? raw.name ?? "").trim() || null,
            poster: raw.poster_path ? `${IMG}/w300${raw.poster_path}` : null,
            background: raw.backdrop_path ? `${IMG}/w780${raw.backdrop_path}` : null,
          }
        : null;
      cache.set(metaId, out);
      return out;
    } catch {
      return null;
    } finally {
      inflight.delete(metaId);
    }
  })();
  inflight.set(metaId, p);
  return p;
}
