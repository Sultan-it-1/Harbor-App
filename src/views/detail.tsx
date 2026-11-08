import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Pencil, Play, Plus, RotateCcw, Star } from "lucide-react";
import { animeDetails, franchiseTags, type FranchiseEntry } from "@/lib/providers/anime-detail";
import { imdbToKitsu, tmdbTvToKitsu } from "@/lib/providers/anime-mapping";
import { stripFranchiseSuffix } from "@/lib/providers/jikan";
import type { KitsuEpisode, KitsuStreamer } from "@/lib/providers/kitsu";
import { AnimeAwardsBlock } from "@/components/anime-awards-block";
import { AwardsBlock, TYPE_ORDER as AWARD_TYPE_ORDER, TYPE_TITLE as AWARD_TYPE_TITLE } from "@/components/awards-block";
import { BackToTop } from "@/components/back-to-top";
import { PickCard } from "@/components/pick-card";
import { Row } from "@/components/row";
import { meta as fetchCinemetaMeta, narrowMediaType, isAddonNativeMeta, type Meta } from "@/lib/cinemeta";
import { fetchAddonMeta } from "@/lib/addons";
import { resolveMeta } from "@/lib/meta-resource";
import { useMdblistScores } from "@/lib/providers/mdblist";
import { lastPlayedEpisode, readResumeEntry, saveResumeMs } from "@/lib/resume";
import { omdbPrefetch, omdbScores, type OmdbScores } from "@/lib/providers/omdb";
import { awardSummary, useAwards } from "@/lib/providers/wikidata";
import { mergeBundledAwards } from "@/lib/awards-history";
import {
  tmdbDetails,
  tmdbImdbId,
  tmdbWatchProviders,
  type TmdbDetail,
  type WatchProvider,
  tmdbCollection,
} from "@/lib/providers/tmdb";
import { cinemetaDetails } from "@/lib/providers/cinemeta-details";
import { useAuth } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import { CLOUD_OK, episodeFromVideoId, libraryGetOne, type LibraryItem } from "@/lib/stremio";
import { decodeWatchedEpisodes } from "@/lib/stremio-watched";
import { useTogether } from "@/lib/together/provider";
import { useTrakt } from "@/lib/trakt/provider";
import { toggleWatchlist, useInWatchlist } from "@/lib/watchlist";
import { markMovieWatched } from "@/lib/mark-watched";
import { recordSeriesTotal, useIsWatched } from "@/lib/watched-marks";
import { useIsFavorite, useMediaFavorites } from "@/lib/media-favorites";
import { openUrl } from "@/lib/window";
import { profileFromDetail, trackEvent } from "@/lib/discover";
import { MOVIE_GENRES, TV_GENRES } from "@/lib/feed/tags";
import { useScrollMemory, useView } from "@/lib/view";
import { useT } from "@/lib/i18n";
import { AddToSimklButton } from "./detail/add-to-simkl-button";
import { CollectionRow } from "./detail/collection-row";
import { MediaGallery } from "./detail/media-gallery";
import { useTitleBackdrop } from "@/lib/title-backdrop";
import { ContentRails, type DetailSection } from "./detail/content-rails";
import {
  loadDetailCustomization,
  saveDetailCustomization,
  moveSection,
  toggleSectionHidden,
  resetDetailCustomization,
  orderedSectionKeys,
  type DetailCustomization,
} from "@/lib/detail-customization";
import { useNativeBrowsePage, useNativeScreensEnabled, type NativeRowInput } from "@/views/native/native-screens";
import { NativeRowSinkContext, useNativeRowSink } from "@/views/native/native-sink";
import { EpisodeDownloadButton } from "./detail/episode-download-button";
import { isTitleUpcoming } from "./detail/helpers";
import { HeroAwardsCorner } from "./detail/hero-awards";
import { CrunchyrollAwardsCorner } from "./detail/crunchyroll-corner";
import { findAnyAwardWins, parseAwardYear } from "@/lib/anime-awards";

function animeAwardLookupName(
  releaseYear: number | undefined,
  ...candidates: (string | null | undefined)[]
): string | null {
  for (const c of candidates) {
    if (!c) continue;
    if (findAnyAwardWins(c, releaseYear).length > 0) return c;
  }
  return null;
}
import { Pill } from "./detail/pill";
import { Credit } from "./detail/credit";
import { TitlePlate } from "./detail/title-plate";
import { PlayModeHint } from "./detail/play-mode-hint";
import { UpcomingCta, upcomingDateLabel } from "./detail/upcoming-cta";
import { Synopsis } from "./detail/synopsis";
import { CastCard } from "./detail/cast-card";
import { PreviewIcon } from "./detail/preview-icon";
import { HeroActionOverflow, useHeroActionItems, useHeroActionOverflow } from "./detail/hero-action-overflow";
import { HeroRatings } from "./detail/hero-ratings";
import { TrailerOverlay } from "./detail/trailer-overlay";
import { DetailHeroTrailer } from "./detail/detail-hero-trailer";
import { SeriesEpisodes } from "./detail/series-episodes";
import { CinemetaEpisodes } from "./detail/cinemeta-episodes";
import { AnimeEpisodes } from "./detail/anime-episodes";
import { EpisodeGridSkeleton } from "./detail/episode-grid-skeleton";
import { StreamingLinks } from "./detail/streaming-links";
import { WatchOn } from "./detail/watch-on";
import { animeStreamerInfo } from "@/lib/providers/anime-streamer";
import { InfoBlock } from "./detail/info-block";
import { TraktComments } from "./detail/trakt-comments";
import { stremioIdToTraktTarget } from "@/lib/trakt/ids";
import type { IdResolution } from "@/lib/trakt/ids";

