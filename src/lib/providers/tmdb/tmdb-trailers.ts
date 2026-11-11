import { get } from "./tmdb-client";

export type Video = {
  key: string;
  site: string;
  type: string;
  official: boolean;
  name?: string;
  published_at?: string;
};

export const pickTrailerVideos = (videos: Video[]): Video[] => {
  const yt = videos.filter((v) => v.site === "YouTube");
  const ranked: Video[] = [
    ...yt.filter((v) => v.type === "Trailer" && v.official),
    ...yt.filter((v) => v.type === "Trailer" && !v.official),
    ...yt.filter((v) => v.type === "Teaser" && v.official),
    ...yt.filter((v) => v.type === "Teaser"),
    ...yt.filter((v) => v.type === "Clip" || v.type === "Featurette"),
  ];
  const seen = new Set<string>();
  const out: Video[] = [];
  for (const v of ranked) {
    if (!v.key || seen.has(v.key)) continue;
    seen.add(v.key);
    out.push(v);
  }
  return out;
};

export const pickTrailers = (videos: Video[]): string[] =>
  pickTrailerVideos(videos).map((video) => video.key);

const trailerRank = (video: Video): number => {
  const official = video.official ? 0 : 1;
  if (video.type === "Trailer") return official;
  if (video.type === "Teaser") return 2 + official;
  return 4;
};

/** Keep trailers before teasers and clips, newest first within each group. */
export const sortTrailerVideos = (videos: Video[]): Video[] =>
  [...videos].sort((a, b) => {
    const rank = trailerRank(a) - trailerRank(b);
    if (rank !== 0) return rank;
    const at = a.published_at ? Date.parse(a.published_at) : 0;
    const bt = b.published_at ? Date.parse(b.published_at) : 0;
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });

/** Merge already-ranked groups without letting a later group reorder an earlier one. */
export const mergeTrailerVideoGroups = (...groups: Video[][]): Video[] => {
  const seen = new Set<string>();
  const out: Video[] = [];
  for (const group of groups) {
    for (const video of group) {
      if (!video.key || seen.has(video.key)) continue;
      seen.add(video.key);
      out.push(video);
    }
  }
  return out;
};

// A long-running show can have dozens of seasons and each one is its own request. The
// trailer worth showing is nearly always for a recent season, so only the last few are asked.
export const TRAILER_SEASON_LIMIT = 3;

/** The seasons whose trailers are worth fetching: real seasons (not "Specials", number 0)
 *  that have episodes, newest last, at most TRAILER_SEASON_LIMIT of them. */
export function trailerSeasonNumbers(
  seasons: Array<{ season_number?: number; episode_count?: number }> | undefined | null,
): number[] {
  const numbers = Array.from(
    new Set(
      (Array.isArray(seasons) ? seasons : [])
        .map((season) => ({
          number: Number(season?.season_number),
          episodes: Number(season?.episode_count),
        }))
        .filter(
          (season) => Number.isInteger(season.number) && season.number > 0 && season.episodes > 0,
        )
        .map((season) => season.number),
    ),
  ).sort((a, b) => a - b);
  return numbers.slice(-TRAILER_SEASON_LIMIT);
}

/** One list of videos per season, in the order asked. A season that fails is just empty. */
export function tmdbSeasonVideos(
  key: string,
  tvId: string,
  seasonNumbers: number[],
): Promise<Array<{ seasonNumber: number; videos: Video[] }>> {
  return Promise.all(
    seasonNumbers.map(async (seasonNumber) => {
      const data = await get<{ results?: Video[] }>(
        key,
        `tv/${tvId}/season/${seasonNumber}/videos`,
      ).catch(() => null);
      return { seasonNumber, videos: data?.results ?? [] };
    }),
  );
}

export async function tmdbTrailerList(key: string, metaId: string): Promise<string[]> {
  if (!key) return [];
  const match = metaId.match(/^tmdb:(movie|tv):(\d+)$/);
  if (!match) return [];
  const [, kind, id] = match;
  if (kind === "tv") {
    // A show's own video list often stops at the first season's trailer; the trailer for
    // the season that is airing now lives under that season. One request brings the season
    // list together with the show's videos, then the recent seasons are asked in parallel.
    const show = await get<{
      seasons?: Array<{ season_number?: number; episode_count?: number }>;
      videos?: { results?: Video[] };
    }>(key, `tv/${id}`, { append_to_response: "videos" }).catch(() => null);
    const seasonVideos = await tmdbSeasonVideos(key, id, trailerSeasonNumbers(show?.seasons));
    const seasonPool = sortTrailerVideos(
      pickTrailerVideos(seasonVideos.flatMap((season) => season.videos)),
    );
    const showPool = sortTrailerVideos(pickTrailerVideos(show?.videos?.results ?? []));
    return mergeTrailerVideoGroups(seasonPool, showPool).map((video) => video.key);
  }
  const data = await get<{ results?: Video[] }>(key, `${kind}/${id}/videos`);
  return sortTrailerVideos(pickTrailerVideos(data?.results ?? [])).map((video) => video.key);
}

export async function tmdbTrailer(key: string, metaId: string): Promise<string | null> {
  const list = await tmdbTrailerList(key, metaId);
  return list[0] ?? null;
}
