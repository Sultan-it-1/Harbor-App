import type { Addon } from "@/lib/addons";
import { isAndroidApp } from "@/lib/android";
import { dlog } from "@/lib/debug";
import type { DebridStore } from "@/lib/debrid/types";
import { fetchAddonStreams, type StreamRequest } from "./addons";
import { enhanceAnimeStreams } from "./anitomy";
import { streamKey } from "./identity";
import { fetchLibraryStreams, type LibraryQuery } from "./library";
import { parseStream } from "./parser";
import { torrentsDisabled } from "@/lib/torrent/stremio-stream";
import { applyTrust, type Rejection, type TrustOptions } from "./trust";
import { computeCorpusStats, rankAndPick, scoreStream, type ScoreOptions } from "./scoring";
import type { ParsedStream, RankedPicker, Stream } from "./types";

// A browser can't decode AC3 or DTS, so the web build picks an AAC source first. The Android
// player decodes them all, and there the AAC source is usually the weaker one.
const PREFER_AAC =
  typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window) && !isAndroidApp();

const GIB = 1024 ** 3;
const RESCUABLE_REASON_RX = /^(fresh-cinema-fake|new-release-stub)/;

function rescueCorroboratedLeaks(rejected: Rejection[], trust: TrustOptions): Set<ParsedStream> {
  const rd = trust.releaseDate ? new Date(trust.releaseDate) : null;
  if (!rd || Number.isNaN(rd.getTime())) return new Set();
  const days = (Date.now() - rd.getTime()) / 86_400_000;
  if (!(days > -90 && days < 60)) return new Set();
  const minSize = (res: string) => (res === "4K" ? 2.5 * GIB : GIB);
  const candidates = rejected.filter(
    (r) =>
      RESCUABLE_REASON_RX.test(r.reason) &&
      (r.stream.resolution === "1080p" || r.stream.resolution === "4K") &&
      r.stream.size != null &&
      r.stream.size >= minSize(r.stream.resolution),
  );
  const clusters = new Map<string, ParsedStream[]>();
  for (const r of candidates) {
    const bucket = Math.round((r.stream.size! / GIB) * 4) / 4;
    const key = `${r.stream.resolution}|${bucket}`;
    const arr = clusters.get(key);
    if (arr) arr.push(r.stream);
    else clusters.set(key, [r.stream]);
  }
  const rescued = new Set<ParsedStream>();
  for (const streams of clusters.values()) {
    const groups = new Set(streams.map((s) => s.releaseGroupNormalized).filter(Boolean));
    if (streams.length >= 3 || groups.size >= 2) {
      for (const s of streams) rescued.add(s);
    }
  }
  return rescued;
}

function finalizeWithRescue(
  picker: RankedPicker,
  rejected: Rejection[],
  trust: TrustOptions,
  score: ScoreOptions,
): { picker: RankedPicker; rejected: Rejection[] } {
  const rescued = rescueCorroboratedLeaks(rejected, trust);
  if (rescued.size === 0) return { picker, rejected };
  const keep: ParsedStream[] = [...picker.all, ...rescued];
  const corpus = computeCorpusStats(keep, score);
  const scored = keep.map((s) => scoreStream(s, score, corpus));
  const newPicker = rankAndPick(scored, score.activeDebrids, PREFER_AAC, score.respectAddonOrder === true);
  dlog(`[pipeline] early-leak rescue: restored ${rescued.size} corroborated high-res stream(s)`);
  return { picker: newPicker, rejected: rejected.filter((r) => !rescued.has(r.stream)) };
}

/**
 * The Android app has no torrent engine (and the picker never plays through a remote stream
 * server), so with no debrid service a source that is only an info hash can't play. Those are
 * left out; how many is reported as `p2pOnlyHidden` so the picker can say why it is empty.
 *
 * The same goes anywhere once "Turn torrents off completely" is on: with no debrid service
 * such a source could only play peer-to-peer, which that switch forbids. With a debrid
 * service it stays, because the service can fetch it and nothing is torrented here.
 */
function dropP2pOnly(
  parsed: ParsedStream[],
  debrids: DebridStore[],
): { playable: ParsedStream[]; hidden: number } {
  if (debrids.length > 0) return { playable: parsed, hidden: 0 };
  if (!isAndroidApp() && !torrentsDisabled()) return { playable: parsed, hidden: 0 };
  const playable = parsed.filter(
    (s) => !s.infoHash || !!s.url || !!s.ytId || !!s.externalUrl || !!s.nzbUrl,
  );
  return { playable, hidden: parsed.length - playable.length };
}

function isJapanese(lang: string): boolean {
  const l = lang.trim().toLowerCase();
  return l === "jp" || l.startsWith("ja");
}

/**
 * "Require preferred language": sources in another language are set aside as "language-mismatch".
 * Same rules as the picker's language filter: a source with no language tag or a multi-language
 * one passes, Japanese only counts for anime, and when nothing would be left everything is kept
 * (a title never ends up with no sources because of this).
 */
