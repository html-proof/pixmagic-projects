import { systemDb, withTenant, type ExpenseCategory as CategoryRow, type ExpenseEntry, type StoreExpense, type Tx } from "@app/db";
import {
  addDays,
  categorySection,
  customCategoryId,
  delta,
  dueOccurrences,
  expenseInRange,
  expensesComplete,
  expenseTotals,
  isCustomCategoryKey,
  localDay,
  MAX_CUSTOM_CATEGORIES,
  MAX_EXPENSES,
  nextDue,
  occurrences,
  sectionOfCost,
  type Comparison,
  type CustomCategory,
  type CustomCategoryInput,
  type DateRange,
  type DayFigures,
  type Expense,
  type ExpenseInput,
  type ExpenseSection,
  type ExpenseSettingsInput,
  type ProfitCost,
} from "@app/shared";
import { AppError } from "./errors.js";
import { dailyRows } from "./reports/sales.js";

/**
 * A store's own costs (Profit & Loss and Settings → Costs, docs/kpis.md "Costs and net profit"): the
 * costs the owner enters, the categories they make for them, each payment of a recurring cost once it
 * has fallen due, and from which day they say the list holds every cost. Only the owner's own figures
 * are kept; the profit and loss spreads each over the days it covers (@app/shared/expenses).
 *
 * `tx` is a tenant transaction (`withTenant`): RLS keeps every workspace to its own stores, and the
 * workspace is in every filter as well.
 */

export class ExpenseError extends AppError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
    this.name = "ExpenseError";
  }
}

type Scope = { ws: string; storeId: string };
/** What saving a cost needs to know of its store: its currency (costs are kept in it) and its today. */
export type ExpenseContext = { currency: string; today: string };

const store = (scope: Scope) => ({ workspaceId: scope.ws, storeId: scope.storeId });
const money = (n: unknown) => Number(n);

