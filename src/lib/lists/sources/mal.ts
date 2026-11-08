import { animeByMalId } from "@/lib/anilist/catalog";
import type { ListItem } from "../types";
import { ListResolveError } from "../types";

/**
 * A MyAnimeList link. These were read through Jikan, whose public API closed on 1 October 2026:
 * one anime (its number) now comes from AniList; a user's list can't be read any more, so the
 * error says how to bring it over (AniList imports MyAnimeList lists).
 */
export async function resolveMal(ref: string): Promise<ListItem[]> {
  if (!/^\d+$/.test(ref)) throw new ListResolveError("mal-closed", "mal");
  let items: ListItem[];
  try {
    items = await animeByMalId(Number(ref));
  } catch {
    throw new ListResolveError("network", "mal");
  }
  if (items.length === 0) throw new ListResolveError("not-found", "mal");
  return items;
}
