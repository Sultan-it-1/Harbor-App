import { isPhoneLayout } from "@/lib/platform";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCalendarFilter,
  groupByDate,
  todayLocalISO,
  type CalendarFilter,
  type CalendarItem,
} from "@/lib/calendar";
import { CalendarSkeleton } from "./calendar/calendar-skeleton";
import { CustomCalendarBar } from "./calendar/custom-bar";
import { useCalendarData } from "./calendar/use-calendar-data";
import { useAuth } from "@/lib/auth";
import { library, type LibraryItem } from "@/lib/stremio";
import { useSettings } from "@/lib/settings";
import { useTrakt } from "@/lib/trakt/provider";
import { useSimkl } from "@/lib/simkl/provider";
import { useScrollMemory, useView } from "@/lib/view";
import { useT } from "@/lib/i18n";
import { AuthModal } from "@/components/auth-modal";
import { DayModal } from "./calendar/day-modal";
import { EmptyState, ErrorState, NoKeyState, NotSignedInState, emptyStateText } from "./calendar/empty-states";
import { MonthGrid } from "./calendar/month-grid";
import { SourceSwitcher, calendarSources } from "./calendar/source-switcher";
import { useNativeBrowsePage, useNativeSheet } from "@/views/native/native-screens";
import {
  buildLibraryNameSet,
  buildMonthCells,
  calendarEpisodeHint,
  calendarToMeta,
  FILTERS,
  formatDateLong,
  MONTH_NAMES,
  normalizeName,
  orderedWeekdayNames,
} from "./calendar/utils";

const PHONE = isPhoneLayout();

