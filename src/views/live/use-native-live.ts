// Android: Live TV drawn natively (see @/views/native/native-screens), in the page's layout.
//
// The bar: the playlist button, the search field, Home / Grid / Guide and, in the grid, the
// categories. The playlists, the categories and the leagues ("Customize") open as the screen's
// own menus (built in ../live.tsx); the page's picker, drawer and window open over the screen,
// which steps aside, only for what needs them: adding, editing or managing playlists, managing
// categories, or when a native menu is not available. Home: "Your TV at 21:40", the spotlight
// (one channel at a time), On now as posters, Live & Upcoming games with their leagues, On now
// as guide cards, the rails of channels now, Browse by country, then a rail per category ("See
// all" opens it in the grid). Grid: the networks, then every channel's card (more as it
// scrolls). Guide: the timeline of channels and their programmes (a tap plays the channel, or a
// past programme where the channel has catch-up). An error shows with "Try again". Multiview,
// and Live TV before any playlist is added, stay the page's.

import { useEffect, useMemo, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import { useT } from "@/lib/i18n";
import { uiLocale } from "@/lib/i18n/locale";
import { isHydratableChannel } from "@/lib/iptv/channel-hydration";
import { computeTvgIdCounts, epgProgramsForChannel } from "@/lib/iptv/epg-resolver";
import { clearCountries, toggleCountry, useCountryPrefs } from "@/lib/iptv/country-prefs";
import { FAVORITES_GROUP_KEY, type useFavorites } from "@/lib/iptv/favorites";
import { resolveNetworks, type NetworkRow } from "@/lib/iptv/top-networks";
import type { EpgIndex, IptvChannel } from "@/lib/iptv/types";
import { findCurrent } from "@/lib/iptv/xmltv";
import { DEFAULT_SPORTS_LEAGUES, LEAGUES, getLeagueLabel, liveCount, type SportsGame } from "@/lib/sports/espn";
import { useSettings } from "@/lib/settings";
import { useView } from "@/lib/view";
import { useNativeBrowsePage, useNativeScreensEnabled, type NativeCardInput, type NativeRowInput } from "@/views/native/native-screens";
import { useChannelHydration } from "./hooks/use-channel-hydration";
import { channelNumber, fmtClock, fmtLeft } from "./live-home/now-format";
import { buildNowItem, hydrationKey, useLiveHome, type NowItem } from "./live-home/use-live-home";
import { useSports } from "./live-home/use-sports";
import type { ViewMode } from "./view-mode-toggle";
import type { EpgProgram } from "@/lib/iptv/types";
import { channelHasCatchup } from "@/lib/iptv/catchup";
import { formatDayLabel, formatTimeLabel, startOfWindow, WINDOW_HOURS } from "./guide/guide-utils";

type T = ReturnType<typeof useT>;

const EMPTY: IptvChannel[] = [];
const RED = "#E5484D";

function nowCard(it: NowItem, hydrated: Meta | null, nowMs: number, t: T): NativeCardInput {
  const art = hydrated?.background || it.current?.iconUrl || null;
  return {
    title: it.current?.title || hydrated?.name || it.channel.group || t("Live channel"),
    sub: it.channel.name,
    kicker: channelNumber(it.channel.attrs),
    img: art ? [art] : [],
    logo: it.channel.logo ?? null,
    bar: it.progress != null,
    progress: it.progress ?? 0,
    desc: it.current ? fmtLeft(it.current.endMs, nowMs, t) : null,
  };
}

function guideCard(it: NowItem, t: T): NativeCardInput {
  return {
    title: it.current?.title || it.channel.name,
    sub: it.channel.name,
    kicker: channelNumber(it.channel.attrs),
    logo: it.channel.logo ?? null,
    bar: it.progress != null,
    progress: it.progress ?? 0,
    desc: it.next
      ? `${t("Next {time}", { time: fmtClock(it.next.startMs) })} · ${it.next.title}`
      : (it.channel.group ?? t("Live")),
  };
}

function sportCard(g: SportsGame, t: T): NativeCardInput {
  const finalGame = g.state === "post";
  const start = (() => {
    if (!g.startMs || Number.isNaN(g.startMs)) return g.detail || t("TBD");
    const d = new Date(g.startMs);
    const time = fmtClock(g.startMs);
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
  })();
  return {
    title: g.away.abbr || g.away.name,
    sub: g.home.abbr || g.home.name,
    rating: g.away.score || null,
    desc: g.home.score || null,
    // The away side's logo as the picture, the home side's as the logo.
    img: g.away.logo ? [g.away.logo] : [],
    logo: g.home.logo || null,
    kicker: g.state === "in" ? g.detail || t("Live") : g.state === "post" ? g.detail || t("Final") : start,
    tone: g.state === "in" ? "accent" : g.state === "post" ? "plain" : "danger",
    button: g.league,
    rank: (finalGame && !g.away.winner ? 1 : 0) | (finalGame && !g.home.winner ? 2 : 0),
  };
}

export function useNativeLive(p: {
  active: boolean;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  hasSources: boolean;
  sourceName: string;
  channelCount: number;
  stateKind: string;
  errorMessage: string | null;
  onRetry: () => void;
  onOpenPicker: () => void;
  pickerOpen: boolean;
  catsOpen: boolean;
  onOpenCats: () => void;
  hasCategories: boolean;
  catsLabel: string;
  group: string | null;
  setGroup: (g: string | null) => void;
  query: string;
  setQuery: (q: string) => void;
  shownChannels: IptvChannel[];
  visible: IptvChannel[];
  regionChannels: IptvChannel[];
  topRows: NetworkRow[];
  showTopRows: boolean;
  epg: EpgIndex | null;
  nowMs: number;
  sourceId: string;
  region: string;
  favorites: ReturnType<typeof useFavorites>;
  hasPlaylist: boolean;
  onPlay: (ch: IptvChannel) => void;
  onInfo: (meta: Meta) => void;
  onCustomizeSports: () => void;
  sportsOpen: boolean;
  onPlayCatchup?: (ch: IptvChannel, program: EpgProgram) => void;
}): boolean {
  const t = useT();
  const { settings } = useSettings();
  const { openMatchDetail } = useView();
  const nativeOn = useNativeScreensEnabled();
  const home = nativeOn && p.mode === "home";
  const grid = nativeOn && p.mode === "grid";
  const guideOn = nativeOn && p.mode === "guide";

  // ---- Home ------------------------------------------------------------------------------------
  const { spotlight, guide, rails, categoryRails, countries } = useLiveHome({
    channels: home ? p.shownChannels : EMPTY,
    epg: p.epg,
    nowMs: p.nowMs,
    sourceId: p.sourceId,
    region: p.region,
    favorites: p.favorites,
  });
  const countryPrefs = useCountryPrefs(p.sourceId);
  const tvgCounts = useMemo(
    () => computeTvgIdCounts(home ? p.shownChannels : grid || guideOn ? p.visible : EMPTY),
    [home, grid, guideOn, p.shownChannels, p.visible],
  );
  const userLeagues = settings.sportsLeagues?.length ? settings.sportsLeagues : DEFAULT_SPORTS_LEAGUES;
  const [league, setLeague] = useState<string>(() => {
    try {
      return localStorage.getItem("harbor.sports.league") || "all";
    } catch {
      return "all";
    }
  });
  const pickLeague = (k: string) => {
    setLeague(k);
    try {
      localStorage.setItem("harbor.sports.league", k);
    } catch {
      /* ignore */
    }
  };
  const sportsLeagues = useMemo(() => (league === "all" ? userLeagues : [league]), [league, userLeagues]);
  const games = useSports({ enabled: home && p.active, leagues: sportsLeagues });

  const railItems = useMemo(
    () => [...rails, ...categoryRails].map((r) => ({ rail: r, items: r.channels.map((ch) => buildNowItem(ch, p.epg, tvgCounts, p.nowMs)) })),
    [rails, categoryRails, p.epg, tvgCounts, p.nowMs],
  );

  // ---- Grid ------------------------------------------------------------------------------------
  const [limit, setLimit] = useState(60);
  useEffect(() => setLimit(60), [p.sourceId, p.group, p.query, p.mode]);
  const shownGrid = useMemo(() => (grid ? p.visible.slice(0, limit) : EMPTY), [grid, p.visible, limit]);
  const nowMinute = Math.floor(p.nowMs / 60_000);
  const gridNow = useMemo(() => {
    const m = new Map<string, ReturnType<typeof findCurrent>>();
    for (const ch of shownGrid) m.set(ch.id, findCurrent(epgProgramsForChannel(ch, p.epg, tvgCounts), p.nowMs));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownGrid, p.epg, tvgCounts, nowMinute]);
  const networks = useMemo(
    () => (grid && p.showTopRows ? p.topRows.map((row) => ({ row, resolved: resolveNetworks(p.regionChannels, row.networks) })).filter((r) => r.resolved.length > 0) : []),
    [grid, p.showTopRows, p.topRows, p.regionChannels],
  );

  // ---- Guide: the hours across (from an hour ago, 8 hours), the channels down ------------------
  const [guideLimit, setGuideLimit] = useState(40);
  useEffect(() => setGuideLimit(40), [p.sourceId, p.group, p.query]);
  const quarter = Math.floor(p.nowMs / (15 * 60_000));
  const guideModel = useMemo(() => {
    if (!guideOn) return null;
    const start = startOfWindow(p.nowMs, 60);
    const end = start + WINDOW_HOURS * 60 * 60_000;
    const ticks: Array<{ at: number; label: string }> = [];
    for (let at = start; at < end; at += 30 * 60_000) ticks.push({ at, label: formatTimeLabel(at) });
    const chans = p.visible.slice(0, guideLimit);
    return {
      start,
      end,
      now: p.nowMs,
      day: formatDayLabel(start, p.nowMs),
      ticks,
      more: chans.length < p.visible.length,
      labels: { live: t("Live"), replay: t("Replay"), ended: t("Ended"), none: t("No program info") },
      channels: chans.map((ch) => {
        const catchup = !!p.onPlayCatchup && channelHasCatchup(ch);
        return {
          name: ch.name,
          number: channelNumber(ch.attrs),
          logo: ch.logo ?? null,
          programs: (epgProgramsForChannel(ch, p.epg, tvgCounts) ?? [])
            .filter((pr) => pr.endMs > start && pr.startMs < end)
            .map((pr) => ({
              s: pr.startMs,
              e: pr.endMs,
              title: pr.title,
              from: formatTimeLabel(pr.startMs),
              to: formatTimeLabel(pr.endMs),
              replay: catchup && pr.endMs <= p.nowMs,
            })),
        };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideOn, p.visible, guideLimit, p.epg, tvgCounts, quarter, t, p.onPlayCatchup]);

  // ---- Pictures for what's on (TMDB, cached) ----------------------------------------------------
  const hydrateKeys = useMemo(() => {
    const set = new Set<string>();
    if (home) {
      for (const it of spotlight) if (isHydratableChannel(it.channel)) set.add(hydrationKey(it));
      for (const { items } of railItems.slice(0, 8)) for (const it of items.slice(0, 14)) if (isHydratableChannel(it.channel)) set.add(hydrationKey(it));
    }
    if (grid) for (const ch of shownGrid) if (isHydratableChannel(ch)) set.add(ch.name);
    return [...set];
  }, [home, grid, spotlight, railItems, shownGrid]);
  const hydrations = useChannelHydration(hydrateKeys);
  const hyd = (it: NowItem) => hydrations.get(hydrationKey(it)) ?? null;

  const rows = useMemo<NativeRowInput[]>(() => {
    const out: NativeRowInput[] = [];
    if (!p.hasPlaylist || p.stateKind === "error" || p.stateKind === "loading") return out;
    if (home) {
      if (spotlight.length > 0) {
        out.push({
          key: "spotlight",
          title: "",
          kind: "livehero",
          metas: [],
          cards: spotlight.map((it) => {
            const h = hyd(it);
            const art = h?.background || it.current?.iconUrl || null;
            return {
              title: it.current?.title || h?.name || it.channel.name,
              sub: [it.channel.name, it.channel.group].filter(Boolean).join(" · ") || null,
              img: art ? [art] : [],
              logo: it.channel.logo ?? null,
              bar: it.progress != null,
              progress: it.progress ?? 0,
              desc: it.current ? fmtLeft(it.current.endMs, p.nowMs, t) : null,
            };
          }),
          onOpen: (i) => {
            const it = spotlight[i];
            if (it) p.onPlay(it.channel);
          },
        });
        out.push({
          key: "picks",
          title: t("On now"),
          kind: "poster",
          metas: [],
          cards: spotlight.map((it) => {
            const h = hyd(it);
            return { title: it.current?.title || h?.name || it.channel.name, img: h?.poster ? [h.poster] : [], kicker: t("Live"), tint: RED };
          }),
          onOpen: (i) => {
            const it = spotlight[i];
            if (it) p.onPlay(it.channel);
          },
        });
      }
      const live = liveCount(games);
      out.push({
        key: "sports",
        title: t("Live & Upcoming"),
        note: live > 0 ? t("{n} LIVE", { n: live }) : null,
        sub: games.length === 0 ? t("No live or upcoming games right now.") : null,
        kind: "sports",
        metas: [],
        chips: {
          key: "league",
          items: [
            { id: "all", label: t("All"), on: league === "all" },
            ...LEAGUES.filter((l) => userLeagues.includes(l.key)).map((l) => ({ id: l.key, label: getLeagueLabel(l), on: league === l.key })),
          ],
        },
        onRowChip: pickLeague,
        tools: [{ id: "customize", label: t("sports.customize") }],
        onTool: () => p.onCustomizeSports(),
        cards: games.map((g) => sportCard(g, t)),
        onOpen: (i) => {
          const g = games[i];
          if (g) openMatchDetail(g);
        },
      });
      if (guide.length > 0) {
        out.push({
          key: "guide",
          title: t("On now"),
          kind: "guide",
          metas: [],
          cards: guide.map((it) => guideCard(it, t)),
          onOpen: (i) => {
            const it = guide[i];
            if (it) p.onPlay(it.channel);
          },
        });
      }
      const railRow = ({ rail, items }: (typeof railItems)[number]): NativeRowInput => ({
        key: `rail:${rail.key}`,
        title: rail.title,
        kind: "live",
        metas: [],
        cards: items.map((it) => nowCard(it, hyd(it), p.nowMs, t)),
        onOpen: (i) => {
          const it = items[i];
          if (it) p.onPlay(it.channel);
        },
        onAll: rail.group
          ? () => {
              p.setGroup(rail.group);
              p.setMode("grid");
            }
          : undefined,
      });
      for (const r of railItems.slice(0, rails.length)) out.push(railRow(r));
      if (countries.length >= 2) {
        const sel = new Set(countryPrefs.selected);
        out.push({
          key: "countries",
          title: t("Browse by country"),
          metas: [],
          cards: [],
          chips: {
            key: "country",
            items: [
              { id: "*", label: t("All"), on: sel.size === 0 },
              ...countries.map((c) => ({ id: c.code, label: `${c.name}  ${c.count}`, on: sel.has(c.code) })),
            ],
          },
          onRowChip: (id) => (id === "*" ? clearCountries(p.sourceId) : toggleCountry(p.sourceId, id)),
        });
      }
      for (const r of railItems.slice(rails.length)) out.push(railRow(r));
      return out;
    }
    if (grid) {
      for (const { row, resolved } of networks) {
        out.push({
          key: `net:${row.id}`,
          title: row.title,
          kind: "logo",
          metas: [],
          cards: resolved.map((n) => ({ title: n.def.displayName, img: n.logoUrl ? [n.logoUrl] : [] })),
          onOpen: (i) => {
            const n = resolved[i];
            if (n) p.onPlay(n.channel);
          },
        });
      }
      if (shownGrid.length > 0) {
        out.push({
          key: "channels",
          title: "",
          kind: "channel",
          grid: true,
          min: 200,
          metas: [],
          cards: shownGrid.map((ch) => {
            const { current } = gridNow.get(ch.id) ?? { current: null };
            const h = hydrations.get(ch.name) ?? null;
            const progress =
              current && current.endMs > current.startMs
                ? Math.max(0, Math.min(1, (p.nowMs - current.startMs) / (current.endMs - current.startMs)))
                : null;
            return {
              title: h?.name?.trim() || ch.name,
              sub: current?.title ?? null,
              img: h?.poster ? [h.poster] : [],
              logo: ch.logo ?? null,
              bar: progress != null,
              progress: progress ?? 0,
              desc: current ? (current.endMs > p.nowMs ? fmtLeft(current.endMs, p.nowMs, t) : null) : ch.group || t("No program info"),
            };
          }),
          onOpen: (i) => {
            const ch = shownGrid[i];
            if (ch) p.onPlay(ch);
          },
          onAction: (a, i) => {
            const ch = shownGrid[i];
            if (a !== "hold" || !ch) return false;
            const h = hydrations.get(ch.name) ?? null;
            p.onInfo(
              h ?? {
                id: `iptv:${ch.id}`,
                type: "tv",
                name: ch.name,
                poster: ch.logo ?? undefined,
                logo: ch.logo ?? undefined,
                background: ch.logo ?? undefined,
                description: ch.group ? `Live channel · ${ch.group}` : "Live channel",
                releaseInfo: "Live",
              },
            );
            return true;
          },
          more: shownGrid.length < p.visible.length ? () => setLimit((l) => l + 60) : undefined,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, home, grid, p.hasPlaylist, p.stateKind, spotlight, games, league, userLeagues, guide, railItems, rails.length, countries, countryPrefs.selected, networks, shownGrid, gridNow, hydrations, p.nowMs, p.visible.length]);

  const chips = [
    { key: "source", items: [{ id: "picker", label: `●  ${p.sourceName}${p.channelCount > 0 ? `  ${p.channelCount.toLocaleString(uiLocale())}` : ""}  ▾`, on: false }] },
    {
      key: "mode",
      items: [
        { id: "home", label: t("Home"), on: p.mode === "home" },
        { id: "grid", label: t("Grid"), on: p.mode === "grid" },
        { id: "guide", label: t("Guide"), on: p.mode === "guide" },
        ...(p.hasCategories
          ? [{ id: "cats", label: `☰  ${p.group === null ? t("Categories") : p.group === FAVORITES_GROUP_KEY ? t("Favorites") : p.catsLabel}`, on: p.group !== null }]
          : []),
      ],
    },
  ];

  return useNativeBrowsePage("live", {
    active: p.active,
    blocked: !p.hasSources || p.mode === "multiview",
    guide: guideModel,
    onGuide: (what, i, text) => {
      if (what === "more") return setGuideLimit((n) => n + 40);
      const ch = p.visible[i];
      if (!ch) return;
      if (what === "pg") {
        const progs = (epgProgramsForChannel(ch, p.epg, tvgCounts) ?? []).filter((pr) => {
          const g = guideModel;
          return !!g && pr.endMs > g.start && pr.startMs < g.end;
        });
        const pr = progs[Number(text)];
        if (pr && pr.endMs <= p.nowMs && p.onPlayCatchup && channelHasCatchup(ch)) return p.onPlayCatchup(ch, pr);
      }
      p.onPlay(ch);
    },
    hidden: p.pickerOpen || p.catsOpen || p.sportsOpen,
    t,
    header: p.mode === "home" && p.hasPlaylist && p.stateKind !== "error" ? { title: t("Your TV"), count: t("at {time}", { time: fmtClock(p.nowMs) }), size: 30 } : null,
    search: {
      key: `live:${p.sourceId}`,
      hint: t("Search {n} channels", { n: p.channelCount }),
      text: p.query,
      onQuery: (q) => {
        p.setQuery(q);
        if (q && p.mode === "home") p.setMode("grid");
      },
    },
    chips,
    onChip: (group, id) => {
      if (group === "source") p.onOpenPicker();
      else if (group === "mode") {
        if (id === "cats") p.onOpenCats();
        else p.setMode(id as ViewMode);
      }
    },
    rows,
    message:
      p.stateKind === "error"
        ? { text: p.errorMessage ?? t("Something went wrong."), action: t("Try again"), onAction: p.onRetry }
        : p.stateKind === "loading" && !p.hasPlaylist
          ? { text: t("Loading…") }
          : (p.mode === "grid" || p.mode === "guide") && p.hasPlaylist && p.visible.length === 0
            ? {
                title: t("No channels match"),
                text: t("Try a different category or clear your filters."),
                action: t("Reset filters"),
                onAction: () => {
                  p.setQuery("");
                  p.setGroup(null);
                },
              }
            : null,
  });
}
