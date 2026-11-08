import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useDebridClients } from "@/lib/debrid/registry";
import type { PipelineResult } from "@/lib/streams/pipeline";
import type { Stream } from "@/lib/streams/types";
import { t } from "@/lib/i18n/translate";

export function SourceDiagnostic({
  result,
  debrids,
}: {
  result: PipelineResult;
  debrids: ReturnType<typeof useDebridClients>;
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = useMemo(() => {
    const fromRaw: Stream[] = [...result.raw.library, ...result.raw.addon];
    const all: Stream[] = fromRaw.length > 0 ? fromRaw : result.picker.all;
    const m = new Map<string, number>();
    for (const s of all) {
      const key = s.addonName ?? s.addonId ?? "Unknown";
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [result]);
  const totalRaw = counts.reduce((a, [, n]) => a + n, 0);
  const cachedTotal = result.picker.all.filter(
    (s) => s.url != null || debrids.some((d) => s.cached[d.slug] || s.inLibrary[d.slug]),
  ).length;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 self-start text-[12px] text-ink-subtle/80 transition-colors hover:text-ink-muted"
      >
        <span className="font-semibold text-ink-muted">{cachedTotal} {t("cached")}</span>
        <span className="text-ink-subtle/40">·</span>
        <span>
          {counts.length === 1
            ? t("{n} found across 1 source", { n: totalRaw })
            : t("{n} found across {count} sources", { n: totalRaw, count: counts.length })}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={2}
          className={`transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 ps-1 text-[11px] text-ink-subtle/70">
          <span>{result.picker.all.length} {t("kept after dedupe")}</span>
          <span className="text-ink-subtle/40">·</span>
          {counts.length === 0 ? (
            <span className="text-ink-subtle/60">{t("no sources returned anything")}</span>
          ) : (
            counts.map(([name, n], i) => (
              <span key={name} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="h-1 w-1 rounded-full bg-ink-subtle/40" />}
                <span>
                  {name} <span className="text-ink-subtle/45">{n}</span>
                </span>
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}
