import { isPhoneLayout } from "@/lib/platform";
import { useEffect, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import { useT } from "@/lib/i18n";
import { tmdbDiscover } from "@/lib/providers/tmdb";
import { rpdbPoster } from "@/lib/providers/rpdb";
import { useSettings } from "@/lib/settings";
import { useView } from "@/lib/view";
import { Row } from "./row";
import { Poster } from "./poster";

export type Lang = { iso: string; name: string; endonym: string; hue: number };

export const LANGS: Lang[] = [
  { iso: "ko", name: "Korean", endonym: "한국어", hue: 25 },
  { iso: "ja", name: "Japanese", endonym: "日本語", hue: 350 },
  { iso: "es", name: "Spanish", endonym: "Español", hue: 60 },
  { iso: "fr", name: "French", endonym: "Français", hue: 260 },
  { iso: "zh", name: "Chinese", endonym: "中文", hue: 10 },
  { iso: "hi", name: "Hindi", endonym: "हिन्दी", hue: 300 },
  { iso: "de", name: "German", endonym: "Deutsch", hue: 40 },
  { iso: "it", name: "Italian", endonym: "Italiano", hue: 145 },
  { iso: "pt", name: "Portuguese", endonym: "Português", hue: 130 },
  { iso: "tr", name: "Turkish", endonym: "Türkçe", hue: 200 },
  { iso: "sv", name: "Swedish", endonym: "Svenska", hue: 230 },
  { iso: "da", name: "Danish", endonym: "Dansk", hue: 0 },
  { iso: "no", name: "Norwegian", endonym: "Norsk", hue: 250 },
  { iso: "ru", name: "Russian", endonym: "Русский", hue: 340 },
  { iso: "pl", name: "Polish", endonym: "Polski", hue: 170 },
  { iso: "th", name: "Thai", endonym: "ไทย", hue: 320 },
  { iso: "nl", name: "Dutch", endonym: "Nederlands", hue: 80 },
  { iso: "ar", name: "Arabic", endonym: "العربية", hue: 165 },
];

const PHONE = isPhoneLayout();

/** [title]: the row's name when the page's editor renamed it. */
export function LanguageTiles({ title }: { title?: string } = {}) {
  const t = useT();
  return (
    <Row title={title ?? t("Browse by Language")} min={210} shape="tile" alwaysActive>
      {LANGS.map((l) => (
        <LanguageTile key={l.iso} lang={l} />
      ))}
    </Row>
  );
}

function LanguageTile({ lang }: { lang: Lang }) {
  const { settings } = useSettings();
  const { openFilter } = useView();
  const t = useT();
  const [backdrops, setBackdrops] = useState<Meta[]>([]);
  const from = `oklch(0.42 0.13 ${lang.hue})`;
  const to = `oklch(0.17 0.07 ${lang.hue})`;
  const ink = `oklch(0.96 0.02 ${lang.hue})`;

  useEffect(() => {
    let cancelled = false;
    tmdbDiscover(settings.tmdbKey, "tv", {
      with_original_language: lang.iso,
      sort_by: "popularity.desc",
      "vote_count.gte": "150",
    })
      .then((list) => {
        if (cancelled) return;
        setBackdrops(list.filter((m) => m.background).slice(0, 3));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lang.iso, settings.tmdbKey]);

  return (
    <button
      type="button"
      onClick={() =>
        openFilter({ kind: "language", mediaType: "tv", name: lang.name, iso: lang.iso })
      }
      className="group relative aspect-[5/4] w-full cursor-pointer overflow-hidden rounded-2xl border border-edge-soft text-start transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0.24,1)] hover:-translate-y-1"
      style={{ background: `linear-gradient(150deg, ${from}, ${to})` }}
    >
      {/* The box's height even where aspect-ratio isn't applied (old WebViews): its pictures and text sit over it. */}
      <span aria-hidden className="block" style={{ paddingTop: "80%" }} />
      <Collage backdrops={backdrops} rpdbKey={settings.rpdbKey} />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `linear-gradient(150deg, ${from} 0%, oklch(from ${from} l c h / 0.55) 60%, oklch(from ${to} l c h / 0.9) 100%)`,
          mixBlendMode: "multiply",
        }}
      />
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1/2"
        style={{ background: `linear-gradient(to bottom, transparent, ${to})` }}
      />
      <span
        className={`pointer-events-none absolute end-4 top-3 select-none font-display font-medium leading-none opacity-25 ${PHONE ? "text-[24px]" : "text-[34px]"}`}
        style={{ color: ink }}
        aria-hidden
      >
        {lang.endonym}
      </span>
      <div className={`absolute flex items-end justify-between ${PHONE ? "inset-x-3.5 bottom-3" : "inset-x-5 bottom-5"}`}>
        <h3
          className={`font-display font-medium leading-tight tracking-tight drop-shadow-[0_2px_18px_rgba(0,0,0,0.4)] ${PHONE ? "text-[18px]" : "text-[26px]"}`}
          style={{ color: ink }}
        >
          {t(lang.name)}
        </h3>
        <span
          className="dir-icon text-[18px] transition-transform duration-200 group-hover:translate-x-1 rtl:group-hover:-translate-x-1"
          style={{ color: ink }}
          aria-hidden
        >
          ›
        </span>
      </div>
    </button>
  );
}

function Collage({ backdrops, rpdbKey }: { backdrops: Meta[]; rpdbKey: string }) {
  if (backdrops.length === 0) return null;
  return (
    <div className="absolute inset-0 grid grid-cols-3">
      {backdrops.slice(0, 3).map((m, i) => (
        <div
          key={m.id}
          className="relative overflow-hidden"
          style={{ transform: `skewX(-8deg) translateX(${(i - 1) * 6}px)` }}
        >
          <Poster
            src={rpdbPoster(rpdbKey, m.id, m.background ?? m.poster)}
            seed={m.id}
            ratio="landscape"
            className="absolute inset-0 rounded-none [transform:skewX(8deg)_scale(1.4)]"
          />
        </div>
      ))}
    </div>
  );
}
