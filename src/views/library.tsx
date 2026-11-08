import { isPhoneLayout } from "@/lib/platform";
import { Bookmark, Clock, HardDrive } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import traktLogo from "@/assets/trakt.svg";
import simklLogo from "@/assets/simkl.png";
import { useSimkl } from "@/lib/simkl/provider";
import { useTrakt } from "@/lib/trakt/provider";
import { useScrollMemory } from "@/lib/view";
import { useT } from "@/lib/i18n";
import { watchlistHas } from "@/lib/watchlist";
import { HistoryTab } from "./library/history-tab";
import { LocalTab } from "./library/local-tab";
import {
  hydrateLibraryMeta,
  NativeLibrarySinkContext,
  TabBtn,
  type NativeLibraryFilter,
  type NativeLibraryGrid,
  type NativeLibrarySink,
  type Tab,
} from "./library/shared";
import { useSettings } from "@/lib/settings";
import { narrowMediaType, type Meta } from "@/lib/cinemeta";
import { useNativeBrowsePage, useNativeScreensEnabled, type NativeRowInput } from "@/views/native/native-screens";
import { SimklTab } from "./library/simkl-tab";
import { TraktTab } from "./library/trakt-tab";
import { WatchlistTab } from "./library/watchlist-tab";
import { pushActivityHint } from "@/lib/discord/activity-hint";

const LIBRARY_TAB_KEY = "harbor.library.tab";

function readSavedTab(): Tab {
  try {
    const v = localStorage.getItem(LIBRARY_TAB_KEY);
    if (
      v === "watchlist" ||
      v === "history" ||
      (v === "local" && !isPhoneLayout()) ||
      v === "trakt" ||
      v === "simkl"
    )
      return v;
  } catch {}
  return "watchlist";
}

export function LibraryView({ active }: { active: boolean }) {
  const [tab, setTab] = useState<Tab>(readSavedTab);
  const { isConnected: traktConnected } = useTrakt();
  const { isConnected: simklConnected } = useSimkl();
  const scrollRef = useRef<HTMLElement>(null);
  useScrollMemory("library", scrollRef, active);

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_TAB_KEY, tab);
    } catch {}
  }, [tab]);

  useEffect(() => {
    if (tab === "trakt" && !traktConnected) setTab("watchlist");
  }, [tab, traktConnected]);

  useEffect(() => {
    if (tab === "simkl" && !simklConnected) setTab("watchlist");
  }, [tab, simklConnected]);

  useEffect(() => {
    if (!active) return;
    const label =
      tab === "watchlist"
        ? "Browsing their watchlist"
        : tab === "history"
          ? "Browsing their watch history"
          : tab === "trakt"
            ? "Browsing their Trakt library"
            : tab === "simkl"
              ? "Browsing their Simkl library"
              : "Browsing their Stremio library";
    return pushActivityHint({ details: label, state: "Library" });
  }, [active, tab]);

  const native = useNativeLibrary({ active, tab, setTab, traktConnected, simklConnected });
  const tabs = (
    <>
      {tab === "watchlist" && <WatchlistTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "local" && <LocalTab />}
      {tab === "trakt" && traktConnected && <TraktTab />}
      {tab === "simkl" && simklConnected && <SimklTab />}
    </>
  );
  if (native.inUse) {
    // Drawn natively: the tabs still run (their filter bar and grids report to the native screen).
    return (
      <main ref={scrollRef} aria-hidden="true" className="flex-1 overflow-hidden">
        <NativeLibrarySinkContext.Provider value={native.sink}>{tabs}</NativeLibrarySinkContext.Provider>
      </main>
    );
  }

  return (
    <main
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-5 pt-24 pb-14 sm:px-8 lg:px-12 lg:pt-28"
    >
      <div data-tauri-drag-region className="flex flex-col gap-7">
        <Header
          tab={tab}
          onTab={setTab}
          traktConnected={traktConnected}
          simklConnected={simklConnected}
        />
        {tabs}
      </div>
    </main>
  );
}

/**
 * Android: the Library drawn natively (see @/views/native/native-screens). The tabs keep all their
 * own logic; their filter bar and grids report to the sink, and this turns that into the screen:
 * the tab, type and sort as chips, each group as a row, long-press to remove (where the page can).
 */
