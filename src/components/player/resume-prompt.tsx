import { Play, RotateCcw } from "lucide-react";
import { useT } from "@/lib/i18n";

export function ResumePrompt({
  resumeSec,
  totalSec,
  title,
  onResume,
  onStartOver,
}: {
  resumeSec: number;
  totalSec: number;
  title: string;
  onResume: () => void;
  onStartOver: () => void;
}) {
  const t = useT();
  const pct = totalSec > 0 ? Math.min(100, Math.round((resumeSec / totalSec) * 100)) : 0;
  return (
    <div className="absolute inset-0 z-[90] flex items-end justify-center bg-gradient-to-t from-black/90 via-black/55 to-transparent pb-16">
      <div className="w-full max-w-xl rounded-3xl bg-surface p-7 ring-1 ring-edge-soft shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-ink-subtle">
          {t("Pick up where you left off")}
        </p>
        <h2 className="mt-3 line-clamp-2 font-display text-[24px] font-semibold leading-tight text-ink">
          {title}
        </h2>
        <p className="mt-2 text-[13.5px] text-ink-muted">
          {t("{watched} of {total} watched ({pct}%).", {
            watched: formatTime(resumeSec),
            total: formatTime(totalSec),
            pct,
          })}
        </p>
        <div className="mt-5 h-1 w-full overflow-hidden rounded-full bg-elevated">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
          <button
            onClick={onResume}
            autoFocus
            className="flex h-12 flex-1 items-center justify-center gap-2.5 rounded-full bg-accent text-[15px] font-semibold text-canvas shadow-[0_8px_22px_-10px_var(--color-accent)] transition-opacity hover:opacity-90"
          >
            <Play size={18} fill="currentColor" />
            {t("Resume from {time}", { time: formatTime(resumeSec) })}
          </button>
          <button
            onClick={onStartOver}
            className="flex h-12 items-center justify-center gap-2.5 rounded-full bg-elevated px-6 text-[14px] font-semibold text-ink ring-1 ring-edge-soft transition-colors hover:bg-raised"
          >
            <RotateCcw size={16} strokeWidth={2.4} />
            {t("Start Over")}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return "0:00";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
