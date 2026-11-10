import { forgetDeadStreamsMemo } from "./dead-streams";
import { dropOldestSnapshots } from "./snapshots";

// Kept parsed in memory by dead-streams.ts, which has to hear when it is removed here.
const DEAD_STREAMS_KEY = "harbor.dead-streams.v1";

const PRUNABLE_KEYS_IN_ORDER: string[] = [
  "harbor.omdb.v1",
  "harbor.omdb.misses",
  "harbor.iptv.hydration.v2",
  DEAD_STREAMS_KEY,
  "harbor.discover.v1",
  "harbor.playback-history.v1",
  "harbor.discover.events.v1",
  "harbor.scroll.v1",
  "harbor.webhook.lastTick",
];

// After the caches: the player's thumbnails (up to 80 small JPEGs, oldest first, a few at a
// time), then resume positions nobody has touched for a year and a half.
const SNAPSHOT_BATCH = 8;
const SNAPSHOT_MAX_ROUNDS = 20;
const RESUME_KEY = "harbor.resume";
const RESUME_MAX_AGE_MS = 548 * 24 * 60 * 60 * 1000;

function pruneOldResume(): boolean {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return false;
    const all = JSON.parse(raw) as Record<string, { t?: number } | null>;
    const cutoff = Date.now() - RESUME_MAX_AGE_MS;
    let dropped = 0;
    for (const [k, e] of Object.entries(all)) {
      if (typeof e?.t === "number" && e.t < cutoff) {
        delete all[k];
        dropped++;
      }
    }
    if (dropped === 0) return false;
    localStorage.setItem(RESUME_KEY, JSON.stringify(all));
    console.info(`[storage] pruned ${dropped} resume positions older than 18 months`);
    return true;
  } catch {
    return false;
  }
}

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
    if (key === DEAD_STREAMS_KEY) forgetDeadStreamsMemo();
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
  const retry = (): boolean => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      return false;
    }
  };
  for (const candidate of PRUNABLE_KEYS_IN_ORDER) {
    if (candidate === key) continue;
    pruneOne(candidate);
    if (retry()) return true;
  }
  for (let round = 0; round < SNAPSHOT_MAX_ROUNDS; round++) {
    if (dropOldestSnapshots(SNAPSHOT_BATCH) === 0) break;
    if (retry()) return true;
  }
  if (key !== RESUME_KEY && pruneOldResume() && retry()) return true;
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
