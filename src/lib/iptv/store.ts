import { androidFetch, isAndroidApp } from "@/lib/android";
import { idbDelete, idbGet, idbSet } from "@/lib/idb-kv";
import { filterChannelsForDisplay } from "./divider-filter";
import { loadFromShape, resumeVodHydration } from "./ingest/load";
import { detectProviderShape } from "./ingest/detect";
import type { IptvChannel, IptvPlaylist, IptvPlaylistSource } from "./types";
import { clearSeriesInfoCache } from "./xtream-vod";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// The last list fetched for each playlist is kept on the device (IndexedDB), so a cold start
// shows Live at once instead of downloading and parsing megabytes first; a copy older than
// CACHE_TTL_MS is shown and refreshed behind it. Without a network the saved list still shows.
const SNAPSHOT_PREFIX = "iptv.playlist.";
const SNAPSHOT_MAX_CHANNELS = 150_000;

type Snapshot = { sig: string; playlist: IptvPlaylist };

/** Ties a saved list to the source as it was: a changed URL or login makes it stale. */
function sourceSig(src: IptvPlaylistSource): string {
  const raw = [src.url, src.kind ?? "", src.xtream?.server ?? "", src.xtream?.username ?? "", src.xtream?.password ?? ""].join("\u0001");
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + raw.length;
}

async function readSnapshot(src: IptvPlaylistSource): Promise<IptvPlaylist | null> {
  const snap = await idbGet<Snapshot>(SNAPSHOT_PREFIX + src.id);
  if (!snap || snap.sig !== sourceSig(src) || !snap.playlist || !Array.isArray(snap.playlist.channels)) return null;
  // The user's own guide URL wins; otherwise keep the one read from the playlist's header
  // when this copy was fetched (the saved channels alone no longer carry that header).
  return { ...snap.playlist, name: src.name, epgUrl: src.epgUrl || snap.playlist.epgUrl || null };
}

function writeSnapshot(src: IptvPlaylistSource, playlist: IptvPlaylist): void {
  if (playlist.channels.length === 0 || playlist.channels.length > SNAPSHOT_MAX_CHANNELS) return;
  const snap: Snapshot = { sig: sourceSig(src), playlist };
  void idbSet(SNAPSHOT_PREFIX + src.id, snap);
}

const cache = new Map<string, IptvPlaylist>();
const inflight = new Map<string, Promise<IptvPlaylist>>();
const listeners = new Set<() => void>();
const vodHydrated = new Set<string>();

let notifyScheduled = false;
function notify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    listeners.forEach((l) => l());
  });
}

