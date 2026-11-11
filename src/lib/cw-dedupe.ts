import { stripFranchiseSuffix } from "@/lib/providers/jikan";
import { readResumeEntry } from "@/lib/resume";
import { episodeFromVideoId, type LibraryItem } from "@/lib/stremio";

/** One viewing reaches several places (the Stremio library, a tracker's pause) seconds apart. */
const SAME_VIEWING_MS = 5 * 60_000;

/** The episode a card is on. An anime's own video id ("kitsu:1:5") has no season: it is season 1. */
function episodeOf(i: LibraryItem): { season?: number; episode?: number } {
  const vid = i.state?.video_id ?? "";
  const kitsuThreeSeg = /^(kitsu|mal|anilist|anidb):/.test(i._id) && vid.split(":").length === 3;
  const se = kitsuThreeSeg ? null : episodeFromVideoId(i.state?.video_id);
  return {
    season: i.state?.season ?? (kitsuThreeSeg ? 1 : se?.season),
    episode: i.state?.episode ?? (kitsuThreeSeg ? Number(vid.split(":")[2]) : se?.episode),
  };
}

function episodeRank(i: LibraryItem): number {
  const { season, episode } = episodeOf(i);
  return season != null && episode != null && season >= 1 && episode >= 1 ? season * 100_000 + episode : -1;
}

/** When it was really played. Not _mtime: that also moves for library upkeep. */
function playbackAt(i: LibraryItem): number {
  const lastWatched = Date.parse(i.state?.lastWatched ?? "");
  if (Number.isFinite(lastWatched) && lastWatched > 0) return lastWatched;
  const { season, episode } = episodeOf(i);
  return readResumeEntry(i._id, season, episode)?.t ?? 0;
}

function progressRatio(i: LibraryItem): number {
  const duration = i.state?.duration ?? 0;
  return duration > 0 ? Math.min(1, (i.state?.timeOffset ?? 0) / duration) : 0;
}

/** A library or local card knows the real length and has its artwork; a tracker's is an estimate. */
function sourceRank(i: LibraryItem): number {
  return i.external ? 0 : 1;
}

/** Is [incoming] the copy to show instead of [existing]? The most recently played one is; for
 *  the same viewing seen from two places, the later episode, then the copy with real numbers. */
export function isFurther(incoming: LibraryItem, existing: LibraryItem): boolean {
  const incomingAt = playbackAt(incoming);
  const existingAt = playbackAt(existing);
  if (Math.abs(incomingAt - existingAt) > SAME_VIEWING_MS) return incomingAt > existingAt;
  const incomingRank = episodeRank(incoming);
  const existingRank = episodeRank(existing);
  if (incomingRank !== existingRank) return incomingRank > existingRank;
  if (sourceRank(incoming) !== sourceRank(existing)) return sourceRank(incoming) > sourceRank(existing);
  if (incomingAt !== existingAt) return incomingAt > existingAt;
  return progressRatio(incoming) > progressRatio(existing);
}

/** A series arrives as series, anime, tv or channel depending on where it came from. */
function typeKey(type: string): string {
  return type === "series" || type === "anime" || type === "tv" || type === "channel" ? "series" : type;
}

export function itemIds(i: LibraryItem): string[] {
  return [i._id, ...(i.altIds ?? [])].filter(Boolean);
}

/** The kind of id: "tt", "tmdb:tv", "kitsu"... Two different ids of one kind are two titles. */
function idSpace(id: string): string {
  if (/^tt\d/.test(id)) return "tt";
  const parts = id.split(":");
  return parts[0] === "tmdb" && parts.length >= 3 ? `tmdb:${parts[1]}` : parts[0];
}

/** Type and name, for copies that share no id (a tracker's TMDB id, the library's IMDb id). A
 *  series loses its "Season 2" / "Part 2": anime sources keep every season as its own title. A
 *  movie keeps its name whole: "Rocky II" is not "Rocky". */
function nameKey(i: LibraryItem): string | null {
  const type = typeKey(i.type);
  const base = type === "series" ? stripFranchiseSuffix(i.name ?? "") : (i.name ?? "");
  const norm = base.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  // Too little left to tell titles apart by.
  if (norm.length < 3 || norm === "untitled") return null;
  return `${type}|${norm}`;
}

/** Same name is not enough when the ids or the years say otherwise. */
function contradicts(group: LibraryItem[], item: LibraryItem): boolean {
  const spaces = new Map<string, string>();
  for (const id of itemIds(item)) spaces.set(idSpace(id), id);
  for (const member of group) {
    if (member.year && item.year && member.year !== item.year) return true;
    for (const id of itemIds(member)) {
      const mine = spaces.get(idSpace(id));
      if (mine !== undefined && mine !== id) return true;
    }
  }
  return false;
}

/** What the survivor takes from a copy: its ids (so removing the card removes every copy), and
 *  artwork where it has none of its own (a tracker's card comes without). */
function withCopy(survivor: LibraryItem, copy: LibraryItem): LibraryItem {
  const altIds = [...new Set([...itemIds(survivor), ...itemIds(copy)])].filter((id) => id !== survivor._id);
  return {
    ...survivor,
    poster: survivor.poster ?? copy.poster,
    background: survivor.background ?? copy.background,
    altIds: altIds.length > 0 ? altIds : undefined,
  };
}

// The same title comes from the Stremio library, this device and the trackers, often under
// another id (IMDb here, TMDB or Kitsu there). One card for it: the most recently played copy.
// [absorbed] says which copies each card stands for, so removing the card can remove them all.
export function dedupeCwItems(
  items: LibraryItem[],
  limit: number,
): { items: LibraryItem[]; absorbed: Map<string, LibraryItem[]> } {
  const idIndex = new Map<string, number>();
  const nameIndex = new Map<string, number>();
  const out: LibraryItem[] = [];
  /** Per card: every copy as it came in, and which of them is the one on show. */
  const groups: LibraryItem[][] = [];
  const shown: LibraryItem[] = [];
  for (const item of items) {
    const key = nameKey(item);
    let index = itemIds(item)
      .map((id) => idIndex.get(id))
      .find((value) => value != null);
    if (index == null && key) {
      const byName = nameIndex.get(key);
      if (byName != null && !contradicts(groups[byName], item)) index = byName;
    }
    if (index == null) {
      if (out.length >= limit) continue;
      index = out.length;
      out.push(item);
      groups.push([item]);
      shown.push(item);
    } else {
      const replace = isFurther(item, shown[index]);
      out[index] = replace ? withCopy(item, out[index]) : withCopy(out[index], item);
      groups[index].push(item);
      if (replace) shown[index] = item;
    }
    for (const id of itemIds(out[index])) idIndex.set(id, index);
    if (key && !nameIndex.has(key)) nameIndex.set(key, index);
  }
  const absorbed = new Map<string, LibraryItem[]>();
  out.forEach((survivor, i) => {
    const copies = groups[i].filter((m) => m !== shown[i]);
    if (copies.length > 0) absorbed.set(survivor._id, copies);
  });
  return { items: out, absorbed };
}
