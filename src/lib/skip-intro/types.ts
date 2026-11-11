export type SkipKind = "intro" | "outro" | "recap";
export type SkipSource = "aniskip" | "introdb" | "skipdb" | "introdb-app" | "chapters";

export type SkipSegment = {
  kind: SkipKind;
  startSec: number;
  endSec: number;
  source: SkipSource;
};
