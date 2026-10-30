import type { StoreExpense, Tx } from "@app/db";
import { delta, expensesComplete, expenseTotals, MAX_EXPENSES, type Comparison, type DateRange, type Expense, type ExpenseCategory, type ExpenseInput, type ExpenseSettingsInput } from "@app/shared";
import { AppError } from "./errors.js";

/**
 * A store's own costs (Settings → Costs, docs/kpis.md "Costs and net profit"): the costs the owner
 * enters, and from which day they say the list holds every one. Only the owner's own figures are
 * kept; the dashboard spreads each over the days it covers (@app/shared/expenses).
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

function fromRow(r: StoreExpense): Expense {
  return {
    id: r.id,
    name: r.name,
    category: r.category as ExpenseCategory,
    amount: Number(r.amount),
    cadence: r.cadence as Expense["cadence"],
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The store's costs, those still running first, then the latest to start. */
export async function listExpenses(tx: Tx, scope: Scope): Promise<Expense[]> {
  const rows = await tx.storeExpense.findMany({ where: { workspaceId: scope.ws, storeId: scope.storeId }, orderBy: [{ startsOn: "desc" }, { createdAt: "desc" }] });
  return rows.map(fromRow).sort((a, b) => Number(a.endsOn !== null) - Number(b.endsOn !== null));
}

/** From which day the list holds every cost (null: the owner hasn't said), and when that was last changed. */
export async function expenseSettings(tx: Tx, scope: Scope): Promise<{ completeFrom: string | null; updatedAt: string | null }> {
  const row = await tx.storeExpenseSettings.findFirst({ where: { workspaceId: scope.ws, storeId: scope.storeId } });
  return { completeFrom: row?.completeFrom ?? null, updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function createExpense(tx: Tx, scope: Scope, input: ExpenseInput, userId: string | null): Promise<Expense> {
  const count = await tx.storeExpense.count({ where: { workspaceId: scope.ws, storeId: scope.storeId } });
  if (count >= MAX_EXPENSES) throw new ExpenseError(`A store keeps up to ${MAX_EXPENSES} costs. Remove one that has ended, or end it, before adding another.`, 409, "too_many_expenses");
  const row = await tx.storeExpense.create({ data: { workspaceId: scope.ws, storeId: scope.storeId, ...input, createdByUserId: userId, updatedByUserId: userId } });
  return fromRow(row);
}

/** Replaces a cost, whole; null when the store has no cost by that id. Returns what it replaced too (for the audit log). */
export async function updateExpense(tx: Tx, scope: Scope, id: string, input: ExpenseInput, userId: string | null): Promise<{ saved: Expense; before: Expense } | null> {
  const row = await tx.storeExpense.findFirst({ where: { id, workspaceId: scope.ws, storeId: scope.storeId } });
  if (!row) return null;
  const saved = await tx.storeExpense.update({ where: { id: row.id }, data: { ...input, updatedByUserId: userId } });
  return { saved: fromRow(saved), before: fromRow(row) };
}

/** Removes a cost; null when the store has no cost by that id. */
export async function deleteExpense(tx: Tx, scope: Scope, id: string): Promise<Expense | null> {
  const row = await tx.storeExpense.findFirst({ where: { id, workspaceId: scope.ws, storeId: scope.storeId } });
  if (!row) return null;
  await tx.storeExpense.delete({ where: { id: row.id } });
  return fromRow(row);
}

export async function saveExpenseSettings(tx: Tx, scope: Scope, input: ExpenseSettingsInput, userId: string | null) {
  const before = await expenseSettings(tx, scope);
  const row = await tx.storeExpenseSettings.upsert({
    where: { storeId: scope.storeId },
    create: { storeId: scope.storeId, workspaceId: scope.ws, completeFrom: input.completeFrom, updatedByUserId: userId },
    update: { completeFrom: input.completeFrom, updatedByUserId: userId },
  });
  return { saved: { completeFrom: row.completeFrom, updatedAt: row.updatedAt.toISOString() }, before };
}

/**
 * Whether this release's tables are in place. The deploy swaps the code before it runs the
 * migrations (docs/database/migrations.md), so for a minute or two the code can run on a database
 * without them; a query of a missing table would fail the dashboard's whole answer (one
 * transaction), so the dashboard leaves the costs out until they exist. Asked once per process
 * after they do.
 */
let ready = false;
export async function expensesReady(tx: Tx): Promise<boolean> {
  if (ready) return true;
  const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT to_regclass('store_expense_settings') IS NOT NULL AS ok`;
  ready = row?.ok === true;
  return ready;
}

/**
 * The dashboard's costs module for the dates: the store's costs for them, by category, those of the
 * dates they're compared with, and whether the list holds every cost for them. Null while the
 * tables don't exist yet (expensesReady). In the store's currency: costs are entered in it.
 */
export async function expensesModule(tx: Tx, scope: Scope, currency: string, range: DateRange, previous: Comparison | null) {
  if (!(await expensesReady(tx))) return null;
  const [rows, settings] = await Promise.all([
    tx.storeExpense.findMany({ where: { workspaceId: scope.ws, storeId: scope.storeId }, select: { category: true, amount: true, cadence: true, startsOn: true, endsOn: true } }),
    expenseSettings(tx, scope),
  ]);
  const list = rows.map((r) => ({ category: r.category as ExpenseCategory, amount: Number(r.amount), cadence: r.cadence as Expense["cadence"], startsOn: r.startsOn, endsOn: r.endsOn }));
  const current = expenseTotals(list, range);
  // Costs are counted by whole days, so a comparison cut at a time of day takes its days whole.
  const before = previous ? expenseTotals(list, previous) : null;
  return {
    currency,
    /** Every cost the store keeps, whether or not it falls in the dates. */
    count: rows.length,
    current,
    previous: before ? { total: before.total } : null,
    delta: before ? delta(current.total, before.total) : null,
    completeFrom: settings.completeFrom,
    /** The list holds every cost for all of the dates (expensesComplete). */
    complete: expensesComplete(settings.completeFrom, range),
  };
}
