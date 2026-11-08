import type { Meta } from "@/lib/cinemeta";

/**
 * Smart search inside a list of titles (the "View all" pages).
 *
 * What it forgives and understands:
 *  - case, accents and punctuation: "amelie" finds "Amélie", "walle" finds "WALL·E",
 *    "spiderman" finds "Spider-Man" (and "spider man" finds "Spiderman"), "fast and furious"
 *    finds "Fast & Furious", "schindlers list" finds "Schindler's List"
 *  - Arabic spelling variants: alef forms, ya / alef maqsura, ta marbuta, diacritics, tatweel,
 *    the leading "ال", Arabic-Indic digits
 *  - words in any order, and half-typed words ("game of thr")
 *  - typos: one slip in short words, two in long ones ("intersteller", "godfahter")
 *  - articles and the like are optional ("dark knight" finds "The Dark Knight")
 *  - initials ("got", "lotr", "bb"), years ("2019"), decades ("90s"), genres ("horror")
 *    and words from the description, in that order of importance
 *  - when nothing matches every word, the titles matching most of them are shown
 *
 * Results come back best first; ties keep the list's own order.
 */

const LATIN_MARKS = /[̀-ͯ]/g;
// Arabic harakat, Quranic marks, superscript alef and tatweel.
const ARABIC_MARKS = /[ً-ٰٟۖ-ۭـ]/g;
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

export function normalizeText(input: string): string {
  let s = input.normalize("NFKD").replace(LATIN_MARKS, "").normalize("NFC");
  s = s.replace(ARABIC_MARKS, "").toLowerCase();
  s = s
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىیې]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/đ/g, "d")
    .replace(/ł/g, "l")
    .replace(/ı/g, "i")
    .replace(/&/g, " and ")
    .replace(/['’‘`´]/g, "");
  return s.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

// Words that don't have to be in the title for it to match.
const STOP = new Set([
  "the", "a", "an", "of", "and", "in", "on", "at", "to", "for", "by", "with", "vs",
  "de", "la", "le", "les", "el", "los", "las", "der", "die", "das", "et", "y",
  "من", "في", "علي", "الي", "عن", "و",
]);

function stripArticle(w: string): string {
  // Arabic "al-": "الجوكر" and "جوكر" are the same word.
  return w.length > 4 && w.startsWith("ال") ? w.slice(2) : w;
}

function wordsOf(normalized: string): string[] {
  return normalized ? normalized.split(" ").map(stripArticle) : [];
}

type Doc = {
  title: string;
  words: string[];
  compact: string;
  /** Acronyms people use: every word ("GoT"), without a leading "The" ("LOTR"), content words only. */
  initials: string[];
  year: number | null;
  genres: string[];
  desc: Set<string>;
  kind: "movie" | "series" | "other";
};

const docCache = new WeakMap<Meta, Doc>();

function yearOf(m: Meta): number | null {
  const src = `${m.releaseInfo ?? ""} ${m.releaseDate ?? ""}`;
  const hit = /(?:^|\D)((?:18|19|20|21)\d{2})(?!\d)/.exec(src);
  return hit ? Number(hit[1]) : null;
}

function acronyms(words: string[], content: string[]): string[] {
  const first = (ws: string[]) => ws.map((w) => w[0]).join("");
  const noLead = words.length > 1 && (words[0] === "the" || words[0] === "a" || words[0] === "an") ? words.slice(1) : words;
  return [...new Set([first(words), first(noLead), first(content.length ? content : words)])].filter((a) => a.length >= 2);
}

function docOf(m: Meta): Doc {
  const have = docCache.get(m);
  if (have) return have;
  const title = normalizeText(m.name ?? "");
  const words = wordsOf(title);
  const content = words.filter((w) => !STOP.has(w));
  const genres = (m.genres ?? []).flatMap((g) => wordsOf(normalizeText(g)));
  const desc = new Set(
    wordsOf(normalizeText((m.description ?? "").slice(0, 600))).filter((w) => w.length > 2 && !STOP.has(w)),
  );
  const doc: Doc = {
    title,
    words,
    compact: title.replace(/ /g, ""),
    initials: acronyms(words, content),
    year: yearOf(m),
    genres,
    desc,
    kind: m.type === "movie" ? "movie" : m.type === "series" || m.type === "anime" ? "series" : "other",
  };
  docCache.set(m, doc);
  return doc;
}

/** Optimal-string-alignment distance (insert, delete, replace, swap neighbours), or max + 1 if over. */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb] > max ? max + 1 : prev[lb];
}

/** How many slips a word of this length may have. Short words must be right. */
function allowedEdits(len: number): number {
  if (len <= 3) return 0;
  return len <= 7 ? 1 : 2;
}

const TYPE_WORDS: Record<string, "movie" | "series"> = {
  movie: "movie", movies: "movie", film: "movie", films: "movie", فيلم: "movie", افلام: "movie",
  series: "series", show: "series", shows: "series", tv: "series", مسلسل: "series", مسلسلات: "series",
};

const YEAR = /^(?:18|19|20|21)\d{2}$/;
const INITIALS_QUERY = /^[a-z0-9]{2,6}$/;
const DECADE = /^(\d{2}|\d{4})s$/;

function decadeOf(t: string): [number, number] | null {
  const m = DECADE.exec(t);
  if (!m) return null;
  let start = Number(m[1]);
  if (m[1].length === 2) start += start <= 29 ? 2000 : 1900;
  if (start % 10 !== 0 || start < 1880 || start > 2100) return null;
  return [start, start + 9];
}

