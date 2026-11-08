import { SeasonDownloadButton } from "./season-download-button";
import { ChevronDown, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EpisodeJumper } from "@/components/episode-jumper";
import type { Meta } from "@/lib/cinemeta";
import { getEpisodeProgress } from "@/lib/episode-progress";
import { franchiseTags, type FranchiseEntry } from "@/lib/providers/anime-detail";
import type { KitsuEpisode } from "@/lib/providers/kitsu";
import { useSettings } from "@/lib/settings";
import { spoilerMaskFor } from "@/lib/spoilers";
import { fetchWatchedKeySet } from "@/lib/trakt/history";
import { useTrakt } from "@/lib/trakt/provider";
import { useView } from "@/lib/view";
import { EpisodeWatchedMenu, type WatchedMenuTarget } from "@/components/episode-watched-menu";
import { manualWatchedVersion, setManualWatchedMany, subscribeManualWatched } from "@/lib/manual-watched";
import { useT } from "@/lib/i18n";
import { AnimeEpisodeRow } from "./anime-episodes/episode-row";
import { useReportNativeRow } from "@/views/native/native-sink";
import { useAuth } from "@/lib/auth";
import { useDebridClients } from "@/lib/debrid/registry";
import { seasonJobKey, startSeasonDownload, stopSeasonDownload, useSeasonDownload } from "@/lib/download/season-download";
import { formatAirDate } from "@/lib/dates";
import { formatRelativeWatched } from "@/lib/episode-progress";
import { isUpcomingDate } from "./helpers";
import { AnimeEpisodeStrip } from "./anime-episode-strip";
import { UpcomingBadge } from "./badges";
import { EpisodeGridControls } from "./episode-grid-controls";
import { EpisodeLayoutToggle } from "./episode-layout-toggle";

const WINDOW_STEP = 60;

