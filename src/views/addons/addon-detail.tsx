import { Check, Copy, Eye, EyeOff, ExternalLink, Loader2, Settings2, Star, Trash2, TrendingUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AddonLogo, resolveAddonLogo } from "@/components/addon-logo";
import { setActiveAddon } from "@/lib/active-addon";
import { manifestToConfigureUrl, manifestToShareUrl } from "@/lib/addon-store";
import { categorizeAddon, isAdultAddon, type ResolvedAddon } from "@/lib/addons-store/store";
import { addonSiteUrl, rateOnSiteUrl, risingEntryFor, useRising } from "@/lib/providers/stremio-addons";
import { useCommunity } from "@/lib/providers/stremio-addons-index";
import { openInstallerViewport } from "@/components/installer-viewport";
import { pushActivityHint } from "@/lib/discord/activity-hint";
import { isPhoneLayout, isWeb } from "@/lib/platform";
import { openUrl } from "@/lib/window";
import { useT } from "@/lib/i18n";
import { AddonDescription } from "./addon-description";
import { AddonDocumentation, useAddonDocumentation } from "./addon-documentation";
import { useView } from "@/lib/view";
import { logoJson, tagPills, useNativeAddonDetail } from "./use-native-addons";
import { categoryLabel } from "./addons-types";
import { idOf, nameOf, resourceLabels } from "./addons-utils";
import { DetailRail } from "./detail-rail";
import { TagRow } from "./tag-row";
import { useTapToConfirm } from "./use-tap-to-confirm";
import { uiLocale } from "@/lib/i18n/locale";

// Android app: single column that fits the screen (the desktop layout put a 220px logo next to
// the text and was wider than the phone, so the page scrolled sideways).
const PHONE = isPhoneLayout();

