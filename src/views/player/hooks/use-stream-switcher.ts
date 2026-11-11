import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackPosition, usePlaybackFlag } from "@/lib/player/playback-clock";
import { pinPickerCache, unpinPickerCache } from "@/lib/picker-cache";
import { readResumeMs } from "@/lib/resume";
import { savePlayback } from "@/lib/playback-history";
import { resolveStream } from "@/lib/streams/resolve";
import type { ScoredStream } from "@/lib/streams/types";
import { registerStreamProxy } from "@/lib/stream-proxy";
import type { PlayerSrc } from "@/lib/view";
import type { DebridStore } from "@/lib/debrid/types";
import { androidApi, isAndroidApp } from "@/lib/android";
import { PLACEHOLDER_MAX_SEC, setSwapState } from "@/lib/player/swap-state";
import { formatStreamQuality } from "@/views/play-picker/picker-utils";
// "t" is a trial in this file.
import { t as tr } from "@/lib/i18n";

let checkShownThisSession = false;

/** How long a just-picked source gets to start for real before going back. */
const TRIAL_MS = 40_000;

/** What the player needs to load a source again. */
export type LiveSource = {
  url: string;
  headers?: Record<string, string>;
  subtitles?: PlayerSrc["subtitles"];
  notWebReady?: boolean;
  streamRef?: PlayerSrc["streamRef"];
};

type Trial = {
  /** The source to go back to if this one turns out bad. */
  prev: LiveSource;
  stream: ScoredStream;
  url: string;
  /** Where you were when you switched (where going back resumes). */
  resumeAt: number;
  /** Where the new source starts; "really playing" = moving past it. */
  startedFrom: number;
  at: number;
};

