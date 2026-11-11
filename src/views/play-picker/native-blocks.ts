// Android: the picker's other layout (its big card, the qualities, every source), its messages and
// its full-screen steps, described for the native screen (see PickerModel.kt). Each builder mirrors
// one of the page's components, with the same texts: PrimaryCard, TierStrip, SourceDrawer,
// SourceDiagnostic, PickerEmptyLadder, CinematicLoader and the steps' modals.

import { addonLogoSrc } from "@/components/addon-logo";
import { badgeImage, streamBadges, type BadgeKind, type BadgeSize } from "@/components/format-badge";
import { resolveStreamLink } from "@/components/player/copy-link-button";
import type { Meta } from "@/lib/cinemeta";
import type { useDebridClients } from "@/lib/debrid/registry";
import { t } from "@/lib/i18n/translate";
import type { ScoredStream, Stream, Tier } from "@/lib/streams/types";
import type { SourceDescriptor } from "@/lib/together/protocol";
import { formatBytes, formatRuntime } from "@/lib/together/source-descriptor";
import { directStreamAvailable } from "@/lib/torrent/stremio-stream";
import type { PlayEpisode } from "@/lib/view";
import {
  confirmationLabel,
  contributorLabel,
  displayTitle,
  formatSize,
  groupRejections,
  hasUncachedMarker,
  streamLeadBadge,
  streamLeadLabel,
  streamSummaryParts,
  tierChipBadges,
  torrentFilename,
} from "./picker-utils";
import type { usePipelineResult } from "./use-pipeline-result";

type Debrids = ReturnType<typeof useDebridClients>;
type PipelineResult = ReturnType<typeof usePipelineResult>["result"];
type Json = Record<string, unknown>;

/** A picture the app ships (a badge, a bundled logo) by its full address: the native screen reads
 *  it from the app's own files. */
export function absUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (/^(https?:|data:)/i.test(u)) return u;
  try {
    return new URL(u, window.location.href).href;
  } catch {
    return null;
  }
}

function badge(kind: BadgeKind, size: BadgeSize): Json {
  const b = badgeImage(kind, size);
  return { src: absUrl(b.src), label: b.label, w: b.w };
}

const FLAG_CC: Record<string, string> = {
  English: "US",
  Italian: "IT",
  Russian: "RU",
  Hindi: "IN",
  Spanish: "ES",
  "Spanish (Latin America)": "ES",
  Korean: "KR",
  Japanese: "JP",
  Chinese: "CN",
  Portuguese: "PT",
  "Portuguese (Brazil)": "BR",
  German: "DE",
  French: "FR",
  Turkish: "TR",
  Arabic: "SA",
  Czech: "CZ",
  Danish: "DK",
  Finnish: "FI",
  Hebrew: "IL",
  Hungarian: "HU",
  Dutch: "NL",
  Norwegian: "NO",
  Polish: "PL",
  Romanian: "RO",
  Swedish: "SE",
  Thai: "TH",
  Ukrainian: "UA",
  Vietnamese: "VN",
};

/** An audio language as the native screen draws it: its flag as an emoji, or its name. */
function flag(lang: string, named: boolean): Json {
  if (lang === "Multi") return { emoji: null, label: named ? t("Multi") : "M", multi: true };
  const cc = FLAG_CC[lang];
  const emoji = cc ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : null;
  return { emoji, label: lang };
}

function addonLogo(s: ScoredStream, logo: string | null): string[] {
  const u = absUrl(logo ?? addonLogoSrc(s.addonId, s.addonName ?? ""));
  return u ? [u] : [];
}

function editionText(edition: string): string {
  if (/director/i.test(edition)) return "Director's Cut";
  if (/open[\s.]?matte/i.test(edition)) return "Open Matte";
  return edition;
}

