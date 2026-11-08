import { Check, Eye, EyeOff } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { setManualWatched, setManualWatchedMany, setManualWatchedUpTo } from "@/lib/manual-watched";
import { markEpisodesWatched, unmarkEpisodeWatched } from "@/lib/simkl/history";
import { stremioIdToSimklTarget } from "@/lib/simkl/ids";
import { useSimkl } from "@/lib/simkl/provider";
import { isPhoneLayout } from "@/lib/platform";
import { t } from "@/lib/i18n/translate";
import { useNativeSheet } from "@/views/native/native-screens";

const PHONE = isPhoneLayout();

export type WatchedMenuTarget = {
  x: number;
  y: number;
  season: number;
  episode: number;
  watched: boolean;
};

export function EpisodeWatchedMenu({
  metaId,
  target,
  allEpisodes,
  onClose,
}: {
  metaId: string;
  target: WatchedMenuTarget;
  allEpisodes?: Array<{ season: number; episode: number }>;
  onClose: () => void;
}) {
  const { isConnected: simklConnected } = useSimkl();

  useEffect(() => {
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const showIds = (() => {
    if (!simklConnected) return null;
    const r = stremioIdToSimklTarget(metaId, { season: target.season, episode: target.episode });
    return r.ok && r.target.kind === "episode" ? r.target.show.ids : null;
  })();

  const markWatched = () => {
    setManualWatched(metaId, target.season, target.episode, true);
    if (showIds) void markEpisodesWatched(showIds, target.season, [target.episode]);
  };
  const markUpTo = () => {
    if (allEpisodes && allEpisodes.length > 0) {
      const upTo = allEpisodes.filter(
        (e) => e.season < target.season || (e.season === target.season && e.episode <= target.episode),
      );
      setManualWatchedMany(metaId, upTo, true);
    } else {
      setManualWatchedUpTo(metaId, target.season, target.episode, true);
    }
    if (showIds) {
      const eps = Array.from({ length: target.episode }, (_, i) => i + 1);
      void markEpisodesWatched(showIds, target.season, eps);
    }
  };
  const markUnwatched = () => {
    setManualWatched(metaId, target.season, target.episode, false);
    if (showIds) void unmarkEpisodeWatched(showIds, target.season, target.episode);
  };
  // Android's native screen: the same rows in its own menu, sliding up from the bottom.
  const native = useNativeSheet(
    `episode:${metaId}:${target.season}:${target.episode}`,
    target.watched
      ? [{ id: "unwatched", label: t("Mark as unwatched"), icon: "eye-off", onSelect: markUnwatched }]
      : [
          { id: "watched", label: t("Mark as watched"), icon: "check", onSelect: markWatched },
          { id: "upto", label: t("Mark watched up to here"), icon: "eye", onSelect: markUpTo },
        ],
    onClose,
  );
  if (native) return null;

  const left = Math.min(target.x, window.innerWidth - 232);
  const top = Math.min(target.y, window.innerHeight - 128);

  return createPortal(
    <div
      role="menu"
      data-context-menu
      // Phone (long press on an episode): a sheet above the tab bar with finger-sized rows.
      style={PHONE ? { bottom: "calc(60px + env(safe-area-inset-bottom) + 12px)" } : { left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      className={`fixed z-[320] flex flex-col rounded-xl border border-edge bg-elevated p-1 shadow-[0_18px_50px_-15px_rgba(0,0,0,0.7)] animate-popover-in ${
        PHONE ? "inset-x-3" : "w-[224px]"
      }`}
    >
      {target.watched ? (
        <Item
          icon={<EyeOff size={14} strokeWidth={2} />}
          label={t("Mark as unwatched")}
          onClick={() => {
            setManualWatched(metaId, target.season, target.episode, false);
            if (showIds) void unmarkEpisodeWatched(showIds, target.season, target.episode);
            onClose();
          }}
        />
      ) : (
        <>
          <Item
            icon={<Check size={14} strokeWidth={2} />}
            label={t("Mark as watched")}
            onClick={() => {
              setManualWatched(metaId, target.season, target.episode, true);
              if (showIds) void markEpisodesWatched(showIds, target.season, [target.episode]);
              onClose();
            }}
          />
          <Item
            icon={<Eye size={14} strokeWidth={2} />}
            label={t("Mark watched up to here")}
            onClick={() => {
              if (allEpisodes && allEpisodes.length > 0) {
                const upTo = allEpisodes.filter(
                  (e) =>
                    e.season < target.season ||
                    (e.season === target.season && e.episode <= target.episode),
                );
                setManualWatchedMany(metaId, upTo, true);
              } else {
                setManualWatchedUpTo(metaId, target.season, target.episode, true);
              }
              if (showIds) {
                const eps = Array.from({ length: target.episode }, (_, i) => i + 1);
                void markEpisodesWatched(showIds, target.season, eps);
              }
              onClose();
            }}
          />
        </>
      )}
    </div>,
    document.body,
  );
}

function Item({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-start text-[13px] text-ink transition-colors hover:bg-raised"
    >
      <span className="text-ink-muted">{icon}</span>
      {label}
    </button>
  );
}
