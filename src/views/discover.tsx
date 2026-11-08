import { isPhoneLayout } from "@/lib/platform";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackToTop } from "@/components/back-to-top";
import { CollectionsRow } from "@/components/collections-row";
import { CriticsPick } from "@/components/critics-pick";
import { LazyMount } from "@/components/lazy-mount";
import { DiscoveryQueueCta } from "@/components/discovery-queue-cta";
import { FeaturedBanner } from "@/components/featured-banner";
import { AwardTiles } from "@/components/award-tiles";
import { GenreTiles } from "@/components/genre-tiles";
import { LanguageTiles } from "@/components/language-tiles";
import { ScrollRootContext } from "@/components/row";
import type { Meta } from "@/lib/cinemeta";
import { fetchCriticsPickList, fetchFeatured, getPool, selectDailyRows, type FeedItem } from "@/lib/feed";
import { getStore, subscribe as subscribeTaste } from "@/lib/discover/store";
import { getDownvotedIds, getUpvotedIds, subscribePrefs } from "@/lib/feed/preferences";
import { recentlyPlayed, subscribePlayback, watchTitleKey } from "@/lib/playback-history";
import { useSettings } from "@/lib/settings";
import { useScrollMemory } from "@/lib/view";
import { Rail } from "./discover/discover-rail";
import { useDedupedRows } from "./discover/use-deduped-rows";
import { ANCHOR_AWARDS, ANCHOR_TOP_RATED } from "@/lib/feed/daily-rows-anchors";
import { CatalogCustomizeBar } from "@/components/catalog/customize-bar";
import { RowControls } from "@/views/home/row-controls";
import { useT } from "@/lib/i18n";
import {
  applyPageRows,
  hasPageRowChanges,
  movePageRow,
  orderedRowKeys,
  renamePageRow,
  resetPageRows,
  togglePageRowHidden,
  usePageRows,
} from "@/lib/page-rows";

import { useNativeBrowsePage, useNativeScreensEnabled, type NativeRowInput } from "@/views/native/native-screens";
import {
  useAwardTilesRow,
  useCriticsRow,
  queueRow,
  useCollectionsRow,
  useGenreTilesRow,
  useLanguageTilesRow,
} from "@/views/native/native-sections";
import { useView } from "@/lib/view";

// Discover's own sections, listed with the rails so the page's editor can hide, move and rename
// them like any row ("x:" keys). Their default places are where they always sat: after the rail
// with that index.
const SECTIONS: Array<{ key: string; title: string; after: number }> = [
  { key: "x:genres", title: "Browse by Genre", after: 0 },
  { key: "x:queue", title: "Your Discovery Queue", after: 1 },
  { key: "x:languages", title: "Browse by Language", after: 2 },
  { key: "x:collections", title: "Collections", after: 2 },
  { key: "x:critics", title: "Critics' Pick", after: 3 },
  { key: "x:awards", title: "Browse by Award", after: 4 },
];
const MAX_RAIL_PAGES = 10;
const MIN_PAGE_YIELD = 4;
const ROW_COUNT = 14;
const DEDUP_PRIORITY = [ANCHOR_TOP_RATED, ANCHOR_AWARDS];

const PHONE = isPhoneLayout();