export function AddonDetail({
  nativeToast = null,
  resolved,
  related,
  recommended,
  installedIds,
  onOpen,
  onInstall,
  onInstallAddon,
  onUninstall,
  showToast,
}: {
  resolved: ResolvedAddon;
  related: ResolvedAddon[];
  recommended: ResolvedAddon[];
  installedIds: Set<string>;
  onOpen: (id: string) => void;
  onInstall: () => Promise<void>;
  onInstallAddon: (r: ResolvedAddon) => Promise<void>;
  onUninstall: () => Promise<void>;
  onInstallUrl: (rawUrl: string) => Promise<string | null>;
  showToast: (kind: "ok" | "error", text: string) => void;
  nativeToast?: { id: number; text: string } | null;
}) {
  const t = useT();
  const { topKind } = useView();
  const m = resolved.manifest;
  const c = resolved.curated;
  const isConfigurable =
    m?.behaviorHints?.configurable === true || m?.behaviorHints?.configurationRequired === true;
  const web = isWeb();
  const configureUrl = manifestToConfigureUrl(resolved.transportUrl);
  const stremioShareUrl = manifestToShareUrl(resolved.transportUrl, "stremio");

  const [copied, setCopied] = useState<"https" | "stremio" | null>(null);
  const [busy, setBusy] = useState<"install" | "remove" | null>(null);
  const [optimisticInstalled, setOptimisticInstalled] = useState<boolean | null>(null);
  const [manifestVisible, setManifestVisible] = useState(false);
  const confirmRemove = useTapToConfirm();
  const community = useCommunity(m?.id);
  const rising = useRising();
  const risingEntry = community ? risingEntryFor(rising, community) : null;
  const openRate = () => {
    if (!community) return;
    openUrl(rateOnSiteUrl(community.slug));
    showToast("ok", t("Opening stremio-addons.net in your browser to sign in and rate"));
  };

  useEffect(() => {
    setActiveAddon({ id: idOf(resolved), name: nameOf(resolved) });
    return () => setActiveAddon(null);
  }, [resolved]);

  const maskedManifestUrl = (() => {
    try {
      const u = new URL(resolved.transportUrl);
      return `${u.protocol}//${u.hostname}/…/manifest.json`;
    } catch {
      return "••••••••••••••••";
    }
  })();

  useEffect(() => {
    if (optimisticInstalled === null) return;
    if (resolved.installed === optimisticInstalled) setOptimisticInstalled(null);
  }, [resolved.installed, optimisticInstalled]);

  useEffect(() => {
    const addonName = nameOf(resolved);
    if (isAdultAddon(resolved))
      return pushActivityHint({ details: "Browsing the addon store", state: "Stremio addons" });
    const rawLogo = resolveAddonLogo(m?.logo, resolved.transportUrl);
    const largeImage = rawLogo && rawLogo.startsWith("https://") ? rawLogo : undefined;
    const shared = { largeImage, largeText: addonName };
    const hint =
      busy === "install"
        ? { details: `Installing ${addonName}`, ...shared }
        : { details: `Browsing ${addonName}`, state: "Stremio addon", ...shared };
    return pushActivityHint(hint);
  }, [resolved, m?.logo, busy]);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string; installed?: boolean }>).detail;
      if (!detail?.id) return;
      if (detail.id !== m?.id) return;
      if (typeof detail.installed === "boolean") setOptimisticInstalled(detail.installed);
    };
    window.addEventListener("harbor:addons-changed", onChange);
    return () => window.removeEventListener("harbor:addons-changed", onChange);
  }, [m?.id]);

  const installed =
    optimisticInstalled !== null ? optimisticInstalled : resolved.installed;

  const handleInstall = async () => {
    if (busy) return;
    setBusy("install");
    setOptimisticInstalled(true);
    try {
      await onInstall();
    } catch {
      setOptimisticInstalled(null);
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async () => {
    if (busy) return;
    // Touch screens have no hover: the first tap asks, the second one removes.
    if (PHONE && !confirmRemove.armed) {
      confirmRemove.arm();
      return;
    }
    confirmRemove.disarm();
    setBusy("remove");
    setOptimisticInstalled(false);
    try {
      await onUninstall();
    } catch {
      setOptimisticInstalled(null);
    } finally {
      setBusy(null);
    }
  };

  const stats: Array<[string, string]> = [
    [t("Version"), m?.version ?? "–"],
    [t("Resources"), resourceLabels(m?.resources ?? []).join(", ") || "–"],
    [t("Types"), (m?.types ?? []).join(", ") || "–"],
    [t("ID prefixes"), (m?.idPrefixes ?? []).slice(0, 3).join(", ") || "–"],
    [t("Catalogs"), String(m?.catalogs?.length ?? 0)],
    [t("P2P"), m?.behaviorHints?.p2p ? t("Yes") : t("No")],
  ];

  const copy = async (kind: "https" | "stremio") => {
    const text = kind === "stremio" ? stremioShareUrl : resolved.transportUrl;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
      showToast("ok", kind === "stremio" ? t("Stremio link copied") : t("Manifest URL copied"));
    } catch {
      showToast("error", t("Couldn't copy. Select the URL manually."));
    }
  };

  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [resolved.transportUrl]);

  // Android: the page drawn by the native screen (use-native-addons.ts), with the same buttons.
  const [descOpen, setDescOpen] = useState(false);
  useEffect(() => setDescOpen(false), [resolved.transportUrl]);
  const documentation = useAddonDocumentation(community?.slug);
  const logoUrl = resolveAddonLogo(m?.logo, resolved.transportUrl);
  const configure = () => openInstallerViewport(configureUrl, nameOf(resolved), logoUrl);
  // The native screen put the address on the clipboard itself.
  const copiedNatively = (kind: "https" | "stremio") => {
    setCopied(kind);
    setTimeout(() => setCopied(null), 1600);
    showToast("ok", kind === "stremio" ? t("Stremio link copied") : t("Manifest URL copied"));
  };
  const nativeButtons: Array<Record<string, unknown>> = [];
  if (busy === "remove") nativeButtons.push({ id: "busy", label: t("Removing"), style: "installed", busy: true });
  else if (busy === "install") nativeButtons.push({ id: "busy", label: t("Installing"), style: "busy", busy: true });
  else if (installed && confirmRemove.armed) nativeButtons.push({ id: "remove", label: t("Tap again to remove"), style: "danger", icon: "trash" });
  else if (installed) nativeButtons.push({ id: "remove", label: t("Installed"), style: "installed", icon: "check" });
  else if (isConfigurable) nativeButtons.push({ id: "configure", label: t("Configure & install"), style: "ink", icon: "settings" });
  else nativeButtons.push({ id: "install", label: t("Install"), style: "ink" });
  if (!installed && isConfigurable && !busy && !web) nativeButtons.push({ id: "install", label: t("Install default"), style: "soft" });
  if (installed && isConfigurable && !busy) nativeButtons.push({ id: "configure", label: t("Reconfigure"), style: "soft", icon: "settings" });
  nativeButtons.push({ id: "copy", label: copied === "https" ? t("Copied") : t("Copy URL"), style: "soft", icon: copied === "https" ? "check" : "copy", copy: resolved.transportUrl });
  nativeButtons.push({ id: "stremio", label: copied === "stremio" ? t("Copied") : t("stremio:// link"), style: "soft", icon: copied === "stremio" ? "check" : "external", copy: stremioShareUrl });
  if (community) {
    nativeButtons.push({ id: "rate", label: t("Rate"), style: "rate", icon: "star" });
    nativeButtons.push({ id: "site", label: t("On Stremio-Addons"), style: "soft", icon: "external" });
  }
  const nativeOn = useNativeAddonDetail({
    active: topKind === "addon-detail",
    resolved,
    installedIds,
    related,
    recommended,
    detail: {
      bg: m?.background ?? null,
      glow: !m?.background ? logoUrl : null,
      logo: logoJson(idOf(resolved), nameOf(resolved), logoUrl),
      stars: community ? community.stars.toLocaleString(uiLocale()) : null,
      eyebrow: `${c?.tags.includes("official") ? t("Official") : t("Community")} · ${categoryLabel(c?.category ?? categorizeAddon(resolved)) ?? t("Addon")}${m?.id ? ` · ${m.id}` : ""}`,
      name: nameOf(resolved),
      rising: risingEntry
        ? {
            text: risingEntry.recentStars === 1
              ? t("Rising · +{n} star in 24h", { n: risingEntry.recentStars })
              : t("Rising · +{n} stars in 24h", { n: risingEntry.recentStars }),
            tone: "rise",
            icon: "trend",
          }
        : null,
      desc: m?.description ?? null,
      descOpen,
      more: t("View more"),
      less: t("Show less"),
      buttons: nativeButtons,
      tags: tagPills(resolved, t),
    },
    warnings: c?.warnings ?? [],
    documentation,
    info: {
      title: t("Project information"),
      note: t("Pulled from manifest"),
      stats: stats.map(([label, value]) => ({ label, value })),
      urlLabel: t("Manifest URL"),
      url: manifestVisible ? resolved.transportUrl : maskedManifestUrl,
      reveal: manifestVisible ? t("Hide") : t("Reveal"),
      copy: manifestVisible ? (copied === "https" ? t("Copied") : t("Copy")) : null,
      hint: manifestVisible ? null : t("Hidden by default. Manifest paths often carry API keys (debrid tokens, OMDB keys, etc.) you don't want over a shoulder."),
      foot: t("Stremio addon, packaged into Harbor's catalog."),
      credit: `${t("Version and capabilities come straight from the addon's manifest. Ratings and categories come from the")} stremio-addons.net ${t("community API. Star, browse, and contribute on their site.")}`,
    },
    onTap: (what) => {
      if (what === "desc") return setDescOpen((v) => !v);
      if (what === "reveal") return setManifestVisible((v) => !v);
      if (what === "copyurl") return copiedNatively("https");
      if (what === "site") return openUrl("https://stremio-addons.net");
      const b = what.startsWith("btn:") ? what.slice(4) : "";
      if (b === "install") void handleInstall();
      else if (b === "remove") void handleUninstall();
      else if (b === "configure") configure();
      else if (b === "copy") copiedNatively("https");
      else if (b === "stremio") copiedNatively("stremio");
      else if (b === "rate") openRate();
      else if (b === "site" && community) openUrl(addonSiteUrl(community.slug));
    },
    onOpen,
    onInstallAddon,
    toast: nativeToast,
  });
  if (nativeOn) return <main className="h-full bg-canvas" />;

  return (
    <main
      ref={mainRef}
      className={`h-full overflow-y-auto ${PHONE ? "overflow-x-hidden px-5 pb-6 pt-20" : "px-12 pb-0 pt-24"}`}
    >
      <header
        className={`relative isolate flex items-start ${
          PHONE
            ? "-mx-5 -mt-20 flex-col gap-5 px-5 pt-24 pb-6"
            : "-mx-12 -mt-24 min-h-[460px] gap-10 px-12 pt-32 pb-10"
        }`}
      >
        <DetailHeaderBackdrop
          logo={resolveAddonLogo(m?.logo, resolved.transportUrl) ?? undefined}
          background={m?.background ?? undefined}
        />
        <div className="relative shrink-0">
          <AddonLogo
            addonId={idOf(resolved)}
            addonName={nameOf(resolved)}
            manifestLogo={resolveAddonLogo(m?.logo, resolved.transportUrl)}
            size={PHONE ? "2xl" : "4xl"}
          />
        </div>
        {community && (
          <button
            type="button"
            onClick={openRate}
            className={`absolute flex items-baseline gap-2 leading-none transition-opacity hover:opacity-80 ${
              PHONE ? "end-5 top-24" : "end-12 top-32"
            }`}
            title={t("Rate on stremio-addons.net")}
          >
            <Star
              size={22}
              strokeWidth={2.4}
              fill="currentColor"
              className="text-accent harbor-rating-star"
            />
            <span className={`${PHONE ? "text-[26px]" : "text-[32px]"} font-semibold tabular-nums leading-none text-ink`}>
              {community.stars.toLocaleString(uiLocale())}
            </span>
          </button>
        )}
        <div className={`relative flex min-w-0 flex-col gap-2 ${PHONE ? "w-full" : "flex-1"}`}>
          <span className={`text-[11px] font-bold uppercase text-ink-subtle ${PHONE ? "tracking-[0.2em]" : "tracking-[0.32em]"}`}>
            {c?.tags.includes("official") ? t("Official") : t("Community")} ·{" "}
            {categoryLabel(c?.category ?? categorizeAddon(resolved)) ?? t("Addon")}
            {m?.id && <> · <span className="break-all font-mono normal-case tracking-normal">{m.id}</span></>}
          </span>
          <h1 className={`font-display font-medium leading-tight tracking-tight text-ink ${PHONE ? "break-words text-[28px]" : "text-[36px]"}`}>
            {nameOf(resolved)}
          </h1>
          {risingEntry && (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 py-1 text-[11px] font-bold text-rose-300 ring-1 ring-rose-500/40">
              <TrendingUp size={12} strokeWidth={2.6} />
              {risingEntry.recentStars === 1
                ? t("Rising · +{n} star in 24h", { n: risingEntry.recentStars })
                : t("Rising · +{n} stars in 24h", { n: risingEntry.recentStars })}
            </span>
          )}
          {m?.description && <AddonDescription text={m.description} />}
          <div className={`mt-3 flex flex-wrap items-center ${PHONE ? "gap-2 [&>button]:px-4 [&>button]:text-[13px]" : "gap-2.5"}`}>
            {busy === "remove" ? (
              <button
                disabled
                className="flex h-11 items-center gap-2 rounded-full bg-elevated/60 px-5 text-[13.5px] font-semibold text-ink-muted ring-1 ring-edge-soft"
              >
                <Loader2 size={14} strokeWidth={2.4} className="animate-spin" />
                {t("Removing")}
              </button>
            ) : busy === "install" ? (
              <button
                disabled
                className="flex h-11 items-center gap-2 rounded-full bg-ink/85 px-5 text-[13.5px] font-semibold text-canvas/80"
              >
                <Loader2 size={14} strokeWidth={2.4} className="animate-spin" />
                {t("Installing")}
              </button>
            ) : installed && confirmRemove.armed ? (
              <button
                onClick={() => void handleUninstall()}
                className="flex h-11 items-center gap-2 rounded-full bg-danger/15 px-5 text-[13.5px] font-semibold text-danger ring-1 ring-danger/30"
              >
                <Trash2 size={14} strokeWidth={2.2} />
                {t("Tap again to remove")}
              </button>
            ) : installed ? (
              <button
                onClick={() => void handleUninstall()}
                className="group/pill flex h-11 items-center gap-2 rounded-full bg-elevated/70 px-5 text-[13.5px] font-semibold text-ink ring-1 ring-edge-soft transition-colors hover:bg-danger/15 hover:text-danger hover:ring-danger/30"
              >
                <Check size={14} strokeWidth={2.4} className="block text-accent group-hover/pill:hidden" />
                <Trash2 size={14} strokeWidth={2.2} className="hidden group-hover/pill:block" />
                <span className="block group-hover/pill:hidden">{t("Installed")}</span>
                <span className="hidden group-hover/pill:block">{t("Remove")}</span>
              </button>
            ) : isConfigurable ? (
              <button
                onClick={() => openInstallerViewport(configureUrl, nameOf(resolved), resolveAddonLogo(m?.logo, resolved.transportUrl))}
                className="flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-semibold text-canvas transition-opacity hover:opacity-90"
              >
                <Settings2 size={14} strokeWidth={2.2} />
                {t("Configure & install")}
              </button>
            ) : (
              <button
                onClick={() => void handleInstall()}
                className="flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-semibold text-canvas transition-opacity hover:opacity-90"
              >
                {t("Install")}
              </button>
            )}
            {!installed && isConfigurable && !busy && !web && (
              <button
                onClick={() => void handleInstall()}
                className="flex h-11 items-center gap-2 rounded-full border border-edge-soft px-5 text-[13.5px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
              >
                {t("Install default")}
              </button>
            )}
            {installed && isConfigurable && !busy && (
              <button
                onClick={() => openInstallerViewport(configureUrl, nameOf(resolved), resolveAddonLogo(m?.logo, resolved.transportUrl))}
                className="flex h-11 items-center gap-2 rounded-full border border-edge-soft px-5 text-[13.5px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
              >
                <Settings2 size={14} strokeWidth={2.2} />
                {t("Reconfigure")}
              </button>
            )}
            <button
              onClick={() => copy("https")}
              className="flex h-11 items-center gap-2 rounded-full border border-edge-soft px-5 text-[13.5px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
            >
              {copied === "https" ? <Check size={14} strokeWidth={2.4} /> : <Copy size={14} strokeWidth={2.2} />}
              {copied === "https" ? t("Copied") : t("Copy URL")}
            </button>
            <button
              onClick={() => copy("stremio")}
              className="flex h-11 items-center gap-2 rounded-full border border-edge-soft px-5 text-[13.5px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
            >
              {copied === "stremio" ? <Check size={14} strokeWidth={2.4} /> : <ExternalLink size={14} strokeWidth={2.2} />}
              {copied === "stremio" ? t("Copied") : t("stremio:// link")}
            </button>
            {community && (
              <>
                <span className="mx-1 h-6 w-px shrink-0 bg-edge-soft" aria-hidden />
                <button
                  onClick={openRate}
                  className="flex h-11 items-center gap-2 rounded-full border border-accent/40 bg-accent-soft px-5 text-[13.5px] font-semibold text-accent transition-colors hover:border-accent hover:bg-accent-soft/80"
                >
                  <Star size={14} strokeWidth={2.4} fill="currentColor" className="harbor-rating-star" />
                  {t("Rate")}
                </button>
                <button
                  onClick={() => openUrl(addonSiteUrl(community.slug))}
                  className="flex h-11 items-center gap-2 rounded-full border border-edge-soft ps-2 pe-5 text-[13.5px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
                >
                  <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-canvas ring-1 ring-edge-soft">
                    <img
                      src="https://stremio-addons.net/favicon.ico"
                      alt=""
                      draggable={false}
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </span>
                  {t("On Stremio-Addons")}
                </button>
              </>
            )}
          </div>
          <TagRow resolved={resolved} />
        </div>
      </header>

      {c?.warnings && c.warnings.length > 0 && (
        <section className="mt-8 rounded-2xl border border-amber-300/30 bg-amber-300/[0.06] p-5">
          <h3 className="text-[13.5px] font-semibold text-amber-200">{t("Worth knowing")}</h3>
          <ul className="mt-2 ms-1 list-disc ps-4 text-[13px] text-ink-muted">
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <section className={`bg-elevated/15 ${PHONE ? "-mx-5 px-5 py-8" : "-mx-12 px-12 py-12"}`}>
        <div className="mx-auto max-w-5xl">
          {community?.slug && <AddonDocumentation slug={community.slug} />}
          <div className="mb-8 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-display text-[22px] font-medium tracking-tight text-ink">
              {t("Project information")}
            </h2>
            <span className="text-[10.5px] uppercase tracking-[0.22em] text-ink-subtle">
              {t("Pulled from manifest")}
            </span>
          </div>
          <div className={`grid md:grid-cols-[1.1fr_1fr] ${PHONE ? "gap-8" : "gap-12"}`}>
            <dl className="border-y border-edge-soft">
              {stats.map(([label, value], i) => (
                <div
                  key={label}
                  className={`flex items-baseline justify-between gap-6 py-3 ${
                    i < stats.length - 1 ? "border-b border-edge-soft" : ""
                  }`}
                >
                  <dt className="text-[12px] uppercase tracking-[0.16em] text-ink-subtle">{label}</dt>
                  <dd className="truncate text-end text-[13.5px] font-medium text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] uppercase tracking-[0.16em] text-ink-subtle">
                  {t("Manifest URL")}
                </span>
                <div className="flex items-center gap-1.5">
                  {manifestVisible && (
                    <button
                      type="button"
                      onClick={() => void copy("https")}
                      className="flex h-7 items-center gap-1.5 rounded-full border border-edge-soft px-2.5 text-[11px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
                    >
                      {copied === "https" ? (
                        <Check size={11} strokeWidth={2.6} />
                      ) : (
                        <Copy size={11} strokeWidth={2.4} />
                      )}
                      {copied === "https" ? t("Copied") : t("Copy")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setManifestVisible((v) => !v)}
                    className="flex h-7 items-center gap-1.5 rounded-full border border-edge-soft px-2.5 text-[11px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
                    title={
                      manifestVisible
                        ? t("Hide the full URL")
                        : t("URLs can carry debrid keys or tokens; reveal when you need to copy")
                    }
                  >
                    {manifestVisible ? (
                      <EyeOff size={11} strokeWidth={2.4} />
                    ) : (
                      <Eye size={11} strokeWidth={2.4} />
                    )}
                    {manifestVisible ? t("Hide") : t("Reveal")}
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-edge-soft bg-canvas/60 p-4">
                <p className="break-all font-mono text-[12.5px] leading-relaxed text-ink-muted">
                  {manifestVisible ? resolved.transportUrl : maskedManifestUrl}
                </p>
              </div>
              {!manifestVisible && (
                <p className="text-[11.5px] leading-relaxed text-ink-subtle">
                  {t("Hidden by default. Manifest paths often carry API keys (debrid tokens, OMDB keys, etc.) you don't want over a shoulder.")}
                </p>
              )}
            </div>
          </div>
          <div className="mt-10 flex flex-col items-center gap-2 border-t border-edge-soft pt-6 text-center">
            <p className="text-[12px] text-ink-subtle">
              {t("Stremio addon, packaged into Harbor's catalog.")}
            </p>
            <p className="text-[11.5px] leading-relaxed text-ink-subtle">
              {t("Version and capabilities come straight from the addon's manifest. Ratings and categories come from the")}{" "}
              <button
                type="button"
                onClick={() => openUrl("https://stremio-addons.net")}
                className="inline-flex items-baseline gap-1 font-semibold text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                stremio-addons.net
              </button>{" "}
              {t("community API. Star, browse, and contribute on their site.")}
            </p>
          </div>
        </div>
      </section>

      <div className={`mx-auto w-full max-w-5xl ${PHONE ? "pb-24" : "pb-20"}`}>
        <DetailRail
          title={t("More like this")}
          items={related}
          installedIds={installedIds}
          onOpen={onOpen}
          onInstall={onInstallAddon}
        />
        <DetailRail
          title={t("Recommended for you")}
          items={recommended}
          installedIds={installedIds}
          onOpen={onOpen}
          onInstall={onInstallAddon}
        />
      </div>
    </main>
  );
}

function DetailHeaderBackdrop({
  logo,
  background,
}: {
  logo: string | undefined;
  background: string | undefined;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(135deg, var(--color-elevated) 0%, var(--color-canvas) 65%, var(--color-canvas) 100%)",
        }}
      />
      {background && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${background})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            opacity: 0.55,
          }}
        />
      )}
      {logo && !background && (
        <div
          className="absolute -inset-20"
          style={{
            backgroundImage: `url(${logo})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "blur(70px) saturate(1.5)",
            opacity: 0.28,
          }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          background: background
            ? "linear-gradient(95deg, var(--color-canvas) 0%, color-mix(in oklch, var(--color-canvas) 88%, transparent) 38%, color-mix(in oklch, var(--color-canvas) 60%, transparent) 62%, color-mix(in oklch, var(--color-canvas) 30%, transparent) 100%)"
            : "linear-gradient(180deg, color-mix(in oklch, var(--color-canvas) 0%, transparent) 0%, color-mix(in oklch, var(--color-canvas) 24%, transparent) 100%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, transparent 70%, color-mix(in oklch, var(--color-canvas) 28%, transparent) 100%)",
        }}
      />
    </div>
  );
}
