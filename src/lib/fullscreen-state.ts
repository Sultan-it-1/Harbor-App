let windowFullscreen = false;
let suppressNextExit = false;
const subs = new Set<() => void>();

export function suppressFullscreenExitOnce(): void {
  suppressNextExit = true;
  setTimeout(() => {
    suppressNextExit = false;
  }, 1000);
}

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
}

function emit(): void {
  for (const fn of subs) fn();
}

export function getWindowFullscreen(): boolean {
  return windowFullscreen;
}

export function subscribeFullscreen(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function setWindowFullscreen(v: boolean): void {
  if (windowFullscreen === v) return;
  windowFullscreen = v;
  emit();
}

export async function enterWindowFullscreen(): Promise<void> {
  setWindowFullscreen(true);
  
  // Try to lock to landscape on mobile devices
  if (typeof screen !== "undefined" && screen.orientation && (screen.orientation as any).lock) {
    try {
      await (screen.orientation as any).lock("landscape");
    } catch {
      /* ignore */
    }
  }

  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("window_fullscreen_enter");
    } catch {
      /* ignore */
    }
  } else if (document.documentElement.requestFullscreen) {
    const p = document.documentElement.requestFullscreen();
    if (p && typeof p.catch === "function") {
      p.catch(() => {});
    }
  }
}

export async function exitWindowFullscreen(): Promise<void> {
  if (suppressNextExit) {
    suppressNextExit = false;
    return;
  }
  setWindowFullscreen(false);
  
  // Unlock orientation
  if (typeof screen !== "undefined" && screen.orientation && screen.orientation.unlock) {
    try {
      screen.orientation.unlock();
    } catch {
      /* ignore */
    }
  }

  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("window_fullscreen_exit");
    } catch {
      /* ignore */
    }
  } else if (document.fullscreenElement) {
    const p = document.exitFullscreen();
    if (p && typeof p.catch === "function") {
      p.catch(() => {});
    }
  }
}

export async function toggleWindowFullscreen(): Promise<void> {
  if (windowFullscreen) await exitWindowFullscreen();
  else await enterWindowFullscreen();
}
