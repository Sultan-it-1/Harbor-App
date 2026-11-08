import { isAndroidApp } from "@/lib/android";
import { safeFetch } from "@/lib/safe-fetch";
import { safeFetch as fetch } from "@/lib/safe-fetch";
import type { Meta } from "./cinemeta";
import { fetchManifestAt, filterEnabled, loadInstalled } from "./addon-store";

const STREMIO_API = "https://api.strem.io/api";
const MAX_ROWS = 24;

export type CatalogDef = {
  id: string;
  type: string;
  name: string;
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
};

export type AddonResource =
  | string
  | { name: string; types?: string[]; idPrefixes?: string[] };

export type Addon = {
  manifest: {
    id: string;
    name: string;
    version?: string;
    description?: string;
    logo?: string;
    background?: string;
    contactEmail?: string;
    catalogs?: CatalogDef[];
    resources?: AddonResource[];
    types?: string[];
    idPrefixes?: string[];
    behaviorHints?: {
      adult?: boolean;
      p2p?: boolean;
      configurable?: boolean;
      configurationRequired?: boolean;
    };
  };
  transportUrl: string;
};

export type AddonRow = {
  key: string;
  type: string;
  name: string;
  metas: Meta[];
  more?: { base: string; type: string; id: string };
};

export function addonAccepts(addon: Addon, resource: string, type: string, id: string): boolean {
  const m = addon.manifest;
  const resources = m.resources ?? [];
  const specific = resources.filter(
    (r): r is { name: string; types?: string[]; idPrefixes?: string[] } =>
      typeof r === "object" && r.name === resource,
  );
  if (specific.length > 0) {
    return specific.some((r) => {
      const typeOk = Array.isArray(r.types) && r.types.includes(type);
      const idOk =
        !r.idPrefixes || r.idPrefixes.length === 0 || r.idPrefixes.some((p) => id.startsWith(p));
      return typeOk && idOk;
    });
  }
  if (!resources.some((r) => r === resource)) return false;
  if (!m.types || !m.types.includes(type)) return false;
  if (m.idPrefixes && m.idPrefixes.length > 0 && !m.idPrefixes.some((p) => id.startsWith(p))) {
    return false;
  }
  return true;
}