export function CalendarView() {
  const t = useT();
  const { settings, update } = useSettings();
  const { authKey } = useAuth();
  const [showAuth, setShowAuth] = useState(false);
  const { openSettings, openMeta, topKind } = useView();
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [filter, setFilter] = useState<CalendarFilter>("all");
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollMemory("calendar", scrollRef);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [dayModal, setDayModal] = useState<string | null>(null);

  const source = settings.calendarSource;
  const { isConnected: traktConnected } = useTrakt();
  const { isConnected: simklConnected } = useSimkl();

  const { items, loading, error } = useCalendarData({
    source,
    authKey,
    traktConnected,
    simklConnected,
    settings,
    year,
    month,
  });

  useEffect(() => {
    if (!authKey || source !== "all") {
      setLibraryItems([]);
      return;
    }
    let cancelled = false;
    library(authKey)
      .then((rows) => {
        if (!cancelled) setLibraryItems(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authKey, source]);

  const libraryNames = useMemo(() => buildLibraryNameSet(libraryItems), [libraryItems]);

  const filtered = useMemo(() => {
    if (source !== "all") return items;
    let out = applyCalendarFilter(items, filter);
    if (watchlistOnly) {
      out = out.filter((i) => {
        const t = i.type === "tv" ? "tv" : "movie";
        return libraryNames.has(`${normalizeName(i.name)}::${t}`);
      });
    }
    return out;
  }, [source, items, filter, watchlistOnly, libraryNames]);

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);
  const cells = useMemo(
    () => buildMonthCells(year, month, settings.weekStartsMonday),
    [year, month, settings.weekStartsMonday],
  );

  const openItem = useCallback(
    (item: CalendarItem) => {
      openMeta(calendarToMeta(item), { episodeHint: calendarEpisodeHint(item) ?? undefined });
    },
    [openMeta],
  );

  const goPrev = () => {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  };
  const goNext = () => {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  };
  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  };

  const todayISO = todayLocalISO();
  const body: "grid" | "other" =
    (source === "library" && !authKey) ||
    (source === "all" && !settings.tmdbKey) ||
    !!error ||
    filtered.length === 0
      ? "other"
      : "grid";
  const dayModalItems = dayModal ? grouped.get(dayModal) ?? [] : [];

  const showAllControls = source === "all";

  // Android: drawn natively (see @/views/native/native-screens) like the page: "Releases",
  // "Calendar", previous / Today / the month / next, the sources, Start week on Monday, the kinds
  // with their counts and Watchlist only, then the month (each day's first three titles and
  // "+N more", which opens the page's list of that day over it). The Custom source's builder
  // keeps the page.
  const nativeCalendar = useMemo(() => {
    const cellsOut = cells.map((cell) => {
      const events = grouped.get(cell.iso) ?? [];
      return {
        day: cell.date.getDate(),
        inMonth: cell.inMonth,
        today: cell.iso === todayISO,
        count: events.length,
        items: events.slice(0, 3).map((it) => ({ title: it.name, img: it.poster ? [it.poster] : [] })),
        more: events.length > 3 ? t("+{n} more", { n: events.length - 3 }) : null,
      };
    });
    return {
      month: `${t(MONTH_NAMES[month])} ${year}`,
      weekdays: orderedWeekdayNames(settings.weekStartsMonday).map((d) => t(d)),
      cells: body === "grid" ? cellsOut : [],
      labels: { prev: t("Previous month"), next: t("Next month"), today: t("Today") },
    };
  }, [t, cells, grouped, todayISO, month, year, settings.weekStartsMonday, body]);
  const nativeChips = useMemo(() => {
    const groups: Array<{ key: string; items: Array<{ id: string; label: string; on: boolean }> }> = [
      {
        key: "source",
        items: calendarSources(traktConnected, simklConnected).map((o) => ({ id: o.id, label: t(o.label), on: source === o.id })),
      },
    ];
    const opts = [{ id: "monday", label: t("Start week on Monday"), on: settings.weekStartsMonday }];
    if (showAllControls) {
      for (const f of FILTERS) {
        const count = f.id === "all" ? filtered.length : applyCalendarFilter(items, f.id).length;
        opts.push({ id: `filter:${f.id}`, label: `${t(f.label)}  ${count}`, on: filter === f.id });
      }
      if (authKey) opts.push({ id: "watchlist", label: `★ ${t("Watchlist only")}`, on: watchlistOnly });
    }
    groups.push({ key: "opts", items: opts });
    return groups;
  }, [t, traktConnected, simklConnected, source, settings.weekStartsMonday, showAllControls, filtered.length, items, filter, authKey, watchlistOnly]);
  const nativeMessage = useMemo(() => {
    if (source === "library" && !authKey) {
      return {
        title: t("Sign in to see your library calendar"),
        text: t("My Library shows upcoming episodes from the shows you've saved on Stremio. Sign in to wire it up."),
        action: t("Sign in"),
        onAction: () => setShowAuth(true),
      };
    }
    if (source === "all" && !settings.tmdbKey) {
      return {
        title: t("All upcoming needs a TMDB key"),
        text: t(
          "TMDB powers the firehose of every release this month. The free tier covers it. About 60 seconds to set up. Switch to My Library if you'd rather only see what you've saved.",
        ),
        action: t("Open settings"),
        onAction: () => openSettings("library"),
      };
    }
    if (error) return { title: t("Couldn't load the calendar"), text: error };
    if (loading && filtered.length === 0) return { text: t("Loading…") };
    if (filtered.length === 0) {
      const e = emptyStateText(t, source, filter, watchlistOnly);
      return { title: e.heading, text: e.body };
    }
    return null;
  }, [t, source, authKey, settings.tmdbKey, error, loading, filtered.length, filter, watchlistOnly, openSettings]);
  // A day's titles: the screen's own menu, sliding up from the bottom (the date and the count on
  // top, then each title with what it is; a tap opens it).
  const daySheet = useNativeSheet(
    dayModal && dayModalItems.length > 0 ? `day:${dayModal}` : null,
    [
      {
        id: "hdr",
        label: `${formatDateLong(dayModal ?? "")}  ·  ${dayModalItems.length === 1 ? t("{n} title", { n: 1 }) : t("{n} titles", { n: dayModalItems.length })}`,
        icon: "calendar",
        stay: true,
      },
      { id: "-", label: "", divider: true },
      ...dayModalItems.map((it, i) => ({
        id: `it:${i}`,
        label: `${it.name}  ·  ${it.isAnime ? t("Anime") : it.type === "movie" ? t("Movie") : t("TV")}`,
        onSelect: () => openItem(it),
      })),
    ],
    () => setDayModal(null),
  );
  const native = useNativeBrowsePage("calendar", {
    active: topKind === "calendar",
    blocked: source === "custom",
    hidden: (!!dayModal && !daySheet) || showAuth,
    t,
    header: { kicker: t("Releases"), title: t("Calendar"), size: 32 },
    chips: nativeChips,
    onChip: (group, id) => {
      if (group === "source") update({ calendarSource: id as typeof source });
      else if (id === "monday") update({ weekStartsMonday: !settings.weekStartsMonday });
      else if (id === "watchlist") setWatchlistOnly((v) => !v);
      else if (id.startsWith("filter:")) setFilter(id.slice(7) as CalendarFilter);
    },
    rows: [],
    calendar: nativeCalendar,
    onCalendar: (what, i, text) => {
      if (what === "prev") goPrev();
      else if (what === "next") goNext();
      else if (what === "today") goToday();
      else {
        const cell = cells[i];
        if (!cell) return;
        if (what === "day") setDayModal(cell.iso);
        else if (what === "item") {
          const it = (grouped.get(cell.iso) ?? [])[Number(text)];
          if (it) openItem(it);
        }
      }
    },
    message: nativeMessage,
  });

  if (native) {
    return (
      <main className="flex h-full flex-col overflow-hidden">
        {dayModal && dayModalItems.length > 0 && !daySheet && (
          <DayModal
            dateISO={dayModal}
            items={dayModalItems}
            onClose={() => setDayModal(null)}
            onOpenItem={(it) => {
              setDayModal(null);
              openItem(it);
            }}
          />
        )}
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      </main>
    );
  }

  let pageBody: React.ReactNode;
  if (source === "library" && !authKey) {
    pageBody = <NotSignedInState onSignIn={() => setShowAuth(true)} />;
  } else if (source === "all" && !settings.tmdbKey) {
    pageBody = <NoKeyState onSetup={() => openSettings("library")} />;
  } else if (error) {
    pageBody = <ErrorState message={error} />;
  } else if (loading && filtered.length === 0) {
    pageBody = <CalendarSkeleton />;
  } else if (filtered.length === 0) {
    pageBody = <EmptyState source={source} filter={filter} watchlistOnly={watchlistOnly} />;
  } else {
    pageBody = (
      <MonthGrid
        cells={cells}
        grouped={grouped}
        todayISO={todayISO}
        weekStartsMonday={settings.weekStartsMonday}
        onOpenItem={openItem}
        onOpenDay={(iso) => setDayModal(iso)}
      />
    );
  }

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <header className={`shrink-0 border-b border-edge-soft ${PHONE ? "px-4 pb-4 pt-20" : "px-12 pb-5 pt-24"}`}>
        <div className={PHONE ? "flex flex-wrap items-end justify-between gap-x-4 gap-y-3" : "flex items-end justify-between gap-6"}>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-[0.32em] text-ink-subtle">
              {t("Releases")}
            </span>
            <h1 className={`font-display font-medium leading-none tracking-tight text-ink ${PHONE ? "text-[32px]" : "text-[44px]"}`}>
              {t("Calendar")}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={goPrev}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-edge-soft text-ink-muted transition-colors hover:border-edge hover:text-ink"
              aria-label={t("Previous month")}
            >
              <ChevronLeft size={16} strokeWidth={2.2} className="dir-icon" />
            </button>
            <button
              onClick={goToday}
              className="h-10 rounded-full border border-edge-soft px-4 text-[13px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
            >
              {t("Today")}
            </button>
            <div className={`flex h-10 items-center justify-center gap-2 rounded-full border border-edge-soft text-[14px] font-semibold text-ink ${PHONE ? "px-3" : "min-w-[150px] px-5"}`}>
              <CalendarIcon size={14} strokeWidth={2} className="text-ink-subtle" />
              {t(MONTH_NAMES[month])} {year}
            </div>
            <button
              onClick={goNext}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-edge-soft text-ink-muted transition-colors hover:border-edge hover:text-ink"
              aria-label={t("Next month")}
            >
              <ChevronRight size={16} strokeWidth={2.2} className="dir-icon" />
            </button>
          </div>
        </div>
        <nav className={`flex flex-wrap items-center gap-3 ${PHONE ? "mt-4" : "mt-6"}`}>
          <div className={PHONE ? "-mx-4 max-w-[100vw] overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "contents"}>
          <SourceSwitcher
            value={source}
            onChange={(s) => update({ calendarSource: s })}
            traktConnected={traktConnected}
            simklConnected={simklConnected}
          />
          </div>
          <button
            onClick={() => update({ weekStartsMonday: !settings.weekStartsMonday })}
            className={`rounded-full px-4 py-1.5 text-[12.5px] font-semibold transition-colors ${
              settings.weekStartsMonday
                ? "bg-ink text-canvas"
                : "border border-edge-soft text-ink-muted hover:border-edge hover:text-ink"
            }`}
          >
            {t("Start week on Monday")}
          </button>
          {source === "custom" && (
            <CustomCalendarBar
              tmdbKey={settings.tmdbKey}
              traktConnected={traktConnected}
              value={settings.customCalendar}
              onChange={(next) => update({ customCalendar: next })}
            />
          )}
          {showAllControls && (
            <>
              <span className="mx-1 h-5 w-px bg-edge-soft" />
              <div className="flex flex-wrap items-center gap-2">
                {FILTERS.map((f) => {
                  const active = filter === f.id;
                  const count =
                    f.id === "all"
                      ? filtered.length
                      : applyCalendarFilter(items, f.id).length;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setFilter(f.id)}
                      className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors ${
                        active
                          ? "bg-ink text-canvas"
                          : "border border-edge-soft text-ink-muted hover:border-edge hover:text-ink"
                      }`}
                    >
                      {t(f.label)}
                      <span
                        className={`text-[11px] tabular-nums ${
                          active ? "text-canvas/65" : "text-ink-subtle"
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
                <button
                  onClick={() => authKey && setWatchlistOnly((v) => !v)}
                  disabled={!authKey}
                  title={!authKey ? t("Sign in to filter by your library") : undefined}
                  className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    watchlistOnly
                      ? "bg-ink text-canvas"
                      : "border border-edge-soft text-ink-muted hover:border-edge hover:text-ink"
                  }`}
                >
                  <Star
                    size={11}
                    strokeWidth={2.4}
                    className={watchlistOnly ? "fill-canvas" : ""}
                  />
                  {t("Watchlist only")}
                </button>
              </div>
            </>
          )}
        </nav>
      </header>

      <div ref={scrollRef} className={`flex-1 overflow-y-auto ${PHONE ? "px-3 py-5" : "px-12 py-8"}`}>{pageBody}</div>

      {dayModal && dayModalItems.length > 0 && (
        <DayModal
          dateISO={dayModal}
          items={dayModalItems}
          onClose={() => setDayModal(null)}
          onOpenItem={(it) => {
            setDayModal(null);
            openItem(it);
          }}
        />
      )}

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </main>
  );
}
