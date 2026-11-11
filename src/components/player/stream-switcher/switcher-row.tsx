import { Loader2, Zap } from "lucide-react";
import { AddonLogo } from "@/components/addon-logo";
import { CopyLinkButton, resolveStreamLink } from "@/components/player/copy-link-button";
import { FlagStack } from "@/components/flag";
import { FormatBadge, streamBadges } from "@/components/format-badge";
import type { ScoredStream } from "@/lib/streams/types";
import { useT } from "@/lib/i18n";

export function streamKey(s: ScoredStream): string {
  // The play link first: several rows can share one torrent (two debrid links, the files of a
  // season pack), and a key made of the hash alone made a tap on the second play the first.
  if (s.url) return `u:${s.url}`;
  if (s.infoHash) return `h:${s.infoHash.toLowerCase()}:${s.fileIdx ?? ""}`;
  return `${s.addonId}:${s.title ?? ""}`;
}

const FLAG_EMOJI_RX = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
function stripFlagEmoji(s: string): string {
  return s.replace(FLAG_EMOJI_RX, "").replace(/\s{2,}/g, " ").trim();
}

export function SwitcherRow({
  stream,
  addonLogo,
  onPick,
  resolving,
  divider,
  isCurrent,
  match,
}: {
  stream: ScoredStream;
  addonLogo: string | null;
  onPick: () => void;
  resolving: boolean;
  divider: boolean;
  isCurrent: boolean;
  match?: "same" | "close" | null;
}) {
  const t = useT();
  const addonName = stream.addonName ?? t("Source");
  const headline = stripFlagEmoji(stream.name?.trim() || addonName) || addonName;
  const description = stripFlagEmoji(stream.title?.trim() || stream.description?.trim() || "");
  const cornerBadges = streamBadges(stream);
  const langs = stream.audioLanguages ?? [];
  const link = resolveStreamLink(stream);
  const filterReason = stream.reasons?.find((r) => r.signal.startsWith("filtered:"))?.signal.slice(9);

  return (
    <li className={divider ? "border-t border-edge-soft/60" : ""}>
      <div
        className={`group relative flex w-full items-center px-5 py-3 text-start transition-colors ${
          isCurrent
            ? "cursor-default bg-canvas/40"
            : "hover:bg-canvas/55"
        } ${resolving ? "cursor-wait opacity-60" : ""}`}
      >
        <button
          className="absolute inset-0"
          onClick={() => {
            if (!resolving && !isCurrent) onPick();
          }}
          aria-label={headline}
        />
        <div className="pointer-events-none relative flex flex-1 items-center gap-3.5 min-w-0">
        <AddonLogo
          addonId={stream.addonId}
          addonName={addonName}
          manifestLogo={addonLogo}
          size="xl"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="whitespace-pre-line text-[14px] font-semibold leading-snug text-ink">
            {headline}
          </p>
          {description && (
            <p className="whitespace-pre-line text-[12.5px] leading-snug text-ink-muted">
              {description}
            </p>
          )}
        </div>
        </div>
        <div className="pointer-events-auto relative z-10 flex shrink-0 items-center gap-2">
          {filterReason && (
            <span
              title={t("Hidden by filter: {reason}", { reason: filterReason })}
              className="rounded-md bg-danger/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-danger ring-1 ring-danger/30"
            >
              {t("Filtered")}
            </span>
          )}
          {match && !isCurrent && (
            <span
              className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ring-1 ${
                match === "same"
                  ? "bg-accent/15 text-accent ring-accent/30"
                  : "bg-raised text-ink-muted ring-edge-soft"
              }`}
            >
              {match === "same" ? t("Same file") : t("Close match")}
            </span>
          )}
          {langs.length > 0 && !isCurrent && (
            <FlagStack languages={langs} size="sm" max={3} />
          )}
          {cornerBadges.length > 0 && !isCurrent && (
            <span className="flex items-center gap-1">
              {cornerBadges.map((b) => (
                <FormatBadge key={b} kind={b} size="sm" />
              ))}
            </span>
          )}
          {isCurrent && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-ink/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink ring-1 ring-edge">
              <Zap size={9} fill="currentColor" strokeWidth={0} />
              {t("Now Playing")}
            </span>
          )}
          {link && !resolving && (
            <a
              href={`vlc://${link}`}
              className="flex h-7 items-center justify-center rounded-md bg-orange-500/80 px-2 text-[10.5px] font-bold uppercase tracking-wider text-white shadow transition-colors hover:bg-orange-500 active:scale-95"
              title={t("Play in VLC")}
            >
              VLC
            </a>
          )}
          {link && !resolving && <CopyLinkButton url={link} />}
          {resolving && <Loader2 size={13} className="animate-spin text-ink-muted" />}
        </div>
      </div>
    </li>
  );
}
