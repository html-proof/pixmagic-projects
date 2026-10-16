// After `next build`: every font an exported page preloads must be one its own markup uses.
// Next preloads each font found in a page's CSS chunks, so a font that ends up in a shared chunk
// (Geist Mono once rode along with Geist Sans) is downloaded by pages that never show it. A page
// "uses" a font when its HTML carries one of that font's next/font classes (`className` or
// `variable`). Fails the build, naming each page and font, instead of shipping the waste.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(webDir, process.env.NEXT_EXPORT_DIR || "out");
const chunks = join(out, "_next", "static", "chunks");
if (!existsSync(chunks)) {
  console.error(`check-font-preloads: ${chunks} does not exist`);
  process.exit(1);
}

/** Font file name -> family, and family -> the class names that apply it. */
const familyOfFile = new Map();
const classesOfFamily = new Map();
const unquote = (s) => s.trim().split(",")[0].trim().replace(/^["']|["']$/g, "");
for (const name of readdirSync(chunks).filter((n) => n.endsWith(".css"))) {
  const css = readFileSync(join(chunks, name), "utf8");
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:([^;]+)/.exec(body)?.[1];
    for (const [, url] of body.matchAll(/url\(["']?([^)"']+\.woff2?)["']?\)/g)) if (family) familyOfFile.set(basename(url), unquote(family));
  }
  // next/font's rules: `.x__className{font-family:F,...}` and `.x__variable{--font-y:"F", ...}`.
  for (const [, cls, value] of css.matchAll(/\.([\w-]+__(?:className|variable))\s*\{(?:font-family|--[\w-]+):([^;}]+)/g)) {
    const family = unquote(value);
    classesOfFamily.set(family, [...(classesOfFamily.get(family) ?? []), cls]);
  }
}

const pages = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "_next" ? [] : pages(p);
    return n.endsWith(".html") ? [p] : [];
  });

const problems = [];
let checked = 0;
for (const file of pages(out)) {
  const html = readFileSync(file, "utf8");
  const page = `/${relative(out, file).split(sep).join("/")}`;
  for (const [tag] of html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)) {
    if (!/\bas="font"/.test(tag)) continue;
    checked++;
    const font = basename(/\bhref="([^"]+)"/.exec(tag)?.[1] ?? "");
    const family = familyOfFile.get(font);
    if (!family) {
      problems.push(`${page} preloads ${font}, which no CSS chunk declares`);
      continue;
    }
    const classes = classesOfFamily.get(family) ?? [];
    if (!classes.some((c) => html.includes(c))) problems.push(`${page} preloads ${family} (${font}) but nothing on it uses that font`);
  }
}

if (problems.length) {
  console.error(`check-font-preloads: ${problems.length} unused font preload(s):\n  ${problems.join("\n  ")}`);
  console.error("Each page should preload only its own fonts: see the cssChunking note in next.config.ts.");
  process.exit(1);
}
console.log(`check-font-preloads: ${checked} font preloads, each used by its page`);