/** The big card (PrimaryCard) and whether its button plays or asks the debrid to cache. */
export function pickBlock(o: {
  meta: Meta;
  episode?: PlayEpisode;
  stream: ScoredStream;
  debrids: Debrids;
  addonLogo: string | null;
  resolving: boolean;
  queued: boolean;
  inSession: boolean;
  isPreviouslyPlayed: boolean;
  match: "same" | "close" | null;
  showFilename: boolean;
  showBadges: boolean;
}): { pk: Json; action: "play" | "cache" | null } {
  const { meta, episode, stream, debrids } = o;
  const cachedDebrids = debrids.filter((d) => stream.cached[d.slug]);
  const libraryDebrids = debrids.filter((d) => stream.inLibrary[d.slug]);
  const cachedDebrid = cachedDebrids[0] ?? null;
  const externalOnly = !stream.url && !stream.infoHash && !!(stream.externalUrl || stream.ytId);
  const link = resolveStreamLink(stream);
  const isCached =
    (stream.url != null && !stream.infoHash && !hasUncachedMarker(stream)) || cachedDebrid != null || o.isPreviouslyPlayed;
  const queueTarget = debrids.find((d) => d.queueCache);
  const canStream = !isCached && directStreamAvailable(stream);
  const title = displayTitle(stream, meta.name, episode);
  const fname = o.showFilename ? torrentFilename(stream) : "";
  const known = stream.audioLanguages.filter((l) => l && l.toLowerCase() !== "unknown");
  const landscape = episode?.still || meta.background || null;
  const hero = landscape || meta.poster || meta.background || null;

  let status: Json | null = null;
  if (libraryDebrids.length > 0) {
    status = { text: `${t("In your")} ${libraryDebrids.map((d) => d.name).join(" + ")} ${t("library")}`, tone: "accent", icon: "zap", upper: false };
  } else if (cachedDebrids.length > 0) {
    status = { text: `${t("Cached on")} ${cachedDebrids.map((d) => d.name).join(" + ")}`, tone: "muted", icon: "zap", upper: false };
  } else if (o.queued) {
    status = { text: `${t("Queued on")} ${queueTarget?.name ?? "debrid"}`, tone: "green", icon: "check", upper: false };
  } else if (debrids.length > 0 && !stream.url) {
    status = { text: t("Not cached yet"), tone: "subtle", icon: "download", upper: false };
  }
  const chips: Json[] = [];
  if (stream.remux) chips.push({ text: "REMUX", style: "remux" });
  if (stream.releaseGroupNormalized) chips.push({ text: stream.releaseGroupNormalized, style: "group" });
  if (stream.edition) chips.push({ text: editionText(stream.edition), style: "accent" });

  let button: Json;
  let action: "play" | "cache" | null = "play";
  if (externalOnly) {
    button = { id: "primary", label: t("Open in browser"), style: "outline", icon: "external" };
  } else if (isCached) {
    button = {
      id: "primary",
      label: o.resolving ? t("Connecting") : o.inSession ? t("Play Together") : t("Play"),
      style: "ink",
      icon: "play",
      busy: o.resolving,
    };
  } else if (o.queued) {
    button = { id: "primary", label: `${t("Queued on")} ${queueTarget?.name ?? "debrid"}`, style: "green", icon: "check" };
    action = null;
  } else if (queueTarget) {
    button = {
      id: "primary",
      label: o.resolving ? t("Sending to TorBox") : t("Cache on {name}", { name: queueTarget.name }),
      style: "cache",
      icon: "download",
      busy: o.resolving,
    };
    action = "cache";
  } else if (canStream) {
    button = {
      id: "primary",
      label: o.resolving ? t("Connecting") : o.inSession ? t("Stream Together") : t("Stream"),
      style: "ink",
      icon: "play",
      busy: o.resolving,
    };
  } else {
    button = { id: "primary", label: t("Not cached"), style: "off" };
    action = null;
  }

  // Where it plays from (PlayProvenance).
  const logo = addonLogo(stream, o.addonLogo);
  let via: Json;
  if (stream.url) {
    via = { top: null, by: t("via"), addon: stream.addonName, logo };
  } else if (debrids.length === 0) {
    via = directStreamAvailable(stream)
      ? { top: t("Streams from peers"), tone: "muted", zap: false, by: t("found by"), addon: stream.addonName, logo }
      : { top: t("No debrid configured"), tone: "danger", zap: false, by: t("add one in settings · found by"), addon: stream.addonName, logo };
  } else {
    const target = debrids.find((d) => stream.cached[d.slug]) ?? debrids[0];
    via = {
      top: isCached ? t("plays via {name}", { name: target.name }) : t("uncached on debrid"),
      tone: "muted",
      zap: isCached,
      by: t("found by"),
      addon: stream.addonName,
      logo,
    };
  }

  return {
    action,
    pk: {
      type: "pick",
      img: hero ? [hero] : [],
      wide: !!landscape,
      logo: landscape && meta.logo ? meta.logo : null,
      badges: o.showBadges ? streamBadges(stream).map((k) => badge(k, "sm")) : [],
      flags: known.slice(0, 6).map((l) => flag(l, true)),
      moreFlags: known.length > 6 ? `+${known.length - 6} ${t("more")}` : null,
      noAudio: known.length === 0 ? t("Audio not labeled") : null,
      confirm: !episode ? confirmationLabel(meta, stream) : null,
      match: o.match ? { text: o.match === "same" ? t("Same file as host") : t("Close match to host"), style: o.match === "same" ? "accent" : "plain" } : null,
      title,
      file: fname && fname !== title ? fname : null,
      summary: streamSummaryParts(stream),
      status,
      chips,
      button,
      via,
      copy: link,
    },
  };
}