function fromRow(r: StoreExpense): Expense {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    method: r.method as Expense["method"],
    amount: money(r.amount),
    percentBase: r.percentBase as Expense["percentBase"],
    currency: r.currency,
    cadence: r.cadence as Expense["cadence"],
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    pausedFrom: r.pausedFrom,
    vendor: r.vendor,
    paymentMethod: r.paymentMethod,
    note: r.note,
    replacesId: r.replacesId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const categoryOf = (r: CategoryRow): CustomCategory => ({ id: r.id, name: r.name, section: r.section as ExpenseSection });

/** The store's costs, those still running first, then the latest to start. */
export async function listExpenses(tx: Tx, scope: Scope): Promise<Expense[]> {
  const rows = await tx.storeExpense.findMany({ where: store(scope), orderBy: [{ startsOn: "desc" }, { createdAt: "desc" }] });
  return rows.map(fromRow).sort((a, b) => Number(a.endsOn !== null) - Number(b.endsOn !== null));
}

/** The categories the store made, by name. */
export async function listCategories(tx: Tx, scope: Scope): Promise<CustomCategory[]> {
  const rows = await tx.expenseCategory.findMany({ where: store(scope), orderBy: { name: "asc" } });
  return rows.map(categoryOf);
}

/** A name another category of the store already has, whatever its case. */
async function nameTaken(tx: Tx, scope: Scope, name: string, except?: string) {
  const rows = await tx.expenseCategory.findMany({ where: { ...store(scope), name: { equals: name, mode: "insensitive" }, ...(except ? { id: { not: except } } : {}) }, select: { id: true } });
  return rows.length > 0;
}

export async function createCategory(tx: Tx, scope: Scope, input: CustomCategoryInput, userId: string | null): Promise<CustomCategory> {
  const count = await tx.expenseCategory.count({ where: store(scope) });
  if (count >= MAX_CUSTOM_CATEGORIES) throw new ExpenseError(`A store makes up to ${MAX_CUSTOM_CATEGORIES} categories of its own. Remove one it no longer uses first.`, 409, "too_many_categories");
  if (await nameTaken(tx, scope, input.name)) throw new ExpenseError(`There's already a category called “${input.name}”.`, 409, "category_exists");
  return categoryOf(await tx.expenseCategory.create({ data: { ...store(scope), name: input.name, section: input.section, createdByUserId: userId } }));
}

/** Renames a category or moves it to another section (its costs move with it); null when the store has none by that id. */
export async function updateCategory(tx: Tx, scope: Scope, id: string, input: CustomCategoryInput): Promise<{ saved: CustomCategory; before: CustomCategory } | null> {
  const row = await tx.expenseCategory.findFirst({ where: { id, ...store(scope) } });
  if (!row) return null;
  if (await nameTaken(tx, scope, input.name, id)) throw new ExpenseError(`There's already a category called “${input.name}”.`, 409, "category_exists");
  const saved = await tx.expenseCategory.update({ where: { id: row.id }, data: { name: input.name, section: input.section } });
  return { saved: categoryOf(saved), before: categoryOf(row) };
}

/** Removes a category no cost uses; null when the store has none by that id. */
export async function deleteCategory(tx: Tx, scope: Scope, id: string): Promise<CustomCategory | null> {
  const row = await tx.expenseCategory.findFirst({ where: { id, ...store(scope) } });
  if (!row) return null;
  const used = await tx.storeExpense.count({ where: { ...store(scope), category: `custom:${id}` } });
  if (used > 0) throw new ExpenseError(`${used === 1 ? "A cost is" : `${used} costs are`} in this category. Move ${used === 1 ? "it" : "them"} to another category, or remove ${used === 1 ? "it" : "them"}, first.`, 409, "category_in_use");
  await tx.expenseCategory.delete({ where: { id: row.id } });
  return categoryOf(row);
}

/** A cost names a category the store has, in the store's currency. */
async function check(tx: Tx, scope: Scope, input: ExpenseInput, ctx: ExpenseContext) {
  if (input.currency !== null && input.currency !== ctx.currency) {
    throw new ExpenseError(`Costs are kept in the store's currency, ${ctx.currency}: bizinsights doesn't convert them. Enter it in ${ctx.currency}.`, 400, "currency_mismatch");
  }
  if (isCustomCategoryKey(input.category)) {
    const found = await tx.expenseCategory.count({ where: { id: customCategoryId(input.category)!, ...store(scope) } });
    if (!found) throw new ExpenseError("That category isn't one of this store's any more. Pick another.", 400, "unknown_category");
  }
}

/** What is saved of an input: the store's currency when none was said. */
const dataOf = (input: ExpenseInput, ctx: ExpenseContext) => ({ ...input, currency: input.currency ?? ctx.currency });

export async function createExpense(tx: Tx, scope: Scope, input: ExpenseInput, userId: string | null, ctx: ExpenseContext): Promise<Expense> {
  const count = await tx.storeExpense.count({ where: store(scope) });
  if (count >= MAX_EXPENSES) throw new ExpenseError(`A store keeps up to ${MAX_EXPENSES} costs. Remove one that has ended, or end it, before adding another.`, 409, "too_many_expenses");
  await check(tx, scope, input, ctx);
  const row = await tx.storeExpense.create({ data: { ...store(scope), ...dataOf(input, ctx), createdByUserId: userId, updatedByUserId: userId } });
  await recordDuePayments(tx, scope, ctx.today, [row]);
  return fromRow(row);
}

/** The terms that decide when payments fall due and what they are: a change to any of them changes payments. */
const termsChanged = (a: Expense, b: ExpenseInput) => a.amount !== b.amount || a.cadence !== b.cadence || a.startsOn !== b.startsOn || a.method !== b.method || a.percentBase !== b.percentBase;

/**
 * Replaces a cost, whole; null when the store has no cost by that id. Returns what it replaced too
 * (for the audit log).
 *
 * `applyFrom` says what a change to a recurring amount's terms (amount, how often, its start) does
 * to its payments already recorded:
 *  - "next": they stay as they were paid. The cost ends the day before its next payment and a new
 *    cost with the new terms starts on that day (`replacesId`), so no month already reported changes;
 *  - "all": every payment, past ones too, takes the new terms (a payment changed one by one keeps its
 *    own amount, unless when it falls due changed).
 * Anything else (its name, category, notes...) changes the cost itself, past dates included.
 */
export async function updateExpense(
  tx: Tx,
  scope: Scope,
  id: string,
  input: ExpenseInput,
  userId: string | null,
  ctx: ExpenseContext,
  applyFrom: "next" | "all" = "all",
): Promise<{ saved: Expense; before: Expense; replaced: boolean } | null> {
  const row = await tx.storeExpense.findFirst({ where: { id, ...store(scope) } });
  if (!row) return null;
  await check(tx, scope, input, ctx);
  const before = fromRow(row);
  const recurring = before.method === "amount" && before.cadence !== "once";
  const next = recurring ? nextDue(before, ctx.today) : null;
  if (applyFrom === "next" && recurring && termsChanged(before, input) && before.startsOn <= ctx.today && next) {
    await recordDuePayments(tx, scope, ctx.today, [row]);
    await tx.storeExpense.update({ where: { id: row.id }, data: { endsOn: addDays(next, -1), updatedByUserId: userId } });
    const count = await tx.storeExpense.count({ where: store(scope) });
    if (count >= MAX_EXPENSES) throw new ExpenseError(`A store keeps up to ${MAX_EXPENSES} costs. Remove one that has ended before changing a cost from its next payment.`, 409, "too_many_expenses");
    const created = await tx.storeExpense.create({
      data: { ...store(scope), ...dataOf(input, ctx), startsOn: next, endsOn: input.endsOn && input.endsOn < next ? null : input.endsOn, replacesId: row.id, createdByUserId: userId, updatedByUserId: userId },
    });
    await recordDuePayments(tx, scope, ctx.today, [created]);
    return { saved: fromRow(created), before, replaced: true };
  }
  const saved = await tx.storeExpense.update({ where: { id: row.id }, data: { ...dataOf(input, ctx), updatedByUserId: userId } });
  if (before.cadence !== input.cadence || before.startsOn !== input.startsOn || input.method !== "amount" || input.cadence === "once") {
    // When payments fall due changed (or there are none any more): those recorded are no longer this cost's.
    await tx.expenseEntry.deleteMany({ where: { ...store(scope), expenseId: row.id } });
  } else if (before.amount !== input.amount) {
    await tx.expenseEntry.updateMany({ where: { ...store(scope), expenseId: row.id, editedAt: null }, data: { amount: input.amount, scheduledAmount: input.amount } });
  }
  if (input.endsOn) await tx.expenseEntry.deleteMany({ where: { ...store(scope), expenseId: row.id, dueOn: { gt: input.endsOn } } });
  await recordDuePayments(tx, scope, ctx.today, [saved]);
  return { saved: fromRow(saved), before, replaced: false };
}

/** Removes a cost and its recorded payments; null when the store has no cost by that id. */
export async function deleteExpense(tx: Tx, scope: Scope, id: string): Promise<Expense | null> {
  const row = await tx.storeExpense.findFirst({ where: { id, ...store(scope) } });
  if (!row) return null;
  await tx.storeExpense.delete({ where: { id: row.id } });
  return fromRow(row);
}

/** Removes several costs at once; returns those removed (ids the store doesn't have are left out). */
export async function deleteExpenses(tx: Tx, scope: Scope, ids: readonly string[]): Promise<Expense[]> {
  const rows = await tx.storeExpense.findMany({ where: { id: { in: [...ids] }, ...store(scope) } });
  if (rows.length) await tx.storeExpense.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, ...store(scope) } });
  return rows.map(fromRow);
}

