import { useMemo } from "react";
import { isStreamDead } from "@/lib/dead-streams";
import { engineP2pEligible } from "@/lib/torrent/stremio-stream";
import type { DebridStore } from "@/lib/debrid/types";
import type { ScoredStream } from "@/lib/streams/types";
import { episodeSpanContains } from "@/lib/streams/episode-span";
import {
  findPreferredSourceMatch,
  streamMatchesEntry,
  streamMatchesPreferredSource,
  streamMatchesPreferredSourceFallback,
  streamOfferedByAddon,
  type PlaybackEntry,
} from "@/lib/playback-history";
import type { SourceDescriptor } from "@/lib/together/protocol";
import { buildMatchScores } from "@/lib/together/source-match";
import { hasInstantMarker, hasUncachedMarker, isWatchHub, needsDownload, normalizeLangCode, streamMatchesLangs } from "./picker-utils";

// A single episode is almost never this big; a file over it that does not name the wanted
// episode is most likely a whole season.
const LIKELY_PACK_BYTES = 12 * 1024 * 1024 * 1024;

export type AutoCandidateArgs = {
  filteredPicker: { all: ScoredStream[]; primary: ScoredStream | null } | null;
  previousPlayback: PlaybackEntry | null;
  sourceEntry: PlaybackEntry | null;
  isCached: (s: ScoredStream) => boolean;
  addons: Array<{ manifest?: { id?: string } }> | null;
  hasStrongAddon: boolean;
  isTorrentioStream: (s: ScoredStream) => boolean;
  preferredLangs: string[];
  hostSource?: SourceDescriptor | null;
  /** The episode being picked for, in the numbering sources are checked against. Leave
   *  both null for a film and for anime (absolute numbering makes a release's "S01E27" say
   *  nothing reliable about which episode it is). */
  season?: number | null;
  episode?: number | null;
};

export function useAutoCandidates(args: AutoCandidateArgs): ScoredStream[] {
  const { filteredPicker, previousPlayback, sourceEntry, isCached, addons, hasStrongAddon, isTorrentioStream, preferredLangs, hostSource, season, episode } = args;
  return useMemo(
    () => buildAutoCandidates({ filteredPicker, previousPlayback, sourceEntry, isCached, addons, hasStrongAddon, isTorrentioStream, preferredLangs, hostSource, season, episode }),
    [filteredPicker, previousPlayback, sourceEntry, isCached, addons, hasStrongAddon, isTorrentioStream, preferredLangs, hostSource, season, episode],
  );
}

/**
 * The sources "Instant" play goes through, in its order: the one played last time first, then
 * what starts at once, single episodes before packs, the preferred languages, the user's addon
 * order. Kept apart from the hook so that downloads pick by the very same list ("Download the
 * best source", "Download season"): what gets saved is what would have played.
 */