function useNativeLibrary({
  active,
  tab,
  setTab,
  traktConnected,
  simklConnected,
}: {
  active: boolean;
  tab: Tab;
  setTab: (t: Tab) => void;
  traktConnected: boolean;
  simklConnected: boolean;
}) {
  const t = useT();
  const { settings, update } = useSettings();
  const enabled = useNativeScreensEnabled();
  const [filter, setFilter] = useState<NativeLibraryFilter | null>(null);
  const grids = useRef(new Map<string, { sig: string; grid: NativeLibraryGrid }>());
  const [gridsVer, setGridsVer] = useState(0);
  const sink = useMemo<NativeLibrarySink | null>(
    () =>
      enabled
        ? {
            setFilter: (f) =>
              setFilter((prev) =>
                f && prev && prev.type === f.type && prev.setType === f.setType && prev.counts.all === f.counts.all &&
                prev.counts.movie === f.counts.movie && prev.counts.series === f.counts.series
                  ? prev
                  : f,
              ),
            setGrid: (id, g) => {
              const m = grids.current;
              if (!g) {
                if (m.delete(id)) setGridsVer((v) => v + 1);
                return;
              }
              // Grids report on every render: only a change of what they show redraws.
              const sig = `${g.section ?? ""}|${g.onRemove ? 1 : 0}|${g.groups.map((x) => `${x.label}:${x.items.map((i) => i.key).join(",")}`).join(";")}`;
              const prev = m.get(id);
              m.set(id, { sig, grid: g });
              if (!prev || prev.sig !== sig) setGridsVer((v) => v + 1);
            },
          }
        : null,
    [enabled],
  );

  // Titles saved without a poster (or a name): looked up like the page's cards do (TMDB, then the
  // addons), a few at a time, once each.
  const [hydrated, setHydrated] = useState<Record<string, Meta>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    void gridsVer;
    const need: Meta[] = [];
    for (const { grid } of grids.current.values()) {
      for (const g of grid.groups) {
        for (const i of g.items) {
          const m = i.meta;
          if ((!m.poster || !m.name) && !asked.current.has(m.id)) need.push(m);
        }
      }
    }
    if (need.length === 0) return;
    let alive = true;
    let next = 0;
    const work = async () => {
      while (alive && next < need.length) {
        const m = need[next++];
        if (asked.current.has(m.id)) continue;
        asked.current.add(m.id);
        const full = await hydrateLibraryMeta(m.id, narrowMediaType(m.type), settings.tmdbKey ?? null).catch(() => null);
        if (full && (full.poster || full.name)) setHydrated((h) => ({ ...h, [m.id]: full }));
      }
    };
    for (let k = 0; k < 4; k++) void work();
    return () => {
      alive = false;
    };
  }, [enabled, gridsVer, settings.tmdbKey]);

  const rows = useMemo<NativeRowInput[]>(() => {
    void gridsVer;
    const out: NativeRowInput[] = [];
    const filled = (m: Meta): Meta => {
      const h = hydrated[m.id];
      return h ? { ...m, poster: m.poster || h.poster, name: m.name || h.name, background: m.background || h.background } : m;
    };
    for (const [id, { grid }] of grids.current) {
      grid.groups.forEach((g, gi) => {
        if (g.items.length === 0) return;
        out.push({
          key: `${id}|${gi}`,
          title: `${grid.section ? `${grid.section} · ` : ""}${t(g.label)} · ${g.items.length}`,
          metas: g.items.map((i) => filled(i.meta)),
        });
      });
    }
    return out;
  }, [gridsVer, t, hydrated]);

  const header = useMemo(
    () => ({
      kicker: t("My library"),
      title: t("Your collection."),
      subtitle: t("Watchlist is what you've saved for later. History is everything you've watched."),
    }),
    [t],
  );

  const chips = useMemo(() => {
    const out = [
      {
        key: "tab",
        items: [
          { id: "watchlist", label: t("Watchlist"), on: tab === "watchlist" },
          { id: "history", label: t("History"), on: tab === "history" },
          ...(traktConnected ? [{ id: "trakt", label: "Trakt", on: tab === "trakt" }] : []),
          ...(simklConnected ? [{ id: "simkl", label: "Simkl", on: tab === "simkl" }] : []),
        ],
      },
    ];
    if (filter) {
      out.push({
        key: "type",
        items: [
          { id: "all", label: `${t("All")} ${filter.counts.all}`, on: filter.type === "all" },
          { id: "movie", label: `${t("Movies")} ${filter.counts.movie}`, on: filter.type === "movie" },
          { id: "series", label: `${t("Shows")} ${filter.counts.series}`, on: filter.type === "series" },
        ],
      });
      out.push({
        key: "sort",
        items: (
          [
            ["recent", t("Recent")],
            ["title", t("A-Z")],
            ["year", t("Year")],
          ] as const
        ).map(([id, label]) => ({ id, label, on: settings.librarySort === id })),
      });
    }
    return out;
  }, [t, tab, traktConnected, simklConnected, filter, settings.librarySort]);

  const empty = useMemo(() => {
    if (rows.length > 0) return null;
    if (filter && filter.counts.all > 0) return { text: t("No matches for these filters.") };
    if (tab === "watchlist") {
      return {
        title: t("Your watchlist is empty"),
        text: t("Long-press any title in Harbor or tap \"Add to Watchlist\" on its detail page to save it here."),
      };
    }
    if (tab === "history") {
      return { title: t("Nothing watched yet"), text: t("Press play on something. It'll show up here once you start watching.") };
    }
    return { text: t("Loading…") };
  }, [rows.length, filter, tab, t]);

  const inUse = useNativeBrowsePage("library", {
    active,
    t,
    header,
    rows,
    chips,
    empty,
    onChip: (group, id) => {
      if (group === "tab") setTab(id as Tab);
      else if (group === "type") filter?.setType(id as NativeLibraryFilter["type"]);
      else if (group === "sort") update({ librarySort: id as typeof settings.librarySort });
    },
    onHold: (rowKey, m: Meta) => {
      const grid = grids.current.get(rowKey.split("|")[0])?.grid;
      const gi = Number(rowKey.split("|")[1]);
      const item = grid?.groups[gi]?.items.find((i) => i.meta.id === m.id);
      if (!grid?.onRemove || !item?.stremioId) return false;
      if (window.confirm(`${t("Remove from library")}: ${m.name}?`)) grid.onRemove(item.stremioId);
      return true;
    },
  });
  return { inUse, sink };
}

