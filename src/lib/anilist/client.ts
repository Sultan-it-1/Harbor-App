import { androidFetch, isAndroidApp } from "@/lib/android";
import { ANILIST_GRAPHQL_URL } from "./config";

class AnilistApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`AniList HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

type GraphqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

async function doFetch(query: string, variables: Record<string, unknown>): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  };
  if (!isAndroidApp()) return fetch(ANILIST_GRAPHQL_URL, init);
  // The Android app: when the WebView gets no answer or a refusal, the shell asks instead (its
  // own network stack, no CORS). Only read queries come through here.
  try {
    const r = await fetch(ANILIST_GRAPHQL_URL, init);
    if (r.ok || r.status === 429 || r.status === 400 || r.status === 404) return r;
  } catch {
    /* the shell tries */
  }
  return androidFetch(ANILIST_GRAPHQL_URL, init);
}

export async function anilistRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let res = await doFetch(query, variables);

  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? "1");
    const waitMs = Math.min(Math.max(retry, 1), 30) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await doFetch(query, variables);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AnilistApiError(res.status, body);
  }

  const json = (await res.json()) as GraphqlResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new AnilistApiError(200, json.errors.map((e) => e.message).join("; "));
  }
  return json.data as T;
}
