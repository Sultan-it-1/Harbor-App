import { isAndroidApp } from "@/lib/android";
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
  // In the Android app the page's own address (https://appassets.androidplatform.net) only
  // exists inside the app: sent to someone, it opens an error page. The invite there is an app
  // link instead. It is pasted into Watch Together, which reads what follows the "?".
  if (isAndroidApp()) return `harbor://join?${params.toString()}`;
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
