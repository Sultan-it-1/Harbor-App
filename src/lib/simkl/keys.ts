import { useSyncExternalStore } from "react";
import { SIMKL_CLIENT_ID } from "./config";

/**
 * Which Simkl app Harbor signs in through: Harbor's built-in one, or an app the user registered
 * on Simkl themselves. The PIN sign-in only needs the Client ID. Kept on this device only.
 */
export type SimklKeyMode = "builtin" | "custom";

export type SimklKeyConfig = {
  mode: SimklKeyMode;
  clientId: string;
};

const STORAGE_KEY = "harbor.simkl.keys.v1";
const DEFAULT_CONFIG: SimklKeyConfig = { mode: "builtin", clientId: "" };

const subscribers = new Set<() => void>();
let cached: SimklKeyConfig | null = null;

function read(): SimklKeyConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const p = JSON.parse(raw) as Partial<SimklKeyConfig> | null;
    return {
      mode: p?.mode === "custom" ? "custom" : "builtin",
      clientId: typeof p?.clientId === "string" ? p.clientId.trim() : "",
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getSimklKeyConfig(): SimklKeyConfig {
  if (!cached) cached = read();
  return cached;
}

export function setSimklKeyConfig(next: SimklKeyConfig): void {
  cached = { mode: next.mode, clientId: next.clientId.trim() };
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

export function useSimklKeyConfig(): SimklKeyConfig {
  return useSyncExternalStore(subscribe, getSimklKeyConfig, getSimklKeyConfig);
}

/** The Client ID every Simkl call uses. A token only works with the app it was issued to, so the
 *  settings screen only lets the choice change while Simkl is disconnected. */
export function getSimklClientId(): { clientId: string; custom: boolean } {
  const c = getSimklKeyConfig();
  if (c.mode === "custom" && c.clientId) return { clientId: c.clientId, custom: true };
  return { clientId: SIMKL_CLIENT_ID, custom: false };
}