type Query = {
  norm: string;
  compact: string;
  tokens: string[];
  required: string[];
};

function parseQuery(raw: string): Query | null {
  const norm = normalizeText(raw);
  if (!norm) return null;
  const tokens = wordsOf(norm);
  const content = tokens.filter((t) => !STOP.has(t));
  return { norm, compact: norm.replace(/ /g, ""), tokens, required: content.length ? content : tokens };
}

/** Best score one query word earns against one title; 0 = no match. */
function tokenScore(t: string, d: Doc): number {
  let best = 0;
  const canContain = t.length >= 3 || CJK.test(t);
  const k = /\d/.test(t) ? 0 : allowedEdits(t.length);
  for (const w of d.words) {
    if (w === t) return 100;
    let s = 0;
    if (w.startsWith(t)) s = 80 + 10 * (t.length / w.length);
    else if (canContain && w.includes(t)) s = 55;
    else if (k > 0) {
      const dist = editDistance(t, w, k);
      if (dist <= k) s = 70 - 15 * dist;
      else if (t.length >= 4 && w.length > t.length) {
        // A half-typed word with a slip in it: compare with the same stretch of the title word.
        const head = editDistance(t, w.slice(0, t.length), k);
        if (head <= k) s = 62 - 15 * head;
      }
    }
    if (s > best) best = s;
  }
  if (best < 60 && t.length >= 4 && d.compact.includes(t)) best = Math.max(best, 58);
  if (YEAR.test(t)) {
    if (d.year === Number(t)) best = Math.max(best, 75);
    return best;
  }
  const decade = decadeOf(t);
  if (decade) {
    if (d.year !== null && d.year >= decade[0] && d.year <= decade[1]) best = Math.max(best, 60);
    return best;
  }
  const kind = TYPE_WORDS[t];
  if (kind && d.kind === kind) best = Math.max(best, 35);
  if (best < 50) {
    for (const g of d.genres) {
      if (g === t) best = Math.max(best, 50);
      else if (t.length >= 3 && g.startsWith(t)) best = Math.max(best, 40);
      else if (k > 0 && editDistance(t, g, 1) <= 1) best = Math.max(best, 32);
    }
  }
  if (best < 20) {
    if (d.desc.has(t)) best = 20;
    else if (t.length >= 4) {
      for (const w of d.desc) {
        if (w.startsWith(t)) {
          best = 12;
          break;
        }
      }
    }
  }
  return best;
}

type Scored = { meta: Meta; index: number; matched: number; score: number };

function scoreDoc(m: Meta, index: number, q: Query): Scored {
  const d = docOf(m);
  let score = 0;
  let matched = 0;
  let inTitle = 0;
  let lastAt = -1;
  let ordered = true;
  for (const t of q.required) {
    const s = tokenScore(t, d);
    if (s > 0) {
      matched += 1;
      score += s;
      if (s >= 55) inTitle += 1;
      const at = d.words.findIndex((w) => w === t || w.startsWith(t));
      if (at >= 0) {
        if (at < lastAt) ordered = false;
        lastAt = at;
      }
    }
  }
  // The query typed as one word against a title written as several (or the reverse).
  if (matched < q.required.length && q.compact.length >= 4 && d.compact.includes(q.compact)) {
    matched = q.required.length;
    inTitle = q.required.length;
    score = Math.max(score, d.compact.startsWith(q.compact) ? 150 : 110);
  }
  // Initials: "got" -> Game of Thrones, "lotr" -> The Lord of the Rings, "bb" -> Breaking Bad.
  if (matched < q.required.length && INITIALS_QUERY.test(q.norm)) {
    const hit = d.initials.some((a) => a === q.norm || (q.norm.length >= 3 && a.startsWith(q.norm)));
    if (hit) {
      matched = q.required.length;
      score = Math.max(score, 90);
    }
  }
  if (matched > 0) {
    if (d.title === q.norm) score += 300;
    else if (d.title.startsWith(q.norm)) score += 120;
    else if (q.norm.length >= 3 && d.title.includes(q.norm)) score += 80;
    if (inTitle === q.required.length) score += 40;
    if (ordered && q.required.length > 1) score += 15;
    score -= Math.min(15, d.title.length * 0.05);
  }
  return { meta: m, index, matched, score };
}

export type SmartResult = {
  items: Meta[];
  /** No title had every word: these are the ones that matched most of them. */
  partial: boolean;
};

export function hasQuery(query: string): boolean {
  return normalizeText(query).length > 0;
}

export function smartFilter(metas: readonly Meta[], query: string): SmartResult {
  const q = parseQuery(query);
  if (!q) return { items: [...metas], partial: false };
  const scored = metas.map((m, i) => scoreDoc(m, i, q));
  const full = scored.filter((s) => s.matched === q.required.length);
  const byScore = (a: Scored, b: Scored) => b.score - a.score || a.index - b.index;
  if (full.length > 0) return { items: full.sort(byScore).map((s) => s.meta), partial: false };
  if (q.required.length >= 2) {
    const need = Math.max(1, q.required.length - 1);
    const some = scored.filter((s) => s.matched >= need);
    if (some.length > 0) {
      some.sort((a, b) => b.matched - a.matched || byScore(a, b));
      return { items: some.map((s) => s.meta), partial: true };
    }
  }
  return { items: [], partial: false };
}