async function call<T>(path: string, body: object): Promise<T | null> {
  try {
    const res = await fetch(`${STREMIO_API}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.result ?? null) as T | null;
  } catch {
    return null;
  }
}

// The account's addon collection is read from a dozen places (Home rows, search, the picker,
// subtitles…): one request every 3 minutes is enough. Writes below drop the cached copy.
const COLLECTION_TTL_MS = 3 * 60_000;
const collectionCache = new Map<string, { at: number; p: Promise<Addon[]> }>();

export function forgetUserAddonsCache(): void {
  collectionCache.clear();
}

export async function userAddons(authKey: string): Promise<Addon[]> {
  const hit = collectionCache.get(authKey);
  if (hit && Date.now() - hit.at < COLLECTION_TTL_MS) return hit.p;
  const p = call<{ addons: Addon[] }>("addonCollectionGet", {
    authKey,
    type: "user",
    update: false,
  }).then((result) => {
    // A failed read isn't cached: the next caller asks again.
    if (!result) collectionCache.delete(authKey);
    return result?.addons ?? [];
  });
  collectionCache.set(authKey, { at: Date.now(), p });
  return p;
}

export async function setUserAddons(authKey: string, addons: Addon[]): Promise<boolean> {
  forgetUserAddonsCache();
  const result = await call<{ success?: boolean }>("addonCollectionSet", {
    authKey,
    type: "user",
    addons: addons.map((a) => {
      const raw = a as Record<string, unknown>;
      return {
        transportUrl: a.transportUrl,
        transportName: typeof raw.transportName === "string" ? raw.transportName : "",
        manifest: a.manifest,
        flags: (raw.flags as { official?: boolean; protected?: boolean } | undefined) ?? {
          official: false,
          protected: false,
        },
      };
    }),
  });
  return result != null;
}

export async function getUserAddonsRaw(authKey: string): Promise<Addon[] | null> {
  const result = await call<{ addons: Addon[] }>("addonCollectionGet", {
    authKey,
    type: "user",
    update: false,
  });
  if (!result || !Array.isArray(result.addons)) return null;
  return result.addons;
}

export async function setUserAddonsRaw(authKey: string, addons: Addon[]): Promise<boolean> {
  if (addons.length === 0) return false;
  forgetUserAddonsCache();
  const result = await call<{ success?: boolean }>("addonCollectionSet", {
    authKey,
    type: "user",
    addons,
  });
  return result != null;
}

const STRIP_WORDS = ["movies", "movie", "series", "shows", "show", "tv shows", "tv"];

export function normalizeName(name: string, type: string): string {
  let n = (name ?? "").toLowerCase();
  for (const w of STRIP_WORDS) {
    n = n.replace(new RegExp(`\\b${w}\\b`, "g"), "");
  }
  n = n.replace(/[^a-z0-9]+/g, " ").trim();
  return `${n}::${type ?? ""}`;
}

async function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<Response | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // safeFetch: addons without CORS headers go through the Android shell.
    return await safeFetch(url, { signal: ac.signal, timeoutMs } as RequestInit);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export type DebridKeySet = {
  rdKey?: string;
  tbKey?: string;
  adKey?: string;
  pmKey?: string;
  dlKey?: string;
};

export function torrentioConfigFor(keys: DebridKeySet): string {
  const parts: string[] = [];
  if (keys.tbKey) parts.push(`torbox=${keys.tbKey.trim()}`);
  if (keys.rdKey) parts.push(`realdebrid=${keys.rdKey.trim()}`);
  if (keys.adKey) parts.push(`alldebrid=${keys.adKey.trim()}`);
  if (keys.pmKey) parts.push(`premiumize=${keys.pmKey.trim()}`);
  if (keys.dlKey) parts.push(`debridlink=${keys.dlKey.trim()}`);
  return parts.join("|");
}

export function torrentioAddonFor(keys: DebridKeySet): Addon {
  const config = torrentioConfigFor(keys);
  const transport = config
    ? `https://torrentio.strem.fun/${config}/manifest.json`
    : "https://torrentio.strem.fun/manifest.json";
  return {
    transportUrl: transport,
    manifest: {
      id: "com.stremio.torrentio.addon",
      name: "Torrentio",
      logo: "https://torrentio.strem.fun/images/logo_v1.png",
      resources: ["stream"],
      types: ["movie", "series"],
      idPrefixes: ["tt", "kitsu"],
    },
  };
}

export function torrentioBareAddon(): Addon {
  return {
    transportUrl: "https://torrentio.strem.fun/manifest.json",
    manifest: {
      id: "com.stremio.torrentio.bare",
      name: "Torrentio",
      logo: "https://torrentio.strem.fun/images/logo_v1.png",
      resources: ["stream"],
      types: ["movie", "series"],
      idPrefixes: ["tt", "kitsu"],
    },
  };
}

export function torboxAddonFor(tbKey: string): Addon | null {
  const k = tbKey.trim();
  if (!k) return null;
  return {
    transportUrl: `https://stremio.torbox.app/${k}/manifest.json`,
    manifest: {
      id: "app.torbox.stremio",
      name: "TorBox",
      logo: "https://torbox.app/android-chrome-512x512.png",
      resources: ["stream"],
      types: ["movie", "series", "anime"],
      idPrefixes: ["tt", "kitsu", "mal", "tmdb", "anidb", "anilist", "anime-planet"],
    },
  };
}

export function withDebridKeys(addons: Addon[], keys: DebridKeySet): Addon[] {
  const config = torrentioConfigFor(keys);
  const torrentioCount = addons.filter(
    (a) => a.manifest.id === "com.stremio.torrentio.addon",
  ).length;
  return addons.map((a) => {
    if (a.manifest.id !== "com.stremio.torrentio.addon") return a;
    if (torrentioCount > 1) return a;
    if (!/torrentio\.strem\.fun\/manifest\.json$/.test(a.transportUrl)) return a;
    return {
      ...a,
      transportUrl: config
        ? `https://torrentio.strem.fun/${config}/manifest.json`
        : "https://torrentio.strem.fun/manifest.json",
    };
  });
}

export async function gatherCatalogAddons(authKey: string | null): Promise<Addon[]> {
  const stremioRaw = authKey ? await userAddons(authKey).catch(() => [] as Addon[]) : [];
  const stremio = filterEnabled(stremioRaw);
  const seen = new Set(stremio.map((a) => a.transportUrl));
  const localOnly = filterEnabled(loadInstalled()).filter((l) => !seen.has(l.transportUrl));
  const localFull = await Promise.all(
    localOnly.map(async (l): Promise<Addon | null> => {
      if (l.manifest?.catalogs?.length) return { manifest: l.manifest, transportUrl: l.transportUrl };
      // A dead addon must not hold up every row on Home: give its manifest 8 s.
      const manifest = await Promise.race([
        fetchManifestAt(l.transportUrl).catch(() => l.manifest ?? null),
        new Promise<Addon["manifest"] | null>((r) => setTimeout(() => r(l.manifest ?? null), 8000)),
      ]);
      return manifest ? { manifest, transportUrl: l.transportUrl } : null;
    }),
  );
  return [...stremio, ...localFull.filter((a): a is Addon => a != null)];
}

const NON_CONTENT_TYPES = new Set(["addon_catalog"]);

/** Runs [jobs] with at most [limit] in flight; results keep the jobs' order. */
async function runLimited<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

function catalogRequestUrl(base: string, cat: CatalogDef): string | null {
  const required = (cat.extra ?? []).filter((e) => e.isRequired);
  if (required.length === 0) return `${base}/catalog/${cat.type}/${cat.id}.json`;
  const parts: string[] = [];
  for (const e of required) {
    if (e.name === "search") return null;
    const opt = e.options?.[0];
    if (!opt) return null;
    parts.push(`${encodeURIComponent(e.name)}=${encodeURIComponent(opt)}`);
  }
  return `${base}/catalog/${cat.type}/${cat.id}/${parts.join("&")}.json`;
}

export async function loadAddonRows(
  authKey: string | null,
  opts: { dedup?: boolean; cap?: number } = {},
): Promise<AddonRow[]> {
  const dedup = opts.dedup ?? true;
  const cap = opts.cap ?? (dedup ? MAX_ROWS : 200);
  const addons = await gatherCatalogAddons(authKey);
  // Big addons list dozens of catalogs each: ask for a bounded number, a few at a time, and
  // start each one's timeout when it really starts (a phone used to fire hundreds at once and
  // time them out while they were still queued).
  // The budget is shared fairly: every addon's first catalogs before anyone's next ones. Taking the
  // first N in install order let two big addons use all of it, so addons further down (and a newly
  // installed one, always last) never got a row.
  const perAddon = addons.map((addon) =>
    (Array.isArray(addon.manifest.catalogs) ? addon.manifest.catalogs : [])
      .filter((c) => c && c.name && c.type && c.id && !NON_CONTENT_TYPES.has(c.type.toLowerCase()))
      .map((cat) => async (): Promise<AddonRow | null> => {
        const base = addon.transportUrl.replace(/\/manifest\.json$/, "");
        const url = catalogRequestUrl(base, cat);
        if (!url) return null;
        const res = await fetchWithTimeout(url);
        if (!res || !res.ok) return null;
        try {
          const json = await res.json();
          const raw: Meta[] = json.metas ?? [];
          if (raw.length === 0) return null;
          const origin = {
            id: addon.manifest.id,
            name: addon.manifest.name,
            logo: addon.manifest.logo,
            base,
          };
          const metas: Meta[] = raw.map((m) => ({ ...m, addonOrigin: origin }));
          return {
            key: `${addon.manifest.id}-${cat.type}-${cat.id}`,
            type: cat.type,
            name: cat.name,
            metas,
            more: { base, type: cat.type, id: cat.id },
          };
        } catch {
          return null;
        }
      }),
  );
  type Job = { addon: number; order: number; run: () => Promise<AddonRow | null> };
  const ordered: Job[][] = [];
  let order = 0;
  for (let a = 0; a < perAddon.length; a++) ordered.push(perAddon[a].map((run) => ({ addon: a, order: order++, run })));
  const picked = fairPick(ordered, Math.max(cap * 2, 48));
  // Phone: the shell's native fetch has 12 threads, so catalogs go 6 at a time and leave room for
  // posters and streams. Desktop and web have no such pool: all at once, as before.
  const results = await runLimited(
    picked.map((j) => j.run),
    isAndroidApp() ? 6 : picked.length,
  );
  const got: Array<Job & { row: AddonRow }> = [];
  results.forEach((row, i) => {
    if (row) got.push({ ...picked[i], row });
  });
  if (!dedup) return fairPick(groupByAddon(got), cap).map((g) => g.row);
  const seen = new Set<string>();
  const deduped: typeof got = [];
  for (const g of got) {
    const key = normalizeName(g.row.name, g.row.type);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(g);
  }
  return fairPick(groupByAddon(deduped), cap).map((g) => g.row);
}

/** Up to [limit] items, round-robin over the groups (each group's first, then each one's second…),
 *  returned in their original order. */
function fairPick<T extends { order: number }>(groups: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let round = 0; out.length < limit; round++) {
    let any = false;
    for (const g of groups) {
      if (round >= g.length) continue;
      any = true;
      out.push(g[round]);
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out.sort((a, b) => a.order - b.order);
}

function groupByAddon<T extends { addon: number }>(items: T[]): T[][] {
  const groups = new Map<number, T[]>();
  for (const it of items) {
    const g = groups.get(it.addon);
    if (g) g.push(it);
    else groups.set(it.addon, [it]);
  }
  return [...groups.values()];
}

export async function fetchAddonMeta(base: string, type: string, id: string): Promise<Meta | null> {
  const res = await fetchWithTimeout(`${base}/meta/${type}/${encodeURIComponent(id)}.json`);
  if (!res || !res.ok) return null;
  try {
    const json = await res.json();
    return (json.meta ?? null) as Meta | null;
  } catch {
    return null;
  }
}

export async function fetchAddonCatalogPage(
  base: string,
  type: string,
  id: string,
  skip: number,
): Promise<Meta[]> {
  const seg = skip > 0 ? `/skip=${skip}` : "";
  const res = await fetchWithTimeout(`${base}/catalog/${type}/${id}${seg}.json`);
  if (!res || !res.ok) return [];
  try {
    const json = await res.json();
    return (json.metas ?? []) as Meta[];
  } catch {
    return [];
  }
}

const TMDB_PROVIDER_ID_PATTERNS: RegExp[] = [
  /^com\.aio\.metadata$/i,
  /tmdb/i,
  /^com\.stremio\.streaming-catalogs$/i,
];

export function hasTmdbProviderAddon(addons: Addon[]): boolean {
  return addons.some((a) => {
    const id = a.manifest?.id ?? "";
    const name = a.manifest?.name ?? "";
    return TMDB_PROVIDER_ID_PATTERNS.some((re) => re.test(id) || re.test(name));
  });
}
