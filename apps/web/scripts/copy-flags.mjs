// Country flags for Settings → Security (where each device signed in from): the 3:2 SVGs of the
// country-flag-icons package (MIT), copied to public/flags so they are plain static files
// (/flags/IN.svg), each fetched only when a page shows that country. Runs before `next build` and
// `next dev`; public/flags is generated, not committed.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const from = join(dirname(createRequire(import.meta.url).resolve("country-flag-icons/package.json")), "3x2");
const to = fileURLToPath(new URL("../public/flags", import.meta.url));
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const flags = readdirSync(from).filter((name) => /^[A-Z]{2}\.svg$/.test(name));
for (const name of flags) cpSync(join(from, name), join(to, name));
console.log(`copy-flags: ${flags.length} flags in public/flags`);
