import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "@/lib/i18n/translate";
import { showHarborError } from "./error-view";

type State = { crashed: boolean };

export class HarborErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    showHarborError({
      fatal: true,
      code: error.name || "Crash",
      title: "Crash",
      message:
        error.message ||
        "Something blew up while rendering. Reload to recover, or send us the technical detail.",
      detail: [
        `${error.name}: ${error.message}`,
        "",
        error.stack ?? "(no stack)",
        "",
        "Component stack:",
        info.componentStack ?? "(none)",
      ].join("\n"),
    });
  }

  render() {
    if (this.state.crashed) return this.props.fallback ?? null;
    return this.props.children;
  }
}

/**
 * For the outermost boundary: everything inside it (the providers, and the ErrorView that would
 * explain a crash) is gone, so this stands alone: plain styles, no context, a Reload button.
 */
export function CrashScreen() {
  return (
    <div
      role="alert"
      style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24, background: "#111213", color: "#ececee", fontFamily: "system-ui, sans-serif", textAlign: "center" }}
    >
      <p style={{ fontSize: 16, fontWeight: 600, maxWidth: 360, lineHeight: 1.5 }}>{t("Harbor ran into a problem and couldn't show this screen. Reload to continue.")}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ minHeight: 44, padding: "0 22px", borderRadius: 999, border: "none", background: "#ececee", color: "#111213", fontSize: 15, fontWeight: 600 }}
      >
        {t("Reload")}
      </button>
    </div>
  );
}
