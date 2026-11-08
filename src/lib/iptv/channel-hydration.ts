import { lruSet } from "@/lib/cache";
import { idbGet, idbSet } from "@/lib/idb-kv";
import { safeFetch as fetch } from "@/lib/safe-fetch";
import type { Meta } from "@/lib/cinemeta";
import { extractTitleFromChannelName } from "./channel-title";

const CINEMETA = "https://v3-cinemeta.strem.io";
// Kept in IndexedDB, not localStorage: up to 5,000 metas would crowd logins and settings out of
// localStorage's ~5 MB quota. The old localStorage copy is moved over once, then removed.
const IDB_KEY = "iptv.hydration.v3";
const LEGACY_STORAGE_KEY = "harbor.iptv.hydration.v2";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE = 5000;
const CHANNEL_TO_QUERY_MAX = 2000;
const MAX_DESCRIPTION = 600;

type CacheEntry = {
  meta: Meta | null;
  at: number;
};

const queryCache = new Map<string, CacheEntry>();
const channelToQuery = new Map<string, string | null>();
const inflight = new Map<string, Promise<Meta | null>>();
let ready: Promise<void> | null = null;
let saveTimer: number | null = null;

/** Only what the channel cards and the detail page's first paint use: no episode lists. */
function compact(m: Meta): Meta {
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    poster: m.poster,
    background: m.background,
    logo: m.logo,
    description: m.description?.slice(0, MAX_DESCRIPTION),
    releaseInfo: m.releaseInfo,
    imdbRating: m.imdbRating,
    runtime: m.runtime,
    genres: m.genres?.slice(0, 6),
  };
}

function readLegacy(): Record<string, CacheEntry> | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return JSON.parse(raw) as Record<string, CacheEntry>;
  } catch {
    return null;
  }
}

function loadCache(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const stored = await idbGet<Record<string, CacheEntry>>(IDB_KEY);
    const legacy = readLegacy();
    const source = stored ?? legacy;
    if (!source || typeof source !== "object") return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(source)) {
      if (queryCache.has(key)) continue;
      if (entry && typeof entry === "object" && typeof entry.at === "number" && now - entry.at < TTL_MS) {
        lruSet(queryCache, key, { meta: entry.meta ? compact(entry.meta) : null, at: entry.at }, MAX_CACHE);
      }
    }
    if (!stored && legacy) scheduleSave();
  })().catch(() => {});
  return ready;
}

function scheduleSave() {
  if (saveTimer != null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    persist();
  }, 1500);
}

function persist() {
  const trimmed = Array.from(queryCache.entries()).slice(-MAX_CACHE);
  const obj: Record<string, CacheEntry> = {};
  for (const [k, v] of trimmed) obj[k] = v;
  void idbSet(IDB_KEY, obj);
}

function queryForChannel(channelName: string): { query: string | null; preferType: "movie" | "series" | null } {
  const memoed = channelToQuery.get(channelName);
  if (memoed !== undefined) {
    return { query: memoed, preferType: null };
  }
  const extracted = extractTitleFromChannelName(channelName);
  lruSet(channelToQuery, channelName, extracted.query, CHANNEL_TO_QUERY_MAX);
  return { query: extracted.query, preferType: extracted.preferType };
}

/** Synchronous: undefined until the saved cache has loaded (hydrateChannel waits for it). */
export function getCachedHydration(channelName: string): Meta | null | undefined {
  void loadCache();
  const { query } = queryForChannel(channelName);
  if (!query) return null;
  const entry = queryCache.get(query);
  if (!entry) return undefined;
  return entry.meta;
}

export async function hydrateChannel(channelName: string): Promise<Meta | null> {
  const { query, preferType } = queryForChannel(channelName);
  if (!query) return null;
  await loadCache();
  const cached = queryCache.get(query);
  if (cached) return cached.meta;
  const existing = inflight.get(query);
  if (existing) return existing;
  const promise = doHydrate(query, preferType).then((full) => {
    const meta = full ? compact(full) : null;
    lruSet(queryCache, query, { meta, at: Date.now() }, MAX_CACHE);
    scheduleSave();
    return meta;
  });
  inflight.set(query, promise);
  void promise.finally(() => inflight.delete(query));
  return promise;
}

async function doHydrate(
  query: string,
  preferType: "movie" | "series" | null,
): Promise<Meta | null> {
  const encoded = encodeURIComponent(query);
  const types: Array<"series" | "movie"> =
    preferType === "series"
      ? ["series", "movie"]
      : preferType === "movie"
        ? ["movie", "series"]
        : ["series", "movie"];
  for (const type of types) {
    try {
      const res = await fetch(`${CINEMETA}/catalog/${type}/top/search=${encoded}.json`);
      if (!res.ok) continue;
      const json = (await res.json()) as { metas?: Meta[] };
      const list = json.metas ?? [];
      const match = pickBestMatch(list, query);
      if (match) {
        const full = await fetchFullMeta(type, match.id);
        return full ?? match;
      }
    } catch {}
  }
  return null;
}

async function fetchFullMeta(
  type: "movie" | "series",
  id: string,
): Promise<Meta | null> {
  try {
    const res = await fetch(`${CINEMETA}/meta/${type}/${id}.json`);
    if (!res.ok) return null;
    const json = (await res.json()) as { meta?: Meta };
    return json.meta ?? null;
  } catch {
    return null;
  }
}

function pickBestMatch(list: Meta[], query: string): Meta | null {
  if (list.length === 0) return null;
  const q = query.toLowerCase().trim();
  if (q.length < 4) return null;
  for (const m of list) {
    if (m.name?.toLowerCase().trim() === q) return m;
  }
  return null;
}

export function isHydratableChannel(channel: { group?: string | null; name: string }): boolean {
  const g = (channel.group ?? "").toUpperCase();
  const n = channel.name.toUpperCase();
  const hay = `${g} ${n}`;
  if (/\bNEWS\b/.test(hay)) return false;
  if (/\bSPORTS?\b/.test(hay)) return false;
  if (/\bTALK\b/.test(hay)) return false;
  if (/\bRADIO\b/.test(hay)) return false;
  if (/\bMUSIC\b/.test(hay)) return false;
  if (/\bEVENTS?\b/.test(hay)) return false;
  if (/\bWEATHER\b/.test(hay)) return false;
  if (/\bDEPORTES?\b/.test(hay)) return false;
  return true;
}
