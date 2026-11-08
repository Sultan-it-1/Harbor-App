import { SeasonDownloadButton } from "./season-download-button";
import { isPhoneLayout } from "@/lib/platform";
import { Check, ChevronDown, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Meta } from "@/lib/cinemeta";
import { EpisodeWatchedMenu, type WatchedMenuTarget } from "@/components/episode-watched-menu";
import { manualWatchedState, manualWatchedVersion, subscribeManualWatched } from "@/lib/manual-watched";
import { getLastSeason, setLastSeason } from "@/lib/last-season";
import { lastPlayedEpisode } from "@/lib/resume";
import { Poster } from "@/components/poster";
import { useSettings } from "@/lib/settings";
import { useView } from "@/lib/view";
import { useT } from "@/lib/i18n";
import { EpisodeDownloadButton } from "./episode-download-button";
import { uiLocale } from "@/lib/i18n/locale";
import { useAuth } from "@/lib/auth";
import { useDebridClients } from "@/lib/debrid/registry";
import { seasonJobKey, startSeasonDownload, stopSeasonDownload, useSeasonDownload } from "@/lib/download/season-download";
import { useReportNativeRow } from "@/views/native/native-sink";

type Translator = (key: string, vars?: Record<string, string | number>) => string;

type CinemetaVideo = NonNullable<Meta["videos"]>[number];

function pickDefaultSeason(metaId: string, seasons: number[]): number {
  const has = (n: number) => seasons.includes(n);
  const saved = getLastSeason(metaId);
  if (saved != null && has(saved)) return saved;
  const lp = lastPlayedEpisode(metaId);
  if (lp && has(lp.season)) return lp.season;
  const real = seasons.filter((s) => s > 0);
  return real[real.length - 1] ?? seasons[seasons.length - 1] ?? 1;
}

const PHONE = isPhoneLayout();

