import { useEffect, useMemo, useState } from "react";
import type { Meta } from "../cinemeta";
import type { Chapter } from "../player/bridge";
import { aniZipByKitsu } from "../providers/anizip";
import type { PlayEpisode } from "../view";
import { fetchAniSkipSegments, kitsuToMal } from "./aniskip";
import { chaptersToSegments } from "./chapters";
import { fetchIntroDbAppSegments } from "./introdb-app";
import { fetchSkipDbSegments } from "./skipdb";
import { fetchIntroDbSegments, setTheIntroDbApiKey } from "./theintrodb";
import type { SkipSegment } from "./types";
import { useSettings } from "../settings";

export type { SkipSegment, SkipKind, SkipSource } from "./types";

const MIN_OUTRO_START_FRACTION = 0.5;
// Nothing we skip is longer than six minutes. A longer span is a bad submission (or a
// whole act marked as "credits") and skipping it would throw away real content.
const MAX_SEGMENT_SEC = 360;

function parseKitsuId(id: string): number | null {
  if (!id.startsWith("kitsu:")) return null;
  const n = parseInt(id.slice("kitsu:".length).split(":")[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Every source contributes: a segment is kept unless an earlier (more trusted) source
 *  already covers part of the same stretch. So AniSkip's opening wins over TheIntroDB's
 *  opening, while a recap only TheIntroDB knows about is still added. */
export function mergeSegments(sourcesInPriority: SkipSegment[][]): SkipSegment[] {
  const merged: SkipSegment[] = [];
  for (const list of sourcesInPriority) {
    if (!list) continue;
    for (const segment of list) {
      const hasOverlap = merged.some(
        (existing) => segment.startSec < existing.endSec && segment.endSec > existing.startSec,
      );
      if (!hasOverlap) merged.push(segment);
    }
  }
  return merged.sort((a, b) => a.startSec - b.startSec);
}

/** What AniZip knows about one episode of a Kitsu title: the show's IMDb id and where
 *  that episode sits in IMDb-style season/episode numbering. Tagged with the title and
 *  episode it was resolved for so a stale answer is never applied to the next episode. */
type AnimeIds = {
  kitsuId: number;
  epNum: number | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
};

export function useSkipSegments(
  meta: Meta,
  episode: PlayEpisode | undefined,
  chapters: Chapter[],
  durationSec: number,
): SkipSegment[] {
  const [aniSkip, setAniSkip] = useState<SkipSegment[]>([]);
  const [introDb, setIntroDb] = useState<SkipSegment[]>([]);
  const [skipDb, setSkipDb] = useState<SkipSegment[]>([]);
  const [introDbApp, setIntroDbApp] = useState<SkipSegment[]>([]);
  const [animeIds, setAnimeIds] = useState<AnimeIds | null>(null);
  const { settings } = useSettings();
  // Settings > Privacy: the online lookups send the title's id to the skip-time services
  // (AniSkip, SkipDB, TheIntroDB, introdb.app, and AniZip for the id mapping). With the
  // switch off nothing below leaves the device and only the file's own chapters are used.
  const lookups = settings.skipLookups !== false;
  const theIntroDbKey = typeof settings.theIntroDbKey === "string" ? settings.theIntroDbKey.trim() : "";
  const kitsuId = parseKitsuId(meta.id);
  const epNum = episode?.episode;
  const episodeImdbId = episode?.imdbId && episode.imdbId.startsWith("tt") ? episode.imdbId : null;

  // A Kitsu title has no IMDb id of its own, and the IMDb-keyed services cannot be asked
  // without one. The detail page usually stamps it on the episode already; when it did not
  // (a Kitsu film, or an episode opened from Continue Watching) ask AniZip for the mapping.
  useEffect(() => {
    setAnimeIds(null);
    if (!lookups || kitsuId == null || episodeImdbId) return;
    let cancelled = false;
    aniZipByKitsu(kitsuId)
      .then((az) => {
        if (cancelled || !az) return;
        const imdb = az.mappings?.imdb_id;
        const azEp = epNum != null ? az.episodes?.[String(epNum)] : undefined;
        const mapped =
          azEp && azEp.seasonNumber != null && azEp.seasonNumber > 0 && azEp.episodeNumber != null;
        setAnimeIds({
          kitsuId,
          epNum: epNum ?? null,
          imdbId: typeof imdb === "string" && imdb.startsWith("tt") ? imdb : null,
          season: mapped ? (azEp.seasonNumber as number) : null,
          episode: mapped ? azEp.episodeNumber : null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kitsuId, epNum, episodeImdbId, lookups]);
  const anime =
    animeIds && animeIds.kitsuId === kitsuId && animeIds.epNum === (epNum ?? null) ? animeIds : null;

  // Kitsu numbers a later season as its own show starting again at episode 1, so a Kitsu
  // "episode 3" is not IMDb's S01E03. When the IMDb id came from AniZip, only AniZip's own
  // season/episode for that episode is trusted; without one the IMDb-keyed services are
  // not asked about this episode at all (wrong skip times are worse than none).
  const viaAniZip = !meta.id.startsWith("tt") && !meta.id.startsWith("tmdb:") && !episodeImdbId;
  const introSeason = viaAniZip
    ? (episode?.imdbSeason ?? anime?.season ?? undefined)
    : (episode?.imdbSeason ?? episode?.season);
  const introEpisode = viaAniZip
    ? (episode?.imdbEpisode ?? anime?.episode ?? undefined)
    : (episode?.imdbEpisode ?? episode?.episode);
  const numberingKnown = !episode || (introSeason != null && introEpisode != null);
  const resolvedImdbId = viaAniZip && numberingKnown ? (anime?.imdbId ?? null) : null;

  const introDbId =
    meta.id.startsWith("tt") || meta.id.startsWith("tmdb:")
      ? meta.id
      : (episodeImdbId ?? resolvedImdbId ?? meta.id);
  // SkipDB and introdb.app only understand IMDb ids.
  const skipImdbId = meta.id.startsWith("tt") ? meta.id : (episodeImdbId ?? resolvedImdbId);

  useEffect(() => {
    setTheIntroDbApiKey(theIntroDbKey);
  }, [theIntroDbKey]);

  useEffect(() => {
    setAniSkip([]);
    // Wait for the real length: AniSkip keeps separate times per cut of an episode.
    if (!lookups || kitsuId == null || epNum == null || durationSec <= 0) return;
    let cancelled = false;
    (async () => {
      let malId = await kitsuToMal(kitsuId);
      // Kitsu's own mapping table has gaps; AniZip often still knows the MAL id.
      if (malId == null) malId = (await aniZipByKitsu(kitsuId))?.mappings?.mal_id ?? null;
      if (cancelled || malId == null) return;
      const segs = await fetchAniSkipSegments(malId, epNum, durationSec);
      if (cancelled) return;
      setAniSkip(segs);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kitsuId, epNum, durationSec, lookups]);

  useEffect(() => {
    setIntroDb([]);
    if (!lookups || durationSec <= 0) return;
    if (!introDbId.startsWith("tmdb:") && !introDbId.startsWith("tt")) return;
    let cancelled = false;
    const ep =
      introSeason != null && introEpisode != null
        ? { season: introSeason, episode: introEpisode }
        : undefined;
    fetchIntroDbSegments(introDbId, ep, durationSec)
      .then((segs) => {
        if (!cancelled) setIntroDb(segs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [introDbId, introSeason, introEpisode, durationSec, lookups, theIntroDbKey]);

  useEffect(() => {
    setSkipDb([]);
    if (!lookups || !skipImdbId || durationSec <= 0) return;
    let cancelled = false;
    const ep =
      introSeason != null && introEpisode != null
        ? { season: introSeason, episode: introEpisode }
        : undefined;
    fetchSkipDbSegments(skipImdbId, ep, durationSec)
      .then((segs) => {
        if (!cancelled) setSkipDb(segs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [skipImdbId, introSeason, introEpisode, durationSec, lookups]);

  useEffect(() => {
    setIntroDbApp([]);
    // introdb.app only has episodes, never films.
    if (!lookups || !skipImdbId || introSeason == null || introEpisode == null) return;
    let cancelled = false;
    fetchIntroDbAppSegments(skipImdbId, { season: introSeason, episode: introEpisode })
      .then((segs) => {
        if (!cancelled) setIntroDbApp(segs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [skipImdbId, introSeason, introEpisode, lookups]);

  const fromChapters = useMemo(
    () => chaptersToSegments(chapters, durationSec),
    [chapters, durationSec],
  );

  return useMemo(() => {
    // Most trusted first: AniSkip is per-release for anime, SkipDB is matched to this
    // file's length, then the two community databases, and the file's chapters fill
    // whatever is still uncovered.
    const base = mergeSegments([aniSkip, skipDb, introDb, introDbApp, fromChapters]);
    if (durationSec <= 0) return base;
    const minOutroStart = durationSec * MIN_OUTRO_START_FRACTION;
    return base
      .filter((s) => s.startSec < durationSec)
      .map((s) => (s.endSec > durationSec ? { ...s, endSec: durationSec } : s))
      .filter((s) => {
        const len = s.endSec - s.startSec;
        return len >= 2 && len <= MAX_SEGMENT_SEC;
      })
      .filter((s) => s.kind !== "outro" || s.startSec >= minOutroStart);
  }, [aniSkip, skipDb, introDb, introDbApp, fromChapters, durationSec]);
}

export function activeSegment(
  segments: SkipSegment[],
  positionSec: number,
): SkipSegment | null {
  for (const s of segments) {
    if (positionSec >= s.startSec && positionSec < s.endSec - 0.75) return s;
  }
  return null;
}
