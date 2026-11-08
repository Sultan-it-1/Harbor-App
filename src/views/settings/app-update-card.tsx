import { ArrowDownToLine, CheckCircle2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { androidApi } from "@/lib/android";
import { useT } from "@/lib/i18n";
import {
  cancelAndroidUpdate,
  checkAndroidUpdate,
  startAndroidUpdate,
  useAndroidUpdate,
} from "@/lib/updater/android-update";

/**
 * The Android app's updates, at the top of the Settings page: the installed version, a check for
 * a newer one (also made by itself now and then), and a one-tap update that downloads the new
 * version and opens Android's installer.
 */
export function AppUpdateCard() {
  const t = useT();
  const u = useAndroidUpdate();
  const [showNotes, setShowNotes] = useState(false);

  // Opening Settings looks for a new version (no more than every few hours by itself).
  useEffect(() => {
    void checkAndroidUpdate(false);
  }, []);

  if (!androidApi()) return null;

  const pct = u.total > 0 ? Math.min(100, Math.round((u.received / u.total) * 100)) : 0;
  const highlight = u.status === "available" || u.status === "permission" || u.status === "downloading" || u.status === "installing";

  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl p-4 ${
        highlight ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent)]" : "bg-elevated/60 shadow-[inset_0_0_0_1px_var(--color-edge-soft)]"
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            highlight ? "bg-accent text-canvas" : "bg-canvas/60 text-ink-subtle"
          }`}
        >
          {u.status === "uptodate" ? <CheckCircle2 size={20} strokeWidth={1.8} /> : <ArrowDownToLine size={20} strokeWidth={1.8} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold text-ink">
            {highlight && u.latest ? t("Harbor {version} available", { version: u.latest }) : t("Updates")}
          </p>
          <p className="text-[12.5px] text-ink-muted">
            {u.status === "checking"
              ? t("Checking…")
              : u.status === "uptodate"
                ? `${t("You're on the latest version.")} (${u.current})`
                : u.status === "error"
                  ? t("Couldn't check for updates.")
                  : highlight
                    ? t("You have {version}.", { version: u.current })
                    : `Harbor ${u.current}`}
          </p>
        </div>
        {(u.status === "idle" || u.status === "uptodate" || u.status === "error" || u.status === "checking") && (
          <button
            type="button"
            onClick={() => void checkAndroidUpdate(true)}
            disabled={u.status === "checking"}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-canvas/70 px-3 text-[12.5px] font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-edge-soft)] disabled:opacity-60"
          >
            {u.status === "checking" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} strokeWidth={2} />}
            {t("Check for updates")}
          </button>
        )}
      </div>

      {u.status === "error" && u.error && <p className="text-[12px] text-danger">{u.error}</p>}

      {highlight && u.notes && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setShowNotes((v) => !v)}
            className="w-fit text-[12.5px] font-semibold text-ink underline-offset-2 hover:underline"
          >
            {t("What's new")}
          </button>
          {showNotes && (
            <p className="max-h-48 overflow-y-auto whitespace-pre-line rounded-xl bg-canvas/50 p-3 text-[12.5px] leading-relaxed text-ink-muted">
              {u.notes}
            </p>
          )}
        </div>
      )}

      {u.status === "available" && (
        <button
          type="button"
          onClick={startAndroidUpdate}
          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-ink text-[14px] font-semibold text-canvas active:scale-[0.99]"
        >
          <ArrowDownToLine size={16} strokeWidth={2.2} />
          {t("Update")}
        </button>
      )}

      {u.status === "permission" && (
        <div className="flex flex-col gap-2">
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-muted">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" />
            {t("Allow Harbor to install updates (Android asks once), then come back: the update starts by itself.")}
          </p>
          <button
            type="button"
            onClick={startAndroidUpdate}
            className="flex h-11 items-center justify-center rounded-xl bg-ink text-[14px] font-semibold text-canvas"
          >
            {t("Allow")}
          </button>
        </div>
      )}

      {u.status === "downloading" && (
        <div className="flex flex-col gap-2">
          <div className="h-2 overflow-hidden rounded-full bg-canvas/60">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between text-[12px] text-ink-muted">
            <span>{t("Downloading… {pct}%", { pct })}</span>
            <button type="button" onClick={cancelAndroidUpdate} className="font-semibold text-ink">
              {t("Cancel")}
            </button>
          </div>
        </div>
      )}

      {u.status === "installing" && (
        <p className="flex items-center gap-2 text-[12.5px] text-ink-muted">
          <Loader2 size={14} className="animate-spin" />
          {t("Opening the installer… Tap Update there.")}
        </p>
      )}
    </div>
  );
}
