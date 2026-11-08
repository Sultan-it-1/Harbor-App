import { TriangleAlert } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useTogether } from "@/lib/together/provider";
import { useView } from "@/lib/view";

export function TogetherRelayBanner() {
  const { relayOutdated, closeModal } = useTogether();
  const { openSettings } = useView();
  const t = useT();
  if (!relayOutdated) return null;

  return (
    <div className="flex items-start gap-2.5 rounded-[14px] border border-edge-soft bg-elevated px-3.5 py-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
        <TriangleAlert size={12} strokeWidth={2.2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[12.5px] font-medium text-ink">
          {t("Relay outdated. Your self-hosted relay is running an older version.")}
        </span>
        <span className="text-[11.5px] leading-snug text-ink-muted">
          {t("Redeploy it to get the latest Watch Together fixes.")}
        </span>
        <button
          onClick={() => {
            closeModal();
            openSettings("relay");
          }}
          className="mt-1 w-fit rounded-lg border border-edge px-2.5 py-1 text-[11.5px] font-medium text-ink-muted transition-colors hover:bg-raised hover:text-ink"
        >
          {t("Open relay settings")}
        </button>
      </div>
    </div>
  );
}
