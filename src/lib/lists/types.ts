import type { Meta } from "@/lib/cinemeta";

export type ListSource = "mdblist" | "trakt" | "tmdb" | "letterboxd" | "imdb" | "mal" | "anilist";

export interface CustomList {
  id: string;
  name: string;
  source: ListSource;
  ref: string;
  addedAt: number;
}

export type ListItem = Meta;

export type ResolveResult = { title?: string; items: ListItem[] };

/** "mal-closed": a MyAnimeList user's list, which can't be read since Jikan closed (1 Oct 2026). */
export type ListErrorReason = "missing-key" | "not-found" | "network" | "unparseable" | "mal-closed";

export class ListResolveError extends Error {
  constructor(
    public reason: ListErrorReason,
    public source: ListSource,
  ) {
    super(`${source}: ${reason}`);
  }
}

export type ListKeys = { mdblistKey: string; tmdbKey: string };

export const SOURCE_LABELS: Record<ListSource, string> = {
  mdblist: "MDBList",
  trakt: "Trakt",
  tmdb: "TMDB",
  letterboxd: "Letterboxd",
  imdb: "IMDb",
  mal: "MyAnimeList",
  anilist: "AniList",
};

export function sourceLabel(source: ListSource): string {
  return SOURCE_LABELS[source];
}
