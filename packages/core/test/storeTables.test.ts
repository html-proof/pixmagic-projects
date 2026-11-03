import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * When a store's data goes but its row stays, nothing goes by cascade from the row, so every table
 * holding the store's rows has to be named: on the in-app Disconnect (purgeStoreData, persist.ts)
 * and on a move to another workspace (attachStore, apps/api/src/connectStore.ts), which purges so
 * the new workspace starts clean. shop/redact deletes the store row itself after the same purge,
 * and with it every table whose store relation cascades.
 *
 * Read from the source, without a database: each Prisma model with a `storeId` is removed by them
 * or is on a list below that says why not. A new store table fails here until it is placed
 * (2026-11-02: the marketing figures, costs and business events, newer than the purge, were found
 * left behind under the old workspace_id, and the marketing sync row held the next backfill back).
 */

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), "utf8");
const lowerFirst = (s: string) => s[0]!.toLowerCase() + s.slice(1);

/**
 * The Prisma models with a `storeId`, by their name on the client (`shopifyMarketingDay`), and for
 * each the models its rows go with (a relation with onDelete: Cascade). The store is left out of
 * those: here its row stays.
 */
function storeModels(schema: string): Map<string, string[]> {
  const models = new Map<string, string[]>();
  for (const [, name, fields] of schema.matchAll(/^model (\w+) \{\r?\n([\s\S]*?)^\}/gm)) {
    if (!/^[ \t]+storeId[ \t]/m.test(fields!)) continue;
    const parents = [...fields!.matchAll(/^[ \t]+\w+[ \t]+(\w+)\??[ \t]+@relation\([^\n]*onDelete: Cascade/gm)].map((m) => lowerFirst(m[1]!));
    models.set(lowerFirst(name!), parents.filter((p) => p !== "store"));
  }
  return models;
}

/** Comments out: a model named in one is not removed. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A top-level function's text, from its name to the brace that closes it at the start of a line. */
function functionText(source: string, name: string): string | null {
  const start = source.search(new RegExp(`function ${name}\\(`));
  if (start < 0) return null;
  return code(source.slice(start, source.indexOf("\n}", start)));
}

const coreSrc = root("packages/core/src");
const coreSources = (readdirSync(coreSrc, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(coreSrc, f), "utf8"));

/** A purge helper of @app/core (`purgeZapierStoreOps`), wherever it is defined. */
function helper(name: string): string {
  const found = coreSources.map((s) => functionText(s, name)).find((t) => t !== null);
  expect(found, `the purge helper ${name} isn't defined in packages/core/src`).toBeDefined();
  return found!;
}

/**
 * Removed after the purge's transaction by a call of its own rather than a deleteMany in it: the
 * model, and the call that removes it (which must be there).
 */
const REMOVED_BY_CALL: Record<string, string> = {
  // Sign-ins still waiting for their ad accounts, let go with their grants (adConnections/logins.ts).
  adLogin: "releaseAdLoginsWhere({ storeId }",
};

/**
 * The models `text` removes: its own deleteMany calls, those of the purge helpers it calls (their
 * operations spread into its transaction, or awaited), and the REMOVED_BY_CALL calls it makes.
 * With `carried`, also the models it hands to the new workspace (an updateMany of workspaceId).
 */
function removedBy(text: string, carried = false, seen = new Set<string>()): Set<string> {
  const out = new Set([...text.matchAll(/\b(?:systemDb|tx)\.(\w+)\.deleteMany\(/g)].map((m) => m[1]!));
  if (carried) for (const m of text.matchAll(/\b(?:systemDb|tx)\.(\w+)\.updateMany\(\{[^;]*?data: \{ workspaceId\b/g)) out.add(m[1]!);
  for (const [model, call] of Object.entries(REMOVED_BY_CALL)) if (text.includes(call)) out.add(model);
  for (const [, name] of text.matchAll(/\b(purge\w+)\(/g)) {
    if (seen.has(name!)) continue;
    seen.add(name!);
    for (const m of removedBy(helper(name!), false, seen)) out.add(m);
  }
  return out;
}

/** With the models whose rows go with theirs (onDelete: Cascade), all the way down. */
function withCascades(removed: Set<string>, models: Map<string, string[]>): Set<string> {
  const out = new Set(removed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [model, parents] of models) {
      if (!out.has(model) && parents.some((p) => out.has(p))) {
        out.add(model);
        grew = true;
      }
    }
  }
  return out;
}

/** Left by purgeStoreData: a Disconnect keeps the store row in its workspace, and these with it. */
const KEPT_ON_DISCONNECT = [
  // What the merchant entered: the store's costs, from when that list is complete, and its business
  // events. They are there again when the store is connected again; a move removes them.
  "storeExpense",
  "storeExpenseSettings",
  // Its own cost categories and its recurring costs' payments as they were paid.
  "expenseCategory",
  "expenseEntry",
  "businessEvent",
  // The store's import jobs. A move removes them, and so does shop/redact.
  "syncJob",
  // The bell leaves out a disconnected store's alerts. A move removes them (a privacy request's
  // follows the store), and so does shop/redact.
  "alert",
  // The email module's (purgeEmailStoreData): its customer records go on shop/redact and a move.
  "emailAutomationRule",
  "emailBusinessEvent",
  "emailMessage",
  // Customers' data requests still to be answered (Shopify gives 30 days): they follow the store
  // on a move, and shop/redact removes them.
  "dataRequest",
  // Shopify's deliveries to us (below).
  "webhookEvent",
];

/** Left by a move too, in the workspace the store leaves. */
const KEPT_ON_MOVE = [
  // The old workspace's own automation, switched off by purgeEmailStoreData: it holds no customer data.
  "emailAutomationRule",
  // Shopify's deliveries to us, kept by Shopify's webhook id so a redelivery is known, and read by
  // store, not workspace: which topics a store sends stays true. shop/redact unlinks them from it.
  "webhookEvent",
];

describe("a store's tables when its data goes but its row stays", () => {
  const models = storeModels(read("packages/db/prisma/schema.prisma"));
  const purge = helper("purgeStoreData");
  const connect = code(read("apps/api/src/connectStore.ts"));
  const moveFrom = connect.indexOf("if (existing && moving) {");
  const moving = connect.slice(moveFrom, connect.indexOf("} else if (existing) {", moveFrom));

  it("reads the schema and the purges", () => {
    for (const m of ["order", "shopifyMarketingDay", "storeExpense", "adCampaign"]) expect(models.has(m), m).toBe(true);
    expect(models.get("adCampaign")).toEqual(["adConnection"]);
    expect(moveFrom, "attachStore's move branch, `if (existing && moving) {`, not found").toBeGreaterThan(-1);
    expect(moving).toContain("purgeStoreData(existing.id");
    expect(removedBy(purge)).toContain("order");
  });

  it("Disconnect removes every store table but what the workspace keeps", () => {
    const removed = withCascades(removedBy(purge), models);
    expect([...models.keys()].filter((m) => !removed.has(m) && !KEPT_ON_DISCONNECT.includes(m)), "neither removed by purgeStoreData nor on KEPT_ON_DISCONNECT").toEqual([]);
    expect(KEPT_ON_DISCONNECT.filter((m) => removed.has(m) || !models.has(m)), "on KEPT_ON_DISCONNECT, but removed by purgeStoreData or not a store table").toEqual([]);
  });

  it("a move to another workspace leaves nothing of the store in the old one but what it names", () => {
    const removed = withCascades(removedBy(moving, true), models);
    expect([...models.keys()].filter((m) => !removed.has(m) && !KEPT_ON_MOVE.includes(m)), "neither removed or carried by the move nor on KEPT_ON_MOVE").toEqual([]);
    expect(KEPT_ON_MOVE.filter((m) => removed.has(m) || !models.has(m)), "on KEPT_ON_MOVE, but handled by the move or not a store table").toEqual([]);
  });

  it("removes Shopify's marketing figures on both, and what the merchant entered only on a move", () => {
    const disconnect = removedBy(purge);
    const move = removedBy(moving, true);
    for (const m of ["shopifyMarketingDay", "shopifyMarketingSync"]) expect(disconnect.has(m) && move.has(m), m).toBe(true);
    for (const m of ["storeExpense", "storeExpenseSettings", "expenseCategory", "businessEvent", "emailBusinessEvent", "emailMessage", "alert"]) {
      expect([m, disconnect.has(m), move.has(m)]).toEqual([m, false, true]);
    }
  });
});
