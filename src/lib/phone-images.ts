// Image loading tuned for the Android app (phone screens, mobile data). The app also keeps the
// images it shows on the phone (android/…/ImageCache.kt) and caps TMDB "original" at 1280px.
import { useEffect, useState, type RefObject } from "react";
import { isPhoneLayout } from "@/lib/platform";

const PHONE = isPhoneLayout();

/** TMDB size for episode stills. Phones show them small, so 500px is plenty (instead of the
 *  full-size original, 10-20× the bytes). */
export function stillSize(hd: boolean): string {
  if (PHONE) return "w500";
  return hd ? "original" : "w300";
}

/** On phones, images off screen wait until you get near them, so what you see loads first. */
export const phoneLazy: "lazy" | undefined = PHONE ? "lazy" : undefined;

// How far outside the screen a poster may be and still count as "near": about a screen
// above/below, a couple of posters to either side in a row.
const NEAR_Y = 800;
const NEAR_X = 360;

// Backup for the IntersectionObserver below. Some WebViews (seen on Android 13 handhelds such as
// the Anbernic RG 476H) never report the posters inside the scrolling rows as on screen, so
// every small cover stayed blank while the big banner — which doesn't wait — showed. This checks
// the posters' positions itself, on any scroll or resize and once a second while any still wait,
// so a poster on screen always loads whatever the WebView's observer does.
const waiting = new Map<Element, () => void>();
let frame = 0;
let timer = 0;

function isNear(el: Element): boolean {
  // Hidden (display:none, e.g. a page in the background): not near.
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  return r.bottom >= -NEAR_Y && r.top <= vh + NEAR_Y && r.right >= -NEAR_X && r.left <= vw + NEAR_X;
}

function checkWaiting() {
  frame = 0;
  for (const [el, done] of waiting) {
    if (isNear(el)) {
      waiting.delete(el);
      done();
    }
  }
  if (waiting.size === 0) stopWatching();
}

function scheduleCheck() {
  if (!frame) frame = requestAnimationFrame(checkWaiting);
}

function startWatching() {
  if (timer) return;
  window.addEventListener("scroll", scheduleCheck, { capture: true, passive: true });
  window.addEventListener("resize", scheduleCheck, { passive: true });
  timer = window.setInterval(scheduleCheck, 1000);
}

function stopWatching() {
  if (!timer) return;
  window.removeEventListener("scroll", scheduleCheck, { capture: true });
  window.removeEventListener("resize", scheduleCheck);
  window.clearInterval(timer);
  timer = 0;
}

/**
 * Phones: true once the element is about to scroll into view (about a screen below/above,
 * a couple of posters to either side in a row), so the posters you see load first instead
 * of the whole page's posters at once. Elsewhere: always true.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(!PHONE);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) {
      setNear(true);
      return;
    }
    let io: IntersectionObserver | undefined;
    const done = () => {
      waiting.delete(el);
      io?.disconnect();
      setNear(true);
    };
    waiting.set(el, done);
    startWatching();
    scheduleCheck();
    if (typeof IntersectionObserver !== "undefined") {
      try {
        // The pages scroll inside their own containers (and rows sideways), whose edges would
        // cut the margin off: scrollMargin widens every container on the way (current WebViews;
        // older ones ignore it, and the position check above covers them).
        const opts = {
          rootMargin: `${NEAR_Y}px ${NEAR_X / 3}px`,
          scrollMargin: `${NEAR_Y}px ${NEAR_X}px`,
        } as IntersectionObserverInit;
        io = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) done();
        }, opts);
        io.observe(el);
      } catch {
        io = undefined;
      }
    }
    return () => {
      waiting.delete(el);
      io?.disconnect();
    };
  }, [near, ref]);
  return near;
}
