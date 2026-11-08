import { SIMKL_API_BASE } from "./config";
import { getSimklClientId } from "./keys";
import { setSession } from "./session";
import type { SimklPin, SimklSession } from "./types";

/** Shown (translated) when Simkl refuses the user's own Client ID. */
export const CUSTOM_KEYS_REFUSED =
  "Simkl didn't accept your Client ID. Check it in Settings → Simkl, or switch back to Harbor's keys.";

/** A token answer from Simkl's OAuth 2.0 endpoints, as a session (no user name yet). */
export function sessionFromOAuth2(data: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}): SimklSession | null {
  if (!data.access_token) return null;
  return {
    accessToken: data.access_token,
    username: null,
    refreshToken: data.refresh_token || undefined,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * Sign-in for an OAuth 2.0 app (every Simkl app made since 2026 is one): null when the app is an
 * older one, which only signs in with the PIN below.
 */
async function requestDeviceCode(clientId: string): Promise<SimklPin | null> {
  const res = await fetch(`${SIMKL_API_BASE}/oauth2/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  // "This client_id is not enabled for OAuth 2.0" (an older app), or no such app: the PIN
  // sign-in below answers for both.
  if (res.status === 400 || res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Simkl device request failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  };
  return {
    userCode: data.user_code,
    verificationUrl: data.verification_uri ?? "https://simkl.com/pin",
    deepLinkUrl: data.verification_uri_complete ?? `https://simkl.com/pin?user_code=${encodeURIComponent(data.user_code)}`,
    expiresIn: data.expires_in,
    pollIntervalSec: data.interval ?? 5,
    deviceCode: data.device_code,
  };
}

export async function requestPin(): Promise<SimklPin> {
  const keys = getSimklClientId();
  // The user's own app: a new one signs in through OAuth 2.0, an older one with the PIN.
  // Harbor's keys are an older app.
  if (keys.custom) {
    const pin = await requestDeviceCode(keys.clientId);
    if (pin) return pin;
  }
  const res = await fetch(
    `${SIMKL_API_BASE}/oauth/pin?client_id=${encodeURIComponent(keys.clientId)}`,
  );
  if (!res.ok) {
    if (keys.custom && res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new Error(CUSTOM_KEYS_REFUSED);
    }
    throw new Error(`Simkl pin request failed: HTTP ${res.status}`);
  }
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
      `${SIMKL_API_BASE}/oauth/pin/${userCode}?client_id=${encodeURIComponent(getSimklClientId().clientId)}`,
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

/** One ask for an OAuth 2.0 app's token: the session, "wait", "slower", or "over" (denied/expired). */
async function pollOnceOAuth2(deviceCode: string): Promise<SimklSession | "wait" | "slower" | "over"> {
  try {
    const res = await fetch(`${SIMKL_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: getSimklClientId().clientId,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (res.ok) return sessionFromOAuth2(data) ?? "wait";
    if (data.error === "slow_down") return "slower";
    if (data.error === "expired_token" || data.error === "access_denied") return "over";
    return "wait";
  } catch {
    return "wait";
  }
}

export function pollForToken(pin: SimklPin, onUpdate: (result: PollResult) => void): PollHandle {
  let cancelled = false;
  const startedAt = Date.now();
  let intervalSec = pin.pollIntervalSec;
  (async () => {
    while (!cancelled) {
      if ((Date.now() - startedAt) / 1000 >= pin.expiresIn) {
        if (!cancelled) onUpdate({ kind: "expired" });
        return;
      }
      let session: SimklSession | null = null;
      if (pin.deviceCode) {
        const r = await pollOnceOAuth2(pin.deviceCode);
        if (cancelled) return;
        if (r === "over") {
          onUpdate({ kind: "expired" });
          return;
        }
        if (r === "slower") intervalSec += 5;
        else if (r !== "wait") session = r;
      } else {
        session = await pollOnce(pin.userCode);
      }
      if (cancelled) return;
      if (session) {
        onUpdate({ kind: "authorized", session });
        return;
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
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
        "simkl-api-key": getSimklClientId().clientId,
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
