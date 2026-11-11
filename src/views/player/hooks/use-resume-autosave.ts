import { useEffect, useRef } from "react";
import { profileFromMeta } from "@/lib/discover/profile";
import { trackEvent } from "@/lib/discover/store";
import { isExternalPlaylistId } from "@/lib/iptv/vod";
import { saveLocalCw } from "@/lib/local-cw";
import { isManuallyWatched, setManualWatched } from "@/lib/manual-watched";
import { savePlayback } from "@/lib/playback-history";
import { saveResumeMs } from "@/lib/resume";
import { markTitleWatched } from "@/lib/watched-marks";
import type { PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackPosition, subscribePlaybackClock } from "@/lib/player/playback-clock";
import type { PlayerSrc } from "@/lib/view";
import { CLOUD_OK } from "@/lib/stremio";
import { isSwapOnTrial, PLACEHOLDER_MAX_SEC } from "@/lib/player/swap-state";
import { MIN_PLAYED_MS, usePlayedTime } from "./use-played-time";

/** Don't save progress from a placeholder clip or a just-switched source that hasn't started:
 *  it would overwrite where you really were. */
function unreliable(sn: PlayerSnapshot): boolean {
  return isSwapOnTrial() || (sn.durationSec > 0 && sn.durationSec < PLACEHOLDER_MAX_SEC);
}

const TICK_MS = 4000;
const MIN_POSITION_SEC = 5;
const TASTE_MIN_SEC = 90;
const WATCHED_RATIO = 0.85;

export function useResumeAutosave(params: {
  src: PlayerSrc;
  snap: PlayerSnapshot;
  season: number | undefined;
  episode: number | undefined;
}) {
  const { src, snap, season, episode } = params;
  const lastSavedRef = useRef(0);
  const taughtRef = useRef<Set<string>>(new Set());
  const latestRef = useRef({ src, snap, season, episode });
  latestRef.current = { src, snap, season, episode };
  const lastGoodPosRef = useRef(0);
  const played = usePlayedTime(snap.status, `${src.url}|${src.meta.id}|${season}|${episode}`);

  useEffect(() => {
    lastGoodPosRef.current = 0;
  }, [src.url, src.meta.id, season, episode]);

  useEffect(
    () =>
      subscribePlaybackClock(() => {
        const pos = getPlaybackPosition();
        if (pos >= MIN_POSITION_SEC && !unreliable(latestRef.current.snap)) lastGoodPosRef.current = pos;
      }),
    [],
  );

  const record = (s: PlayerSrc, sn: PlayerSnapshot, se?: number, ep?: number): void => {
    const id = s.meta.id;
    if (!id || id.startsWith("iptv:")) return;
    if (unreliable(sn)) return;
    // A stream that failed or never really got going leaves nothing behind (Continue Watching
    // would show a title you couldn't watch, with a progress and time left made up of the attempt).
    if (sn.status === "error" || sn.durationSec <= 0 || played.current < MIN_PLAYED_MS) return;
    const pos = getPlaybackPosition() || lastGoodPosRef.current;
    if (pos < MIN_POSITION_SEC) return;
    lastSavedRef.current = pos * 1000;
    saveResumeMs(id, pos * 1000, se, ep, sn.durationSec * 1000);
    if (isExternalPlaylistId(id)) return;
    if (s.streamRef) {
      savePlayback(id, { ...s.streamRef, url: s.url, title: s.meta.name }, se, ep);
    } else {
      savePlayback(id, { title: s.meta.name, parsedTitle: s.meta.name }, se, ep);
    }
    // A movie watched to (nearly) the end counts as watched: the poster gets its check.
    if (
      s.meta.type === "movie" &&
      typeof se !== "number" &&
      sn.durationSec > 0 &&
      pos / sn.durationSec >= WATCHED_RATIO
    ) {
      markTitleWatched(id);
    }
    if (
      s.meta.type === "series" &&
      typeof se === "number" &&
      typeof ep === "number" &&
      sn.durationSec > 0 &&
      pos / sn.durationSec >= WATCHED_RATIO &&
      !isManuallyWatched(id, se, ep)
    ) {
      setManualWatched(id, se, ep, true);
    }
    if ((s.meta.type === "series" || s.meta.type === "movie") && !CLOUD_OK.test(id)) {
      saveLocalCw({
        id,
        type: s.meta.type,
        name: s.meta.name,
        poster: s.meta.poster,
        background: s.meta.background,
        season: se,
        episode: ep,
        videoId: s.episode?.videoId,
        positionMs: Math.floor(pos * 1000),
        durationMs: Math.max(0, Math.floor(sn.durationSec * 1000)),
        t: Date.now(),
      });
    }
    if (pos < TASTE_MIN_SEC) return;
    const ratio = sn.durationSec > 0 ? pos / sn.durationSec : 0;
    const kind = ratio >= WATCHED_RATIO ? "watched" : "play";
    const key = `${id}|${kind}`;
    if (taughtRef.current.has(key)) return;
    taughtRef.current.add(key);
    trackEvent(id, kind, profileFromMeta(s.meta));
  };

  const persistNow = (force: boolean): void => {
    const { src: s, snap: sn, season: se, episode: ep } = latestRef.current;
    if (s.meta.id?.startsWith("iptv:")) return;
    const pos = getPlaybackPosition() || lastGoodPosRef.current;
    if (pos < MIN_POSITION_SEC) return;
    const ms = pos * 1000;
    if (!force && Math.abs(ms - lastSavedRef.current) < 1500) return;
    record(s, sn, se, ep);
  };

  useEffect(() => {
    if (snap.status !== "playing") return;
    const id = window.setInterval(() => persistNow(false), TICK_MS);
    return () => window.clearInterval(id);
  }, [snap.status]);

  useEffect(() => {
    if (
      snap.status === "playing" ||
      snap.status === "loading" ||
      snap.status === "idle" ||
      snap.status === "ready"
    )
      return;
    persistNow(true);
  }, [snap.status]);

  useEffect(() => {
    const mySeason = season;
    const myEpisode = episode;
    return () => {
      record(latestRef.current.src, latestRef.current.snap, mySeason, myEpisode);
    };
  }, [src.url, src.meta.id, season, episode]);

  useEffect(() => {
    const onUnload = () => persistNow(true);
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);
}
