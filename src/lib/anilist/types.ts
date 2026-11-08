export type AnilistMedia = {
  id: number;
  idMal: number | null;
  title: {
    romaji: string | null;
    english: string | null;
    native: string | null;
    userPreferred: string | null;
  };
  coverImage: { extraLarge: string | null; large: string | null; medium: string | null };
  bannerImage: string | null;
  format: string | null;
  episodes: number | null;
  averageScore: number | null;
  seasonYear: number | null;
};
