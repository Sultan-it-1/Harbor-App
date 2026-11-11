export type PlaybackEntry = {
  infoHash?: string | null;
  fileIdx?: number | null;
  addonId?: string | null;
  url?: string | null;
  title?: string | null;
  parsedTitle?: string | null;
  resolution?: string | null;
  releaseGroup?: string | null;
  source?: string | null;
  /** Audio languages the played release was tagged with (a dub is part of what "the same
   *  source" means). Null or missing when the release named none. */
  audioLanguages?: string[] | null;
  size?: number | null;
  bingeGroup?: string | null;
  cachedSlugs?: string[];
  savedAt: number;
};

const STORAGE_KEY = "harbor.playback-history.v1";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

const listeners = new Set<() => void>();

export function subscribePlayback(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function entryKey(metaId: string, season?: number, episode?: number): string {
  if (typeof season === "number" && typeof episode === "number") {
    return `${metaId}|s${season}e${episode}`;
  }
  return metaId;
}

function readAll(): Record<string, PlaybackEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PlaybackEntry>;
    const now = Date.now();
    const fresh: Record<string, PlaybackEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v?.savedAt) continue;
      if (now - v.savedAt > TTL_MS) continue;
      fresh[k] = v;
    }
    return fresh;
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, PlaybackEntry>): void {
  try {
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      const sorted = Object.entries(map).sort((a, b) => b[1].savedAt - a[1].savedAt);
      map = Object.fromEntries(sorted.slice(0, MAX_ENTRIES));
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22)) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
    }
  }
  listeners.forEach((l) => l());
}

export function savePlayback(
  metaId: string,
  entry: Omit<PlaybackEntry, "savedAt">,
  season?: number,
  episode?: number,
): void {
  const all = readAll();
  const key = entryKey(metaId, season, episode);
  const prev = all[key];
  const thin = !entry.infoHash && !entry.addonId && !entry.url;
  if (thin && prev) {
    all[key] = {
      ...prev,
      title: entry.title ?? prev.title,
      parsedTitle: entry.parsedTitle ?? prev.parsedTitle,
      savedAt: Date.now(),
    };
  } else {
    const next: PlaybackEntry = { ...entry, savedAt: Date.now() };
    // The player saves this entry again while it plays, from what it knows about the
    // stream, which does not include the audio languages or (on some paths) the release
    // group. For the same source those are kept from the save made when it was picked.
    if (prev && streamMatchesEntry(entry, prev)) {
      if (entry.audioLanguages === undefined && prev.audioLanguages != null) {
        next.audioLanguages = prev.audioLanguages;
      }
      if (entry.releaseGroup == null && prev.releaseGroup) next.releaseGroup = prev.releaseGroup;
    }
    all[key] = next;
  }
  writeAll(all);
}

export function readPlayback(
  metaId: string,
  season?: number,
  episode?: number,
): PlaybackEntry | null {
  const all = readAll();
  return all[entryKey(metaId, season, episode)] ?? null;
}

export function clearPlayback(metaId: string, season?: number, episode?: number): void {
  const all = readAll();
  delete all[entryKey(metaId, season, episode)];
  writeAll(all);
}

function offeredBy(
  s: { addonId?: string | null; contributors?: Array<{ id: string }> },
  addonId: string,
): boolean {
  return s.addonId === addonId || s.contributors?.some((c) => c.id === addonId) === true;
}

/** True when the stream came from the given addon or one of its contributors. */
export function streamOfferedByAddon(
  s: { addonId?: string | null; contributors?: Array<{ id: string }> },
  addonId: string | null | undefined,
): boolean {
  return !!addonId && offeredBy(s, addonId);
}

/**
 * Pick the remembered addon's stream before a same-file stream from another
 * addon. Debrid library copies and aggregator duplicates share the torrent hash,
 * so a plain hash match would otherwise select whichever row came first.
 */
