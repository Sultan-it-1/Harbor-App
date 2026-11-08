import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import type { Meta } from "@/lib/cinemeta";
import { useAuth } from "@/lib/auth";
import { useDebridClients } from "@/lib/debrid/registry";
import {
  seasonJobKey,
  startSeasonDownload,
  stopSeasonDownload,
  useSeasonDownload,
} from "@/lib/download/season-download";
import { useSettings } from "@/lib/settings";
import { useView, type PlayEpisode } from "@/lib/view";
import { t } from "@/lib/i18n/translate";

/**
 * "Download season": picks the best saveable source for every episode of the season
 * and queues them all (they show up in Downloads with progress). The queue keeps going
 * when you leave the page; coming back shows where it is.
 */
export function SeasonDownloadButton({ meta, episodes }: { meta: Meta; episodes: PlayEpisode[] }) {
  const { authKey } = useAuth();
  const { settings } = useSettings();
  const debrids = useDebridClients();
  const { setView } = useView();
  const [confirm, setConfirm] = useState(false);
  const key = seasonJobKey(meta.id, episodes);
  const progress = useSeasonDownload(key);

  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirm]);

  if (episodes.length === 0) return null;
  const running = !!progress && !progress.finished;

  const start = () => {
    setConfirm(false);
    startSeasonDownload(key, { meta, episodes, authKey, settings, debrids });
  };

  const base = "flex h-10 items-center gap-2 rounded-full px-4 text-[13.5px] font-semibold transition-colors";

  if (running) {
    const cur = progress.current;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${base} border border-edge-soft bg-elevated/60 text-ink-muted`}>
          <Loader2 size={15} className="animate-spin" />
          {t("Finding sources {done}/{total}", { done: Math.min(progress.done + 1, progress.total), total: progress.total })}
          {cur ? ` · E${cur.episode}` : ""}
        </span>
        <button
          type="button"
          onClick={() => stopSeasonDownload(key)}
          aria-label={t("Stop")}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-edge-soft text-ink-subtle"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  if (progress?.finished) {
    const failed = progress.failed.map((e) => `E${e.episode}`).join(", ");
    return (
      <div className="flex flex-col gap-1">
        <button type="button" onClick={() => setView("downloads")} className={`${base} w-fit bg-accent/15 text-accent`}>
          <Download size={15} />
          {t("{n} queued", { n: progress.queued })}
          {progress.skipped ? ` · ${t("{n} already saved", { n: progress.skipped })}` : ""}
          {` · ${t("open Downloads")}`}
        </button>
        {failed && <span className="ps-2 text-[12px] text-ink-subtle">{t("No saveable source for {what}", { what: failed })}</span>}
      </div>
    );
  }

  return confirm ? (
    <button type="button" onClick={start} className={`${base} w-fit bg-accent text-canvas`}>
      <Download size={15} />
      {episodes.length === 1 ? t("Download 1 episode?") : t("Download {n} episodes?", { n: episodes.length })}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setConfirm(true)}
      className={`${base} w-fit border border-edge-soft bg-elevated/50 text-ink hover:bg-elevated`}
    >
      <Download size={15} />
      {t("Download season")}
    </button>
  );
}
