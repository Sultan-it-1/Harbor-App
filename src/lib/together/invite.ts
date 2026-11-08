import { normalizeRoomCode } from "./protocol";
import { isRetiredRelay } from "./relay-version";

const RELAY_PARAM = "harbor-relay";
const ROOM_PARAM = "harbor-room";

export type ParsedInvite = {
  relayUrl: string;
  roomCode: string;
};

export function buildInviteUrl(relayUrl: string, roomCode: string): string {
  const params = new URLSearchParams();
  params.set(RELAY_PARAM, relayUrl);
  params.set(ROOM_PARAM, roomCode.toUpperCase());
  return `${window.location.origin}/?${params.toString()}`;
}

export function parseInviteFromLocation(): ParsedInvite | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const relay = params.get(RELAY_PARAM)?.trim();
  const roomRaw = params.get(ROOM_PARAM)?.trim();
  if (!relay || !roomRaw) return null;
  const room = normalizeRoomCode(roomRaw);
  if (!room) return null;
  if (!/^wss?:\/\//.test(relay) || isRetiredRelay(relay)) return null;
  return { relayUrl: relay, roomCode: room };
}

export function clearInviteParams(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete(RELAY_PARAM);
  url.searchParams.delete(ROOM_PARAM);
  window.history.replaceState(null, "", url.toString());
}
