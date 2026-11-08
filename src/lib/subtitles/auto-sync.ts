export type AutoSyncInput = {
  subtitleUrl: string;
  audioSampleRate: number;
  audioPcm: Float32Array | null;
  cuesSec: number[];
};

export type AutoSyncResult = {
  offsetSec: number;
  confidence: number;
};

export const AUTO_SYNC_AVAILABLE = false;

export async function estimateSubtitleOffset(
  _input: AutoSyncInput,
): Promise<AutoSyncResult | null> {
  return null;
}
