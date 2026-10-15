// The HTML a template may contain, enforced on save and again on every rendered email.
//
// An allowlist: email-safe formatting tags and attributes survive, everything else goes. Scripts,
// styles blocks, frames, forms, embedded objects, SVG/MathML, comments and processing
// instructions are dropped with their content; event handler attributes and any URL that isn't
// http(s), mailto or tel are dropped too. The output is re-serialized from what was parsed (every
// attribute value quoted and escaped), so malformed input can't reopen a tag.
//
// It has to run without a DOM (Workers and the browser alike), hence the hand-written tokenizer.
// The dashboard additionally shows previews in a sandboxed iframe, so a sanitizer bug can't run
// script in bizinsights itself.

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "b", "blockquote", "body", "br", "caption", "center", "cite", "code", "col", "colgroup",
  "dd", "del", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "html", "i", "img", "ins",
  "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "small", "span", "strike", "strong", "sub", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "template",
  "svg", "math", "title", "head", "form", "textarea", "select", "button", "xmp", "plaintext", "audio", "video", "canvas",
]);

const VOID = new Set(["br", "hr", "img", "col", "wbr"]);

const GLOBAL_ATTRS = new Set(["style", "title", "align", "valign", "width", "height", "bgcolor", "dir", "lang", "class", "border", "role"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "name"]),
  img: new Set(["src", "alt"]),
  font: new Set(["color", "face", "size"]),
  table: new Set(["cellpadding", "cellspacing", "summary"]),
  td: new Set(["colspan", "rowspan", "nowrap"]),
  th: new Set(["colspan", "rowspan", "nowrap", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type"]),
  ul: new Set(["type"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
};
const URL_ATTRS = new Set(["href", "src", "cite"]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", tab: "\t", newline: "\n", colon: ":" };

/** Decode character references, as a browser would before looking at a URL's scheme. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[ref.toLowerCase()] ?? m;
  });
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text between tags: `<` never reaches here; a bare `&` that isn't a character reference is escaped. */
const escapeText = (s: string) => s.replace(/&(?!(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/>/g, "&gt;");

/** C0 controls, space, DEL and C1 controls: browsers drop them inside URLs, so a tab inside "javascript:" still means javascript:. */
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x20)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]+`, "g");

/** Whether a URL may stay: http(s), mailto, tel, an in-page anchor, or (in a template) a placeholder. */
export function safeUrl(value: string, attr: string, allowPlaceholder: boolean): boolean {
  const v = decodeEntities(value).replace(CONTROL_CHARS, "").toLowerCase();
  if (allowPlaceholder && v.startsWith("{{")) return true;
  if (attr === "src") return /^https?:\/\//.test(v);
  return /^(https?:\/\/|mailto:|tel:|#)/.test(v);
}

/** Inline styles stay unless they can load or run something. */
function safeStyle(value: string): boolean {
  const v = decodeEntities(value).replace(/\\[0-9a-f]{1,6}\s?/gi, "?").replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
  if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|<\/?\s*style/.test(v)) return false;
  const urls = v.match(/url\s*\(\s*['"]?([^'")\s]*)/g) ?? [];
  return urls.every((u) => /url\s*\(\s*['"]?https:\/\//.test(u));
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function cleanAttrs(tag: string, src: string, allowPlaceholder: boolean): string {
  const allowed = TAG_ATTRS[tag];
  const out: string[] = [];
  const seen = new Set<string>();
  let blankTarget = false;
  for (const m of src.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith("on") || !(GLOBAL_ATTRS.has(name) || allowed?.has(name))) continue;
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    const value = decodeEntities(raw);
    if (URL_ATTRS.has(name) && !safeUrl(raw, name, allowPlaceholder)) continue;
    if (name === "style" && !safeStyle(raw)) continue;
    if (name === "target") {
      if (value.toLowerCase() !== "_blank") continue;
      blankTarget = true;
    }
    if (name === "rel") continue; // set below for target=_blank only
    out.push(` ${name}="${escapeAttr(value)}"`);
  }
  if (blankTarget) out.push(' rel="noopener noreferrer"');
  return out.join("");
}

/** Index of the `>` that ends a tag starting at `from`, skipping quoted attribute values; -1 if none. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

/**
 * Sanitize HTML. `allowPlaceholders` keeps `{{...}}` in URL attributes (for saving a template, whose
 * links may be filled in later); rendered emails are sanitized again without it.
 */
export function sanitizeHtml(html: string, opts: { allowPlaceholders?: boolean } = {}): string {
  const allowPlaceholder = !!opts.allowPlaceholders;
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(escapeText(html.slice(i)));
      break;
    }
    out.push(escapeText(html.slice(i, lt)));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 80));
    if (!m) {
      out.push("&lt;");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + m[0].length);
    if (end === -1) {
      // An unterminated tag: whatever follows is text, never markup.
      out.push(escapeText(html.slice(lt).replace(/</g, "&lt;")));
      break;
    }
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    i = end + 1;
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) {
        const close = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(i));
        i = close ? i + close.index + close[0].length : html.length;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      if (!VOID.has(name)) out.push(`</${name}>`);
      continue;
    }
    out.push(`<${name}${cleanAttrs(name, html.slice(lt + m[0].length, end), allowPlaceholder)}>`);
  }
  return out.join("");
}
