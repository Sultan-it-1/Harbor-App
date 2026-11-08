import { ArrowLeft, Check, Copy, Download, ImagePlus, Loader2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { setCustomThemePreview } from "@/lib/custom-themes";
import type { ThemePreset } from "@/lib/theme";
import type { LibraryEntry } from "./library-grid";
import { fileToPreviewDataUrl } from "./preview-image";
import { t } from "@/lib/i18n/translate";

export function LibraryBrowser({
  entries,
  activeId,
  onActivate,
  onExport,
  onDownload,
  onRemove,
  onClose,
  exportPanel,
}: {
  entries: LibraryEntry[];
  activeId: string;
  onActivate: (id: string) => void;
  onExport: (id: string) => void;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
  /** The theme code of a card's "Copy theme code", shown inside the library (it used to open on
   *  the settings page behind this full-screen view, so the tap seemed to do nothing). */
  exportPanel?: React.ReactNode;
}) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const builtIn = entries.filter((e) => e.category === "Built-in");
  const featured = entries.filter((e) => e.category === "Featured");
  const templates = entries.filter((e) => e.category === "Template");
  const yours = entries.filter((e) => e.category === "Yours");

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex flex-col bg-canvas"
      role="dialog"
      aria-label={t("Theme library")}
    >
      {/* Below 640px (the phone): 16px gutters and an arrow-only back button, so the title fits on one line. */}
      <header data-tauri-drag-region className="flex shrink-0 items-center justify-between gap-3 border-b border-edge-soft bg-surface/40 px-4 py-4 sm:gap-4 sm:px-10 sm:py-5">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Back to settings")}
            className="flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-full border border-edge-soft bg-canvas/60 text-[13px] font-semibold text-ink-muted transition-all hover:-translate-x-0.5 rtl:hover:translate-x-0.5 hover:border-edge hover:text-ink sm:w-auto sm:px-4"
          >
            <ArrowLeft size={15} strokeWidth={2.2} className="dir-icon" />
            <span className="hidden sm:inline">{t("Back to settings")}</span>
          </button>
          <div data-tauri-drag-region className="flex min-w-0 flex-col">
            <h1 className="pointer-events-none text-[24px] font-semibold tracking-tight text-ink">{t("Theme Library")}</h1>
            <p className="pointer-events-none text-[13px] text-ink-subtle">
              {entries.length} {t("themes. Click Apply on any card to use it.")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
        >
          <X size={18} strokeWidth={2.2} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-10 sm:py-10">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-12">
          {featured.length > 0 && (
            <BrowserSection title={t("Featured")} subtitle={t("Hand-picked reskins from the Harbor crew.")}>
              <BrowserGrid
                entries={featured}
                activeId={activeId}
                onActivate={onActivate}
                onExport={onExport}
                onDownload={onDownload}
                onRemove={onRemove}
              />
            </BrowserSection>
          )}

          {builtIn.length > 0 && (
            <BrowserSection title={t("Built-in")} subtitle={t("Ships with Harbor. Always available.")}>
              <BrowserGrid
                entries={builtIn}
                activeId={activeId}
                onActivate={onActivate}
                onExport={onExport}
                onDownload={onDownload}
                onRemove={onRemove}
              />
            </BrowserSection>
          )}

          {templates.length > 0 && (
            <BrowserSection title={t("Templates")} subtitle={t("Starting points to remix and save your own.")}>
              <BrowserGrid
                entries={templates}
                activeId={activeId}
                onActivate={onActivate}
                onExport={onExport}
                onDownload={onDownload}
                onRemove={onRemove}
              />
            </BrowserSection>
          )}

          {yours.length > 0 && (
            <BrowserSection title={t("Your themes")} subtitle={t("Themes you imported or built.")}>
              <BrowserGrid
                entries={yours}
                activeId={activeId}
                onActivate={onActivate}
                onExport={onExport}
                onDownload={onDownload}
                onRemove={onRemove}
              />
            </BrowserSection>
          )}
        </div>
      </div>
      {exportPanel && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-edge-soft bg-surface px-4 py-4 sm:px-10">
          <div className="mx-auto max-w-[1280px]">{exportPanel}</div>
        </div>
      )}
    </div>,
    document.body,
  );
}

function BrowserSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h3 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h3>
        <p className="text-[13px] text-ink-subtle">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function BrowserGrid({
  entries,
  activeId,
  onActivate,
  onExport,
  onDownload,
  onRemove,
}: {
  entries: LibraryEntry[];
  activeId: string;
  onActivate: (id: string) => void;
  onExport: (id: string) => void;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {entries.map((e) => (
        <BrowserCard
          key={e.theme.id}
          theme={e.theme}
          removable={e.removable}
          active={activeId === e.theme.id}
          onActivate={() => onActivate(e.theme.id)}
          onExport={() => onExport(e.theme.id)}
          onDownload={() => onDownload(e.theme.id)}
          onRemove={() => onRemove(e.theme.id)}
        />
      ))}
    </div>
  );
}

function BrowserCard({
  theme,
  removable,
  active,
  onActivate,
  onExport,
  onDownload,
  onRemove,
}: {
  theme: ThemePreset;
  removable: boolean;
  active: boolean;
  onActivate: () => void;
  onExport: () => void;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const hasImage = !!theme.previewImage;
  const bg = theme.background?.image ?? `linear-gradient(135deg, ${theme.swatch[0]}, ${theme.swatch[1]})`;
  const [busy, setBusy] = useState(false);
  const addImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setBusy(true);
      const url = await fileToPreviewDataUrl(f);
      if (url) setCustomThemePreview(theme.id, url);
      setBusy(false);
    };
    input.click();
  };
  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-2xl border transition-all ${
        active
          ? "border-accent shadow-[0_0_0_2px_var(--color-accent-soft),0_18px_40px_-22px_rgba(0,0,0,0.35)]"
          : "border-edge-soft bg-surface hover:border-edge"
      }`}
    >
      <div
        className="relative h-40 w-full"
        style={
          hasImage
            ? {
                backgroundImage: `url(${theme.previewImage})`,
                backgroundSize: "contain",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
                backgroundColor: theme.swatch[0],
              }
            : { background: bg }
        }
      >
        {active && (
          <span className="absolute end-3 top-3 flex h-7 items-center gap-1.5 rounded-full bg-accent px-2.5 text-[10.5px] font-bold uppercase tracking-[0.18em] text-canvas shadow-[0_4px_12px_-4px_rgba(0,0,0,0.4)]">
            <Check size={11} strokeWidth={3} /> {t("Active")}
          </span>
        )}
        <div className="absolute bottom-0 left-0 right-0 flex h-2">
          {theme.swatch.map((c, i) => (
            <span key={i} className="flex-1" style={{ background: c }} />
          ))}
        </div>
        {removable && !hasImage && (
          <button
            type="button"
            onClick={addImage}
            disabled={busy}
            className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-canvas/45 text-[12px] font-semibold text-ink-muted opacity-0 backdrop-blur-[1px] transition-opacity hover:text-ink group-hover:opacity-100"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} strokeWidth={1.9} />}
            {busy ? t("Adding") : t("Add image")}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[16px] font-semibold tracking-tight text-ink">{theme.name}</span>
          {theme.blurb && (
            <span className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-muted">{theme.blurb}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onActivate}
            disabled={active}
            className={`h-10 flex-1 rounded-xl text-[13px] font-semibold transition-opacity ${
              active
                ? "bg-elevated/70 text-ink ring-1 ring-edge"
                : "bg-ink text-canvas hover:opacity-90"
            }`}
          >
            {active ? t("Active") : t("Apply")}
          </button>
          <IconButton label={t("Copy theme")} onClick={onExport}>
            <Copy size={14} strokeWidth={2.2} />
          </IconButton>
          <IconButton label={t("Download")} onClick={onDownload}>
            <Download size={14} strokeWidth={2.2} />
          </IconButton>
          {removable && (
            <IconButton label={t("Remove")} onClick={onRemove} danger>
              <Trash2 size={14} strokeWidth={2.2} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-xl border border-edge-soft text-ink-muted transition-colors ${
        danger ? "hover:border-danger/40 hover:text-danger" : "hover:border-edge hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
