// Android: the Addons page and an addon's own page drawn by the native screen (see AddonsModel.kt),
// in the page's layout and with its texts: the tabs, search, "paste a URL", Adult and the filters;
// Discover (sign in, the featured addon, stremio-addons.net's top, Starters, the categories, the
// curated rails), Browse (top rated / rising / newest, more as it scrolls) and Installed (switch,
// Manage, remove with a second tap, Reorder). The page's pop-ups (install, age gate, reorder) still
// open over it.

import { useEffect, useRef, useState } from "react";
import { addonLogoSrc, paletteFor, resolveAddonLogo } from "@/components/addon-logo";
import {
  SITE_NAME,
  SITE_URL,
  TABS as COMMUNITY_TABS,
  installCommunityAddon,
  stremioAddonsLogo,
  useCommunityRailItems,
  type SortMode,
} from "@/components/community-addons-rail";
import { isAddonEnabled, setAddonEnabled } from "@/lib/addon-store";
import type { ResolvedAddon } from "@/lib/addons-store/store";
import { useT } from "@/lib/i18n";
import { uiLocale } from "@/lib/i18n/locale";
import { addonSiteUrl, type SAAddon } from "@/lib/providers/stremio-addons";
import { communityFor, useCommunityIndex } from "@/lib/providers/stremio-addons-index";
import { openUrl } from "@/lib/window";
import { useNativeBrowsePage, useNativeScreensEnabled, type NativeRowInput } from "@/views/native/native-screens";
import { absUrl } from "@/views/play-picker/native-blocks";
import iconAnime from "@/assets/category/png/anime.png";
import iconCatalogs from "@/assets/category/png/catalogs.png";
import iconLivetv from "@/assets/category/png/livetv.png";
import iconSports from "@/assets/category/png/sports.png";
import iconStreams from "@/assets/category/png/streams.png";
import iconSubtitles from "@/assets/category/png/subtitles.png";
import type { Tab, ToastInfo } from "./addons-types";
import { idOf, nameOf, subtitleFromManifest, withMinDuration } from "./addons-utils";
import { CATEGORY_TILES } from "./category-grid";
import { isInstalled, isNewlyAdded, useApiSortedAddons, useRisingAddons } from "./community-browse-list";

type Json = Record<string, unknown>;
type T = ReturnType<typeof useT>;

/** The category tiles' icons as pictures the native screen can draw (the page's are SVGs). */
const CATEGORY_ICON: Record<string, string> = {
  "http+streams": iconStreams,
  metadata: iconCatalogs,
  subtitles: iconSubtitles,
  anime: iconAnime,
  torrents: iconSports,
  "live+tv": iconLivetv,
};

const TW: Record<string, string> = {
  "amber-400": "fbbf24",
  "amber-500": "f59e0b",
  "orange-500": "f97316",
  "orange-600": "ea580c",
  "blue-500": "3b82f6",
  "indigo-600": "4f46e5",
  "cyan-500": "06b6d4",
  "sky-600": "0284c7",
  "emerald-500": "10b981",
  "teal-600": "0d9488",
  "rose-500": "f43f5e",
  "pink-600": "db2777",
  "violet-500": "8b5cf6",
  "fuchsia-600": "c026d3",
};

/** "from-amber-500/40 to-orange-600/30" as the two colours (#AARRGGBB). */
export function gradientOf(cls: string | undefined): [string, string] | null {
  if (!cls) return null;
  const pick = (side: "from" | "to") => {
    const m = new RegExp(`${side}-([a-z]+-\\d+)(?:/(\\d+))?`).exec(cls);
    const hex = m ? TW[m[1]] : undefined;
    if (!hex) return null;
    const a = Math.round(((m![2] ? Number(m![2]) : 100) / 100) * 255);
    return `#${a.toString(16).padStart(2, "0")}${hex}`;
  };
  const f = pick("from");
  const t = pick("to");
  return f && t ? [f, t] : null;
}

