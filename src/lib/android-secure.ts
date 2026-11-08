// Android app: keep screenshots, screen recordings and the Recents preview out of screens that
// show secrets. While a password field or an element marked data-secure-screen (the PIN pad)
// is on screen, the window gets FLAG_SECURE; it is lifted again when they are gone.
import { androidApi } from "@/lib/android";

const SELECTOR = 'input[type="password"], [data-secure-screen]';

export function watchSecureScreens(): void {
  const api = androidApi();
  if (!api?.setSecure || typeof MutationObserver === "undefined") return;
  // Unknown at first: the first check always tells the shell, so a reloaded page (or a rebuilt
  // WebView) clears a FLAG_SECURE the previous page left on.
  let secure: boolean | null = null;
  let queued = false;
  const check = () => {
    queued = false;
    const now = document.querySelector(SELECTOR) != null;
    if (now === secure) return;
    secure = now;
    try {
      api.setSecure?.(now);
    } catch {
      /* older shell */
    }
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(check);
  }).observe(document.documentElement, { childList: true, subtree: true });
  check();
}