async function recurringRow(tx: Tx, scope: Scope, id: string) {
  const row = await tx.storeExpense.findFirst({ where: { id, ...store(scope) } });
  if (!row) return null;
  if (row.method !== "amount" || row.cadence === "once") throw new ExpenseError("Only a cost paid every day, week, month… can be paused or resumed. Give this one an end date instead.", 409, "not_recurring");
  return row;
}

/** Pauses a recurring cost from its next payment on (those already due stay); null when the store has no cost by that id. */
export async function pauseExpense(tx: Tx, scope: Scope, id: string, userId: string | null, today: string): Promise<{ saved: Expense; before: Expense } | null> {
  const row = await recurringRow(tx, scope, id);
  if (!row) return null;
  const before = fromRow(row);
  if (before.pausedFrom) throw new ExpenseError("It's already paused.", 409, "already_paused");
  const next = nextDue(before, today);
  if (!next) throw new ExpenseError("It has no payment left to pause: it has ended.", 409, "not_running");
  await recordDuePayments(tx, scope, today, [row]);
  const saved = await tx.storeExpense.update({ where: { id: row.id }, data: { pausedFrom: next, updatedByUserId: userId } });
  return { saved: fromRow(saved), before };
}

/**
 * Resumes a paused cost: the payments that would have fallen due while it was paused are recorded as
 * skipped, so none of them counts; the next one falls due as before. Null when the store has no cost by that id.
 */
