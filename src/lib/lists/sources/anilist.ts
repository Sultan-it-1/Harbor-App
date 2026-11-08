import { animeListOfUser } from "@/lib/anilist/catalog";
import type { ListItem } from "../types";
import { ListResolveError } from "../types";

/** A user's public anime list on AniList ([ref] is the user name). */
export async function resolveAnilist(ref: string): Promise<ListItem[]> {
  try {
    return await animeListOfUser(ref);
  } catch (e) {
    const status = (e as { status?: number }).status;
    // No such user, or a profile that isn't public.
    if (status === 404 || status === 403) throw new ListResolveError("not-found", "anilist");
    throw new ListResolveError("network", "anilist");
  }
}
