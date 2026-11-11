import { useEffect, useMemo, useRef } from "react";
import { androidApi, isAndroidApp, onNativePlayerEvent } from "@/lib/android";
import { peekPickerCache } from "@/lib/picker-cache";
import type { ScoredStream } from "@/lib/streams/types";
import type { SkipSegment } from "@/lib/skip-intro";
import type { PlayerSrc, PlayerStreamRef, PlayEpisode } from "@/lib/view";
import { t } from "@/lib/i18n";
import { badgeLabel, streamBadges } from "@/components/format-badge";
import { streamKey } from "@/components/player/stream-switcher/switcher-row";
import { qualityKey, QUALITY_LABEL } from "@/components/player/stream-switcher/quality";
import { formatBytes } from "@/lib/together/source-descriptor";
import { useSettings } from "@/lib/settings";

const FLAG_EMOJI_RX = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const clean = (s: string) =>
  s.replace(FLAG_EMOJI_RX, "").split("\n").map((l) => l.replace(/\s{2,}/g, " ").trim()).filter(Boolean);

function send(cmd: Record<string, unknown>) {
  androidApi()?.command(JSON.stringify(cmd));
}

/**
 * Is this the stream that is playing? Told by what the player remembers of it (its torrent,
 * or its addon and title): the playing URL is the resolved link, which is rarely the addon's
 * own URL, so comparing URLs almost never marked a row.
 */
function isPlaying(s: ScoredStream, ref: PlayerStreamRef | undefined, liveUrl: string): boolean {
  if (ref?.infoHash) {
    return s.infoHash?.toLowerCase() === ref.infoHash.toLowerCase() && (!ref.addonId || s.addonId === ref.addonId);
  }
  if (ref?.addonId && ref.title) return !s.infoHash && s.addonId === ref.addonId && s.title === ref.title;
  return !!s.url && s.url === liveUrl;
}

