import { androidApi } from "@/lib/android";

const EVENT = "harbor:deeplink-install";
const OPEN_EVENT = "harbor:deeplink-open";

type DeepLinkDetail = { rawUrl: string };
type DeepLinkOpen = { type: string; id: string; videoId?: string };
type DeepLinkOpenDetail = { open: DeepLinkOpen };

let pendingUrl: string | null = null;

export function emitDeepLinkInstall(rawUrl: string): void {
  pendingUrl = rawUrl;
  window.dispatchEvent(new CustomEvent<DeepLinkDetail>(EVENT, { detail: { rawUrl } }));
}

export function consumePendingDeepLink(): string | null {
  const url = pendingUrl;
  pendingUrl = null;
  return url;
}

export function peekPendingDeepLink(): string | null {
  return pendingUrl;
}

export function clearPendingDeepLink(): void {
  pendingUrl = null;
}

export function onDeepLinkInstall(handler: (rawUrl: string) => void): () => void {
  const listener = (e: Event) => {
    const ev = e as CustomEvent<DeepLinkDetail>;
    if (ev.detail?.rawUrl) handler(ev.detail.rawUrl);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

export function emitDeepLinkOpen(open: DeepLinkOpen): void {
  window.dispatchEvent(new CustomEvent<DeepLinkOpenDetail>(OPEN_EVENT, { detail: { open } }));
}

export function onDeepLinkOpen(handler: (open: DeepLinkOpen) => void): () => void {
  const listener = (e: Event) => {
    const ev = e as CustomEvent<DeepLinkOpenDetail>;
    if (ev.detail?.open) handler(ev.detail.open);
  };
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

function parseDetailPath(path: string): DeepLinkOpen | null {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts[0] !== "detail" || parts.length < 3) return null;
  const type = decodeURIComponent(parts[1]);
  const id = decodeURIComponent(parts[2]);
  if (!type || !id) return null;
  const videoId = parts[3] ? decodeURIComponent(parts[3]) : undefined;
  return { type, id, videoId };
}

export function parseStremioOpen(url: string): DeepLinkOpen | null {
  if (url.startsWith("stremio://")) return parseDetailPath(url.slice("stremio://".length));
  const hash = url.indexOf("#");
  if (hash !== -1 && url.includes("stremio.com")) {
    let frag = url.slice(hash + 1);
    if (frag.startsWith("/")) frag = frag.slice(1);
    return parseDetailPath(frag);
  }
  return null;
}

function shouldForward(url: string): boolean {
  if (url.startsWith("harbor://")) return true;
  if (url.startsWith("stremio://")) {
    if (window.__harborInstallerOpen) return true;
    return !!window.__harborStremioDeeplink;
  }
  return url.includes("manifest.json");
}

/** Same routing the desktop uses; `trusted` skips the "is anyone waiting for it" check. */
function routeDeepLink(u: string, trusted = false): void {
  const open = parseStremioOpen(u);
  if (open) {
    emitDeepLinkOpen(open);
    return;
  }
  if (trusted || shouldForward(u)) emitDeepLinkInstall(u);
}

/**
 * Android app: the shell is registered for stremio:// links (an addon's "Install" button, in the
 * in-app setup page or in the phone's browser). It keeps the link until the page asks for it.
 */
function startAndroidDeepLinks(): () => void {
  const take = () => {
    const u = androidApi()?.takeLink?.();
    if (u) routeDeepLink(u, true);
  };
  window.__harborDeepLinkCheck = take;
  // A link that launched the app is already waiting: hand it over once the UI is listening.
  const t = window.setTimeout(take, 400);
  return () => {
    window.clearTimeout(t);
    if (window.__harborDeepLinkCheck === take) window.__harborDeepLinkCheck = undefined;
  };
}

export async function startDeepLinkBridge(): Promise<() => void> {
  if (typeof window !== "undefined" && typeof androidApi()?.takeLink === "function") {
    return startAndroidDeepLinks();
  }
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
  if (!isTauri) return () => {};
  try {
    const mod = await import("@tauri-apps/plugin-deep-link");
    const handle = (urls: string[]) => {
      for (const u of urls) {
        if (typeof u !== "string" || u.length === 0) continue;
        const open = parseStremioOpen(u);
        if (open) {
          emitDeepLinkOpen(open);
          continue;
        }
        if (shouldForward(u)) emitDeepLinkInstall(u);
      }
    };
    const unlisten = await mod.onOpenUrl(handle);
    const { listen } = await import("@tauri-apps/api/event");
    const unlistenNative = await listen<string>("harbor:stremio-deeplink", (e) => {
      const u = e.payload;
      if (typeof u !== "string" || !u) return;
      const open = parseStremioOpen(u);
      if (open) {
        emitDeepLinkOpen(open);
        return;
      }
      if (shouldForward(u)) emitDeepLinkInstall(u);
    });
    let lastCap = "";
    let lastCapAt = 0;
    const forwardLinuxBrowserInstall = async (e: { payload: string }) => {
      const u = e.payload;
      if (typeof u !== "string" || !u) return;
      const open = parseStremioOpen(u);
      if (open) {
        emitDeepLinkOpen(open);
        return;
      }
      const now = Date.now();
      if (u === lastCap && now - lastCapAt < 2500) return;
      lastCap = u;
      lastCapAt = now;
      emitDeepLinkInstall(u);
      const { invoke } = await import("@tauri-apps/api/core");
      invoke("browser_close").catch(() => {});
    };
    const unlistenBrowserCap = await listen<string>(
      "harbor://browser-stremio-capture",
      forwardLinuxBrowserInstall,
    );
    try {
      const initial = await mod.getCurrent();
      if (initial && initial.length > 0) handle(initial);
    } catch {}
    return () => {
      try {
        unlisten();
      } catch {}
      try {
        unlistenNative();
      } catch {}
      try {
        unlistenBrowserCap();
      } catch {}
    };
  } catch (e) {
    console.warn("[harbor] deep-link bridge failed", e);
    return () => {};
  }
}
