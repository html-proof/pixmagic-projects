// Next 16's static export writes route-segment prefetch data as nested files
// (`reset/__next.reset/__PAGE__.txt`) but the client router requests the flat
// name (`reset/__next.reset.__PAGE__.txt`), which 404s on any static host.
// Write a copy of each nested file under the flat name the client asks for.
import { copyFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const out = new URL(`../${process.env.NEXT_EXPORT_DIR || "out"}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let copied = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
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

walk(out);
console.log(`fix-export-prefetch: wrote ${copied} flat prefetch files`);
