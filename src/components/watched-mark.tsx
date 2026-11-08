import { Check } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { useIsWatched } from "@/lib/watched-marks";

/** Whether the "watched" checks (posters and episodes) are turned on in Settings. */
export function useShowWatchedMarks(): boolean {
  const { settings } = useSettings();
  return settings.showWatchedMarks !== false;
}

/**
 * A small check in a poster's corner for a movie / show you've finished. Place it inside the
 * poster's `relative` box; `className` moves it (default bottom-left), `size` shrinks it for
 * small thumbnails.
 */
export function WatchedMark({
  id,
  altIds,
  size = "md",
  className = "bottom-1.5 start-1.5",
}: {
  id: string;
  altIds?: ReadonlyArray<string | null | undefined>;
  size?: "sm" | "md";
  className?: string;
}) {
  const t = useT();
  const watched = useIsWatched(id, altIds);
  if (!watched) return null;
  return (
    <span
      title={t("Watched")}
      aria-label={t("Watched")}
      className={`pointer-events-none absolute z-[1] flex items-center justify-center rounded-full bg-accent text-canvas shadow-[0_1px_6px_rgba(0,0,0,0.5)] ring-2 ring-canvas/70 ${
        size === "sm" ? "h-4 w-4" : "h-[22px] w-[22px]"
      } ${className}`}
    >
      <Check size={size === "sm" ? 10 : 13} strokeWidth={3.2} />
    </span>
  );
}
