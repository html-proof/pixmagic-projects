import { z } from "zod";
import { withTenant } from "@app/db";
import { customCategoryInput, expenseInput, expenseSettingsInput, expenseTotals, isDay, localDay, MAX_EXPENSE_AMOUNT, MAX_EXPENSES, nextDue, type DateRange, type Expense } from "@app/shared";
import {
  audit,
  createCategory,
  createExpense,
  dayFigures,
  deleteCategory,
  deleteExpense,
  deleteExpenses,
  endExpense,
  expenseHistory,
  expensePayments,
  expenseSettings,
  expenseTerms,
  listCategories,
  listExpenses,
  logger,
  pauseExpense,
  resumeExpense,
  saveExpenseSettings,
  savePayment,
  updateCategory,
  updateExpense,
} from "@app/core";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";

/**
 * A store's own costs (Profit & Loss and Settings → Costs, docs/kpis.md "Costs and net profit").
 * Reading them needs finance.breakdown (Shopify's cost of goods sold beside them needs "View costs and
 * stock value" too); changing them needs "Manage costs" (finance.costs: owners and admins, and the
 * members they gave it to), as they change what the whole team's dashboard says. Every change is in
 * the audit log with what it was before. A shared link and a workspace API key never change them
 * (routeAccess.test.ts).
 */
