export const TRAKT_API_BASE = "https://api.trakt.tv";
export const TRAKT_API_VERSION = "2";
export const TRAKT_CLIENT_ID =
  "7f43ae26e50d8b1eccb387b9acabf3b596211854dc440da9fdee4775f24d8178";
export const TRAKT_CLIENT_SECRET =
  (import.meta.env.VITE_TRAKT_CLIENT_SECRET as string | undefined) ||
  "547cb21f778aac9dbdf6db2fa9a48c0f3fd283ba795f9a76680f416be265970e";
export const TRAKT_VERIFY_URL = "https://trakt.tv/activate";
export const REFRESH_THRESHOLD_SEC = 14 * 24 * 60 * 60;
export const WRITE_MIN_INTERVAL_MS = 1000;
