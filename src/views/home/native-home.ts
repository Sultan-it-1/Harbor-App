// Android app: Home drawn natively (see src/views/native/native-screens.ts). The page still
// decides what Home shows (addons, TMDB, Trakt, the row order and hidden rows…) and handles every
// tap; the shell only draws it.
import { useMemo, useRef } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { Slide } from "@/components/hero-carousel";
import type { HomeRowCustomization } from "@/lib/home-customization";
import { useSettings } from "@/lib/settings";
import type { LibraryItem } from "@/lib/stremio";
import { useView } from "@/lib/view";
import {
  cwCard,
  cwEpisode,
  cwMeta,
  editLabels,
  nativeLabels,
  nativeRowJson,
  type NativeRowInput,
  nativeScreensAvailable,
  useNativeCards,
  useNativeMetaActions,
  useNativeScreen,
  useNativeScreensEnabled,
  type NativeAction,
  type T,
} from "@/views/native/native-screens";
import type { HomeRow } from "./home-types";

/** A row as the page would show it, already filtered (see CustomizableRows). */
export type NativeHomeRow = { row: HomeRow; metas: Meta[]; ranked: boolean };

/** Home's row editor (the same changes the page's own editor makes). */
export type NativeHomeEditor = {
  custom: HomeRowCustomization;
  /** The editable rows' keys in their order (what decides "Move up" / "Move down"). */
  orderKeys: string[];
  move: (key: string, delta: -1 | 1) => void;
  toggleHidden: (key: string) => void;
  rename: (key: string, label: string) => void;
  toggleNumerals: (key: string) => void;
  toggleHero: (key: string) => void;
  deleteSource: (key: string) => void;
  reset: () => void;
  addSource: () => void;
};

export type NativeHomeInput = {
  /** Home is the screen on top. */
  active: boolean;
  editMode: boolean;
  setEditMode: (on: boolean) => void;
  t: T;
  heroSlides: Slide[];
  /** Home has a hero (not the classic Home); hidden or not is the editor's. */
  showHero: boolean;
  cwItems: LibraryItem[];
  signedIn: boolean;
  /** The Top 10, when there is one (hidden or not). */
  top10: Meta[];
  top10Title: string;
  /** In the editor: every row, hidden ones too. */
  rows: NativeHomeRow[];
  onLoadMore: (rowKey: string) => void;
  resetTick: number;
  /** Your Streaming (TMDB services) and Collections (hidden or not), when Home has them. */
  servicesRow?: NativeRowInput | null;
  collectionsRow?: NativeRowInput | null;
  editor: NativeHomeEditor;
};

/** The shell can draw the browse screens (kept under this name for the Settings switch). */
export const nativeHomeAvailable = nativeScreensAvailable;

/**
 * Publishes Home to its native screen. Returns true while the native Home is in use: the page then
 * leaves its own Home empty (it is underneath, out of sight).
 */
