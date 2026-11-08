import { useSyncExternalStore } from "react";

let positionSec = 0;
let bufferedSec = 0;
const listeners = new Set<() => void>();

export function setPlaybackClock(pos: number, buf: number) {
  if (pos === positionSec && buf === bufferedSec) return;
  positionSec = pos;
  bufferedSec = buf;
  for (const l of listeners) l();
}

export function getPlaybackPosition(): number {
  return positionSec;
}

export function getPlaybackBuffered(): number {
  return bufferedSec;
}

export function subscribePlaybackClock(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

let seekHovering = false;
const seekListeners = new Set<() => void>();

export function setSeekHovering(v: boolean): void {
  if (seekHovering === v) return;
  seekHovering = v;
  for (const l of seekListeners) l();
}

export function getSeekHovering(): boolean {
  return seekHovering;
}

export function subscribeSeekHovering(cb: () => void): () => void {
  seekListeners.add(cb);
  return () => {
    seekListeners.delete(cb);
  };
}

export function usePlaybackPosition(): number {
  return useSyncExternalStore(
    subscribePlaybackClock,
    () => positionSec,
    () => positionSec,
  );
}

export function usePlaybackBuffered(): number {
  return useSyncExternalStore(
    subscribePlaybackClock,
    () => bufferedSec,
    () => bufferedSec,
  );
}

const NEVER = () => () => {};

export function usePlaybackFlag(predicate: () => boolean): boolean {
  return useSyncExternalStore(subscribePlaybackClock, predicate, predicate);
}

export function usePlaybackPositionGated(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribePlaybackClock : NEVER,
    () => positionSec,
    () => positionSec,
  );
}

export function usePlaybackBufferedGated(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribePlaybackClock : NEVER,
    () => bufferedSec,
    () => bufferedSec,
  );
}
