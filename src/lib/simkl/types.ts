export type SimklSession = {
  accessToken: string;
  username: string | null;
};

export type SimklPin = {
  userCode: string;
  verificationUrl: string;
  deepLinkUrl: string;
  expiresIn: number;
  pollIntervalSec: number;
};

export type SimklIds = {
  simkl?: number;
  imdb?: string;
  tmdb?: number | string;
  tvdb?: number;
  mal?: number;
  anidb?: number;
};

export type SimklTarget =
  | { kind: "movie"; ids: SimklIds }
  | { kind: "episode"; show: { ids: SimklIds }; season: number; number: number }
  | { kind: "show"; ids: SimklIds };

export type SimklItem = {
  type: "movie" | "show";
  title: string;
  year: number | null;
  ids: SimklIds;
  watchedAt?: string;
};

export type SimklUser = {
  name: string;
  avatar?: string | null;
  type?: string;
};
