import { uiLocale } from "@/lib/i18n/locale";
export function formatAirDate(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.length === 10 ? `${value}T00:00:00Z` : value;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(uiLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatAirDateShort(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.length === 10 ? `${value}T00:00:00Z` : value;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(uiLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const DAY_MS = 86400000;

export function daysFromTodayLocal(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const air = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (Number.isNaN(air.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((air.getTime() - today.getTime()) / DAY_MS);
}
