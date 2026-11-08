// Phone smoke test for the Android build of the web UI (run after `pnpm run build`):
// serves dist/, opens it in a phone-sized Chromium with a stand-in for the Android shell's bridge
// (offline: every native fetch fails, as on a phone without a connection), visits every main
// screen and every Settings section in English and Arabic, and fails on a page error, a missing tab
// bar, a Back gesture that does nothing, a Settings section wider than a 360px screen or with a
// short button label wrapping onto two lines, or text the Arabic catalog is missing.
// Usage: pnpm run test:phone
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const VIEWS = ["home", "discover", "movies", "shows", "live", "library", "downloads", "addons", "calendar", "settings"];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm" };

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("phone-smoke: dist/ not found. Run `pnpm run build` first.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// The Android shell, minus the native parts: fetch answers "offline", the rest records calls.
const SHELL = ({ lang }) => {
  window.__harborI18nMisses = new Set();
  window.HarborAndroid = {
    version: () => "smoke",
    fetch: (id) => setTimeout(() => window.__harborNativeFetchDone?.(id, JSON.stringify({ ok: false, error: "java.net.UnknownHostException: offline" })), 5),
    fetchCancel: () => {},
    play: () => {}, command: () => {}, stop: () => {}, openExternal: () => {},
    dlStart: () => JSON.stringify({ ok: true }), dlStatus: () => "{}", dlDelete: () => true, dlPause: () => true, dlResume: () => true,
    dlAddSubs: () => true, dlFiles: () => "{}", dlStorage: () => JSON.stringify({ free: 5e10, used: 0 }),
    takeLink: () => "", dlKeepAlive: () => {}, bgAllowed: () => true, bgRequest: () => {},
  };
  try {
    localStorage.setItem("harbor.onboarding", JSON.stringify({ onboarded: true, nudges: {} }));
    const cur = JSON.parse(localStorage.getItem("harbor.settings") || "{}");
    // A saved relay address, so Settings > Harbor Relay shows its connected state too.
    localStorage.setItem("harbor.settings", JSON.stringify({ ...cur, uiLanguage: lang, togetherRelayUrl: "wss://smoke-relay.example.workers.dev" }));
  } catch {}
};

const failures = [];
const browser = await chromium.launch();
for (const lang of ["en", "ar"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: lang === "ar" ? "ar" : "en-US",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 HarborAndroid/smoke" });
  // Nothing leaves the machine: the test must not depend on outside services.
  await ctx.route((url) => !url.href.startsWith(base) && !url.href.startsWith("data:") && !url.href.startsWith("blob:"), (route) => route.abort("internetdisconnected"));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 200)));
  await page.addInitScript(SHELL, { lang });
  await page.goto(`${base}/index.html`);
  await page.waitForFunction(() => !!window.harbor?.navigate, null, { timeout: 30_000 });
  if (lang === "ar" && (await page.evaluate(() => document.documentElement.dir)) !== "rtl") failures.push("ar: the page is not right to left");
  for (const v of VIEWS) {
    await page.evaluate((v) => window.harbor.navigate(v), v);
    await page.waitForTimeout(1500);
    const ok = await page.evaluate(() => !!document.querySelector("main"));
    if (!ok) failures.push(`${lang}/${v}: no <main> rendered`);
    if (v !== "settings" && !(await page.$("[data-phone-tabbar]"))) failures.push(`${lang}/${v}: the tab bar is missing`);
  }
  // Back from a page returns to where you were.
  await page.evaluate(() => window.harbor.navigate("library"));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.harbor.navigate("downloads"));
  await page.waitForTimeout(800);
  const handled = await page.evaluate(() => (window.__harborAndroidBack ? window.__harborAndroidBack() : "no handler"));
  await page.waitForTimeout(800);
  if (handled === "no handler") failures.push(`${lang}: no Android Back handler`);

  // Every Settings section fits a small phone (360 px): nothing in it needs more width than the
  // screen gives (that is what showed up cut off at the right edge), and short button labels stay
  // on one line.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => window.harbor.navigate("settings"));
  await page.waitForTimeout(1500);
  const sections = await page.evaluate(() => {
    const nav = [...document.querySelectorAll("nav")].find((n) => n.getBoundingClientRect().width > 0);
    return nav ? [...nav.querySelectorAll("button")].map((b) => b.innerText.trim().split("\n")[0]).filter(Boolean) : [];
  });
  if (sections.length < 8) failures.push(`${lang}: the Settings list shows only ${sections.length} sections`);
  for (const label of sections) {
    const opened = await page.evaluate((label) => {
      const nav = [...document.querySelectorAll("nav")].find((n) => n.getBoundingClientRect().width > 0);
      const b = nav && [...nav.querySelectorAll("button")].find((x) => x.innerText.trim().split("\n")[0] === label);
      b?.click();
      return !!b;
    }, label);
    if (!opened) {
      failures.push(`${lang}/settings "${label}": could not open it from the list`);
      continue;
    }
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => {
      const main = [...document.querySelectorAll("main")].find((m) => m.getBoundingClientRect().width > 0);
      const col = main?.firstElementChild;
      if (!col) return null;
      // Anything that sticks out past the screen edge (and gets cut off). Sideways-scrolling strips,
      // text cut with "…" on purpose and absolutely placed decorations don't count.
      const vw = window.innerWidth;
      const rtl = document.documentElement.dir === "rtl";
      const past = (r) => (rtl ? r.left < -1 : r.right > vw + 1);
      const exempt = (e) => {
        for (let p = e; p && p !== col; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (ps.textOverflow === "ellipsis" || ps.position === "absolute" || ps.position === "fixed") return true;
          if (p !== e && /(auto|scroll)/.test(ps.overflowX)) return true;
        }
        return false;
      };
      const cut = [];
      for (const e of col.querySelectorAll("*")) {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || !past(r) || exempt(e)) continue;
        if (e.parentElement && e.parentElement !== col && past(e.parentElement.getBoundingClientRect())) continue;
        cut.push(`"${(e.innerText || e.getAttribute("aria-label") || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40)}"`);
      }
      // Lines of a control's own text (icons and inputs inside it don't count).
      const lines = (el) => {
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const mids = [];
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          if (!n.textContent.trim()) continue;
          const rg = document.createRange();
          rg.selectNodeContents(n);
          for (const x of rg.getClientRects()) if (x.width > 1) mids.push(x.top + x.height / 2);
        }
        mids.sort((a, b) => a - b);
        let count = 0;
        let last = -1e9;
        for (const m of mids) if (m - last > 6) { count++; last = m; }
        return count;
      };
      const wrapped = [];
      for (const b of main.querySelectorAll('button, a, [role="button"]')) {
        const txt = (b.innerText || "").trim();
        if (!txt || txt.length > 28 || txt.includes("\n") || b.getBoundingClientRect().width === 0) continue;
        if (lines(b) >= 2) wrapped.push(`"${txt}"`);
      }
      // A single word split over two lines ("Sy|nc", "ACT|IVE") anywhere in the section.
      const broken = [];
      const tw = document.createTreeWalker(col, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const word = n.textContent.trim();
        if (word.length < 2 || word.length > 16 || /\s/.test(word)) continue;
        const pe = n.parentElement;
        if (!pe || pe.closest("input, textarea, select, [aria-hidden='true']")) continue;
        if (lines(pe) >= 2 && pe.textContent.trim() === word) broken.push(`"${word}"`);
      }
      return { cut: [...new Set(cut)], wrapped: [...new Set(wrapped)], broken: [...new Set(broken)] };
    });
    if (r && r.cut.length) failures.push(`${lang}/settings "${label}": cut off at the screen edge on a 360px phone: ${r.cut.slice(0, 6).join(", ")}`);
    if (r && r.wrapped.length) failures.push(`${lang}/settings "${label}": button text wraps onto two lines: ${r.wrapped.slice(0, 6).join(", ")}`);
    if (r && r.broken.length) failures.push(`${lang}/settings "${label}": a word is split across two lines: ${r.broken.slice(0, 6).join(", ")}`);
    await page.evaluate(() => window.__harborAndroidBack?.());
    await page.waitForTimeout(500);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  if (lang === "ar") {
    // Arabic text keys are fine; anything else falls back to English.
    const missing = (await page.evaluate(() => [...window.__harborI18nMisses])).filter((k) => !/[؀-ۿ]/.test(k));
    if (missing.length) failures.push(`ar: missing Arabic for ${JSON.stringify(missing.slice(0, 20))}`);
  }
  if (errors.length) failures.push(`${lang}: page errors ${JSON.stringify(errors.slice(0, 5))}`);
  await ctx.close();
}
await browser.close();
server.close();

if (failures.length) {
  console.error("phone-smoke: FAILED");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`phone-smoke: ${VIEWS.length} screens and every Settings section in English and Arabic, no page errors, tab bar and Back work, Settings fits a 360px screen, no missing Arabic.`);