export function findPreferredSourceMatch<
  T extends {
    addonId?: string | null;
    contributors?: Array<{ id: string }>;
    resolution?: string | null;
    releaseGroupNormalized?: string | null;
    audioLanguages?: string[] | null;
  },
>(
  streams: T[],
  entry: PlaybackEntry,
  match: (stream: T, entry: PlaybackEntry) => boolean,
): T | null {
  const candidates = streams.filter((s) => match(s, entry));
  const rememberedLangs = (entry.audioLanguages ?? []).filter((l) => l !== "Multi");
  const score = (s: T): number =>
    (streamOfferedByAddon(s, entry.addonId) ? 4 : 0) +
    (entry.releaseGroup && s.releaseGroupNormalized === entry.releaseGroup ? 2 : 0) +
    (rememberedLangs.some((l) => (s.audioLanguages ?? []).includes(l)) ? 2 : 0) +
    (entry.resolution && s.resolution === entry.resolution ? 1 : 0);
  // Addon first, then the same release group/dub, then the quality the user picked.
  return candidates.slice().sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function streamMatchesEntry(
  s: {
    infoHash?: string | null;
    fileIdx?: number | null;
    url?: string | null;
    addonId?: string | null;
    contributors?: Array<{ id: string }>;
    parsedTitle?: string | null;
    resolution?: string | null;
    source?: string | null;
    size?: number | null;
  },
  e: PlaybackEntry,
): boolean {
  if (e.infoHash && s.infoHash) {
    if (s.infoHash.toLowerCase() !== e.infoHash.toLowerCase()) return false;
    if (e.fileIdx == null || s.fileIdx == null) return true;
    return s.fileIdx === e.fileIdx;
  }
  if (
    e.addonId &&
    offeredBy(s, e.addonId) &&
    e.parsedTitle &&
    s.parsedTitle === e.parsedTitle &&
    e.resolution === s.resolution &&
    e.source === s.source &&
    (e.fileIdx == null || s.fileIdx == null || e.fileIdx === s.fileIdx) &&
    (e.size == null || s.size == null || e.size === s.size)
  ) {
    return true;
  }
  if (e.url && s.url) return s.url === e.url;
  return false;
}

export type WatchedSet = { ids: Set<string>; titles: Set<string> };

export function watchTitleKey(name: string | null | undefined): string {
  if (!name) return "";
  return name.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, "");
}

export function recentlyPlayed(): WatchedSet {
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const [key, entry] of Object.entries(readAll())) {
    const base = key.split("|")[0];
    if (base) ids.add(base);
    const parsed = watchTitleKey(entry.parsedTitle);
    if (parsed) titles.add(parsed);
    const raw = watchTitleKey(entry.title);
    if (raw) titles.add(raw);
  }
  return { ids, titles };
}

export function readLastSeriesPlayback(metaId: string): PlaybackEntry | null {
  const all = readAll();
  const prefix = `${metaId}|`;
  let best: PlaybackEntry | null = null;
  for (const [key, entry] of Object.entries(all)) {
    if (key !== metaId && !key.startsWith(prefix)) continue;
    // An entry that only records "watched" (marked by hand, no stream behind it) says
    // nothing about which source to keep, so it must not hide the last one really played.
    if (!entry.infoHash && !entry.addonId && !entry.bingeGroup && !entry.releaseGroup) continue;
    if (!best || entry.savedAt > best.savedAt) best = entry;
  }
  return best;
}

/** The same torrent, else the same binge group, else the same addon at the same
 *  resolution and source type. Loose: it answers "is this what I played", it is not how
 *  the next episode's source is chosen (see streamMatchesPreferredSource). */
export function streamMatchesSource(
  s: {
    infoHash?: string | null;
    addonId?: string | null;
    contributors?: Array<{ id: string }>;
    resolution?: string | null;
    source?: string | null;
    behaviorHints?: { bingeGroup?: string };
  },
  e: PlaybackEntry,
): boolean {
  if (e.infoHash && s.infoHash) {
    return s.infoHash.toLowerCase() === e.infoHash.toLowerCase();
  }
  const sBinge = s.behaviorHints?.bingeGroup ?? null;
  if (e.bingeGroup && sBinge) return sBinge === e.bingeGroup;
  return (
    !!e.addonId && offeredBy(s, e.addonId) && e.resolution === s.resolution && e.source === s.source
  );
}

