import { isPhoneLayout } from "@/lib/platform";
import { Play } from "lucide-react";
import { AddonLogo } from "@/components/addon-logo";
import { CopyLinkButton, resolveStreamLink } from "@/components/player/copy-link-button";
import { FormatBadge, streamBadges } from "@/components/format-badge";
import { HostMatchChip } from "@/components/host-match-chip";
import { useSettings } from "@/lib/settings";
import type { ScoredStream } from "@/lib/streams/types";
import { EditionChip } from "./edition-chip";
import { t } from "@/lib/i18n/translate";

const PHONE = isPhoneLayout();

export function StremioRow({
  stream,
  failed,
  addonLogo,
  match = null,
  onPlay,
}: {
  stream: ScoredStream;
  failed: boolean;
  addonLogo: string | null;
  match?: "same" | "close" | null;
  onPlay: () => void;
}) {
  const { settings } = useSettings();
  const full = settings.fullStreamDescription;
  const addonName = stream.addonName ?? "Source";
  const headline = stream.name?.trim() || addonName;
  const rawDescription = stream.title?.trim() || stream.description?.trim() || "";
  const description = full ? rawDescription : condenseDescription(rawDescription);
  const badges = settings.showQualityBadge ? streamBadges(stream) : [];
  const link = resolveStreamLink(stream);
  return (
    <div
      // Phone: the whole card is the play target (a 64px button eats a third of the width).
      onClick={PHONE ? onPlay : undefined}
      className={`flex items-stretch rounded-2xl bg-elevated/40 ring-1 transition-colors ${PHONE ? "cursor-pointer gap-3 p-3.5 active:bg-elevated/70" : "gap-5 p-5"} ${
        failed ? "ring-danger/40 bg-danger/5" : "ring-edge-soft/50"
      }`}
    >
      <div className={`flex shrink-0 flex-col items-center ${PHONE ? "w-[36px] justify-start pt-0.5" : "w-[68px] justify-center"}`}>
        <AddonLogo
          addonId={stream.addonId}
          addonName={addonName}
          manifestLogo={addonLogo}
          size={PHONE ? "md" : "tile"}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
        <p className={`whitespace-pre-line font-semibold leading-snug text-ink ${PHONE ? "text-[14.5px]" : "text-[16px]"}`}>
          {headline}
        </p>
        {description && (
          <p className={`whitespace-pre-line leading-snug text-ink-muted ${PHONE ? "break-words text-[12.5px]" : "text-[14.5px]"}${full ? "" : PHONE ? " line-clamp-4" : " line-clamp-3"}`}>
            {description}
          </p>
        )}
        {(badges.length > 0 || match || stream.edition) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <HostMatchChip match={match} />
            {badges.map((k) => (
              <FormatBadge key={k} kind={k} size="sm" />
            ))}
            <EditionChip stream={stream} />
          </div>
        )}
        {failed && (
          <p className="text-[13px] font-medium text-danger">{t("Unavailable, try another.")}</p>
        )}
      </div>
      <div
        className={`flex shrink-0 items-center gap-2 self-center ${PHONE ? "flex-col-reverse" : ""}`}
        onClick={PHONE ? (e) => e.stopPropagation() : undefined}
      >
        {link && <CopyLinkButton url={link} size={16} className={PHONE ? "h-8 w-8" : "h-9 w-9"} />}
        <button
          onClick={onPlay}
          aria-label={t("Play")}
          className={`flex items-center justify-center rounded-full bg-accent text-canvas transition-transform active:scale-95 hover:opacity-90 ${PHONE ? "h-11 w-11" : "h-16 w-16"}`}
        >
          <Play size={PHONE ? 19 : 26} fill="currentColor" className="ml-0.5" />
        </button>
      </div>
    </div>
  );
}

export function condenseDescription(text: string): string {
  if (!text) return "";
  const [first, ...rest] = text.split("\n");
  const head = first.length > 90 ? first.slice(0, 90).trimEnd() + "…" : first;
  return [head, ...rest].join("\n");
}
