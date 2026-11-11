import type { Meta } from "@/lib/cinemeta";
import { MOVIE_GENRES, TV_GENRES } from "@/lib/feed/tags";
import { t } from "@/lib/i18n";
import { tmdbDiscover } from "@/lib/providers/tmdb";

export type ArabicRowDef = {
  id: string;
  titleKey: string;
  /** Values for the placeholders in the title ("Ramadan {year} Series"). */
  titleVars?: () => Record<string, string | number>;
  english: string;
  type: "movie" | "series";
  fetch: (key: string, page: number) => Promise<Meta[]>;
};

/** A row's title in the UI language, with its placeholders filled in. */
export function arabicRowTitle(def: ArabicRowDef): string {
  return t(def.titleKey, def.titleVars?.());
}

const ARABIC = "ar-SA";

// Where the Hijri calendar isn't available: 1 Ramadan 1447 (18 Feb 2026) and the mean lunar
// year, which is right to within a day or two.
const RAMADAN_1447_MS = Date.UTC(2026, 1, 18);
const LUNAR_YEAR_MS = 354.367 * 86_400_000;

let ramadanMemo: { day: string; year: number } | null = null;

/**
 * The Gregorian year the latest Ramadan began in: the season the "Ramadan series" row is about.
 * It changes on 1 Ramadan, not on 1 January.
 */
export function ramadanYear(): number {
  const now = new Date();
  const today = now.toDateString();
  if (ramadanMemo?.day === today) return ramadanMemo.year;
  let year: number | null = null;
  try {
    const fmt = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { month: "numeric", day: "numeric" });
    if (fmt.resolvedOptions().calendar === "islamic-umalqura") {
      // Walk back a month at a time to Ramadan (month 9), then to its first day.
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
      for (let hop = 0; hop < 14 && year == null; hop++) {
        const parts = fmt.formatToParts(d);
        const month = Number(parts.find((p) => p.type === "month")?.value);
        const day = Number(parts.find((p) => p.type === "day")?.value);
        if (!Number.isFinite(month) || !Number.isFinite(day)) break;
        if (month === 9) {
          d.setDate(d.getDate() - (day - 1));
          year = d.getFullYear();
        } else {
          d.setDate(d.getDate() - day);
        }
      }
    }
  } catch {
    /* no Hijri calendar here: the estimate below */
  }
  if (year == null) {
    const seasons = Math.floor((now.getTime() - RAMADAN_1447_MS) / LUNAR_YEAR_MS);
    year = new Date(RAMADAN_1447_MS + seasons * LUNAR_YEAR_MS).getUTCFullYear();
  }
  ramadanMemo = { day: today, year };
  return year;
}
const GULF_COUNTRIES = "SA|AE|KW|QA|BH|OM";

function arParams(extra: Record<string, string>): Record<string, string> {
  return {
    language: ARABIC,
    with_original_language: "ar",
    sort_by: "popularity.desc",
    ...extra,
  };
}

function trendingSince(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 18);
  return d.toISOString().slice(0, 10);
}

async function fetchRamadan(key: string, page: number): Promise<Meta[]> {
  // This season first, then the one before, page by page.
  const latest = ramadanYear();
  const years = [latest, latest - 1];
  const year = years[(page - 1) % years.length];
  const cycle = Math.floor((page - 1) / years.length) + 1;
  return tmdbDiscover(
    key,
    "tv",
    arParams({ first_air_date_year: String(year), page: String(cycle) }),
  );
}

async function fetchDrama(key: string, page: number): Promise<Meta[]> {
  return tmdbDiscover(
    key,
    "tv",
    arParams({ with_genres: String(TV_GENRES.Drama), page: String(page) }),
  );
}

async function fetchMovies(key: string, page: number): Promise<Meta[]> {
  return tmdbDiscover(key, "movie", arParams({ page: String(page) }));
}

async function fetchKhaleeji(key: string, page: number): Promise<Meta[]> {
  return tmdbDiscover(
    key,
    "tv",
    arParams({ with_origin_country: GULF_COUNTRIES, page: String(page) }),
  );
}

async function fetchComedy(key: string, page: number): Promise<Meta[]> {
  return tmdbDiscover(
    key,
    "movie",
    arParams({ with_genres: String(MOVIE_GENRES.Comedy), page: String(page) }),
  );
}

async function fetchTrending(key: string, page: number): Promise<Meta[]> {
  return tmdbDiscover(
    key,
    "movie",
    arParams({
      "vote_count.gte": "50",
      "primary_release_date.gte": trendingSince(),
      page: String(page),
    }),
  );
}

export const ARABIC_RAMADAN: ArabicRowDef = {
  id: "ramadan",
  titleKey: "arabic.row.ramadan",
  titleVars: () => ({ year: ramadanYear() }),
  get english() {
    return `Ramadan ${ramadanYear()} Series`;
  },
  type: "series",
  fetch: fetchRamadan,
};

export const ARABIC_DRAMA: ArabicRowDef = {
  id: "drama",
  titleKey: "arabic.row.drama",
  english: "Arabic Drama",
  type: "series",
  fetch: fetchDrama,
};

export const ARABIC_MOVIES: ArabicRowDef = {
  id: "movies",
  titleKey: "arabic.row.movies",
  english: "Arabic Movies",
  type: "movie",
  fetch: fetchMovies,
};

export const ARABIC_KHALEEJI: ArabicRowDef = {
  id: "khaleeji",
  titleKey: "arabic.row.khaleeji",
  english: "Gulf / Khaleeji",
  type: "series",
  fetch: fetchKhaleeji,
};

export const ARABIC_COMEDY: ArabicRowDef = {
  id: "comedy",
  titleKey: "arabic.row.comedy",
  english: "Arabic Comedy",
  type: "movie",
  fetch: fetchComedy,
};

export const ARABIC_TRENDING: ArabicRowDef = {
  id: "trending",
  titleKey: "arabic.row.trending",
  english: "Trending in Arabic",
  type: "movie",
  fetch: fetchTrending,
};
