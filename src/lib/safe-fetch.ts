import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetchImpl } from "@tauri-apps/plugin-http";
import { TrackerBlockedError, isBlockedUrl, noteBlocked } from "./privacy/blocklist";
import { androidFetch, canNativeFetch, isAndroidApp } from "./android";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Torrentio + TorBox sit behind Cloudflare that blocks datacenter IPs, so on web they
// MUST be fetched directly from the browser's residential IP (they set CORS, so it
// works) — proxying them through the VPS gets 403'd. EVERYTHING ELSE routes through the
// VPS /api-proxy: it's required for addons that send no CORS header at all (OpenSubtitles)
// and for the CORS-less debrid REST APIs, and it's fine for the rest (Cinemeta, Comet).
const DIRECT_HOSTS = new Set([
  "torrentio.strem.fun",
  "stremio.torbox.app",
]);

const PROXY_HOSTS = new Set([
  "v3-cinemeta.strem.io",
  "opensubtitles-v3.strem.io",
  "opensubtitles.strem.io",
  "opensubtitles.stremio.homes",
  "api.torbox.app",
  "api.real-debrid.com",
  "api.alldebrid.com",
  "debrid-link.com",
  "www.premiumize.me",
]);

const PROXY_SUFFIXES = [
  ".elfhosted.com",
  ".strem.fun",
  ".strem.io",
  ".stremio.homes",
  ".baby-beamup.club",
  ".workers.dev",
  ".debridio.com",
  ".code.run",
  ".fly.dev",
  ".onrender.com",
  ".vercel.app",
  ".netlify.app",
  ".railway.app",
  ".deno.dev",
];

// Android app: these answer with proper CORS headers, so the WebView calls them directly
// (no base64 hop through the shell, no limit of the shell's 12 network threads). Everything
// else goes through the shell: IPTV panels, Letterboxd/IMDb, addons and APIs without CORS.
const CORS_OK_HOSTS = new Set([
  "api.themoviedb.org",
  "image.tmdb.org",
  "api.trakt.tv",
  "api.simkl.com",
  "graphql.anilist.co",
  "kitsu.io",
  "kitsu.app",
  "api.jikan.moe",
  "api.mdblist.com",
  "webservice.fanart.tv",
  "torrentio.strem.fun",
  "stremio.torbox.app",
]);

function androidGoesNative(parsed: URL): boolean {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (typeof window !== "undefined" && parsed.host === window.location.host) return false;
  if (needsProxy(parsed)) return true;
  return !CORS_OK_HOSTS.has(parsed.hostname);
}

function needsProxy(parsed: URL): boolean {
  if (DIRECT_HOSTS.has(parsed.hostname)) return false;
  return PROXY_HOSTS.has(parsed.hostname) || PROXY_SUFFIXES.some((s) => parsed.hostname.endsWith(s));
}

function rewriteForWeb(url: string, init?: RequestInit): { url: string; init?: RequestInit } {
  if (isTauri) return { url, init };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, init };
  }
  if (!needsProxy(parsed)) return { url, init };

  const proxyHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const isDev = typeof window !== 'undefined' && window.location.port === '1420';
  const proxied = isDev 
    ? `http://${proxyHost}:1421/api-proxy/${parsed.hostname}${parsed.pathname}${parsed.search}`
    : `/api-proxy/${parsed.hostname}${parsed.pathname}${parsed.search}`;
  if (!init?.headers) return { url: proxied, init };
  const out = new Headers(init.headers as HeadersInit);
  const auth = out.get("authorization");
  if (auth) {
    out.delete("authorization");
    out.set("x-harbor-auth", auth);
  }
  return { url: proxied, init: { ...init, headers: out } };
}

type HarborFetchResponse = {
  status: number;
  ok: boolean;
  body: string;
  contentType: string | null;
};

async function tauriHarborFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers as HeadersInit);
    h.forEach((v, k) => {
      headers[k] = v;
    });
  }
  const body =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
        ? init.body.toString()
        : init?.body
          ? JSON.stringify(init.body)
          : undefined;
  const resp = await invoke<HarborFetchResponse>("harbor_fetch", {
    args: {
      url: input,
      method: init?.method ?? "GET",
      headers,
      body,
      timeoutMs: (init as { timeoutMs?: number } | undefined)?.timeoutMs ?? 30000,
    },
  });
  return new Response(resp.body, {
    status: resp.status,
    headers: resp.contentType ? { "content-type": resp.contentType } : {},
  });
}

function isIdempotent(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

export const safeFetch: typeof fetch = (input, init) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : null;
  if (target && isBlockedUrl(target)) {
    noteBlocked();
    let host = target;
    try {
      host = new URL(target).hostname;
    } catch {}
    return Promise.reject(new TrackerBlockedError(host));
  }
  if (isTauri) {
    if (typeof input === "string") {
      if (isIdempotent(init?.method)) {
        return tauriHarborFetch(input, init).catch(
          () => tauriFetchImpl(input as string, init as RequestInit) as Promise<Response>,
        );
      }
      return tauriHarborFetch(input, init);
    }
    return tauriFetchImpl(input as unknown as string, init as RequestInit) as Promise<Response>;
  }
  if (typeof input === "string") {
    // Android app: no /api-proxy server behind us; the native shell does CORS-free HTTP.
    if (isAndroidApp() && canNativeFetch(init)) {
      try {
        if (androidGoesNative(new URL(input))) return androidFetch(input, init);
      } catch {
        /* not an absolute URL — fall through */
      }
    }
    const r = rewriteForWeb(input, init);
    return fetch(r.url, r.init);
  }
  return fetch(input, init);
};

/**
 * A fetch that gives up after `ms` and stops when `init.signal` aborts. Meant for bursts of
 * requests (search asks dozens of addons at once): a slow or dead server must not hold things up
 * for the usual 30 seconds. On the Android app the shell also drops the request, freeing its thread.
 */
export function timedFetch(input: string, init: RequestInit = {}, ms = 7000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const outer = init.signal ?? null;
  const onAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return safeFetch(input, { ...init, signal: ac.signal, timeoutMs: ms } as RequestInit).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  });
}
