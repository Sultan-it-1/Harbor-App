import { useEffect, useRef, useState } from "react";
import type { ScoredStream } from "@/lib/streams/types";
import type { SourceDescriptor } from "@/lib/together/protocol";
import { engineP2pEligible } from "@/lib/torrent/stremio-stream";
import { autoPlayFailedHashes, hasInstantMarker, streamMatchesLangs } from "./picker-utils";

const AUTO_SETTLE_MS = 1500;
const HIGH_CONFIDENCE_GRACE_MS = 350;
const HOST_SOURCE_WAIT_MS = 12_000;

export function useAutoFire(args: {
  autoActive: boolean;
  rememberedHandledFirst?: boolean;
  attempt?: number;
  /** The title / episode being picked for (autoPlayMediaKey). */
  mediaKey: string;
  autoCandidates: ScoredStream[];
  resolving: unknown;
  autoAttemptIdx: number;
  autoSettleReady: boolean;
  pipelineDone: boolean;
  firstResultAt: number | null;
  isCached: (s: ScoredStream) => boolean;
  p2pAutoConsent: boolean;
  preferredLangs: string[];
  hasStrongAddon: boolean;
  isTorrentioStream: (s: ScoredStream) => boolean;
  expectHostSource?: boolean;
  hostSource?: SourceDescriptor | null;
  autoFiredRef: React.MutableRefObject<boolean>;
  setAutoSettleReady: (v: boolean) => void;
  setAutoCancelled: (v: boolean) => void;
  onPlay: (s: ScoredStream, committed: boolean, skipP2pConfirm?: boolean) => void;
}): void {
  const {
    autoActive, rememberedHandledFirst, attempt, mediaKey, autoCandidates, resolving, autoAttemptIdx, autoSettleReady,
    pipelineDone, firstResultAt, isCached, p2pAutoConsent, preferredLangs, hasStrongAddon, isTorrentioStream,
    expectHostSource, hostSource,
    autoFiredRef, setAutoSettleReady, setAutoCancelled, onPlay,
  } = args;
  const highConfidenceSinceRef = useRef<number | null>(null);
  const [highConfidenceTick, setHighConfidenceTick] = useState(0);

  const [hostWaitElapsed, setHostWaitElapsed] = useState(false);
  useEffect(() => {
    if (!autoActive || !expectHostSource || hostSource || hostWaitElapsed) return;
    const t = window.setTimeout(() => setHostWaitElapsed(true), HOST_SOURCE_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [autoActive, expectHostSource, hostSource, hostWaitElapsed]);
  const waitingForHostSource = !!expectHostSource && !hostSource && !hostWaitElapsed;

  useEffect(() => {
    if (waitingForHostSource) return;
    if (!autoActive || autoFiredRef.current || pipelineDone || autoSettleReady) return;
    const top = autoCandidates[0];
    const langOk = preferredLangs.length === 0 || (top != null && streamMatchesLangs(top, preferredLangs));
    if (!top || !hasInstantMarker(top) || !isCached(top) || !langOk || (hasStrongAddon && isTorrentioStream(top))) {
      highConfidenceSinceRef.current = null;
      return;
    }
    const t = window.setTimeout(() => setHighConfidenceTick((n) => n + 1), HIGH_CONFIDENCE_GRACE_MS + 20);
    return () => window.clearTimeout(t);
  }, [autoActive, pipelineDone, autoSettleReady, autoCandidates, isCached, preferredLangs, hasStrongAddon, isTorrentioStream, autoFiredRef, waitingForHostSource]);

  useEffect(() => {
    if (!autoActive || autoSettleReady || pipelineDone) return;
    if (firstResultAt == null) return;
    const elapsed = performance.now() - firstResultAt;
    const remaining = Math.max(0, AUTO_SETTLE_MS - elapsed);
    const t = window.setTimeout(() => setAutoSettleReady(true), remaining);
    return () => window.clearTimeout(t);
  }, [autoActive, autoSettleReady, pipelineDone, firstResultAt, setAutoSettleReady]);

  useEffect(() => {
    if (!autoActive || autoFiredRef.current) return;
    if (rememberedHandledFirst) return;
    if (waitingForHostSource) return;
    const top = autoCandidates[0];
    const isFirstAttempt = (attempt ?? 0) === 0 && autoAttemptIdx === 0;
    const langOk = preferredLangs.length === 0 || (top != null && streamMatchesLangs(top, preferredLangs));
    const highConfidenceTop =
      top != null && hasInstantMarker(top) && isCached(top) && langOk &&
      (!hasStrongAddon || !isTorrentioStream(top));
    if (isFirstAttempt && !pipelineDone) {
      if (highConfidenceTop) {
        const now = performance.now();
        if (highConfidenceSinceRef.current == null) highConfidenceSinceRef.current = now;
        if (now - highConfidenceSinceRef.current < HIGH_CONFIDENCE_GRACE_MS) return;
      } else {
        highConfidenceSinceRef.current = null;
        if (!autoSettleReady) return;
      }
    }
    if (autoCandidates.length === 0) return;
    if (resolving) return;
    // `attempt` counts every source the player gave up on, and each one takes a place at the
    // front of the candidates. But a source the player marked dead (a stub) is no longer
    // among them: leaving a place for it too jumped over a good source that was never tried.
    const gone = autoPlayFailedHashes(mediaKey).filter(
      (h) => !autoCandidates.some((s) => s.infoHash?.toLowerCase() === h),
    ).length;
    const idx = Math.min(Math.max(0, (attempt ?? 0) - gone) + autoAttemptIdx, autoCandidates.length - 1);
    const pick = autoCandidates[idx];
    if (!pick) return;
    const pickInstant = isCached(pick) || !!pick.url || (p2pAutoConsent && engineP2pEligible(pick));
    if (!pickInstant) {
      if (pipelineDone) setAutoCancelled(true);
      return;
    }
    autoFiredRef.current = true;
    const p2pConsentPick = !isCached(pick) && !pick.url && p2pAutoConsent && engineP2pEligible(pick);
    onPlay(pick, p2pConsentPick, p2pConsentPick);
  }, [autoActive, rememberedHandledFirst, attempt, mediaKey, autoCandidates, resolving, autoAttemptIdx, autoSettleReady, pipelineDone, isCached, preferredLangs, hasStrongAddon, isTorrentioStream, autoFiredRef, setAutoCancelled, onPlay, highConfidenceTick, waitingForHostSource]);
}
