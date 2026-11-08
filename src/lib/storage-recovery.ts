const PRUNABLE_KEYS_IN_ORDER: string[] = [
  "harbor.omdb.v1",
  "harbor.omdb.misses",
  "harbor.iptv.hydration.v2",
  "harbor.dead-streams.v1",
  "harbor.discover.v1",
  "harbor.playback-history.v1",
  "harbor.discover.events.v1",
  "harbor.scroll.v1",
  "harbor.webhook.lastTick",
];

function isQuotaError(e: unknown): boolean {
  if (e instanceof DOMException) {
    if (e.name === "QuotaExceededError") return true;
    if (e.name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
    if (e.code === 22) return true;
    if (e.code === 1014) return true;
  }
  return false;
}

function pruneOne(key: string): number {
  try {
    const cur = localStorage.getItem(key);
    if (cur == null) return 0;
    const freed = cur.length + key.length;
    localStorage.removeItem(key);
    console.info(`[storage] pruned "${key}" to free ${freed} chars`);
    return freed;
  } catch {
    return 0;
  }
}

export function setItemWithRecovery(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (!isQuotaError(e)) throw e;
  }
  for (const candidate of PRUNABLE_KEYS_IN_ORDER) {
    if (candidate === key) continue;
    pruneOne(candidate);
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
    }
  }
  console.warn(`[storage] giving up on "${key}" after pruning every known cache`);
  // Say so on screen: a sign-in or setting that only lives in memory is lost when Android ends
  // the app (StorageFullToast).
  try {
    window.dispatchEvent(new CustomEvent("harbor:storage-full", { detail: key }));
  } catch {
    /* no window (tests) */
  }
  return false;
}

export function freeStorageSpace(): { freedBytes: number; pruned: string[] } {
  let freed = 0;
  const pruned: string[] = [];
  for (const key of PRUNABLE_KEYS_IN_ORDER) {
    const n = pruneOne(key);
    if (n > 0) {
      freed += n;
      pruned.push(key);
    }
  }
  return { freedBytes: freed, pruned };
}

const PROACTIVE_PER_KEY_THRESHOLD = 256 * 1024;
const PROACTIVE_TOTAL_THRESHOLD = 3.5 * 1024 * 1024;

export function proactiveStorageCleanup(): void {
  if (typeof localStorage === "undefined") return;
  let total = 0;
  const overgrown: string[] = [];
  for (const key of PRUNABLE_KEYS_IN_ORDER) {
    try {
      const v = localStorage.getItem(key);
      if (!v) continue;
      const size = v.length + key.length;
      total += size;
      if (size > PROACTIVE_PER_KEY_THRESHOLD) overgrown.push(key);
    } catch {}
  }
  if (overgrown.length > 0) {
    for (const k of overgrown) pruneOne(k);
    console.info(`[storage] proactive cleanup: pruned ${overgrown.length} oversized caches`);
  }
  if (total > PROACTIVE_TOTAL_THRESHOLD) {
    const r = freeStorageSpace();
    console.info(`[storage] proactive total cleanup: ${r.pruned.length} caches, ${r.freedBytes} bytes`);
  }
}