export function expenseRoutes(app: App, deps: Deps) {
  /** The store whose costs these are, in this workspace (404 otherwise: ids can't be probed). Before any input is read. */
  const storeOf = async (ws: string, storeId: string) => {
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true, currency: true, timezone: true } }));
    if (!store) throw new HttpError(404, "Not found", "not_found");
    return { ...store, today: localDay(new Date(), store.timezone) };
  };

  const record = (c: Parameters<typeof clientIp>[0], ws: string, userId: string | null, action: string, targetId: string, metadata: Record<string, unknown>, targetType = "store_expense") =>
    audit({ workspaceId: ws, actorUserId: userId, action, targetType, targetId, metadata, ip: clientIp(c) }).catch((err: unknown) => logger.warn({ err }, "audit failed"));

  /** What an audit entry keeps of a cost: its terms, never its free text (description, note). */
  const terms = (e: Expense) => ({
    name: e.name,
    category: e.category,
    method: e.method,
    amount: e.amount,
    percentBase: e.percentBase,
    cadence: e.cadence,
    startsOn: e.startsOn,
    endsOn: e.endsOn,
    pausedFrom: e.pausedFrom,
    vendor: e.vendor,
  });

  const notFound = () => new HttpError(404, "Not found", "not_found");

  /**
   * Every cost the store keeps (each with its next payment), the store's own categories, from which
   * day the list is complete, the store's currency (costs are entered in it), and what the costs come
   * to this month so far, for the page's summary.
   */
  app.get("/workspaces/:ws/stores/:storeId/expenses", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "finance.breakdown");
    const store = await storeOf(ws, storeId);
    const scope = { ws, storeId };
    const thisMonth: DateRange = { from: `${store.today.slice(0, 8)}01`, to: store.today };
    const [expenses, categories, settings, costs, figures] = await withTenant(ws, (tx) =>
      Promise.all([listExpenses(tx, scope), listCategories(tx, scope), expenseSettings(tx, scope), expenseTerms(tx, scope), dayFigures(tx, scope, thisMonth)]),
    );
    return c.json({
      currency: store.currency,
      today: store.today,
      expenses: expenses.map((e) => ({ ...e, nextDue: nextDue(e, store.today) })),
      categories,
      settings,
      thisMonth: { ...thisMonth, ...expenseTotals(costs.costs, thisMonth, settings.operatingWeekdays, figures) },
    });
  });

  app.post("/workspaces/:ws/stores/:storeId/expenses", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    const store = await storeOf(ws, storeId);
    const input = expenseInput.parse(await body(c));
    const saved = await withTenant(ws, (tx) => createExpense(tx, { ws, storeId }, input, a.user?.id ?? null, store));
    await record(c, ws, a.user?.id ?? null, "expense.added", saved.id, { storeId, ...terms(saved) });
    return c.json({ expense: { ...saved, nextDue: nextDue(saved, store.today) } }, 201);
  });

  /** Several costs removed at once (the costs list's "Remove selected"); each in the audit log. Before /:id. */
  app.post("/workspaces/:ws/stores/:storeId/expenses/bulk-delete", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    await storeOf(ws, storeId);
    const { ids } = z
      .object({ ids: z.array(z.string().min(1).max(40)).min(1).max(MAX_EXPENSES) })
      .strict()
      .parse(await body(c));
    const removed = await withTenant(ws, (tx) => deleteExpenses(tx, { ws, storeId }, [...new Set(ids)]));
    for (const e of removed) await record(c, ws, a.user?.id ?? null, "expense.removed", e.id, { storeId, ...terms(e) });
    return c.json({ removed: removed.map((e) => e.id) });
  });

  /**
   * From which day the list holds every cost (null: take it back), and the days the store is open
   * (its recurring costs are spread over those), either or both. Before /:id, so "settings" is never
   * taken for an id.
   */
  app.put("/workspaces/:ws/stores/:storeId/expenses/settings", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    await storeOf(ws, storeId);
    const input = expenseSettingsInput.parse(await body(c));
    const { saved, before } = await withTenant(ws, (tx) => saveExpenseSettings(tx, { ws, storeId }, input, a.user?.id ?? null));
    const log = (action: string, metadata: Record<string, unknown>) =>
      audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action, targetType: "store", targetId: storeId, metadata, ip: clientIp(c) }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
    if (input.completeFrom !== undefined) await log("expenses.completeness_changed", { before: before.completeFrom, after: saved.completeFrom });
    if (input.operatingWeekdays !== undefined) await log("expenses.operating_days_changed", { before: before.operatingWeekdays, after: saved.operatingWeekdays });
    return c.json({ settings: saved });
  });

  /**
   * Replaces a cost. `?apply=next` keeps the payments of a recurring cost already recorded as they
   * were paid: the change takes effect from its next payment, as a new cost taking over from this one
   * (updateExpense in core). Without it (`all`), the change applies to every date.
   */
  app.put("/workspaces/:ws/stores/:storeId/expenses/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    const store = await storeOf(ws, storeId);
    const { apply } = z.object({ apply: z.enum(["next", "all"]).default("all") }).parse(c.req.query());
    const input = expenseInput.parse(await body(c));
    const changed = await withTenant(ws, (tx) => updateExpense(tx, { ws, storeId }, id, input, a.user?.id ?? null, store, apply));
    if (!changed) throw notFound();
    if (changed.replaced) {
      await record(c, ws, a.user?.id ?? null, "expense.ended", id, { storeId, reason: "changed_from_next_payment", endsOn: changed.saved.startsOn, replacedBy: changed.saved.id });
      await record(c, ws, a.user?.id ?? null, "expense.added", changed.saved.id, { storeId, replaces: id, before: terms(changed.before), ...terms(changed.saved) });
    } else {
      await record(c, ws, a.user?.id ?? null, "expense.changed", id, { storeId, before: terms(changed.before), after: terms(changed.saved) });
    }
    return c.json({ expense: { ...changed.saved, nextDue: nextDue(changed.saved, store.today) }, replaced: changed.replaced });
  });

  app.delete("/workspaces/:ws/stores/:storeId/expenses/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    await storeOf(ws, storeId);
    const removed = await withTenant(ws, (tx) => deleteExpense(tx, { ws, storeId }, id));
    if (!removed) throw notFound();
    await record(c, ws, a.user?.id ?? null, "expense.removed", id, { storeId, ...terms(removed) });
    return c.json({ ok: true });
  });

  /** Pauses a recurring cost from its next payment, resumes it, or ends it (`on`, by default the day before its next payment). */
  app.post("/workspaces/:ws/stores/:storeId/expenses/:id/:action{pause|resume|end}", async (c) => {
    const { ws, storeId, id, action } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    const store = await storeOf(ws, storeId);
    const scope = { ws, storeId };
    const userId = a.user?.id ?? null;
    if (action === "end") {
      const { on } = z
        .object({ on: z.string().refine(isDay, "Pick a real date (YYYY-MM-DD)").nullable().optional() })
        .strict()
        .parse(await body(c));
      const ended = await withTenant(ws, (tx) => endExpense(tx, scope, id, userId, store.today, on));
      if (!ended) throw notFound();
      await record(c, ws, userId, "expense.ended", id, { storeId, before: terms(ended.before), endsOn: ended.saved.endsOn });
      return c.json({ expense: { ...ended.saved, nextDue: nextDue(ended.saved, store.today) } });
    }
    const done = await withTenant(ws, (tx) => (action === "pause" ? pauseExpense(tx, scope, id, userId, store.today) : resumeExpense(tx, scope, id, userId, store.today)));
    if (!done) throw notFound();
    await record(c, ws, userId, action === "pause" ? "expense.paused" : "expense.resumed", id, {
      storeId,
      pausedFrom: action === "pause" ? done.saved.pausedFrom : done.before.pausedFrom,
      ...("skipped" in done ? { skipped: done.skipped } : {}),
    });
    return c.json({ expense: { ...done.saved, nextDue: nextDue(done.saved, store.today) } });
  });

  /** A recurring cost's payments: those recorded (paid, changed, skipped) and the next few to come. */
  app.get("/workspaces/:ws/stores/:storeId/expenses/:id/payments", async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, "finance.breakdown");
    const store = await storeOf(ws, storeId);
    const found = await withTenant(ws, (tx) => expensePayments(tx, { ws, storeId }, id, store.today));
    if (!found) throw notFound();
    return c.json({ currency: store.currency, today: store.today, ...found });
  });

  /** Changes one payment of a recurring cost (its amount, a note), skips it, or puts it back as the cost says (`reset`). */
  app.put("/workspaces/:ws/stores/:storeId/expenses/:id/payments/:due", async (c) => {
    const { ws, storeId, id, due } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    await storeOf(ws, storeId);
    if (!isDay(due)) throw notFound();
    const input = z
      .object({
        amount: z
          .number()
          .min(0)
          .max(MAX_EXPENSE_AMOUNT)
          .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Amounts go to the cent at most")
          .optional(),
        skipped: z.boolean().optional(),
        note: z.string().trim().max(500).nullable().optional(),
        reset: z.boolean().optional(),
      })
      .strict()
      .refine((x) => x.reset || x.amount !== undefined || x.skipped !== undefined || x.note !== undefined, "Nothing to save")
      .parse(await body(c));
    const saved = await withTenant(ws, (tx) => savePayment(tx, { ws, storeId }, id, due, input, a.user?.id ?? null));
    if (!saved) throw notFound();
    await record(c, ws, a.user?.id ?? null, "expense.payment_changed", id, {
      storeId,
      due,
      before: saved.before ? { amount: saved.before.amount, status: saved.before.status } : null,
      after: { amount: saved.saved.amount, status: saved.saved.status, scheduledAmount: saved.saved.scheduledAmount },
    });
    return c.json({ payment: saved.saved });
  });

  /** Who changed the cost and when, with what it was before (the audit log's entries for it). */
  app.get("/workspaces/:ws/stores/:storeId/expenses/:id/history", async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, "finance.breakdown");
    await storeOf(ws, storeId);
    const history = await withTenant(ws, (tx) => expenseHistory(tx, { ws, storeId }, id));
    if (!history) throw notFound();
    return c.json({ history });
  });

  /** The store's own cost categories. */
  app.post("/workspaces/:ws/stores/:storeId/expense-categories", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    await storeOf(ws, storeId);
    const input = customCategoryInput.parse(await body(c));
    const saved = await withTenant(ws, (tx) => createCategory(tx, { ws, storeId }, input, a.user?.id ?? null));
    await record(c, ws, a.user?.id ?? null, "expense_category.added", saved.id, { storeId, name: saved.name, section: saved.section }, "expense_category");
    return c.json({ category: saved }, 201);
  });

  app.put("/workspaces/:ws/stores/:storeId/expense-categories/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    await storeOf(ws, storeId);
    const input = customCategoryInput.parse(await body(c));
    const changed = await withTenant(ws, (tx) => updateCategory(tx, { ws, storeId }, id, input));
    if (!changed) throw notFound();
    await record(c, ws, a.user?.id ?? null, "expense_category.changed", id, { storeId, before: changed.before, after: changed.saved }, "expense_category");
    return c.json({ category: changed.saved });
  });

  app.delete("/workspaces/:ws/stores/:storeId/expense-categories/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.costs");
    await storeOf(ws, storeId);
    const removed = await withTenant(ws, (tx) => deleteCategory(tx, { ws, storeId }, id));
    if (!removed) throw notFound();
    await record(c, ws, a.user?.id ?? null, "expense_category.removed", id, { storeId, name: removed.name, section: removed.section }, "expense_category");
    return c.json({ ok: true });
  });
}
