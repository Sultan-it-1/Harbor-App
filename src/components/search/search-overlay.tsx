import { isPhoneLayout } from "@/lib/platform";
import { PHONE_TABBAR_H } from "@/chrome/phone-tabbar";
import { Search, X, Loader2, CornerDownLeft, CalendarRange, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import { useNativeBrowsePage, useNativeScreensEnabled, type NativeRowInput } from "@/views/native/native-screens";
import { NativeRowSinkContext, useNativeRowSink } from "@/views/native/native-sink";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { useSearch } from "@/lib/search-context";
import { useView } from "@/lib/view";
import { MOVIE_GENRES, TV_GENRES } from "@/lib/feed/tags";
import { AnimeRow } from "./anime-row";
import { EmptyState } from "./empty-state";
import { GuideModal } from "./guide-modal";
import { LiveTvRow } from "./live-tv-row";
import { TopMatch } from "./top-match";
import { PeopleRow } from "./people-row";
import { MetaList } from "./meta-list";
import { AddonHits } from "./addon-hits";
import { AddonResults } from "./addon-results";
import { MagnetCard } from "./magnet-card";
import { UrlCard } from "./url-card";
import { AiSearchSection } from "./ai-search-section";
import { isMagnetInput, isDirectVideoUrl } from "@/lib/torrent/magnet";

const PHONE = isPhoneLayout();

export function SearchOverlay() {
  const { open, setOpen, query, setQuery, results, status, clear, recordRecent } = useSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const { openFilter, openMeta, openPerson, openAddonDetail, openPlayer } = useView();
  const t = useT();
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(id);
      document.body.style.overflow = "";
    };
  }, [open]);

  // Android: the search screen drawn natively (see @/views/native/native-screens) like the page:
  // the big field at the top (the keyboard up at once), then before typing: recent searches, Jump
  // to, Try a genre, Surprise me (handed over by EmptyState); after: Browse <genre/year>, the top
  // match, Live TV, Addons, People, Movies and Series listed, Anime, then each addon's results.
  // A magnet or video link, and the AI suggestions, keep the page for now.
  const nativeOn = useNativeScreensEnabled();
  const [sink, sinkRows] = useNativeRowSink(nativeOn);
  const [openSeq, setOpenSeq] = useState(0);
  useEffect(() => {
    if (open) setOpenSeq((n) => n + 1);
  }, [open]);
  const tq = query.trim();
  const directNow = !!tq && (isMagnetInput(tq) || isDirectVideoUrl(tq));
  const closeSearch = () => {
    if (tq && results) recordRecent(query);
    setOpen(false);
  };
  const latestClose = useRef(closeSearch);
  latestClose.current = closeSearch;
  const resultRows = useMemo<NativeRowInput[]>(() => {
    if (!tq || !results) return [];
    const done = (f: () => void) => {
      latestClose.current();
      f();
    };
    const out: NativeRowInput[] = [];
    const intent = results.intent;
    if (intent) {
      out.push({
        key: "intent",
        title: "",
        kind: "action",
        metas: [],
        cards: [{ title: intent.label, kicker: t("Browse"), icon: intent.kind === "year" ? "calendar" : "tag" }],
        onOpen: () => {
          if (intent.kind === "genre") {
            const id = (intent.mediaType === "movie" ? MOVIE_GENRES : TV_GENRES)[intent.genre];
            if (typeof id === "number") done(() => openFilter({ kind: "genre", mediaType: intent.mediaType, name: intent.genre, id }));
          } else {
            done(() => openFilter({ kind: "year", mediaType: "movie", value: intent.year }));
          }
        },
      });
    }
    const top = results.topMatch;
    if (top) {
      out.push({
        key: "top",
        title: t("Top match"),
        kind: "feature",
        metas: [top.meta],
        cards: [
          {
            title: top.meta.name,
            kicker: top.kind === "movie" ? t("Movie") : t("Series"),
            sub: top.overview ?? top.meta.description ?? null,
            img: [top.backdrop, top.meta.background, top.meta.poster].filter((u, i, a): u is string => !!u && a.indexOf(u) === i),
            rating: top.meta.imdbRating ?? (top.voteAverage ? top.voteAverage.toFixed(1) : null),
          },
        ],
        onOpen: () => done(() => openMeta(top.meta)),
      });
    }
    if (results.liveTv.length > 0) {
      const hits = results.liveTv;
      out.push({
        key: "live",
        title: t("Live TV"),
        kind: "logo",
        metas: [],
        cards: hits.map((h) => ({ title: h.name, img: h.logo ? [h.logo] : [] })),
        onOpen: (i) => {
          const hit = hits[i];
          if (!hit) return;
          const meta: Meta = {
            id: `iptv:${hit.playlistId}:${hit.channelId}`,
            type: "tv",
            name: hit.name,
            poster: hit.logo ?? undefined,
            logo: hit.logo ?? undefined,
            background: hit.logo ?? undefined,
            description: hit.group ? `Live channel · ${hit.group}` : "Live channel",
            releaseInfo: "Live",
          } as Meta;
          done(() => openPlayer({ meta, url: hit.url, title: hit.name, subtitle: hit.group ?? "Live", notWebReady: true }));
        },
      });
    }
    if (results.addons.length > 0) {
      const addons = results.addons;
      out.push({
        key: "addons",
        title: t("Addons"),
        kind: "logo",
        metas: [],
        cards: addons.map((a) => ({ title: a.name, img: a.logo ? [a.logo] : [] })),
        onOpen: (i) => {
          const a = addons[i];
          if (a) done(() => openAddonDetail(a.id));
        },
      });
    }
    if (results.people.length > 0) {
      const people = results.people;
      out.push({
        key: "people",
        title: t("People"),
        kind: "people",
        metas: [],
        cards: people.map((p) => ({ title: p.name, sub: p.knownFor || null, img: p.profile ? [`https://image.tmdb.org/t/p/w185${p.profile}`] : [] })),
        onOpen: (i) => {
          const p = people[i];
          if (p) done(() => openPerson(p.id));
        },
      });
    }
    const listed = (key: string, title: string, items: Meta[]) => {
      if (items.length === 0) return;
      out.push({
        key,
        title,
        kind: "list",
        metas: items,
        cards: items.map((m) => ({
          title: m.name,
          sub: [m.releaseInfo, m.imdbRating ? `★ ${m.imdbRating}` : null].filter(Boolean).join("  ·  ") || null,
          img: [m.poster, /^tt\d+/.test(m.id) ? `https://images.metahub.space/poster/medium/${m.id.split(":")[0]}/img` : null].filter(
            (u): u is string => !!u,
          ),
        })),
        onOpen: (i) => {
          const m = items[i];
          if (m) done(() => openMeta(m));
        },
      });
    };
    listed("movies", t("Movies"), results.movies);
    listed("series", t("Series"), results.series);
    if (results.anime.length > 0) {
      const anime = results.anime;
      out.push({
        key: "anime",
        title: t("Anime"),
        kind: "poster",
        metas: [],
        cards: anime.map((h) => ({ title: h.name, img: h.poster ? [h.poster] : [] })),
        onOpen: (i) => {
          const hit = anime[i];
          if (!hit) return;
          const meta = {
            id: hit.kitsuId ? `kitsu:${hit.kitsuId}` : `mal:${hit.malId}`,
            type: "anime",
            name: hit.name,
            poster: hit.poster ?? undefined,
            background: hit.background ?? hit.poster ?? undefined,
            description: hit.overview,
            releaseInfo: hit.year ?? undefined,
            imdbRating: hit.score > 0 ? hit.score.toFixed(1) : undefined,
          } as Meta;
          done(() => openMeta(meta));
        },
      });
    }
    for (const g of results.addonGroups) {
      if (g.metas.length === 0) continue;
      out.push({
        key: `ag:${g.id}`,
        title: g.name,
        sub: t("From your addons"),
        metas: g.metas,
        onOpen: (i) => {
          const m = g.metas[i];
          if (m) done(() => openMeta(m));
        },
      });
    }
    return out;
  }, [tq, results, t, openFilter, openMeta, openPerson, openAddonDetail, openPlayer]);
  const resultsIn =
    !!results &&
    !!(results.topMatch || results.people.length || results.movies.length || results.series.length || results.liveTv.length || results.anime.length || results.addons.length || results.addonGroups.length);
  const stillSearching = !!tq && !directNow && status !== "done";
  const nativeSearch = useMemo(
    () => ({
      key: `search:${openSeq}`,
      hint: t("Search movies, shows, people, genres, years..."),
      text: query,
      busy: (status === "loading" || status === "typing") && !!tq,
      onQuery: setQuery,
      big: true,
      focus: true,
      onSubmit: () => {
        const m = results?.topMatch?.meta;
        if (!m) return;
        recordRecent(query);
        setOpen(false);
        openMeta(m);
      },
    }),
    [openSeq, t, query, status, tq, setQuery, results, recordRecent, setOpen, openMeta],
  );
  const native = useNativeBrowsePage("search", {
    active: open,
    blocked: false,
    hidden: guideOpen,
    noTogether: true,
    t,
    search: nativeSearch,
    // A magnet or video link: its card (the sink); otherwise Browse, the AI card (the sink), the rest.
    rows: !tq
      ? sinkRows
      : directNow
        ? sinkRows
        : resultRows[0]?.key === "intent"
          ? [resultRows[0], ...sinkRows, ...resultRows.slice(1)]
          : [...sinkRows, ...resultRows],
    message: !tq || directNow
      ? null
      : stillSearching
        ? { text: resultsIn ? t("Searching more sources…") : t("Looking…") }
        : !resultsIn && results && status === "done"
          ? {
              title: t('No matches for "{query}"', { query: tq }),
              text: t('Try a different spelling, a person\'s name, a year like "1972", or a genre like "Horror".'),
            }
          : null,
  });

  if (!open) return null;
  if (native) {
    return createPortal(
      <>
        <NativeRowSinkContext.Provider value={sink}>
          {!tq && <EmptyState onClose={closeSearch} onOpenGuide={() => setGuideOpen(true)} />}
          {tq && isMagnetInput(tq) && <MagnetCard raw={tq} onClose={closeSearch} />}
          {tq && !isMagnetInput(tq) && isDirectVideoUrl(tq) && <UrlCard raw={tq} onClose={closeSearch} />}
          {tq && !directNow && <AiSearchSection query={tq} onClose={closeSearch} />}
        </NativeRowSinkContext.Provider>
        {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}
      </>,
      document.body,
    );
  }
  const close = () => {
    if (query.trim() && results) recordRecent(query);
    setOpen(false);
  };

  const onIntent = () => {
    const intent = results?.intent;
    if (!intent) return;
    if (intent.kind === "genre") {
      const id = (intent.mediaType === "movie" ? MOVIE_GENRES : TV_GENRES)[intent.genre];
      if (typeof id === "number") {
        recordRecent(query);
        openFilter({ kind: "genre", mediaType: intent.mediaType, name: intent.genre, id });
        setOpen(false);
      }
      return;
    }
    if (intent.kind === "year") {
      recordRecent(query);
      openFilter({ kind: "year", mediaType: "movie", value: intent.year });
      setOpen(false);
    }
  };

  const trimmed = query.trim();
  const magnetInput = !!trimmed && isMagnetInput(trimmed);
  const urlInput = !!trimmed && !magnetInput && isDirectVideoUrl(trimmed);
  const directInput = magnetInput || urlInput;
  const hasResults =
    results &&
    trimmed &&
    (results.topMatch ||
      results.people.length ||
      results.movies.length ||
      results.series.length ||
      results.liveTv.length ||
      results.anime.length ||
      results.addons.length ||
      results.addonGroups.length);
  const noResults =
    results &&
    trimmed &&
    status === "done" &&
    !results.topMatch &&
    results.people.length === 0 &&
    results.movies.length === 0 &&
    results.series.length === 0 &&
    results.liveTv.length === 0 &&
    results.anime.length === 0 &&
    results.addons.length === 0 &&
    results.addonGroups.length === 0;

  // Still waiting on at least one source: never say "no matches" yet.
  const searching = !!trimmed && !directInput && status !== "done";

  return createPortal(
    <div
      className={`fixed inset-x-0 top-0 flex flex-col ${PHONE ? "z-[185] bg-canvas" : "bottom-0 z-[200]"}`}
      // Phone: stop above the tab bar so one tap on a tab closes search and navigates.
      style={PHONE ? { bottom: `calc(${PHONE_TABBAR_H}px + env(safe-area-inset-bottom))` } : undefined}
    >
      {!PHONE && (
        <button
          aria-label={t("Close search")}
          onClick={close}
          className="harbor-search-backdrop absolute inset-0 cursor-default"
        />
      )}

      <div className={`relative mx-auto flex h-full w-full max-w-[1080px] flex-col ${PHONE ? "px-4 pb-2 pt-4" : "px-6 py-6 sm:px-10 sm:py-10"}`}>
        <div className="modal-panel flex shrink-0 items-center gap-3 rounded-2xl border border-edge-soft/80 bg-elevated/70 px-5 shadow-[0_24px_80px_-30px_rgba(0,0,0,0.7)]">
          <Search size={22} className="shrink-0 text-ink-muted" strokeWidth={1.9} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results?.topMatch) {
                e.preventDefault();
                recordRecent(query);
                const meta = results.topMatch.meta;
                setOpen(false);
                openMeta(meta);
              }
            }}
            placeholder={t("Search movies, shows, people, genres, years...")}
            className="h-16 flex-1 bg-transparent text-[20px] text-ink placeholder:text-ink-subtle focus:outline-none sm:text-[22px]"
            spellCheck={false}
            autoComplete="off"
          />
          {(status === "loading" || status === "typing") && trimmed && (
            <Loader2 size={18} className="shrink-0 animate-spin text-ink-subtle" />
          )}
          {query && (
            <button
              type="button"
              aria-label={t("Clear")}
              onClick={clear}
              className="flex h-10 w-10 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-canvas/60 hover:text-ink"
            >
              <X size={18} strokeWidth={2.2} />
            </button>
          )}
          <Hint />
        </div>

        <div className="relative mt-6 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {!trimmed && <EmptyState onClose={close} onOpenGuide={() => setGuideOpen(true)} />}

          {magnetInput && (
            <div className="mb-5">
              <MagnetCard raw={trimmed} onClose={close} />
            </div>
          )}

          {urlInput && (
            <div className="mb-5">
              <UrlCard raw={trimmed} onClose={close} />
            </div>
          )}

          {trimmed && !directInput && results?.intent && (
            <button
              onClick={onIntent}
              className="mb-5 flex h-14 w-full items-center gap-3 rounded-2xl border border-accent/40 bg-accent/10 px-5 text-start transition-colors hover:bg-accent/15"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/20 text-accent">
                {results.intent.kind === "year" ? (
                  <CalendarRange size={16} strokeWidth={2.1} />
                ) : (
                  <Tag size={16} strokeWidth={2.1} />
                )}
              </span>
              <span className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                  {t("Browse")}
                </span>
                <span className="text-[15px] font-semibold text-ink">{results.intent.label}</span>
              </span>
              <CornerDownLeft size={15} className="ms-auto text-ink-subtle" />
            </button>
          )}

          {trimmed && !directInput && <AiSearchSection query={trimmed} onClose={close} />}

          {trimmed && !directInput && hasResults && results && (
            <div className="flex flex-col gap-8 pb-12">
              {results.topMatch && <TopMatch match={results.topMatch} onClose={close} />}
              <LiveTvRow items={results.liveTv} onClose={close} />
              <AddonHits hits={results.addons} onClose={close} />
              <PeopleRow people={results.people} onClose={close} />
              <div className="grid gap-8 lg:grid-cols-2">
                <MetaList title={t("Movies")} items={results.movies} onClose={close} />
                <MetaList title={t("Series")} items={results.series} onClose={close} />
              </div>
              <AnimeRow items={results.anime} onClose={close} />
              <AddonResults groups={results.addonGroups} onClose={close} />
              {searching && (
                <div className="flex items-center justify-center gap-2 text-[12.5px] text-ink-subtle">
                  <Loader2 size={14} className="animate-spin" />
                  {t("Searching more sources…")}
                </div>
              )}
            </div>
          )}

          {noResults && !directInput && (
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
              <span className="text-[17px] font-semibold text-ink">{t("No matches for \"{query}\"", { query: trimmed })}</span>
              <span className="max-w-[44ch] text-[14px] text-ink-muted">
                {t("Try a different spelling, a person's name, a year like \"1972\", or a genre like \"Horror\".")}
              </span>
            </div>
          )}

          {searching && !hasResults && (
            <div className="flex flex-col items-center gap-3 pt-16 text-ink-muted">
              <Loader2 size={22} className="animate-spin" />
              <span className="text-[13.5px]">{t("Looking…")}</span>
            </div>
          )}
        </div>
      </div>
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}
    </div>,
    document.body,
  );
}

function Hint() {
  return (
    <span className="hidden shrink-0 items-center gap-1 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle sm:flex">
      <kbd className="rounded-md border border-edge-soft bg-canvas/60 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
        Esc
      </kbd>
    </span>
  );
}
