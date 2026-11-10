// Bridge to the native Android shell (android/ in this repo). The shell injects
// `window.HarborAndroid` before the page loads; everywhere else this module is inert.

type HarborAndroidApi = {
  version(): string;
  /** The build number (CI run), shells from the native-Home release on. */
  build?(): string;
  fetch(id: string, requestJson: string): void;
  /** Stops a request that is queued or running in the shell (frees its thread). */
  fetchCancel?(id: string): void;
  play(sourceJson: string): void;
  command(json: string): void;
  stop(): void;
  openExternal(url: string): void;
  // Downloads (android/…/Downloads.kt). Absent on shells older than the downloads release.
  dlStart?(json: string): string;
  dlStatus?(): string;
  dlDelete?(id: string): boolean;
  dlPause?(id: string): boolean;
  /** Resume a paused download, or retry a failed one from where it got to. */
  dlResume?(id: string): boolean;
  dlAddSubs?(id: string, json: string): boolean;
  dlFiles?(id: string): string;
  dlStorage?(): string;
  /** A fresh link for an expired download (keeps what was downloaded). */
  dlRelink?(id: string, url: string, headersJson: string): boolean;
  /** Downloads only on Wi-Fi (default on) or also on mobile data. */
  dlSetWifiOnly?(on: boolean): void;
  dlWifiOnly?(): boolean;
  /** Background work in the page (season queue, subtitle searches): keep the app running. */
  dlKeepAlive?(on: boolean): void;
  /** Whether Harbor may run in the background without battery limits, and the system prompt for it. */
  bgAllowed?(): boolean;
  bgRequest?(): void;
  /** A stremio:// link that opened (or was sent to) the app, once; "" when there is none. */
  takeLink?(): string;
  /** Keep screenshots and the Recents preview out of a sensitive screen (PIN, sign-in). */
  setSecure?(on: boolean): void;
  /** The app's language ("en" / "ar"), for the shell's own texts: the player, notifications. */
  setLanguage?(lang: string): void;
  /** Ask where to save a file (system "save as" screen). Answer: window.__harborFileSaved(id, "1"|"0"). */
  saveFile?(id: string, name: string, mime: string, base64: string): boolean;
  /** Native screens (android/…/NativeScreens.kt): a page's model, and which page's screen is up
   *  ("" = none). See src/views/native/native-screens.ts. */
  homeSet?(json: string): void;
  screenShow?(page: string, bottomCss: number, cssWidth: number): void;
  /** Saved images (android/…/ImageStore.kt): {"used","limit","free"} in bytes. The limit follows
   *  the phone's free space. */
  imageCache?(): string;
  /** Empties them (and the WebView's own cache); answers like imageCache. */
  imageCacheClear?(): string;
};

export type NativePlayerEvent =
  | {
      type: "state";
      positionMs: number;
      durationMs: number;
      bufferedMs: number;
      playing: boolean;
      playWhenReady: boolean;
      buffering: boolean;
      ended: boolean;
      ready: boolean;
      rate: number;
      width: number;
      height: number;
    }
  | { type: "ended" }
  | { type: "error"; code: string; message: string; fatal?: boolean }
  | { type: "closed"; positionMs: number; durationMs: number }
  | { type: "requestStreams" }
  | { type: "pickStream"; key: string }
  | { type: "next" }
  | { type: "subSearch" }
  /** The viewer's own pick in the native subtitle panel ([lang]: the track's language code). */
  | { type: "subsChoice"; off: boolean; lang?: string };

type NativeFetchResult =
  | { ok: true; status: number; url: string; headers: Record<string, string>; body: string }
  | { ok: false; error: string };

declare global {
  interface Window {
    HarborAndroid?: HarborAndroidApi;
    __harborNativeFetchDone?: (id: string, json: string) => void;
    __harborNativeEvent?: (json: string) => void;
    __harborAndroidBack?: () => boolean;
    /** Called by the shell when a link arrives while the page is running (see takeLink). */
    __harborDeepLinkCheck?: () => void;
    __harborFileSaved?: (id: string, ok: string) => void;
    /** Taps on the native screens (see src/views/native/native-screens.ts). */
    __harborNativeHome?: (json: string) => void;
  }
}

