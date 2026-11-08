import type { SimklSession } from "./types";

const STORAGE_KEY = "harbor.simkl.session.v1";

const subscribers = new Set<() => void>();
let cached: SimklSession | null = null;
let loaded = false;

function read(): SimklSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SimklSession;
    if (typeof parsed?.accessToken !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(session: SimklSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  cached = read();
}

export function getSession(): SimklSession | null {
  ensureLoaded();
  return cached;
}

export function setSession(session: SimklSession | null): void {
  ensureLoaded();
  cached = session;
  write(session);
  for (const fn of subscribers) fn();
}

export function subscribeSession(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function isAuthenticated(): boolean {
  return !!getSession();
}
