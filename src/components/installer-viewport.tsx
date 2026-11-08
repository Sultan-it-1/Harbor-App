import { ArrowUpRight, ChevronDown, ClipboardCopy, ExternalLink, ListOrdered, RotateCw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { installFromUrl } from "@/lib/addon-store";
import { isAdultText } from "@/lib/addons-store/adult-filter";
import { pushActivityHint } from "@/lib/discord/activity-hint";
import { clearPendingDeepLink } from "@/lib/deep-link";
import { androidApi, androidFetch, pushAndroidBackHandler } from "@/lib/android";
import { blocksFraming } from "@/lib/frame-policy";
import { isLinuxDesktop, isPhoneLayout, isWeb } from "@/lib/platform";
import { openUrl } from "@/lib/window";
import { HarborLoader } from "@/components/harbor-loader";
import { InstallOverlay } from "./installer-viewport/install-overlay";
import { Interpolate } from "@/components/interpolate";
import { t } from "@/lib/i18n/translate";

const EVENT = "harbor:open-installer";

// Android app: a phone-sized setup screen with plain steps (no clipboard button: the app has no
// business reading your clipboard; paste with a long-press in the field instead).
const PHONE = isPhoneLayout();

type InstallerDetail = { url: string; title?: string; logo?: string | null };

/** Phone: whether the "how to install" steps under the setup page are shown ("0" = hidden). */
const SETUP_STEPS_KEY = "harbor.addonSetupSteps";

export function openInstallerViewport(url: string, title?: string, logo?: string | null): void {
  if (typeof window === "undefined") return;
  // Linux: the in-page iframe can't capture the addon's stremio:// install link
  // (WebKitGTK refuses the scheme). Route through the Harbor Browser window, where
  // browser.rs intercepts the link and feeds it into the deep-link install bridge.
  if (isLinuxDesktop()) {
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("browser_open", { url }).catch(() => {
        window.__harborInstallerOpen = true;
        window.dispatchEvent(
          new CustomEvent<InstallerDetail>(EVENT, { detail: { url, title, logo } }),
        );
      });
    });
    return;
  }
  window.__harborInstallerOpen = true;
  window.dispatchEvent(
    new CustomEvent<InstallerDetail>(EVENT, { detail: { url, title, logo } }),
  );
}

const CLOSED_EVENT = "harbor:installer-closed";

/** The addon setup page is open over everything (a native screen steps aside for it). */
export function useInstallerOpen(): boolean {
  const [open, setOpen] = useState(() => typeof window !== "undefined" && !!window.__harborInstallerOpen);
  useEffect(() => {
    const on = () => setOpen(true);
    const off = () => setOpen(false);
    window.addEventListener(EVENT, on);
    window.addEventListener(CLOSED_EVENT, off);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener(CLOSED_EVENT, off);
    };
  }, []);
  return open;
}

export function InstallerViewportRoot() {
  const [request, setRequest] = useState<InstallerDetail | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<InstallerDetail>).detail;
      if (detail?.url) setRequest(detail);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
  if (!request) return null;
  return (
    <InstallerViewport
      url={request.url}
      title={request.title ?? new URL(request.url).hostname}
      logo={request.logo ?? null}
      onClose={() => setRequest(null)}
    />
  );
}

type Phase =
  | { kind: "idle" }
  | { kind: "installing"; name: string | null }
  | { kind: "success"; name: string; logo: string | null }
  | { kind: "error"; message: string };

const STREMIO_PROTO = "stremio://";

function normalizeInstallUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(STREMIO_PROTO)) {
    return "https://" + trimmed.slice(STREMIO_PROTO.length);
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return null;
}