export function streamMatchesReleaseLineage(
  s: {
    infoHash?: string | null;
    addonId?: string | null;
    contributors?: Array<{ id: string }>;
    resolution?: string | null;
    source?: string | null;
    releaseGroupNormalized?: string | null;
    behaviorHints?: { bingeGroup?: string };
  },
  e: PlaybackEntry,
): boolean {
  if (streamMatchesSource(s, e)) return true;
  if (!e.releaseGroup || !s.releaseGroupNormalized) return false;
  if (s.releaseGroupNormalized !== e.releaseGroup) return false;
  if (e.addonId && !offeredBy(s, e.addonId)) return false;
  return e.resolution === s.resolution && e.source === s.source;
}

/** A confirmed next-episode release match, not an addon/quality fallback. */
export function streamMatchesPreferredSource(
  s: Parameters<typeof streamMatchesReleaseLineage>[0] & {
    audioLanguages?: string[] | null;
  },
  e: PlaybackEntry,
): boolean {
  if (e.resolution && s.resolution && e.resolution !== s.resolution) return false;
  const rememberedLangs = (e.audioLanguages ?? []).filter((l) => l !== "Multi");
  const candidateLangs = (s.audioLanguages ?? []).filter((l) => l !== "Multi");
  if (
    rememberedLangs.length > 0 &&
    candidateLangs.length > 0 &&
    !rememberedLangs.some((l) => candidateLangs.includes(l))
  )
    return false;
  if (e.infoHash && s.infoHash && e.infoHash.toLowerCase() === s.infoHash.toLowerCase())
    return true;
  if (e.bingeGroup && s.behaviorHints?.bingeGroup === e.bingeGroup) return true;
  // Aggregators share one addon ID across unrelated releases. Only the release
  // identity can confirm a match; generic quality fallback is handled by the picker.
  return (
    !!e.releaseGroup && !!s.releaseGroupNormalized && e.releaseGroup === s.releaseGroupNormalized
  );
}

/** When no release is confirmed: the same addon, the same dub and the same quality. */
export function streamMatchesPreferredSourceFallback(
  s: Parameters<typeof streamMatchesReleaseLineage>[0] & {
    audioLanguages?: string[] | null;
  },
  e: PlaybackEntry,
): boolean {
  if (streamMatchesPreferredSource(s, e)) return true;
  if (!e.addonId || !offeredBy(s, e.addonId)) return false;
  // A dub is part of the source identity. Only reject when both sides name a
  // concrete language and they have none in common; an unlabelled release must
  // remain eligible.
  const rememberedLangs = (e.audioLanguages ?? []).filter((l) => l !== "Multi");
  const candidateLangs = (s.audioLanguages ?? []).filter((l) => l !== "Multi");
  if (
    rememberedLangs.length > 0 &&
    candidateLangs.length > 0 &&
    !rememberedLangs.some((l) => candidateLangs.includes(l))
  ) {
    return false;
  }
  // The user asked to keep the quality they picked. A same-group 4K episode is
  // not a match for a remembered 1080p source; let the picker choose another
  // 1080p stream instead.
  if (e.resolution && s.resolution && e.resolution !== s.resolution) return false;
  // The same release group is the strongest identity. Source tags often differ
  // between episodes (1080p AV1 vs 1080p WEB-DL), so do not reject a same-group
  // episode merely because its filename carries different tags.
  if (e.releaseGroup && s.releaseGroupNormalized) {
    return e.releaseGroup === s.releaseGroupNormalized;
  }
  if (e.source && s.source && e.source !== s.source) return false;
  return true;
}
