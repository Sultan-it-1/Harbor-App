// "Download the best source": go through a title's (or an episode's) streams in the order
// "Instant" play would try them (buildAutoCandidates: the callers hand that list over), and
// queue the first one that is really ready to be saved. Used by the button in the picker's
// download mode and, per episode, by "Download season" (season-download.ts).
import type { Meta } from "@/lib/cinemeta";
import type { DebridStore, DirectLink } from "@/lib/debrid/types";
import { markStreamDead } from "@/lib/dead-streams";
import { checkDownloadLink } from "@/lib/streams/preflight";
import { resolveStream } from "@/lib/streams/resolve";
import type { ScoredStream } from "@/lib/streams/types";
import type { PlayEpisode } from "@/lib/view";
import { hasUncachedMarker } from "@/views/play-picker/picker-utils";
import { downloadMinBytes, enqueueDownload } from "./downloads-store";

/** How many sources are tried in all before giving up. Each try can take several seconds, and
 *  opening an addon's link that turns out not to be cached makes that addon start the torrent
 *  on the debrid, so the list is not walked to its end. */
const MAX_TRIES = 12;

/** After this many sources of one provider were not ready, the rest of that provider wait until
 *  every other provider has had its turn. The best-ranked sources often all come from the same
 *  addon, and when its links are not really cached they fail one after the other: the button
 *  used to stop there and never reach the addons further down. */
const PROVIDER_STRIKES = 2;

/** A source that answered with a placeholder is left out of auto-play for this long (as a
 *  pick by hand does, use-pick-handler.ts): it may well be ready later. */
const PLACEHOLDER_DEAD_TTL_MS = 15 * 60 * 1000;

/** The user's debrid services that already hold this stream (cached there, or in their library). */
export function heldBy(s: ScoredStream, debrids: DebridStore[]): DebridStore[] {
  return debrids.filter((d) => s.cached?.[d.slug] === true || s.inLibrary?.[d.slug] === true);
}

/**
 * Streams worth trying for a download, best first: cached on a debrid or a direct link. An
 * uncached torrent is never tried: it can't be saved right now, and asking a debrid for it
 * leaves the torrent queued in the user's account (TorBox, AllDebrid). The same goes for an
 * addon's own link that says it isn't cached ("[RD download]", ⏳): opening it only makes the
 * addon start that torrent on the debrid, and what comes back is the placeholder clip.
 */
export function downloadCandidates(all: ScoredStream[], debrids: DebridStore[]): ScoredStream[] {
  const direct = (s: ScoredStream) => !!s.url && s.url !== "#" && !s.infoHash && !hasUncachedMarker(s);
  return all.filter((s) => heldBy(s, debrids).length > 0 || direct(s));
}

/**
 * Where a stream's link comes from: its addon and, for an addon's own link, the server the link
 * points at (an addon that gathers several others hands out links to each of them). Sources of
 * one provider tend to fail together, so the tries are spread over the providers.
 */
export function providerKey(s: ScoredStream): string {
  let host = "";
  if (s.url && !s.infoHash) {
    try {
      host = new URL(s.url).host.toLowerCase();
    } catch {
      /* not an address: the addon alone names the provider */
    }
  }
  return `${s.addonId}|${host}`;
}

/** What a download is called on the Downloads page ("4K WEB-DL"), from its stream. */
export function downloadLabel(s: ScoredStream): string | null {
  return [s.resolution, s.source].filter(Boolean).join(" ") || s.parsedTitle || s.title || s.name || s.addonName || null;
}

export type BestDownloadResult =
  | { ok: true; stream: ScoredStream; label: string | null }
  /** "no-candidates": nothing cached or direct in the list; "none-ready": every one tried failed. */
  | { ok: false; reason: "no-candidates" | "none-ready" | "aborted" };

export async function queueBestDownload(opts: {
  meta: Meta;
  episode?: PlayEpisode;
  /** The title's streams in the order they are to be tried (buildAutoCandidates). */
  streams: ScoredStream[];
  debrids: DebridStore[];
  signal: AbortSignal;
  /** A candidate that turned out not to be usable (the picker marks its row). */
  onNotReady?: (s: ScoredStream) => void;
}): Promise<BestDownloadResult> {
  const { meta, episode, streams, debrids, signal, onNotReady } = opts;
  const candidates = downloadCandidates(streams, debrids);
  if (candidates.length === 0) return { ok: false, reason: "no-candidates" };
  // Only films and episodes have a size a placeholder can be told from.
  const checkSize = downloadMinBytes(meta, episode) > 0;
  const queue = async (s: ScoredStream, link: DirectLink): Promise<BestDownloadResult> => {
    const label = downloadLabel(s);
    await enqueueDownload({
      meta,
      episode,
      streamLabel: label,
      url: link.url,
      rawUrl: link.url,
      headers: link.headers,
      subtitles: link.subtitles,
      source: s,
    });
    return { ok: true, stream: s, label };
  };
  // The best source whose link gave no clear answer (unreachable, timed out, an error status).
  // (Kept in a list because it is set from inside `attempt`; only the first one counts.)
  const unsure: { stream: ScoredStream; link: DirectLink }[] = [];
  // One source: its link if it is clearly ready, null when the next one should be tried.
  const attempt = async (s: ScoredStream): Promise<DirectLink | null> => {
    // Only the services that already have it, and not as a "start this torrent" request.
    const r = await resolveStream(s, heldBy(s, debrids), signal, false);
    if (signal.aborted) return null;
    if (!r.ok) {
      onNotReady?.(s);
      return null;
    }
    if (!checkSize) return r.data;
    const check = await checkDownloadLink(r.data.url, r.data.headers, signal);
    if (signal.aborted) return null;
    if (check.verdict === "ok") return r.data;
    if (check.verdict === "placeholder") {
      markStreamDead({ url: r.data.url }, `preflight_stub_${check.sizeBytes ?? 0}b`, PLACEHOLDER_DEAD_TTL_MS);
      onNotReady?.(s);
    } else if (check.verdict === "not-a-file") {
      onNotReady?.(s);
    } else {
      if (unsure.length === 0) unsure.push({ stream: s, link: r.data });
    }
    // Anything but a clear yes: the next one may be fine.
    return null;
  };
  // Best first, but a provider whose sources keep failing gives way to the others; what it
  // has left is tried last, if there are tries left.
  const strikes = new Map<string, number>();
  const setAside: ScoredStream[] = [];
  let tries = 0;
  for (const round of [candidates, setAside]) {
    for (const s of round) {
      if (signal.aborted || tries >= MAX_TRIES) break;
      const provider = providerKey(s);
      if (round === candidates && (strikes.get(provider) ?? 0) >= PROVIDER_STRIKES) {
        setAside.push(s);
        continue;
      }
      tries++;
      const link = await attempt(s);
      if (link) return queue(s, link);
      strikes.set(provider, (strikes.get(provider) ?? 0) + 1);
    }
  }
  if (signal.aborted) return { ok: false, reason: "aborted" };
  // None was clearly ready, but one could not be checked at all (a slow link, a server that
  // doesn't answer a size question): start that one, as a pick by hand would. The app's own
  // downloader still refuses it if it turns out to be a placeholder.
  if (unsure.length > 0) return queue(unsure[0].stream, unsure[0].link);
  return { ok: false, reason: "none-ready" };
}
