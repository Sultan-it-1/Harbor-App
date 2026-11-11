// What is left of the Jikan (MyAnimeList) provider. Its public API closed on 1 October 2026 and
// the anime lists come from AniList now (src/lib/anilist/catalog.ts). The network calls and
// their caches are gone. The franchise-name helpers and the genre numbers the anime page still
// keys its rows by are used across the app, so they stay under this name.

// The removed catalogue and id-mapping caches: free what they left in storage.
try {
  localStorage.removeItem("harbor.jikancatalog");
  localStorage.removeItem("harbor.armcache");
} catch {
  /* storage blocked: nothing to clean */
}

const FRANCHISE_STRIP_RX: RegExp[] = [
  /\s*[-:]?\s*(?:1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th|First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Final|Last)\s+(?:Season|Cour|Part)\b.*$/i,
  /\s*[-:]?\s*Season\s+\d+\b.*$/i,
  /\s+S\d+(?:\s|$).*/i,
  /\s*[-:]?\s*(?:Part|Cour|Chapter)\s+\d+\b.*$/i,
  /\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)\s*$/,
];

export function stripFranchiseSuffix(name: string): string {
  let t = name;
  for (const rx of FRANCHISE_STRIP_RX) t = t.replace(rx, "");
  return t.replace(/[\s°'."’˚_:\-]+$/g, "").trim();
}

export function animeFranchiseKey(name: string): string {
  return stripFranchiseSuffix(name).toLowerCase();
}

export const GENRE = {
  Action: 1,
  Adventure: 2,
  Comedy: 4,
  Drama: 8,
  Fantasy: 10,
  Horror: 14,
  Mystery: 7,
  Romance: 22,
  SciFi: 24,
  SliceOfLife: 36,
  Sports: 30,
  Supernatural: 37,
  Thriller: 41,
  Mecha: 18,
  Music: 19,
  Psychological: 40,
} as const;