export function useNativeHome(input: NativeHomeInput): boolean {
  const { settings } = useSettings();
  const { openPicker, openGrid } = useView();
  const enabled = useNativeScreensEnabled();
  const inUse = enabled;
  const cards = useNativeCards();
  const meta = useNativeMetaActions();

  const published = useRef<{ hero: Meta[]; cw: LibraryItem[]; rows: Map<string, { metas: Meta[]; row?: HomeRow; input?: NativeRowInput }> }>({
    hero: [],
    cw: [],
    rows: new Map(),
  });
  const editing = input.editMode;
  const custom = input.editor.custom;
  const orderKeys = input.editor.orderKeys;
  const model = useMemo(() => {
    if (!inUse) return null;
    const { t } = input;
    const isHidden = (key: string) => custom.hidden.includes(key);
    const heroOn = input.showHero && !isHidden("hero");
    const hero = heroOn ? input.heroSlides.map((s) => s.meta) : [];
    const rows: unknown[] = [];
    const rowMap = new Map<string, { metas: Meta[]; row?: HomeRow; input?: NativeRowInput }>();
    /** A row the editor can only show or hide (the hero, the Top 10, Collections). */
    const pinned = (json: Record<string, unknown>, key: string) => {
      const hidden = isHidden(key);
      if (hidden) json.items = [];
      json.ed = { pinned: true, hidden };
      return json;
    };
    const extra = (r: NativeRowInput | null | undefined, editable: boolean) => {
      if (!r || !r.cards || r.cards.length === 0) return;
      if (editable && isHidden(r.key) && !editing) return;
      rowMap.set(r.key, { metas: r.metas, input: r });
      const json = nativeRowJson(r, cards) as Record<string, unknown>;
      rows.push(editable && editing ? pinned(json, r.key) : json);
    };
    // The editor: the hero's own switch first (the hero itself is above it).
    if (editing && input.showHero) {
      rows.push(pinned({ key: "hero", title: t("Featured hero"), kind: "poster", items: [] }, "hero"));
    }
    // The page's order: Continue Watching, Your Streaming, Top 10, Collections, then the rows.
    if (input.cwItems.length > 0) {
      rows.push({ key: "cw", title: t("Continue Watching"), kind: "cw", items: input.cwItems.map((i) => cwCard(i, t)) });
    }
    extra(input.servicesRow, false);
    if (input.top10.length >= 10 && (editing || !isHidden("top10"))) {
      rowMap.set("top10", { metas: input.top10 });
      const json: Record<string, unknown> = { key: "top10", title: input.top10Title, kind: "rank", items: input.top10.map(cards.rank) };
      rows.push(editing ? pinned(json, "top10") : json);
    }
    extra(input.collectionsRow, true);
    for (const { row, metas, ranked } of input.rows) {
      const hidden = isHidden(row.key);
      if (!editing && (hidden || row.sourceRow || metas.length === 0)) continue;
      // Your own sources (folders) are drawn by the page only: here, just their controls.
      const shown = row.sourceRow || hidden ? [] : ranked ? metas.slice(0, 10) : metas;
      rowMap.set(row.key, { metas: shown, row });
      const json: Record<string, unknown> = {
        key: row.key,
        title: t(row.name),
        kind: ranked ? "rank" : "poster",
        all: !!row.fetcher,
        more: !ranked && row.hasMore,
        items: ranked ? shown.map(cards.rank) : shown.map(cards.poster),
      };
      if (editing) {
        const idx = orderKeys.indexOf(row.key);
        const canHero = !row.sourceRow && row.metas.some((m) => m.background || m.poster);
        json.ed = {
          hidden,
          up: idx > 0,
          down: idx >= 0 && idx < orderKeys.length - 1,
          numerals: row.sourceRow || row.metas.length < 10 ? "na" : (custom.numerals ?? []).includes(row.key) ? "on" : "off",
          hero: canHero ? (custom.heroSource === row.key ? "on" : "off") : "na",
          del: !!row.sourceRow,
          renamed: row.key in custom.renamed,
        };
      }
      rows.push(json);
    }
    published.current = { hero, cw: input.cwItems, rows: rowMap };
    return {
      top: input.resetTick,
      labels: { ...nativeLabels(t, t("Customize home")), ...editLabels(t) },
      edit: editing,
      addSource: editing,
      hero: input.heroSlides
        .slice(0, hero.length)
        .map((s) => cards.hero(s.meta, t("#{position} in {label} Today", { position: s.rank.position, label: t(s.rank.label) }))),
      rows,
      cwEmpty:
        input.cwItems.length > 0
          ? null
          : {
              title: t("Continue Watching"),
              text: input.signedIn
                ? t("Nothing in progress yet. Press Play on something.")
                : `${t("Sign in to")} Stremio ${t("to bring in your library.")}`,
            },
      customize: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inUse, input.t, input.heroSlides, input.showHero, input.cwItems, input.signedIn, input.top10, input.top10Title, input.rows, input.resetTick, cards, input.servicesRow?.cards, input.collectionsRow?.cards, editing, custom, orderKeys]);

  const latest = useRef(input);
  latest.current = input;

  useNativeScreen("home", {
    inUse,
    active: input.active,
    model,
    onAction: (a: NativeAction) => {
      const p = published.current;
      const i = typeof a.i === "number" ? a.i : -1;
      switch (a.a) {
        case "hero":
          return meta.hero(p.hero[i], a.what);
        case "open":
        case "hold": {
          const entry = a.row === "cw" ? undefined : p.rows.get(a.row ?? "");
          if (a.a === "open" && entry?.input?.onOpen) return entry.input.onOpen(i);
          const m = a.row === "cw" ? (p.cw[i] ? cwMeta(p.cw[i]) : undefined) : entry?.metas[i];
          return a.a === "open" ? meta.open(m) : meta.hold(m);
        }
        case "play": {
          const item = a.row === "cw" ? p.cw[i] : undefined;
          if (item) openPicker(cwMeta(item), cwEpisode(item), { autoPlay: settings.instantPlay, resume: true });
          return;
        }
        case "all": {
          const onAll = p.rows.get(a.row ?? "")?.input?.onAll;
          if (onAll) return onAll();
          const row = p.rows.get(a.row ?? "")?.row;
          if (row?.fetcher) openGrid({ title: input.t(row.name), fetcher: row.fetcher, initial: row.metas });
          return;
        }
        case "more":
          if (a.row) input.onLoadMore(a.row);
          return;
        case "customize":
          latest.current.setEditMode(true);
          return;
        case "done":
          latest.current.setEditMode(false);
          return;
        case "reset":
          latest.current.editor.reset();
          return;
        case "addsource":
          latest.current.editor.addSource();
          return;
        case "edit": {
          const ed = latest.current.editor;
          const key = a.row;
          if (!key) return;
          switch (a.what) {
            case "up":
            case "down":
              return ed.move(key, a.what === "up" ? -1 : 1);
            case "hide":
              return ed.toggleHidden(key);
            case "rename":
              return ed.rename(key, a.text ?? "");
            case "num":
              return ed.toggleNumerals(key);
            case "hero":
              return ed.toggleHero(key);
            case "del":
              return ed.deleteSource(key);
          }
          return;
        }
      }
    },
  });

  return inUse;
}
