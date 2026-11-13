import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { accountRemovalPlan, localAuth, prismaAuthStore, removeAccountsExcept, sendSignInNotices, signInMoveReport } from "@app/api";
import { env, logger } from "@app/core";
import { disconnectDb } from "@app/db";
import { runAction } from "./actions.js";
import { parseArgs, toAction } from "./adminArgs.js";
import { importDynamoItems } from "./pgCoord.js";
import { listDead, queueStats, redriveDead } from "./pgQueues.js";
import { runtimePool, selfHostDeps, selfHostSettings } from "./selfhost.js";

/**
 * The self-hosted server's maintenance command (bundled as admin.mjs), run in a one-off container:
 *
 *   docker compose run --rm admin <command> [options]
 *
 * Commands:
 *   migrate | counts | after-move | reread | verify | shopify-check | product-check | config | evolution-db
 *                        the AWS cron function's maintenance actions (actions.ts), same code
 *     --shop <x.myshopify.com>  --days <n>  --dry-run  --from <YYYY-MM-DD> --to <YYYY-MM-DD>
 *   queues               jobs per queue: ready, delayed, in flight, dead
 *   dlq [queue]          the dead-letter queue's newest jobs (no bodies)
 *   redrive <queue>      every dead job of that queue back into it; or --id <job id> for one
 *   import-coord <file>  DynamoDB `coord` items (aws dynamodb scan output) into the coordinator (cutover)
 *   remove-accounts --keep <address>
 *                        what deleting every account but that one would take (each account, the
 *                        workspaces and stores that go with it); removes nothing
 *     --confirm <n>        deletes them, as "Delete account" in Settings does, if n is the plan's count
 *   sign-in-move         how many of Cognito's users the app's own sign-in has, and how many it still waits for
 *     --notify             emails those who had a password only at Cognito (deleted 2026-11-13) and
 *                          haven't set one in the app how to; with --dry-run, only counts them
 *
 * migrate, counts and evolution-db need the owner's login (OWNER_DATABASE_URL), which only this
 * command is given (infra/ikorex/docker-compose.yml). Prints JSON; exits 1 on failure.
 */
const here = dirname(fileURLToPath(import.meta.url));

async function run(argv: string[]): Promise<unknown> {
  const { command, positional, flags } = parseArgs(argv);
  selfHostSettings();
  const pool = runtimePool(process.env, 2);
  try {
    const action = toAction(command, flags);
    if (action) {
      const deps = selfHostDeps(pool);
      return await runAction(action, { jobs: async () => deps, ready: async () => {}, dir: here });
    }
    switch (command) {
      case "queues":
        return await queueStats(pool, Date.now());
      case "dlq":
        return await listDead(pool, positional[0]);
      case "redrive": {
        const id = typeof flags.id === "string" ? flags.id : undefined;
        const queue = positional[0];
        if (!id && !queue) throw new Error("redrive needs a queue name or --id <job id>");
        return { redriven: await redriveDead(pool, { queue, id }) };
      }
      case "import-coord": {
        const file = positional[0];
        if (!file) throw new Error("import-coord needs the scan output file");
        const scan = JSON.parse(readFileSync(file, "utf8")) as { Items?: Array<Record<string, { S?: string; N?: string }>> };
        return { imported: await importDynamoItems(pool, scan.Items ?? []) };
      }
      case "remove-accounts": {
        const keep = typeof flags.keep === "string" ? flags.keep : "";
        if (!keep) throw new Error("remove-accounts needs --keep <the address of the account that stays>");
        if (flags.confirm === undefined) return await accountRemovalPlan(keep);
        const n = typeof flags.confirm === "string" ? Number(flags.confirm) : NaN;
        if (!Number.isInteger(n)) throw new Error("--confirm takes the number of accounts the plan lists");
        const deps = selfHostDeps(pool);
        // The sign-in directory's own delete, as the Delete account route uses it; no email is sent.
        const auth = localAuth({ store: prismaAuthStore(), coord: deps.coord, mailer: deps.mailer });
        return await removeAccountsExcept(keep, n, { auth, fetchImpl: deps.fetchImpl });
      }
      case "sign-in-move": {
        const store = prismaAuthStore();
        if (flags.notify !== true) return await signInMoveReport(store);
        return await sendSignInNotices({ store, mailer: selfHostDeps(pool).mailer, appUrl: env().APP_URL, dryRun: flags["dry-run"] === true });
      }
      default:
        throw new Error(`Unknown command "${command}". See the comment at the top of apps/aws/src/admin.ts.`);
    }
  } finally {
    await pool.end().catch(() => {});
    await disconnectDb().catch(() => {});
  }
}

run(process.argv.slice(2)).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  },
  (err: unknown) => {
    logger.error({ err }, "admin command failed");
    process.exit(1);
  },
);
