import { isPhoneLayout } from "@/lib/platform";
import { ArrowRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { DoneStep } from "@/components/onboarding/done-step";
import { Dots } from "@/components/onboarding/dots";
import { LanguageStep } from "@/components/onboarding/language-step";
import { LayoutStep } from "@/components/onboarding/layout-step";
import { SplashStep } from "@/components/onboarding/splash-step";
import { StreamingStep } from "@/components/onboarding/streaming-step";
import { StremioStep } from "@/components/onboarding/stremio-step";
import { SubtitlesStep } from "@/components/onboarding/subtitles-step";
import { TmdbStep } from "@/components/onboarding/tmdb-step";
import { WelcomeStep } from "@/components/onboarding/welcome-step";
import { useT } from "@/lib/i18n";
import { useOnboarding } from "@/lib/onboarding";

type StepId = "splash" | "language" | "welcome" | "layout" | "tmdb" | "stremio" | "streaming" | "subtitles" | "done";
// The language comes first, so the rest of the setup is in the chosen one. The "layout" step
// compares two desktop home layouts; the phone app has its own layout, so the step is skipped there.
const STEPS: StepId[] = isPhoneLayout()
  ? ["splash", "language", "welcome", "tmdb", "stremio", "streaming", "subtitles", "done"]
  : ["splash", "language", "welcome", "layout", "tmdb", "stremio", "streaming", "subtitles", "done"];

// Where the setup is, for this session: choosing a language reloads the page (its content then
// comes in that language), and the setup must carry on from where it was, not start over.
const STEP_KEY = "harbor.onboarding.step";

function savedStep(): number {
  try {
    const v = Number(sessionStorage.getItem(STEP_KEY));
    return Number.isInteger(v) && v > 0 && v < STEPS.length ? v : 0;
  } catch {
    return 0;
  }
}

export function OnboardingModal() {
  const { onboarded, finishOnboarding } = useOnboarding();
  const t = useT();
  const [stepIdx, setStepIdx] = useState(savedStep);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    try {
      if (onboarded) sessionStorage.removeItem(STEP_KEY);
      else sessionStorage.setItem(STEP_KEY, String(stepIdx));
    } catch {
      /* not remembered: a reload starts the setup over */
    }
  }, [stepIdx, onboarded]);

  useEffect(() => {
    if (!onboarded) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [onboarded]);

  if (onboarded) return null;

  const step = STEPS[stepIdx];
  const isSplash = step === "splash";
  const next = () => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  const back = () => setStepIdx((i) => Math.max(i - 1, 0));
  const finish = () => {
    setClosing(true);
    setTimeout(finishOnboarding, 320);
  };

  // Phone app: full screen above the tab bar, scrollable body, buttons pinned to the bottom.
  const phone = isPhoneLayout();
  return (
    <div
      className={`fixed inset-0 ${phone ? "z-[250] bg-canvas" : "z-50 bg-canvas/85 backdrop-blur-md"} flex items-center justify-center ${
        closing ? "opacity-0 transition-opacity duration-300" : "animate-fade-in"
      }`}
    >
      <div
        className={`relative flex flex-col overflow-hidden ${
          phone
            ? "h-full w-full bg-elevated"
            : "w-[min(92vw,580px)] rounded-[28px] border border-edge-soft bg-elevated/95 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.6)]"
        } ${
          closing ? "scale-[0.97] opacity-0 transition-all duration-300" : "animate-modal-in"
        }`}
      >
        {!isSplash && (
          <button
            onClick={finish}
            aria-label={t("Skip setup")}
            className="absolute end-5 top-5 z-10 flex h-9 w-9 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-raised hover:text-ink"
          >
            <X size={17} />
          </button>
        )}

        {isSplash ? (
          <SplashStep onAdvance={next} />
        ) : (
          <>
            <div
              className={
                phone
                  ? "flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6 pt-16"
                  : "flex min-h-[440px] flex-col justify-center px-12 py-10"
              }
            >
              <div key={step} className="animate-step-in">
                {step === "language" && <LanguageStep />}
                {step === "welcome" && <WelcomeStep />}
                {step === "layout" && <LayoutStep />}
                {step === "tmdb" && <TmdbStep />}
                {step === "stremio" && <StremioStep />}
                {step === "streaming" && <StreamingStep />}
                {step === "subtitles" && <SubtitlesStep />}
                {step === "done" && <DoneStep />}
              </div>
            </div>

            <div
              className={
                phone
                  ? "flex shrink-0 flex-col gap-3 border-t border-edge-soft bg-canvas/60 px-5 pt-4"
                  : "flex items-center justify-between border-t border-edge-soft bg-canvas/40 px-8 py-5"
              }
              style={phone ? { paddingBottom: "calc(16px + env(safe-area-inset-bottom))" } : undefined}
            >
              <div className={phone ? "flex justify-center" : "contents"}>
                <Dots
                  count={STEPS.length - 1}
                  active={Math.max(stepIdx - 1, 0)}
                  onJump={(i) => setStepIdx(i + 1)}
                />
              </div>
              <div className={phone ? "flex items-center justify-between gap-2 [&>button:last-child]:ms-auto" : "flex items-center gap-2.5"}>
                {(step === "tmdb" || step === "stremio" || step === "streaming" || step === "subtitles") && (
                  <button
                    key={`skip-${step}`}
                    onClick={next}
                    className="animate-skip-in h-11 rounded-full px-4 text-[13px] font-medium text-ink-subtle transition-colors hover:text-ink"
                  >
                    {t("Skip for now")}
                  </button>
                )}
                {stepIdx > 1 && stepIdx < STEPS.length - 1 && (
                  <button
                    onClick={back}
                    className="h-11 rounded-full px-5 text-[14px] font-medium text-ink-muted transition-colors hover:text-ink"
                  >
                    {t("Back")}
                  </button>
                )}
                {stepIdx < STEPS.length - 1 ? (
                  <button
                    onClick={next}
                    className="flex h-11 items-center gap-2 rounded-full bg-ink px-6 text-[14px] font-semibold text-canvas transition-transform hover:scale-[1.03] active:scale-[0.97]"
                  >
                    {step === "welcome" ? t("Get Started") : t("Continue")}
                    <ArrowRight size={15} strokeWidth={2.4} className="dir-icon" />
                  </button>
                ) : (
                  <button
                    onClick={finish}
                    className="flex h-11 items-center gap-2 rounded-full bg-ink px-6 text-[14px] font-semibold text-canvas transition-transform hover:scale-[1.03] active:scale-[0.97]"
                  >
                    {t("Enter Harbor")}
                    <ArrowRight size={15} strokeWidth={2.4} className="dir-icon" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
