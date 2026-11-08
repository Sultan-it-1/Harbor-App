import type { ReactNode } from "react";
import { usePlaybackPositionGated } from "@/lib/player/playback-clock";
import { fmtTime } from "./transport-utils";
import type { TimeFormat } from "@/lib/player-chrome";

export function TimeStart({
  durationSec,
  timeFormat,
  isLiveChannel,
  tight,
  active,
  stremio,
}: {
  durationSec: number;
  timeFormat?: TimeFormat;
  isLiveChannel: boolean;
  tight?: boolean;
  active: boolean;
  stremio?: boolean;
}): ReactNode {
  const positionSec = usePlaybackPositionGated(active);
  if (isLiveChannel) return null;
  if (stremio) {
    const fmt: TimeFormat = timeFormat ?? "start-end";
    const positionText = fmtTime(positionSec);
    if (fmt === "elapsed-only") {
      return (
        <span className="pointer-events-auto ms-2 shrink-0 font-medium tabular-nums text-[14px] text-white/90">
          {positionText}
        </span>
      );
    }
    const remaining = Math.max(0, (durationSec ?? 0) - positionSec);
    const endText = fmt === "remaining" ? `-${fmtTime(remaining)}` : fmtTime(durationSec ?? 0);
    return (
      <span className="pointer-events-auto ms-2 shrink-0 font-medium tabular-nums text-[14px] text-white/90">
        {positionText}
        <span className="mx-1 text-white/55">/</span>
        {endText}
      </span>
    );
  }
  if (tight) return null;
  return (
    <span className="shrink-0 font-mono text-[13px] tabular-nums text-white/85 drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]">
      {fmtTime(positionSec)}
    </span>
  );
}

export function TimeEnd({
  durationSec,
  timeFormat,
  isLiveChannel,
  tight,
  active,
}: {
  durationSec: number;
  timeFormat?: TimeFormat;
  isLiveChannel: boolean;
  tight?: boolean;
  active: boolean;
}): ReactNode {
  const positionSec = usePlaybackPositionGated(active);
  if (isLiveChannel || tight) return null;
  const fmt: TimeFormat = timeFormat ?? "start-end";
  if (fmt === "elapsed-only") return null;
  const duration = durationSec ?? 0;
  const text =
    fmt === "remaining" ? `-${fmtTime(Math.max(0, duration - positionSec))}` : fmtTime(duration);
  return (
    <span className="shrink-0 font-mono text-[13px] tabular-nums text-white/65 drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]">
      {text}
    </span>
  );
}