export const NATIVE_PLAYER_CLOSED_EVENT = "harbor:native-player-closed";

export function androidApi(): HarborAndroidApi | null {
  if (typeof window === "undefined") return null;
  return window.HarborAndroid ?? null;
}

export function isAndroidApp(): boolean {
  return androidApi() != null;
}

// ---- native fetch -------------------------------------------------------------------

const pendingFetches = new Map<string, { resolve: (r: Response) => void; reject: (e: unknown) => void; host: string }>();
let fetchSeq = 0;
// Ids are unique per page load: after a reload the counter restarts, and a late answer to a
// request from the old page must not resolve a new request that happens to reuse its id.
const fetchPrefix = Math.random().toString(36).slice(2, 8);

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- "is the network really there?" ---------------------------------------------------
// navigator.onLine stays true on a Wi-Fi without internet (captive portal, dead router). Several
// native requests failing in a row, with none succeeding, is the better signal on the phone.
const NET_DOWN_AFTER = 3;
let netFailuresInARow = 0;
// A dead addon host or two failing over and over is not "offline": failures must come from at
// least two different hosts.
const failingHosts = new Set<string>();
const netListeners = new Set<() => void>();
let netProbe: number | null = null;
function setNetFailures(n: number, host?: string) {
  const wasDown = nativeNetworkLooksDown();
  netFailuresInARow = n;
  if (n === 0) failingHosts.clear();
  else if (host) failingHosts.add(host);
  const down = nativeNetworkLooksDown();
  if (wasDown === down) return;
  netListeners.forEach((l) => l());
  // While it looks down, check now and then so the notice goes away once the network is back
  // even if nothing else on the page makes a request.
  if (down && netProbe == null) {
    netProbe = window.setInterval(() => {
      void androidFetch("https://v3-cinemeta.strem.io/manifest.json", { method: "GET", timeoutMs: 8000 }).catch(() => {});
    }, 15000);
  } else if (!down && netProbe != null) {
    window.clearInterval(netProbe);
    netProbe = null;
  }
}
/** True when the last few native requests all failed at the network level. */
export function nativeNetworkLooksDown(): boolean {
  return netFailuresInARow >= NET_DOWN_AFTER && failingHosts.size >= 2;
}
export function subscribeNativeNetwork(cb: () => void): () => void {
  netListeners.add(cb);
  return () => netListeners.delete(cb);
}

if (typeof window !== "undefined") {
  window.__harborNativeFetchDone = (id, json) => {
    const p = pendingFetches.get(id);
    if (!p) return;
    pendingFetches.delete(id);
    let r: NativeFetchResult;
    try {
      r = JSON.parse(json) as NativeFetchResult;
    } catch (e) {
      p.reject(e);
      return;
    }
    if (!r.ok) {
      if (!/cancel/i.test(r.error)) setNetFailures(netFailuresInARow + 1, p.host);
      p.reject(new TypeError(`Network request failed: ${r.error}`));
      return;
    }
    setNetFailures(0);
    const nullBody = r.status === 204 || r.status === 205 || r.status === 304;
    const resp = new Response(nullBody ? null : base64ToBytes(r.body), { status: r.status, headers: r.headers });
    try {
      Object.defineProperty(resp, "url", { value: r.url });
    } catch {
      /* read-only on some engines */
    }
    p.resolve(resp);
  };
}

/** Text/JSON request bodies only (same as the desktop harbor_fetch path). */
export function canNativeFetch(init?: RequestInit): boolean {
  const b = init?.body;
  return b == null || typeof b === "string" || b instanceof URLSearchParams;
}

