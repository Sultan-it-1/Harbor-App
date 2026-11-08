
import { t } from "@/lib/i18n/translate";export function Dots({
  count,
  active,
  onJump,
}: {
  count: number;
  active: number;
  onJump: (i: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <button
          key={i}
          onClick={() => onJump(i)}
          aria-label={t("Step {v1}", { v1: i + 1 })}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i === active ? "w-9 bg-ink" : "w-1.5 bg-ink-subtle/40 hover:bg-ink-subtle"
          }`}
        />
      ))}
    </div>
  );
}