/** "Switch quality" (TierStrip) with the Cached / language pills. */
export function tiersBlock(o: {
  tiers: Tier[];
  selected: Tier | null;
  byTier: Partial<Record<Tier, ScoredStream>>;
  debrids: Debrids;
  cachedPill: { on: boolean; hidden: number } | null;
  langPill: { on: boolean; hidden: number; label: string } | null;
}): Json {
  const pills: Json[] = [];
  if (o.cachedPill) {
    pills.push({
      id: "cached",
      icon: "zap",
      on: o.cachedPill.on,
      label: o.cachedPill.on ? t("Cached only · +{n}", { n: o.cachedPill.hidden }) : t("Show all sources"),
    });
  }
  if (o.langPill) {
    const label = o.langPill.label;
    pills.push({
      id: "lang",
      icon: "lang",
      on: o.langPill.on,
      label: o.langPill.on ? t("{label} only · +{n}", { label, n: o.langPill.hidden }) : t("Show {label} only", { label }),
    });
  }
  return {
    type: "tiers",
    title: t("Switch quality"),
    infoTitle: t("Quality labels come from addons"),
    infoBody: t(
      "Each row's resolution badge is whatever the addon claimed. Some addons mislabel files: a 1080p or 4K tag on a brand-new theatrical release is often a CAM or TS rebadged. Harbor pushes obvious mismatches down the ranking, but if a top result looks suspicious, scroll the source list or pick the Theater Capture tier instead.",
    ),
    pills,
    tiers: o.tiers.map((tier) => {
      const stream = o.byTier[tier]!;
      const cachedHere = o.debrids.some((d) => stream.cached[d.slug]);
      const instant =
        (stream.url != null && !stream.infoHash && !hasUncachedMarker(stream)) || o.debrids.some((d) => stream.inLibrary[d.slug]);
      const size = stream.size != null ? formatSize(stream.size) : null;
      return {
        badge: badge(streamLeadBadge(stream, tier), "lg"),
        label: streamLeadLabel(stream, tier),
        status: `${instant ? "Instant" : cachedHere ? "Cached" : "Cache"} · ${size ?? "size unknown"}`,
        zap: instant ? "fill" : cachedHere ? "line" : null,
        on: o.selected === tier,
        dim: !cachedHere,
      };
    }),
  };
}

