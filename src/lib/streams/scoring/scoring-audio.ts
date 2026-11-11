import { isAndroidApp } from "@/lib/android";
import type { ParsedStream, ScoreReason } from "../types";

export function audioPoints(s: ParsedStream): ScoreReason {
  if (s.audio.codec === "Atmos") return { signal: "Atmos", delta: 3 };
  if (s.audio.codec === "TrueHD") return { signal: "TrueHD", delta: 2 };
  if (s.audio.codec === "DTS-HD MA") return { signal: "DTS-HD MA", delta: 2 };
  if (s.audio.codec === "DD+") return { signal: "DD+", delta: 1 };
  return { signal: "audio", delta: 0 };
}

export function playabilityPenalty(s: ParsedStream): number {
  let penalty = 0;
  // A desktop WebView can't decode DTS or TrueHD. The Android player can (FFmpeg audio), and
  // there these are the better sources, so they are not marked down.
  if (!isAndroidApp()) {
    if (s.audio.codec === "DTS" || s.audio.codec === "DTS-HD MA") penalty -= 6;
    if (s.audio.codec === "TrueHD") penalty -= 4;
    if (s.container === "mkv" && (s.audio.codec === "DTS" || s.audio.codec === "TrueHD")) penalty -= 3;
  }
  if (s.container === "avi" || s.container === "wmv") penalty -= 8;
  if (s.codec === "AV1") penalty -= 2;
  return penalty;
}