/** An addon's logo as the page's AddonLogo picks it (bundled ones for some), and its initial. */
export function logoJson(id: string, name: string, manifestLogo: string | null | undefined): Json {
  const bundled = addonLogoSrc(id, name);
  const preferBundled = /mediafusion/.test(`${id} ${name}`.toLowerCase()) && !!bundled;
  const primary = preferBundled ? bundled : manifestLogo || bundled || null;
  const fallback = preferBundled ? null : manifestLogo && bundled ? bundled : null;
  const [from, to] = paletteFor(id || name || "?");
  return {
    img: [primary, fallback].map((u) => absUrl(u)).filter((u): u is string => !!u),
    initial: (name || "?").trim().charAt(0).toUpperCase(),
    from,
    to,
  };
}

const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The community's stars and "New" (AddonStarBadge). */
export function starPills(manifestId: string | undefined | null, t: T): Json[] {
  const c = communityFor(manifestId);
  if (!c) return [];
  const out: Json[] = [];
  if (c.stars > 0) out.push({ text: c.stars.toLocaleString(uiLocale()), tone: "star", icon: "star" });
  const at = Date.parse(c.createdAt ?? "");
  if (Number.isFinite(at) && Date.now() - at < NEW_WINDOW_MS) out.push({ text: t("New"), tone: "new", icon: "sparkles" });
  return out;
}

/** The curated tags (TagRow). */
export function tagPills(r: ResolvedAddon, t: T): Json[] {
  const out: Json[] = [];
  for (const tag of r.curated?.tags ?? []) {
    if (tag === "official") out.push({ text: t("Official"), tone: "good" });
    if (tag === "free") out.push({ text: t("Free"), tone: "neutral" });
    if (tag === "premium") out.push({ text: t("Paid"), tone: "warn" });
    if (tag === "debrid-required") out.push({ text: t("Debrid required"), tone: "warn" });
    if (tag === "configurable") out.push({ text: t("Configurable"), tone: "neutral" });
    if (tag === "usenet") out.push({ text: t("Usenet"), tone: "neutral" });
  }
  if (r.manifest?.behaviorHints?.adult) out.push({ text: t("Adult"), tone: "warn" });
  return out;
}

const configurable = (r: ResolvedAddon) =>
  r.manifest?.behaviorHints?.configurable === true || r.manifest?.behaviorHints?.configurationRequired === true;

/** A tile's button (TileCard). */
export function tileButton(r: ResolvedAddon, installed: boolean, busy: boolean, t: T): Json {
  if (installed) return { id: "btn", label: t("Installed"), style: "green", icon: "check" };
  if (busy) return { id: "btn", label: t("Installing"), style: "busy", busy: true };
  if (configurable(r)) return { id: "btn", label: t("Set up"), style: "ink", icon: "settings" };
  return { id: "btn", label: t("Install"), style: "ink" };
}

export function tileJson(r: ResolvedAddon, installed: boolean, busy: boolean, t: T): Json {
  const logo = resolveAddonLogo(r.manifest?.logo, r.transportUrl);
  return {
    logo: logoJson(idOf(r), nameOf(r), logo),
    name: nameOf(r),
    pills: starPills(r.manifest?.id, t),
    desc: r.manifest?.description ?? subtitleFromManifest(r),
    button: tileButton(r, installed, busy, t),
    art: absUrl(logo),
  };
}

/** Markdown as headings, paragraphs, list lines and code (the native screen draws plain text). */
export function markdownParts(md: string): Array<{ k: string; text: string }> {
  const clean = (s: string) =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  const out: Array<{ k: string; text: string }> = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  const flush = () => {
    const text = clean(para.join(" "));
    if (text) out.push({ k: "p", text });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      if (code.length) out.push({ k: "code", text: code.join("\n") });
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const text = clean(h[2]);
      if (text) out.push({ k: h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : "h3", text });
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const text = clean(li[1]);
      if (text) out.push({ k: "li", text });
      continue;
    }
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.slice(0, 400);
}

