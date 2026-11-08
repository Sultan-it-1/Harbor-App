import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { Section, Segmented } from "./shared";

type Mode = "builtin" | "custom";

export type KeyInput = {
  id: string;
  /** Already translated. */
  label: string;
  secret?: boolean;
  required?: boolean;
};

const MODE_OPTIONS = [
  { value: "builtin", label: "Harbor's keys" },
  { value: "custom", label: "My own keys" },
] as const;

/** A value to copy into a form on another site: wraps on a phone instead of overflowing. */
export function CopyCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-canvas/70 px-1.5 py-0.5 font-mono text-[12px] text-ink ring-1 ring-edge-soft [overflow-wrap:anywhere]">
      {children}
    </code>
  );
}

/**
 * Lets the user pick which app a tracker signs in through: Harbor's built-in keys, or keys of an
 * app they registered themselves. A token only works with the app that issued it, so the choice
 * is locked while the account is connected.
 */
export function OwnKeysSection({
  subtitle,
  mode,
  saved,
  inputs,
  help,
  connected,
  onSave,
}: {
  subtitle: string;
  mode: Mode;
  saved: Record<string, string>;
  inputs: KeyInput[];
  help: ReactNode;
  connected: boolean;
  onSave: (mode: Mode, values: Record<string, string>) => void;
}) {
  const t = useT();
  const savedKey = JSON.stringify(saved);
  const [draftMode, setDraftMode] = useState<Mode>(mode);
  const [values, setValues] = useState<Record<string, string>>(saved);

  useEffect(() => setDraftMode(mode), [mode]);
  useEffect(() => setValues(JSON.parse(savedKey) as Record<string, string>), [savedKey]);

  const value = (id: string) => values[id] ?? "";
  const complete = inputs.every((i) => !i.required || value(i.id).trim());
  const savedComplete = inputs.every((i) => !i.required || (saved[i.id] ?? "").trim());
  const unchanged = inputs.every((i) => value(i.id).trim() === (saved[i.id] ?? "").trim());
  const active = mode === "custom" && unchanged;

  const pickMode = (next: Mode) => {
    setDraftMode(next);
    // Harbor's keys need nothing more; already-saved own keys switch back on straight away.
    if (next === "builtin" && mode !== "builtin") onSave("builtin", saved);
    if (next === "custom" && mode !== "custom" && savedComplete) onSave("custom", saved);
  };

  return (
    <Section title={t("API keys")} subtitle={subtitle}>
      {connected ? (
        <p className="rounded-xl border border-edge-soft bg-canvas/40 px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted">
          {mode === "custom" ? t("Signed in with your own app keys.") : t("Signed in with Harbor's keys.")}{" "}
          {t("Disconnect to change keys.")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <Segmented value={draftMode} options={MODE_OPTIONS} onChange={pickMode} />
          {draftMode === "custom" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-ink-muted">{help}</div>
              {inputs.map((i) => (
                <input
                  key={i.id}
                  type={i.secret ? "password" : "text"}
                  value={value(i.id)}
                  onChange={(e) => setValues((v) => ({ ...v, [i.id]: e.target.value }))}
                  placeholder={i.label}
                  aria-label={i.label}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-11 min-w-0 rounded-xl border border-edge bg-canvas px-3.5 font-mono text-[13px] text-ink outline-none focus:border-ink"
                />
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => onSave("custom", values)}
                  disabled={!complete || active}
                  className="flex h-10 items-center justify-center rounded-xl bg-ink px-5 text-[13px] font-semibold text-canvas transition-transform hover:scale-[1.01] disabled:opacity-50 disabled:hover:scale-100"
                >
                  {t("Save keys")}
                </button>
                {active ? (
                  <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-accent">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    {t("Your keys are in use.")}
                  </span>
                ) : (
                  <span className="text-[11.5px] text-ink-subtle">
                    {mode === "custom"
                      ? t("Save to use the new keys.")
                      : t("Until you save, Harbor's keys are used.")}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
