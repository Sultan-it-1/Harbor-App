import { X } from "lucide-react";
import { useEffect } from "react";
import { PHONE_TABBAR_H } from "@/chrome/phone-tabbar";
import { pushAndroidBackHandler } from "@/lib/android";
import { useT } from "@/lib/i18n";
import { CategorySidebar } from "./category-sidebar";

type SidebarProps = Parameters<typeof CategorySidebar>[0];

/**
 * Phone: the categories list opens over the channels instead of squeezing them into half of a
 * narrow screen. It closes on a pick, a tap outside, the X or the back gesture; the tab bar
 * underneath stays usable.
 */
export function CategoryDrawer({
  onClose,
  onSelect,
  ...rest
}: Omit<SidebarProps, "className" | "onSelect"> & {
  onSelect: SidebarProps["onSelect"];
  onClose: () => void;
}) {
  const t = useT();
  useEffect(
    () =>
      pushAndroidBackHandler(() => {
        onClose();
        return true;
      }),
    [onClose],
  );
  return (
    <div
      className="fixed inset-x-0 top-0 z-[170] flex bg-black/60"
      style={{ bottom: `calc(${PHONE_TABBAR_H}px + env(safe-area-inset-bottom))` }}
      onClick={onClose}
    >
      <div
        className="flex h-full w-[min(86vw,340px)] flex-col border-e border-edge bg-surface shadow-[0_0_40px_rgba(0,0,0,0.6)]"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-edge-soft/40 ps-4 pe-2">
          <span className="text-[15px] font-semibold text-ink">{t("Categories")}</span>
          <button
            type="button"
            aria-label={t("Close")}
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-full text-ink-muted active:bg-elevated"
          >
            <X size={18} />
          </button>
        </div>
        <CategorySidebar
          {...rest}
          className="min-h-0 w-full flex-1"
          onSelect={(g) => {
            onSelect(g);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
