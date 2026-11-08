// The player switched source in place, from its own source list. While a just-picked source
// is on trial, and for as long as a switched-to source plays, the "this source is bad, back to
// the source list" safety nets stay out of it: the switcher deals with a bad pick itself (back
// to the source that was playing, at the same spot), and progress isn't saved from a source
// that hasn't proven itself (an uncached torrent's 30-second "downloading" clip would
// otherwise overwrite where you were).
let swapped = false;
let onTrial = false;

export function setSwapState(next: { swapped: boolean; onTrial: boolean }): void {
  swapped = next.swapped;
  onTrial = next.onTrial;
}

/** The playing source isn't the one the player was opened with. */
export function isSwappedSource(): boolean {
  return swapped;
}

/** A just-switched source hasn't started playing for real yet. */
export function isSwapOnTrial(): boolean {
  return onTrial;
}

/** A movie/episode "source" this short is a placeholder clip, not the real thing. */
export const PLACEHOLDER_MAX_SEC = 90;
