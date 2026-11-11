import { isPhoneLayout } from "@/lib/platform";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { resolveAddonLogo } from "@/components/addon-logo";
import { torrentEngineStatus } from "@/lib/torrent/local-engine";
import { useAuth } from "@/lib/auth";
import type { Meta } from "@/lib/cinemeta";
import { useDebridClients } from "@/lib/debrid/registry";
import { useTogether } from "@/lib/together/provider";
import { buildMatchScores, matchBadge, MATCH_CLOSE } from "@/lib/together/source-match";
import { HostSourceBanner } from "@/components/host-source-banner";
import { consumeRecentStubEvent } from "@/lib/dead-streams";
import {
  findPreferredSourceMatch,
  readPlayback,
  readLastSeriesPlayback,
  streamMatchesEntry,
  streamMatchesPreferredSource,
} from "@/lib/playback-history";
import { useSettings } from "@/lib/settings";
import type { ScoredStream, Tier } from "@/lib/streams/types";
import { isAddonRanked } from "@/lib/streams/addon-detect";
import { useView, type PlayEpisode } from "@/lib/view";
import { exitWindowFullscreen } from "@/lib/fullscreen-state";
import { useWindowFullscreen } from "@/lib/use-window-fullscreen";
import { AutoExhaustedModal } from "./play-picker/auto-exhausted-modal";
import { AutoPlayTransition } from "./play-picker/auto-play-transition";
import { BackdropLayer } from "./play-picker/backdrop-layer";
import { CinematicLoader } from "./play-picker/cinematic-loader";
import { DownloadStarted } from "./play-picker/download-started";
import { DebridDownModal } from "./play-picker/debrid-down-modal";
import { P2pConfirmModal } from "./play-picker/p2p-confirm-modal";
import { CachedFilterPill, LanguageFilterPill } from "./play-picker/filter-pills";
import { PickerEmptyLadder } from "./play-picker/picker-empty-ladder";
import { NoSourcesConfiguredModal } from "./play-picker/no-sources-modal";
import {
  hasUncachedMarker,
  isEngineWarmingError,
  normalizeLangCode,
  orderByAddonNative,
  streamMatchesLangs,
} from "./play-picker/picker-utils";
import { PickerHeader } from "./play-picker/picker-header";
import { PrimaryCard } from "./play-picker/primary-card";
import { SourceDiagnostic } from "./play-picker/source-diagnostic";
import { StremioLayout } from "./play-picker/stremio-layout";
import { SourceDrawer } from "./play-picker/source-drawer";
import { TierStrip } from "./play-picker/tier-strip";
import { usePickHandler } from "./play-picker/use-pick-handler";
import { useAutoCandidates } from "./play-picker/use-auto-candidates";
import { useAutoFire } from "./play-picker/use-auto-fire";
import { useRoomInvite } from "./play-picker/use-room-invite";
import { useAddons } from "./play-picker/use-addons";
import { useImdbId } from "./play-picker/use-imdb-id";
import { usePipelineResult } from "./play-picker/use-pipeline-result";
import { useStreamIds } from "./play-picker/use-stream-ids";
import { t } from "@/lib/i18n/translate";
import { useT } from "@/lib/i18n";
import { addonLogoSrc } from "@/components/addon-logo";
import { streamBadges } from "@/components/format-badge";
import { useNativeBrowsePage, useAssetDataUrls, type NativeRowInput } from "@/views/native/native-screens";
import { pendingAddons, useStremioSources } from "./play-picker/stremio-layout";
import { condenseDescription } from "./play-picker/stremio-row";
import { qualityTier } from "./play-picker/quality-filter";
import { useCloseOnAndroidBack } from "@/lib/use-android-back";
import { abbreviateLanguages, addonInstanceKey, autoPlayMediaKey, buildAddonOptions } from "./play-picker/picker-utils";
import { stillInTheatres } from "./play-picker/picker-empty-ladder";
import {
  diagBlock,
  drawerBlock,
  hostCard,
  ladderPanels,
  loaderBlock,
  pickBlock,
  stages,
  streamsBlock,
  tiersBlock,
  type PanelAction,
} from "./play-picker/native-blocks";

const TIER_ORDER: Tier[] = ["4K_DV", "4K_HDR", "4K", "1080p_HDR", "1080p", "720p", "SD", "ROUGH"];

