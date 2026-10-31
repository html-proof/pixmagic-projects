import { withTenant } from "@app/db";
import { expenseInput, expenseSettingsInput, expenseTotals, localDay, type DateRange } from "@app/shared";
import { audit, createExpense, deleteExpense, expenseSettings, listExpenses, logger, saveExpenseSettings, updateExpense } from "@app/core";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";

/**
 * A store's own costs (Settings → Costs, docs/kpis.md "Costs and net profit"). Reading them needs
 * finance.breakdown (Shopify's cost of goods sold beside them needs "View costs and stock value"
 * too); changing them is for owners and
 * admins (stores:manage), as the store's sales calculation is: they change what the whole team's
 * dashboard says, and every change is in the audit log with what it was before. A shared link and a
 * workspace API key never change them (routeAccess.test.ts).
 */
export function expenseRoutes(app: App, deps: Deps) {
  /** The store whose costs these are, in this workspace (404 otherwise: ids can't be probed). */
  const storeOf = async (ws: string, storeId: string) => {
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true, currency: true, timezone: true } }));
    if (!store) throw new HttpError(404, "Not found", "not_found");
    return store;
  };

  const record = (c: Parameters<typeof clientIp>[0], ws: string, userId: string | null, action: string, targetId: string, metadata: Record<string, unknown>) =>
    audit({ workspaceId: ws, actorUserId: userId, action, targetType: "store_expense", targetId, metadata, ip: clientIp(c) }).catch((err: unknown) => logger.warn({ err }, "audit failed"));

  /** What an audit entry keeps of a cost: its terms, never the note (free text). */
  const terms = (e: { name: string; category: string; amount: number; cadence: string; startsOn: string; endsOn: string | null }) => ({
    name: e.name,
    category: e.category,
    amount: e.amount,
    cadence: e.cadence,
    startsOn: e.startsOn,
    endsOn: e.endsOn,
  });

  /**
   * Every cost the store keeps, from which day the list is complete, the store's currency (costs are
   * entered in it), and what the costs come to this month so far, for the page's summary.
   */
  app.get("/workspaces/:ws/stores/:storeId/expenses", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "finance.breakdown");
    const store = await storeOf(ws, storeId);
    const scope = { ws, storeId };
    const [expenses, settings] = await withTenant(ws, (tx) => Promise.all([listExpenses(tx, scope), expenseSettings(tx, scope)]));
    const today = localDay(new Date(), store.timezone);
    const thisMonth: DateRange = { from: `${today.slice(0, 8)}01`, to: today };
    return c.json({ currency: store.currency, today, expenses, settings, thisMonth: { ...thisMonth, ...expenseTotals(expenses, thisMonth) } });
  });

  app.post("/workspaces/:ws/stores/:storeId/expenses", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "stores:manage");
    await storeOf(ws, storeId);
    const input = expenseInput.parse(await body(c));
    const saved = await withTenant(ws, (tx) => createExpense(tx, { ws, storeId }, input, a.user?.id ?? null));
    await record(c, ws, a.user?.id ?? null, "expense.added", saved.id, { storeId, ...terms(saved) });
    return c.json({ expense: saved }, 201);
  });

  /** From which day the list holds every cost (null: take it back). Before /:id, so "settings" is never taken for an id. */
  app.put("/workspaces/:ws/stores/:storeId/expenses/settings", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "stores:manage");
    await storeOf(ws, storeId);
    const input = expenseSettingsInput.parse(await body(c));
    const { saved, before } = await withTenant(ws, (tx) => saveExpenseSettings(tx, { ws, storeId }, input, a.user?.id ?? null));
    await audit({
      workspaceId: ws,
      actorUserId: a.user?.id ?? null,
      action: "expenses.completeness_changed",
      targetType: "store",
      targetId: storeId,
      metadata: { before: before.completeFrom, after: saved.completeFrom },
      ip: clientIp(c),
    }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
    return c.json({ settings: saved });
  });

  app.put("/workspaces/:ws/stores/:storeId/expenses/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "stores:manage");
    await storeOf(ws, storeId);
    const input = expenseInput.parse(await body(c));
    const changed = await withTenant(ws, (tx) => updateExpense(tx, { ws, storeId }, id, input, a.user?.id ?? null));
    if (!changed) throw new HttpError(404, "Not found", "not_found");
    await record(c, ws, a.user?.id ?? null, "expense.changed", id, { storeId, before: terms(changed.before), after: terms(changed.saved) });
    return c.json({ expense: changed.saved });
  });

  app.delete("/workspaces/:ws/stores/:storeId/expenses/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "stores:manage");
    await storeOf(ws, storeId);
    const removed = await withTenant(ws, (tx) => deleteExpense(tx, { ws, storeId }, id));
    if (!removed) throw new HttpError(404, "Not found", "not_found");
    await record(c, ws, a.user?.id ?? null, "expense.removed", id, { storeId, ...terms(removed) });
    return c.json({ ok: true });
  });
}
