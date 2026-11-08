import { SIMKL_API_BASE, SIMKL_CLIENT_ID } from "./config";
import { setSession } from "./session";
import type { SimklPin, SimklSession } from "./types";

export async function requestPin(): Promise<SimklPin> {
  const res = await fetch(
    `${SIMKL_API_BASE}/oauth/pin?client_id=${encodeURIComponent(SIMKL_CLIENT_ID)}`,
  );
  if (!res.ok) throw new Error(`Simkl pin request failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  };
  return {
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    deepLinkUrl: `https://simkl.com/pin/${data.user_code}`,
    expiresIn: data.expires_in,
    pollIntervalSec: data.interval,
  };
}

export type PollResult =
  | { kind: "authorized"; session: SimklSession }
  | { kind: "expired" };

export type PollHandle = { cancel: () => void };

async function pollOnce(userCode: string): Promise<SimklSession | null> {
  try {
    const res = await fetch(
      `${SIMKL_API_BASE}/oauth/pin/${userCode}?client_id=${encodeURIComponent(SIMKL_CLIENT_ID)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: string; access_token?: string };
    if (data.result === "OK" && data.access_token) {
      return { accessToken: data.access_token, username: null };
    }
    return null;
  } catch {
    return null;
  }
}

export function pollForToken(pin: SimklPin, onUpdate: (result: PollResult) => void): PollHandle {
  let cancelled = false;
  const startedAt = Date.now();
  (async () => {
    while (!cancelled) {
      if ((Date.now() - startedAt) / 1000 >= pin.expiresIn) {
        if (!cancelled) onUpdate({ kind: "expired" });
        return;
      }
      const session = await pollOnce(pin.userCode);
      if (cancelled) return;
      if (session) {
        onUpdate({ kind: "authorized", session });
        return;
      }
      await new Promise((r) => setTimeout(r, pin.pollIntervalSec * 1000));
    }
  })();
  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

export async function fetchUsername(session: SimklSession): Promise<string | null> {
  try {
    const res = await fetch(`${SIMKL_API_BASE}/users/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "simkl-api-key": SIMKL_CLIENT_ID,
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: { name?: string } };
    return data.user?.name ?? null;
  } catch {
    return null;
  }
}

export async function completeAuthorization(session: SimklSession): Promise<SimklSession> {
  const username = await fetchUsername(session).catch(() => null);
  const final: SimklSession = { ...session, username };
  setSession(final);
  return final;
}
