import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

export function resolveStreamLink(stream: { url?: string; externalUrl?: string }): string | null {
  return stream.url ?? stream.externalUrl ?? null;
}

export function CopyLinkButton({
  url,
  size = 13,
  className = "",
  label,
}: {
  url: string;
  size?: number;
  className?: string;
  label?: string;
}) {
  const t = useT();
  const resolvedLabel = label ?? t("Copy link");
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      title={copied ? t("Copied to clipboard") : resolvedLabel}
      aria-label={resolvedLabel}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          void copy();
        }
      }}
      className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors ${
        copied ? "text-accent" : "text-ink-subtle hover:bg-canvas/60 hover:text-ink"
      } ${className}`}
    >
      {copied ? (
        <Check size={size} strokeWidth={2.4} />
      ) : (
        <Copy size={size} strokeWidth={2} />
      )}
    </span>
  );
}
