// Build the UI into its own folder and deploy exactly that folder with the Worker.
//
// - `wrangler deploy` on its own ships `../web/out` (assets.directory in wrangler.jsonc). The web
//   build honours NEXT_EXPORT_DIR, so with that set in the shell (as the demo and e2e setups do)
//   the old one-liner built into another folder and deployed whatever stale build `out` held.
// - `out` is also what a local `wrangler dev` serves, and on Windows a running one holds it open,
//   so rebuilding it in place fails with EBUSY. A dedicated folder sidesteps both.
import { execSync } from "node:child_process";

const DIR = "out-deploy";
const env = { ...process.env, NEXT_EXPORT_DIR: DIR };
const run = (cmd) => execSync(cmd, { stdio: "inherit", env });

run("pnpm --filter @app/web build");
run(`pnpm exec wrangler deploy --assets ../web/${DIR} ${process.argv.slice(2).join(" ")}`.trim());