function applyRequiredLanguage(
  keep: ParsedStream[],
  rejected: Rejection[],
  trust: TrustOptions,
): { keep: ParsedStream[]; rejected: Rejection[] } {
  if (!trust.requirePreferredLanguage || trust.disabled) return { keep, rejected };
  const langs = [
    ...(trust.preferredLanguages ?? []),
    ...(trust.preferredAudioLangs ?? []),
    ...(trust.isAnime ? ["Japanese"] : []),
  ]
    .filter((l) => trust.isAnime || !isJapanese(l))
    .map((l) => l.toLowerCase());
  if (langs.length === 0) return { keep, rejected };
  const matches = (s: ParsedStream) =>
    s.audioLanguages.length === 0 ||
    s.audioLanguages.includes("Multi") ||
    s.audioLanguages.some((l) => langs.some((p) => l.toLowerCase() === p || l.toLowerCase().startsWith(p)));
  const inLanguage = keep.filter(matches);
  if (inLanguage.length === 0 || inLanguage.length === keep.length) return { keep, rejected };
  const others = keep.filter((s) => !matches(s)).map((stream) => ({ stream, reason: "language-mismatch" }));
  return { keep: inLanguage, rejected: [...rejected, ...others] };
}

/** The trust filter, then the "require preferred language" setting. */
function applyFilters(
  parsed: ParsedStream[],
  trust: TrustOptions,
): { keep: ParsedStream[]; rejected: Rejection[] } {
  const { keep, rejected } = applyTrust(parsed, trust);
  return applyRequiredLanguage(keep, rejected, trust);
}

export type PipelineInput = {
  request: StreamRequest;
  query: LibraryQuery;
  addons: Addon[];
  debrids: DebridStore[];
  trust?: TrustOptions;
  score: ScoreOptions;
  isAnime?: boolean;
  presetStreams?: Stream[];
};

export type PipelineResult = {
  picker: RankedPicker;
  rejected: Rejection[];
  raw: { addon: Stream[]; library: Stream[] };
  /** Torrent-only sources left out because nothing here can play them (Android, no debrid service). */
  p2pOnlyHidden: number;
};