export function CinemetaEpisodes({
  meta,
  videos,
}: {
  meta: Meta;
  videos: NonNullable<Meta["videos"]>;
}) {
  const t = useT();
  useSyncExternalStore(subscribeManualWatched, manualWatchedVersion);
  const [watchedMenu, setWatchedMenu] = useState<WatchedMenuTarget | null>(null);
  const openWatchedMenu = (e: React.MouseEvent, season: number, episode: number, watched: boolean) => {
    e.preventDefault();
    setWatchedMenu({ x: e.clientX, y: e.clientY, season, episode, watched });
  };
  const grouped = useMemo(() => {
    const map = new Map<number, CinemetaVideo[]>();
    const flat: CinemetaVideo[] = [];
    for (const v of videos) {
      if (v.season == null || (v.episode ?? v.number) == null) {
        flat.push(v);
        continue;
      }
      const arr = map.get(v.season) ?? [];
      arr.push(v);
      map.set(v.season, arr);
    }
    const numbered = Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([s, eps]) => ({
        seasonNumber: s,
        episodes: eps.slice().sort((a, b) => ((a.episode ?? a.number) ?? 0) - ((b.episode ?? b.number) ?? 0)),
      }));
    if (flat.length > 0 && numbered.length === 0) {
      flat.sort((a, b) => (a.released ?? "").localeCompare(b.released ?? ""));
      return [{ seasonNumber: -1, episodes: flat }];
    }
    return numbered;
  }, [videos]);

  const allEpisodesOrdered = useMemo(
    () =>
      grouped.flatMap((g) =>
        g.episodes.map((ep, i) => ({
          season: ep.season ?? 0,
          episode: ep.episode ?? ep.number ?? (ep.season == null ? i + 1 : 1),
        })),
      ),
    [grouped],
  );

  const [active, setActive] = useState<number>(() =>
    pickDefaultSeason(meta.id, grouped.map((g) => g.seasonNumber)),
  );
  const userPickedRef = useRef(false);

  useEffect(() => {
    userPickedRef.current = false;
  }, [meta.id]);

  useEffect(() => {
    if (userPickedRef.current) return;
    setActive(pickDefaultSeason(meta.id, grouped.map((g) => g.seasonNumber)));
  }, [meta.id, grouped.length]);

  const activeEps = grouped.find((g) => g.seasonNumber === active)?.episodes ?? [];

  // Android: the title's page is drawn natively; this list hands its row over (native-sink) as
  // the page shows it: "Episodes" with the count, the seasons, Download season (Stop while it
  // runs), then each episode (its picture with the number and the watched check, the name,
  // "S1 E3 · date"). A tap plays it, its download button picks a source to save, a long-press
  // opens the page's watched menu over the screen.
  const { openPicker } = useView();
  const { settings } = useSettings();
  const { authKey } = useAuth();
  const debrids = useDebridClients();
  const playEps = activeEps.map((ep, i) => ({
    season: ep.season ?? 0,
    episode: ep.episode ?? ep.number ?? (ep.season == null ? i + 1 : 1),
    name: ep.name || ep.title || undefined,
    videoId: ep.id || undefined,
    still: ep.thumbnail || undefined,
  }));
  const dlKey = seasonJobKey(meta.id, playEps);
  const dlProgress = useSeasonDownload(dlKey);
  const dlRunning = !!dlProgress && !dlProgress.finished;
  const nativeEpisodes = useReportNativeRow(
    "episodes",
    0,
    grouped.length === 0
      ? null
      : {
          key: "episodes",
          title: t("Episodes"),
          sub: activeEps.length === 1 ? t("{n} episode", { n: 1 }) : t("{n} episodes", { n: activeEps.length }),
          kind: "episodes",
          noInfo: true,
          metas: [],
          chips:
            grouped.length > 1
              ? { key: "season", items: grouped.map((g) => ({ id: String(g.seasonNumber), label: seasonLabel(t, g.seasonNumber), on: g.seasonNumber === active })) }
              : null,
          tools: playEps.length > 0 ? [dlRunning ? { id: "stopdl", label: t("Stop") } : { id: "download", label: t("Download season") }] : [],
          cards: activeEps.map((ep, i) => {
            const pe = playEps[i];
            const aired = formatAired(ep.released ?? ep.firstAired ?? null);
            return {
              title: ep.name || ep.title || aired || t("Episode {n}", { n: pe.episode }),
              sub: [ep.season != null ? `S${ep.season} E${pe.episode}` : null, aired].filter(Boolean).join("  ·  "),
              img: ep.thumbnail ? [ep.thumbnail] : [],
              rank: ep.season != null ? pe.episode : 0,
              watched: manualWatchedState(meta.id, pe.season, pe.episode) === true,
              play: true,
            };
          }),
          onOpen: (i) => {
            const pe = playEps[i];
            if (pe) openPicker(meta, pe, { autoPlay: settings.instantPlay });
          },
          onRowChip: (id) => {
            const n = Number(id);
            if (!Number.isFinite(n)) return;
            userPickedRef.current = true;
            setLastSeason(meta.id, n);
            setActive(n);
          },
          onTool: (id) => {
            if (id === "download") {
              const q = playEps.length === 1 ? t("Download 1 episode?") : t("Download {n} episodes?", { n: playEps.length });
              if (window.confirm(q)) startSeasonDownload(dlKey, { meta, episodes: playEps, authKey, settings, debrids });
            } else if (id === "stopdl") {
              stopSeasonDownload(dlKey);
            }
          },
          onAction: (a, i) => {
            const pe = playEps[i];
            if (!pe) return false;
            if (a === "dl") openPicker(meta, pe, { intent: "download" });
            else if (a === "hold") {
              setWatchedMenu({
                x: window.innerWidth / 2,
                y: window.innerHeight / 2,
                season: pe.season,
                episode: pe.episode,
                watched: manualWatchedState(meta.id, pe.season, pe.episode) === true,
              });
            }
            return true;
          },
        },
  );
  if (nativeEpisodes) {
    return watchedMenu ? (
      <EpisodeWatchedMenu metaId={meta.id} target={watchedMenu} allEpisodes={allEpisodesOrdered} onClose={() => setWatchedMenu(null)} />
    ) : null;
  }

  if (grouped.length === 0) return null;

  return (
    <div data-episodes className="flex scroll-mt-24 flex-col gap-6">
      <div className="flex items-end justify-between gap-6">
        <h3 className="text-[22px] font-medium tracking-tight text-ink">{t("Episodes")}</h3>
        {grouped.length > 1 && (
          <SeasonDropdown
            seasons={grouped.map((g) => g.seasonNumber)}
            active={active}
            onChange={(n) => {
              userPickedRef.current = true;
              setLastSeason(meta.id, n);
              setActive(n);
            }}
          />
        )}
      </div>
      <p className="text-[13px] text-ink-subtle">
        {activeEps.length === 1
          ? t("{n} episode", { n: activeEps.length })
          : t("{n} episodes", { n: activeEps.length })}
      </p>
      <SeasonDownloadButton
        meta={meta}
        episodes={activeEps.map((ep, i) => ({
          season: ep.season ?? 0,
          episode: ep.episode ?? ep.number ?? (ep.season == null ? i + 1 : 1),
          name: ep.name || ep.title || undefined,
          videoId: ep.id || undefined,
        }))}
      />
      <div className="flex flex-col gap-1">
        {activeEps.map((ep, i) => {
          const season = ep.season ?? 0;
          const epNumber = ep.episode ?? ep.number ?? (ep.season == null ? i + 1 : 1);
          return (
            <CinemetaEpisodeRow
              key={ep.id ?? `${ep.season ?? "x"}-${ep.episode ?? i}`}
              meta={meta}
              ep={ep}
              flatIndex={ep.season == null ? i + 1 : undefined}
              watched={manualWatchedState(meta.id, season, epNumber) === true}
              onContextMenu={openWatchedMenu}
            />
          );
        })}
      </div>
      {watchedMenu && (
        <EpisodeWatchedMenu
          metaId={meta.id}
          target={watchedMenu}
          allEpisodes={allEpisodesOrdered}
          onClose={() => setWatchedMenu(null)}
        />
      )}
    </div>
  );
}

