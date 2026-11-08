/**
 * The anime page's lists from AniList. Jikan's public API (MyAnimeList's data) closed on
 * 1 October 2026, so its rows (airing now, the top lists, the decades, the genres, the hidden
 * gems) and the title look-ups ask AniList instead.
 *
 * AniList answers 30 requests a minute, so lists asked for at the same moment go as one request
 * (each list a named part of it), and answers are kept for six hours.
 */
import type { Meta } from "@/lib/cinemeta";
import { adultContentHidden, isAdultText } from "@/lib/addons-store/adult-filter";
import { animeFranchiseKey } from "@/lib/providers/jikan";
import { anilistRequest } from "./client";

type Media = {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; userPreferred: string | null };
  coverImage: { extraLarge: string | null; large: string | null } | null;
  format: string | null;
  averageScore: number | null;
  popularity: number | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  genres: string[] | null;
  description: string | null;
  trailer: { id: string | null; site: string | null } | null;
  isAdult: boolean | null;
  relations?: { edges: Array<{ relationType: string | null }> } | null;
};

const FIELDS =
  "id idMal title{romaji english userPreferred} coverImage{extraLarge large} format averageScore popularity " +
  "seasonYear startDate{year} genres description(asHtml:false) trailer{id site} isAdult";

/** One list: AniList's media arguments (GraphQL text), a page and its size. */
type Ask = { args: string; page: number; perPage: number; extra?: string };

type Waiting = { ask: Ask; resolve: (m: Media[]) => void; reject: (e: unknown) => void };