/** The drawer's button and, open, its addon pills (SourceDrawer). */
export function drawerBlock(o: {
  open: boolean;
  count: number;
  addonCount: number;
  usedAddons: Array<{ id: string; name: string; logo: string | null }>;
  filter: string;
  total: number;
  options: Array<{ id: string; name: string; count: number }>;
}): Json {
  return {
    type: "drawer",
    label: o.open ? t("Hide all sources") : t("All sources"),
    count: String(o.count),
    logos: o.usedAddons.slice(0, 5).map((a) => {
      const u = absUrl(a.logo ?? addonLogoSrc(a.id, a.name));
      return { img: u ? [u] : [], initial: a.name };
    }),
    addons: o.usedAddons.length > 0 ? (o.addonCount === 1 ? t("1 addon") : t("{n} addons", { n: o.addonCount })) : null,
    open: o.open,
    pills:
      o.options.length > 1
        ? [
            { id: "all", label: t("All"), count: String(o.total), on: o.filter === "all" },
            ...o.options.map((p) => ({ id: p.id, label: p.name, count: String(p.count), on: o.filter === p.id })),
          ]
        : [],
  };
}

/** Every source shown in the drawer, a line each (SourceRow). */
export function streamsBlock(o: {
  streams: ScoredStream[];
  debrids: Debrids;
  logoOf: (addonId: string) => string | null;
  matchFor?: (s: ScoredStream) => "same" | "close" | null;
  resolvingId: string | null;
  showName: string;
  episode?: PlayEpisode;
  showFilename: boolean;
}): Json {
  return {
    type: "streams",
    items: o.streams.map((s) => {
      const cachedDebrids = o.debrids.filter((d) => s.cached[d.slug]);
      const libraryDebrids = o.debrids.filter((d) => s.inLibrary[d.slug]);
      const external = !s.url && !s.infoHash && !!(s.externalUrl || s.ytId);
      const title = displayTitle(s, o.showName, o.episode);
      const fname = o.showFilename ? torrentFilename(s) : "";
      const langs = s.audioLanguages.filter((l) => l.toLowerCase() !== "unknown");
      const summary = streamSummaryParts(s);
      const match = o.matchFor ? o.matchFor(s) : null;
      const status = libraryDebrids.length > 0
        ? { text: `${t("In")} ${libraryDebrids.map((d) => d.name).join(" + ")}`, tone: "accent", icon: "zap" }
        : cachedDebrids.length > 0
          ? { text: `${t("Cached on")} ${cachedDebrids.map((d) => d.name).join(" + ")}`, tone: "muted", icon: "zap-line" }
          : external
            ? { text: t("External"), tone: "subtle", icon: "external" }
            : !s.url
              ? { text: o.debrids.length === 0 && s.infoHash ? t("Stream") : t("Cache"), tone: "subtle", icon: "download" }
              : null;
      return {
        badges: tierChipBadges(s).map((k) => badge(k, "md")),
        title,
        edition: s.edition ? editionText(s.edition) : null,
        file: fname && fname !== title ? fname : null,
        logo: { img: addonLogo(s, o.logoOf(s.addonId)), initial: s.addonName ?? "" },
        addon: contributorLabel(s),
        summary: summary.length > 0 ? summary.join(" · ") : null,
        flags: langs.slice(0, 4).map((l) => flag(l, false)),
        moreFlags: Math.max(0, langs.length - 4),
        match: match ? { text: match === "same" ? t("Same file") : t("Close match"), style: match === "same" ? "accent" : "plain" } : null,
        status,
        end: o.resolvingId !== null && s.infoHash === o.resolvingId ? "busy" : external ? "external" : "play",
        copy: resolveStreamLink(s),
      };
    }),
  };
}

