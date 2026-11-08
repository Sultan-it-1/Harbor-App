import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

/** Shown when a critical localStorage write failed even after every cache was pruned. */
export function StorageFullToast() {
  const t = useT();
  const [show, setShow] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onFull = () => {
      setShow(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setShow(false), 8000);
    };
    window.addEventListener("harbor:storage-full", onFull);
    return () => {
      window.removeEventListener("harbor:storage-full", onFull);
      window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!show) return null;
  return (
    <div role="alert" className="phone-above-tabbar fixed inset-x-0 bottom-24 z-[130] flex justify-center px-4">
      <button
        type="button"
        onClick={() => setShow(false)}
        className="flex max-w-[420px] items-start gap-2.5 rounded-2xl border border-amber-400/30 bg-surface/98 px-4 py-3 text-start shadow-[0_24px_60px_-15px_rgba(0,0,0,0.75)] animate-popover-in"
      >
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-[12px] font-bold text-amber-300">
          !
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-ink">{t("Storage is full")}</span>
          <span className="text-[12px] leading-snug text-ink-muted">
            {t(
              "Harbor couldn't save a change (a sign-in or a setting), even after clearing its caches. Free some space on this device, then try again.",
            )}
          </span>
        </span>
      </button>
    </div>
  );
}