function InstallerViewport({
  url,
  title,
  logo,
  onClose,
}: {
  url: string;
  title: string;
  logo: string | null;
  onClose: () => void;
}) {
  const [pasteValue, setPasteValue] = useState("");
  // Phone: the three "how to install" steps under the page can be hidden (and shown again);
  // the choice is remembered.
  const [stepsShown, setStepsShown] = useState(() => {
    try {
      return localStorage.getItem(SETUP_STEPS_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleSteps = () =>
    setStepsShown((v) => {
      try {
        localStorage.setItem(SETUP_STEPS_KEY, v ? "0" : "1");
      } catch {
        /* not remembered */
      }
      return !v;
    });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [loaded, setLoaded] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const successTimerRef = useRef<number | null>(null);
  const blockedTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    document.body.style.overflow = "hidden";
    window.__harborInstallerOpen = true;
    return () => {
      document.body.style.overflow = "";
      window.__harborInstallerOpen = false;
      window.dispatchEvent(new Event(CLOSED_EVENT));
    };
  }, []);

  useEffect(() => {
    if (isAdultText(url, title))
      return pushActivityHint({ details: "Setting up an addon", state: "Addon setup" });
    const label =
      phase.kind === "installing"
        ? `Installing ${title}`
        : phase.kind === "success"
          ? `Installed ${title}`
          : `Configuring ${title}`;
    const largeImage = logo && logo.startsWith("https://") ? logo : undefined;
    return pushActivityHint({ details: label, state: "Addon setup", largeImage, largeText: title });
  }, [url, title, logo, phase.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase.kind !== "installing") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, phase.kind]);

  useEffect(() => {
    blockedTimerRef.current = window.setTimeout(() => {
      if (!loaded) setBlocked(true);
    }, 7500);
    return () => {
      if (blockedTimerRef.current !== null) window.clearTimeout(blockedTimerRef.current);
    };
  }, [loaded, reloadKey]);

  // Android: many setup pages forbid being framed (X-Frame-Options / CSP frame-ancestors). The
  // frame then shows "Web page not available" and still reports "loaded", so ask the page's
  // headers first (the shell's fetch isn't limited by CORS) and skip the frame when it's refused.
  const [framingRefused, setFramingRefused] = useState(false);
  useEffect(() => {
    if (!PHONE || !androidApi()) return;
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 8000);
    setFramingRefused(false);
    androidFetch(url, { signal: ac.signal })
      .then((r) => {
        if (blocksFraming(r.headers)) setFramingRefused(true);
      })
      .catch(() => {
        /* offline or the page is down: let the frame show its own error */
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [url, reloadKey]);

  const submit = useCallback(
    async (rawUrl: string) => {
      const normalized = normalizeInstallUrl(rawUrl);
      if (!normalized) {
        setPhase({
          kind: "error",
          message: "Paste a stremio:// link or an https://…/manifest.json URL.",
        });
        return;
      }
      setPhase({ kind: "installing", name: null });
      try {
        const result = await installFromUrl(normalized);
        const name = result.addon.manifest.name ?? "Addon";
        const logo = result.addon.manifest.logo ?? null;
        const id = result.addon.manifest.id;
        setPhase({ kind: "success", name, logo });
        window.dispatchEvent(
          new CustomEvent("harbor:addons-changed", { detail: { id, installed: true } }),
        );
        successTimerRef.current = window.setTimeout(() => {
          onClose();
        }, 2000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Install failed.";
        setPhase({ kind: "error", message: msg });
      }
    },
    [onClose],
  );

  useEffect(() => {
    return () => {
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    };
  }, []);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const submitRef = useRef(submit);
  submitRef.current = submit;
  // Only the addon's own setup page (this iframe) may hand over a manifest: messages from any
  // other window (another frame, an ad inside the page, a popup) are ignored.
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // Android: the back gesture closes this screen and nothing else. It used to fall through to
  // the page underneath, which jumped to Home behind the setup screen, so the X then landed on
  // Home and a second back left the app. (While an install is running, back just waits.)
  useEffect(
    () =>
      pushAndroidBackHandler(() => {
        if (phaseRef.current.kind !== "installing") onClose();
        return true;
      }),
    [onClose],
  );

  useEffect(() => {
    const isBusy = () =>
      phaseRef.current.kind === "installing" || phaseRef.current.kind === "success";

    const onMessage = (e: MessageEvent) => {
      if (isBusy()) return;
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const data = e.data;
      if (!data) return;
      const candidate =
        typeof data === "string"
          ? data
          : typeof data?.url === "string"
            ? data.url
            : typeof data?.manifestUrl === "string"
              ? data.manifestUrl
              : null;
      if (!candidate) return;
      if (candidate.startsWith(STREMIO_PROTO) || candidate.includes("manifest.json")) {
        void submitRef.current(candidate);
      }
    };
    const onDeeplink = (e: Event) => {
      if (isBusy()) return;
      const detail = (e as CustomEvent<{ rawUrl: string }>).detail;
      const raw = detail?.rawUrl;
      if (!raw) return;
      clearPendingDeepLink();
      setPasteValue(raw);
      void submitRef.current(raw);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("harbor:deeplink-install", onDeeplink);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("harbor:deeplink-install", onDeeplink);
    };
  }, []);

  const readClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      setPasteValue(text);
      void submit(text);
    } catch {
      setPhase({
        kind: "error",
        message: "Clipboard access was blocked. Paste the link manually.",
      });
    }
  };

  const pageRefused = blocked || framingRefused;
  const dismissError = () => setPhase({ kind: "idle" });
  const reload = () => {
    setBlocked(false);
    setLoaded(false);
    setReloadKey((k) => k + 1);
  };

  return createPortal(
    <div className="fixed inset-0 z-[240] flex flex-col bg-black/82 backdrop-blur-md">
      <header
        data-tauri-drag-region
        className={`flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-canvas/60 text-ink backdrop-blur-md ${
          PHONE ? "px-4" : "px-5"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {logo && (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-elevated ring-1 ring-edge-soft">
              <img
                src={logo}
                alt=""
                draggable={false}
                className="h-full w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            </span>
          )}
          <span className={`truncate font-bold uppercase text-accent ${PHONE ? "text-[11px] tracking-[0.16em]" : "text-[10.5px] tracking-[0.24em]"}`}>
            {t("Setup ·")} {title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={reload}
            aria-label={t("Reload")}
            className={`flex h-9 items-center gap-1.5 rounded-full border border-edge-soft text-[12px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink ${
              PHONE ? "w-9 justify-center" : "px-3"
            }`}
          >
            <RotateCw
              size={12}
              strokeWidth={2.4}
              style={{
                transform: `rotate(${reloadKey * 360}deg)`,
                transition: "transform 0.6s cubic-bezier(0.22,0.61,0.36,1)",
              }}
            />
            {!PHONE && t("Reload")}
          </button>
          {!PHONE && (
            <button
              type="button"
              onClick={() => openUrl(url)}
              className="flex h-9 items-center gap-1.5 rounded-full border border-edge-soft px-3 text-[12px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
            >
              <ExternalLink size={12} strokeWidth={2.4} />
              {t("Open in browser")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
            disabled={phase.kind === "installing"}
            className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-elevated/60 hover:text-ink disabled:opacity-40"
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>
      </header>

      <div className="relative flex-1 overflow-hidden bg-white">
        {!loaded && !blocked && !framingRefused && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas">
            <HarborLoader size="lg" caption={`Loading ${title}`} />
          </div>
        )}
        {pageRefused && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
            <p className="text-[14px] font-semibold text-ink">
              {title} {t("can't open inside Harbor.")}
            </p>
            <p className="max-w-[44ch] text-[12.5px] leading-relaxed text-ink-muted">
              {PHONE
                ? t("This setup page doesn't allow being shown inside another app. Open it in your browser and set it up there. When you tap its Install button, choose Harbor if Android asks which app to use.")
                : t("Open it in a regular browser, set it up there, then come back and paste the install link below.")}
            </p>
            <button
              type="button"
              onClick={() => openUrl(url)}
              className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90"
            >
              <ArrowUpRight size={13} strokeWidth={2.4} />
              {t("Open in browser")}
            </button>
          </div>
        )}
        {!framingRefused && (
          <iframe
            ref={frameRef}
            key={reloadKey}
            src={url}
            title={title}
            onLoad={() => setLoaded(true)}
            className="h-full w-full border-0"
            referrerPolicy="strict-origin-when-cross-origin"
            allow={PHONE ? "clipboard-write; encrypted-media; fullscreen" : "clipboard-write; clipboard-read; encrypted-media; fullscreen"}
          />
        )}
        {(phase.kind === "installing" || phase.kind === "success") && (
          <InstallOverlay phase={phase} logo={logo} />
        )}
      </div>

      <footer
        className={`flex shrink-0 flex-col border-t border-white/10 bg-canvas/80 backdrop-blur-md ${
          PHONE ? "gap-3 px-4 pb-4 pt-3.5" : "gap-2.5 px-5 py-3.5"
        }`}
      >
        {PHONE && pageRefused ? (
          // The message above already says what to do; this is only the paste option.
          <p className="text-[12.5px] leading-snug text-ink-muted">
            {t("Already have the addon link? Paste it below (long-press the field, then Paste).")}
          </p>
        ) : PHONE ? (
          <>
            {stepsShown && (
            <ol className="flex flex-col gap-1.5 text-[12.5px] leading-snug text-ink-muted">
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">1</span>
                {/* "Install" stays English: it names the button on the addon's own (English) page. */}
                <span><Interpolate text={t("Set up the addon on the page above, then tap its {b1} button.")} values={{ b1: <b className="text-ink">Install</b> }} /></span>
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">2</span>
                <span><Interpolate text={t("Page not showing? Open it in your browser, set it up there, tap {b1} and choose {b2}.")} values={{ b1: <b className="text-ink">Install</b>, b2: <b className="text-ink">Harbor</b> }} /></span>
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">3</span>
                <span><Interpolate text={t("Or paste the addon link ({c1} or {c2}) below.")} values={{ c1: <span className="font-mono text-[11.5px]">stremio://…</span>, c2: <span className="font-mono text-[11.5px]">…/manifest.json</span> }} /></span>
              </li>
            </ol>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => openUrl(url)}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full border border-edge bg-elevated/70 text-[13.5px] font-semibold text-ink transition-colors hover:bg-elevated"
              >
                <ExternalLink size={14} strokeWidth={2.3} />
                {t("Open in browser")}
              </button>
              <button
                type="button"
                onClick={toggleSteps}
                aria-expanded={stepsShown}
                aria-label={stepsShown ? t("Hide the steps") : t("Show the steps")}
                title={stepsShown ? t("Hide the steps") : t("Show the steps")}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-edge bg-elevated/70 text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
              >
                {stepsShown ? <ChevronDown size={17} strokeWidth={2.3} /> : <ListOrdered size={17} strokeWidth={2.1} />}
              </button>
            </div>
          </>
        ) : (
          <p className="text-[12.5px] leading-snug text-ink-muted">
            {isWeb()
              ? t("Configure the addon above, then copy its manifest URL and paste it here. The web app can't catch the Install button automatically the way the desktop app does.")
              : t("Paste the manifest URL, or click Install on the addon's configuration page above.")}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(pasteValue);
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (text) {
                setPasteValue(text);
                window.setTimeout(() => void submit(text), 60);
              }
            }}
            placeholder="stremio://… or https://…/manifest.json"
            className={`min-w-0 flex-1 rounded-full border border-edge-soft bg-surface px-4 text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none ${
              PHONE ? "h-11 text-[14px]" : "h-10 text-[13px]"
            }`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={phase.kind === "installing" || phase.kind === "success"}
          />
          {!PHONE && (
            <button
              type="button"
              onClick={() => void readClipboard()}
              disabled={phase.kind === "installing" || phase.kind === "success"}
              className="flex h-10 items-center gap-1.5 rounded-full border border-edge-soft px-3.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink disabled:opacity-40"
            >
              <ClipboardCopy size={13} strokeWidth={2.2} />
              {t("From clipboard")}
            </button>
          )}
          <button
            type="submit"
            disabled={!pasteValue.trim() || phase.kind === "installing" || phase.kind === "success"}
            className={`flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 font-semibold text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${
              PHONE ? "h-11 text-[14px]" : "h-10 text-[13px]"
            }`}
          >
            <Sparkles size={13} strokeWidth={2.4} />
            {t("Install")}
          </button>
        </form>
        {phase.kind === "error" && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <span className="flex-1">{phase.message}</span>
            <button
              type="button"
              onClick={dismissError}
              className="font-semibold uppercase tracking-wider opacity-70 hover:opacity-100"
            >
              {t("Dismiss")}
            </button>
          </div>
        )}
      </footer>
    </div>,
    document.body,
  );
}
