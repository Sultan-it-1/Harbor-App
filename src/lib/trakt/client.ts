import {
  TRAKT_API_BASE,
  TRAKT_API_VERSION,
  TRAKT_CLIENT_ID,
  TRAKT_CLIENT_SECRET,
} from "./config";
import { androidFetch, isAndroidApp } from "@/lib/android";
import { getSession, setSession } from "./session";
import type { TraktSession } from "./types";

export type TraktRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  authed?: boolean;
};

export class TraktApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Trakt HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

function baseHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": TRAKT_API_VERSION,
    "trakt-api-key": TRAKT_CLIENT_ID,
  };
}

async function refreshAccessToken(): Promise<TraktSession | null> {
  const current = getSession();
  if (!current) return null;
  const res = await fetch(`${TRAKT_API_BASE}/oauth/token`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({
      refresh_token: current.refreshToken,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // Only a refused refresh token ends the session (400/401, "invalid_grant"). A 5xx, a rate
    // limit (429) or a proxy page is temporary: keep the session and try again on the next call,
    // instead of silently signing the user out.
    let refused = res.status === 401;
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      refused = !body || /invalid_grant|invalid_request|unauthorized_client/i.test(body);
    }
    if (refused) setSession(null);
    return null;
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    created_at: number;
    expires_in: number;
  };
  const next: TraktSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    createdAt: data.created_at,
    expiresIn: data.expires_in,
    username: current.username,
  };
  setSession(next);
  return next;
}

let inflightRefresh: Promise<TraktSession | null> | null = null;
function ensureRefreshed(): Promise<TraktSession | null> {
  if (!inflightRefresh) {
    inflightRefresh = refreshAccessToken().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

async function doFetch(path: string, opts: TraktRequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...(baseHeaders() as Record<string, string>) };
  const useAuth = opts.authed !== false;
  if (useAuth) {
    const session = getSession();
    if (session) headers["Authorization"] = `Bearer ${session.accessToken}`;
  }
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  };
  const url = `${TRAKT_API_BASE}${path}`;
  // The Android app: a read the WebView can't get through (no answer, a blocked request) is asked
  // by the shell instead. Writes aren't: one that did reach Trakt would be sent twice.
  if (!isAndroidApp() || init.method !== "GET") return fetch(url, init);
  try {
    return await fetch(url, init);
  } catch {
    return androidFetch(url, { ...init, timeoutMs: 20000 });
  }
}

export async function traktRequest<T>(
  path: string,
  opts: TraktRequestOptions = {},
): Promise<T> {
  let res = await doFetch(path, opts);

  if (res.status === 401 && opts.authed !== false) {
    const refreshed = await ensureRefreshed();
    if (refreshed) res = await doFetch(path, opts);
  }

  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? "1");
    const waitMs = Math.min(Math.max(retry, 1), 30) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await doFetch(path, opts);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TraktApiError(res.status, body);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}
