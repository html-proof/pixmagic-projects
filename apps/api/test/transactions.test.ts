import { afterAll, describe, expect, it } from "vitest";
import { disconnectDb, systemDb, withTenant } from "@app/db";

afterAll(async () => disconnectDb());

/**
 * Pages run queries in parallel inside one transaction (Promise.all over `tx`, as the WhatsApp
 * overview does). Prisma batches the findUniques among them and sent the batch's statements at once
 * on the transaction's one connection: pg queued them, with a DeprecationWarning (pg@9 refuses
 * instead) that Lambda logged at ERROR level ~50 times in two days, feeding the error-lines alarms.
 * Node prints a deprecation once per process, and Vitest gives each test file its own: keep this
 * the only file here that looks for it.
 */
describe("a transaction's statements", () => {
  it("reach its connection one at a time, however the code issues them", async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.message);
    process.on("warning", onWarning);
    try {
      const ws = await systemDb.workspace.create({ data: { name: "W" } });
      // The tenant role's transaction (RLS), shaped like the WhatsApp overview's.
      const page = await withTenant(ws.id, (tx) =>
        Promise.all([
          tx.workspace.findUnique({ where: { id: ws.id } }),
          tx.waSettings.findUnique({ where: { storeId: "none" } }),
          tx.waConnection.findUnique({ where: { storeId: "none" } }),
          tx.waTemplate.findMany({ where: { storeId: "none" } }),
          tx.waMessage.count({ where: { storeId: "none" } }),
        ]),
      );
      expect(page).toEqual([expect.objectContaining({ id: ws.id }), null, null, [], 0]);
      // A statement that fails still fails its transaction, and the next one runs normally.
      await expect(
        systemDb.$transaction(async (tx) => Promise.all([tx.workspace.findUnique({ where: { id: ws.id } }), tx.$queryRaw`SELECT 1/0`, tx.store.findUnique({ where: { id: "x" } })])),
      ).rejects.toThrow(/division by zero/);
      expect(await systemDb.$transaction(async (tx) => Promise.all([tx.workspace.findUnique({ where: { id: ws.id } }), tx.store.findUnique({ where: { id: "x" } }), tx.user.findUnique({ where: { id: "x" } })]))).toEqual([
        expect.objectContaining({ id: ws.id }),
        null,
        null,
      ]);
      // Node emits a warning on a later tick.
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off("warning", onWarning);
      await systemDb.workspace.deleteMany({ where: { name: "W" } });
    }
    expect(warnings.filter((m) => m.includes("already executing a query"))).toEqual([]);
  });
});
