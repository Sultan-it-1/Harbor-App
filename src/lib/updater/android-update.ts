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
  /** The last check failed because GitHub is limiting requests from this network. */
  busy: boolean;
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
  busy: false,
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

/** A newer release, as the card offers it. */
type Latest = { latest: string; notes: string | null; url: string; sha256: string | null; size: number | null };

/** The check failed; [busy]: GitHub is limiting requests from this network (403 / 429). */
class CheckFailed extends Error {
  constructor(
    readonly busy: boolean,
    message: string,
  ) {
    super(message);
  }
}

const REPO_URL = `https://github.com/${RELEASES_REPO}`;
const apkUrlOf = (version: string) => `${REPO_URL}/releases/download/v${version}/harbor-android.apk`;
const SHA_RX = /^[0-9a-f]{64}$/i;

function httpFailed(res: Response): CheckFailed {
  return new CheckFailed(res.status === 403 || res.status === 429, `GitHub answered HTTP ${res.status}`);
}

/** The release's notes as the card shows them: no download instructions, no checksum line. */
function notesOf(body: string): string | null {
  const lines = body
    .split(/\r?\n/)
    .filter((l) => !/SHA-256:|harbor-android\.apk|install from unknown sources|open it on your phone|^\s*-{3,}\s*$/i.test(l));
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || null;
}

/**
 * The small latest.json each release carries next to the APK (from 1.0.12 on). It downloads
 * like the APK does, so GitHub's API limit (60 requests an hour for a whole network, which
 * phones on the same mobile network share) doesn't apply.
 */
async function fromManifest(): Promise<Latest> {
  const res = await androidFetch(`${REPO_URL}/releases/latest/download/latest.json`, { timeoutMs: 15000 });
  if (!res.ok) throw httpFailed(res);
  const m = (await res.json()) as { version?: unknown; notes?: unknown; url?: unknown; sha256?: unknown; size?: unknown };
  const latest = typeof m.version === "string" ? m.version.replace(/^v/i, "").trim() : "";
  if (!latest) throw new CheckFailed(false, "latest.json names no version");
  return {
    latest,
    notes: typeof m.notes === "string" ? notesOf(m.notes) : null,
    url: typeof m.url === "string" && m.url.startsWith("https://") ? m.url : apkUrlOf(latest),
    sha256: typeof m.sha256 === "string" && SHA_RX.test(m.sha256) ? m.sha256 : null,
    size: typeof m.size === "number" ? m.size : null,
  };
}

/** GitHub's API: the release's notes and APK. null when the release has no APK. */
async function fromApi(): Promise<Latest | null> {
  const url = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
  const init = { headers: { Accept: "application/vnd.github+json" } };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    res = await androidFetch(url, { ...init, timeoutMs: 15000 });
  }
  if (!res.ok) throw httpFailed(res);
  const rel = (await res.json()) as {
    tag_name?: string;
    body?: string | null;
    assets?: Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string | null }>;
  };
  const latest = (rel.tag_name ?? "").replace(/^v/i, "");
  const apk = rel.assets?.find((a) => a.name === "harbor-android.apk");
  if (!latest || !apk?.browser_download_url) return null;
  const body = rel.body ?? "";
  const sha =
    body.match(/SHA-256:\s*`?([0-9a-f]{64})/i)?.[1] ?? (apk.digest?.startsWith("sha256:") ? apk.digest.slice(7) : null);
  return { latest, notes: notesOf(body), url: apk.browser_download_url, sha256: sha, size: apk.size ?? null };
}

/** Last resort: github.com's "latest release" page leads to the release's tag (no notes). */
async function fromRedirect(): Promise<Latest> {
  const res = await androidFetch(`${REPO_URL}/releases/latest`, { method: "HEAD", timeoutMs: 15000 });
  if (!res.ok) throw httpFailed(res);
  const tag = res.url?.match(/\/releases\/tag\/v?([^/?#]+)/)?.[1];
  if (!tag) throw new CheckFailed(false, "no release found");
  const latest = decodeURIComponent(tag);
  return { latest, notes: null, url: apkUrlOf(latest), sha256: null, size: null };
}

/** The latest release, from the first place that answers. null: it has no APK. */
async function latestRelease(): Promise<Latest | null> {
  let busy = false;
  let last: unknown = null;
  for (const source of [fromManifest, fromApi, fromRedirect]) {
    try {
      return await source();
    } catch (e) {
      if (e instanceof CheckFailed && e.busy) busy = true;
      last = e;
    }
  }
  throw new CheckFailed(busy, last instanceof Error ? last.message : String(last));
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
  set({ status: "checking", error: null, busy: false, current: installedVersion() });
  try {
    const found = await latestRelease();
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    if (!found || compareVersions(found.latest, state.current) <= 0) {
      try {
        localStorage.removeItem(FOUND_KEY);
      } catch {
        /* ignore */
      }
      set({ status: "uptodate", latest: found?.latest ?? null });
      return;
    }
    try {
      localStorage.setItem(FOUND_KEY, JSON.stringify(found));
    } catch {
      /* ignore */
    }
    set({ status: "available", ...found });
  } catch (e) {
    set({
      status: manual ? "error" : "idle",
      error: e instanceof Error ? e.message : String(e),
      busy: e instanceof CheckFailed && e.busy,
    });
  }
}

/** The new version's APK, downloaded by the browser (Android then offers to install it). */
export function startAndroidUpdate(): void {
  const api = androidApi();
  if (!api || !state.url) return;
  api.openExternal(state.url);
}
