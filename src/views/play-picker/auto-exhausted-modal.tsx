import { useCloseOnAndroidBack } from "@/lib/use-android-back";
import type { Meta } from "@/lib/cinemeta";
import { useView, type PlayEpisode } from "@/lib/view";
import { t } from "@/lib/i18n/translate";

export function AutoExhaustedModal({
  meta,
  episode,
  onBrowseManually,
}: {
  meta: Meta;
  episode?: PlayEpisode;
  onBrowseManually: () => void;
}) {
  useCloseOnAndroidBack(true, onBrowseManually);
  // Exit leaves the stream search for good, to the title's page: plain Back landed on the search
  // again (which found nothing again), so it went round in a loop.
  const { exitPickerToDetail } = useView();
  const title = meta.name ?? "this title";
  const epSuffix = episode
    ? ` S${episode.imdbSeason ?? episode.season}E${String(episode.imdbEpisode ?? episode.episode).padStart(2, "0")}`
    : "";
  return (
    <main className="fixed inset-0 z-[120] flex items-center justify-center overflow-hidden bg-black px-6">
      <div className="w-full max-w-md rounded-2xl bg-elevated p-8 ring-1 ring-edge-soft">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-ink-subtle">
          Harbor
        </p>
        <h2 className="mt-3 text-start text-[24px] font-semibold leading-tight text-ink" dir="auto">
          {t("We could not find a working stream")}
        </h2>
        <p className="mt-3 text-start text-[14px] leading-relaxed text-ink-muted" dir="auto">
          {t("Harbor checked every available source for")} {title}{epSuffix} {t("and none of them played. The most common reasons:")}
        </p>
        <ul className="mt-3 space-y-1.5 text-start text-[13.5px] leading-relaxed text-ink-muted" dir="auto">
          <li dir="auto">{t("· A debrid key (TorBox, Real-Debrid, etc.) is missing or expired.")}</li>
          <li dir="auto">{t("· No stream addon is installed yet (Torrentio, MediaFusion, Comet).")}</li>
          <li dir="auto">{t("· This title is too new and no source has it cached yet.")}</li>
        </ul>
        <div className="mt-7 flex flex-col gap-2.5">
          <button
            onClick={onBrowseManually}
            className="flex h-11 items-center justify-center rounded-full bg-ink text-[14px] font-semibold text-canvas transition-opacity hover:opacity-90"
          >
            {t("Browse streams manually")}
          </button>
          <button
            onClick={() => exitPickerToDetail(meta)}
            className="mt-1 h-10 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
          >
            {t("Exit")}
          </button>
        </div>
      </div>
    </main>
  );
}
