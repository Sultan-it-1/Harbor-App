// Fails when text passed to t("…") in src/ has no Arabic translation in
// src/lib/i18n/locales/ar/*.ts, so a new string can't ship half-English in the Arabic UI.
// Usage: node scripts/check-i18n.mjs   (prints the missing keys with where they are used)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const AR_DIR = path.join(SRC, "lib/i18n/locales/ar");
const TRANSLATORS = new Set(["t", "tr", "translate"]);

function parse(file) {
  const text = fs.readFileSync(file, "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!p.includes(`${path.sep}i18n${path.sep}locales`)) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const arKeys = new Set();
for (const f of fs.readdirSync(AR_DIR)) {
  if (!f.endsWith(".ts")) continue;
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name) || ts.isNoSubstitutionTemplateLiteral(n.name))) {
      arKeys.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(path.join(AR_DIR, f)));
}

const missing = new Map();
for (const file of walk(SRC)) {
  const sf = parse(file);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && TRANSLATORS.has(n.expression.text) && n.arguments.length > 0) {
      const a = n.arguments[0];
      if ((ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && !arKeys.has(a.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
        const where = `${path.relative(ROOT, file)}:${line + 1}`;
        if (!missing.has(a.text)) missing.set(a.text, where);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

if (missing.size > 0) {
  console.error(`check-i18n: ${missing.size} text(s) have no Arabic translation. Add them to src/lib/i18n/locales/ar/:`);
  for (const [key, where] of missing) console.error(`  ${JSON.stringify(key)}  (${where})`);
  process.exit(1);
}
console.log(`check-i18n: every t() text has an Arabic translation (${arKeys.size} entries).`);