export function CinemetaEpisodeRow({
  meta,
  ep,
  flatIndex,
  watched = false,
  onContextMenu,
}: {
  meta: Meta;
  ep: CinemetaVideo;
  flatIndex?: number;
  watched?: boolean;
  onContextMenu?: (e: React.MouseEvent, season: number, episode: number, watched: boolean) => void;
}) {
  const t = useT();
  const { openPicker } = useView();
  const { settings } = useSettings();
  const aired = ep.released ?? ep.firstAired ?? null;
  const epNumber = ep.episode ?? ep.number ?? flatIndex ?? 1;
  const season = ep.season ?? 0;
  const playEpisode = {
    season: ep.season ?? 0,
    episode: epNumber,
    name: ep.name || ep.title || undefined,
    videoId: ep.id || undefined,
    still: ep.thumbnail || undefined,
    overview: undefined,
  };
  return (
    <div
      data-no-card-ring
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, season, epNumber, watched) : undefined}
      className={`group flex items-center rounded-2xl transition-colors hover:bg-elevated/30 ${PHONE ? "gap-1.5 px-1 py-3" : "gap-4 px-4 py-5"}`}
    >
      <button
        onClick={() => openPicker(meta, playEpisode, { autoPlay: settings.instantPlay })}
        className={`flex min-w-0 flex-1 text-start ${PHONE ? "gap-3" : "gap-6"}`}
      >
        <div className={`relative shrink-0 self-start overflow-hidden rounded-lg ${PHONE ? "w-[132px]" : "w-[200px]"}`}>
          <Poster
            src={ep.thumbnail}
            seed={ep.id ?? `${meta.id}-${ep.season}-${epNumber}`}
            ratio="landscape"
            lazy
          />
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/40 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-canvas">
              <Play size={18} fill="currentColor" />
            </div>
          </div>
          {ep.season != null && (
            <span className="absolute start-2 top-2 rounded-md bg-canvas/95 px-1.5 py-0.5 text-[11px] font-semibold text-ink">
              {epNumber}
            </span>
          )}
          {watched && (
            <span className="absolute end-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-canvas shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
              <Check size={13} strokeWidth={3} />
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h4 className={`font-semibold text-ink ${PHONE ? "line-clamp-2 text-[14px]" : "truncate text-[16px]"}`}>
            {ep.name || ep.title || formatAired(aired) || t("Episode {n}", { n: epNumber })}
          </h4>
          <p className="text-[12px] text-ink-subtle">
            {[ep.season != null ? `S${ep.season} E${epNumber}` : null, formatAired(aired)]
              .filter(Boolean)
              .join("  ·  ")}
          </p>
        </div>
      </button>
      <EpisodeDownloadButton meta={meta} episode={playEpisode} />
    </div>
  );
}

function SeasonDropdown({
  seasons,
  active,
  onChange,
}: {
  seasons: number[];
  active: number;
  onChange: (n: number) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-2 rounded-full border border-edge-soft bg-canvas/90 ps-4 pe-3 text-[13.5px] font-medium text-ink transition-colors hover:bg-canvas"
      >
        <span>{seasonLabel(t, active)}</span>
        <ChevronDown
          size={15}
          className={`text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="animate-fade-in absolute end-0 top-full z-30 mt-2 w-44 overflow-hidden rounded-2xl border border-edge-soft bg-canvas py-1.5 shadow-2xl">
          <div className="max-h-[60vh] overflow-y-auto">
            {seasons.map((s) => {
              const isActive = s === active;
              return (
                <button
                  key={s}
                  onClick={() => {
                    onChange(s);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center px-4 py-2.5 text-start text-[13.5px] transition-colors ${
                    isActive
                      ? "bg-ink/10 text-ink"
                      : "text-ink-muted hover:bg-elevated/60 hover:text-ink"
                  }`}
                >
                  {seasonLabel(t, s)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function seasonLabel(t: Translator, n: number): string {
  if (n === 0) return t("Specials");
  if (n === -1) return t("Videos");
  return t("Season {n}", { n });
}

function formatAired(date: string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(uiLocale(), { month: "short", day: "numeric", year: "numeric" });
}