export function useStreamSwitcher(params: {
  bridgeRef: RefObject<PlayerBridge | null>;
  src: PlayerSrc;
  snap: PlayerSnapshot;
  debrids: DebridStore[];
}) {
  const { bridgeRef, src, snap, debrids } = params;

  const checkShownRef = useRef(false);
  const [streamCheckOpen, setStreamCheckOpen] = useState(false);
  const isLive = src.meta.id?.startsWith("iptv:") ?? false;
  const startedEnough = usePlaybackFlag(() => getPlaybackPosition() >= 1.5);
  useEffect(() => {
    checkShownRef.current = false;
    setStreamCheckOpen(false);
  }, [src.url]);
  useEffect(() => {
    if (checkShownRef.current) return;
    if (checkShownThisSession) return;
    if (isLive) return;
    if (snap.status !== "playing" || !startedEnough) return;
    checkShownRef.current = true;
    checkShownThisSession = true;
    setStreamCheckOpen(true);
  }, [snap.status, startedEnough, src.url, isLive]);
  useEffect(() => {
    if (!streamCheckOpen) return;
    const t = window.setTimeout(() => setStreamCheckOpen(false), 5500);
    return () => window.clearTimeout(t);
  }, [streamCheckOpen]);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [swapResolvingKey, setSwapResolvingKey] = useState<string | null>(null);
  const [liveUrl, setLiveUrl] = useState(src.url);
  const [liveStreamRef, setLiveStreamRef] = useState(src.streamRef);
  // What the playing source needs to be loaded again (to go back to it after a bad pick).
  const liveRef = useRef<LiveSource>({ url: src.url, headers: src.headers, subtitles: src.subtitles, notWebReady: src.notWebReady, streamRef: src.streamRef });
  const trialRef = useRef<Trial | null>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useEffect(() => {
    setLiveUrl(src.url);
    setLiveStreamRef(src.streamRef);
    liveRef.current = { url: src.url, headers: src.headers, subtitles: src.subtitles, notWebReady: src.notWebReady, streamRef: src.streamRef };
    trialRef.current = null;
    setSwapState({ swapped: false, onTrial: false });
  }, [src.url, src.streamRef, src.headers, src.subtitles, src.notWebReady]);
  useEffect(() => () => setSwapState({ swapped: false, onTrial: false }), []);

  const swapAcRef = useRef<AbortController | null>(null);

  // Pin this item's streams in the picker cache for the whole playback session
  // so they survive the 30-min stale sweep. Without this, opening the switcher
  // after watching a while found a cold cache and fell back to the full picker.
  useEffect(() => {
    pinPickerCache(src.meta, src.episode);
    return () => unpinPickerCache(src.meta, src.episode);
  }, [src.meta, src.episode]);

  // Always open the in-place switcher overlay. NEVER navigate to the full
  // picker from here: that unmounts the player and stops the movie, which is
  // the "switching stream kicked me out of the movie" bug. The pinned cache
  // above keeps this item's streams available for the overlay.
  const pickAnother = useCallback(() => {
    setSwitcherOpen(true);
  }, []);

  const remember = useCallback(
    (url: string, stream: ScoredStream) => {
      if (!src.meta.id || src.meta.id.startsWith("iptv:")) return;
      savePlayback(
        src.meta.id,
        {
          infoHash: stream.infoHash ?? null,
          fileIdx: stream.fileIdx ?? null,
          addonId: stream.addonId ?? null,
          url,
          title: src.meta.name,
          parsedTitle: stream.parsedTitle ?? null,
          resolution: stream.resolution ?? null,
          source: stream.source ?? null,
          size: stream.size ?? null,
          bingeGroup: stream.behaviorHints?.bingeGroup ?? null,
          cachedSlugs: Object.entries(stream.cached ?? {})
            .filter(([, v]) => v === true)
            .map(([k]) => k),
        },
        src.episode?.season,
        src.episode?.episode,
      );
    },
    [src.meta.id, src.meta.name, src.episode?.season, src.episode?.episode],
  );

  // A picked source turned out bad (an uncached torrent's placeholder clip, an error, or it
  // never started): go back to the source that was playing, at the spot you switched from.
  const revert = useCallback(
    async (t: Trial, why: "placeholder" | "error" | "timeout") => {
      if (trialRef.current !== t) return;
      trialRef.current = null;
      const prev = t.prev;
      setSwapState({ swapped: prev.url !== src.url, onTrial: false });
      console.warn(`[player] switched source failed (${why}); back to the previous one`);
      void import("@/lib/dead-streams").then(({ markStreamDead, STUB_TTL_MS }) =>
        markStreamDead(
          { infoHash: t.stream.infoHash ?? undefined, fileIdx: undefined, url: t.url, addonId: t.stream.addonId ?? "", title: t.stream.title ?? undefined },
          `swap_${why}`,
          STUB_TTL_MS,
        ),
      );
      androidApi()?.command(
        JSON.stringify({
          cmd: "streamFailed",
          message:
            why === "placeholder"
              ? tr("This source is not ready on your debrid, so you are back on the one you were watching. Ready sources are marked ⚡")
              : why === "timeout"
                ? tr("This source did not start, so you are back on the one you were watching")
                : tr("This source did not play, so you are back on the one you were watching"),
        }),
      );
      const b = bridgeRef.current;
      if (!b) return;
      liveRef.current = prev;
      setLiveUrl(prev.url);
      setLiveStreamRef(prev.streamRef);
      try {
        await b.load({
          url: prev.url,
          subtitles: prev.subtitles,
          notWebReady: prev.notWebReady,
          headers: isAndroidApp() ? prev.headers : undefined,
          startAtSec: t.resumeAt > 5 ? t.resumeAt : undefined,
        });
        await b.play().catch(() => {});
      } catch (e) {
        console.warn("[player] going back to the previous source failed", e);
      }
    },
    [bridgeRef, src.url],
  );

  // Watch a just-switched source until it really plays (long enough to be the actual movie,
  // and moving past where it started); give it 40s.
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = trialRef.current;
      if (!t) return;
      const sn = snapRef.current;
      if (sn.errorCode != null || sn.status === "error") {
        void revert(t, "error");
        return;
      }
      if (sn.durationSec > 0 && sn.durationSec < PLACEHOLDER_MAX_SEC && !isLive) {
        void revert(t, "placeholder");
        return;
      }
      const moving = getPlaybackPosition() >= t.startedFrom + 2;
      if (sn.status === "playing" && (sn.durationSec >= PLACEHOLDER_MAX_SEC || isLive) && moving) {
        trialRef.current = null;
        setSwapState({ swapped: true, onTrial: false });
        remember(t.url, t.stream);
        return;
      }
      if (Date.now() - t.at > TRIAL_MS) void revert(t, "timeout");
    }, 500);
    return () => window.clearInterval(id);
  }, [revert, remember, isLive]);

  const onSwitchStream = useCallback(
    async (stream: ScoredStream) => {
      const key = stream.infoHash ?? stream.url ?? `${stream.addonId}:${stream.title ?? ""}`;
      setSwapResolvingKey(key);
      swapAcRef.current?.abort();
      const ac = new AbortController();
      swapAcRef.current = ac;
      const r = await resolveStream(stream, debrids, ac.signal, true);
      if (ac.signal.aborted) return;
      if (!r.ok) {
        console.warn(`[player] stream swap failed: ${r.code}`);
        setSwapResolvingKey(null);
        return;
      }
      let playUrl = r.data.url;
      // Android: the native player sends the headers itself (no local proxy there).
      const nativeHeaders = isAndroidApp() ? r.data.headers : undefined;
      if (!nativeHeaders && r.data.headers && Object.keys(r.data.headers).length > 0) {
        try {
          const proxied = await registerStreamProxy(r.data.url, r.data.headers);
          playUrl = proxied.url;
        } catch {
          setSwapResolvingKey(null);
          return;
        }
      }
      const b = bridgeRef.current;
      if (!b) {
        setSwapResolvingKey(null);
        return;
      }
      // Going back after a bad pick returns to the last source that actually played.
      const prev = trialRef.current?.prev ?? liveRef.current;
      const current = getPlaybackPosition();
      const savedSec = readResumeMs(src.meta.id, src.episode?.season, src.episode?.episode) / 1000;
      const resumeAt = trialRef.current ? trialRef.current.resumeAt : current > 5 ? current : savedSec;
      const nextRef: PlayerSrc["streamRef"] = {
        infoHash: stream.infoHash ?? null,
        fileIdx: stream.fileIdx ?? null,
        addonId: stream.addonId ?? null,
        title: stream.title ?? null,
        parsedTitle: stream.parsedTitle ?? null,
        resolution: stream.resolution ?? null,
        quality: formatStreamQuality(stream),
        source: stream.source ?? null,
        size: stream.size ?? null,
        bingeGroup: stream.behaviorHints?.bingeGroup ?? null,
        cachedSlugs: Object.entries(stream.cached ?? {})
          .filter(([, v]) => v === true)
          .map(([k]) => k),
      };
      const trial: Trial = { prev, stream, url: playUrl, resumeAt, startedFrom: resumeAt > 5 ? resumeAt : 0, at: Date.now() };
      trialRef.current = trial;
      setSwapState({ swapped: true, onTrial: true });
      liveRef.current = { url: playUrl, headers: nativeHeaders, subtitles: r.data.subtitles, notWebReady: r.data.notWebReady, streamRef: nextRef };
      try {
        await b.load({
          url: playUrl,
          subtitles: r.data.subtitles,
          notWebReady: r.data.notWebReady,
          headers: nativeHeaders,
          startAtSec: resumeAt > 5 ? resumeAt : undefined,
        });
        await b.play().catch(() => {});
      } catch (e) {
        console.warn("[player] stream swap failed", e);
      }
      setLiveUrl(playUrl);
      setLiveStreamRef(nextRef);
      setSwapResolvingKey(null);
      setSwitcherOpen(false);
      checkShownRef.current = false;
      setStreamCheckOpen(false);
    },
    [debrids, bridgeRef, src.meta.id, src.episode?.season, src.episode?.episode],
  );

  useEffect(() => () => swapAcRef.current?.abort(), []);

  return {
    streamCheckOpen,
    setStreamCheckOpen,
    switcherOpen,
    setSwitcherOpen,
    swapResolvingKey,
    liveUrl,
    liveStreamRef,
    liveSourceRef: liveRef,
    pickAnother,
    onSwitchStream,
  };
}