export function subscribePlaylists(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getCachedPlaylist(id: string): IptvPlaylist | null {
  return cache.get(id) ?? null;
}

export function clearPlaylistCache(id?: string) {
  if (id) {
    cache.delete(id);
    vodHydrated.delete(id);
    inflight.delete(id);
    clearSeriesInfoCache(id);
    void idbDelete(SNAPSHOT_PREFIX + id);
  } else {
    cache.clear();
    vodHydrated.clear();
    inflight.clear();
    clearSeriesInfoCache();
  }
  notify();
}

export async function loadPlaylist(
  src: IptvPlaylistSource,
  opts?: { force?: boolean },
): Promise<IptvPlaylist> {
  const existing = cache.get(src.id);
  if (!opts?.force && existing) {
    if (Date.now() - existing.fetchedAt < CACHE_TTL_MS) return existing;
    // An old copy is on screen (or saved from an earlier start): keep showing it and fetch the
    // current list behind it. A failure (offline, provider down) leaves the copy in place
    // instead of replacing it with an error.
    if (!inflight.has(src.id)) void loadPlaylist(src, { force: true }).catch(() => {});
    return existing;
  }
  const pending = inflight.get(src.id);
  if (pending && !opts?.force) return pending;
  let fromSnapshot = false;
  const promise = (async () => {
    if (!opts?.force) {
      const saved = await readSnapshot(src);
      if (saved) {
        fromSnapshot = true;
        return saved;
      }
    }
    // A fresh list: an Xtream source's VOD and series are fetched again for it.
    vodHydrated.delete(src.id);
    return loadFromShape(src, detectProviderShape(src));
  })();
  inflight.set(src.id, promise);
  let result: IptvPlaylist;
  try {
    result = await promise;
    // Still the load for this playlist (not removed or edited meanwhile): use it, and save a
    // fresh list on the device.
    if (inflight.get(src.id) === promise) {
      cache.set(src.id, result);
      notify();
      if (!fromSnapshot) writeSnapshot(src, result);
    }
  } finally {
    if (inflight.get(src.id) === promise) inflight.delete(src.id);
  }
  if (fromSnapshot && cache.get(src.id) === result) {
    if (Date.now() - result.fetchedAt >= CACHE_TTL_MS) {
      // Old copy: fetch the current list behind it (it replaces this one when it arrives, VOD
      // included). A failure (offline) keeps the saved one on screen.
      void loadPlaylist(src, { force: true }).catch(() => {});
    } else {
      // Recent copy: an Xtream source's VOD and series are still fetched, as a network load does.
      resumeVodHydration(src, result);
    }
  }
  return result;
}

export function markVodHydrated(id: string): boolean {
  if (vodHydrated.has(id)) return false;
  vodHydrated.add(id);
  return true;
}

export function unmarkVodHydrated(id: string): void {
  vodHydrated.delete(id);
}

export function commitHydratedPlaylist(src: IptvPlaylistSource, channels: IptvChannel[]): void {
  if (!cache.has(src.id)) return;
  cache.set(src.id, shapePlaylist(src, channels));
  notify();
}

const CONNECT_TIMEOUT_S = 30;
const PARSE_LIMIT_BYTES = 80 * 1024 * 1024;

export async function fetchM3uText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await iptvFetch(url);
  } catch (e) {
    throw new Error(networkErrorMessage(e));
  }
  if (!res.ok) {
    throw new Error(httpErrorMessage(res.status, res.statusText));
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (declared > PARSE_LIMIT_BYTES) {
    throw new Error(`Playlist is too large (${(declared / 1024 / 1024).toFixed(1)} MB). 80 MB limit.`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new Error(`Failed reading playlist body: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!text) {
    throw new Error("Playlist server returned an empty body");
  }
  if (text.length > PARSE_LIMIT_BYTES) {
    throw new Error(`Playlist is too large (${(text.length / 1024 / 1024).toFixed(1)} MB). 80 MB limit.`);
  }
  return text;
}

async function iptvFetch(url: string): Promise<Response> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    try {
      return await tauriFetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
          Accept: "audio/x-mpegurl, application/x-mpegURL, application/octet-stream, */*",
        },
        connectTimeout: CONNECT_TIMEOUT_S * 1000,
        maxRedirections: 5,
      } as unknown as RequestInit);
    } catch (e) {
      if (!/scope|not allowed/i.test(String(e))) throw e;
      const { safeFetch } = await import("@/lib/safe-fetch");
      return safeFetch(url, {
        headers: {
          "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
          Accept: "audio/x-mpegurl, application/x-mpegURL, application/octet-stream, */*",
        },
      });
    }
  }
  // Android app: IPTV panels don't send CORS headers; the shell fetches them (as VLC, which
  // some providers insist on).
  if (isAndroidApp()) {
    return androidFetch(url, {
      headers: { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20", Accept: "audio/x-mpegurl, application/x-mpegURL, application/octet-stream, */*" },
      timeoutMs: 60_000,
    });
  }
  return fetch(url, { cache: "no-store" });
}

function httpErrorMessage(status: number, statusText: string): string {
  if (status === 401) {
    return "HTTP 401: bad username or password. Check the URL credentials with your provider.";
  }
  if (status === 403) {
    return "HTTP 403: your IP or device is blocked from this playlist. Some providers geo-restrict or device-limit accounts.";
  }
  if (status === 404) {
    return "HTTP 404: playlist URL not found on this server. Check the URL for typos.";
  }
  if (status === 429) {
    return "HTTP 429: provider is rate-limiting your account. Wait a minute and try again.";
  }
  if (status === 503) {
    return "HTTP 503: provider is refusing service right now. Most common cause: account is at its max-connections limit (other devices/players still logged in). Close other sessions, or contact your provider if the credentials are valid.";
  }
  return `HTTP ${status} ${statusText}`;
}

function networkErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const lower = raw.toLowerCase();
  if (lower.includes("cancel") || lower.includes("abort")) {
    return `Server did not respond (gave up after ${CONNECT_TIMEOUT_S}s). The provider may be rate-limiting your IP or down.`;
  }
  if (lower.includes("dns") || lower.includes("resolve")) {
    return `Could not resolve playlist hostname. Check the URL for typos.`;
  }
  if (lower.includes("connection refused") || lower.includes("refused")) {
    return `Playlist server refused the connection.`;
  }
  if (lower.includes("reset")) {
    return `Playlist server reset the connection. Some providers reject generic clients; try with their official app to confirm credentials work.`;
  }
  return `Network error: ${raw}`;
}

export function shapePlaylist(src: IptvPlaylistSource, channels: IptvChannel[]): IptvPlaylist {
  const cleaned = filterChannelsForDisplay(channels);
  return {
    id: src.id,
    name: src.name,
    url: src.url,
    epgUrl: src.epgUrl ?? null,
    channels: cleaned,
    fetchedAt: Date.now(),
    groups: uniqueGroups(cleaned),
  };
}

function uniqueGroups(channels: { group: string | null }[]): string[] {
  const set = new Set<string>();
  for (const c of channels) {
    if (c.group) set.add(c.group);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
