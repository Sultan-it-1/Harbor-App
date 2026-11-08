/**
 * Updates for the Android app: the latest release of the app's repository on GitHub, compared
 * with the installed version. The update itself downloads in the browser and installs from
 * there, as a first install does: an app that installs APKs itself gets flagged by Play Protect.
 */
import { useSyncExternalStore } from "react";
import { androidApi, androidFetch } from "@/lib/android";

/** Where the app's releases are published. */
export const RELEASES_REPO = "Sultan-it-1/Harbor-App";

export type AndroidUpdateState = {
  status: "idle" | "checking" | "uptodate" | "available" | "error";
  /** The installed version ("1.0.7"). */
  current: string;
  /** The latest release's version, once known. */
  latest: string | null;
  /** What the release says is new (its notes, without the download line and the checksum). */
  notes: string | null;
  url: string | null;
  sha256: string | null;
  size: number | null;
  error: string | null;
};

const LAST_CHECK_KEY = "harbor.update.lastCheck";
/** A newer release found by the last look, kept until it's installed (or a look finds none). */
const FOUND_KEY = "harbor.update.found";
/** The app looks for a new version by itself at most this often (a manual check always asks). */
const AUTO_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function installedVersion(): string {
  try {
    return androidApi()?.version() || __APP_VERSION__;
  } catch {
    return __APP_VERSION__;
  }
}

let state: AndroidUpdateState = {
  status: "idle",
  current: typeof window !== "undefined" ? installedVersion() : "",
  latest: null,
  notes: null,
  url: null,
  sha256: null,
  size: null,
  error: null,
};
const listeners = new Set<() => void>();

// A newer version found earlier (the app looks by itself only every few hours): offered again at
// once, until the installed version has caught up with it.
if (typeof window !== "undefined") {
  try {
    const found = JSON.parse(localStorage.getItem(FOUND_KEY) || "null") as Partial<AndroidUpdateState> | null;
    if (found?.latest && found.url && compareVersions(found.latest, state.current) > 0) {
      state = { ...state, status: "available", latest: found.latest, notes: found.notes ?? null, url: found.url, sha256: found.sha256 ?? null, size: found.size ?? null };
    } else if (found) {
      localStorage.removeItem(FOUND_KEY);
    }
  } catch {
    /* no storage */
  }
}

function set(patch: Partial<AndroidUpdateState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

/** Where the update stands now (outside React). */
export function getAndroidUpdateState(): AndroidUpdateState {
  return state;
}

export function useAndroidUpdate(): AndroidUpdateState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => state,
    () => state,
  );
}

/** -1, 0 or 1 as [a] is older than, the same as, or newer than [b] ("1.2.3"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, "").split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

type Release = {
  tag_name?: string;
  body?: string | null;
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string | null }>;
};

/** The release's notes as the card shows them: no download instructions, no checksum line. */
function notesOf(body: string): string | null {
  const lines = body
    .split(/\r?\n/)
    .filter((l) => !/SHA-256:|harbor-android\.apk|install from unknown sources|open it on your phone|^\s*-{3,}\s*$/i.test(l));
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || null;
}

async function latestRelease(): Promise<Release> {
  const url = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
  const init = { headers: { Accept: "application/vnd.github+json" } };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    res = await androidFetch(url, { ...init, timeoutMs: 15000 });
  }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  return (await res.json()) as Release;
}

/**
 * Looks for a newer release. [manual]: asked from the card (always asks); otherwise only when
 * the last look was long enough ago.
 */
export async function checkAndroidUpdate(manual = false): Promise<void> {
  if (!androidApi()) return;
  if (state.status === "checking") return;
  if (!manual) {
    try {
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) || 0);
      if (Date.now() - last < AUTO_CHECK_EVERY_MS) return;
    } catch {
      /* no storage: look anyway */
    }
  }
  set({ status: "checking", error: null, current: installedVersion() });
  try {
    const rel = await latestRelease();
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    const latest = (rel.tag_name ?? "").replace(/^v/i, "");
    const apk = rel.assets?.find((a) => a.name === "harbor-android.apk");
    const body = rel.body ?? "";
    const sha =
      body.match(/SHA-256:\s*`?([0-9a-f]{64})/i)?.[1] ??
      (apk?.digest?.startsWith("sha256:") ? apk.digest.slice(7) : null);
    if (!latest || !apk?.browser_download_url || compareVersions(latest, state.current) <= 0) {
      try {
        localStorage.removeItem(FOUND_KEY);
      } catch {
        /* ignore */
      }
      set({ status: "uptodate", latest: latest || null });
      return;
    }
    const found = { latest, notes: notesOf(body), url: apk.browser_download_url, sha256: sha, size: apk.size ?? null };
    try {
      localStorage.setItem(FOUND_KEY, JSON.stringify(found));
    } catch {
      /* ignore */
    }
    set({ status: "available", ...found });
  } catch (e) {
    set({ status: manual ? "error" : "idle", error: e instanceof Error ? e.message : String(e) });
  }
}

/** The new version's APK, downloaded by the browser (Android then offers to install it). */
export function startAndroidUpdate(): void {
  const api = androidApi();
  if (!api || !state.url) return;
  api.openExternal(state.url);
}
