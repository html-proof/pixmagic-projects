// Next 16's static export writes route-segment prefetch data as nested files
// (`reset/__next.reset/__PAGE__.txt`) but the client router requests the flat
// name (`reset/__next.reset.__PAGE__.txt`), which 404s on any static host.
// Write a copy of each nested file under the flat name the client asks for.
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath + resolve: a URL's `.pathname` stays percent-encoded (a checkout under a folder
// with a space broke), and an absolute NEXT_EXPORT_DIR must not be joined onto "../".
const webDir = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(webDir, process.env.NEXT_EXPORT_DIR || "out");
let copied = 0;
let flatAlready = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) {
      if (name.startsWith("__next.") && name.endsWith(".txt")) flatAlready++;
      continue;
    }
    if (name.startsWith("__next.")) flatten(dir, p);
    else if (name !== "_next") walk(p);
  }
}

/** routeDir/__next.a/b/c.txt -> routeDir/__next.a.b.c.txt */
function flatten(routeDir, segDir) {
  const files = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
  for (const file of files(segDir)) {
    if (!file.endsWith(".txt")) continue;
    const flat = relative(routeDir, file).split(sep).join(".");
    copyFileSync(file, join(routeDir, flat));
    copied++;
  }
}

if (!existsSync(out)) {
  console.error(`fix-export-prefetch: export folder ${out} does not exist`);
  process.exit(1);
}
walk(out);
// Nothing nested and nothing flat means Next changed how it lays prefetch data out: every client
// navigation would 404 its prefetch, so fail the build rather than ship that silently. (Flat files
// with nothing nested means Next fixed this upstream; then the script has nothing to do.)
if (copied === 0 && flatAlready === 0) {
  console.error("fix-export-prefetch: found no route prefetch files at all; Next's export layout has changed, check this script");
  process.exit(1);
}
console.log(`fix-export-prefetch: wrote ${copied} flat prefetch files`);
