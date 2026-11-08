import { SIMKL_API_BASE } from "./config";
import { getSimklClientId } from "./keys";
import { sessionFromOAuth2 } from "./device-auth";
import { getSession, setSession } from "./session";

export type SimklRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  authed?: boolean;
};

export class SimklApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Simkl HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

function baseHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "simkl-api-key": getSimklClientId().clientId,
  };
}

async function doFetch(path: string, opts: SimklRequestOptions): Promise<Response> {
  const headers = baseHeaders();
  if (opts.authed !== false) {
    const session = getSession();
    if (session) headers["Authorization"] = `Bearer ${session.accessToken}`;
  }
  return fetch(`${SIMKL_API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

let refreshing: Promise<boolean> | null = null;

/**
 * A new token for an OAuth 2.0 app's session (their tokens expire), kept in the session; false
 * when there's nothing to renew with or Simkl refuses it. One renewal at a time.
 */
function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = getSession();
    if (!current?.refreshToken) return false;
    try {
      const res = await fetch(`${SIMKL_API_BASE}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: getSimklClientId().clientId,
        }),
      });
      if (!res.ok) return false;
      const next = sessionFromOAuth2(await res.json());
      if (!next) return false;
      setSession({ ...next, username: current.username, refreshToken: next.refreshToken ?? current.refreshToken });
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function simklRequest<T>(path: string, opts: SimklRequestOptions = {}): Promise<T> {
  // An OAuth 2.0 session's token about to run out is renewed first.
  const s = getSession();
  if (opts.authed !== false && s?.refreshToken && s.expiresAt && Date.now() > s.expiresAt - 60_000) {
    await refreshSession();
  }
  let res = await doFetch(path, opts);

  for (let attempt = 0; res.status === 429 && attempt < 5; attempt += 1) {
    await new Promise((r) => setTimeout(r, Math.min(16, 2 ** attempt) * 1000));
    res = await doFetch(path, opts);
  }

  if (res.status === 401 && opts.authed !== false && getSession()?.refreshToken && (await refreshSession())) {
    res = await doFetch(path, opts);
  }

  if (res.status === 401 && opts.authed !== false) {
    setSession(null);
    throw new SimklApiError(401, "unauthorized");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SimklApiError(res.status, body);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}