/** A toast as the native screen shows it: once per new message. */
export function useNativeToast(toast: ToastInfo | null): { id: number; text: string } | null {
  const seq = useRef(0);
  const last = useRef<ToastInfo | null>(null);
  if (toast && toast !== last.current) seq.current += 1;
  last.current = toast;
  return toast ? { id: seq.current, text: toast.addon?.name ? `${toast.text} · ${toast.addon.name}` : toast.text } : null;
}

/** Two-tap removal on a phone: [armed] is the addon asked about, for 3.5 s. */
function useArmed(): [string | null, (k: string | null) => void] {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(null), 3500);
    return () => window.clearTimeout(id);
  }, [armed]);
  return [armed, setArmed];
}

type BrowseModeId = "top" | "new" | "rising";

export function useNativeAddons(o: {
  active: boolean;
  blocked: boolean;
  hidden: boolean;
  tab: Tab;
  setTab: (t: Tab) => void;
  query: string;
  setQuery: (q: string) => void;
  categoryFilter: string | null;
  setCategoryFilter: (c: string | null) => void;
  browseMode: BrowseModeId;
  setBrowseMode: (m: BrowseModeId) => void;
  browseModes: Array<{ id: BrowseModeId; label: string }>;
  filtersOpen: boolean;
  setFiltersOpen: (v: boolean) => void;
  categories: Array<{ slug: string; name: string }>;
  showAdult: boolean;
  onAdult: () => void;
  hero: { entry: { id: string }; resolved: ResolvedAddon } | null;
  rails: { rail: { id: string; title: string; blurb?: string; layout: string }; items: ResolvedAddon[] }[];
  installed: ResolvedAddon[];
  installedIds: Set<string>;
  loading: boolean;
  catalogEmpty: boolean;
  authKey: string | null;
  onOpen: (id: string) => void;
  onInstall: (r: ResolvedAddon) => Promise<void>;
  onUninstall: (r: ResolvedAddon) => Promise<void>;
  onManage: (r: ResolvedAddon) => void;
  onReorder: () => void;
  onUrl: (url: string) => void;
  refetch: () => void;
  toast: ToastInfo | null;
}): boolean {
  const t = useT();
  useCommunityIndex();
  const enabled = useNativeScreensEnabled();
  const on = enabled && !o.blocked && o.active;
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useArmed();
  const [railOpen, setRailOpen] = useState<Set<string>>(new Set());
  const [commSort, setCommSort] = useState<SortMode>("stars");
  const [commBusy, setCommBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [, bump] = useState(0);
  const comm = useCommunityRailItems(commSort, on && o.tab === "discover");
  const q = o.query.trim();
  const browseOn = on && o.tab === "browse" && o.browseMode !== "rising";
  const api = useApiSortedAddons({
    mode: o.browseMode === "new" ? "new" : "top",
    category: q ? null : o.categoryFilter,
    search: q || null,
    allowAdult: o.showAdult,
    enabled: browseOn,
  });
  const rising = useRisingAddons({ category: q ? null : o.categoryFilter, search: q || null, allowAdult: o.showAdult });
  const toast = useNativeToast(o.toast);

  const withBusy = async (key: string, work: () => Promise<unknown>, min: number) => {
    setBusy((s) => new Set(s).add(key));
    try {
      await withMinDuration(work(), min);
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };
  /** InstallPill: install, set up, or remove on a second tap. */
  const pillTap = (r: ResolvedAddon) => {
    const key = idOf(r);
    if (busy.has(key)) return;
    if (o.installedIds.has(key)) {
      if (armed !== key) return setArmed(key);
      setArmed(null);
      void withBusy(key, () => o.onUninstall(r), 450);
      return;
    }
    if (configurable(r)) return o.onOpen(key);
    void withBusy(key, () => o.onInstall(r), 650);
  };
  const pillJson = (r: ResolvedAddon): Json => {
    const key = idOf(r);
    const inst = o.installedIds.has(key);
    if (busy.has(key)) return { id: "btn", label: t("Installing"), style: "busy", busy: true };
    if (inst && armed === key) return { id: "btn", label: t("Tap again to remove"), style: "danger", icon: "x" };
    if (inst) return { id: "btn", label: t("Installed"), style: "installed", icon: "check" };
    if (configurable(r)) return { id: "btn", label: t("Set up"), style: "ink", icon: "settings" };
    return { id: "btn", label: t("Install"), style: "ink", icon: "plus" };
  };
  const tileTap = (r: ResolvedAddon) => {
    const key = idOf(r);
    if (o.installedIds.has(key) || busy.has(key)) return;
    if (configurable(r)) return o.onOpen(key);
    void withBusy(key, () => o.onInstall(r), 0);
  };

  const rows: NativeRowInput[] = [];
  const add = (key: string, ad: Json, onAd?: (what: string, i: number) => void) => rows.push({ key, title: "", kind: "ad", metas: [], ad, onAd });
  const panel = (key: string, pk: Json) => rows.push({ key, title: "", kind: "pk", metas: [], pk: { type: "panel", ...pk } });
  rows.push({
    key: "ad-url",
    title: "",
    kind: "action",
    metas: [],
    cards: [{ title: t("Paste manifest URL or stremio:// link"), icon: "link", tone: "plain" }],
    onOpen: () => setAsking(true),
  });
  const cardJson = (r: ResolvedAddon, variant: string): Json => {
    const logo = resolveAddonLogo(r.manifest?.logo, r.transportUrl);
    return {
      type: "card",
      variant,
      logo: logoJson(idOf(r), nameOf(r), logo),
      name: nameOf(r),
      pills: starPills(r.manifest?.id, t),
      desc: variant === "feature" ? r.manifest?.description ?? null : r.manifest?.description ?? subtitleFromManifest(r),
      tags: variant === "feature" ? tagPills(r, t) : [],
      button: pillJson(r),
      chevron: false,
      art: absUrl(logo),
    };
  };
  const rail = (id: string, title: string, blurb: string | undefined, layout: string, items: ResolvedAddon[]) => {
    const collapsed = layout === "feature" || layout === "list" ? 2 : 4;
    const open = railOpen.has(id);
    const shown = open ? items : items.slice(0, collapsed);
    add(
      `ad-h-${id}`,
      {
        type: "head",
        title,
        blurb: blurb ?? null,
        action: items.length > collapsed ? (open ? t("Show less") : t("See all ({n})", { n: items.length })) : null,
        open,
      },
      () =>
        setRailOpen((s) => {
          const n = new Set(s);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        }),
    );
    if (layout === "feature" || layout === "list") {
      shown.forEach((r, i) =>
        add(`ad-${id}-${i}`, cardJson(r, layout), (what) => (what === "btn" ? pillTap(r) : o.onOpen(idOf(r)))),
      );
    } else {
      add(
        `ad-t-${id}`,
        { type: "tiles", strip: false, items: shown.map((r) => tileJson(r, o.installedIds.has(idOf(r)), busy.has(idOf(r)), t)) },
        (what, i) => {
          const r = shown[i];
          if (!r) return;
          if (what === "btn") tileTap(r);
          else o.onOpen(idOf(r));
        },
      );
    }
  };
  const communityRow = (a: SAAddon, i: number, extra: { delta?: number; window?: number; isNew?: boolean; last?: boolean }) => {
    const m = a.manifest;
    const name = m?.name ?? a.slug;
    const logo = resolveAddonLogo(m?.logo, a.manifestUrl);
    const inst = isInstalled(a, o.installedIds);
    const pills: Json[] = [];
    if (a.stars > 0) pills.push({ text: a.stars.toLocaleString(uiLocale()), tone: "star", icon: "star" });
    if (extra.delta != null) pills.push({ text: `+${extra.delta} / ${extra.window === 1 ? "24h" : `${extra.window}d`}`, tone: "rise", icon: "trend" });
    if (extra.isNew) pills.push({ text: t("New"), tone: "new", icon: "sparkles" });
    add(
      `ad-c-${a.uuid}`,
      {
        type: "card",
        variant: "community",
        logo: logoJson(m?.id ?? a.slug, name, logo),
        name,
        pills,
        desc: m?.description ?? "",
        tags: [],
        button: inst
          ? { id: "btn", label: t("Installed"), style: "accentpill" }
          : m?.id
            ? { id: "btn", label: t("Install"), style: "ink", icon: "plus", busy: busy.has(a.uuid) }
            : null,
        chevron: true,
        art: absUrl(logo),
        more: !!extra.last,
      },
      (what) => {
        if (what === "more") return void api.loadMore();
        if (what === "btn") {
          if (inst || busy.has(a.uuid)) return;
          void withBusy(a.uuid, () => installCommunityAddon(a).then(() => o.refetch()), 0);
          return;
        }
        if (m?.id) o.onOpen(m.id);
        else openUrl(a.url);
      },
    );
    void i;
  };

  if (o.loading && o.catalogEmpty) {
    rows.push({ key: "ad-loading", title: "", kind: "action", metas: [], cards: [{ title: t("Loading the catalog"), busy: true, tone: "plain" }] });
  } else if (o.tab === "discover") {
    if (!o.authKey) {
      panel("ad-signin", {
        look: "warn",
        title: t("Sign in to sync your addons across devices"),
        body: t("Anything you install in Harbor pushes back to your Stremio account so it shows up on your other devices too. Sign in from More → Settings → Account."),
      });
    }
    const hero = o.hero;
    const c = hero?.resolved.curated?.hero;
    if (hero && c) {
      const inst = o.installedIds.has(hero.entry.id);
      const g = idOf(hero.resolved) === "com.stremio.torrentio.addon" ? null : gradientOf(c.accent);
      add(
        "ad-hero",
        {
          type: "hero",
          eyebrow: t(c.eyebrow),
          pills: starPills(hero.resolved.manifest?.id, t),
          title: c.title,
          subtitle: t(c.subtitle),
          button: !inst
            ? { id: "btn", label: t("Get"), style: "ink" }
            : armed === hero.entry.id
              ? { id: "btn", label: t("Tap again to remove"), style: "danger", icon: "x" }
              : { id: "btn", label: t("Installed"), style: "installed" },
          link: t("View details"),
          from: g?.[0] ?? null,
          to: g?.[1] ?? null,
        },
        (what) => {
          if (what !== "btn") return o.onOpen(hero.entry.id);
          if (!inst) return void o.onInstall(hero.resolved);
          // Same as every other "Installed" button here: the first tap asks, the second removes.
          if (armed !== hero.entry.id) return setArmed(hero.entry.id);
          setArmed(null);
          void o.onUninstall(hero.resolved);
        },
      );
    }
    const items = comm.items;
    add(
      "ad-community",
      {
        type: "community",
        logo: absUrl(stremioAddonsLogo),
        kicker: t("Community ratings"),
        title: t("Top on"),
        site: SITE_NAME,
        sub: `${t("Ranked by the")} ${SITE_NAME} ${t("community from their public index.")}`,
        tabs: COMMUNITY_TABS.map((tb) => ({ id: tb.id, label: tb.label, on: commSort === tb.id })),
        browse: t("Browse all"),
        state: comm.error ? "error" : items === null ? "loading" : items.length === 0 ? "empty" : "ok",
        message: comm.error
          ? `${SITE_NAME} ${t("should be reachable in a moment. They're deploying right now. Refresh once their docs go live.")}\n(${comm.error})`
          : items && items.length === 0
            ? t("No addons match these filters right now.")
            : null,
        cards: (items ?? []).map((a) => {
          const m = a.manifest;
          return {
            bg: m?.background ?? null,
            stars: a.stars.toLocaleString(uiLocale()),
            logo: m?.logo ?? null,
            name: m?.name ?? a.slug,
            desc: m?.description ?? null,
            types: (Array.isArray(m?.types) ? m!.types! : []).slice(0, 3),
            installed: isInstalled(a, o.installedIds) ? t("Installed") : null,
            install: t("Install"),
            busy: commBusy === a.uuid,
          };
        }),
      },
      (what, i) => {
        if (what.startsWith("tab:")) return setCommSort(what.slice(4) as SortMode);
        if (what === "site") return openUrl(SITE_URL);
        const a = items?.[i];
        if (!a) return;
        if (what === "install") {
          if (isInstalled(a, o.installedIds) || commBusy) return;
          setCommBusy(a.uuid);
          void installCommunityAddon(a)
            .then(() => o.refetch())
            .catch(() => undefined)
            .finally(() => setCommBusy(null));
          return;
        }
        if (a.manifest?.id) o.onOpen(a.manifest.id);
        else openUrl(addonSiteUrl(a.slug));
      },
    );
    const essential = o.rails.find((r) => r.rail.id === "essential");
    const picks = essential ? essential.items.filter((it) => idOf(it) !== (o.hero?.entry.id ?? "")) : [];
    if (picks.length > 0) rail("starters", t("Starters"), t("Common picks for a fresh setup."), "list", picks);
    add(
      "ad-cats",
      {
        type: "cats",
        title: t("Browse by category"),
        blurb: t("Six places to start. Tap one and we'll filter the catalog for you."),
        tiles: CATEGORY_TILES.map((c) => {
          const g = gradientOf(c.accent);
          return { title: t(c.title), blurb: t(c.blurb), from: g?.[0] ?? null, to: g?.[1] ?? null, icon: absUrl(CATEGORY_ICON[c.cat]) };
        }),
      },
      (_what, i) => {
        const c = CATEGORY_TILES[i];
        if (!c) return;
        o.setCategoryFilter(c.cat);
        o.setTab("browse");
      },
    );
    for (const { rail: r, items: its } of o.rails) {
      if (r.id === "essential") continue;
      rail(r.id, t(r.title), r.blurb ? t(r.blurb) : undefined, r.layout, its);
    }
  } else if (o.tab === "browse") {
    if (o.browseMode === "rising") {
      if (rising.length === 0) {
        panel("ad-norise", {
          look: "dashed",
          title: t("No velocity data yet"),
          titleSize: 18,
          body: t("Trending tracks star growth across your Harbor visits. Open the addons page again tomorrow and the top risers will appear here."),
        });
      }
      rising.forEach((r, i) => communityRow(r.addon, i, { delta: r.delta, window: r.window }));
    } else {
      api.items.forEach((a, i) => communityRow(a, i, { isNew: o.browseMode === "new" && isNewlyAdded(a.createdAt), last: i === api.items.length - 1 && !api.exhausted }));
      if (api.loading) {
        rows.push({ key: "ad-more", title: "", kind: "action", metas: [], cards: [{ title: t("Loading…"), busy: true, tone: "plain" }] });
      } else if (api.failed) {
        rows.push({
          key: "ad-retry",
          title: "",
          kind: "action",
          metas: [],
          cards: [{ title: t("Couldn't load the addons. Check your connection."), sub: t("Try again"), icon: "alert", tone: "plain" }],
          onOpen: () => void api.retry(),
        });
      } else if (api.exhausted && api.items.length > 0) {
        panel("ad-end", { look: "plain", body: t("You've reached the end · {n} addons", { n: api.items.length }) });
      }
    }
  } else {
    const ql = q.toLowerCase();
    const filtered = ql
      ? o.installed.filter((r) => {
          const name = (r.manifest?.name ?? "").toLowerCase();
          const desc = (r.manifest?.description ?? "").toLowerCase();
          const id = (r.manifest?.id ?? r.curated?.id ?? "").toLowerCase();
          return name.includes(ql) || desc.includes(ql) || id.includes(ql);
        })
      : o.installed;
    if (o.installed.length === 0) {
      panel("ad-none", {
        look: "card",
        title: t("No addons installed yet"),
        titleSize: 22,
        body: t("Head to Discover. Cinemeta and OpenSubtitles cover the basics; Torrentio + a debrid key cover almost everything else."),
      });
    } else if (filtered.length === 0) {
      panel("ad-nomatch", {
        look: "dashed",
        title: t("No installed addon matches that."),
        titleSize: 16,
        body: t("Clear the search to see all {n} installed.", { n: o.installed.length }),
      });
    }
    for (const r of filtered) {
      const key = idOf(r);
      const isOn = isAddonEnabled(r.transportUrl);
      const removing = busy.has(key);
      add(
        `ad-i-${key}:${r.transportUrl}`,
        {
          type: "installed",
          logo: logoJson(key, nameOf(r), resolveAddonLogo(r.manifest?.logo, r.transportUrl)),
          name: nameOf(r),
          sub: isOn ? subtitleFromManifest(r) : t("Off · catalogs and streams hidden"),
          enabled: isOn,
          manage: configurable(r) && r.transportUrl ? t("Manage") : null,
          pill: removing
            ? { id: "remove", label: `${t("Uninstalling")}…`, style: "danger" }
            : armed === key
              ? { id: "remove", label: t("Tap again to remove"), style: "danger", icon: "trash" }
              : { id: "remove", label: t("Installed"), style: "installed" },
          dim: removing,
        },
        (what) => {
          if (removing) return;
          if (what === "toggle") {
            setAddonEnabled(r.transportUrl, !isOn);
            window.dispatchEvent(new CustomEvent("harbor:addons-changed", { detail: { id: key, enabled: !isOn } }));
            bump((n) => n + 1);
          } else if (what === "manage") o.onManage(r);
          else if (what === "remove") {
            if (armed !== key) return setArmed(key);
            setArmed(null);
            void withBusy(key, () => o.onUninstall(r), 0);
          } else o.onOpen(key);
        },
      );
    }
  }

  const tabChips = [
    { id: "discover", label: t("Discover"), on: o.tab === "discover" },
    { id: "browse", label: t("Browse"), on: o.tab === "browse" },
    { id: "installed", label: `✓  ${t("Installed")}  ${o.installedIds.size}`, on: o.tab === "installed" },
  ];
  const catName = o.categoryFilter ? o.categories.find((c) => c.slug === o.categoryFilter)?.name : undefined;
  const optChips = [
    { id: "adult", label: `${o.showAdult ? "☑" : "☐"}  ${t("Adult")}`, on: o.showAdult },
    ...(o.tab === "browse"
      ? [{ id: "filters", label: o.filtersOpen ? t("Hide") : catName ? `${t("Filters")} · ${catName}` : t("Filters"), on: o.filtersOpen }]
      : []),
    ...(o.tab === "installed" && o.installed.length > 0 ? [{ id: "reorder", label: `⇅  ${t("Reorder")}`, on: false }] : []),
  ];
  const chips = [
    { key: "tab", items: tabChips },
    { key: "opts", items: optChips },
    ...(o.tab === "browse" && o.filtersOpen
      ? [
          {
            key: "cat",
            items: [
              { id: "__all", label: t("All"), on: o.categoryFilter == null },
              ...o.categories.filter((c) => o.showAdult || c.slug !== "nsfw").map((c) => ({ id: c.slug, label: c.name, on: o.categoryFilter === c.slug })),
            ],
          },
          {
            key: "mode",
            items: o.browseModes.map((m) => ({
              id: m.id,
              label: `${m.id === "top" ? "★" : m.id === "rising" ? "↗" : "✦"}  ${t(m.label)}`,
              on: o.browseMode === m.id,
            })),
          },
        ]
      : []),
  ];
  return useNativeBrowsePage("addons", {
    active: o.active,
    blocked: o.blocked,
    hidden: o.hidden,
    t,
    rows,
    chips,
    onChip: (group, id) => {
      if (group === "tab") {
        o.setTab(id as Tab);
        if (id === "browse") o.setCategoryFilter(null);
      } else if (group === "opts") {
        if (id === "adult") o.onAdult();
        else if (id === "filters") o.setFiltersOpen(!o.filtersOpen);
        else if (id === "reorder") o.onReorder();
      } else if (group === "cat") {
        o.setCategoryFilter(id === "__all" ? null : id);
        o.setFiltersOpen(false);
      } else if (group === "mode") {
        o.setBrowseMode(id as BrowseModeId);
        o.setFiltersOpen(false);
      }
    },
    search: { key: "addons", hint: t("Search addons"), text: o.query, onQuery: o.setQuery },
    scrollKey: `${o.tab}:${o.categoryFilter ?? ""}`,
    toast,
    prompt: asking
      ? { key: "url", title: t("Install from URL: paste any manifest or stremio:// link"), hint: t("Paste manifest URL or stremio:// link"), ok: t("Install"), cancel: t("Cancel") }
      : null,
    onPrompt: (_key, text) => {
      setAsking(false);
      const url = text?.trim();
      if (url) o.onUrl(url);
    },
  });
}

/** An addon's page (AddonDetail) drawn by the native screen; [rows] in the page's order. */
export function useNativeAddonDetail(o: {
  active: boolean;
  resolved: ResolvedAddon;
  installedIds: Set<string>;
  related: ResolvedAddon[];
  recommended: ResolvedAddon[];
  detail: Record<string, unknown>;
  warnings: string[];
  documentation: string | null;
  info: Record<string, unknown>;
  onTap: (what: string) => void;
  onOpen: (id: string) => void;
  onInstallAddon: (r: ResolvedAddon) => Promise<void>;
  toast: { id: number; text: string } | null;
}): boolean {
  const t = useT();
  useCommunityIndex();
  const [docOpen, setDocOpen] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  useEffect(() => setDocOpen(false), [o.resolved.transportUrl]);
  const rows: NativeRowInput[] = [];
  const add = (key: string, ad: Json, onAd?: (what: string, i: number) => void) => rows.push({ key, title: "", kind: "ad", metas: [], ad, onAd });
  add("adx-top", { type: "detail", ...o.detail }, (what) => o.onTap(what));
  if (o.warnings.length > 0) {
    rows.push({
      key: "adx-warn",
      title: "",
      kind: "pk",
      metas: [],
      pk: { type: "panel", look: "warn", title: t("Worth knowing"), body: o.warnings.map((w) => `•  ${w}`).join("\n") },
    });
  }
  if (o.documentation) {
    add(
      "adx-doc",
      {
        type: "doc",
        title: t("Documentation"),
        note: t("From stremio-addons.net"),
        parts: markdownParts(o.documentation),
        open: docOpen,
        more: t("View more"),
        less: t("Show less"),
      },
      () => setDocOpen((v) => !v),
    );
  }
  add("adx-info", { type: "info", ...o.info }, (what) => o.onTap(what));
  const strip = (key: string, title: string, items: ResolvedAddon[]) => {
    if (items.length === 0) return;
    add(`adx-h-${key}`, { type: "head", title, size: 22 });
    add(
      `adx-t-${key}`,
      { type: "tiles", strip: true, items: items.map((r) => tileJson(r, o.installedIds.has(idOf(r)), busy.has(idOf(r)), t)) },
      (what, i) => {
        const r = items[i];
        if (!r) return;
        const id = idOf(r);
        if (what !== "btn") return o.onOpen(id);
        if (o.installedIds.has(id) || busy.has(id)) return;
        if (configurable(r)) return o.onOpen(id);
        setBusy((s) => new Set(s).add(id));
        void o.onInstallAddon(r).finally(() =>
          setBusy((s) => {
            const n = new Set(s);
            n.delete(id);
            return n;
          }),
        );
      },
    );
  };
  strip("related", t("More like this"), o.related);
  strip("recommended", t("Recommended for you"), o.recommended);
  return useNativeBrowsePage("addon", {
    active: o.active,
    t,
    back: true,
    rows,
    scrollKey: o.resolved.transportUrl,
    toast: o.toast,
  });
}