const waiting: Waiting[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * What one request carries. AniList refuses a query costing over 500 "complexity" points, and a
 * list costs about 23 (its fields, whatever its length); the item cap keeps answers small.
 */
const MAX_ITEMS = 500;
const MAX_PARTS = 18;

function flush() {
  flushTimer = null;
  if (waiting.length === 0) return;
  const batch: Waiting[] = [];
  let items = 0;
  while (waiting.length > 0 && batch.length < MAX_PARTS && items + waiting[0].ask.perPage <= MAX_ITEMS) {
    const w = waiting.shift()!;
    items += w.ask.perPage;
    batch.push(w);
  }
  if (batch.length === 0) batch.push(waiting.shift()!);
  if (waiting.length > 0) flushTimer = setTimeout(flush, 0);
  const query =
    "query{" +
    batch
      .map(
        (w, i) =>
          `p${i}:Page(page:${w.ask.page},perPage:${w.ask.perPage}){media(type:ANIME,${w.ask.args}){${FIELDS}${w.ask.extra ? " " + w.ask.extra : ""}}}`,
      )
      .join(" ") +
    "}";
  anilistRequest<Record<string, { media: Media[] | null } | null>>(query)
    .then((data) => batch.forEach((w, i) => w.resolve(data?.[`p${i}`]?.media ?? [])))
    .catch((e) => batch.forEach((w) => w.reject(e)));
}

/** Asks for one list; lists asked for within a few milliseconds of each other share a request. */
function ask(a: Ask): Promise<Media[]> {
  return new Promise((resolve, reject) => {
    waiting.push({ ask: a, resolve, reject });
    if (flushTimer == null) flushTimer = setTimeout(flush, 30);
  });
}

const CACHE_TTL = 6 * 60 * 60 * 1000;
const cache = new Map<string, { metas: Meta[]; t: number }>();
const inflight = new Map<string, Promise<Meta[]>>();

function plain(text: string | null): string | undefined {
  if (!text) return undefined;
  const s = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s || undefined;
}

function nameOf(m: Media): string {
  return m.title.english || m.title.userPreferred || m.title.romaji || "";
}

function yearOf(m: Media): number {
  return m.seasonYear ?? m.startDate?.year ?? 9999;
}

function toMeta(m: Media): Meta {
  const poster = m.coverImage?.extraLarge ?? m.coverImage?.large ?? undefined;
  const year = m.seasonYear ?? m.startDate?.year ?? null;
  return {
    id: m.idMal != null ? `mal:${m.idMal}` : `anilist:${m.id}`,
    type: m.format === "MOVIE" ? "movie" : "series",
    name: nameOf(m),
    poster,
    background: poster,
    description: plain(m.description),
    releaseInfo: year != null ? String(year) : undefined,
    imdbRating: m.averageScore != null ? (m.averageScore / 10).toFixed(1) : undefined,
    genres: m.genres ?? undefined,
    trailerStreams: m.trailer?.site === "youtube" && m.trailer.id ? [{ ytId: m.trailer.id }] : undefined,
  };
}

/**
 * The list as the page shows it: adult titles left out when they're hidden, one entry a
 * franchise (its first season, where the list has it, in the place the franchise first shows up),
 * no two entries with the same name.
 */
function toMetas(list: Media[]): Meta[] {
  const hideAdult = adultContentHidden();
  const items = list.filter((m) => nameOf(m) && !(hideAdult && (m.isAdult || isAdultText(m.title.english, m.title.romaji))));
  const groups = new Map<string, Media[]>();
  for (const m of items) {
    const fk = animeFranchiseKey(nameOf(m));
    const g = groups.get(fk);
    if (g) g.push(m);
    else groups.set(fk, [m]);
  }
  const out: Meta[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const m of items) {
    const fk = animeFranchiseKey(nameOf(m));
    const group = groups.get(fk);
    if (!group) continue;
    groups.delete(fk);
    const anchor = [...group].sort((x, y) => yearOf(x) - yearOf(y) || x.id - y.id)[0];
    const meta = toMeta(anchor);
    const nameKey = meta.name.trim().toLowerCase();
    if (seenIds.has(meta.id) || seenNames.has(nameKey)) continue;
    seenIds.add(meta.id);
    seenNames.add(nameKey);
    out.push(meta);
  }
  return out;
}

/** [opts.sfw]: adult titles left out even when the settings show them. */
function list(
  args: string,
  page: number,
  opts: {
    perPage?: number;
    extra?: string;
    keep?: (m: Media) => boolean;
    order?: (media: Media[]) => Media[];
    sfw?: boolean;
  } = {},
): Promise<Meta[]> {
  const perPage = opts.perPage ?? 25;
  const adult = opts.sfw || adultContentHidden() ? "isAdult:false," : "";
  const key = `${adult}${args}|${page}|${perPage}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return Promise.resolve(hit.metas);
  const running = inflight.get(key);
  if (running) return running;
  const p = ask({ args: adult + args, page, perPage, extra: opts.extra })
    .then((media) => {
      const kept = opts.keep ? media.filter(opts.keep) : media;
      const metas = toMetas(opts.order ? opts.order(kept) : kept);
      // An empty answer isn't kept: the next visit asks again.
      if (metas.length > 0) cache.set(key, { metas, t: Date.now() });
      return metas;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** AniList's names for the genre numbers the page keeps (MyAnimeList's, from Jikan's days). */
const GENRE_NAME: Record<number, string> = {
  1: "Action",
  2: "Adventure",
  4: "Comedy",
  7: "Mystery",
  8: "Drama",
  10: "Fantasy",
  14: "Horror",
  18: "Mecha",
  19: "Music",
  22: "Romance",
  24: "Sci-Fi",
  30: "Sports",
  36: "Slice of Life",
  37: "Supernatural",
  40: "Psychological",
  41: "Thriller",
};

/** Titles from now on enough lists to matter, best first (the decades, the genres). */
const KNOWN = "popularity_greater:10000,";

export const animeAiringNow = (page = 1) => list("status:RELEASING,sort:[POPULARITY_DESC]", page);
export const animeUpcoming = (page = 1) => list("status:NOT_YET_RELEASED,sort:[POPULARITY_DESC]", page);
export const animeTopRated = (page = 1) => list("sort:[SCORE_DESC]", page);
export const animeTopAiring = (page = 1) => list("status:RELEASING,sort:[SCORE_DESC]", page);
export const animeMostPopular = (page = 1) => list("sort:[POPULARITY_DESC]", page);
export const animeTopMovies = (page = 1) => list("format:MOVIE,sort:[SCORE_DESC]", page);
export const animeTopSeries = (page = 1) => list("format:TV,sort:[SCORE_DESC]", page);
export const animeNewReleases = (page = 1) =>
  list("status:RELEASING,averageScore_greater:60,sort:[START_DATE_DESC]", page);

export function animeByGenre(genreId: number, page = 1): Promise<Meta[]> {
  const name = GENRE_NAME[genreId];
  if (!name) return Promise.resolve([]);
  return list(`genre_in:[${JSON.stringify(name)}],${KNOWN}sort:[SCORE_DESC]`, page, { sfw: true });
}

/**
 * [start] / [end]: "YYYY-MM-DD"; whole years count (AniList keeps a date it only knows the year
 * of as YYYY0000).
 */
export function animeByEra(start: string, end: string, page = 1): Promise<Meta[]> {
  const from = Number(start.slice(0, 4)) || 1900;
  const to = Number(end.slice(0, 4)) || 2100;
  return list(`startDate_greater:${from * 10000 - 1},startDate_lesser:${(to + 1) * 10000},${KNOWN}sort:[SCORE_DESC]`, page, { sfw: true });
}

const SEQUEL_RX =
  /\b(?:1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th|Final|Last|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s+(?:Season|Cour|Part)\b|\bSeason\s+\d+\b|\bS\d+\b|\b(?:Part|Cour)\s+\d+\b|\s(?:II|III|IV|V|VI|VII|VIII|IX|X)$|\s\d+$/i;

/** Well-rated series few people have on their lists, first seasons only. */
export function animeHiddenGems(page = 1): Promise<Meta[]> {
  return list("format:TV,averageScore_greater:75,popularity_greater:5000,popularity_lesser:100000,sort:[SCORE_DESC]", page, {
    sfw: true,
    perPage: 50,
    extra: "relations{edges{relationType}}",
    keep: (m) =>
      !(m.relations?.edges ?? []).some((e) => e.relationType === "PREQUEL" || e.relationType === "PARENT") &&
      ![m.title.english, m.title.romaji].some((t) => t && SEQUEL_RX.test(t)),
  });
}

/** A name compared loosely: case, apostrophes and punctuation don't count. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The anime a title names, best match first ([] when there's none). Throws when AniList can't be
 * asked, so a caller can tell "no such anime" from "ask again later".
 */
export function animeSearchByTitle(title: string, limit = 1): Promise<Meta[]> {
  const q = title.trim();
  if (!q) return Promise.resolve([]);
  // A few more than asked for, then the best first: AniList's own first match is sometimes a
  // special or a later season. A title named exactly as asked comes first, then series and films
  // before specials; a franchise's seasons collapse into its first one.
  const want = Math.max(1, Math.min(limit, 10));
  const key = nameKey(q);
  const order = (media: Media[]) =>
    media
      .map((m, i) => {
        const exact = [m.title.english, m.title.romaji, m.title.userPreferred].some((t) => t && nameKey(t) === key);
        const main = m.format === "TV" || m.format === "MOVIE" || m.format === "TV_SHORT";
        return { m, rank: (exact ? 0 : 2) + (main ? 0 : 1), i };
      })
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.m);
  return list(`search:${JSON.stringify(q)},sort:[SEARCH_MATCH]`, 1, { perPage: Math.max(5, want), order }).then((m) =>
    m.slice(0, want),
  );
}

/** The MyAnimeList number of the anime a title names (null when there's none); throws offline. */
export async function animeMalIdByTitle(title: string): Promise<number | null> {
  const metas = await animeSearchByTitle(title, 1);
  const id = metas[0]?.id;
  return id?.startsWith("mal:") ? Number(id.slice(4)) || null : null;
}

/** What other screens need to know about one anime, by its MyAnimeList number. */
export type AnimeFacts = { titles: string[]; year?: number; score?: string };

type FactsMedia = {
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[] | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  averageScore: number | null;
};

const factsCache = new Map<number, AnimeFacts | null>();
const factsWaiting = new Map<number, Array<{ resolve: (f: AnimeFacts | null) => void; reject: (e: unknown) => void }>>();
let factsTimer: ReturnType<typeof setTimeout> | null = null;

function flushFacts() {
  factsTimer = null;
  const ids = [...factsWaiting.keys()].slice(0, 50);
  const waiting = ids.map((id) => [id, factsWaiting.get(id) ?? []] as const);
  for (const id of ids) factsWaiting.delete(id);
  if (factsWaiting.size > 0) factsTimer = setTimeout(flushFacts, 0);
  const query =
    `query{Page(perPage:50){media(type:ANIME,idMal_in:[${ids.join(",")}]){` +
    "idMal title{romaji english native} synonyms seasonYear startDate{year} averageScore}}}";
  anilistRequest<{ Page: { media: FactsMedia[] | null } | null }>(query)
    .then((data) => {
      const byId = new Map<number, FactsMedia>();
      for (const m of data?.Page?.media ?? []) if (m.idMal != null) byId.set(m.idMal, m);
      for (const [id, ws] of waiting) {
        const m = byId.get(id);
        const facts: AnimeFacts | null = m
          ? {
              titles: [m.title.english, m.title.romaji, ...(m.synonyms ?? []), m.title.native].filter(
                (t): t is string => !!t,
              ),
              year: m.seasonYear ?? m.startDate?.year ?? undefined,
              score: m.averageScore ? (m.averageScore / 10).toFixed(1) : undefined,
            }
          : null;
        factsCache.set(id, facts);
        for (const w of ws) w.resolve(facts);
      }
    })
    .catch((e) => {
      for (const [, ws] of waiting) for (const w of ws) w.reject(e);
    });
}

/**
 * An anime's names, year and AniList score, by its MyAnimeList number (null when AniList doesn't
 * have it). Asks made together go as one request. Throws when AniList can't be asked.
 */
export function animeFactsByMalId(malId: number): Promise<AnimeFacts | null> {
  if (factsCache.has(malId)) return Promise.resolve(factsCache.get(malId) ?? null);
  return new Promise((resolve, reject) => {
    const ws = factsWaiting.get(malId);
    if (ws) ws.push({ resolve, reject });
    else factsWaiting.set(malId, [{ resolve, reject }]);
    if (factsTimer == null) factsTimer = setTimeout(flushFacts, 30);
  });
}

/**
 * What AniList's members recommend after an anime (by its MyAnimeList number), best first; []
 * when AniList doesn't know it. Throws when AniList can't be asked.
 */
export async function animeRecommendationsForMalId(malId: number): Promise<Meta[]> {
  const query =
    `query{Media(idMal:${malId},type:ANIME){recommendations(sort:[RATING_DESC],perPage:12){nodes{` +
    `mediaRecommendation{${FIELDS}}}}}}`;
  try {
    const data = await anilistRequest<{
      Media: { recommendations: { nodes: Array<{ mediaRecommendation: Media | null }> | null } | null } | null;
    }>(query);
    const media = (data?.Media?.recommendations?.nodes ?? [])
      .map((n) => n.mediaRecommendation)
      .filter((m): m is Media => !!m);
    return toMetas(media);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
}
