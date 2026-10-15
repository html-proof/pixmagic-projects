// Starts the local server (apps/aws/src/local.ts: UI + API + jobs in one process) for a demo,
// with the test settings in apps/web/e2e/server.env and the demo's own overrides on top.
//   import { startLocalServer } from "./local-server.mjs";
//   startLocalServer({ port: "8789", assets: "apps/web/out-demo", db: "localhost:5434/app_demo", env: { ... } });
// `db` is host:port/database; the owner and app_rls roles both connect to it.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function startLocalServer({ port, assets, db, env = {} }) {
  const cwd = resolve(root, "apps/aws");
  const child = spawn(
    process.execPath,
    [
      resolve(cwd, "node_modules/tsx/dist/cli.mjs"),
      "src/dev.ts",
      "--port",
      String(port),
      "--settings",
      resolve(root, "apps/web/e2e/server.env"),
      "--assets",
      resolve(root, assets),
    ],
    {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://app:app@${db}`,
        APP_DATABASE_URL: `postgresql://app_rls:app_rls@${db}`,
        APP_URL: `http://localhost:${port}`,
        API_URL: `http://localhost:${port}/api`,
        ...env,
      },
    },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  return child;
}
