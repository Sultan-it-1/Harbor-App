export const REQUIRED_RELAY_VERSION = 10;

// Harbor's old public relay. It has shut down for good, so a saved relay URL or an invite link
// that still points at it counts as no relay.
const RETIRED_RELAY_HOST = "pub.harbor.site";

export function relayOutdated(version: number | null | undefined): boolean {
  return version == null || version < REQUIRED_RELAY_VERSION;
}

export function isRetiredRelay(url: string): boolean {
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^(wss?|https?):\/\//, "")
    .replace(/[/:?#].*$/, "");
  return host === RETIRED_RELAY_HOST;
}
