// Android app: console output ends up in logcat, which other tools and bug reports can read.
// Addon and debrid URLs carry API keys in their path or query, and Xtream URLs carry the
// username and password, so log text is redacted before it is printed.

const RULES: [RegExp, string][] = [
  // key=value pairs that are secrets
  [/([?&;](?:api[_-]?key|apikey|token|access_token|refresh_token|password|pass|passwd|key|auth|authkey|secret)=)[^&\s"'#]+/gi, "$1…"],
  // Xtream / IPTV paths: /live/<user>/<pass>/…, /movie/…, /series/…, /timeshift/…
  [/(\/(?:live|movie|series|timeshift)\/)[^/\s"']+\/[^/\s"']+\//gi, "$1…/…/"],
  // username=…&password=… in get.php / player_api.php
  [/(username=)[^&\s"'#]+/gi, "$1…"],
  // long opaque tokens in URL paths (debrid keys, addon configs)
  [/(\/)[A-Za-z0-9_%=-]{24,}(?=[/?#\s"']|$)/g, "$1…"],
];

export function redact(text: string): string {
  let out = text;
  for (const [rx, to] of RULES) out = out.replace(rx, to);
  return out;
}

let installed = false;

/** Wraps console.log/info/warn/error/debug so string arguments are redacted. */
export function installConsoleRedaction(): void {
  if (installed || typeof console === "undefined") return;
  installed = true;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => orig(...args.map((a) => (typeof a === "string" ? redact(a) : a)));
  }
}