export async function resumeExpense(tx: Tx, scope: Scope, id: string, userId: string | null, today: string): Promise<{ saved: Expense; before: Expense; skipped: number } | null> {
  const row = await recurringRow(tx, scope, id);
  if (!row) return null;
  const before = fromRow(row);
  if (!before.pausedFrom) throw new ExpenseError("It isn't paused.", 409, "not_paused");
  const missed = before.pausedFrom < today ? occurrences({ ...before, pausedFrom: null }, before.pausedFrom, addDays(today, -1)).filter((o) => o.due >= before.pausedFrom! && o.due < today) : [];
  if (missed.length) {
    await tx.expenseEntry.createMany({
      data: missed.map((o) => ({ ...store(scope), expenseId: row.id, dueOn: o.due, amount: 0, scheduledAmount: o.amount, status: "skipped", note: "Paused", editedByUserId: userId, editedAt: new Date() })),
      skipDuplicates: true,
    });
  }
  const saved = await tx.storeExpense.update({ where: { id: row.id }, data: { pausedFrom: null, updatedByUserId: userId } });
  await recordDuePayments(tx, scope, today, [saved]);
  return { saved: fromRow(saved), before, skipped: missed.length };
}

/**
 * Ends a recurring cost (cancels it): no payment falls due after `on`, by default the day before its
 * next payment, so the one paid last covers its days in full. Payments already recorded stay. Null
 * when the store has no cost by that id.
 */
export async function endExpense(tx: Tx, scope: Scope, id: string, userId: string | null, today: string, on?: string | null): Promise<{ saved: Expense; before: Expense } | null> {
  const row = await recurringRow(tx, scope, id);
  if (!row) return null;
  const before = fromRow(row);
  const next = nextDue({ ...before, pausedFrom: null }, today);
  const end = on ?? (before.pausedFrom ? addDays(before.pausedFrom, -1) : next ? addDays(next, -1) : today);
  if (end < before.startsOn) throw new ExpenseError("It hasn't started by then: remove it instead.", 409, "ends_before_start");
  if (before.endsOn && before.endsOn <= end) throw new ExpenseError("It already ends by then.", 409, "already_ended");
  await tx.expenseEntry.deleteMany({ where: { ...store(scope), expenseId: row.id, dueOn: { gt: end } } });
  const saved = await tx.storeExpense.update({ where: { id: row.id }, data: { endsOn: end, pausedFrom: null, updatedByUserId: userId } });
  return { saved: fromRow(saved), before };
}

/**
 * Records every payment of the store's recurring costs that has fallen due by `today` and isn't
 * recorded yet, at the cost's amount. Never twice: one row per cost and due day, and a row already
 * there (changed, or skipped) is left as it is, so a retry or a second sweep changes nothing.
 * `rows`: only these costs (one just saved); all the store's otherwise. Returns how many it recorded.
 */
export async function recordDuePayments(tx: Tx, scope: Scope, today: string, rows?: readonly StoreExpense[]): Promise<number> {
  const costs = rows ?? (await tx.storeExpense.findMany({ where: { ...store(scope), method: "amount", cadence: { not: "once" }, startsOn: { lte: today } } }));
  const recurring = costs.filter((c) => c.method === "amount" && c.cadence !== "once" && c.startsOn <= today);
  if (!recurring.length) return 0;
  const last = await tx.expenseEntry.groupBy({ by: ["expenseId"], where: { ...store(scope), expenseId: { in: recurring.map((c) => c.id) } }, _max: { dueOn: true } });
  const after = new Map(last.map((l) => [l.expenseId, l._max.dueOn]));
  const data = recurring.flatMap((c) => {
    const e = fromRow(c);
    const from = after.get(c.id);
    const due = from ? occurrences(e, from, today).filter((o) => o.due > from && o.due <= today) : dueOccurrences(e, today);
    return due.map((o) => ({ ...store(scope), expenseId: c.id, dueOn: o.due, amount: e.amount, scheduledAmount: e.amount }));
  });
  if (!data.length) return 0;
  const { count } = await tx.expenseEntry.createMany({ data, skipDuplicates: true });
  return count;
}

