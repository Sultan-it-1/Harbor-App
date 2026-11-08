/**
 * Whether a page's response headers forbid showing it inside another page (an iframe):
 * X-Frame-Options DENY / SAMEORIGIN, or a CSP frame-ancestors that doesn't allow everyone.
 * Such a page just shows the browser's "Web page not available" (ERR_BLOCKED_BY_RESPONSE)
 * inside the frame, and the frame still reports "loaded", so it can't be told from the page itself.
 */
export function blocksFraming(headers: { get(name: string): string | null }): boolean {
  const xfo = (headers.get("x-frame-options") ?? "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return true;
  const csp = headers.get("content-security-policy") ?? "";
  const m = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(csp);
  if (!m) return false;
  const sources = m[1].trim().toLowerCase().split(/\s+/);
  if (sources.includes("'none'")) return true;
  // Anyone allowed (*, https:), or the app's own origin listed.
  return !sources.some((s) => s === "*" || s === "https:" || s.includes("appassets.androidplatform.net"));
}