export function Discover({ active = true }: { active?: boolean }) {
  const scrollRef = useRef<HTMLElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const scrollCb = useCallback((el: HTMLElement | null) => {
    (scrollRef as { current: HTMLElement | null }).current = el;
    setScrollEl(el);
  }, []);
  useScrollMemory("discover", scrollRef, active);

  const { settings } = useSettings();
  const t = useT();
  const pageRows = usePageRows("discover");
  const [featured, setFeatured] = useState<Meta[]>([]);
  const [queue, setQueue] = useState<FeedItem[]>([]);
  const [criticsPickList, setCriticsPickList] = useState<Meta[]>([]);
  const [tasteVersion, setTasteVersion] = useState(0);
  const [rails, setRails] = useState<Record<string, Meta[]>>({});
  const railPagesRef = useRef<Record<string, number>>({});
  const railExhaustedRef = useRef<Record<string, boolean>>({});
  const railLoadingRef = useRef<Record<string, boolean>>({});
  const genRef = useRef(0);

  const dailyRows = useMemo(
    () => selectDailyRows(settings.tmdbKey, getStore().affinity, settings, ROW_COUNT),
    [settings.tmdbKey, settings.region, settings.streaming, tasteVersion],
  );
  const rowSig = useMemo(() => dailyRows.map((r) => r.id).join("|"), [dailyRows]);

  useEffect(() => {
    let cancelled = false;
    fetchFeatured(settings.tmdbKey, settings).then((m) => !cancelled && setFeatured(m));
    return () => {
      cancelled = true;
    };
  }, [
    settings.tmdbKey,
    settings.tmdbLanguage,
    settings.region,
    settings.feedLocaleBias,
    settings.preferredLanguages,
    tasteVersion,
  ]);

  useEffect(() => {
    let cancelled = false;
    const hidden = new Set<string>([...getDownvotedIds(), ...getUpvotedIds()]);
    getPool(settings.tmdbKey).then(async (p) => {
      if (cancelled) return;
      const { filterQueuePool } = await import("@/lib/feed/skipped");
      setQueue(filterQueuePool(p).filter((it) => !hidden.has(it.meta.id)));
    });
    fetchCriticsPickList(settings.tmdbKey, settings).then(
      (list) => !cancelled && setCriticsPickList(list.filter((x) => !hidden.has(x.id))),
    );
    return () => {
      cancelled = true;
    };
  }, [
    settings.tmdbKey,
    settings.region,
    settings.feedLocaleBias,
    settings.preferredLanguages,
    settings.tmdbLanguage,
  ]);

  useEffect(() => {
    let timer = 0;
    const bump = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setTasteVersion((v) => v + 1), 600);
    };
    const dropWatched = () => {
      const watched = recentlyPlayed();
      if (watched.ids.size === 0 && watched.titles.size === 0) return;
      const isWatched = (m: Meta) =>
        watched.ids.has(m.id) || watched.titles.has(watchTitleKey(m.name));
      setFeatured((prev) => {
        const next = prev.filter((m) => !isWatched(m));
        return next.length === prev.length ? prev : next;
      });
      setQueue((prev) => {
        const next = prev.filter((it) => !isWatched(it.meta));
        return next.length === prev.length ? prev : next;
      });
      setCriticsPickList((prev) => {
        const next = prev.filter((m) => !isWatched(m));
        return next.length === prev.length ? prev : next;
      });
    };
    const offTaste = subscribeTaste(bump);
    const offPrefs = subscribePrefs(() => {
      const blocked = new Set<string>([...getDownvotedIds(), ...getUpvotedIds()]);
      setFeatured((prev) => prev.filter((m) => !blocked.has(m.id)));
      setQueue((prev) => prev.filter((it) => !blocked.has(it.meta.id)));
      setCriticsPickList((prev) => prev.filter((m) => !blocked.has(m.id)));
      bump();
    });
    const offPlayback = subscribePlayback(() => {
      dropWatched();
      bump();
    });
    return () => {
      clearTimeout(timer);
      offTaste();
      offPrefs();
      offPlayback();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const watched = recentlyPlayed();
    if (watched.ids.size === 0 && watched.titles.size === 0) return;
    const isWatched = (m: Meta) =>
      watched.ids.has(m.id) || watched.titles.has(watchTitleKey(m.name));
    setFeatured((prev) => prev.filter((m) => !isWatched(m)));
    setQueue((prev) => prev.filter((it) => !isWatched(it.meta)));
    setCriticsPickList((prev) => prev.filter((m) => !isWatched(m)));
  }, [active]);

  const ensureLoaded = useCallback(
    (railId: string) => {
      if (railPagesRef.current[railId] != null) return;
      if (railLoadingRef.current[railId]) return;
      const def = dailyRows.find((r) => r.id === railId);
      if (!def) return;
      const gen = genRef.current;
      railLoadingRef.current[railId] = true;
      def
        .fetch(1)
        .then((list) => {
          if (genRef.current !== gen) return;
          railPagesRef.current[railId] = 1;
          if (list.length < MIN_PAGE_YIELD) railExhaustedRef.current[railId] = true;
          setRails((prev) => ({ ...prev, [railId]: list }));
        })
        .catch(() => {
          if (genRef.current !== gen) return;
          railPagesRef.current[railId] = 1;
          railExhaustedRef.current[railId] = true;
          setRails((prev) => ({ ...prev, [railId]: [] }));
        })
        .finally(() => {
          if (genRef.current === gen) railLoadingRef.current[railId] = false;
        });
    },
    [dailyRows],
  );

  const ensureLoadedRef = useRef(ensureLoaded);
  ensureLoadedRef.current = ensureLoaded;

  useEffect(() => {
    genRef.current += 1;
    setRails({});
    railPagesRef.current = {};
    railExhaustedRef.current = {};
    railLoadingRef.current = {};
    for (const id of DEDUP_PRIORITY) ensureLoadedRef.current(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSig, settings.tmdbKey, settings.region, settings.streaming, settings.tmdbLanguage]);

  const loadMore = useCallback(
    (railId: string) => {
      if (railLoadingRef.current[railId]) return;
      if (railExhaustedRef.current[railId]) return;
      const cur = railPagesRef.current[railId] ?? 1;
      if (cur >= MAX_RAIL_PAGES) return;
      const def = dailyRows.find((r) => r.id === railId);
      if (!def) return;
      const next = cur + 1;
      railLoadingRef.current[railId] = true;
      def
        .fetch(next)
        .then((list) => {
          railPagesRef.current[railId] = next;
          if (list.length < MIN_PAGE_YIELD) railExhaustedRef.current[railId] = true;
          setRails((prev) => ({ ...prev, [railId]: [...(prev[railId] ?? []), ...list] }));
        })
        .catch(() => {})
        .finally(() => {
          railLoadingRef.current[railId] = false;
        });
    },
    [dailyRows],
  );

  const featuredIds = useMemo(() => new Set(featured.map((m) => m.id)), [featured]);

  const criticsPick = useMemo(() => {
    const candidates = criticsPickList.filter(
      (m) => !featuredIds.has(m.id) && m.background && m.description,
    );
    if (candidates.length === 0) {
      return criticsPickList.find((m) => !featuredIds.has(m.id)) ?? null;
    }
    const dayOfYear = Math.floor(
      (Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86_400_000,
    );
    return candidates[dayOfYear % candidates.length];
  }, [criticsPickList, featuredIds]);

  const order = useMemo(() => dailyRows.map((r) => r.id), [dailyRows]);
  const deduped = useDedupedRows(rails, order, featuredIds, criticsPick?.id, DEDUP_PRIORITY);

  const railItems = useMemo(() => {
    const sections = SECTIONS.filter((x) => x.key !== "x:collections" || !!settings.tmdbKey);
    const out: Array<{ key: string; title: string }> = [];
    dailyRows.forEach((r, i) => {
      out.push({ key: r.id, title: r.shelf.title });
      for (const x of sections) if (x.after === i) out.push({ key: x.key, title: x.title });
    });
    for (const x of sections) if (x.after >= dailyRows.length) out.push({ key: x.key, title: x.title });
    return out;
  }, [dailyRows, settings.tmdbKey]);
  const railKeys = useMemo(() => railItems.map((r) => r.key), [railItems]);
  const visibleRails = useMemo(
    () => applyPageRows(railItems, pageRows.custom, false),
    [railItems, pageRows.custom],
  );
  const editRails = useMemo(
    () =>
      applyPageRows(railItems, pageRows.custom, true).filter((item) => {
        const d = deduped[item.key];
        return d == null || d.length > 0;
      }),
    [railItems, pageRows.custom, deduped],
  );
  const orderKeys = useMemo(
    () => orderedRowKeys(railKeys, pageRows.custom),
    [railKeys, pageRows.custom],
  );

  /** One of Discover's own sections ("x:" keys), under [title]. */
  const section = (key: string, title: string) => {
    switch (key) {
      case "x:genres":
        return <GenreTiles title={title} />;
      case "x:queue":
        return queue.length > 0 ? <DiscoveryQueueCta items={queue} title={title} /> : null;
      case "x:languages":
        return <LanguageTiles title={title} />;
      case "x:collections":
        return settings.tmdbKey ? (
          <LazyMount minHeight={260}>
            <CollectionsRow title={title} />
          </LazyMount>
        ) : null;
      case "x:critics":
        return criticsPick ? (
          <LazyMount minHeight={580}>
            <CriticsPick meta={criticsPick} title={title} />
          </LazyMount>
        ) : null;
      case "x:awards":
        return <AwardTiles title={title} />;
    }
    return null;
  };

  // Android: drawn natively (see @/views/native/native-screens); the page then stays empty.
  const view = useView();
  const nativeOn = useNativeScreensEnabled();
  // Editing: every row, hidden ones too (drawn with their controls, without their cards).
  const nativeRails = pageRows.editMode ? editRails : visibleRails;
  const titleOf = (key: string) => {
    const it = nativeRails.find((r) => r.key === key);
    return it ? t(it.title) : "";
  };
  const genresRow = useGenreTilesRow("x:genres", titleOf("x:genres"), nativeOn, settings.tmdbKey, t, view);
  const languagesRow = useLanguageTilesRow("x:languages", titleOf("x:languages"), nativeOn, settings.tmdbKey, t, view);
  const collectionsRow = useCollectionsRow("x:collections", titleOf("x:collections"), nativeOn, settings.tmdbKey, t, view);
  const awardsRow = useAwardTilesRow("x:awards", titleOf("x:awards"), nativeOn, t, view);
  const criticsNative = useCriticsRow("x:critics", titleOf("x:critics"), criticsPick, nativeOn, settings.tmdbKey, t, view);
  const nativeRows = useMemo<NativeRowInput[]>(() => {
    const out: NativeRowInput[] = [];
    for (const item of nativeRails) {
      const title = t(item.title);
      if (item.key.startsWith("x:")) {
        const r =
          item.key === "x:genres"
            ? genresRow
            : item.key === "x:languages"
              ? languagesRow
              : item.key === "x:collections"
                ? collectionsRow
                : item.key === "x:awards"
                  ? { ...awardsRow, title }
                  : item.key === "x:queue"
                    ? queueRow(item.key, title, queue, t, view)
                    : item.key === "x:critics"
                      ? criticsNative && { ...criticsNative, title }
                      : null;
        if (r) out.push(r);
        // Nothing to show right now (no queue yet…): the editor still lists it.
        else if (pageRows.editMode) out.push({ key: item.key, title, metas: [], cards: [] });
        continue;
      }
      const def = dailyRows.find((r) => r.id === item.key);
      const metas = deduped[item.key] ?? [];
      out.push({
        key: item.key,
        title,
        metas,
        seeAll: def ? { title, fetcher: (page: number) => def.fetch(page), initial: metas } : undefined,
        more: () => loadMore(item.key),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeRails, pageRows.editMode, dailyRows, deduped, t, loadMore, genresRow.cards, languagesRow.cards, collectionsRow.cards, awardsRow.cards, queue, criticsNative, view]);
  const nativeHero = useMemo(() => ({ metas: featured, rank: t("Featured") }), [featured, t]);
  const { setEditMode, editMode, custom, persist } = pageRows;
  const nativeCustomize = useMemo(() => ({ label: t("Customize page"), onTap: () => setEditMode(true) }), [t, setEditMode]);
  // Moves step over the rows the editor shows (a rail left empty after de-duplication isn't).
  const editKeys = useMemo(() => editRails.map((r) => r.key), [editRails]);
  const nativeEditor = useMemo(
    () => ({ on: editMode, setOn: setEditMode, custom, allKeys: editKeys, persist }),
    [editMode, setEditMode, custom, editKeys, persist],
  );
  const native = useNativeBrowsePage("discover", {
    active,
    editor: nativeEditor,
    t,
    hero: nativeHero,
    rows: nativeRows,
    customize: nativeCustomize,
  });
  // The web page loads a rail when it scrolls into view; drawn natively, load them all, a few at a
  // time.
  useEffect(() => {
    if (!native) return;
    const keys = visibleRails.map((r) => r.key).filter((k) => !k.startsWith("x:"));
    const timers: number[] = [];
    keys.forEach((k, i) => {
      timers.push(window.setTimeout(() => ensureLoadedRef.current(k), Math.floor(i / 4) * 700));
    });
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [native, visibleRails]);
  if (native) return <main ref={scrollCb} aria-hidden="true" className="flex-1 overflow-hidden" />;

  return (
    <main ref={scrollCb} className={`flex-1 overflow-y-auto ${PHONE ? "px-4 pb-10 pt-20" : "px-12 pb-20 pt-28"}`}>
      <ScrollRootContext.Provider value={scrollEl}>
        <div data-tauri-drag-region className={`flex flex-col ${PHONE ? "gap-8" : "gap-14"}`}>
          <div className="relative">
            <FeaturedBanner items={featured} />
            {/* Phone: on its own line under the banner (hung off the banner's edge it ran into
                the slide dots and the first row's title). */}
            <div className={PHONE ? "mt-3 flex justify-end" : "absolute bottom-4 end-0 z-10"}>
              <CatalogCustomizeBar
                editMode={pageRows.editMode}
                hasChanges={hasPageRowChanges(pageRows.custom)}
                onToggleEdit={() => pageRows.setEditMode((v) => !v)}
                onReset={() => pageRows.persist(resetPageRows())}
              />
            </div>
          </div>

          {pageRows.editMode
            ? editRails.map((item) => {
                const hidden = pageRows.custom.hidden.includes(item.key);
                const idx = orderKeys.indexOf(item.key);
                return (
                  <div key={item.key}>
                    <RowControls
                      name={t(item.title)}
                      hidden={hidden}
                      canMoveUp={idx > 0}
                      canMoveDown={idx >= 0 && idx < orderKeys.length - 1}
                      onMoveUp={() => pageRows.persist(movePageRow(pageRows.custom, railKeys, item.key, -1))}
                      onMoveDown={() => pageRows.persist(movePageRow(pageRows.custom, railKeys, item.key, 1))}
                      onToggleHidden={() => pageRows.persist(togglePageRowHidden(pageRows.custom, item.key))}
                      onRename={(label) => pageRows.persist(renamePageRow(pageRows.custom, item.key, label))}
                      onResetName={() => pageRows.persist(renamePageRow(pageRows.custom, item.key, ""))}
                      isRenamed={item.key in pageRows.custom.renamed}
                    />
                    {!hidden &&
                      (item.key.startsWith("x:") ? (
                        section(item.key, t(item.title))
                      ) : (
                        <Rail
                          railId={item.key}
                          allRails={dailyRows}
                          deduped={deduped}
                          loadMore={loadMore}
                          ensureLoaded={ensureLoaded}
                          titleOverride={item.title}
                        />
                      ))}
                  </div>
                );
              })
            : visibleRails.map((item) => (
                <Fragment key={item.key}>
                  {item.key.startsWith("x:") ? (
                    section(item.key, t(item.title))
                  ) : (
                    <LazyMount minHeight={PHONE ? 240 : 340}>
                      <Rail
                        railId={item.key}
                        allRails={dailyRows}
                        deduped={deduped}
                        loadMore={loadMore}
                        ensureLoaded={ensureLoaded}
                        titleOverride={item.title}
                      />
                    </LazyMount>
                  )}
                </Fragment>
              ))}
        </div>
      </ScrollRootContext.Provider>
      <BackToTop scrollRef={scrollRef} />
    </main>
  );
}

export { Discover as DiscoverView };
