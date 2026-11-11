import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { blockedTrackerCount, subscribeBlockedTrackers } from "@/lib/privacy/blocklist";
import { useSettings } from "@/lib/settings";
import { ToggleRow } from "./shared";
import { useT } from "@/lib/i18n";
import { uiLocale } from "@/lib/i18n/locale";

export function PrivacyRow() {
  const t = useT();
  const { settings, update } = useSettings();
  const [count, setCount] = useState(() => blockedTrackerCount());
  useEffect(() => subscribeBlockedTrackers(() => setCount(blockedTrackerCount())), []);

  // Accurate wording: Harbor sends no analytics of its own, but some features look things up
  // online by the title's id (skip-intro times), which the switch below controls.
  const sub = settings.blockTrackers
    ? count > 0
      ? t("{count} tracker request blocked this session. Harbor sends no analytics of its own.", { count: count.toLocaleString(uiLocale()) })
      : t("Watching for ad, analytics, and tracking requests. Harbor sends no analytics of its own.")
    : t("Ad, analytics, and tracking requests pass through untouched.");

  return (
    <>
      <ToggleRow
        label={t("Block ads & trackers")}
        sub={sub}
        leading={<ShieldCheck size={18} strokeWidth={2} className="text-ink-muted" />}
        value={settings.blockTrackers}
        onChange={(v) => update({ blockTrackers: v })}
      />
      <ToggleRow
        label={t("Look up intro and credits times")}
        sub={t("For the skip buttons, the title's IMDb/TMDB id, season and episode are sent to TheIntroDB, and anime episodes to AniSkip. Turn off to send nothing.")}
        value={settings.skipLookups !== false}
        onChange={(v) => update({ skipLookups: v })}
      />
    </>
  );
}
