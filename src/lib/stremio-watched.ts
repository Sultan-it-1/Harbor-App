import type { Meta } from "./cinemeta";
import type { LibraryItem } from "./stremio";

type CinemetaVideo = NonNullable<Meta["videos"]>[number];

export async function decodeWatchedEpisodes(
  watchedField: string | null | undefined,
  videos: CinemetaVideo[] | undefined,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!watchedField || !videos || videos.length === 0) return keys;
  const parts = watchedField.split(":");
  if (parts.length < 3) return keys;
  const b64 = parts[parts.length - 1];
  const anchorLength = Number.parseInt(parts[parts.length - 2], 10);
  const anchorVideoId = parts.slice(0, -2).join(":");
  if (!Number.isFinite(anchorLength) || anchorLength <= 0) return keys;
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    const inflated = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate"));
    bytes = new Uint8Array(await new Response(inflated).arrayBuffer());
  } catch {
    return keys;
  }
  const bit = (i: number) =>
    i >= 0 && i < bytes.length * 8 && (bytes[i >> 3] & (1 << (i & 7))) !== 0;
  const anchorIdx = videos.findIndex((v) => v.id === anchorVideoId);
  const offset = anchorIdx >= 0 ? anchorLength - anchorIdx - 1 : 0;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (v?.season != null && v?.episode != null && bit(i + offset)) {
      keys.add(`${v.season}:${v.episode}`);
    }
  }
  return keys;
}

export function stremioMovieWatched(item: LibraryItem | null | undefined): boolean {
  if (!item) return false;
  return (item.state?.flaggedWatched ?? 0) > 0;
}
