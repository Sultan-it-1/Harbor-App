import { TRAKT_API_BASE } from "./config";
import { getTraktKeys, secretField } from "./keys";
import { setSession } from "./session";
import type { DeviceCode, TraktSession, TraktUserMe } from "./types";

const baseHeaders = (): HeadersInit => ({
  "Content-Type": "application/json",
});

/** Shown (translated) when Trakt refuses the user's own Client ID. */
export const CUSTOM_KEYS_REFUSED =
  "Trakt didn't accept your Client ID. Check it in Settings → Trakt, or switch back to Harbor's keys.";

export async function requestDeviceCode(): Promise<DeviceCode> {
  const keys = getTraktKeys();
  const res = await fetch(`${TRAKT_API_BASE}/oauth/device/code`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ client_id: keys.clientId }),
  });
  if (!res.ok) {
    if (keys.custom && (res.status === 401 || res.status === 403 || res.status === 404)) {
      throw new Error(CUSTOM_KEYS_REFUSED);
    }
    throw new Error(`Trakt device-code request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  };
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    expiresIn: data.expires_in,
    pollIntervalSec: data.interval,
  };
}

export type PollResult =
  | { kind: "authorized"; session: TraktSession }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

async function pollOnce(deviceCode: string): Promise<PollResult> {
  const keys = getTraktKeys();
  const res = await fetch(`${TRAKT_API_BASE}/oauth/device/token`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({
      code: deviceCode,
      client_id: keys.clientId,
      ...secretField(keys),
    }),
  });
  if (res.status === 200) {
    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      created_at: number;
      expires_in: number;
    };
    const session: TraktSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      createdAt: data.created_at,
      expiresIn: data.expires_in,
      username: null,
    };
    return { kind: "authorized", session };
  }
  if (res.status === 400) return { kind: "pending" };
  if (res.status === 429) return { kind: "slow_down" };
  if (res.status === 410) return { kind: "expired" };
  if (res.status === 418) return { kind: "denied" };
  // Trakt hiccups (5xx, or a proxy page) are temporary: keep waiting until the code expires.
  if (res.status >= 500) return { kind: "pending" };
  return { kind: "error", message: `HTTP ${res.status}` };
}

export type PollHandle = {
  cancel: () => void;
};

export function pollForToken(
  device: DeviceCode,
  onUpdate: (result: PollResult) => void,
): PollHandle {
  let cancelled = false;
  let intervalSec = device.pollIntervalSec;
  const startedAt = Date.now();

  (async () => {
    while (!cancelled) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      if (elapsedSec >= device.expiresIn) {
        if (!cancelled) onUpdate({ kind: "expired" });
        return;
      }

      // A network error (phone between Wi-Fi and mobile data, app in the background) is not a
      // failure of the sign-in: keep polling until the code expires, like the Simkl flow.
      const result = await pollOnce(device.deviceCode).catch((e: Error): PollResult => {
        console.warn("[trakt] device-code poll failed, retrying", e?.message);
        return { kind: "pending" };
      });
      if (cancelled) return;

      if (result.kind === "slow_down") {
        intervalSec += 5;
        onUpdate(result);
      } else if (result.kind !== "pending") {
        onUpdate(result);
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

export async function fetchUsername(session: TraktSession): Promise<string | null> {
  const res = await fetch(`${TRAKT_API_BASE}/users/me`, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": getTraktKeys().clientId,
      Authorization: `Bearer ${session.accessToken}`,
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as TraktUserMe;
  return data.username ?? null;
}

export async function completeAuthorization(session: TraktSession): Promise<TraktSession> {
  const username = await fetchUsername(session).catch(() => null);
  const final: TraktSession = { ...session, username };
  setSession(final);
  return final;
}
