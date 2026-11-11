export type SkipKind = "intro" | "outro" | "recap";
export type SkipSource = "aniskip" | "introdb" | "chapters";

export type SkipSegment = {
  kind: SkipKind;
  startSec: number;
  endSec: number;
  source: SkipSource;
};
