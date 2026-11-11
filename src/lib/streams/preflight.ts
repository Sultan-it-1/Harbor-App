import { androidFetch, isAndroidApp } from "@/lib/android";
import { safeFetch as fetch } from "@/lib/safe-fetch";

/** A film or an episode is never smaller than this: a file under it is a debrid's "not ready"
 *  clip (or an error page), not the video. The Android downloader refuses the same size
 *  (`minBytes` in downloads-store.ts). */
export const MIN_REAL_SIZE_BYTES = 5 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 2500;
/** A download can wait longer than playback: a debrid "resolve" link takes several seconds. */
const DOWNLOAD_PREFLIGHT_TIMEOUT_MS = 10_000;

export type PreflightOk = { ok: true; sizeBytes: number | null };
export type PreflightFail = {
  ok: false;
  reason: "stub" | "unreachable" | "http-error";
  sizeBytes: number | null;
  status?: number;
  /** What the server called the short answer (a playlist or a web page is not a placeholder clip). */
  contentType?: string | null;
};
export type PreflightResult = PreflightOk | PreflightFail;

export type PreflightOptions = {
  /** Give up after this long (playback's 2.5 s when left out). */
  timeoutMs?: number;
  /** Request headers the link needs (the stream's own). */
  headers?: Record<string, string>;
  /** Android app: always ask through the shell. The page itself can't read the size of a link
   *  on another site (Content-Range is hidden from it) and can't follow a redirect to a host
   *  without CORS, which is exactly what an addon's "resolve" link does. */
  viaShell?: boolean;
};

const memo = new Map<string, PreflightResult>();
const inflight = new Map<string, Promise<PreflightResult>>();

export function readPreflightMemo(url: string): PreflightResult | null {
  return memo.get(url) ?? null;
}

export function preflightCheck(url: string, signal?: AbortSignal, opts?: PreflightOptions): Promise<PreflightResult> {
  // A check with its own time limit or headers (a download) is always asked afresh and never
  // kept: an answer cut short by playback's 2.5 s says nothing about a link that needs 6 s,
  // and a source that sent a placeholder a minute ago may be ready now. The memo below stays
  // what it was: playback's answers, one per URL.
  if (opts) return run(url, signal, opts);
  const cached = memo.get(url);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(url);
  if (pending) return pending;
  const p = run(url, signal).then((r) => {
    inflight.delete(url);
    memo.set(url, r);
    return r;
  });
  inflight.set(url, p);
  return p;
}

export type DownloadLinkCheck =
  /** The link answers and is not a placeholder (`sizeBytes` when the server said the size). */
  | { verdict: "ok"; sizeBytes: number | null }
  /** A short clip, or nothing at all (404), where the video should be. */
  | { verdict: "placeholder"; sizeBytes: number | null }
  /** A streaming playlist or a web page: nothing that can be saved as a file. */
  | { verdict: "not-a-file" }
  /** No clear answer: unreachable, timed out, or an error status. */
  | { verdict: "unsure" };

const NOT_A_FILE_RX = /mpegurl|dash\+xml|text\/html|application\/xhtml|application\/json/i;

/**
 * The size check before a download starts. Playback skips it for a link that came straight
 * from an addon; a download can't: an addon's debrid link answers with a short "not ready"
 * clip, a real video file, which used to be saved and shown as finished.
 */
export async function checkDownloadLink(
  url: string,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<DownloadLinkCheck> {
  if (signal?.aborted) return { verdict: "unsure" };
  const r = await preflightCheck(url, signal, { timeoutMs: DOWNLOAD_PREFLIGHT_TIMEOUT_MS, headers, viaShell: true });
  if (r.ok) return { verdict: "ok", sizeBytes: r.sizeBytes };
  if (r.reason !== "stub") return { verdict: "unsure" };
  // A playlist or a web page is small too, but it is not "not ready yet": the downloader has
  // its own, exact message for those.
  if (r.contentType && NOT_A_FILE_RX.test(r.contentType)) return { verdict: "not-a-file" };
  return { verdict: "placeholder", sizeBytes: r.sizeBytes };
}

async function run(url: string, signal?: AbortSignal, opts: PreflightOptions = {}): Promise<PreflightResult> {
  const timeoutMs = opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const viaShell = !!opts.viaShell && isAndroidApp();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (k.toLowerCase() !== "range") headers[k] = v;
  headers.Range = "bytes=0-1";
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init = { method: "GET", headers, redirect: "follow", signal: ctrl.signal } as const;
    const rangeRes = await (viaShell ? androidFetch(url, { ...init, timeoutMs }) : fetch(url, init)).catch(() => null);
    if (!rangeRes) {
      return { ok: false, reason: "unreachable", sizeBytes: null };
    }
    if (rangeRes.status === 404 || rangeRes.status === 410) {
      return { ok: false, reason: "stub", sizeBytes: 0, status: rangeRes.status };
    }
    if (!rangeRes.ok && rangeRes.status !== 206 && rangeRes.status !== 200) {
      return { ok: false, reason: "http-error", sizeBytes: null, status: rangeRes.status };
    }
    const contentType = rangeRes.headers.get("Content-Type");
    const rangeTotal = parseRangeTotal(rangeRes.headers.get("Content-Range"));
    if (rangeTotal != null && rangeTotal > 0 && rangeTotal < MIN_REAL_SIZE_BYTES) {
      return { ok: false, reason: "stub", sizeBytes: rangeTotal, contentType };
    }
    if (rangeTotal != null && rangeTotal >= MIN_REAL_SIZE_BYTES) {
      return { ok: true, sizeBytes: rangeTotal };
    }
    let fullLen = parseLength(rangeRes.headers.get("Content-Length"));
    if (viaShell && rangeRes.status === 200 && fullLen == null) {
      // The shell hands over the whole answer and leaves out its Content-Length. When the
      // server ignored the range (200), the answer is the file: its size is the file's size.
      fullLen = await rangeRes
        .arrayBuffer()
        .then((b) => b.byteLength)
        .catch(() => null);
    }
    if (rangeRes.status === 200 && fullLen != null && fullLen < MIN_REAL_SIZE_BYTES) {
      return { ok: false, reason: "stub", sizeBytes: fullLen, contentType };
    }
    if (fullLen != null && fullLen >= MIN_REAL_SIZE_BYTES) {
      return { ok: true, sizeBytes: fullLen };
    }
    return { ok: true, sizeBytes: null };
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseLength(v: string | null): number | null {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseRangeTotal(v: string | null): number | null {
  if (!v) return null;
  const m = v.match(/\/(\d+)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
