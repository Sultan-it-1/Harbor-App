import { Check, Loader2, Plus, Settings2, X } from "lucide-react";
import { useState } from "react";
import type { ResolvedAddon } from "@/lib/addons-store/store";
import { useT } from "@/lib/i18n";
import { isPhoneLayout } from "@/lib/platform";
import { withMinDuration } from "./addons-utils";
import { useTapToConfirm } from "./use-tap-to-confirm";

// Touch screens have no hover to reveal "Remove", so a tap on "Installed" asks first.
const PHONE = isPhoneLayout();

const MIN_INSTALL_FEEDBACK_MS = 650;

export function InstallPill({
  resolved,
  installed,
  onInstall,
  onUninstall,
  onOpen,
}: {
  resolved: ResolvedAddon;
  installed: boolean;
  onInstall: () => void | Promise<void>;
  onUninstall: () => void | Promise<void>;
  onOpen: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const confirm = useTapToConfirm();

  const runInstall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await withMinDuration(onInstall(), MIN_INSTALL_FEEDBACK_MS);
    } finally {
      setBusy(false);
    }
  };

  const runUninstall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    if (PHONE && !confirm.armed) {
      confirm.arm();
      return;
    }
    confirm.disarm();
    setBusy(true);
    try {
      await withMinDuration(onUninstall(), 450);
    } finally {
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <button
        disabled
        className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-ink/80 px-5 text-[13.5px] font-semibold text-canvas transition-transform duration-150"
      >
        <Loader2 size={14} strokeWidth={2.4} className="animate-spin" />
        {t("Installing")}
      </button>
    );
  }

  if (installed && confirm.armed) {
    return (
      <button
        onClick={runUninstall}
        className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-danger/15 px-4 text-[13px] font-semibold text-danger ring-1 ring-danger/30 transition-all duration-150 ease-out active:scale-[0.96]"
      >
        <X size={14} strokeWidth={2.6} />
        {t("Tap again to remove")}
      </button>
    );
  }
  if (installed) {
    return (
      <button
        onClick={runUninstall}
        className="group/pill flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-elevated/70 px-5 text-[13.5px] font-semibold text-ink ring-1 ring-edge-soft transition-all duration-150 ease-out hover:bg-danger/15 hover:text-danger hover:ring-danger/30 active:scale-[0.96]"
      >
        <Check size={14} strokeWidth={2.6} className="block text-accent group-hover/pill:hidden" />
        <X size={14} strokeWidth={2.6} className="hidden group-hover/pill:block" />
        <span className="block group-hover/pill:hidden">{t("Installed")}</span>
        <span className="hidden group-hover/pill:block">{t("Remove")}</span>
      </button>
    );
  }
  const hints = resolved.manifest?.behaviorHints;
  const needsConfigure = hints?.configurable === true || hints?.configurationRequired === true;
  if (needsConfigure) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-ink px-5 text-[13.5px] font-semibold text-canvas transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.96]"
      >
        <Settings2 size={14} strokeWidth={2.2} />
        {t("Set up")}
      </button>
    );
  }
  return (
    <button
      onClick={runInstall}
      className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-ink px-5 text-[13.5px] font-semibold text-canvas transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.96]"
    >
      <Plus size={14} strokeWidth={2.6} />
      {t("Install")}
    </button>
  );
}