function Header({
  tab,
  onTab,
  traktConnected,
  simklConnected,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  traktConnected: boolean;
  simklConnected: boolean;
}) {
  const t = useT();
  // Many tabs (Trakt, Simkl…) don't fit a phone: the strip scrolls inside itself, and the chosen
  // tab is kept in view.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const on = strip?.querySelector<HTMLElement>('[data-active="true"]');
    if (!strip || !on) return;
    const left = on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [tab, traktConnected, simklConnected]);
  return (
    <header className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.28em] text-ink-subtle">
            {t("My library")}
          </span>
          <h1 className="font-display text-[44px] font-medium leading-[1.05] text-ink">
            {t("Your collection.")}
          </h1>
          <p className="text-[14px] leading-snug text-ink-muted">
            {isPhoneLayout()
              ? t("Watchlist is what you've saved for later. History is everything you've watched.")
              : t("Watchlist is what you've saved for later. History is everything you've watched. Local is files on your computer.")}
          </p>
        </div>
      </div>
      <div
        ref={stripRef}
        className="-mx-5 flex items-center gap-1 overflow-x-auto border-b border-edge-soft px-5 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        <TabBtn active={tab === "watchlist"} onClick={() => onTab("watchlist")}>
          <Bookmark size={14} strokeWidth={2.2} />
          {t("Watchlist")}
        </TabBtn>
        <TabBtn active={tab === "history"} onClick={() => onTab("history")}>
          <Clock size={14} strokeWidth={2.2} />
          {t("History")}
        </TabBtn>
        {/* Local = files on this computer: nothing to show on the phone. */}
        {!isPhoneLayout() && (
          <TabBtn active={tab === "local"} onClick={() => onTab("local")}>
            <HardDrive size={14} strokeWidth={2.2} />
            {t("Local")}
          </TabBtn>
        )}
        {traktConnected && (
          <TabBtn active={tab === "trakt"} onClick={() => onTab("trakt")}>
            <img src={traktLogo} alt="" className="h-3.5 w-3.5 object-contain" />
            Trakt
          </TabBtn>
        )}
        {simklConnected && (
          <TabBtn active={tab === "simkl"} onClick={() => onTab("simkl")}>
            <img src={simklLogo} alt="" className="h-3.5 w-3.5 object-contain" />
            Simkl
          </TabBtn>
        )}
      </div>
    </header>
  );
}

void watchlistHas;