export function AnimeEpisodes({
  meta,
  episodes,
  franchise,
  currentId,
  scrollRef,
}: {
  meta: Meta;
  episodes: KitsuEpisode[];
  franchise: FranchiseEntry[];
  currentId: string;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const { isConnected: traktConnected } = useTrakt();
  const [traktWatched, setTraktWatched] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!traktConnected) {
      setTraktWatched(new Set());
      return;
    }
    let cancelled = false;
    fetchWatchedKeySet()
      .then((set) => {
        if (!cancelled) setTraktWatched(set);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [traktConnected]);

  const { settings, update } = useSettings();
  const mwVersion = useSyncExternalStore(subscribeManualWatched, manualWatchedVersion);
  const [watchedMenu, setWatchedMenu] = useState<WatchedMenuTarget | null>(null);
  const openWatchedMenu = (
    e: React.MouseEvent,
    season: number,
    episode: number,
    watched: boolean,
  ) => {
    e.preventDefault();
    setWatchedMenu({ x: e.clientX, y: e.clientY, season, episode, watched });
  };

  const progressByNum = useMemo(() => {
    const m = new Map<number, { ratio: number; watched: boolean; startedAt: number }>();
    for (const ep of episodes) {
      m.set(
        ep.number,
        getEpisodeProgress(
          meta.id,
          ep.seasonNumber || 1,
          ep.number,
          ep.length ?? null,
          ep.imdbId ?? null,
          traktWatched,
          undefined,
          undefined,
          ep.imdbSeason,
          ep.imdbEpisode,
        ),
      );
    }
    return m;
  }, [episodes, meta.id, traktWatched, mwVersion]);
  const progressFor = (ep: KitsuEpisode) =>
    progressByNum.get(ep.number) ?? { ratio: 0, watched: false, startedAt: 0 };
  const nextUpNum = useMemo(() => {
    for (const ep of episodes) {
      if (!progressByNum.get(ep.number)?.watched) return ep.number;
    }
    return null;
  }, [episodes, progressByNum]);
  const spoilerFor = (ep: KitsuEpisode) =>
    spoilerMaskFor(settings, {
      watched: progressByNum.get(ep.number)?.watched ?? false,
      isNextUp: ep.number === nextUpNum,
    });
  const allWatched =
    episodes.length > 0 && episodes.every((ep) => progressByNum.get(ep.number)?.watched);
  const markSeason = (watched: boolean) => {
    if (episodes.length === 0) return;
    setManualWatchedMany(
      meta.id,
      episodes.map((ep) => ({ season: ep.seasonNumber || 1, episode: ep.number })),
      watched,
    );
  };

  const windowed = settings.episodeLayout === "list" || settings.episodeLayout === "strip";
  const [renderCount, setRenderCount] = useState(WINDOW_STEP);
  useEffect(() => {
    setRenderCount(WINDOW_STEP);
  }, [meta.id, settings.episodeLayout]);
  const grow = useCallback(
    () => setRenderCount((c) => (c >= episodes.length ? c : Math.min(episodes.length, c + WINDOW_STEP))),
    [episodes.length],
  );
  const reveal = useCallback(
    (n: number) => setRenderCount((c) => Math.max(c, Math.min(episodes.length, n + 20))),
    [episodes.length],
  );
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listEpisodes = windowed ? episodes.slice(0, renderCount) : episodes;
  const hasMore = windowed && renderCount < episodes.length;
  useEffect(() => {
    if (settings.episodeLayout !== "list" || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) grow();
      },
      { root: scrollRef.current ?? null, rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [settings.episodeLayout, hasMore, grow, scrollRef]);

  const isOneOff = meta.type === "movie" || episodes.length <= 1;

  // Android: the title's page is drawn natively; this list hands its row over (native-sink) like
  // the page shows it: the parts of the franchise to switch to, Download season / Mark season,
  // then every episode (still, number, Filler / Upcoming, "E3 · Abs E27 · 24 min · date", how
  // far in, the synopsis). A long-press opens the page's episode menu over it.
  const { openPicker, openMeta } = useView();
  const { authKey } = useAuth();
  const debrids = useDebridClients();
  const seasonEps = episodes.map((ep) => ({
    season: ep.seasonNumber || 1,
    episode: ep.number,
    name: ep.title || undefined,
    still: ep.thumbnail ?? undefined,
    overview: ep.synopsis || undefined,
  }));
  const dlKey = seasonJobKey(meta.id, seasonEps);
  const dlProgress = useSeasonDownload(dlKey);
  const dlRunning = !!dlProgress && !dlProgress.finished;
  const nativeEpisodes = useReportNativeRow("episodes", 0, {
    key: "episodes",
    title: isOneOff ? t("Movie") : t("Episodes"),
    sub: !isOneOff && episodes.length > 0 ? (episodes.length === 1 ? t("{n} episode", { n: episodes.length }) : t("{n} episodes", { n: episodes.length })) : null,
    kind: "episodes",
    noInfo: true,
    metas: [],
    chips:
      franchise.length > 1
        ? {
            key: "franchise",
            items: franchise.map((f) => ({
              id: f.meta.id,
              label: f.episodeCount ? `${f.meta.name} · ${f.episodeCount === 1 ? t("{n} ep", { n: f.episodeCount }) : t("{n} eps", { n: f.episodeCount })}` : f.meta.name,
              on: f.meta.id === currentId,
            })),
          }
        : null,
    tools:
      !isOneOff && episodes.length > 0
        ? [
            dlRunning ? { id: "stopdl", label: t("Stop") } : { id: "download", label: t("Download season") },
            allWatched ? { id: "unwatched", label: t("Mark season as unwatched") } : { id: "watched", label: t("Mark season as watched") },
          ]
        : [],
    cards: episodes.map((ep) => {
      const pr = progressFor(ep);
      const sp = spoilerFor(ep);
      const ago = pr.startedAt > 0 ? formatRelativeWatched(pr.startedAt) : "";
      const line = [
        `E${ep.number}`,
        ep.absoluteNumber && ep.absoluteNumber !== ep.number ? `Abs E${ep.absoluteNumber}` : null,
        ep.length ? t("{n} min", { n: ep.length }) : null,
        formatAirDate(ep.airdate) || null,
      ]
        .filter(Boolean)
        .join("  ·  ");
      const progressText =
        pr.watched && ago
          ? t("Watched {ago}", { ago })
          : !pr.watched && pr.ratio > 0.01 && ago
            ? `${t("{pct}% watched", { pct: Math.round(pr.ratio * 100) })} · ${ago}`
            : "";
      return {
        title: sp?.title ? t("Episode {n}", { n: ep.number }) : ep.title || t("Episode {n}", { n: ep.number }),
        sub: progressText ? `${line}  ·  ${progressText}` : line,
        desc: sp?.desc ? null : ep.synopsis || null,
        img: sp?.thumb ? [] : [ep.thumbnail, ep.thumbnailFallback, meta.background].filter((u, i, a): u is string => !!u && a.indexOf(u) === i),
        rank: ep.number,
        progress: pr.ratio,
        watched: pr.watched && settings.showWatchedMarks !== false,
        kicker: ep.filler ? t("Filler") : isUpcomingDate(ep.airdate) ? t("Upcoming") : null,
        play: true,
      };
    }),
    onOpen: (i) => {
      const s = seasonEps[i];
      if (s) openPicker(meta, s, { autoPlay: settings.instantPlay });
    },
    onRowChip: (id) => {
      const f = franchise.find((x) => x.meta.id === id);
      if (f && f.meta.id !== currentId) openMeta(f.meta);
    },
    onTool: (id) => {
      if (id === "download") {
        const q = seasonEps.length === 1 ? t("Download 1 episode?") : t("Download {n} episodes?", { n: seasonEps.length });
        if (window.confirm(q)) startSeasonDownload(dlKey, { meta, episodes: seasonEps, authKey, settings, debrids });
      } else if (id === "stopdl") {
        stopSeasonDownload(dlKey);
      } else if (id === "watched" || id === "unwatched") {
        markSeason(id === "watched");
      }
    },
    onAction: (a, i) => {
      const s = seasonEps[i];
      if (!s) return false;
      if (a === "dl") openPicker(meta, s, { intent: "download" });
      else if (a === "hold") {
        setWatchedMenu({ x: window.innerWidth / 2, y: window.innerHeight / 2, season: s.season, episode: s.episode, watched: progressFor(episodes[i]).watched });
      }
      return true;
    },
  });
  if (nativeEpisodes) {
    return watchedMenu ? <EpisodeWatchedMenu metaId={meta.id} target={watchedMenu} onClose={() => setWatchedMenu(null)} /> : null;
  }

  return (
    <div data-anime-episodes className="flex flex-col gap-6 scroll-mt-24">
      <div className="flex items-center justify-between gap-6">
        <h3 className="text-[22px] font-medium tracking-tight text-ink">
          {isOneOff ? t("Movie") : t("Episodes")}
        </h3>
        <div className="flex items-center gap-4">
          {!isOneOff && (
            <p className="text-[13px] text-ink-subtle">
              {episodes.length === 1
                ? t("{n} episode", { n: episodes.length })
                : t("{n} episodes", { n: episodes.length })}
            </p>
          )}
          {!isOneOff && (
            <EpisodeLayoutToggle
              value={settings.episodeLayout}
              onChange={(v) => update({ episodeLayout: v })}
            />
          )}
          {!isOneOff && settings.episodeLayout === "grid" && (
            <EpisodeGridControls
              sort={settings.episodeSort}
              onSort={(s) => update({ episodeSort: s })}
              allWatched={allWatched}
              onMarkSeason={markSeason}
            />
          )}
          {franchise.length > 1 && (
            <AnimeSeasonPicker franchise={franchise} currentId={currentId} />
          )}
        </div>
      </div>
      {!isOneOff && (
        <SeasonDownloadButton
          meta={meta}
          episodes={episodes.map((ep) => ({
            season: ep.seasonNumber || 1,
            episode: ep.number,
            name: ep.title,
            kitsuStreamId: ep.streamId,
            imdbId: ep.imdbId,
            imdbSeason: ep.imdbSeason,
            imdbEpisode: ep.imdbEpisode,
          }))}
        />
      )}
      {isOneOff ? (
        <MovieEntryCard meta={meta} ep={episodes[0]} />
      ) : (
        <div key={settings.episodeLayout} className="animate-fade-in">
          {settings.episodeLayout === "list" ? (
            <div className="flex flex-col gap-1">
              {listEpisodes.map((ep) => (
                <AnimeEpisodeRow
                  key={ep.id}
                  meta={meta}
                  ep={ep}
                  progress={progressFor(ep)}
                  spoiler={spoilerFor(ep)}
                  onContextMenu={openWatchedMenu}
                />
              ))}
              {hasMore && <div ref={sentinelRef} aria-hidden className="h-px w-full" />}
            </div>
          ) : (
            <AnimeEpisodeStrip
              layout={settings.episodeLayout === "grid" ? "grid" : "strip"}
              meta={meta}
              episodes={settings.episodeLayout === "grid" ? episodes : listEpisodes}
              progressFor={progressFor}
              spoilerFor={spoilerFor}
              onContextMenu={openWatchedMenu}
              onReachEnd={settings.episodeLayout === "grid" ? undefined : grow}
            />
          )}
          <EpisodeJumper scrollRef={scrollRef} totalEpisodes={episodes.length} onReveal={reveal} />
        </div>
      )}
      {watchedMenu && (
        <EpisodeWatchedMenu
          metaId={meta.id}
          target={watchedMenu}
          onClose={() => setWatchedMenu(null)}
        />
      )}
    </div>
  );
}

function MovieEntryCard({ meta, ep }: { meta: Meta; ep: KitsuEpisode | undefined }) {
  const t = useT();
  const { openPicker } = useView();
  const { settings } = useSettings();
  const banner = meta.background || meta.poster;
  return (
    <button
      onClick={() =>
        openPicker(
          meta,
          ep
            ? {
                season: ep.seasonNumber || 1,
                episode: ep.number,
                name: ep.title,
                still: ep.thumbnail ?? undefined,
                overview: ep.synopsis || undefined,
                kitsuStreamId: ep.streamId,
                imdbId: ep.imdbId,
                imdbSeason: ep.imdbSeason,
                imdbEpisode: ep.imdbEpisode,
              }
            : { season: 1, episode: 1 },
          { autoPlay: settings.instantPlay },
        )
      }
      className="group relative block h-[300px] w-full overflow-hidden rounded-2xl border border-edge-soft/50 text-start"
    >
      {banner ? (
        <img src={banner} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-elevated" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-canvas/90 via-canvas/35 to-transparent" />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_8px_28px_rgba(0,0,0,0.4)] transition-transform duration-200 group-hover:scale-105">
          <Play size={24} fill="currentColor" />
        </div>
      </div>
      <span className="absolute bottom-5 start-6 text-[15px] font-semibold text-ink drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
        {t("Play movie")}
      </span>
    </button>
  );
}

function AnimeSeasonPicker({
  franchise,
  currentId,
}: {
  franchise: FranchiseEntry[];
  currentId: string;
}) {
  const t = useT();
  const { openMeta } = useView();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const matchIdx = franchise.findIndex((f) => f.meta.id === currentId);
  const currentIdx = matchIdx >= 0 ? matchIdx : franchise.findIndex((f) => f.isCurrent);
  const current = franchise[currentIdx];

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

  if (!current) return null;
  const tags = franchiseTags(franchise);
  const positionLabel = tags[currentIdx]?.short ?? `S${currentIdx + 1}`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-2 rounded-full border border-edge-soft bg-elevated/70 ps-4 pe-3 text-[13.5px] font-medium text-ink transition-colors hover:bg-elevated"
      >
        <span className="font-mono text-[11.5px] text-ink-subtle">{positionLabel}</span>
        <span className="max-w-[280px] truncate">{current.meta.name}</span>
        {current.isUpcoming && <UpcomingBadge />}
        <ChevronDown
          size={15}
          className={`text-ink-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="animate-fade-in absolute end-0 top-full z-30 mt-2 w-[360px] max-w-[min(360px,calc(100vw-3rem))] overflow-hidden rounded-2xl border border-edge-soft bg-canvas py-1.5 shadow-2xl">
          <div className="max-h-[60vh] overflow-y-auto">
            {franchise.map((f, i) => {
              const isActive = i === currentIdx;
              return (
                <button
                  key={f.meta.id}
                  onClick={() => {
                    if (!isActive) openMeta(f.meta);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-start transition-colors ${
                    isActive ? "bg-ink/10 text-ink" : "text-ink-muted hover:bg-elevated/60 hover:text-ink"
                  }`}
                >
                  <span className="mt-0.5 font-mono text-[11px] text-ink-subtle">{tags[i]?.short ?? `S${i + 1}`}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-[13.5px] font-medium">
                      <span className="truncate">{f.meta.name}</span>
                      {f.isUpcoming && <UpcomingBadge />}
                    </span>
                    <span className="text-[11.5px] text-ink-subtle">
                      {f.episodeCount
                        ? f.episodeCount === 1
                          ? t("{n} ep", { n: f.episodeCount })
                          : t("{n} eps", { n: f.episodeCount })
                        : ""}
                      {f.episodeCount && f.startDate ? "  ·  " : ""}
                      {f.startDate ? f.startDate.slice(0, 4) : f.isUpcoming ? "TBA" : ""}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
