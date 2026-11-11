// "Download the best source": go through a title's (or an episode's) ranked streams, best
// first, and queue the first one that is really ready to be saved. Used by the button in the
// picker's download mode and, per episode, by "Download season" (season-download.ts).
import type { Meta } from "@/lib/cinemeta";
import type { DebridStore, DirectLink } from "@/lib/debrid/types";
import { markStreamDead } from "@/lib/dead-streams";
import { checkDownloadLink } from "@/lib/streams/preflight";
import { resolveStream } from "@/lib/streams/resolve";
import type { ScoredStream } from "@/lib/streams/types";
import type { PlayEpisode } from "@/lib/view";
import { hasUncachedMarker } from "@/views/play-picker/picker-utils";
import { downloadMinBytes, enqueueDownload } from "./downloads-store";

/** How many sources are tried before giving up (each try can take several seconds). */
const MAX_CANDIDATES = 6;

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
  return all.filter((s) => heldBy(s, debrids).length > 0 || direct(s)).slice(0, MAX_CANDIDATES);
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
  /** The title's ranked streams (the picker's `result.picker.all`). */
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
  let unsure: { stream: ScoredStream; link: DirectLink } | null = null;
  for (const s of candidates) {
    if (signal.aborted) break;
    // Only the services that already have it, and not as a "start this torrent" request.
    const r = await resolveStream(s, heldBy(s, debrids), signal, false);
    if (signal.aborted) break;
    if (!r.ok) {
      onNotReady?.(s);
      continue;
    }
    if (checkSize) {
      const check = await checkDownloadLink(r.data.url, r.data.headers, signal);
      if (signal.aborted) break;
      if (check.verdict === "placeholder") {
        markStreamDead({ url: r.data.url }, `preflight_stub_${check.sizeBytes ?? 0}b`, PLACEHOLDER_DEAD_TTL_MS);
        onNotReady?.(s);
      } else if (check.verdict === "not-a-file") {
        onNotReady?.(s);
      } else if (check.verdict === "unsure") {
        unsure ??= { stream: s, link: r.data };
      }
      // Anything but a clear yes: the next one may be fine.
      if (check.verdict !== "ok") continue;
    }
    return queue(s, r.data);
  }
  if (signal.aborted) return { ok: false, reason: "aborted" };
  // None was clearly ready, but one could not be checked at all (a slow link, a server that
  // doesn't answer a size question): start that one, as a pick by hand would. The app's own
  // downloader still refuses it if it turns out to be a placeholder.
  if (unsure) return queue(unsure.stream, unsure.link);
  return { ok: false, reason: "none-ready" };
}