export function androidFetch(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const api = androidApi();
  if (!api) return fetch(url, init);
  const headers: Record<string, string> = {};
  if (init?.headers) new Headers(init.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
  const body = init?.body == null ? null : String(init.body);
  if (init?.body instanceof URLSearchParams && !headers["content-type"]) {
    headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }
  const id = `f${fetchPrefix}-${++fetchSeq}`;
  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      /* not a URL: the native side refuses it anyway */
    }
    pendingFetches.set(id, { resolve, reject, host });
    signal?.addEventListener("abort", () => {
      if (pendingFetches.delete(id)) {
        reject(new DOMException("Aborted", "AbortError"));
        // Don't leave the request holding one of the shell's few network threads.
        try {
          api.fetchCancel?.(id);
        } catch {
          /* older shell */
        }
      }
    });
    api.fetch(id, JSON.stringify({ url, method: init?.method ?? "GET", headers, body, timeoutMs: init?.timeoutMs ?? 30000 }));
  });
}

// ---- saving files --------------------------------------------------------------------

const pendingSaves = new Map<string, (ok: boolean) => void>();
let saveSeq = 0;

if (typeof window !== "undefined") {
  window.__harborFileSaved = (id, ok) => {
    const done = pendingSaves.get(id);
    pendingSaves.delete(id);
    done?.(ok === "1");
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** The Android app can't save `<a download>` blobs: this asks where to save the file and writes
 *  it. Resolves true only once the file is really written (false if the user backs out). */
export function androidSaveFile(name: string, mime: string, data: Uint8Array | string): Promise<boolean> {
  const api = androidApi();
  if (!api?.saveFile) return Promise.resolve(false);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const id = `s${++saveSeq}`;
  return new Promise<boolean>((resolve) => {
    pendingSaves.set(id, resolve);
    let started = false;
    try {
      started = api.saveFile!(id, name, mime, bytesToBase64(bytes));
    } catch (e) {
      console.warn("[android] saveFile failed", e);
    }
    if (!started) {
      pendingSaves.delete(id);
      resolve(false);
    }
  });
}

/** Opens a link outside the app (browser, or the app that handles it). */
export function androidOpenExternal(url: string): boolean {
  const api = androidApi();
  if (!api) return false;
  try {
    api.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

// ---- native player events -----------------------------------------------------------

const playerListeners = new Set<(e: NativePlayerEvent) => void>();

if (typeof window !== "undefined") {
  window.__harborNativeEvent = (json) => {
    let e: NativePlayerEvent;
    try {
      e = JSON.parse(json) as NativePlayerEvent;
    } catch {
      return;
    }
    playerListeners.forEach((l) => l(e));
    if (e.type === "closed") window.dispatchEvent(new CustomEvent(NATIVE_PLAYER_CLOSED_EVENT, { detail: e }));
  };
}

export function onNativePlayerEvent(cb: (e: NativePlayerEvent) => void): () => void {
  playerListeners.add(cb);
  return () => playerListeners.delete(cb);
}

// ---- back button interceptors --------------------------------------------------------

type BackEntry = { fn: () => boolean; known: Set<Element> };
const backInterceptors: BackEntry[] = [];
const POPUPS = '[role="dialog"], [aria-modal="true"], [role="menu"]';

/** Pop-ups actually on screen (some stay mounted while hidden). */
export function visiblePopups(): Element[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll(POPUPS)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

/** Lets a screen handle the Android back gesture first (e.g. Settings: section -> list).
 *  The handler returns true when it consumed the back press. */
export function pushAndroidBackHandler(fn: () => boolean): () => void {
  const entry: BackEntry = { fn, known: new Set(visiblePopups()) };
  backInterceptors.push(entry);
  return () => {
    const i = backInterceptors.lastIndexOf(entry);
    if (i >= 0) backInterceptors.splice(i, 1);
  };
}

/**
 * Newest handler first. A pop-up that opened after a handler (a colour picker inside a Settings
 * section, the avatar catalog inside the profile editor) closes before it: that handler and the
 * older ones step aside, and the caller sends the pop-up an Escape.
 */
export function runAndroidBackHandlers(force = false): boolean {
  const open = visiblePopups();
  for (let i = backInterceptors.length - 1; i >= 0; i--) {
    const e = backInterceptors[i];
    if (!force && open.some((el) => !e.known.has(el))) return false;
    if (e.fn()) return true;
  }
  return false;
}
