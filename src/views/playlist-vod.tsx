import { Film, Search, Tv } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import { useT } from "@/lib/i18n";
import { getCachedPlaylist } from "@/lib/iptv/store";
import type { IptvPlaylistSource } from "@/lib/iptv/types";
import { buildVodLibrary, type VodEpisode, type VodMovie, type VodSeries } from "@/lib/iptv/vod";
import { useSettings } from "@/lib/settings";
import { useScrollMemory, useView } from "@/lib/view";
import { SourcePicker } from "./live/source-picker";
import { PlaylistEmpty } from "./live/playlist-empty";
import { useIptvPlaylist } from "./live/hooks/use-iptv-playlist";
import { SeriesDetail } from "./playlist-vod/series-detail";
import { useVodSources } from "./playlist-vod/use-vod-sources";
import { VodCard } from "./playlist-vod/vod-card";
import { uiLocale } from "@/lib/i18n/locale";
import { enrichVod } from "@/lib/iptv/vod-enrich";
import { useNativeBrowsePage, useNativeSheet, type NativeRowInput } from "@/views/native/native-screens";

type Tab = "movies" | "series";

const RENDER_CAP = 500;

export function PlaylistVodView({ active }: { active: boolean }) {
  const t = useT();
  const { settings } = useSettings();
  const { openPlayer, topKind } = useView();
  const { sources, activeId, selectId, addPlaylist, editPlaylist, removePlaylist } = useVodSources();

  const activeSource = useMemo<IptvPlaylistSource | null>(
    () => sources.find((s) => s.id === activeId) ?? null,
    [sources, activeId],
  );

  const { state, refresh } = useIptvPlaylist(active ? activeSource : null);
  const playlist = state.kind === "ready" ? state.playlist : getCachedPlaylist(activeSource?.id ?? "");

  const names = useMemo(() => new Map(sources.map((s) => [s.id, s.name] as const)), [sources]);
  const library = useMemo(
    () => (playlist ? buildVodLibrary([playlist], names) : { movies: [], series: [] }),
    [playlist, names],
  );

  const [tab, setTab] = useState<Tab>("movies");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<VodSeries | null>(null);

  const chooseTab = useCallback((t: Tab) => {
    setTab(t);
    setSelected(null);
  }, []);

  useEffect(() => {
    setSelected(null);
  }, [activeId]);

  const q = query.trim().toLowerCase();
  const movies = useMemo(
    () => (q ? library.movies.filter((m) => m.title.toLowerCase().includes(q)) : library.movies),
    [library.movies, q],
  );
  const series = useMemo(
    () => (q ? library.series.filter((s) => s.title.toLowerCase().includes(q)) : library.series),
    [library.series, q],
  );

  const playMovie = useCallback(
    (m: VodMovie) => {
      openPlayer({
        meta: vodMeta(m.id, "movie", m.title, m.logo, m.year),
        url: m.url,
        title: m.title,
        subtitle: m.year ? String(m.year) : m.playlistName,
        notWebReady: true,
      });
    },
    [openPlayer],
  );

  const playEpisode = useCallback(
    (s: VodSeries, ep: VodEpisode) => {
      openPlayer({
        meta: vodMeta(s.id, "series", s.title, s.logo, null),
        episode: { season: ep.season, episode: ep.episode, name: ep.title },
        url: ep.url,
        title: ep.title,
        subtitle: `${s.title} · S${ep.season} · E${ep.episode}`,
        notWebReady: true,
      });
    },
    [openPlayer],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollMemory("vod", scrollRef, active);

  // Android: drawn natively (see @/views/native/native-screens) like the page: the playlist
  // button (its menu of playlists, add / edit / remove opens over the screen), Movies / Shows
  // with their counts, the search field, then the posters (more as it scrolls, TMDB's poster
  // when the playlist has none) or a show's page: its poster, episodes and seasons, then its
  // episodes (a tap plays one). With no playlist yet the page's own setup shows.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRequest, setPickerRequest] = useState(0);
  // The playlists as the screen's own menu: switch, refresh; adding, editing and the rest open
  // the page's picker (its forms).
  const [plSheet, setPlSheet] = useState(false);
  const [addRequest, setAddRequest] = useState(0);
  const [editRequest, setEditRequest] = useState<{ id: string; nonce: number } | null>(null);
  useNativeSheet(
    plSheet ? `vod-playlists:${activeId}` : null,
    [
      ...sources.map((src) => ({ id: `pl:${src.id}`, label: src.name, active: src.id === activeId, onSelect: () => selectId(src.id) })),
      { id: "-", label: "", divider: true },
      { id: "refresh", label: t("Refresh playlist"), icon: "retry", onSelect: refresh },
      ...(activeId ? [{ id: "edit", label: t("Edit link & login"), icon: "pencil", onSelect: () => setEditRequest({ id: activeId, nonce: Date.now() }) }] : []),
      { id: "add", label: t("Add another playlist"), icon: "plus", onSelect: () => setAddRequest((n) => n + 1) },
      { id: "manage", label: `${t("Rename")} · ${t("Delete")}…`, icon: "list-checks", onSelect: () => setPickerRequest((n) => n + 1) },
    ],
    () => setPlSheet(false),
  );
  const [limit, setLimit] = useState(60);
  useEffect(() => setLimit(60), [tab, q, activeId]);
  const [posters, setPosters] = useState<Record<string, string>>({});
  const shownMovies = useMemo(() => movies.slice(0, Math.min(limit, RENDER_CAP)), [movies, limit]);
  const shownSeries = useMemo(() => series.slice(0, Math.min(limit, RENDER_CAP)), [series, limit]);
  // TMDB's posters for the titles shown (a few at a time; the lookups are cached).
  useEffect(() => {
    if (!settings.tmdbKey || !active) return;
    let cancelled = false;
    const wanted: Array<{ id: string; kind: "movie" | "series"; title: string; year: number | null }> =
      tab === "movies"
        ? shownMovies.map((m) => ({ id: m.id, kind: "movie" as const, title: m.title, year: m.year }))
        : shownSeries.map((x) => ({ id: x.id, kind: "series" as const, title: x.title, year: null }));
    const todo = wanted.filter((w) => !(w.id in posters));
    if (todo.length === 0) return;
    let next = 0;
    const found: Record<string, string> = {};
    const flush = () => {
      if (!cancelled && Object.keys(found).length > 0) setPosters((p) => ({ ...p, ...found }));
    };
    const worker = async () => {
      while (!cancelled && next < todo.length) {
        const w = todo[next++];
        const e = await enrichVod(settings.tmdbKey, w.kind, w.title, w.year).catch(() => null);
        found[w.id] = e?.poster ?? "";
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]).then(flush);
    return () => {
      cancelled = true;
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.tmdbKey, active, tab, shownMovies, shownSeries]);
  const posterOf = (id: string, logo: string | null) => [posters[id], logo].filter((u): u is string => !!u);
  const capNote =
    !selected && (tab === "movies" ? movies.length : series.length) > RENDER_CAP
      ? tab === "movies"
        ? t("Showing {shown} of {total} movies. Search to find the rest.", {
            shown: RENDER_CAP.toLocaleString(uiLocale()),
            total: movies.length.toLocaleString(uiLocale()),
          })
        : t("Showing {shown} of {total} shows. Search to find the rest.", {
            shown: RENDER_CAP.toLocaleString(uiLocale()),
            total: series.length.toLocaleString(uiLocale()),
          })
      : null;
  const [season, setSeason] = useState<number>(1);
  useEffect(() => setSeason(selected?.seasons[0] ?? 1), [selected]);
  const nativeRows = useMemo<NativeRowInput[]>(() => {
    if (state.kind === "error" || (state.kind === "loading" && !playlist)) return [];
    if (selected) {
      const eps = selected.episodes.filter((e) => e.season === season);
      return [
        {
          key: "episodes",
          title: "",
          kind: "winners",
          metas: [],
          chips:
            selected.seasons.length > 1
              ? { key: "season", items: selected.seasons.map((n) => ({ id: String(n), label: t("Season {n}", { n }), on: n === season })) }
              : null,
          onRowChip: (id) => setSeason(Number(id)),
          cards: eps.map((ep) => ({ title: ep.title, sub: String(ep.episode) })),
          onOpen: (i) => {
            const ep = eps[i];
            if (ep) playEpisode(selected, ep);
          },
        },
      ];
    }
    const more = (list: unknown[], shown: unknown[]) =>
      shown.length < Math.min(list.length, RENDER_CAP) ? () => setLimit((l) => l + 60) : undefined;
    if (tab === "movies") {
      return [
        {
          key: "movies",
          title: "",
          kind: "poster",
          grid: true,
          min: Math.round(150 * (settings.posterScale ?? 1)),
          metas: [],
          cards: shownMovies.map((m) => ({ title: m.title, sub: m.year ? String(m.year) : null, img: posterOf(m.id, m.logo) })),
          onOpen: (i) => {
            const m = shownMovies[i];
            if (m) playMovie(m);
          },
          more: more(movies, shownMovies),
        },
      ];
    }
    return [
      {
        key: "series",
        title: "",
        kind: "poster",
        grid: true,
        min: Math.round(150 * (settings.posterScale ?? 1)),
        metas: [],
        cards: shownSeries.map((x) => ({
          title: x.title,
          sub: x.episodes.length === 1 ? t("{n} episode", { n: 1 }) : t("{n} episodes", { n: x.episodes.length }),
          img: posterOf(x.id, x.logo),
        })),
        onOpen: (i) => {
          const x = shownSeries[i];
          if (x) setSelected(x);
        },
        more: more(series, shownSeries),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, state.kind, playlist, selected, season, tab, shownMovies, shownSeries, movies, series, posters, settings.posterScale, playMovie, playEpisode]);
  const activeName = sources.find((s) => s.id === activeId)?.name ?? t("No playlist");
  const native = useNativeBrowsePage("vod", {
    active: topKind === "vod" && active,
    blocked: sources.length === 0,
    hidden: pickerOpen,
    t,
    back: !!selected,
    onBack: () => setSelected(null),
    header: selected
      ? {
          photo: selected.logo ?? null,
          title: selected.title,
          size: 26,
          subtitle: [
            selected.episodes.length === 1 ? t("{n} episode", { n: 1 }) : t("{n} episodes", { n: selected.episodes.length }),
            selected.seasons.length > 1 ? t("{n} seasons", { n: selected.seasons.length }) : null,
            selected.group,
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : null,
    chips: selected
      ? []
      : [
          { key: "source", items: [{ id: "picker", label: `●  ${activeName}  ▾`, on: false }] },
          {
            key: "tab",
            items: [
              { id: "movies", label: `${t("Movies")}  ${library.movies.length.toLocaleString(uiLocale())}`, on: tab === "movies" },
              { id: "series", label: `${t("Shows")}  ${library.series.length.toLocaleString(uiLocale())}`, on: tab === "series" },
            ],
          },
        ],
    onChip: (group, id) => {
      if (group === "source") setPlSheet(true);
      else if (group === "tab") chooseTab(id === "series" ? "series" : "movies");
    },
    search: selected
      ? null
      : { key: `vod:${activeId}:${tab}`, hint: tab === "movies" ? t("Search movies") : t("Search shows"), text: query, onQuery: setQuery },
    note: capNote,
    rows: nativeRows,
    message:
      state.kind === "error"
        ? { text: state.message, action: t("Try again"), onAction: refresh }
        : state.kind === "loading" && !playlist
          ? { text: t("Loading playlist...") }
          : !selected && tab === "movies" && movies.length === 0
            ? { text: emptyMoviesText(t, library.movies.length, q) }
            : !selected && tab === "series" && series.length === 0
              ? { text: emptyShowsText(t, library.series.length, q) }
              : null,
  });
  if (native || (pickerOpen && sources.length > 0)) {
    // The playlist menu is the page's own: it opens here, over a plain page, while the native
    // screen steps aside.
    return (
      <main data-rail-flush className="relative flex min-h-0 flex-1 flex-col pt-20">
        <header className={`relative z-[40] flex shrink-0 items-center px-4 py-2.5 ${pickerOpen ? "" : "pointer-events-none opacity-0"}`}>
          <SourcePicker
            sources={sources}
            activeId={activeId}
            exportEnabled={false}
            onSelect={selectId}
            onAdd={addPlaylist}
            onEdit={editPlaylist}
            onRemove={removePlaylist}
            onRefresh={refresh}
            onExport={() => {}}
            fetchedAt={playlist?.fetchedAt ?? null}
            channelCount={null}
            loading={state.kind === "loading"}
            openRequest={pickerRequest}
            addRequest={addRequest}
            editRequest={editRequest}
            onOpenChange={setPickerOpen}
          />
        </header>
      </main>
    );
  }

  if (sources.length === 0) {
    return (
      <main data-rail-flush className="relative flex min-h-0 flex-1 flex-col overflow-y-auto pt-20">
        <PlaylistEmpty onSave={addPlaylist} />
      </main>
    );
  }

  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(150 * (settings.posterScale ?? 1))}px, 1fr))`,
  };

  return (
    <main data-rail-flush className="relative flex min-h-0 flex-1 flex-col pt-20">
      <header className="relative z-[40] flex shrink-0 flex-wrap items-center gap-2.5 border-b border-edge-soft/40 bg-surface px-6 py-2.5">
        <SourcePicker
          sources={sources}
          activeId={activeId}
          exportEnabled={false}
          onSelect={selectId}
          onAdd={addPlaylist}
          onEdit={editPlaylist}
          onRemove={removePlaylist}
          onRefresh={refresh}
          onExport={() => {}}
          fetchedAt={playlist?.fetchedAt ?? null}
          channelCount={null}
          loading={state.kind === "loading"}
        />
        <div className="flex h-11 items-center gap-0.5 rounded-xl border border-edge-soft/55 bg-elevated p-1">
          <TabButton active={tab === "movies"} onClick={() => chooseTab("movies")} icon={<Film size={14} strokeWidth={2} />} label={t("Movies")} count={library.movies.length} />
          <TabButton active={tab === "series"} onClick={() => chooseTab("series")} icon={<Tv size={14} strokeWidth={2} />} label={t("Shows")} count={library.series.length} />
        </div>
        <div className="flex h-11 flex-1 min-w-[220px] items-center gap-2.5 rounded-xl border border-edge-soft/55 bg-elevated px-3.5">
          <Search size={15} strokeWidth={2} className="text-ink-subtle" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "movies" ? t("Search movies") : t("Search shows")}
            className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-subtle focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink">
              {t("Clear")}
            </button>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pt-6 pb-16">
        {state.kind === "error" ? (
          <Notice text={state.message} onRetry={refresh} />
        ) : state.kind === "loading" && !playlist ? (
          <Notice text={t("Loading playlist...")} />
        ) : selected ? (
          <SeriesDetail series={selected} onBack={() => setSelected(null)} onPlay={(ep) => playEpisode(selected, ep)} />
        ) : tab === "movies" ? (
          movies.length === 0 ? (
            <Notice text={emptyMoviesText(t, library.movies.length, q)} />
          ) : (
            <>
              <CapNote shown={Math.min(movies.length, RENDER_CAP)} total={movies.length} kind="movies" />
              <div className="grid gap-x-4 gap-y-6" style={gridStyle}>
                {movies.slice(0, RENDER_CAP).map((m) => (
                  <VodCard key={m.id} kind="movie" title={m.title} year={m.year} logo={m.logo} seed={m.title} onClick={() => playMovie(m)} />
                ))}
              </div>
            </>
          )
        ) : series.length === 0 ? (
          <Notice text={emptyShowsText(t, library.series.length, q)} />
        ) : (
          <>
            <CapNote shown={Math.min(series.length, RENDER_CAP)} total={series.length} kind="shows" />
            <div className="grid gap-x-4 gap-y-6" style={gridStyle}>
              {series.slice(0, RENDER_CAP).map((s) => (
                <VodCard
                  key={s.id}
                  kind="series"
                  title={s.title}
                  year={null}
                  logo={s.logo}
                  seed={s.title}
                  subtitle={
                    s.episodes.length === 1
                      ? t("{n} episode", { n: 1 })
                      : t("{n} episodes", { n: s.episodes.length })
                  }
                  onClick={() => setSelected(s)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function emptyMoviesText(t: Translate, total: number, query: string): string {
  if (query) return t('No movies match "{query}".', { query });
  if (total === 0)
    return t(
      "This playlist has no movies. It may be live channels only, or an Xtream login that exposes movies separately.",
    );
  return t("No movies here.");
}

function emptyShowsText(t: Translate, total: number, query: string): string {
  if (query) return t('No shows match "{query}".', { query });
  if (total === 0)
    return t(
      "This playlist has no shows. It may be live channels only, or an Xtream login that exposes shows separately.",
    );
  return t("No shows here.");
}

function vodMeta(id: string, type: "movie" | "series", name: string, logo: string | null, year: number | null): Meta {
  return {
    id,
    type,
    name,
    poster: logo ?? undefined,
    background: logo ?? undefined,
    releaseInfo: year ? String(year) : undefined,
  };
}

function TabButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-full items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-colors ${
        active ? "bg-ink text-canvas" : "text-ink-muted hover:bg-raised hover:text-ink"
      }`}
    >
      {icon}
      {label}
      {count > 0 && (
        <span className={`rounded-full px-1.5 text-[10.5px] tabular-nums ${active ? "bg-canvas/25" : "bg-canvas/70 text-ink-subtle"}`}>
          {count.toLocaleString(uiLocale())}
        </span>
      )}
    </button>
  );
}

function CapNote({ shown, total, kind }: { shown: number; total: number; kind: "movies" | "shows" }) {
  const t = useT();
  if (total <= shown) return null;
  const text =
    kind === "movies"
      ? t("Showing {shown} of {total} movies. Search to find the rest.", {
          shown: shown.toLocaleString(uiLocale()),
          total: total.toLocaleString(uiLocale()),
        })
      : t("Showing {shown} of {total} shows. Search to find the rest.", {
          shown: shown.toLocaleString(uiLocale()),
          total: total.toLocaleString(uiLocale()),
        });
  return <p className="mb-4 text-[12.5px] text-ink-subtle">{text}</p>;
}

function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-edge px-6 py-16 text-center">
      <p className="max-w-[520px] text-[14.5px] leading-relaxed text-ink-muted">{text}</p>
      {onRetry && (
        <button onClick={onRetry} className="h-9 rounded-lg bg-elevated px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-raised">
          {t("Try again")}
        </button>
      )}
    </div>
  );
}
