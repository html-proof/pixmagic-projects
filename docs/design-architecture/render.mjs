// Copies bizinsights-design-architecture.xml into index.html, so the page shows the edited map.
//   node docs/design-architecture/render.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, "bizinsights-design-architecture.xml"), "utf8").replace(/^<\?xml[^>]*\?>\s*/, "");
if (/<\/script/i.test(xml)) throw new Error("The XML can't contain </script>: it is embedded in a script element.");
const page = readFileSync(join(here, "index.html"), "utf8");
const open = '<script type="application/xml" id="design-xml">';
const start = page.indexOf(open);
const end = page.indexOf("</script>", start);
if (start < 0 || end < 0) throw new Error("index.html has no design-xml block");
writeFileSync(join(here, "index.html"), `${page.slice(0, start + open.length)}\n${xml}\n${page.slice(end)}`);
console.log("index.html updated");
