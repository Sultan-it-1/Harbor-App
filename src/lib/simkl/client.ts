import { SIMKL_API_BASE, SIMKL_CLIENT_ID } from "./config";
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
    "simkl-api-key": SIMKL_CLIENT_ID,
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

export async function simklRequest<T>(path: string, opts: SimklRequestOptions = {}): Promise<T> {
  let res = await doFetch(path, opts);

  for (let attempt = 0; res.status === 429 && attempt < 5; attempt += 1) {
    await new Promise((r) => setTimeout(r, Math.min(16, 2 ** attempt) * 1000));
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