export function PlayPicker({
  meta,
  episode,
  autoPlay,
  attempt,
  intent,
  resume,
}: {
  meta: Meta;
  episode?: PlayEpisode;
  autoPlay?: boolean;
  attempt?: number;
  intent?: "play" | "download";
  resume?: boolean;
}) {
  const isDownload = intent === "download";
  const { openPlayer, openSettings, exitPickerToDetail, topKind, goBack, setView } = useView();
  const backToDetail = () => {
    void exitWindowFullscreen();
    exitPickerToDetail(meta);
  };
  const { settings, update } = useSettings();
  const fs = useWindowFullscreen();
  const { authKey } = useAuth();
  const debrids = useDebridClients();
  const { snapshot: roomSnapshot, sendInvite, claimHost, wasInvitedTo, clientId, hostSource, roomGuestPick, lastInviteProto } = useTogether();
  const inSession = roomSnapshot.state === "joined";
  const resolvedImdb = useImdbId(meta, settings.tmdbKey);
  const imdbId = resolvedImdb.id;
  const streamIds = useStreamIds(meta, episode, imdbId);
  const { addons } = useAddons(authKey, settings);
  const [resolving, setResolving] = useState<{ stream: ScoredStream } | null>(null);
  const [failedStreams, setFailedStreams] = useState<Set<ScoredStream>>(new Set());
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [downloadConfirm, setDownloadConfirm] = useState<{ label: string | null } | null>(null);
  const [strictMode, setStrictMode] = useState(settings.streamFilterLevel === "strict");
  const [forceShowAll, setForceShowAll] = useState(false);
  const filterDisabled = settings.streamFilterLevel === "off" || forceShowAll || isDownload;
  const {
    result,
    loading,
    pipelineDone,
    firstResultAt,
    autoSettleReady,
    resolveError,
    refresh,
    setAutoSettleReady,
    setResolveError,
  } = usePipelineResult({
    meta,
    episode,
    imdbId,
    streamIds,
    addons,
    debrids,
    settings,
    strictMode,
    filterDisabled,
  });
  const baseLangs = settings.preferredLanguages ?? [];
  const isAnimeRequest = useMemo(
    () => (streamIds ?? []).some((id) => id.startsWith("kitsu:") || id.startsWith("mal:")),
    [streamIds],
  );
  const preferredLangs = useMemo(() => {
    const codes = settings.preferredAudioLangs ?? [];
    const animeAdd = isAnimeRequest ? ["Japanese"] : [];
    const all = [...baseLangs, ...codes, ...animeAdd];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const lang of all) {
      const code = normalizeLangCode(lang);
      if (!isAnimeRequest && code === "ja") continue;
      if (seen.has(code)) continue;
      seen.add(code);
      out.push(lang);
    }
    return out;
  }, [baseLangs, settings.preferredAudioLangs, isAnimeRequest]);
  const [langFilter, setLangFilter] = useState(
    settings.requirePreferredLanguage === true && baseLangs.length > 0,
  );
  const [cachedOnly, setCachedOnly] = useState(false);

  const { inviteKey, canInvite, inviteSentRef, hostSourceForMedia, expectHostSource } = useRoomInvite({
    meta,
    episode,
    inSession,
    roomSnapshot,
    clientId,
    hostSource,
    lastInviteProto,
    wasInvitedTo,
    claimHost,
    sendInvite,
  });

  useEffect(() => {
    setStrictMode(settings.streamFilterLevel === "strict");
    setForceShowAll(false);
  }, [meta.id, episode?.season, episode?.episode, settings.streamFilterLevel]);

  const hostMatch = useMemo(
    () => (hostSourceForMedia && result ? buildMatchScores(result.picker.all, hostSourceForMedia) : null),
    [result, hostSourceForMedia],
  );
  const matchFor = useCallback(
    (s: ScoredStream) => (hostMatch ? matchBadge(hostMatch.get(s)) : null),
    [hostMatch],
  );

  const isCached = useCallback(
    (s: ScoredStream) =>
      (s.url != null && !s.infoHash && !hasUncachedMarker(s)) ||
      debrids.some((d) => s.cached[d.slug] === true || s.inLibrary[d.slug] === true),
    [debrids],
  );
  const hasStrongAddon = useMemo(
    () => (addons ?? []).some((a) => /mediafusion|comet/i.test(a.manifest?.name ?? "")),
    [addons],
  );
  const isTorrentioStream = useCallback(
    (s: ScoredStream) => /torrentio/i.test(s.addonName ?? ""),
    [],
  );

  const filteredPicker = useMemo(() => {
    if (!result) return null;
    let all = result.picker.all;
    if (langFilter && preferredLangs.length > 0) {
      const langFiltered = all.filter((s) => streamMatchesLangs(s, preferredLangs));
      if (langFiltered.length > 0) all = langFiltered;
    }
    if (cachedOnly && debrids.length > 0) {
      const cached = all.filter(isCached);
      if (cached.length > 0) all = cached;
    }
    const cachedFirst = all.slice().sort((a, b) => (isCached(b) ? 1 : 0) - (isCached(a) ? 1 : 0));
    const ranked = hostMatch
      ? cachedFirst.slice().sort((a, b) => (hostMatch.get(b) ?? 0) - (hostMatch.get(a) ?? 0))
      : cachedFirst;
    const byTier: Partial<Record<Tier, ScoredStream>> = {};
    for (const s of ranked) if (!byTier[s.tier]) byTier[s.tier] = s;
    const hostBest =
      hostMatch && ranked.length > 0 && (hostMatch.get(ranked[0]) ?? 0) >= MATCH_CLOSE
        ? ranked[0]
        : null;
    const primaryCandidates = [hostBest, result.picker.primary, ...ranked].filter(
      (s): s is ScoredStream => s != null && all.includes(s),
    );
    const primary = primaryCandidates[0] ?? null;
    return { primary, byTier, all };
  }, [result, langFilter, preferredLangs, cachedOnly, debrids.length, isCached, hostMatch]);

  const anyAddonRanked = useMemo(() => {
    const all = filteredPicker?.all ?? [];
    if (all.length === 0 || !addons) return false;
    const byUrl = new Map(addons.map((a) => [a.transportUrl, a]));
    const usedUrls = new Set(all.map((s) => s.addonUrl).filter(Boolean) as string[]);
    if (usedUrls.size === 0) return false;
    for (const url of usedUrls) {
      const a = byUrl.get(url);
      if (a && isAddonRanked(a)) return true;
    }
    return false;
  }, [filteredPicker, addons]);
  const addonOrderMode = settings.streamSort === "addon" || anyAddonRanked;
  const displayStreams = useMemo(() => {
    const all = filteredPicker?.all ?? [];
    const base = addonOrderMode && result ? orderByAddonNative(all, result.raw.addon, addons) : all;
    if (!hostMatch) return base;
    return base.slice().sort((a, b) => (hostMatch.get(b) ?? 0) - (hostMatch.get(a) ?? 0));
  }, [filteredPicker, addonOrderMode, result, addons, hostMatch]);

  const langHiddenCount = useMemo(() => {
    if (!result || preferredLangs.length === 0) return 0;
    return result.picker.all.filter((s) => !streamMatchesLangs(s, preferredLangs)).length;
  }, [result, preferredLangs]);

  const uncachedHiddenCount = useMemo(() => {
    if (!result || debrids.length === 0) return 0;
    return result.picker.all.filter((s) => !isCached(s)).length;
  }, [result, debrids.length, isCached]);

  const populatedTiers = useMemo(
    () => TIER_ORDER.filter((t) => filteredPicker?.byTier[t]),
    [filteredPicker],
  );

  useEffect(() => {
    if (!filteredPicker?.primary) return;
    setSelectedTier((s) => s ?? filteredPicker.primary!.tier);
  }, [filteredPicker]);

  const previousPlayback = useMemo(
  () =>
    settings.rememberLastStream
      ? readPlayback(meta.id, episode?.season, episode?.episode)
      : null,
  [meta.id, episode?.season, episode?.episode, settings.rememberLastStream],
  );

  const lastSeriesSource = useMemo(
    () =>
      settings.keepSourceNextEpisode && !!autoPlay && meta.type === "series"
        ? readLastSeriesPlayback(meta.id)
        : null,
    [meta.id, meta.type, settings.keepSourceNextEpisode, autoPlay],
  );

  const autoCandidates = useAutoCandidates({
    filteredPicker,
    previousPlayback,
    sourceEntry: lastSeriesSource,
    isCached,
    addons,
    hasStrongAddon,
    isTorrentioStream,
    preferredLangs,
    hostSource: hostSourceForMedia,
    // The same numbering the source filter checks against. Not for anime: its releases
    // count episodes across seasons, so their numbers say nothing reliable here.
    season: isAnimeRequest ? null : (episode?.imdbSeason ?? episode?.season ?? null),
    episode: isAnimeRequest ? null : (episode?.imdbEpisode ?? episode?.episode ?? null),
  });

  const autoFiredRef = useRef(false);
  const [autoAttemptIdx, setAutoAttemptIdx] = useState(0);
  const [autoExhausted, setAutoExhausted] = useState(false);
  const [autoCancelled, setAutoCancelled] = useState(false);
  const isLiveLikeContent =
    !!meta.type && !["movie", "series", "anime"].includes(String(meta.type).toLowerCase());
  const autoActive =
    !!((autoPlay && !isLiveLikeContent) || wasInvitedTo(inviteKey)) &&
    !autoCancelled &&
    !autoExhausted &&
    !isDownload &&
    !roomGuestPick;
  useEffect(() => {
    if (!autoActive) return;
    const t = window.setTimeout(() => setAutoCancelled(true), 45_000);
    return () => window.clearTimeout(t);
  }, [autoActive]);

  const previousMatch: ScoredStream | null = useMemo(() => {
    if (!filteredPicker || !previousPlayback) return null;
    return filteredPicker.all.find((s) => streamMatchesEntry(s, previousPlayback)) ?? null;
  }, [filteredPicker, previousPlayback]);

  const sameSourceMatch: ScoredStream | null = useMemo(() => {
    if (!filteredPicker || !lastSeriesSource || previousMatch) return null;
    // Only a confirmed same release (same torrent, binge group or release group, at the same
    // resolution and dub) is shown as "the same source"; a look-alike from the same addon
    // is not.
    return findPreferredSourceMatch(filteredPicker.all, lastSeriesSource, streamMatchesPreferredSource);
  }, [filteredPicker, lastSeriesSource, previousMatch]);

  const currentPick: ScoredStream | null = useMemo(() => {
    if (!filteredPicker) return null;
    if (selectedTier && filteredPicker.byTier[selectedTier]) {
    return filteredPicker.byTier[selectedTier]!;
  }
    if (previousMatch) return previousMatch;
    if (sameSourceMatch) return sameSourceMatch;   
    return filteredPicker.primary;
  }, [filteredPicker, selectedTier, previousMatch, sameSourceMatch]);

  const { onPlay, onCache, queuedHash, debridDown, resetDebridDown, abortResolve, p2pConfirm, confirmP2p, cancelP2p } = usePickHandler({
    meta,
    imdbId,
    imdbIdVerified: resolvedImdb.verified,
    episode,
    attempt,
    debrids,
    isCached,
    p2pAutoConsent: settings.p2pAutoConsent,
    inSession,
    canInvite,
    inviteSentRef,
    sendInvite,
    claimHost,
    openPlayer,
    intent,
    onDownloadStarted: (label) => setDownloadConfirm({ label: label ?? null }),
    autoActive,
    autoAttemptIdx,
    autoCandidatesLength: autoCandidates.length,
    autoFiredRef,
    setAutoAttemptIdx,
    setAutoExhausted,
    setFailedStreams,
    setResolveError,
    setResolving,
  });

  const playManually = useCallback(
    (s: ScoredStream) => {
      setAutoCancelled(true);
      onPlay(s);
    },
    [onPlay],
  );

  const rememberedFiredRef = useRef(false);
  const rememberedHandledFirst =
    !!previousMatch &&
    settings.rememberLastStream &&
    !!resume &&
    !wasInvitedTo(inviteKey) &&
    !isDownload &&
    !roomGuestPick &&
    !inSession &&
    (attempt ?? 0) === 0;
  useEffect(() => {
    if (rememberedFiredRef.current || !rememberedHandledFirst || !previousMatch) return;
    rememberedFiredRef.current = true;
    onPlay(previousMatch, true);
  }, [rememberedHandledFirst, previousMatch, onPlay]);

  useAutoFire({
    autoActive,
    rememberedHandledFirst: rememberedHandledFirst && autoAttemptIdx === 0,
    attempt,
    mediaKey: autoPlayMediaKey(meta.id, episode),
    autoCandidates,
    resolving,
    autoAttemptIdx,
    autoSettleReady,
    pipelineDone,
    firstResultAt,
    isCached,
    p2pAutoConsent: settings.p2pAutoConsent,
    preferredLangs,
    hasStrongAddon,
    isTorrentioStream,
    expectHostSource,
    hostSource: hostSourceForMedia,
    autoFiredRef,
    setAutoSettleReady,
    setAutoCancelled,
    onPlay,
  });

  const allCount = filteredPicker?.all.length ?? 0;
  // A list restored from the cache comes without the raw addon lists (the cache doesn't keep
  // them): count what it does keep. With 0 here, "Only 1 source after filtering" lost its
  // "Harbor dropped N results" line and the "Show everything anyway" button.
  const rawSeen = (result?.raw.addon.length ?? 0) + (result?.raw.library.length ?? 0);
  const rawCount = rawSeen > 0 || !result ? rawSeen : result.picker.all.length + result.rejected.length;
  const addonCount = useMemo(() => {
    if (!filteredPicker) return 0;
    return new Set(filteredPicker.all.map((s) => s.addonId)).size;
  }, [filteredPicker]);
  const addonLogoMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of addons ?? []) m.set(a.manifest.id, resolveAddonLogo(a.manifest.logo, a.transportUrl));
    return m;
  }, [addons]);
  const lookupLogo = (id: string): string | null => addonLogoMap.get(id) ?? null;
  const usedAddons = useMemo(() => {
    if (!filteredPicker) return [];
    const seen = new Map<string, { id: string; name: string; logo: string | null }>();
    for (const s of filteredPicker.all) {
      if (seen.has(s.addonId)) continue;
      seen.set(s.addonId, { id: s.addonId, name: s.addonName, logo: addonLogoMap.get(s.addonId) ?? null });
    }
    return [...seen.values()];
  }, [filteredPicker, addonLogoMap]);
  const backdropSrc = episode?.still || meta.background || meta.poster;

  const [maxWaitElapsed, setMaxWaitElapsed] = useState(false);
  useEffect(() => {
    setMaxWaitElapsed(false);
    const t = window.setTimeout(() => setMaxWaitElapsed(true), 30_000);
    return () => window.clearTimeout(t);
  }, [streamIds]);
  const addonsSettled = pipelineDone || maxWaitElapsed;

  const noStreamIds = addonsSettled && (!streamIds || streamIds.length === 0);
  const noDebrids = addonsSettled && !!streamIds && streamIds.length > 0 && debrids.length === 0;
  const noResults =
    addonsSettled && !!streamIds && streamIds.length > 0 && allCount === 0 && debrids.length > 0;
  const terminalEmpty = noStreamIds || noDebrids || noResults;
  const [stubBanner, setStubBanner] = useState<string | null>(null);
  useEffect(() => {
    const ev = consumeRecentStubEvent(8000);
    if (!ev) return;
    setStubBanner(
      "Last source wasn't actually cached on your debrid yet. Pick another from the list.",
    );
    const t = window.setTimeout(() => setStubBanner(null), 6000);
    return () => window.clearTimeout(t);
  }, [streamIds]);
  useEffect(() => {
    if (
      autoPlay &&
      pipelineDone &&
      autoCandidates.length === 0 &&
      !autoExhausted &&
      !autoCancelled
    ) {
      setAutoExhausted(true);
    }
  }, [autoPlay, pipelineDone, autoCandidates.length, autoExhausted, autoCancelled]);

  const engineWarming = isEngineWarmingError(resolveError);
  useEffect(() => {
    if (!engineWarming) return;
    let alive = true;
    const clear = () => {
      if (alive) setResolveError(null);
    };
    const poll = async () => {
      const status = await torrentEngineStatus();
      if (status?.ready) clear();
    };
    void poll();
    const id = window.setInterval(() => void poll(), 1500);
    const cap = window.setTimeout(clear, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearTimeout(cap);
    };
  }, [engineWarming, setResolveError]);

  const showAutoTransition =
    !resolveError &&
    ((autoActive && (streamIds === null || loading || autoCandidates.length > 0)) ||
      resolving != null);
  void terminalEmpty;

  const noSourcesConfigured =
    addons !== null && addons.length === 0 && debrids.length === 0;

  // Android: the picker drawn natively (see @/views/native/native-screens), in either layout:
  // - Stremio style: the title, the addons and qualities to pick (with their counts) and Refresh,
  //   then each source (the addon's logo, name, description, labels, Play), the addons still
  //   answering;
  // - the other layout: what was found, the big card of the picked source, "Switch quality" and
  //   every source in the drawer (native-blocks.ts);
  // - in both, the search's breathing logo, the empty ladder's messages, and the full-screen steps
  //   (connecting, peer-to-peer, debrid down, nothing played, saving offline, no sources yet).
  const tt = useT();
  const stremioNative = settings.pickerLayout === "stremio" || isDownload;
  const listed = stremioNative && filteredPicker ? displayStreams : [];
  const preserve = addonOrderMode || !!hostMatch;
  const src = useStremioSources(listed, addons, preserve);
  const logoOf = (s: ScoredStream) =>
    src.addonLogoMap.get(s.addonUrl ?? "") ?? src.addonLogoMap.get(s.addonId) ?? addonLogoSrc(s.addonId, s.addonName ?? "") ?? null;
  const toData = useAssetDataUrls(src.visibleStreams.map(logoOf));
  const waiting = pendingAddons(addons, listed);
  const [drawerAddon, setDrawerAddon] = useState("all");
  const [diagOpen, setDiagOpen] = useState(false);
  const [p2pRemember, setP2pRemember] = useState(false);
  const drawerOptions = useMemo(() => buildAddonOptions(displayStreams), [displayStreams]);
  useEffect(() => {
    if (drawerAddon !== "all" && !drawerOptions.some((o) => o.id === drawerAddon)) setDrawerAddon("all");
  }, [drawerOptions, drawerAddon]);
  const drawerShown = useMemo(
    () => (drawerAddon === "all" ? displayStreams : displayStreams.filter((s) => addonInstanceKey(s) === drawerAddon)).slice(0, 80),
    [displayStreams, drawerAddon],
  );
  const panelAct = (a: PanelAction | null) => {
    if (a === "library") openSettings("library");
    else if (a === "streaming") openSettings("streaming");
    else if (a === "showAll") setForceShowAll(true);
    else if (a === "wider") {
      if (strictMode) setStrictMode(false);
      else setForceShowAll(true);
    }
  };
  const pick = useMemo(() => !stremioNative && !loading && currentPick
    ? pickBlock({
        meta,
        episode,
        stream: currentPick,
        debrids,
        addonLogo: lookupLogo(currentPick.addonId),
        resolving: resolving?.stream === currentPick,
        queued: currentPick.infoHash != null && queuedHash === currentPick.infoHash,
        inSession,
        isPreviouslyPlayed: previousMatch === currentPick,
        match: matchFor(currentPick),
        showFilename: !!settings.pickerShowFilename,
        showBadges: !!settings.showQualityBadge,
      })
    : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stremioNative, loading, currentPick, meta, episode, debrids, resolving, queuedHash, inSession, previousMatch, matchFor, settings.pickerShowFilename, settings.showQualityBadge, addonLogoMap]);
  const pickerRows = useMemo<NativeRowInput[]>(() => {
    const out: NativeRowInput[] = [];
    const card = (key: string, c: { title: string; sub?: string | null; kicker?: string; tone?: "plain" | "danger" | "accent"; busy?: boolean; icon?: string }) =>
      out.push({ key, title: "", kind: "action", metas: [], cards: [{ title: c.title, sub: c.sub ?? null, kicker: c.kicker, tone: c.tone ?? "plain", busy: c.busy, icon: c.icon }] });
    const block = (key: string, pk: Record<string, unknown>, onPk?: (what: string, i: number) => void) =>
      out.push({ key, title: "", kind: "pk", metas: [], pk, onPk });
    if (hostSourceForMedia) {
      const h = hostCard(hostSourceForMedia);
      card("host", { kicker: h.kicker, title: h.title, sub: h.sub, tone: "accent", icon: "crown" });
    }
    if (isDownload) card("download", { title: tt("Choose a source to save offline. You can track progress on the Downloads page."), icon: "download" });
    if (stubBanner) card("stub", { title: stubBanner, icon: "alert" });
    if (!addonsSettled && (!filteredPicker || filteredPicker.all.length === 0)) block("pk-loader", loaderBlock(meta));
    for (const p of ladderPanels({
      meta,
      result,
      addonsSettled,
      pipelineDone,
      streamIds,
      debridCount: debrids.length,
      addonCount: addons?.length ?? 0,
      allCount,
      rawCount,
      strictMode,
      forceShowAll,
      theatres: stillInTheatres(meta, result, allCount, rawCount),
    })) {
      block(p.key, p.pk, () => panelAct(p.action));
    }
    if (stremioNative) {
      if (src.visibleStreams.length > 0) {
        out.push({
          key: "sources",
          title: "",
          kind: "sources",
          metas: [],
          cards: src.visibleStreams.map((s) => {
            const raw = s.title?.trim() || s.description?.trim() || "";
            const failed = failedStreams.has(s);
            return {
              title: s.name?.trim() || s.addonName || "Source",
              desc: (settings.fullStreamDescription ? raw : condenseDescription(raw)) || null,
              img: [toData(logoOf(s))].filter((u): u is string => !!u),
              kicker: s.addonName ?? null,
              tags: settings.showQualityBadge ? streamBadges(s).map(shortBadge) : [],
              tone: failed ? ("danger" as const) : undefined,
              sub: failed ? tt("Unavailable, try another.") : null,
            };
          }),
          onOpen: (i) => {
            const s = src.visibleStreams[i];
            if (s) playManually(s);
          },
        });
      }
      if (!pipelineDone && listed.length > 0) {
        const n = Math.max(waiting.length, Math.max(0, (addons?.length ?? 0) - addonCount));
        card("pending", {
          title: waiting[0]
            ? `${tt("Waiting for")} ${waiting[0].manifest?.name ?? waiting[0].manifest?.id ?? ""}`
            : n === 1
              ? tt("1 addon loading")
              : n > 1
                ? tt("{n} addons loading", { n })
                : tt("Loading more sources"),
          busy: true,
        });
      }
    } else {
      if (!loading && result) block("pk-diag", diagBlock(result, debrids, diagOpen), () => setDiagOpen((v) => !v));
      if (pick && currentPick) {
        block("pk-pick", pick.pk, () => {
          if (pick.action === "cache") onCache(currentPick);
          else if (pick.action === "play") playManually(currentPick);
        });
      }
      if (!loading && populatedTiers.length > 1 && filteredPicker) {
        block(
          "pk-tiers",
          tiersBlock({
            tiers: populatedTiers,
            selected: selectedTier,
            byTier: filteredPicker.byTier,
            debrids,
            cachedPill: uncachedHiddenCount > 0 ? { on: cachedOnly, hidden: uncachedHiddenCount } : null,
            langPill:
              preferredLangs.length > 0 && langHiddenCount > 0
                ? {
                    on: langFilter,
                    hidden: langHiddenCount,
                    label: abbreviateLanguages(isAnimeRequest ? preferredLangs : preferredLangs.filter((l) => normalizeLangCode(l) !== "ja")),
                  }
                : null,
          }),
          (what, i) => {
            if (what === "tier") {
              const tier = populatedTiers[i];
              if (tier) setSelectedTier(tier);
            } else if (what === "pill:cached") setCachedOnly((v) => !v);
            else if (what === "pill:lang") setLangFilter((v) => !v);
          },
        );
      }
      if (!loading && allCount > 0 && filteredPicker) {
        block(
          "pk-drawer",
          drawerBlock({
            open: drawerOpen,
            count: allCount,
            addonCount,
            usedAddons,
            filter: drawerAddon,
            total: displayStreams.length,
            options: drawerOptions,
          }),
          (what) => {
            if (what === "drawer") setDrawerOpen((o) => !o);
            else if (what.startsWith("filter:")) setDrawerAddon(what.slice(7));
          },
        );
        if (drawerOpen && drawerShown.length > 0) {
          block(
            "pk-streams",
            streamsBlock({
              streams: drawerShown,
              debrids,
              logoOf: lookupLogo,
              matchFor: hostMatch ? matchFor : undefined,
              resolvingId: resolving?.stream.infoHash ?? null,
              showName: meta.name,
              episode,
              showFilename: !!settings.pickerShowFilename,
            }),
            (what, i) => {
              const s = drawerShown[i];
              if (what === "stream" && s) playManually(s);
            },
          );
        }
      }
    }
    if (resolveError) card("error", { title: resolveError, tone: engineWarming ? "plain" : "danger", busy: engineWarming });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tt, isDownload, stubBanner, addonsSettled, filteredPicker, src.visibleStreams, failedStreams, settings.fullStreamDescription, settings.showQualityBadge, settings.pickerShowFilename, pipelineDone, listed.length, waiting.length, addons, addonCount, resolveError, engineWarming, toData, stremioNative, hostSourceForMedia, result, streamIds, debrids, allCount, rawCount, strictMode, forceShowAll, loading, diagOpen, pick, currentPick, populatedTiers, selectedTier, uncachedHiddenCount, cachedOnly, preferredLangs, langHiddenCount, langFilter, isAnimeRequest, drawerOpen, usedAddons, drawerAddon, displayStreams, drawerOptions, drawerShown, hostMatch, resolving, meta, episode]);

  // The full-screen steps, in the page's order, and what their buttons (and Back) do.
  const stage: { model: Record<string, unknown>; onTap: (what: string) => void; back: (() => void) | null } | null = noSourcesConfigured
    ? {
        model: stages.noSources(meta),
        onTap: (w) => (w === "addons" ? setView("addons") : w === "settings" ? openSettings("streaming") : goBack()),
        back: null,
      }
    : p2pConfirm
      ? {
          model: stages.p2p(meta, p2pConfirm.stream, p2pRemember),
          onTap: (w) => {
            if (w === "toggle") setP2pRemember((v) => !v);
            else if (w === "p2p") {
              if (p2pRemember) update({ p2pAutoConsent: true });
              confirmP2p();
            } else cancelP2p();
          },
          back: cancelP2p,
        }
      : showAutoTransition
        ? {
            model: stages.connecting(meta, episode, autoAttemptIdx, !!stubBanner),
            onTap: () => {
              abortResolve();
              setResolving(null);
              setAutoCancelled(true);
            },
            back: null,
          }
        : debridDown
          ? { model: stages.debridDown(meta), onTap: (w) => (w === "retry" ? resetDebridDown() : backToDetail()), back: backToDetail }
          : autoExhausted
            ? {
                model: stages.exhausted(meta, episode),
                onTap: (w) => {
                  if (w === "exit") exitPickerToDetail(meta);
                  else {
                    setAutoCancelled(true);
                    setAutoExhausted(false);
                  }
                },
                back: () => {
                  setAutoCancelled(true);
                  setAutoExhausted(false);
                },
              }
            : downloadConfirm
              ? { model: stages.saving(meta, episode, downloadConfirm.label), onTap: () => backToDetail(), back: backToDetail }
              : null;
  const stageModel = stage?.model ?? null;
  const stageJson = stageModel ? JSON.stringify(stageModel) : null;
  const stableStage = useMemo(() => (stageJson ? (JSON.parse(stageJson) as Record<string, unknown>) : null), [stageJson]);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const pickerNative = useNativeBrowsePage("picker", {
    active: topKind === "picker",
    blocked: false,
    t: tt,
    back: !stableStage,
    onBack: backToDetail,
    noTogether: true,
    stage: stableStage,
    onStage: (what) => stageRef.current?.onTap(what),
    header: {
      kicker: episode
        ? `${meta.name} ${tt("· Season")} ${episode.imdbSeason ?? episode.season} ${tt("· Episode")} ${String(episode.imdbEpisode ?? episode.episode).padStart(2, "0")}`
        : [meta.releaseInfo, ...(meta.genres ?? []).slice(0, 2)].filter(Boolean).join(" · ") || null,
      title: episode ? episode.name || tt("Episode {n}", { n: episode.episode }) : meta.name,
      size: 34,
      body: episode?.overview || null,
      backdrop: backdropSrc ? [backdropSrc] : [],
    },
    chips:
      listed.length > 0
        ? [
            {
              key: "addon",
              items: [
                { id: "all", label: `${tt("All sources")}  ${listed.length}`, on: src.filter === "all" },
                ...src.addonOptions.map((o) => ({ id: o.id, label: `${o.name}  ${o.count}`, on: src.filter === o.id })),
                { id: "refresh", label: `⟳  ${tt("Refresh")}`, on: false },
              ],
            },
            ...(src.qualityOptions.length > 1
              ? [
                  {
                    key: "quality",
                    items: [
                      { id: "all", label: `${tt("All")}  ${src.addonFiltered.length}`, on: src.quality === "all" },
                      ...src.qualityOptions.map((o) => ({ id: o.tier, label: `${o.tier}  ${o.count}`, on: src.quality === o.tier })),
                    ],
                  },
                ]
              : []),
          ]
        : [{ key: "addon", items: [{ id: "refresh", label: `⟳  ${tt("Refresh")}`, on: false }] }],
    onChip: (group, id) => {
      if (id === "refresh") refresh();
      else if (group === "addon") src.setFilter(id);
      else if (group === "quality") src.setQuality(id);
    },
    rows: pickerRows,
  });
  // The steps' Back, as their pop-ups on the page do it (they aren't mounted while it's native).
  useCloseOnAndroidBack(pickerNative && !!stage?.back, () => stageRef.current?.back?.());
  // "Saving to Downloads" goes back to the title by itself, as on the page.
  useEffect(() => {
    if (!pickerNative || !downloadConfirm) return;
    const id = window.setTimeout(() => backToDetail(), 1500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerNative, downloadConfirm]);
  void qualityTier;

  if (pickerNative) return <main className="absolute inset-0 z-50 overflow-hidden bg-canvas" />;

  if (noSourcesConfigured) {
    return <NoSourcesConfiguredModal meta={meta} />;
  }

  if (p2pConfirm) {
    return (
      <P2pConfirmModal
        meta={meta}
        stream={p2pConfirm.stream}
        onConfirm={(remember) => {
          if (remember) update({ p2pAutoConsent: true });
          confirmP2p();
        }}
        onCancel={cancelP2p}
      />
    );
  }

  if (showAutoTransition) {
    return (
      <AutoPlayTransition
        meta={meta}
        episode={episode}
        resolving={resolving != null}
        attemptIdx={autoAttemptIdx}
        onCancel={() => {
          abortResolve();
          setResolving(null);
          setAutoCancelled(true);
        }}
      />
    );
  }

  if (debridDown) {
    return (
      <DebridDownModal
        meta={meta}
        onTryAgain={resetDebridDown}
        onBack={() => backToDetail()}
      />
    );
  }

  if (autoExhausted) {
    return (
      <AutoExhaustedModal
        meta={meta}
        episode={episode}
        onBrowseManually={() => {
          setAutoCancelled(true);
          setAutoExhausted(false);
        }}
      />
    );
  }

  if (downloadConfirm) {
    return (
      <DownloadStarted
        meta={meta}
        episode={episode}
        label={downloadConfirm.label}
        onDone={backToDetail}
      />
    );
  }

  return (
    <main className="absolute inset-0 z-50 overflow-y-auto bg-canvas">
      <BackdropLayer src={backdropSrc} />

      <div aria-hidden data-tauri-drag-region={fs ? "false" : "true"} className="absolute inset-x-0 top-0 z-10 h-20" />

      <div className={`relative mx-auto flex min-h-full w-full max-w-5xl flex-col ${isPhoneLayout() ? "gap-6 px-4 pb-16 pt-20" : "gap-12 px-12 pb-32 pt-32"}`}>
        <PickerHeader meta={meta} episode={episode} onBack={backToDetail} onRefresh={refresh} refreshing={loading} />

        {hostSourceForMedia && <HostSourceBanner source={hostSourceForMedia} />}

        {isDownload && (
          <div className="rounded-2xl border border-edge-soft bg-elevated/60 px-5 py-3.5 text-[13.5px] text-ink-muted">
            {t("Choose a source to save offline. You can track progress on the Downloads page.")}
          </div>
        )}

        {stubBanner && (
          <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-5 py-4 text-[13.5px] text-amber-100">
            {stubBanner}
          </div>
        )}

        {!addonsSettled && (!filteredPicker || filteredPicker.all.length === 0) && (
          <CinematicLoader meta={meta} />
        )}

        <PickerEmptyLadder
          meta={meta}
          result={result}
          addonsSettled={addonsSettled}
          pipelineDone={pipelineDone}
          streamIds={streamIds}
          debridCount={debrids.length}
          addonCount={addons?.length ?? 0}
          allCount={allCount}
          rawCount={rawCount}
          strictMode={strictMode}
          forceShowAll={forceShowAll}
          onOpenLibrarySettings={() => openSettings("library")}
          onOpenStreamingSettings={() => openSettings("streaming")}
          onShowAll={() => setForceShowAll(true)}
          onSearchWider={() => {
            if (strictMode) setStrictMode(false);
            else setForceShowAll(true);
          }}
        />

        {(settings.pickerLayout === "stremio" || isDownload) && filteredPicker && filteredPicker.all.length > 0 ? (
          <StremioLayout
            streams={displayStreams}
            addons={addons}
            pipelineDone={pipelineDone}
            loadingAddonCount={Math.max(0, (addons?.length ?? 0) - addonCount)}
            failedStreams={failedStreams}
            preserveOrder={addonOrderMode || !!hostMatch}
            matchFor={hostMatch ? matchFor : undefined}
            onPlay={playManually}
          />
        ) : (
          <>
            {!loading && result && (
              <SourceDiagnostic result={result} debrids={debrids} />
            )}

            {!loading && currentPick && (
              <PrimaryCard
                meta={meta}
                episode={episode}
                stream={currentPick}
                debrids={debrids}
                addonLogo={lookupLogo(currentPick.addonId)}
                onPlay={() => playManually(currentPick)}
                onCache={() => onCache(currentPick)}
                resolving={resolving?.stream === currentPick}
                queued={
                  currentPick.infoHash != null && queuedHash === currentPick.infoHash
                }
                inSession={inSession}
                isPreviouslyPlayed={previousMatch === currentPick}
                match={matchFor(currentPick)}
              />
            )}

            {!loading && populatedTiers.length > 1 && filteredPicker && (
              <TierStrip
                tiers={populatedTiers}
                selected={selectedTier}
                onSelect={setSelectedTier}
                byTier={filteredPicker.byTier}
                debrids={debrids}
                langFilterSlot={
                  <div className="ml-auto flex items-center gap-2">
                    {uncachedHiddenCount > 0 && (
                      <CachedFilterPill
                        on={cachedOnly}
                        hiddenCount={uncachedHiddenCount}
                        onToggle={() => setCachedOnly((v) => !v)}
                      />
                    )}
                    {preferredLangs.length > 0 && langHiddenCount > 0 && (
                      <LanguageFilterPill
                        languages={preferredLangs}
                        on={langFilter}
                        hiddenCount={langHiddenCount}
                        onToggle={() => setLangFilter((v) => !v)}
                        isAnime={isAnimeRequest}
                      />
                    )}
                  </div>
                }
              />
            )}

            {!loading && allCount > 0 && filteredPicker && (
              <SourceDrawer
                open={drawerOpen}
                onToggle={() => setDrawerOpen((o) => !o)}
                count={allCount}
                addonCount={addonCount}
                usedAddons={usedAddons}
                streams={displayStreams}
                debrids={debrids}
                getAddonLogo={lookupLogo}
                matchFor={hostMatch ? matchFor : undefined}
                onPlay={playManually}
                resolvingId={resolving?.stream.infoHash ?? null}
                showName={meta.name}
                episode={episode}
              />
            )}
          </>
        )}

        {resolveError && engineWarming && (
          <div className="flex items-center gap-3 rounded-2xl border border-edge-soft/60 bg-elevated/40 px-5 py-4 text-[13.5px] text-ink-muted">
            <Loader2 size={16} className="shrink-0 animate-spin text-ink-subtle" />
            <span>{resolveError}</span>
          </div>
        )}
        {resolveError && !engineWarming && (
          <div className="rounded-2xl border border-danger/30 bg-danger/15 px-5 py-4 text-[13.5px] text-ink">
            {resolveError}
          </div>
        )}
      </div>
    </main>
  );
}


/** A format label as short as the page's badge reads (4K, HDR10+, DV, Atmos…). */
function shortBadge(kind: string): string {
  const map: Record<string, string> = {
    "8k": "8K",
    "4k-uhd": "4K",
    uhd: "UHD",
    "2k-qhd": "2K",
    hdr10: "HDR10",
    "hdr10-plus": "HDR10+",
    dv: "DV",
    hdr: "HDR",
    hlg: "HLG",
    sdr: "SDR",
    atmos: "Atmos",
    "atmos-912": "Atmos 9.1.2",
    truehd: "TrueHD",
    "dts-hd": "DTS-HD",
    "dts-hd-ma": "DTS-HD MA",
    "dts-x": "DTS:X",
    dts: "DTS",
    dd: "DD",
    ddp: "DD+",
    ac3: "AC3",
    eac3: "EAC3",
    webdl: "WEB-DL",
    webrip: "WEBRip",
    bluray: "BluRay",
    remux: "REMUX",
    hevc: "HEVC",
    av1: "AV1",
    imax: "IMAX",
    "3d": "3D",
  };
  return map[kind] ?? kind.toUpperCase();
}