export async function runPipeline(
  input: PipelineInput,
  signal: AbortSignal,
  onProgress?: (partial: PipelineResult) => void,
): Promise<PipelineResult> {
  let library: Stream[] = [];
  let lastPartialAt = 0;

  const buildPartial = (addonStreams: Stream[]): PipelineResult => {
    const merged = mergeAndDedupe(library, addonStreams);
    const { playable: parsed, hidden } = dropP2pOnly(merged.map(parseStream), input.debrids);
    const { keep, rejected } = applyFilters(parsed, input.trust ?? {});
    const corpus = computeCorpusStats(keep, input.score);
    const scored = keep.map((s) => scoreStream(s, input.score, corpus));
    const picker = rankAndPick(scored, input.score.activeDebrids, PREFER_AAC, input.score.respectAddonOrder === true);
    const fin = finalizeWithRescue(picker, rejected, input.trust ?? {}, input.score);
    return { picker: fin.picker, rejected: fin.rejected, raw: { addon: addonStreams, library }, p2pOnlyHidden: hidden };
  };

  const emitPartial = (addonStreams: Stream[]) => {
    if (!onProgress || signal.aborted) return;
    const now = performance.now();
    if (now - lastPartialAt < 250) return;
    lastPartialAt = now;
    try {
      onProgress(buildPartial(addonStreams));
    } catch {
      /* swallow */
    }
  };

  const presets = input.presetStreams ?? [];
  const [librarySettled, addonSettled] = await Promise.allSettled([
    fetchLibraryStreams(input.debrids, input.query, signal).then((s) => {
      library = s;
      return s;
    }),
    presets.length > 0
      ? Promise.resolve(presets)
      : fetchAddonStreams(input.addons, input.request, signal, emitPartial),
  ]);
  if (librarySettled.status === "fulfilled") library = librarySettled.value;
  const addonStreams = addonSettled.status === "fulfilled" ? addonSettled.value : [];
  const merged = mergeAndDedupe(library, addonStreams);

  const { playable: parsed, hidden: p2pOnlyHidden } = dropP2pOnly(merged.map(parseStream), input.debrids);
  if (p2pOnlyHidden > 0) {
    dlog(`[pipeline] ${p2pOnlyHidden} torrent-only stream(s) left out: no debrid service, and no torrent engine here or torrents are turned off`);
  }

  if (input.isAnime) {
    await enhanceAnimeStreams(parsed);
  }

  const hashes = [
    ...new Set(
      parsed
        .map((p) => p.infoHash)
        .filter((h): h is string => Boolean(h))
        .map((h) => h.toLowerCase()),
    ),
  ];
  if (hashes.length > 0 && input.debrids.length > 0 && !signal.aborted) {
    dlog(`[pipeline] ${parsed.length} parsed streams · ${hashes.length} unique hashes · debrids: ${input.debrids.map((d) => d.name).join(", ")}`);
    const [cacheResults, libraryResults] = await Promise.all([
      Promise.allSettled(input.debrids.map((d) => d.cacheCheck(hashes, signal))),
      Promise.allSettled(input.debrids.map((d) => d.listLibrary(signal))),
    ]);
    for (let i = 0; i < input.debrids.length; i++) {
      const r = cacheResults[i];
      if (r.status !== "fulfilled" || !r.value.ok) continue;
      const slug = input.debrids[i].slug;
      let hits = 0;
      for (const p of parsed) {
        if (!p.infoHash) continue;
        if (r.value.data[p.infoHash.toLowerCase()]) {
          p.cached[slug] = true;
          hits++;
        }
      }
      dlog(`[pipeline] cacheCheck on ${input.debrids[i].name}: ${hits} streams flagged cached`);
    }

    for (let i = 0; i < input.debrids.length; i++) {
      const r = libraryResults[i];
      if (r.status !== "fulfilled" || !r.value.ok) continue;
      const slug = input.debrids[i].slug;
      const libHashes = new Set(r.value.data.map((e) => e.hash.toLowerCase()).filter(Boolean));
      let hits = 0;
      for (const p of parsed) {
        if (!p.infoHash) continue;
        if (libHashes.has(p.infoHash.toLowerCase())) {
          if (!p.cached[slug]) hits++;
          p.cached[slug] = true;
          p.inLibrary[slug] = true;
        }
      }
      dlog(`[pipeline] listLibrary cross-check on ${input.debrids[i].name}: ${hits} extra streams flagged cached (lib has ${libHashes.size} hashes)`);
    }

    const totalCached = parsed.filter((p) => Object.values(p.cached).some(Boolean)).length;
    dlog(`[pipeline] final: ${totalCached}/${parsed.length} streams marked cached`);
  }

  const core = await runCorePipeline(parsed, input.trust ?? {}, input.score);
  if (core) {
    if (core.rejected.length > 0) {
      const byReason = new Map<string, number>();
      for (const r of core.rejected) {
        const k = r.reason.split(":")[0];
        byReason.set(k, (byReason.get(k) ?? 0) + 1);
      }
      const summary = [...byReason.entries()].map(([k, n]) => `${k}=${n}`).join(", ");
      dlog(`[pipeline] (core) trust kept ${core.picker.all.length}/${parsed.length} · rejected: ${summary}`);
    }
    const fin = finalizeWithRescue(core.picker, core.rejected, input.trust ?? {}, input.score);
    return { picker: fin.picker, rejected: fin.rejected, raw: { addon: addonStreams, library }, p2pOnlyHidden };
  }
  const { keep, rejected } = applyFilters(parsed, input.trust ?? {});
  if (rejected.length > 0) {
    const byReason = new Map<string, number>();
    for (const r of rejected) {
      const k = r.reason.split(":")[0];
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
    const summary = [...byReason.entries()].map(([k, n]) => `${k}=${n}`).join(", ");
    dlog(`[pipeline] trust kept ${keep.length}/${parsed.length} · rejected: ${summary}`);
    for (const r of rejected.slice(0, 6)) {
      dlog(`[pipeline]   reject ${r.reason} :: ${r.stream.parsedTitle ?? r.stream.title ?? r.stream.name ?? "?"}`);
    }
  }
  const corpus = computeCorpusStats(keep, input.score);
  const scored = keep.map((s) => scoreStream(s, input.score, corpus));
  const picker = rankAndPick(scored, input.score.activeDebrids, PREFER_AAC, input.score.respectAddonOrder === true);
  const fin = finalizeWithRescue(picker, rejected, input.trust ?? {}, input.score);
  return { picker: fin.picker, rejected: fin.rejected, raw: { addon: addonStreams, library }, p2pOnlyHidden };
}

async function runCorePipeline(
  parsed: ReturnType<typeof parseStream>[],
  trustOpts: TrustOptions,
  scoreOpts: ScoreOptions,
): Promise<{ picker: RankedPicker; rejected: Rejection[] } | null> {
  const isTauri = typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = (await invoke("streams_run_pipeline", {
      streams: parsed,
      trustOpts,
      scoreOpts,
    })) as { picker: RankedPicker; rejected: Rejection[] };
    return result;
  } catch (e) {
    dlog(`[pipeline] core pipeline failed, falling back to JS: ${e}`);
    return null;
  }
}

function mergeAndDedupe(library: Stream[], addons: Stream[]): Stream[] {
  const seen = new Map<string | Stream, Stream>();
  for (const s of [...library, ...addons]) {
    const identity = streamKey(s);
    // Addon tabs filter by the owning installation. Sharing a playback endpoint
    // must not remove either installation's row, metadata, or native ordering.
    // (The lists that arrive while addons are still answering are not deduplicated
    // where they are fetched, so the same rule is applied here.)
    const key =
      typeof identity === "string" ? JSON.stringify([s.addonUrl, s.addonId, identity]) : identity;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { ...s, contributors: [{ id: s.addonId, name: s.addonName }] });
    } else if (s.sources?.length) {
      prior.sources = [...new Set([...(prior.sources ?? []), ...s.sources])];
    }
  }
  return [...seen.values()];
}