/**
 * Records the payments that have fallen due for every store with a recurring cost (the cron sweep every 15 minutes),
 * each on its own store-local today and in its own workspace's transaction. The stores are found in
 * the sweep's cross-tenant scope (systemDb).
 */
export async function recordDuePaymentsEverywhere(now = new Date()): Promise<{ stores: number; recorded: number }> {
  const stores = await systemDb.store.findMany({
    where: { expenses: { some: { method: "amount", cadence: { not: "once" }, pausedFrom: null } } },
    select: { id: true, workspaceId: true, timezone: true },
  });
  let recorded = 0;
  for (const s of stores) {
    recorded += await withTenant(s.workspaceId, (tx) => recordDuePayments(tx, { ws: s.workspaceId, storeId: s.id }, localDay(now, s.timezone)));
  }
  return { stores: stores.length, recorded };
}

/** A payment as the cost's page lists it. */
export interface ExpensePaymentView {
  due: string;
  /** The days it pays for: to the day before the next one (or the cost's end). */
  to: string;
  amount: number;
  /** What the cost said; differs from `amount` when the payment was changed one by one. */
  scheduledAmount: number;
  /** posted: recorded; skipped: recorded as not paid; upcoming: not due yet (or not recorded yet). */
  status: "posted" | "skipped" | "upcoming";
  edited: boolean;
  note: string | null;
}

const paymentOf = (r: ExpenseEntry, to: string): ExpensePaymentView => ({
  due: r.dueOn,
  to,
  amount: money(r.amount),
  scheduledAmount: money(r.scheduledAmount),
  status: r.status === "skipped" ? "skipped" : "posted",
  edited: r.editedAt !== null,
  note: r.note,
});

/** A recurring cost's payments: those recorded, newest first, and the next few to come. Null when the store has no cost by that id. */
export async function expensePayments(tx: Tx, scope: Scope, id: string, today: string, upcoming = 3): Promise<{ expense: Expense; payments: ExpensePaymentView[]; nextDue: string | null } | null> {
  const row = await tx.storeExpense.findFirst({ where: { id, ...store(scope) } });
  if (!row) return null;
  const expense = fromRow(row);
  const entries = await tx.expenseEntry.findMany({ where: { ...store(scope), expenseId: id }, orderBy: { dueOn: "desc" }, take: 400 });
  const terms = { ...expense, pausedFrom: null };
  const periodTo = (due: string) => occurrences(terms, due, due).find((o) => o.due === due)?.to ?? due;
  const recorded = entries.map((r) => paymentOf(r, periodTo(r.dueOn)));
  const next = nextDue(expense, today);
  const coming: ExpensePaymentView[] = [];
  for (let due = next; due && coming.length < upcoming; ) {
    const o = occurrences(expense, due, due).find((x) => x.due === due);
    if (!o) break;
    if (!entries.some((r) => r.dueOn === due)) coming.push({ due, to: o.to, amount: expense.amount, scheduledAmount: expense.amount, status: "upcoming", edited: false, note: null });
    due = nextDue(expense, due);
  }
  return { expense, payments: [...coming.reverse(), ...recorded], nextDue: next };
}

/**
 * Changes one payment of a recurring cost (its amount, a note), or skips it, keeping what the cost
 * said (`scheduledAmount`). A payment to come may be changed ahead of its day. `reset` puts it back to
 * the cost's amount. Null when the store has no cost by that id.
 */
