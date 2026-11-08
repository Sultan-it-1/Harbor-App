import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Search, X } from "lucide-react";
import { BackToTop } from "@/components/back-to-top";
import { PickCard } from "@/components/pick-card";
import type { Meta } from "@/lib/cinemeta";
import { useT } from "@/lib/i18n";
import { isPhoneLayout } from "@/lib/platform";
import { useSearch } from "@/lib/search-context";
import { hasQuery, smartFilter } from "@/lib/smart-search";
import { layoutHasGlobalBack } from "@/lib/theme";
import { useScrollMemory, useView, type GridSpec } from "@/lib/view";
import { useNativeBrowsePage, type NativeRowInput } from "@/views/native/native-screens";

const PAGE_CAP = 40;
const PHONE = isPhoneLayout();

function dedupe(list: Meta[]): Meta[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export function GridView({ grid }: { grid: GridSpec }) {
  const t = useT();
  const { goBack, topKind } = useView();
  const { setQuery: setGlobalQuery, setOpen: setGlobalOpen } = useSearch();
  const scrollRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [metas, setMetas] = useState<Meta[]>(() => dedupe(grid.initial ?? []));
  const [page, setPage] = useState(grid.initial?.length ? 1 : 0);
  const [done, setDone] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const pageRef = useRef(page);
  const metasRef = useRef(metas);
  metasRef.current = metas;
  useScrollMemory(`grid:${grid.title}`, scrollRef);

  // Search: typing never blocks, and it covers the whole list (the rest of the pages load while
  // you search), not just what happens to be on screen.
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const searching = hasQuery(deferred);
  const result = useMemo(() => (searching ? smartFilter(metas, deferred) : null), [searching, metas, deferred]);
  const shown = result ? result.items : metas;

  const loadNext = useCallback(() => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const next = pageRef.current + 1;
    grid
      .fetcher(next)
      .then((batch) => {
        pageRef.current = next;
        setPage(next);
        if (batch.length === 0 || next >= PAGE_CAP) {
          doneRef.current = true;
          setDone(true);
          return;
        }
        const have = new Set(metasRef.current.map((m) => m.id));
        const fresh = dedupe(batch).filter((m) => !have.has(m.id));
        if (fresh.length === 0) {
          doneRef.current = true;
          setDone(true);
          return;
        }
        setMetas((prev) => [...prev, ...fresh]);
      })
      .catch(() => {
        doneRef.current = true;
        setDone(true);
      })
      .finally(() => {
        loadingRef.current = false;
        setLoadingMore(false);
      });
  }, [grid]);

  // Scrolling near the end loads the next page.
  useEffect(() => {
    if (done) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadNext();
      },
      { rootMargin: "900px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [done, page, loadNext]);

  // While there is something typed, keep loading until the whole list is in.
  useEffect(() => {
    if (searching && !done && !loadingMore) loadNext();
  }, [searching, done, loadingMore, page, loadNext]);

  const total = metas.length;
  const searchEverywhere = () => {
    setGlobalQuery(query.trim());
    setGlobalOpen(true);
  };

  // Android: drawn natively (see @/views/native/native-screens) like the page: the title and its
  // count, the search field held at the top, the posters two or more across, the next page near
  // the end. The page then stays empty underneath.
  const nativeRows = useMemo<NativeRowInput[]>(
    () => [{ key: "grid", title: "", metas: shown, grid: true, min: 140, more: searching || done ? undefined : loadNext }],
    [shown, searching, done, loadNext],
  );
  const nativeHeader = useMemo(
    () => ({
      title: grid.title,
      size: 26,
      count: result
        ? t("{shown} of {total} titles", { shown: result.items.length, total })
        : t("{n} titles", { n: total }),
    }),
    [grid.title, result, total, t],
  );
  const nativeSearch = useMemo(
    () => ({
      key: `grid:${grid.title}`,
      hint: t("Search in {title}", { title: grid.title }),
      text: query,
      busy: searching && !done,
      onQuery: setQuery,
    }),
    [grid.title, query, searching, done, t],
  );
  const noMatch = searching && shown.length === 0;
  const nothing = done && !searching && metas.length === 0;
  const native = useNativeBrowsePage("grid", {
    scrollKey: grid.title,
    active: topKind === "grid",
    t,
    back: true,
    header: nativeHeader,
    search: nativeSearch,
    rows: nativeRows,
    note:
      result?.partial && result.items.length > 0
        ? t("No title has every word. Showing the closest matches.")
        : searching && !done && shown.length > 0
          ? t("Searching all titles… {n} checked", { n: total })
          : null,
    message: noMatch
      ? {
          title: t('No titles match "{query}"', { query: query.trim() }),
          text: done ? t("Checked all {n} titles in this list.", { n: total }) : t("Still checking the rest of the list…"),
          action: t('Search everywhere for "{query}"', { query: query.trim() }),
          onAction: searchEverywhere,
        }
      : nothing
        ? { text: t("Nothing here yet.") }
        : null,
  });
  if (native) return <main ref={scrollRef} aria-hidden="true" className="absolute inset-0 z-30 overflow-hidden bg-canvas" />;

  return (
    <main ref={scrollRef} className="absolute inset-0 z-30 overflow-y-auto bg-canvas">
      <div className={`flex w-full flex-col ${PHONE ? "gap-5 px-4 pb-24 pt-20" : "gap-8 px-12 pb-24 pt-24"}`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {!layoutHasGlobalBack() && (
            <button
              onClick={goBack}
              aria-label={t("Back")}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-elevated text-ink-muted transition-colors hover:text-ink"
            >
              <ArrowLeft size={18} strokeWidth={2.2} />
            </button>
          )}
          <h1
            className={`font-display font-medium leading-none tracking-tight text-ink ${PHONE ? "text-[26px]" : "text-[30px]"}`}
          >
            {grid.title}
          </h1>
          <span className="text-[14px] text-ink-subtle">
            {result
              ? t("{shown} of {total} titles", { shown: result.items.length, total })
              : t("{n} titles", { n: total })}
          </span>
        </div>
        {/* On a phone the search bar stays under the top buttons while the list scrolls. */}
        <div
          className={
            PHONE
              ? "sticky top-[60px] z-20 -mx-4 -my-2 bg-canvas/90 px-4 py-2 backdrop-blur-md"
              : "-mt-3 w-full max-w-xl"
          }
        >
          <div className="flex h-11 items-center gap-2.5 rounded-xl border border-edge-soft/60 bg-elevated px-3.5 transition-colors focus-within:border-accent/60">
            <Search size={16} strokeWidth={2.1} className="shrink-0 text-ink-subtle" />
            <input
              type="text"
              inputMode="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder={t("Search in {title}", { title: grid.title })}
              aria-label={t("Search in {title}", { title: grid.title })}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[14.5px] text-ink placeholder:text-ink-subtle focus:outline-none"
            />
            {searching && !done && <Loader2 size={15} className="shrink-0 animate-spin text-ink-subtle" />}
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("Clear")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-subtle transition-colors hover:text-ink"
              >
                <X size={15} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>

        {result?.partial && result.items.length > 0 && (
          <p className="text-[13px] text-ink-muted">
            {t("No title has every word. Showing the closest matches.")}
          </p>
        )}

        {shown.length > 0 && (
          <div
            className={`grid gap-x-4 gap-y-8 ${PHONE ? "grid-cols-[repeat(auto-fill,minmax(140px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]"}`}
          >
            {shown.map((m) => (
              <PickCard key={m.id} meta={m} />
            ))}
          </div>
        )}

        {searching && shown.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-[15px] font-medium text-ink">{t('No titles match "{query}"', { query: query.trim() })}</p>
            <p className="text-[13px] text-ink-subtle">
              {done ? t("Checked all {n} titles in this list.", { n: total }) : t("Still checking the rest of the list…")}
            </p>
            <button
              type="button"
              onClick={searchEverywhere}
              className="mt-1 flex h-10 items-center gap-2 rounded-full border border-edge-soft bg-elevated px-4 text-[13.5px] font-semibold text-ink transition-colors hover:border-edge"
            >
              <Search size={14} strokeWidth={2.2} />
              {t('Search everywhere for "{query}"', { query: query.trim() })}
            </button>
          </div>
        )}

        {searching && !done && shown.length > 0 && (
          <div className="flex items-center justify-center gap-2 text-[12.5px] text-ink-subtle">
            <Loader2 size={14} className="animate-spin" />
            {t("Searching all titles… {n} checked", { n: total })}
          </div>
        )}

        {!done && <div ref={sentinelRef} className="h-24" />}
        {done && !searching && metas.length === 0 && (
          <p className="py-20 text-center text-[14px] text-ink-subtle">{t("Nothing here yet.")}</p>
        )}
      </div>
      <BackToTop scrollRef={scrollRef} />
    </main>
  );
}