export function buildAutoCandidates(args: AutoCandidateArgs): ScoredStream[] {
  const { filteredPicker, previousPlayback, sourceEntry, isCached, addons, hasStrongAddon, isTorrentioStream, preferredLangs, hostSource, season, episode } = args;
  if (!filteredPicker) return [];
  const key = (s: ScoredStream) => s.url ?? s.infoHash ?? `${s.addonId}:${s.title ?? ""}`;
  const instantTier = (s: ScoredStream) => (isCached(s) ? 0 : 1);
  // The file names the wanted episode (a double episode S01E01-E02 counts for both).
  const episodeExact = (s: ScoredStream) =>
    episode != null &&
    s.episode != null &&
    (season != null && s.season != null
      ? episodeSpanContains(s, season, episode)
      : s.episode === episode);
  // A season pack plays, but the right file has to be found inside it and it can stall
  // on a part that is not there yet, so when a single-episode source is on offer it goes
  // first. Only the order changes: a pack is still tried when nothing else is left.
  const isLikelyPack = (s: ScoredStream) => {
    if (episode == null) return false;
    if (s.seasonPack) return true;
    if (episodeExact(s)) return false;
    return s.size != null && s.size > LIKELY_PACK_BYTES;
  };
  const addonRank = new Map<string, number>();
  (addons ?? []).forEach((a, i) => {
    if (a.manifest?.id) addonRank.set(a.manifest.id, i);
  });
  const matchScores = hostSource ? buildMatchScores(filteredPicker.all, hostSource) : null;
  const previousMatch = previousPlayback
    ? filteredPicker.all.find((s) => streamMatchesEntry(s, previousPlayback)) ?? null
    : null;
  const sorted = filteredPicker.all.slice().sort((a, b) => {
    if (matchScores) {
      const dm = (matchScores.get(b) ?? 0) - (matchScores.get(a) ?? 0);
      if (dm !== 0) return dm;
    }
    const aw = isWatchHub(a) ? 1 : 0;
    const bw = isWatchHub(b) ? 1 : 0;
    if (aw !== bw) return aw - bw;
    const ai0 = instantTier(a);
    const bi0 = instantTier(b);
    if (ai0 !== bi0) return ai0 - bi0;
    const ap = isLikelyPack(a) ? 1 : 0;
    const bp = isLikelyPack(b) ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const ad = needsDownload(a) ? 1 : 0;
    const bd = needsDownload(b) ? 1 : 0;
    if (ad !== bd) return ad - bd;
    if (hasStrongAddon) {
      const at = isTorrentioStream(a) ? 1 : 0;
      const bt = isTorrentioStream(b) ? 1 : 0;
      if (at !== bt) return at - bt;
    }
    if (preferredLangs.length > 0) {
      const al = streamMatchesLangs(a, preferredLangs) ? 0 : 1;
      const bl = streamMatchesLangs(b, preferredLangs) ? 0 : 1;
      if (al !== bl) return al - bl;
    }
    const ar = addonRank.get(a.addonId) ?? 9999;
    const br = addonRank.get(b.addonId) ?? 9999;
    if (ar !== br) return ar - br;
    const ai = hasInstantMarker(a) ? 1 : 0;
    const bi = hasInstantMarker(b) ? 1 : 0;
    if (ai !== bi) return bi - ai;
    return 0;
  });
  const out: ScoredStream[] = [];
  const seen = new Set<string>();
  const push = (s: ScoredStream | null | undefined) => {
    if (!s) return;
    if (isStreamDead(s)) return;
    if (isWatchHub(s)) return;
    if (!isCached(s) && !s.url && !engineP2pEligible(s)) return;
    const k = key(s);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  // "Keep the same source for the next episode". The source of the last episode played is
  // looked for among this episode's results, strictest test first:
  //   1. the same release: same torrent (a season pack), same binge group, or the same
  //      release group, and never at another resolution or in another dub;
  //   2. failing that, the same addon at the same resolution and dub;
  //   3. failing that, the best source at the resolution that was picked.
  // Only sources that start at once are put ahead of the normal order: jumping to a
  // "same" source that first has to download would be worse than a different one.
  const instantPlayable = (s: ScoredStream | null) => !!s && (isCached(s) || !!s.url);
  const eligible = sourceEntry
    ? filteredPicker.all.filter((s) => !isStreamDead(s) && !isWatchHub(s) && (isCached(s) || !!s.url))
    : [];
  const sourceMatch = sourceEntry
    ? findPreferredSourceMatch(eligible, sourceEntry, streamMatchesPreferredSource)
    : null;
  const fallbackSourceMatch = sourceEntry
    ? findPreferredSourceMatch(eligible, sourceEntry, streamMatchesPreferredSourceFallback)
    : null;
  const preferredQuality = sourceEntry?.resolution
    ? (filteredPicker.all.find(
        (s) =>
          s.resolution === sourceEntry.resolution &&
          (!sourceEntry.addonId || streamOfferedByAddon(s, sourceEntry.addonId)),
      ) ??
      filteredPicker.all.find((s) => s.resolution === sourceEntry.resolution) ??
      null)
    : null;
  if (!matchScores) {
    if (instantPlayable(sourceMatch)) push(sourceMatch);
    push(previousMatch);
    if (instantPlayable(fallbackSourceMatch)) push(fallbackSourceMatch);
    if (instantPlayable(preferredQuality)) push(preferredQuality);
  }
  for (const s of sorted) push(s);
  return out;
}

/** A source that starts at once: an addon's own link (unless it says it isn't cached), or a
 *  torrent one of the user's debrid services already holds. */
export function instantSource(s: ScoredStream, debrids: DebridStore[]): boolean {
  return (
    (s.url != null && !s.infoHash && !hasUncachedMarker(s)) ||
    debrids.some((d) => s.cached[d.slug] === true || s.inLibrary[d.slug] === true)
  );
}

/** The languages a pick is steered towards: the preferred languages and audio languages from
 *  Settings, each once. Japanese is added for anime and left out for everything else. */
export function autoPreferredLangs(preferredLanguages: string[], preferredAudioLangs: string[], isAnime: boolean): string[] {
  const all = [...preferredLanguages, ...preferredAudioLangs, ...(isAnime ? ["Japanese"] : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lang of all) {
    const code = normalizeLangCode(lang);
    if (!isAnime && code === "ja") continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(lang);
  }
  return out;
}