export async function savePayment(
  tx: Tx,
  scope: Scope,
  id: string,
  due: string,
  input: { amount?: number; skipped?: boolean; note?: string | null; reset?: boolean },
  userId: string | null,
): Promise<{ saved: ExpensePaymentView; before: ExpensePaymentView | null } | null> {
  const row = await tx.storeExpense.findFirst({ where: { id, ...store(scope) } });
  if (!row) return null;
  const e = fromRow(row);
  if (e.method !== "amount" || e.cadence === "once") throw new ExpenseError("Only a recurring cost's payments are changed one by one: change the cost itself.", 409, "not_recurring");
  const o = occurrences({ ...e, pausedFrom: null }, due, due).find((x) => x.due === due);
  if (!o) throw new ExpenseError("No payment of this cost falls due on that day.", 404, "no_such_payment");
  const was = await tx.expenseEntry.findUnique({ where: { expenseId_dueOn: { expenseId: id, dueOn: due } } });
  const scheduled = was ? money(was.scheduledAmount) : e.amount;
  const data = input.reset
    ? { amount: scheduled, status: "posted", note: null, editedByUserId: null, editedAt: null }
    : {
        amount: input.skipped ? 0 : (input.amount ?? (was ? money(was.amount) : scheduled)),
        status: input.skipped ? "skipped" : "posted",
        note: input.note === undefined ? (was?.note ?? null) : input.note,
        editedByUserId: userId,
        editedAt: new Date(),
      };
  const saved = await tx.expenseEntry.upsert({
    where: { expenseId_dueOn: { expenseId: id, dueOn: due } },
    create: { ...store(scope), expenseId: id, dueOn: due, scheduledAmount: scheduled, ...data },
    update: data,
  });
  return { saved: paymentOf(saved, o.to), before: was ? paymentOf(was, o.to) : null };
}

/** A change to a cost, from the audit log: what it was before and after, by whom and when. */
export interface ExpenseHistoryEntry {
  id: string;
  action: string;
  at: string;
  /** The member's name, or their email address; null for bizinsights itself. */
  actor: string | null;
  detail: Record<string, unknown>;
}

/** A cost's changes, newest first, with those of the cost it took over from and of its payments. */
export async function expenseHistory(tx: Tx, scope: Scope, id: string, limit = 100): Promise<ExpenseHistoryEntry[] | null> {
  const row = await tx.storeExpense.findFirst({ where: { id, ...store(scope) }, select: { id: true, replacesId: true } });
  if (!row) return null;
  const ids = [row.id, ...(row.replacesId ? [row.replacesId] : [])];
  const rows = await tx.auditLog.findMany({ where: { workspaceId: scope.ws, targetType: "store_expense", targetId: { in: ids } }, orderBy: { createdAt: "desc" }, take: limit });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const actors = new Map<string, string>();
  if (actorIds.length) for (const u of await systemDb.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, displayName: true } })) actors.set(u.id, u.displayName ?? u.email);
  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const { storeId: _store, ...detail } = meta;
    return { id: r.id, action: r.action, at: r.createdAt.toISOString(), actor: r.actorUserId ? (actors.get(r.actorUserId) ?? null) : null, detail };
  });
}

/**
 * From which day the list holds every cost (null: the owner hasn't said), the weekdays the store is
 * open (empty: every day; its recurring costs are spread over those), and when that was last changed.
 */
export async function expenseSettings(tx: Tx, scope: Scope): Promise<{ completeFrom: string | null; operatingWeekdays: number[]; updatedAt: string | null }> {
  const row = await tx.storeExpenseSettings.findFirst({ where: store(scope) });
  return { completeFrom: row?.completeFrom ?? null, operatingWeekdays: row?.operatingWeekdays ?? [], updatedAt: row?.updatedAt.toISOString() ?? null };
}

/** Saves what `input` holds; what it leaves out stays as it was. */
export async function saveExpenseSettings(tx: Tx, scope: Scope, input: ExpenseSettingsInput, userId: string | null) {
  const before = await expenseSettings(tx, scope);
  const change = {
    ...(input.completeFrom !== undefined ? { completeFrom: input.completeFrom } : {}),
    ...(input.operatingWeekdays !== undefined ? { operatingWeekdays: input.operatingWeekdays } : {}),
    updatedByUserId: userId,
  };
  const row = await tx.storeExpenseSettings.upsert({
    where: { storeId: scope.storeId },
    create: { storeId: scope.storeId, workspaceId: scope.ws, ...change },
    update: change,
  });
  return { saved: { completeFrom: row.completeFrom, operatingWeekdays: row.operatingWeekdays, updatedAt: row.updatedAt.toISOString() }, before };
}

/**
 * The store's costs as the profit figures read them (no names or notes): each with the section its
 * category goes in and the payments recorded with another amount than its own (or skipped); with the
 * store's categories and its settings.
 */