/** One row of the native stream list. */
function toItem(s: ScoredStream, ref: PlayerStreamRef | undefined, liveUrl: string) {
  const name = clean(s.name?.trim() || s.addonName || "Source").join(" · ");
  const lines = clean(s.title?.trim() || s.description?.trim() || "");
  // Addons often put size / seeders in the title already; only add what's missing.
  const text = lines.join(" ");
  const hasSize = /\d(?:[.,]\d+)?\s?(?:GB|MB|GiB|MiB)\b/i.test(text);
  const hasSeeders = /👤|seed/i.test(text);
  const extra = [
    s.size && !hasSize ? formatBytes(s.size) : null,
    s.seeders != null && !hasSeeders ? `👤 ${s.seeders}` : null,
    s.addonName && !name.toLowerCase().includes(s.addonName.toLowerCase()) ? s.addonName : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const q = qualityKey(s);
  return {
    key: streamKey(s),
    name,
    desc: [...lines.slice(0, 3), extra].filter(Boolean).join("\n"),
    badges: streamBadges(s).filter((b) => b !== "no-label" && b !== "unknown").slice(0, 4).map(badgeLabel).join(" · "),
    quality: QUALITY_LABEL[q] ?? q,
    cached: Object.values(s.cached ?? {}).some(Boolean),
    current: isPlaying(s, ref, liveUrl),
  };
}

/**
 * Android app: feeds the native player what only the web side knows (title / episode, whether
 * there's a next episode, the title's stream list) and runs its requests (switch stream,
 * next episode).
 */
export function useAndroidPlayerExtras(params: {
  src: PlayerSrc;
  liveUrl: string;
  /** What the player remembers of the stream that is playing (marks its row in the list). */
  streamRef: PlayerStreamRef | undefined;
  /** "4K · Dolby Vision · TrueHD 7.1" from the stream's name (the player shows what it
   *  actually decodes once it knows; this is the first guess). */
  quality: string | null;
  swapResolvingKey: string | null;
  onSwitchStream: (s: ScoredStream) => void;
  nextEp: PlayEpisode | null;
  goNext: () => void;
}) {
  const { src, liveUrl, swapResolvingKey, nextEp, quality } = params;
  const { settings } = useSettings();
  const showQuality = settings.showQualityInfo === true;
  const latest = useRef(params);
  latest.current = params;
  const enabled = isAndroidApp();

  // Title line + episode line + next-episode availability.
  const ep = src.episode;
  const subtitle = ep ? `S${ep.season} · E${ep.episode}${ep.name ? ` · ${ep.name}` : ""}` : "";
  const title = src.meta.name ?? src.title ?? "";
  useEffect(() => {
    if (!enabled) return;
    send({ cmd: "meta", title, subtitle, hasNext: !!nextEp, showQuality, quality: quality ?? "" });
  }, [enabled, title, subtitle, nextEp, liveUrl, showQuality, quality]);

  // A pick is in flight: report the outcome once the swap settles.
  const pendingRef = useRef<{ key: string; url: string } | null>(null);
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || swapResolvingKey) return;
    pendingRef.current = null;
    if (liveUrl === pending.url) send({ cmd: "streamFailed", key: pending.key });
  }, [swapResolvingKey, liveUrl]);

  useEffect(() => {
    if (!enabled) return;
    return onNativePlayerEvent((e) => {
      const cur = latest.current;
      if (e.type === "requestStreams") {
        const cache = peekPickerCache(cur.src.meta, cur.src.episode);
        const all = (cache?.result.picker.all ?? []).filter(
          (s) => !`${s.addonId} ${s.addonName ?? ""}`.toLowerCase().includes("watchhub"),
        );
        send({
          cmd: "streams",
          items: all.slice(0, 150).map((s) => toItem(s, cur.streamRef, cur.liveUrl)),
          message: all.length === 0 ? t("There is no source list for this title (open it from its page and pick a source).") : "",
        });
      } else if (e.type === "pickStream") {
        const cache = peekPickerCache(cur.src.meta, cur.src.episode);
        const stream = cache?.result.picker.all.find((s) => streamKey(s) === e.key);
        if (!stream) {
          send({ cmd: "streamFailed", key: e.key, message: t("This source is no longer available") });
          return;
        }
        pendingRef.current = { key: e.key, url: cur.liveUrl };
        cur.onSwitchStream(stream);
      } else if (e.type === "next") {
        if (cur.nextEp) cur.goNext();
      }
    });
  }, [enabled]);
}

/**
 * Android app: the page's own skip button is hidden under the native player, so the native
 * player draws one. It gets the intro / recap / credits segments whenever they change (an empty
 * list when there are none), and whether intros are skipped without asking. The list carries the
 * title it belongs to (the key the player is given with play), because it can get there before
 * that title starts and must not act on the one still playing.
 */
export function useAndroidSkipSegments(params: {
  src: PlayerSrc;
  segments: SkipSegment[];
  autoSkipIntro: boolean;
}) {
  const { src, segments, autoSkipIntro } = params;
  const enabled = isAndroidApp();
  // Same shape as the contentKey in use-bridge-load.ts.
  const contentKey = `${src.meta.id}|${src.episode?.season ?? ""}|${src.episode?.episode ?? ""}`;
  // As text, so a list rebuilt with the same segments is not sent again.
  const command = useMemo(
    () =>
      JSON.stringify({
        cmd: "segments",
        contentKey,
        autoSkipIntro,
        segments: segments.map((s) => ({
          kind: s.kind,
          startMs: Math.max(0, Math.round(s.startSec * 1000)),
          endMs: Math.max(0, Math.round(s.endSec * 1000)),
        })),
      }),
    [contentKey, autoSkipIntro, segments],
  );
  useEffect(() => {
    if (!enabled) return;
    androidApi()?.command(command);
  }, [enabled, command]);
  // Leaving the player: nothing is left behind for whatever plays next.
  useEffect(() => {
    if (!enabled) return;
    return () => send({ cmd: "segments", contentKey: "", autoSkipIntro: false, segments: [] });
  }, [enabled]);
}