/** "12 cached · 40 found across 3 sources" (SourceDiagnostic). */
export function diagBlock(result: NonNullable<PipelineResult>, debrids: Debrids, open: boolean): Json {
  const fromRaw: Stream[] = [...result.raw.library, ...result.raw.addon];
  const all: Stream[] = fromRaw.length > 0 ? fromRaw : result.picker.all;
  const m = new Map<string, number>();
  for (const s of all) {
    const key = s.addonName ?? s.addonId ?? "Unknown";
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  const counts = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((a, [, n]) => a + n, 0);
  const cached = result.picker.all.filter((s) => s.url != null || debrids.some((d) => s.cached[d.slug] || s.inLibrary[d.slug])).length;
  return {
    type: "diag",
    lead: `${cached} ${t("cached")}`,
    text: counts.length === 1 ? t("{n} found across 1 source", { n: total }) : t("{n} found across {count} sources", { n: total, count: counts.length }),
    open,
    more: [
      `${result.picker.all.length} ${t("kept after dedupe")}`,
      ...(counts.length === 0 ? [t("no sources returned anything")] : counts.map(([name, n]) => `${name} ${n}`)),
    ],
  };
}

/** Searching (CinematicLoader). */
export function loaderBlock(meta: Meta): Json {
  return { type: "loader", logo: meta.logo ? [meta.logo] : [], text: meta.name, caption: t("Searching streams") };
}

export type PanelAction = "library" | "streaming" | "showAll" | "wider";

/** The empty ladder's messages (PickerEmptyLadder), in its order, with what their buttons do. */
export function ladderPanels(o: {
  meta: Meta;
  result: PipelineResult;
  addonsSettled: boolean;
  pipelineDone: boolean;
  streamIds: string[] | null;
  debridCount: number;
  addonCount: number;
  allCount: number;
  rawCount: number;
  strictMode: boolean;
  forceShowAll: boolean;
  theatres: boolean;
}): Array<{ key: string; pk: Json; action: PanelAction | null }> {
  const out: Array<{ key: string; pk: Json; action: PanelAction | null }> = [];
  const ids = o.streamIds;
  const has = !!ids && ids.length > 0;
  const panel = (key: string, pk: Json, action: PanelAction | null) => out.push({ key, pk: { type: "panel", ...pk }, action });
  if (o.addonsSettled && !has) {
    panel(
      "pk-noid",
      {
        look: "dashed",
        body: "Harbor couldn't resolve a usable ID for this title. Add a TMDB key in Library settings or sign in to Stremio to broaden coverage.",
        button: { id: "panel", label: "Open Library settings", style: "ink", icon: "arrow" },
      },
      "library",
    );
  }
  if (o.addonsSettled && has && o.debridCount === 0 && o.allCount === 0) {
    panel(
      "pk-nodebrid",
      {
        look: "dashed",
        body: "No playable streams turned up, and no debrid is configured. Real-Debrid, TorBox, AllDebrid, Premiumize, or Debrid-Link will unlock raw torrent results. Some addons bake debrid in (Sootio, Comet/ElfHosted, MediaFusion/ElfHosted) and play without your own keys.",
        button: { id: "panel", label: "Set up a debrid", style: "ink", icon: "arrow" },
      },
      "streaming",
    );
  }
  if (o.addonsSettled && has && o.allCount === 0 && o.debridCount > 0 && o.rawCount === 0) {
    const anime = o.meta.id.startsWith("kitsu:") || o.meta.id.startsWith("mal:");
    // As the page words it (NoSourcesState): the app's page is not the desktop app.
    const isWeb = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
    const tip = anime
      ? "Anime sources are usually richer through Torrentio's anime config or AIOStreams. Make sure one is installed in Stremio."
      : isWeb
        ? "On the web, Harbor can only reach addons that allow browser access (Torrentio, TorBox, Cinemeta). For unreleased titles, no source typically exists yet."
        : "Try signing in to Stremio so Harbor can use your addon collection. Older or foreign titles often need Torrentio + a debrid addon to find anything.";
    panel(
      "pk-none",
      {
        look: "card",
        kicker: t("No source returned a stream"),
        title: o.addonCount === 1 ? t("Harbor queried 1 addon and got nothing back") : t("Harbor queried {n} addons and got nothing back", { n: o.addonCount }),
        titleSize: 28,
        body: tip,
        mono: `${t("Tried IDs:")} ${ids!.slice(0, 3).join(" · ")}${ids!.length > 3 ? ` · ${t("+{n} more", { n: ids!.length - 3 })}` : ""}`,
      },
      null,
    );
  }
  if (o.addonsSettled && has && o.allCount === 0 && o.debridCount > 0 && o.rawCount > 0 && o.theatres) {
    const art = o.meta.background || o.meta.poster;
    panel(
      "pk-theatres",
      {
        look: "art",
        art: art ? [art] : [],
        kicker: t("Not out yet"),
        title: o.meta.name,
        titleSize: 34,
        body: t("No clean release has surfaced yet. This may be too new. Harbor's filters dropped everything that came back as wrong-movie noise."),
        button: o.forceShowAll ? null : { id: "panel", label: t("Show everything anyway"), style: "outline" },
        note: o.forceShowAll ? t("Filters off · still empty") : null,
      },
      o.forceShowAll ? null : "showAll",
    );
  }
  if (o.addonsSettled && has && o.allCount === 0 && o.debridCount > 0 && o.rawCount > 0 && !o.theatres) {
    const strict = o.strictMode || !o.forceShowAll;
    panel(
      "pk-filtered",
      {
        look: "card",
        kicker: `${o.rawCount} ${t("sources · 0 made it through")}`,
        title: t("Strict filters dropped everything"),
        titleSize: 34,
        body: t("Harbor blocks suspicious files and mismatched releases by default. For older shows and unusual titles this is sometimes too tight."),
        pills: groupRejections(o.result?.rejected ?? []).slice(0, 4).map((g) => `${g.count} ${g.label}`),
        button: strict ? { id: "panel", label: t("Search wider"), style: "ink" } : null,
        note: strict ? null : t("Wide search · still empty"),
      },
      strict ? "wider" : null,
    );
  }
  if (o.pipelineDone && o.allCount > 0 && o.allCount <= 2) {
    const dropped = o.rawCount - o.allCount;
    const offer = dropped > 0 && !o.forceShowAll;
    panel(
      "pk-few",
      {
        look: "warn",
        title: o.allCount === 1 ? t("Only 1 source after filtering") : t("Only 2 sources after filtering"),
        body:
          (o.allCount === 1
            ? t("Clean releases for this title haven't surfaced yet. The result below may not match the title you're looking for, so confirm the filename and size before playing.")
            : t("Clean releases for this title are still scarce. Confirm the filename and size before playing.")) +
          (offer
            ? ` ${dropped === 1 ? t("Harbor dropped 1 suspicious or mismatched result.") : t("Harbor dropped {n} suspicious or mismatched results.", { n: dropped })}`
            : ""),
        button: offer ? { id: "panel", label: t("Show everything anyway"), style: "amber" } : null,
      },
      offer ? "showAll" : null,
    );
  }
  return out;
}

/** "Host is watching" (HostSourceBanner) as an action card. */
export function hostCard(source: SourceDescriptor): { title: string; sub: string | null; kicker: string } {
  const chips: string[] = [];
  if (source.resolution) chips.push(source.resolution);
  if (source.sizeBytes != null && source.sizeBytes > 0) chips.push(formatBytes(source.sizeBytes));
  if (source.durationSec != null && source.durationSec > 0) chips.push(formatRuntime(source.durationSec));
  return { kicker: t("Host is watching"), title: source.title ?? t("Unknown release"), sub: chips.length > 0 ? chips.join(" · ") : null };
}

const epCode = (e: PlayEpisode) => `S${e.imdbSeason ?? e.season}E${String(e.imdbEpisode ?? e.episode).padStart(2, "0")}`;

/** The full-screen steps (the page's modals), each with its buttons' ids. */
export const stages = {
  noSources(meta: Meta): Json {
    const title = meta.name ?? "this title";
    return {
      look: "dialog",
      kicker: "Harbor",
      title: t("No streaming sources yet"),
      titleSize: 24,
      body: `${t("Harbor needs at least one streaming source before it can play")} ${title}${t(". Pick one of the options below to get set up.")}`,
      bullets: [t("· Install a stream addon (Torrentio, Comet, MediaFusion)."), t("· Add a debrid key (TorBox, Real-Debrid, AllDebrid, Premiumize, Debrid-Link).")],
      buttons: [
        { id: "addons", label: t("Browse addons"), style: "ink" },
        { id: "settings", label: t("Open settings"), style: "secondary" },
        { id: "back", label: t("Back"), style: "link" },
      ],
    };
  },
  p2p(meta: Meta, stream: ScoredStream, remember: boolean): Json {
    const backdrop = meta.background || meta.poster;
    const meta2: string[] = [];
    if (stream.size != null) meta2.push(formatSize(stream.size));
    const summary = streamSummaryParts(stream).filter((p) => !/seed/i.test(p));
    if (summary.length > 0) meta2.push(summary.join(" · "));
    return {
      look: "art",
      backdrop: backdrop ? [backdrop] : [],
      title: t("Stream this via peer-to-peer?"),
      titleSize: 40,
      body: t("This source isn't cached on your debrid, so Harbor would pull it directly from peers. It can take a moment to start and may buffer on low-seed torrents."),
      box: {
        title: stream.parsedTitle || stream.title || stream.name || "This source",
        seeders: stream.seeders != null ? `${stream.seeders} ${t("seeders")}` : null,
        meta: meta2,
      },
      toggle: { label: t("Auto-play peer-to-peer sources from now on"), on: remember },
      buttons: [
        { id: "p2p", label: t("Stream via P2P"), style: "accent", icon: "radio" },
        { id: "cancel", label: t("Back to sources"), style: "glass", icon: "x" },
      ],
    };
  },
  connecting(meta: Meta, episode: PlayEpisode | undefined, attemptIdx: number, stub: boolean): Json {
    const backdrop = episode?.still || meta.background || meta.poster;
    return {
      look: "art",
      backdrop: backdrop ? [backdrop] : [],
      logo: meta.logo ? [meta.logo] : [],
      logoText: meta.name,
      line: episode
        ? `S${episode.imdbSeason ?? episode.season} · E${String(episode.imdbEpisode ?? episode.episode).padStart(2, "0")}${episode.name ? ` · ${episode.name}` : ""}`
        : null,
      spinner: attemptIdx > 0 ? `Trying source ${attemptIdx + 1}` : "Connecting",
      notice: stub ? "Last source wasn't actually cached on your debrid yet. Trying another." : null,
      cancel: { id: "cancel", label: t("Cancel") },
    };
  },
  debridDown(meta: Meta): Json {
    const backdrop = meta.background || meta.poster;
    return {
      look: "art",
      backdrop: backdrop ? [backdrop] : [],
      pill: { text: t("Debrid is down"), style: "danger" },
      title: t("Your debrid service can't process this right now."),
      titleSize: 44,
      body: t("Stremio hits the same wall when this happens. Real-Debrid, TorBox, AllDebrid and Premiumize all have brief outages where they stop returning links. Wait a few minutes and try again, or check the service's status page."),
      buttons: [
        { id: "retry", label: t("Try again"), style: "white" },
        { id: "back", label: t("Back"), style: "glass" },
      ],
    };
  },
  exhausted(meta: Meta, episode: PlayEpisode | undefined): Json {
    const title = meta.name ?? "this title";
    return {
      look: "dialog",
      kicker: "Harbor",
      title: t("We could not find a working stream"),
      titleSize: 24,
      body: `${t("Harbor checked every available source for")} ${title}${episode ? ` ${epCode(episode)}` : ""} ${t("and none of them played. The most common reasons:")}`,
      bullets: [
        t("· A debrid key (TorBox, Real-Debrid, etc.) is missing or expired."),
        t("· No stream addon is installed yet (Torrentio, MediaFusion, Comet)."),
        t("· This title is too new and no source has it cached yet."),
      ],
      buttons: [
        { id: "browse", label: t("Browse streams manually"), style: "ink" },
        { id: "exit", label: t("Exit"), style: "link" },
      ],
    };
  },
  saving(meta: Meta, episode: PlayEpisode | undefined, label: string | null): Json {
    const backdrop = episode?.still || meta.background || meta.poster;
    return {
      look: "art",
      backdrop: backdrop ? [backdrop] : [],
      check: true,
      title: t("Saving to Downloads"),
      titleSize: 30,
      sub: episode
        ? `${meta.name}  ·  S${episode.imdbSeason ?? episode.season} E${String(episode.imdbEpisode ?? episode.episode).padStart(2, "0")}`
        : meta.name,
      label,
      foot: t("Track progress on the Downloads tab"),
    };
  },
};