function HeroBackdrop({ url }: { url: string }) {
  const lowUrl = url.replace(/\/t\/p\/(w\d+|original)\//, "/t/p/w300/");
  const highUrl = url.replace(/\/t\/p\/(w\d+|original)\//, "/t/p/original/");
  const canBlurUp = lowUrl !== highUrl;
  const [ready, setReady] = useState(false);
  return (
    <>
      {canBlurUp && (
        <img
          src={lowUrl}
          alt=""
          aria-hidden="true"
          decoding="async"
          className="absolute inset-0 h-full w-full scale-105 object-cover blur-2xl"
        />
      )}
      <img
        src={highUrl}
        alt=""
        decoding="async"
        fetchPriority="high"
        ref={(el) => {
          if (el?.complete) setReady(true);
        }}
        onLoad={() => setReady(true)}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${ready ? "opacity-100" : "opacity-0"}`}
      />
    </>
  );
}

if (typeof document !== "undefined") {
  const __id = "harbor-fade-in-up-style";
  if (!document.getElementById(__id)) {
    const __el = document.createElement("style");
    __el.id = __id;
    __el.textContent =
      "@keyframes harborFadeInUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.harbor-fade-in-up{animation:harborFadeInUp .4s ease-out both}";
    document.head.appendChild(__el);
  }
}

function FadeInUp({ children }: { children: ReactNode }) {
  return <div className="harbor-fade-in-up">{children}</div>;
}

export function DetailView({
  meta,
  liveContext = false,
  episodeHint,
}: {
  meta: Meta;
  liveContext?: boolean;
  episodeHint?: { season: number; episode: number };
}) {
  const t = useT();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [detail, setDetail] = useState<TmdbDetail | null>(null);
  const [animeEpisodes, setAnimeEpisodes] = useState<KitsuEpisode[]>([]);
  const [franchise, setFranchise] = useState<FranchiseEntry[]>([]);
  const [animeCanonicalId, setAnimeCanonicalId] = useState<string | null>(null);
  const [detectedKitsu, setDetectedKitsu] = useState<number | null>(null);
  const [detectingAnime, setDetectingAnime] = useState(false);
  const failedKitsu = useRef<number | null>(null);
  const [streamers, setStreamers] = useState<KitsuStreamer[]>([]);
  const [backdrops, setBackdrops] = useState<string[]>([]);
  const [backdropIdx, setBackdropIdx] = useState(0);
  const pinnedBackdrop = useTitleBackdrop(meta.id);
  const pinnedBackdropHi = pinnedBackdrop
    ? pinnedBackdrop.replace(/\/t\/p\/w\d+\//, "/t/p/original/")
    : undefined;
  const [cinemetaFull, setCinemetaFull] = useState<Meta | null>(
    meta.videos && meta.videos.length > 0 ? meta : null,
  );
  const [libraryItem, setLibraryItem] = useState<LibraryItem | null>(null);
  const { authKey } = useAuth();
  const [loading, setLoading] = useState(true);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [watchedMark, setWatchedMark] = useState(false);
  // Already watched (Harbor's history, your Stremio library or Trakt): the button shows it.
  const alreadyWatched = useIsWatched(meta.id, [detail?.imdbId]);
  const isWatchedNow = watchedMark || alreadyWatched;
  const [layout, setLayout] = useState<DetailCustomization>(loadDetailCustomization);
  const [layoutEdit, setLayoutEdit] = useState(false);
  const [scores, setScores] = useState<OmdbScores | null>(null);
  const [cinemetaRating, setCinemetaRating] = useState<string | null>(null);
  const [watchProviders, setWatchProviders] = useState<WatchProvider[]>([]);
  const mdblist = useMdblistScores(
    settings.mdblistKey,
    detail?.imdbId ?? (meta.id.startsWith("tt") ? meta.id : null),
    meta.type === "movie" ? "movie" : "show",
  );
  const scrollRef = useRef<HTMLElement>(null);

  const { openPicker, openFilter, promoteMetaToRoot } = useView();
  const { snapshot: roomSnapshot, claimHost } = useTogether();
  const { isConnected: traktConnected } = useTrakt();
  const inWatchlist = useInWatchlist(meta.id, [detail?.imdbId]);
  const { toggle: toggleFavorite } = useMediaFavorites();
  const isFav = useIsFavorite(meta.id, [detail?.imdbId]);
  const inSession = roomSnapshot.state === "joined" && roomSnapshot.participants.length >= 2;
  useScrollMemory(`meta:${meta.id}`, scrollRef);
  const idAnime = meta.id.startsWith("kitsu:") || meta.id.startsWith("mal:");
  const isAnime = idAnime || detectedKitsu != null;
  const stickyAwardName = useRef<string | null>(null);
  useEffect(() => {
    stickyAwardName.current = null;
  }, [meta.id]);
  const addonNative = liveContext || isAddonNativeMeta(meta);
  const trailerCandidate =
    detail?.trailerCandidates?.[0] ?? meta.trailerStreams?.[0]?.ytId ?? null;
  const actionRowRef = useRef<HTMLDivElement | null>(null);
  const actionStage = useHeroActionOverflow(actionRowRef, [meta.id]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setAnimeEpisodes([]);
    setFranchise([]);
    setAnimeCanonicalId(null);
    setDetectedKitsu(null);
    setDetectingAnime(false);
    failedKitsu.current = null;
    setStreamers([]);
    setBackdrops([]);
    setBackdropIdx(0);
    setCinemetaFull(meta.videos && meta.videos.length > 0 ? meta : null);
    if (meta.id.startsWith("tt") && !addonNative) {
      fetchCinemetaMeta(narrowMediaType(meta.type), meta.id)
        .then((full) => {
          if (cancelled || !full) return;
          setCinemetaFull(full);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.type, addonNative]);

  useEffect(() => {
    if (idAnime || detectedKitsu != null || addonNative) return;
    const tmdbTv = meta.id.startsWith("tmdb:tv:") ? Number(meta.id.slice(8)) : null;
    const imdb = meta.id.startsWith("tt")
      ? meta.id
      : detail?.imdbId?.startsWith("tt")
        ? detail.imdbId
        : null;
    if (tmdbTv == null && !imdb) return;
    let cancelled = false;
    setDetectingAnime(true);
    (async () => {
      let k = tmdbTv != null && Number.isFinite(tmdbTv) ? await tmdbTvToKitsu(tmdbTv) : null;
      if (k == null && imdb) k = await imdbToKitsu(imdb);
      if (cancelled) return;
      if (k != null && k !== failedKitsu.current) setDetectedKitsu(k);
      setDetectingAnime(false);
    })().catch(() => {
      if (!cancelled) setDetectingAnime(false);
    });
    return () => {
      cancelled = true;
    };
  }, [idAnime, detectedKitsu, addonNative, meta.id, detail?.imdbId]);

  useEffect(() => {
    if (meta.type !== "series") return;
    const imdb =
      meta.id.startsWith("tt") ? meta.id : detail?.imdbId?.startsWith("tt") ? detail.imdbId : null;
    if (!imdb) return;
    if (cinemetaFull?.videos && cinemetaFull.videos.length > 0) return;
    let cancelled = false;
    fetchCinemetaMeta(narrowMediaType(meta.type), imdb)
      .then((full) => {
        if (cancelled || !full) return;
        setCinemetaFull(full);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meta.id, detail?.imdbId, meta.type, cinemetaFull?.videos?.length]);

  useEffect(() => {
    if (meta.type !== "series" && !addonNative) return;
    const base = meta.addonOrigin?.base;
    if (!base) return;
    if (cinemetaFull?.videos && cinemetaFull.videos.length > 0) return;
    let cancelled = false;
    fetchAddonMeta(base, meta.type, meta.id)
      .then((full) => {
        if (cancelled || !full?.videos?.length) return;
        setCinemetaFull(full);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.type, meta.addonOrigin?.base, addonNative, cinemetaFull?.videos?.length]);

  useEffect(() => {
    if (meta.type !== "series") return;
    if (meta.addonOrigin?.base) return;
    if (/^(tt\d|tmdb:|kitsu:|mal:|anilist:|anidb:)/.test(meta.id)) return;
    if (cinemetaFull?.videos && cinemetaFull.videos.length > 0) return;
    let cancelled = false;
    resolveMeta(authKey, narrowMediaType(meta.type), meta.id)
      .then((full) => {
        if (cancelled || !full?.videos?.length) return;
        setCinemetaFull(full);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.type, meta.addonOrigin?.base, authKey, cinemetaFull?.videos?.length]);

  useEffect(() => {
    setLibraryItem(null);
    if (!authKey) return;
    const candidates: string[] = [];
    if (meta.id.startsWith("tt")) candidates.push(meta.id);
    if (detail?.imdbId?.startsWith("tt") && !candidates.includes(detail.imdbId)) {
      candidates.push(detail.imdbId);
    }
    if (!meta.id.startsWith("tt") && CLOUD_OK.test(meta.id)) candidates.push(meta.id);
    if (candidates.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const cid of candidates) {
        const item = await libraryGetOne(authKey, cid).catch(() => null);
        if (cancelled) return;
        if (item) {
          setLibraryItem(item);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authKey, meta.id, detail?.imdbId]);

  const [stremioWatched, setStremioWatched] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    decodeWatchedEpisodes(libraryItem?.state?.watched, cinemetaFull?.videos)
      .then((keys) => {
        if (!cancelled) setStremioWatched(keys);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [libraryItem?.state?.watched, cinemetaFull?.videos]);

  // Learn how many episodes this show has aired, so its poster can tell when you've finished it.
  useEffect(() => {
    if (meta.type !== "series") return;
    const vids = cinemetaFull?.videos;
    if (!vids || vids.length === 0) return;
    const now = Date.now();
    const aired = vids.filter((v) => (v.season ?? 0) >= 1 && (!v.released || Date.parse(v.released) <= now)).length;
    recordSeriesTotal(meta.id, aired);
  }, [meta.id, meta.type, cinemetaFull?.videos]);

  useEffect(() => {
    if (!libraryItem?.state) return;
    const st = libraryItem.state;
    if (!st.timeOffset || st.timeOffset <= 0) return;
    const stremioT = Date.parse(libraryItem._mtime ?? "");
    if (!Number.isFinite(stremioT)) return;
    if (libraryItem.type === "movie") {
      const local = readResumeEntry(meta.id);
      if (!local || stremioT > local.t) {
        saveResumeMs(meta.id, st.timeOffset);
        if (import.meta.env.DEV)
          console.info(`[stremio-resume] movie ${meta.id}: synced ${st.timeOffset}ms from Stremio (mtime=${libraryItem._mtime})`);
      }
      return;
    }
    const se = episodeFromVideoId(st.video_id);
    const season = st.season ?? se?.season;
    const episode = st.episode ?? se?.episode;
    if (!isAnime && libraryItem.type === "series" && season && episode) {
      const local = readResumeEntry(meta.id, season, episode);
      if (!local || stremioT > local.t) {
        saveResumeMs(meta.id, st.timeOffset, season, episode);
        if (import.meta.env.DEV)
          console.info(`[stremio-resume] series ${meta.id} S${season}E${episode}: synced ${st.timeOffset}ms from Stremio (mtime=${libraryItem._mtime})`);
      }
    }
  }, [libraryItem, meta.id, isAnime]);

  useEffect(() => {
    let cancelled = false;
    if (addonNative) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const work = isAnime
      ? animeDetails(settingsRef.current, detectedKitsu != null ? { ...meta, id: `kitsu:${detectedKitsu}` } : meta).then((res) => {
          if (cancelled) return null;
          if (!res) {
            if (detectedKitsu != null) {
              failedKitsu.current = detectedKitsu;
              setDetectedKitsu(null);
            }
            return null;
          }
          setAnimeEpisodes(res.episodes);
          setFranchise(res.franchise);
          setAnimeCanonicalId(`kitsu:${res.kitsuId}`);
          setStreamers(res.streamers);
          setBackdrops(res.backdrops);
          return res.detail;
        })
      : settingsRef.current.tmdbKey
        ? tmdbDetails(settingsRef.current.tmdbKey, meta).then((d) =>
            d ?? cinemetaDetails(meta),
          )
        : cinemetaDetails(meta);
    work
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    meta.id,
    meta.type,
    settings.tmdbKey,
    settings.fanartKey,
    settings.tvdbKey,
    settings.tmdbLanguage,
    isAnime,
    addonNative,
    detectedKitsu,
  ]);

  useEffect(() => {
    if (!detail) return;
    const profile = profileFromDetail(detail);
    trackEvent(meta.id, "open", profile);
    const t = setTimeout(() => trackEvent(meta.id, "dwell", profile), 8000);
    return () => clearTimeout(t);
  }, [detail, meta.id]);

  useEffect(() => {
    setScores(null);
    const imdbId = detail?.imdbId ?? (meta.id.startsWith("tt") ? meta.id : null);
    if (!imdbId || !settings.omdbKey) return;
    let cancelled = false;
    omdbScores(settings.omdbKey, imdbId).then((s) => {
      if (!cancelled) setScores(s);
    });
    return () => {
      cancelled = true;
    };
  }, [detail?.imdbId, meta.id, settings.omdbKey]);

  useEffect(() => {
    setCinemetaRating(null);
    if (meta.id.startsWith("tt")) return;
    const imdb = detail?.imdbId;
    if (!imdb || !imdb.startsWith("tt")) return;
    let cancelled = false;
    fetchCinemetaMeta(narrowMediaType(meta.type), imdb)
      .then((full) => {
        if (!cancelled && full?.imdbRating) setCinemetaRating(full.imdbRating);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.type, detail?.imdbId]);

  useEffect(() => {
    if (!settings.omdbKey || !detail) return;
    const queue = [...detail.recommendations.slice(0, 6), ...detail.similar.slice(0, 6)];
    for (const m of queue) {
      tmdbImdbId(settings.tmdbKey, m.id).then((id) => {
        if (id) omdbPrefetch(settings.omdbKey, id);
      });
    }
  }, [detail, settings.tmdbKey, settings.omdbKey]);

  useEffect(() => {
    if (backdrops.length < 2) return;
    const id = window.setInterval(() => {
      setBackdropIdx((i) => (i + 1) % backdrops.length);
    }, 12000);
    return () => window.clearInterval(id);
  }, [backdrops]);

  useEffect(() => {
    setWatchProviders([]);
    if (isAnime || !settings.tmdbKey || !detail) return;
    const k = detail.kind;
    if ((k !== "movie" && k !== "tv") || !Number.isFinite(Number(detail.id))) return;
    let cancelled = false;
    tmdbWatchProviders(settings.tmdbKey, k, detail.id, settings.region)
      .then((p) => {
        if (!cancelled) setWatchProviders(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [detail, isAnime, settings.tmdbKey, settings.region]);

  const rawTitle = detail?.title ?? meta.name;
  const title = isAnime ? stripFranchiseSuffix(rawTitle) : rawTitle;
  const overview = detail?.overview ?? meta.description ?? "";
  const tagline = detail?.tagline ?? "";
  const backdrop =
    pinnedBackdropHi || backdrops[backdropIdx] || meta.background || detail?.backdrop || (loading ? undefined : meta.poster) || undefined;
  const logo = loading ? detail?.logo : (detail?.logo || meta.logo);
  const year = detail?.year ?? meta.releaseInfo;
  const releaseYearNum = parseAwardYear(year);
  const imdbRatingValue =
    scores?.imdbRating ?? cinemetaRating ?? (meta.id.startsWith("tt") ? meta.imdbRating : undefined);
  const rating = imdbRatingValue ?? detail?.rating ?? meta.imdbRating;
  const runtime = detail?.runtime;
  const genres = detail?.genres ?? meta.genres ?? [];
  const recommendations = detail?.recommendations ?? [];
  const similar = detail?.similar ?? [];
  const liveAwards = useAwards(detail?.imdbId ?? undefined);
  const awards = useMemo(
    () => mergeBundledAwards(liveAwards, meta.name, releaseYearNum ?? undefined),
    [liveAwards, meta.name, releaseYearNum],
  );
  const heroAwardSummary = awardSummary(awards).slice(0, 2);
  const isSeries = detail?.kind != null
    ? detail.kind === "tv"
    : meta.type === "series";
  const traktResolution = useMemo((): IdResolution => {
    if (isAnime) return { ok: false, reason: "anime" };
    const imdbId = detail?.imdbId ?? (meta.id.startsWith("tt") ? meta.id : null);
    const tmdbId = detail?.id;
    if (isSeries && (imdbId || (tmdbId && detail?.kind === "tv"))) {
      const ids: Record<string, string | number> = {};
      if (imdbId) ids.imdb = imdbId;
      if (tmdbId) ids.tmdb = tmdbId;
      return { ok: true, target: { kind: "show", ids } } as IdResolution;
    }
    if (!isSeries && (imdbId || tmdbId)) {
      const ids: Record<string, string | number> = {};
      if (imdbId) ids.imdb = imdbId;
      if (tmdbId) ids.tmdb = tmdbId;
      return { ok: true, target: { kind: "movie", ids } } as IdResolution;
    }
    return stremioIdToTraktTarget(meta.id);
  }, [meta.id, isSeries, isAnime, detail?.imdbId, detail?.id, detail?.kind]);
  const playMeta: Meta = {
    ...meta,
    name: title,
    logo,
    background: backdrop,
    releaseDate: detail?.releaseDate ?? meta.releaseDate,
    releaseInfo: detail?.year ?? meta.releaseInfo,
    behaviorHints: meta.behaviorHints ?? cinemetaFull?.behaviorHints,
    videos: meta.videos ?? cinemetaFull?.videos,
  };
  const upcoming = !loading && isTitleUpcoming(detail, meta);
  const currentFranchiseId = animeCanonicalId ?? meta.id;
  const franchiseIdx = isAnime
    ? franchise.findIndex((f) => f.meta.id === currentFranchiseId)
    : -1;
  const showSeasonPill = isAnime && franchise.length > 1 && franchiseIdx >= 0;
  const seasonPillTags = showSeasonPill ? franchiseTags(franchise) : [];
  const seasonPillCount = seasonPillTags.filter((tag) => tag.kind === "season").length;
  const seasonPillTag = seasonPillTags[franchiseIdx];
  const seasonPillLabel = !seasonPillTag
    ? ""
    : seasonPillTag.kind === "movie"
      ? t("Movie")
      : seasonPillCount > 1
        ? t("Season {n} of {m}", { n: seasonPillTag.seasonNum, m: seasonPillCount })
        : t("Season {n}", { n: seasonPillTag.seasonNum });

  const lastPlay = useMemo(() => {
    if (episodeHint) return episodeHint;
    const st = libraryItem?.state;
    if (!isAnime && libraryItem?.type === "series" && st && (st.timeOffset ?? 0) > 0) {
      const se = episodeFromVideoId(st.video_id);
      const season = st.season ?? se?.season;
      const episode = st.episode ?? se?.episode;
      if (
        typeof season === "number" &&
        typeof episode === "number" &&
        season >= 1 &&
        episode >= 1
      ) {
        return { season, episode };
      }
    }
    return lastPlayedEpisode(meta.id);
  }, [meta.id, libraryItem, isAnime, episodeHint]);
  const smartPlay = useCallback(async (forcePicker = false) => {
    if (inSession) claimHost(true);
    if (!isSeries) {
      openPicker(playMeta, undefined, { autoPlay: !forcePicker && settings.instantPlay, resume: !forcePicker && settings.instantPlay });
      return;
    }
    if (isAnime) {
      const wantedEp = lastPlay
        ? animeEpisodes.find(
            (e) => (e.seasonNumber || 1) === lastPlay.season && e.number === lastPlay.episode,
          )
        : animeEpisodes[0];
      if (wantedEp) {
        openPicker(
          playMeta,
          {
            season: wantedEp.seasonNumber || 1,
            episode: wantedEp.number,
            name: wantedEp.title,
            still: wantedEp.thumbnail ?? undefined,
            overview: wantedEp.synopsis || undefined,
            kitsuStreamId: wantedEp.streamId,
            imdbId: wantedEp.imdbId,
            imdbSeason: wantedEp.imdbSeason,
            imdbEpisode: wantedEp.imdbEpisode,
          },
          { autoPlay: !forcePicker && settings.instantPlay, resume: !forcePicker && settings.instantPlay },
        );
        return;
      }
      openPicker(playMeta, undefined, { autoPlay: !forcePicker && settings.instantPlay, resume: !forcePicker && settings.instantPlay });
      return;
    }
    if (lastPlay) {
      openPicker(
        playMeta,
        { season: lastPlay.season, episode: lastPlay.episode },
        { autoPlay: !forcePicker && settings.instantPlay, resume: !forcePicker && settings.instantPlay },
      );
      return;
    }
    if (authKey) {
      const candidates: string[] = [];
      if (meta.id.startsWith("tt")) candidates.push(meta.id);
      if (detail?.imdbId?.startsWith("tt") && !candidates.includes(detail.imdbId)) {
        candidates.push(detail.imdbId);
      }
      if (!meta.id.startsWith("tt") && CLOUD_OK.test(meta.id)) candidates.push(meta.id);
      for (const cid of candidates) {
        const item = await libraryGetOne(authKey, cid).catch(() => null);
        const st = item?.state;
        if (st && (st.timeOffset ?? 0) > 0) {
          const se = episodeFromVideoId(st.video_id);
          const season = st.season ?? se?.season;
          const episode = st.episode ?? se?.episode;
          if (
            typeof season === "number" &&
            typeof episode === "number" &&
            season >= 1 &&
            episode >= 1
          ) {
            openPicker(playMeta, { season, episode }, { autoPlay: !forcePicker && settings.instantPlay, resume: !forcePicker && settings.instantPlay });
            return;
          }
        }
        if (item) break;
      }
    }
    openPicker(playMeta, { season: 1, episode: 1 }, { autoPlay: !forcePicker && settings.instantPlay, resume: !forcePicker && settings.instantPlay });
  }, [isSeries, isAnime, animeEpisodes, lastPlay, openPicker, playMeta, settings.instantPlay, inSession, claimHost, authKey, meta.id, detail?.imdbId]);
  const smartPlayLabel = inSession && !liveContext
    ? t("Play Together")
    : isSeries && lastPlay
      ? t("Resume S{s}:E{e}", { s: lastPlay.season, e: lastPlay.episode })
      : t("Play");


  // Android, a film: drawn natively (see @/views/native/native-screens) like the page: the hero
  // (backdrop, tagline, logo, year / ratings / runtime / genres, Play and "…", which opens the
  // page's own menu: watchlist, favourite, trailer, download, Trakt…), the synopsis, then the
  // sections in the page's order (crew, cast, collection, more like this, you might also like,
  // media, information). Series, anime and live channels keep the page for now (their episode
  // lists, downloads and seasons).
  const { topKind, openPerson, openCollection } = useView();
  const nativeOn = useNativeScreensEnabled();
  // Series too (their episode list hands its row over, native-sink): TMDB's seasons, or the
  // addon's / Cinemeta's videos when TMDB has none. Live channels keep the page for now.
  // A live channel's page (opened from Live TV) too: its picture, name and line, Play and "Open
  // in TV Shows / Movies" as on the page.
  const nativeBlocked =
    (meta.type !== "movie" && meta.type !== "series" && meta.type !== "anime" && !addonNative) ||
    layoutEdit;
  const [episodesSink, episodesRows] = useNativeRowSink(nativeOn && !nativeBlocked);
  const showEpisodes = !!detail && !isAnime && isSeries && detail.seasons.length > 0;
  const cinemetaVideos = cinemetaFull?.videos;
  const showCinemetaEpisodes =
    !liveContext &&
    (!detail || detail.seasons.length === 0) &&
    !isAnime &&
    (isSeries || (addonNative && (meta.type === "channel" || meta.type === "tv"))) &&
    !!cinemetaVideos &&
    (addonNative ? cinemetaVideos.length > 0 : cinemetaVideos.some((v) => v.season != null && v.season > 0 && v.episode != null));
  // Anime: its own episode list (the franchise's parts, Kitsu episodes), handed over the same way.
  const showAnimeEpisodes = !!detail && isAnime && (animeEpisodes.length > 1 || franchise.length > 1);
  const [awardsOpen, setAwardsOpen] = useState(false);
  useEffect(() => setAwardsOpen(false), [meta.id]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  useEffect(() => setCommentsOpen(false), [meta.id]);
  const [collectionParts, setCollectionParts] = useState<Meta[]>([]);
  const collectionId = detail?.collection?.id;
  useEffect(() => {
    setCollectionParts([]);
    if (!nativeOn || nativeBlocked || !collectionId || !settings.tmdbKey) return;
    let off = false;
    tmdbCollection(settings.tmdbKey, collectionId)
      .then((c) => !off && setCollectionParts(c?.parts ?? []))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [nativeOn, nativeBlocked, collectionId, settings.tmdbKey]);
  const nativeDetail = useMemo(() => {
    const pills: Array<{ id: string; label: string; kind: string }> = [];
    if (year) pills.push({ id: "year", label: String(year), kind: "pill" });
    if (showSeasonPill && seasonPillLabel) pills.push({ id: "season", label: seasonPillLabel, kind: "score" });
    if (rating) {
      pills.push(
        isAnime
          ? { id: "mal", label: `MyAnimeList ${rating}`, kind: "score" }
          : imdbRatingValue != null
            ? { id: "imdb", label: String(rating), kind: "imdb" }
            : { id: "tmdb", label: `TMDB ${rating}`, kind: "score" },
      );
    }
    if (settings.showRtBadge && scores?.rtCritics != null) pills.push({ id: "rt", label: `RT ${scores.rtCritics}%`, kind: "score" });
    if (settings.showRtBadge && mdblist?.rtAudience != null) pills.push({ id: "rta", label: `🍿 ${Math.round(mdblist.rtAudience)}%`, kind: "score" });
    if (mdblist?.letterboxd != null) pills.push({ id: "lb", label: `Letterboxd ${mdblist.letterboxd}`, kind: "score" });
    const metacritic = mdblist?.metacritic ?? scores?.metascore ?? null;
    if (metacritic != null) pills.push({ id: "mc", label: `Metacritic ${metacritic}`, kind: "score" });
    if (runtime) pills.push({ id: "runtime", label: String(runtime), kind: "pill" });
    for (const g of genres.slice(0, 3)) pills.push({ id: `genre:${g}`, label: g, kind: "pill" });
    return {
      backdrop: [backdrop, meta.background, detail?.backdrop].filter((u, i, a): u is string => !!u && a.indexOf(u) === i),
      logo: logo ?? null,
      title,
      tagline: !loading && !detectingAnime && tagline ? tagline : null,
      pills,
      // Not out yet: the page's "Upcoming · in 3 days" (it still searches, in case it's out early).
      play: upcoming
        ? [t("Upcoming"), upcomingDateLabel(t, detail?.kind === "movie" ? detail?.releaseDate : detail?.firstAirDate)].filter(Boolean).join(" · ")
        : smartPlayLabel,
      more: !liveContext,
      extra: liveContext
        ? meta.type === "series" || meta.type === "tv"
          ? t("Open in TV Shows")
          : meta.type === "anime"
            ? t("Open in Anime")
            : t("Open in Movies")
        : null,
      synopsis: overview || null,
      // The full details are still loading: the native hero holds its words until they're in.
      pending: loading,
    };
  }, [showSeasonPill, seasonPillLabel, isAnime, year, rating, imdbRatingValue, settings.showRtBadge, scores, mdblist, runtime, genres, backdrop, meta.background, detail?.backdrop, logo, title, loading, detectingAnime, tagline, upcoming, smartPlayLabel, overview, liveContext, meta.type, t]);
  const nativeRows = useMemo<NativeRowInput[]>(() => {
    if (!detail) return [];
    const sections = new Map<string, NativeRowInput>();
    const crew: Array<{ label: string; people: Array<{ id: number; name: string }> }> = [];
    const add = (label: string, people: Array<{ id: number; name: string }>) => {
      if (people.length > 0) crew.push({ label, people });
    };
    add(detail.directors.length === 1 ? t("Director") : t("Directors"), detail.directors);
    add(detail.creators.length === 1 ? t("Creator") : t("Creators"), detail.creators);
    add(detail.writers.length === 1 ? t("Writer") : t("Writers"), detail.writers.slice(0, 6));
    add(t("Producers"), detail.producers.slice(0, 6));
    add(t("Cinematography"), detail.cinematography);
    add(t("Music"), detail.composer);
    add(detail.editor.length === 1 ? t("Editor") : t("Editors"), detail.editor);
    if (crew.length > 0) sections.set("crew", { key: "crew", title: "", metas: [], kind: "credits", credits: crew });
    if (detail.cast.length > 0) {
      sections.set("cast", {
        key: "cast",
        title: t("Cast · {n}", { n: detail.cast.length }),
        metas: [],
        kind: "poster",
        cards: detail.cast.map((c) => ({
          title: c.name,
          sub: c.character || null,
          img: c.profilePath ? [c.profilePath.startsWith("http") ? c.profilePath : `https://image.tmdb.org/t/p/w185${c.profilePath}`] : [],
        })),
        onOpen: (i) => {
          const c = detail.cast[i];
          if (c && c.id > 0) openPerson(c.id);
        },
      });
    }
    if (detail.collection && collectionParts.length > 0) {
      const coll = detail.collection;
      sections.set("collection", { key: "collection", title: coll.name, metas: collectionParts, onAll: () => openCollection(coll.id) });
    }
    if (recommendations.length > 0) sections.set("moreLikeThis", { key: "moreLikeThis", title: t("More Like This"), metas: recommendations });
    if (similar.length > 0) sections.set("similar", { key: "similar", title: t("You Might Also Like"), metas: similar });
    const stills = [...(detail.gallery?.backdrops ?? [])];
    if (stills.length > 0) {
      sections.set("mediaGallery", {
        key: "mediaGallery",
        title: t("Media"),
        metas: [],
        kind: "tile",
        ratio: 9 / 16,
        gallery: true,
        cards: stills.map((u) => ({ title: "", img: [u] })),
      });
    }
    const info: Array<{ label: string; value: string }> = [];
    const money = (n?: number) => (n && n > 0 ? `$${Math.round(n).toLocaleString("en-US")}` : null);
    if (detail.status) info.push({ label: t("Status"), value: detail.status });
    if (detail.productionCompanies.length > 0) info.push({ label: t("Studio"), value: detail.productionCompanies.slice(0, 4).join(", ") });
    if (detail.productionCountries.length > 0) info.push({ label: t("Country"), value: detail.productionCountries.join(", ") });
    if (detail.spokenLanguages.length > 0) info.push({ label: t("Original language"), value: detail.spokenLanguages.slice(0, 3).join(", ") });
    if (detail.originalTitle && detail.originalTitle !== detail.title) info.push({ label: t("Original title"), value: detail.originalTitle });
    if (detail.genres.length > 0) info.push({ label: t("Genres"), value: detail.genres.join(", ") });
    const budget = money(detail.budget);
    if (budget) info.push({ label: t("Budget"), value: budget });
    const revenue = money(detail.revenue);
    if (revenue) info.push({ label: t("Revenue"), value: revenue });
    // Awards & Recognition: each award with its wins and nominations, then the categories.
    if (awards && awards.length > 0) {
      const groups = new Map<string, typeof awards>();
      for (const a of awards) {
        if (a.type === "other") continue;
        groups.set(a.type, [...(groups.get(a.type) ?? []), a]);
      }
      const lines = [...groups.entries()]
        .sort((a, b) => (AWARD_TYPE_ORDER[a[0] as keyof typeof AWARD_TYPE_ORDER] ?? 99) - (AWARD_TYPE_ORDER[b[0] as keyof typeof AWARD_TYPE_ORDER] ?? 99))
        .map(([type, entries]) => {
          const wins = entries.filter((e) => e.result === "won");
          const noms = entries.filter((e) => e.result === "nominated");
          const head = [
            wins.length > 0 ? `${wins.length} ${wins.length === 1 ? t("Win") : t("Wins")}` : null,
            noms.length > 0 ? `${noms.length} ${noms.length === 1 ? t("Nomination") : t("Nominations")}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const cat = (e: (typeof entries)[number]) => [e.year, e.category, e.recipient].filter(Boolean).join(" · ");
          const won = wins.filter((e) => e.category).sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).map(cat);
          const nom = noms.filter((e) => e.category).sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).map(cat);
          const body = [
            head,
            ...won,
            ...(nom.length > 0 ? [`${won.length > 0 ? `${t("Also Nominated")}: ` : ""}${nom.join(" / ")}`] : []),
          ]
            .filter(Boolean)
            .join("\n");
          return { label: AWARD_TYPE_TITLE[type as keyof typeof AWARD_TYPE_TITLE] ?? type, value: body };
        });
      if (lines.length > 0) sections.set("awards", { key: "awards", title: t("Awards & Recognition"), metas: [], kind: "credits", credits: lines });
    }
    if (info.length > 0) sections.set("info", { key: "info", title: t("Information"), metas: [], kind: "credits", credits: info });
    // Anime awards: the page's own block opens over the screen.
    if (isAnime) {
      sections.set("animeAwards", {
        key: "animeAwards",
        title: t("Awards"),
        metas: [],
        cards: [],
        tools: [{ id: "awards", label: t("Awards") }],
        onTool: () => setAwardsOpen(true),
      });
    }
    // Trakt comments (when turned on): the page's own list opens over the screen.
    if (settings.showTraktComments === true) {
      sections.set("traktComments", {
        key: "traktComments",
        title: t("Comments"),
        metas: [],
        cards: [],
        tools: [{ id: "comments", label: t("Comments") }],
        onTool: () => setCommentsOpen(true),
      });
    }
    const order = orderedSectionKeys([...sections.keys()], layout).filter((k) => !layout.hidden.includes(k));
    return order.map((k) => sections.get(k)).filter((r): r is NativeRowInput => !!r);
  }, [detail, collectionParts, recommendations, similar, layout, t, openPerson, openCollection, awards, settings.showTraktComments, isAnime]);
  // Watch on (where it streams) comes first, as on the page, then the episodes, then the rest.
  const watchOnRow = useMemo<NativeRowInput | null>(
    () =>
      isAnime
        ? streamers.length > 0
          ? {
              key: "watchOn",
              title: t("Watch on"),
              kind: "logo",
              metas: [],
              cards: streamers.map((s) => {
                const info = animeStreamerInfo(s.service);
                return { title: s.service, img: info.logo ? [info.logo] : [] };
              }),
              onOpen: (i) => {
                const s = streamers[i];
                if (s?.url) openUrl(s.url);
              },
            }
          : null
        : watchProviders.length > 0
        ? {
            key: "watchOn",
            title: t("Watch on"),
            kind: "logo",
            metas: [],
            cards: watchProviders.map((p) => ({ title: p.name, img: p.logo ? [p.logo] : [] })),
            onOpen: (i) => {
              const p = watchProviders[i];
              if (p?.link) openUrl(p.link);
            },
          }
        : null,
    [isAnime, watchProviders, streamers, t],
  );
  const nativeAllRows = useMemo(
    () => [...(watchOnRow ? [watchOnRow] : []), ...(showEpisodes || showAnimeEpisodes || showCinemetaEpisodes ? episodesRows : []), ...nativeRows],
    [watchOnRow, showEpisodes, showAnimeEpisodes, showCinemetaEpisodes, episodesRows, nativeRows],
  );
  // The "…" menu, drawn by the native screen as a menu sliding up from the bottom (the same rows
  // as the page's menu).
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [meta.id]);
  const moreItems = useHeroActionItems({
    meta,
    isFav,
    onToggleFavorite: () =>
      toggleFavorite({ id: meta.id, type: meta.type, name: title || meta.name, poster: meta.poster ?? detail?.poster }),
    hasTrailer: !!trailerCandidate,
    onTrailer: () => setTrailerOpen(true),
    canDownload: meta.type === "movie",
    showWatched: settings.showWatchedButton && meta.type === "movie",
    watchedMark: isWatchedNow,
    onWatched: () => {
      setWatchedMark(true);
      void markMovieWatched(meta, detail?.imdbId, meta.id.startsWith("tmdb:") ? meta.id.split(":")[2] : null);
    },
    showSync: true,
    inWatchlist,
    onToggleWatchlist: () =>
      toggleWatchlist({ id: meta.id, type: meta.type, name: title || meta.name, poster: meta.poster ?? detail?.poster, imdbId: detail?.imdbId }),
    simkl: { harborId: meta.id, type: meta.type === "movie" ? "movie" : "series" },
    onClose: () => setMoreOpen(false),
  });
  const native = useNativeBrowsePage("detail", {
    scrollKey: meta.id,
    active: topKind === "meta",
    blocked: nativeBlocked,
    hidden: trailerOpen || commentsOpen || awardsOpen,
    sheet: moreOpen ? { key: `more:${meta.id}`, items: moreItems } : null,
    onSheet: (id) => {
      if (!id) {
        setMoreOpen(false);
        return;
      }
      const item = moreItems.find((m) => m.id === id);
      if (!item || item.divider) return;
      item.onSelect?.();
      if (!item.group) setMoreOpen(false);
    },
    t,
    back: true,
    detail: nativeDetail,
    rows: nativeAllRows,
    onDetail: (what) => {
      if (what === "play") void smartPlay();
      else if (what === "extra") promoteMetaToRoot();
      else if (what === "more") setMoreOpen(true);
    },
    onPill: (id) => {
      if (id === "year") {
        const n = Number(String(year).slice(0, 4));
        if (Number.isFinite(n)) openFilter({ kind: "year", mediaType: isSeries ? "tv" : "movie", value: n });
      } else if (id === "runtime") {
        if (isSeries) return;
        const minutes = parseInt(String(runtime), 10);
        if (Number.isFinite(minutes)) openFilter({ kind: "runtime", mediaType: "movie", value: minutes });
      } else if (id.startsWith("genre:")) {
        const g = id.slice(6);
        const gid = (isSeries ? TV_GENRES : MOVIE_GENRES)[g];
        if (gid) openFilter({ kind: "genre", mediaType: isSeries ? "tv" : "movie", name: g, id: gid });
      }
    },
  });
  if (native) {
    // Only what the native screen opens over itself: the trailer and the sheets (its "…" menu is
    // the screen's own).
    return (
      <main ref={scrollRef} aria-hidden={!trailerOpen} className="absolute inset-0 z-30 overflow-hidden bg-canvas">
        {showEpisodes && detail && (
          <NativeRowSinkContext.Provider value={episodesSink}>
            <SeriesEpisodes
              meta={playMeta}
              tvId={detail.id}
              imdbId={detail.imdbId ?? (meta.id.startsWith("tt") ? meta.id : null)}
              seasons={detail.seasons}
              lastEpisodeAir={detail.lastEpisodeAir}
              scrollRef={scrollRef}
              cinemetaVideos={cinemetaFull?.videos}
              stremioWatched={stremioWatched}
            />
          </NativeRowSinkContext.Provider>
        )}
        {trailerOpen && trailerCandidate && (
          <TrailerOverlay id={trailerCandidate} title={title} logo={logo} onClose={() => setTrailerOpen(false)} />
        )}
        {commentsOpen && (
          <WebSheet title={t("Comments")} onClose={() => setCommentsOpen(false)}>
            <TraktComments resolution={traktResolution} />
          </WebSheet>
        )}
        {awardsOpen && (
          <WebSheet title={t("Awards")} onClose={() => setAwardsOpen(false)}>
            <AnimeAwardsBlock
              name={animeAwardLookupName(releaseYearNum, title, meta.name, detail?.title) ?? stickyAwardName.current ?? title}
              year={releaseYearNum}
            />
          </WebSheet>
        )}
        {showCinemetaEpisodes && cinemetaVideos && (
          <NativeRowSinkContext.Provider value={episodesSink}>
            <CinemetaEpisodes meta={playMeta} videos={cinemetaVideos} />
          </NativeRowSinkContext.Provider>
        )}
        {showAnimeEpisodes && detail && (
          <NativeRowSinkContext.Provider value={episodesSink}>
            <AnimeEpisodes meta={playMeta} episodes={animeEpisodes} franchise={franchise} currentId={currentFranchiseId} scrollRef={scrollRef} />
          </NativeRowSinkContext.Provider>
        )}
      </main>
    );
  }

  return (
    <main
      ref={scrollRef}
      className="absolute inset-0 z-30 overflow-y-auto bg-canvas"
    >
      <section className="relative">
        <div
          data-tauri-drag-region
          className="harbor-bleed-stremio relative h-[78vh] min-h-[640px] overflow-hidden"
        >
          {!pinnedBackdrop && backdrops.length >= 2 ? (
            backdrops.map((b, i) => (
              <img
                key={b}
                src={b}
                alt=""
                decoding="async"
                fetchPriority={i === 0 ? "high" : "low"}
                loading={i < 3 ? "eager" : "lazy"}
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-[1200ms] ${i === backdropIdx ? "opacity-100" : "opacity-0"}`}
              />
            ))
          ) : backdrop ? (
            <HeroBackdrop key={backdrop} url={backdrop} />
          ) : (
            <div className="absolute inset-0 animate-pulse bg-white/[0.02]" />
          )}
          {settings.detailTrailerAutoplay && trailerCandidate && (
            <DetailHeroTrailer candidateId={trailerCandidate} paused={trailerOpen} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-canvas via-canvas/55 via-45% to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r rtl:bg-gradient-to-l from-canvas/85 via-canvas/35 to-transparent" />

          <div className="absolute inset-x-0 bottom-0 px-12 pb-14">
            <div className="max-w-3xl">
              {tagline && !loading && !detectingAnime && (
                <p className="mb-4 text-[14px] font-medium uppercase tracking-[0.2em] text-ink-subtle">
                  {tagline}
                </p>
              )}
              <TitlePlate title={title} logo={logo} loading={loading} />
              <div className="mt-6 flex flex-wrap items-center gap-3 text-[13px] font-medium text-ink-muted">
                {year && (
                  <Pill
                    onClick={() => {
                      const n = Number(String(year).slice(0, 4));
                      if (Number.isFinite(n)) {
                        openFilter({ kind: "year", mediaType: isSeries ? "tv" : "movie", value: n });
                      }
                    }}
                  >
                    {year}
                  </Pill>
                )}
                <HeroRatings
                  rating={rating}
                  isAnime={isAnime}
                  scores={scores}
                  mdblist={mdblist}
                  showRtBadge={settings.showRtBadge}
                  imdbId={detail?.imdbId ?? (meta.id.startsWith("tt") ? meta.id : null)}
                  mediaType={meta.type === "movie" ? "movie" : "show"}
                  ratingSource={imdbRatingValue != null ? "imdb" : "tmdb"}
                  onOpenUrl={openUrl}
                />
                {runtime && (
                  <Pill
                    onClick={() => {
                      if (isSeries) {
                        document
                          .querySelector("[data-episodes], [data-anime-episodes]")
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                        return;
                      }
                      const minutes = parseInt(String(runtime), 10);
                      if (Number.isFinite(minutes)) {
                        openFilter({ kind: "runtime", mediaType: "movie", value: minutes });
                      }
                    }}
                  >
                    {runtime}
                  </Pill>
                )}
                {showSeasonPill && (
                  <button
                    onClick={() => {
                      document
                        .querySelector('[data-anime-episodes]')
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/12 px-3 py-1 text-[12.5px] font-semibold text-accent transition-colors hover:bg-accent/20"
                  >
                    {seasonPillLabel}
                  </button>
                )}
                {meta.addonOrigin ? (
                  <span className="flex items-center gap-2 rounded-full border border-edge bg-canvas/80 py-1 ps-1.5 pe-3 text-[12.5px] font-medium text-ink-muted">
                    {meta.addonOrigin.logo ? (
                      <img
                        src={meta.addonOrigin.logo}
                        alt=""
                        draggable={false}
                        className="h-5 w-5 rounded-full object-cover"
                      />
                    ) : (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-ink">
                        {meta.addonOrigin.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    {meta.addonOrigin.name}
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    {genres.slice(0, 3).map((g) => {
                      const map = isSeries ? TV_GENRES : MOVIE_GENRES;
                      const id = map[g];
                      return (
                        <Pill
                          key={g}
                          onClick={
                            id
                              ? () => openFilter({ kind: "genre", mediaType: isSeries ? "tv" : "movie", name: g, id })
                              : undefined
                          }
                        >
                          {g}
                        </Pill>
                      );
                    })}
                  </div>
                )}
              </div>
              <div ref={actionRowRef} className="mt-9 flex items-center gap-3 [&>*]:shrink-0">
                {upcoming ? (
                  <UpcomingCta detail={detail} onTry={() => smartPlay()} />
                ) : (
                  <PlayModeHint>
                  <button
                    onClick={() => smartPlay(false)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void smartPlay(true);
                    }}
                    className="flex h-12 items-center gap-2.5 rounded-full bg-ink px-7 text-[15px] font-semibold text-canvas shadow-[0_8px_24px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-1px_0_rgba(0,0,0,0.18)] transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98]"
                  >
                    <Play size={18} fill="currentColor" />
                    {smartPlayLabel}
                  </button>
                  </PlayModeHint>
                )}
                {actionStage < 2 && (
                  <button
                    type="button"
                    onClick={() =>
                      toggleWatchlist({
                        id: meta.id,
                        type: meta.type,
                        name: title || meta.name,
                        poster: meta.poster ?? detail?.poster,
                        imdbId: detail?.imdbId,
                      })
                    }
                    title={traktConnected ? t("Synced to Trakt") : t("Saved locally. Connect Trakt in Settings to sync.")}
                    className={`flex h-12 items-center gap-2.5 whitespace-nowrap rounded-full border px-6 text-[15px] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-[transform,background-color,border-color] duration-200 active:scale-[0.98] ${
                      inWatchlist
                        ? "border-ink bg-ink/10 text-ink hover:bg-ink/20"
                        : "border-edge bg-canvas/80 text-ink hover:border-ink-subtle hover:bg-canvas/95"
                    }`}
                  >
                    {inWatchlist ? (
                      <>
                        <Check size={18} strokeWidth={2.4} />
                        {t("In Watchlist")}
                      </>
                    ) : (
                      <>
                        <Plus size={18} strokeWidth={2} />
                        {t("Add to Watchlist")}
                      </>
                    )}
                  </button>
                )}
                {actionStage < 2 && (
                  <AddToSimklButton
                    harborId={isAnime ? (animeCanonicalId ?? meta.id) : meta.id}
                    title={title || meta.name}
                    type={meta.type === "movie" ? "movie" : "series"}
                  />
                )}
                {actionStage >= 1 ? (
                  <HeroActionOverflow
                    meta={meta}
                    isFav={isFav}
                    onToggleFavorite={() =>
                      toggleFavorite({
                        id: meta.id,
                        type: meta.type,
                        name: title || meta.name,
                        poster: meta.poster ?? detail?.poster,
                      })
                    }
                    hasTrailer={!!trailerCandidate}
                    onTrailer={() => setTrailerOpen(true)}
                    canDownload={meta.type === "movie"}
                    showWatched={settings.showWatchedButton && meta.type === "movie"}
                    watchedMark={isWatchedNow}
                    onWatched={() => {
                      setWatchedMark(true);
                      void markMovieWatched(
                        meta,
                        detail?.imdbId,
                        meta.id.startsWith("tmdb:") ? meta.id.split(":")[2] : null,
                      );
                    }}
                    showSync={actionStage >= 2}
                    inWatchlist={inWatchlist}
                    onToggleWatchlist={() =>
                      toggleWatchlist({
                        id: meta.id,
                        type: meta.type,
                        name: title || meta.name,
                        poster: meta.poster ?? detail?.poster,
                        imdbId: detail?.imdbId,
                      })
                    }
                    simkl={{
                      harborId: isAnime ? (animeCanonicalId ?? meta.id) : meta.id,
                      type: meta.type === "movie" ? "movie" : "series",
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        toggleFavorite({
                          id: meta.id,
                          type: meta.type,
                          name: title || meta.name,
                          poster: meta.poster ?? detail?.poster,
                        })
                      }
                      aria-label={isFav ? t("Remove from favorites") : t("Add to favorites")}
                      title={isFav ? t("Favorited") : t("Favorite")}
                      className={`group flex h-12 w-12 items-center justify-center rounded-full border transition-[transform,background-color,border-color] duration-200 active:scale-[0.94] ${
                        isFav
                          ? "border-accent/55 bg-accent/15 text-accent hover:bg-accent/22"
                          : "border-edge bg-canvas/80 text-ink hover:border-ink-subtle hover:bg-canvas/95"
                      }`}
                    >
                      <Star size={20} strokeWidth={isFav ? 0 : 1.9} fill={isFav ? "currentColor" : "none"} />
                    </button>
                    {settings.showWatchedButton && meta.type === "movie" && (
                      <button
                        type="button"
                        onClick={() => {
                          setWatchedMark(true);
                          void markMovieWatched(
                            meta,
                            detail?.imdbId,
                            meta.id.startsWith("tmdb:") ? meta.id.split(":")[2] : null,
                          );
                        }}
                        aria-label={t("Mark watched")}
                        title={isWatchedNow ? t("Marked watched") : t("Mark watched")}
                        className={`group flex h-12 w-12 items-center justify-center rounded-full border transition-[transform,background-color,border-color] duration-200 active:scale-[0.94] ${
                          isWatchedNow
                            ? "border-accent/55 bg-accent/15 text-accent"
                            : "border-edge bg-canvas/80 text-ink hover:border-ink-subtle hover:bg-canvas/95"
                        }`}
                      >
                        <Check size={20} strokeWidth={2.4} />
                      </button>
                    )}
                    {trailerCandidate && (
                      <button
                        type="button"
                        onClick={() => setTrailerOpen(true)}
                        aria-label={t("Watch trailer")}
                        title={t("Watch trailer")}
                        className="group flex h-12 w-12 items-center justify-center rounded-full border border-edge bg-canvas/80 text-ink transition-[transform,background-color,border-color] duration-200 hover:border-ink-subtle hover:bg-canvas/95 active:scale-[0.94]"
                      >
                        <PreviewIcon size={20} />
                      </button>
                    )}
                    {meta.type === "movie" && <EpisodeDownloadButton meta={meta} variant="bar" />}
                  </>
                )}
                {liveContext && (
                  <button
                    type="button"
                    onClick={promoteMetaToRoot}
                    className="flex h-12 items-center gap-2 rounded-full border border-edge bg-canvas/80 px-5 text-[14px] font-medium text-ink-muted transition-colors hover:border-ink-subtle hover:bg-canvas/95 hover:text-ink"
                  >
                    {meta.type === "series" || meta.type === "tv"
                      ? t("Open in TV Shows")
                      : meta.type === "anime"
                        ? t("Open in Anime")
                        : t("Open in Movies")}
                  </button>
                )}
              </div>
            </div>
          </div>
          {(() => {
            if (isAnime) {
              const animeName =
                animeAwardLookupName(releaseYearNum, title, meta.name, detail?.title) ??
                stickyAwardName.current;
              if (animeName) {
                stickyAwardName.current = animeName;
                return <CrunchyrollAwardsCorner name={animeName} year={releaseYearNum} />;
              }
            }
            if (heroAwardSummary.length > 0) {
              return <HeroAwardsCorner summary={heroAwardSummary} />;
            }
            const resolved =
              animeAwardLookupName(releaseYearNum, title, meta.name, detail?.title) ??
              stickyAwardName.current;
            if (resolved) stickyAwardName.current = resolved;
            if (resolved) return <CrunchyrollAwardsCorner name={resolved} year={releaseYearNum} />;
            return null;
          })()}
        </div>
      </section>

      <div data-tauri-drag-region className="flex flex-col gap-16 px-12 pb-24 pt-14">
        {overview && <Synopsis text={overview} />}
        {loading && (meta.type === "series" || isAnime) && <EpisodeGridSkeleton />}

        {isAnime && streamers.length > 0 && <FadeInUp><StreamingLinks streamers={streamers} /></FadeInUp>}

        {!isAnime && watchProviders.length > 0 && <FadeInUp><WatchOn providers={watchProviders} /></FadeInUp>}

        {!liveContext && detail && isAnime && (animeEpisodes.length > 1 || franchise.length > 1) && (
          <FadeInUp>
          <AnimeEpisodes
            meta={playMeta}
            episodes={animeEpisodes}
            franchise={franchise}
            currentId={currentFranchiseId}
            scrollRef={scrollRef}
          />
          </FadeInUp>
        )}

        {!liveContext && detail && !isAnime && isSeries && detail.seasons.length > 0 && (
          <FadeInUp>
          <SeriesEpisodes
            meta={playMeta}
            tvId={detail.id}
            imdbId={detail.imdbId ?? (meta.id.startsWith("tt") ? meta.id : null)}
            seasons={detail.seasons}
            lastEpisodeAir={detail.lastEpisodeAir}
            scrollRef={scrollRef}
            cinemetaVideos={cinemetaFull?.videos}
            stremioWatched={stremioWatched}
          />
          </FadeInUp>
        )}

        {!liveContext &&
          (!detail || detail.seasons.length === 0) &&
          !isAnime &&
          (isSeries || (addonNative && (meta.type === "channel" || meta.type === "tv"))) &&
          cinemetaFull?.videos &&
          (addonNative
            ? cinemetaFull.videos.length > 0
            : cinemetaFull.videos.some((v) => v.season != null && v.season > 0 && v.episode != null)) && (
            <FadeInUp><CinemetaEpisodes meta={playMeta} videos={cinemetaFull.videos} /></FadeInUp>
          )}

        {(() => {
          const railSections: DetailSection[] = [];
          if (detail && (detail.directors.length > 0 || detail.creators.length > 0 || detail.writers.length > 0)) {
            railSections.push({
              key: "crew",
              label: t("Crew"),
              minHeight: 160,
              node: (
                <div className="grid grid-cols-1 gap-x-12 gap-y-6 border-b border-edge-soft pb-12 sm:grid-cols-2 lg:grid-cols-3">
                  {detail.directors.length > 0 && (
                    <Credit label={detail.directors.length === 1 ? t("Director") : t("Directors")} people={detail.directors} />
                  )}
                  {detail.creators.length > 0 && (
                    <Credit label={detail.creators.length === 1 ? t("Creator") : t("Creators")} people={detail.creators} />
                  )}
                  {detail.writers.length > 0 && (
                    <Credit label={detail.writers.length === 1 ? t("Writer") : t("Writers")} people={detail.writers.slice(0, 6)} />
                  )}
                  {detail.producers.length > 0 && (
                    <Credit label={t("Producers")} people={detail.producers.slice(0, 6)} />
                  )}
                  {detail.cinematography.length > 0 && (
                    <Credit label={t("Cinematography")} people={detail.cinematography} />
                  )}
                  {detail.composer.length > 0 && (
                    <Credit label={t("Music")} people={detail.composer} />
                  )}
                  {detail.editor.length > 0 && (
                    <Credit label={detail.editor.length === 1 ? t("Editor") : t("Editors")} people={detail.editor} />
                  )}
                </div>
              ),
            });
          }
          if (detail && detail.cast.length > 0) {
            railSections.push({
              key: "cast",
              label: t("Cast"),
              minHeight: 240,
              node: (
                <Row title={t("Cast · {n}", { n: detail.cast.length })} min={128}>
                  {detail.cast.map((c, i) => (
                    <CastCard key={`${c.id}-${i}`} cast={c} />
                  ))}
                </Row>
              ),
            });
          }
          if (detail?.collection) {
            railSections.push({
              key: "collection",
              label: t("Collection"),
              node: <CollectionRow collection={detail.collection} currentId={meta.id} />,
            });
          }
          if (recommendations.length > 0) {
            railSections.push({
              key: "moreLikeThis",
              label: t("More Like This"),
              node: (
                <Row title={t("More Like This")}>
                  {recommendations.map((r) => (
                    <PickCard key={r.id} meta={r} />
                  ))}
                </Row>
              ),
            });
          }
          if (similar.length > 0) {
            railSections.push({
              key: "similar",
              label: t("You Might Also Like"),
              node: (
                <Row title={t("You Might Also Like")}>
                  {similar.map((r) => (
                    <PickCard key={`s-${r.id}`} meta={r} />
                  ))}
                </Row>
              ),
            });
          }
          if (detail) {
            railSections.push({
              key: "mediaGallery",
              label: t("Media"),
              node: <MediaGallery detail={detail} title={title} logo={logo} />,
            });
          }
          if (isAnime) {
            railSections.push({
              key: "animeAwards",
              label: t("Awards"),
              minHeight: 160,
              node: (
                <AnimeAwardsBlock
                  name={
                    animeAwardLookupName(releaseYearNum, title, meta.name, detail?.title) ??
                    stickyAwardName.current ??
                    title
                  }
                  year={releaseYearNum}
                />
              ),
            });
          }
          if (detail && awards) {
            railSections.push({
              key: "awards",
              label: t("Awards & Recognition"),
              minHeight: 200,
              node: <AwardsBlock awards={awards} />,
            });
          }
          if (detail) {
            railSections.push({
              key: "info",
              label: t("Information"),
              minHeight: 200,
              node: <InfoBlock detail={detail} isAnime={isAnime} />,
            });
          }
          if (settings.showTraktComments === true) {
            railSections.push({
              key: "traktComments",
              label: t("Comments"),
              minHeight: 120,
              node: <TraktComments resolution={traktResolution} />,
            });
          }
          if (railSections.length === 0) return null;
          const railKeys = railSections.map((s) => s.key);
          const persist = (next: DetailCustomization) => {
            setLayout(next);
            saveDetailCustomization(next);
          };
          const hasChanges = layout.order.length > 0 || layout.hidden.length > 0;
          return (
            <>
              <div className="flex items-center justify-end gap-2">
                {layoutEdit && hasChanges && (
                  <button
                    onClick={() => persist(resetDetailCustomization())}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-edge-soft/40 bg-canvas/80 px-2.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-ink"
                  >
                    <RotateCcw size={12} strokeWidth={2.2} />
                    {t("Reset")}
                  </button>
                )}
                <button
                  onClick={() => setLayoutEdit((v) => !v)}
                  className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
                    layoutEdit
                      ? "border-ink bg-ink text-canvas hover:opacity-90"
                      : "border-edge-soft/40 bg-canvas/80 text-ink-muted hover:bg-canvas hover:text-ink"
                  }`}
                >
                  <Pencil size={12} strokeWidth={2.4} />
                  {layoutEdit ? t("Done editing") : t("Customize layout")}
                </button>
              </div>
              <FadeInUp>
              <ContentRails
                sections={railSections}
                custom={layout}
                editMode={layoutEdit}
                onMove={(k, d) => persist(moveSection(layout, railKeys, k, d))}
                onToggleHidden={(k) => persist(toggleSectionHidden(layout, k))}
              />
              </FadeInUp>
            </>
          );
        })()}

        {!loading && !detail && !isAnime && !addonNative && !settings.tmdbKey && (
          <div className="rounded-2xl border border-dashed border-edge px-6 py-12 text-center text-[14px] text-ink-muted">
            {t("Add a TMDB key in Settings to see cast, related titles, and trailers here.")}
          </div>
        )}
      </div>
      <BackToTop scrollRef={scrollRef} />
      {trailerOpen && trailerCandidate && (
        <TrailerOverlay
          id={trailerCandidate}
          title={title}
          logo={logo}
          onClose={() => setTrailerOpen(false)}
        />
      )}
    </main>
  );
}

/** Android: a part of the page shown over the native screen (Trakt comments, anime awards: the
 *  page's own block, reading and posting included); Back or the close button returns to it. */
function WebSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[150] flex flex-col bg-canvas">
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h3 className="text-[20px] font-medium tracking-tight text-ink">{title}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close")}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-edge-soft text-ink-muted"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24">{children}</div>
    </div>
  );
}
