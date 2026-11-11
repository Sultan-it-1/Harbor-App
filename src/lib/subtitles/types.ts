export type ProviderMatchConfidence = "exact" | "high" | "medium" | "low" | "unknown";

/** Evidence reported by the provider or implied by a provider-side exact filter. */
export type ProviderMatchEvidence = {
  score?: number;
  confidence?: ProviderMatchConfidence;
  reasons?: string[];
  matchedBy?: Array<"hash" | "filename" | "id" | "episode" | "title" | "release">;
  degraded?: boolean;
};

export type SubtitleRating = {
  score?: number;
  good?: number;
  bad?: number;
  total?: number;
};

/** How a subtitle's timing compared with the audio, when something measured it. */
export type SubtitleTimingStatus =
  | "not-tested"
  | "aligned"
  | "fixed-offset"
  | "drifting"
  | "different-cut"
  | "unmeasurable"
  | "invalid";

export type SubResult = {
  id: string;
  url: string;
  lang: string;
  langName?: string;
  title?: string;
  source: "wyzie" | "addon" | "opensubtitles" | "jimaku";
  format?: "srt" | "vtt" | "ass" | "ssa" | "sub";
  encoding?: string;
  fps?: number;
  hearingImpaired?: boolean;
  forced?: boolean;
  release?: string;
  downloads?: number;
  hash?: string;
  // The fields below are read by the ranking (candidate-ranking.ts). Our providers fill
  // few of them today; each one a provider starts to report improves the order for free.
  foreignOnly?: boolean;
  machineTranslated?: boolean;
  fromTrusted?: boolean;
  rating?: SubtitleRating;
  rawFilename?: string;
  season?: number;
  episode?: number;
  episodeConfirmed?: boolean;
  providerMatch?: ProviderMatchEvidence;
  timingStatus?: SubtitleTimingStatus;
};

export type SubSearchQuery = {
  imdbId?: string;
  tmdbId?: string;
  stremioId?: string;
  type?: "movie" | "series";
  title?: string;
  season?: number;
  episode?: number;
  langs?: string[];
  videoHash?: string;
  videoSize?: number;
  filename?: string;
};
