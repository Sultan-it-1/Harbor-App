export type SimklSession = {
  accessToken: string;
  username: string | null;
  /** OAuth 2.0 apps (Simkl apps made since 2026): their tokens expire and are renewed with this. */
  refreshToken?: string;
  /** When the access token stops working (ms since 1970); none for the older PIN apps. */
  expiresAt?: number;
};

export type SimklPin = {
  userCode: string;
  verificationUrl: string;
  deepLinkUrl: string;
  expiresIn: number;
  pollIntervalSec: number;
  /** Set for an OAuth 2.0 app: the device code its token is asked for with. */
  deviceCode?: string;
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
