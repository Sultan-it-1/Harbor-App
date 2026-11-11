// Addon documentation is somebody else's markdown, and markdown may carry raw HTML. Rendered as it
// comes, that HTML lands in the app's own page: an <iframe srcdoc>, a <script async src> (React 19
// runs those) or an onerror attribute would run with the app's full rights: sign-in tokens, debrid
// keys and the Android bridge. This rehype plugin runs after rehype-raw and keeps only what a
// README needs.
//
// It is an allow-list on purpose (a block-list always misses the next tag or attribute), and it
// works on the parsed tree that React then draws directly, so there is no second HTML parse to
// trick.

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const set = (words: string) => new Set(words.split(" "));

// Kept as they are (with their attributes filtered). Any other tag is unwrapped: the tag goes,
// what is inside it stays.
const KEEP = set(
  "a abbr b blockquote br caption center code col colgroup dd del details div dl dt em figcaption figure " +
    "h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s samp small span strike strong " +
    "sub summary sup table tbody td tfoot th thead tr tt u ul var",
);

// Dropped with everything inside them: their content is code, styling, a form or a way out of the page.
const DROP = set(
  "script style iframe frame frameset object embed applet link meta base form button textarea select " +
    "option optgroup datalist svg math template noscript noembed noframes audio video track canvas dialog " +
    "title head xmp plaintext listing map area",
);

// Attributes by the names the parser gives them. Everything else goes: every on* handler, srcdoc,
// style (it could lay a fake screen over the app), id and name (they can shadow the app's own
// elements), srcset, and whatever comes next.
const KEEP_ATTRS = set("alt title width height align colSpan rowSpan start open dir lang");

/**
 * The link if it is http(s), mailto (when allowed) or has no scheme at all (relative, #anchor);
 * null for javascript:, data:, vbscript:, intent: and the rest. Spaces and control characters are
 * removed first, because a browser ignores them inside a scheme ("java\tscript:").
 */
function safeUrl(value: unknown, mailto: boolean): string | null {
  if (typeof value !== "string") return null;
  const url = value.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
  if (!scheme) return url;
  return scheme === "http" || scheme === "https" || (mailto && scheme === "mailto") ? url : null;
}

function cleanProps(tag: string, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (KEEP_ATTRS.has(key)) out[key] = props[key];
  }
  if (tag === "a") {
    const href = safeUrl(props.href, true);
    if (href) out.href = href;
  }
  if (tag === "img") {
    const src = safeUrl(props.src, false);
    if (src) out.src = src;
  }
  // Only the class that names a code block's language ("language-js"): any other class would
  // pull in the app's own styles, e.g. to cover the whole screen.
  const classes = Array.isArray(props.className) ? props.className : [];
  const language = classes.filter((c) => typeof c === "string" && /^language-[\w+#.-]+$/.test(c));
  if (language.length > 0) out.className = language;
  return out;
}

function clean(nodes: HastNode[]): HastNode[] {
  const out: HastNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      out.push(node);
      continue;
    }
    // Comments, doctypes and any HTML left unparsed are not shown at all.
    if (node.type !== "element" || !node.tagName) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === "input") {
      // A task list's checkbox ("- [x] done") is the one form control markdown itself makes.
      if (node.properties?.type === "checkbox") {
        out.push({
          ...node,
          properties: { type: "checkbox", checked: node.properties.checked === true, disabled: true },
          children: [],
        });
      }
      continue;
    }
    if (DROP.has(tag)) continue;
    const children = clean(node.children ?? []);
    if (!KEEP.has(tag)) {
      out.push(...children);
      continue;
    }
    const properties = cleanProps(tag, node.properties ?? {});
    // A picture whose address was refused would only draw a broken-image box.
    if (tag === "img" && !properties.src) continue;
    out.push({ ...node, properties, children });
  }
  return out;
}

/** rehype plugin: put it right after rehype-raw wherever third-party markdown is rendered. */
export function rehypeSanitizeDoc() {
  return (tree: HastNode): void => {
    tree.children = clean(tree.children ?? []);
  };
}
