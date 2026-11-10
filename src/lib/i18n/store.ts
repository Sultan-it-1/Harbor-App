import { useSyncExternalStore } from "react";
import { isRtl, type UiLanguage } from "./languages";

/** The Android shell draws the player and its notifications itself, in the app's language. */
function tellShell(lang: UiLanguage): void {
  try {
    (window as unknown as { HarborAndroid?: { setLanguage?: (l: string) => void } }).HarborAndroid?.setLanguage?.(lang);
  } catch {
    /* an older shell */
  }
}

let current: UiLanguage = "en";
const listeners = new Set<() => void>();

function applyDocument(lang: UiLanguage) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dir = isRtl(lang) ? "rtl" : "ltr";
  root.lang = lang;
}

export function getUiLanguage(): UiLanguage {
  return current;
}

export function setUiLanguage(lang: UiLanguage): void {
  const next: UiLanguage = lang === "ar" ? "ar" : "en";
  applyDocument(next);
  tellShell(next);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(subscribe, getUiLanguage, getUiLanguage);
}