export async function expenseTerms(tx: Tx, scope: Scope) {
  const [rows, entries, categories, settings] = await Promise.all([
    tx.storeExpense.findMany({ where: store(scope), select: { id: true, category: true, method: true, amount: true, percentBase: true, cadence: true, startsOn: true, endsOn: true, pausedFrom: true } }),
    tx.expenseEntry.findMany({ where: { ...store(scope), OR: [{ editedAt: { not: null } }, { status: "skipped" }] }, select: { expenseId: true, dueOn: true, amount: true } }),
    listCategories(tx, scope),
    expenseSettings(tx, scope),
  ]);
  const payments = new Map<string, Array<{ due: string; amount: number }>>();
  for (const p of entries) payments.set(p.expenseId, [...(payments.get(p.expenseId) ?? []), { due: p.dueOn, amount: money(p.amount) }]);
  const costs: ProfitCost[] = rows.map((r) => ({
    category: r.category,
    // A cost whose category was removed (it can't be while used) counts as a fixed cost, as `sectionOfCost` says.
    section: categorySection(r.category, categories) ?? sectionOfCost({ category: r.category }),
    method: r.method as ProfitCost["method"],
    amount: money(r.amount),
    percentBase: r.percentBase as ProfitCost["percentBase"],
    cadence: r.cadence as ProfitCost["cadence"],
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    pausedFrom: r.pausedFrom,
    ...(payments.has(r.id) ? { payments: payments.get(r.id) } : {}),
  }));
  return { costs, categories, completeFrom: settings.completeFrom, operatingWeekdays: settings.operatingWeekdays };
}

/** The store's sales day by day as the costs that follow them read them (a percentage, an amount per order or item). */
export async function dayFigures(tx: Tx, scope: Scope, range: DateRange): Promise<(day: string) => DayFigures | undefined> {
  const rows = await dailyRows(tx, scope.ws, scope.storeId, range);
  const byDay = new Map(
    rows.map((r) => {
      const netSales = r.grossSales - r.discounts - r.refunds;
      const revenue = Math.round((netSales + r.shipping + r.additionalFees) * 100) / 100;
      return [r.day, { totalSales: r.totalSales, revenue, netSales: Math.round(netSales * 100) / 100, orders: r.orders, units: r.units }];
    }),
  );
  return (day) => byDay.get(day);
}

/**
 * Whether this release's tables are in place. The deploy applies the migrations before the code goes
 * live (docs/database/migrations.md), but a release rolled back to leaves them in place either way;
 * this keeps the dashboard's answer whole if the code ever runs on a database without them (a query
 * of a missing table would fail the dashboard's whole answer, one transaction). Asked once per
 * process after they exist.
 */
