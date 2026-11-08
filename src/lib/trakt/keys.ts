import { useSyncExternalStore } from "react";
import { TRAKT_CLIENT_ID, TRAKT_CLIENT_SECRET } from "./config";

/**
 * Which Trakt app Harbor signs in through: Harbor's built-in one, or an app the user registered
 * on Trakt themselves (so their sign-in keeps working whatever happens to the built-in keys).
 * Kept on this device only, next to the Trakt session, never in the synced settings.
 */
export type TraktKeyMode = "builtin" | "custom";

export type TraktKeyConfig = {
  mode: TraktKeyMode;
  clientId: string;
  /** Trakt apps created since late 2026 may have no secret: then it stays empty and is not sent. */
  clientSecret: string;
};

export type TraktKeys = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  custom: boolean;
};

const STORAGE_KEY = "harbor.trakt.keys.v1";

/** Trakt's development apps only take a localhost redirect. Harbor signs in with the device flow
 *  and never opens it, but the token calls must name a redirect URI the app has. */
export const TRAKT_CUSTOM_REDIRECT_URI = "http://localhost";
const BUILTIN_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const DEFAULT_CONFIG: TraktKeyConfig = { mode: "builtin", clientId: "", clientSecret: "" };

const subscribers = new Set<() => void>();
let cached: TraktKeyConfig | null = null;

function read(): TraktKeyConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const p = JSON.parse(raw) as Partial<TraktKeyConfig> | null;
    return {
      mode: p?.mode === "custom" ? "custom" : "builtin",
      clientId: typeof p?.clientId === "string" ? p.clientId.trim() : "",
      clientSecret: typeof p?.clientSecret === "string" ? p.clientSecret.trim() : "",
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getTraktKeyConfig(): TraktKeyConfig {
  if (!cached) cached = read();
  return cached;
}

export function setTraktKeyConfig(next: TraktKeyConfig): void {
  cached = {
    mode: next.mode,
    clientId: next.clientId.trim(),
    clientSecret: next.clientSecret.trim(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    /* storage full or blocked: the choice still holds until the app restarts */
  }
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function useTraktKeyConfig(): TraktKeyConfig {
  return useSyncExternalStore(subscribe, getTraktKeyConfig, getTraktKeyConfig);
}

/** The keys every Trakt call uses. A token only works with the app it was issued to, so the
 *  settings screen only lets the choice change while Trakt is disconnected. */
export function getTraktKeys(): TraktKeys {
  const c = getTraktKeyConfig();
  if (c.mode === "custom" && c.clientId) {
    return {
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      redirectUri: TRAKT_CUSTOM_REDIRECT_URI,
      custom: true,
    };
  }
  return {
    clientId: TRAKT_CLIENT_ID,
    clientSecret: TRAKT_CLIENT_SECRET,
    redirectUri: BUILTIN_REDIRECT_URI,
    custom: false,
  };
}

/** `client_secret` for a token request, left out when the app has none. */
export function secretField(keys: TraktKeys): { client_secret?: string } {
  return keys.clientSecret ? { client_secret: keys.clientSecret } : {};
}
