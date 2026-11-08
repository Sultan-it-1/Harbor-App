import { Check } from "lucide-react";
import { setUiLanguage, useT, useUiLanguage } from "@/lib/i18n";
import type { UiLanguage } from "@/lib/i18n/languages";
import { useSettings } from "@/lib/settings";

const CHOICES: Array<{ id: UiLanguage; name: string; hint: string }> = [
  { id: "en", name: "English", hint: "English" },
  { id: "ar", name: "العربية", hint: "Arabic" },
];

/** The first setup screen: the app's language, so everything after it is in the chosen one. The
 *  heading is in both languages: whoever opens the app can read it. */
export function LanguageStep() {
  const t = useT();
  const { update } = useSettings();
  const current = useUiLanguage();
  const choose = (id: UiLanguage) => {
    setUiLanguage(id);
    update({ uiLanguage: id });
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-[30px] font-medium leading-tight tracking-tight text-ink">
          <span dir="ltr">Choose your language</span>
        </h2>
        <h2 className="font-display text-[30px] font-medium leading-tight tracking-tight text-ink" dir="rtl">
          اختر لغتك
        </h2>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-muted">{t("You can change it any time in Settings.")}</p>
      </div>
      <div className="flex flex-col gap-3" role="radiogroup">
        {CHOICES.map((c) => {
          const on = current === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(c.id)}
              className={`flex h-16 items-center justify-between gap-3 rounded-2xl border px-5 text-start transition-colors ${
                on ? "border-ink bg-ink/10" : "border-edge-soft bg-canvas/40 hover:border-edge"
              }`}
            >
              <span className="flex flex-col">
                <span className="text-[17px] font-semibold text-ink" dir={c.id === "ar" ? "rtl" : "ltr"}>
                  {c.name}
                </span>
                {c.hint !== c.name && <span className="text-[12px] text-ink-subtle">{c.hint}</span>}
              </span>
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  on ? "bg-ink text-canvas" : "border border-edge-soft"
                }`}
              >
                {on && <Check size={15} strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