let ready = false;
export async function expensesReady(tx: Tx): Promise<boolean> {
  if (ready) return true;
  const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT to_regclass('expense_entries') IS NOT NULL AS ok`;
  ready = row?.ok === true;
  return ready;
}

/**
 * The dashboard's costs module for the dates: the store's costs for them, by category and section,
 * those of the dates they're compared with, and whether the list holds every cost for them. Null
 * while the tables don't exist yet (expensesReady). In the store's currency: costs are entered in it.
 * `withTerms`: the Profit sheet's question, which adds every cost's terms (no names or notes) so the
 * sheet spreads them over its own columns.
 */
export async function expensesModule(tx: Tx, scope: Scope, currency: string, range: DateRange, previous: Comparison | null, opts: { withTerms?: boolean } = {}) {
  if (!(await expensesReady(tx))) return null;
  const { costs, categories, completeFrom, operatingWeekdays } = await expenseTerms(tx, scope);
  const follows = costs.some((c) => (c.method ?? "amount") !== "amount");
  const span = previous && previous.from < range.from ? { from: previous.from, to: range.to } : range;
  const figures = follows ? await dayFigures(tx, scope, span) : undefined;
  const current = expenseTotals(costs, range, operatingWeekdays, figures);
  // Costs are counted by whole days, so a comparison cut at a time of day takes its days whole.
  const before = previous ? expenseTotals(costs, previous, operatingWeekdays, figures) : null;
  return {
    currency,
    /** Every cost the store keeps, whether or not it falls in the dates. */
    count: costs.length,
    current,
    previous: before ? { total: before.total } : null,
    delta: before ? delta(current.total, before.total) : null,
    completeFrom,
    /** The list holds every cost for all of the dates (expensesComplete). */
    complete: expensesComplete(completeFrom, range),
    /** The weekdays the store is open (empty: every day): its recurring costs are spread over those. */
    operatingWeekdays,
    /** The store's own categories, for their names. */
    categories,
    ...(opts.withTerms ? { terms: costs } : {}),
  };
}

/** One line of the costs list for some dates (Profit & Loss → Expenses). */
export interface ExpenseLine {
  /** The cost's id, and the payment's due day for a recurring cost's payment. */
  key: string;
  expenseId: string;
  /**
   * one_time: a cost paid once; payment: a payment of a recurring cost (recorded, or to be recorded
   * on its day); rule: a cost that follows the sales, what it comes to over the dates.
   */
  kind: "one_time" | "payment" | "rule";
  /** The day it was paid or falls due; the first of the dates it counts on, for a rule. */
  date: string;
  /** The last day it counts on (a payment: the day before the next one). */
  to: string;
  name: string;
  category: string;
  section: ExpenseSection;
  vendor: string | null;
  paymentMethod: string | null;
  description: string | null;
  note: string | null;
  /** The amount: what was paid; what the rule comes to over the dates. */
  amount: number;
  /** A payment changed one by one: what the cost said. */
  scheduledAmount: number | null;
  status: "posted" | "skipped" | "upcoming" | "edited";
}

/**
 * Every cost of the owner's in the dates, a line each: those paid once on their day, each payment of
 * a recurring cost due in the dates (recorded as paid, changed or skipped, or still to be recorded on
 * its day), and what each cost that follows the sales comes to. Newest first.
 */
export async function expenseLines(tx: Tx, scope: Scope, range: DateRange, today: string): Promise<ExpenseLine[]> {
  const [rows, categories] = await Promise.all([tx.storeExpense.findMany({ where: { ...store(scope), startsOn: { lte: range.to }, OR: [{ endsOn: null }, { endsOn: { gte: range.from } }] } }), listCategories(tx, scope)]);
  const recurringIds = rows.filter((r) => r.method === "amount" && r.cadence !== "once").map((r) => r.id);
  const entries = recurringIds.length ? await tx.expenseEntry.findMany({ where: { ...store(scope), expenseId: { in: recurringIds }, dueOn: { gte: range.from, lte: range.to } } }) : [];
  const recorded = new Map(entries.map((e) => [`${e.expenseId}:${e.dueOn}`, e]));
  const figures = rows.some((r) => r.method !== "amount") ? await dayFigures(tx, scope, range) : undefined;
  const lines: ExpenseLine[] = [];
  for (const r of rows) {
    const e = fromRow(r);
    const base = {
      expenseId: e.id,
      name: e.name,
      category: e.category,
      section: categorySection(e.category, categories) ?? sectionOfCost(e),
      vendor: e.vendor,
      paymentMethod: e.paymentMethod,
      description: e.description,
      note: e.note,
    };
    if (e.method !== "amount") {
      const from = e.startsOn > range.from ? e.startsOn : range.from;
      const to = e.endsOn && e.endsOn < range.to ? e.endsOn : range.to;
      lines.push({ ...base, key: e.id, kind: "rule", date: from, to: to > today ? today : to, amount: expenseInRange(e, range, [], figures), scheduledAmount: null, status: "posted" });
    } else if (e.cadence === "once") {
      if (e.startsOn >= range.from && e.startsOn <= range.to) lines.push({ ...base, key: e.id, kind: "one_time", date: e.startsOn, to: e.startsOn, amount: e.amount, scheduledAmount: null, status: e.startsOn > today ? "upcoming" : "posted" });
    } else {
      for (const o of occurrences({ ...e, pausedFrom: null }, range.from, range.to)) {
        if (o.due < range.from || o.due > range.to) continue;
        const entry = recorded.get(`${e.id}:${o.due}`);
        if (!entry && e.pausedFrom && o.due >= e.pausedFrom) continue;
        const amount = entry ? money(entry.amount) : e.amount;
        const status = entry ? (entry.status === "skipped" ? "skipped" : entry.editedAt ? "edited" : "posted") : o.due > today ? "upcoming" : "posted";
        lines.push({ ...base, key: `${e.id}:${o.due}`, kind: "payment", date: o.due, to: o.to, amount, scheduledAmount: entry && entry.editedAt ? money(entry.scheduledAmount) : null, status, note: entry?.note ?? e.note });
      }
    }
  }
  return lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));
}
