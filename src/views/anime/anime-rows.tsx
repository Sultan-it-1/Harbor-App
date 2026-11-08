import type { AddonRow } from "@/lib/addons";
import type { Meta } from "@/lib/cinemeta";
import { GENRE } from "@/lib/providers/jikan";
import {
  animeAiringNow,
  animeByEra,
  animeByGenre,
  animeHiddenGems,
  animeMostPopular,
  animeTopAiring,
  animeTopMovies,
  animeTopSeries,
  animeUpcoming,
} from "@/lib/anilist/catalog";

export type RowPool = "general" | "era" | "genre";

export type Spec = {
  key: string;
  title: string;
  fetcher: (page: number) => Promise<Meta[]>;
  rank?: boolean;
  pool?: RowPool;
};

export const SPECS: Spec[] = [
  { key: "airing", title: "Airing Now", fetcher: animeAiringNow },
  { key: "top-airing", title: "Top Airing on AniList", fetcher: animeTopAiring, rank: true },
  { key: "upcoming", title: "Upcoming Season", fetcher: animeUpcoming },
  { key: "top-tv", title: "Top Series on AniList", fetcher: animeTopSeries, rank: true },
  { key: "top-movies", title: "Top Movies on AniList", fetcher: animeTopMovies },
  { key: "popular", title: "Most Popular on AniList", fetcher: animeMostPopular },
  { key: "gems", title: "Hidden Gems on AniList", fetcher: animeHiddenGems },
  {
    key: "era-2020s",
    title: "2020s Hits",
    pool: "era",
    fetcher: (p) => animeByEra("2020-01-01", "2029-12-31", p),
  },
  {
    key: "era-2010s",
    title: "2010s Classics",
    pool: "era",
    fetcher: (p) => animeByEra("2010-01-01", "2019-12-31", p),
  },
  {
    key: "era-2000s",
    title: "2000s Era",
    pool: "era",
    fetcher: (p) => animeByEra("2000-01-01", "2009-12-31", p),
  },
  {
    key: "era-1990s",
    title: "Foundation Years (90s)",
    pool: "era",
    fetcher: (p) => animeByEra("1990-01-01", "1999-12-31", p),
  },
  { key: "genre-action", title: "Action & Adventure", pool: "genre", fetcher: (p) => animeByGenre(GENRE.Action, p) },
  { key: "genre-romance", title: "Romance", pool: "genre", fetcher: (p) => animeByGenre(GENRE.Romance, p) },
  { key: "genre-slice", title: "Slice of Life", pool: "genre", fetcher: (p) => animeByGenre(GENRE.SliceOfLife, p) },
  { key: "genre-mecha", title: "Mecha", pool: "genre", fetcher: (p) => animeByGenre(GENRE.Mecha, p) },
  { key: "genre-fantasy", title: "Fantasy", pool: "genre", fetcher: (p) => animeByGenre(GENRE.Fantasy, p) },
  { key: "genre-scifi", title: "Sci-Fi", pool: "genre", fetcher: (p) => animeByGenre(GENRE.SciFi, p) },
  { key: "genre-psych", title: "Psychological", pool: "genre", fetcher: (p) => animeByGenre(GENRE.Psychological, p) },
  { key: "genre-horror", title: "Horror & Supernatural", pool: "genre", fetcher: (p) => animeByGenre(GENRE.Horror, p) },
];

export const HERO_KEYS = new Set(["airing", "top-airing", "upcoming", "popular"]);
export const TOP_PICKS_KEY = "top-airing";

export const ROW_MIN_VISIBLE = 12;
export const ROW_MAX_PAGES = 5;

export type RowState = { metas: Meta[]; page: number; hasMore: boolean; ready: boolean };

export const EMPTY_ROW: RowState = { metas: [], page: 1, hasMore: false, ready: false };

export function isAnimeRow(row: AddonRow): boolean {
  if (row.type === "anime") return true;
  const nameLower = (row.name ?? "").toLowerCase();
  if (/\b(anime|mal|anilist|kitsu|aniworld|crunchyroll|funimation)\b/.test(nameLower)) return true;
  const sample = row.metas.slice(0, 6);
  if (sample.length === 0) return false;
  const animeIds = sample.filter(
    (m) => m.id.startsWith("kitsu:") || m.id.startsWith("mal:") || m.id.startsWith("anilist:"),
  ).length;
  return animeIds / sample.length >= 0.5;
}

export function RowSkeleton({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="font-display text-[26px] font-medium text-ink/85">{title}</h2>
      </div>
      <div className="flex gap-5 overflow-hidden px-1">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex-shrink-0 animate-pulse rounded-2xl bg-elevated/60"
            style={{ width: 144, aspectRatio: "2 / 3", animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
