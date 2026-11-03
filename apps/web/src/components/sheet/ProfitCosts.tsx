"use client";
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { categoryLabel, categorySection, EXPENSE_GROUP_LABEL, EXPENSE_GROUPS, EXPENSE_SECTION_LABEL, expenseInRange, groupOfSection, type CustomCategory, type Expense, type ExpenseGroup, type ExpenseSection } from "@app/shared/expenses";
import type { ProfitLoss } from "@app/shared/profit";
import { ConfirmDialog, Dialog, useAction } from "@/components/AppUi";
import { BarRow, StackedBar } from "@/components/dashboard/Charts";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtDay, fmtLongDay, fmtMoneyCompact, fmtMonth, weekdayNames } from "@/components/dashboard/format";
import { ApplyChoice, asksApplyFrom, blankCost, changesPayments, CostFields, draftOf, inputOf, termsOf, whenOf, type CostDraft } from "@/components/costs/CostForm";
import { api, fmtMoney, friendlyError, liveDataChanged } from "@/lib/api";
import { monthPeriods } from "./ProfitCharts";
import type { ProfitAnswer, ProfitState } from "./useProfit";

// ---------------------------------------------------------------------------
// Where the money went in the month (docs/kpis.md "Profit and loss"): fixed, variable and below
// operating profit, the biggest costs, how they've moved month by month, and the owner's costs
// themselves, which owners and admins add, change and remove here as in Settings → Costs (the same
// API, the same rules). How fixed costs are spread (every day, or the days the store is open) and
// whether the list is complete are set here too.
// ---------------------------------------------------------------------------

/** A new cost of a group starts in its usual category, paid as it usually is. */
const STARTS: Record<ExpenseGroup, { category: Expense["category"]; cadence: Expense["cadence"]; label: string }> = {
  fixed: { category: "rent", cadence: "monthly", label: "Add a fixed cost" },
  variable: { category: "packaging", cadence: "once", label: "Add a variable cost" },
  non_operating: { category: "interest", cadence: "monthly", label: "Add interest or tax" },
};

const SEGMENT_FILL = { products: "bg-info", ads: "bg-violet", variable: "bg-warn", fixed: "bg-accent", non_operating: "bg-rose" } as const;

export function ExpenseBreakdown({ p, data, day }: { p: ProfitState; data: ProfitAnswer; day: ProfitLoss }) {
  const t = data.total;
  const money = (n: number) => fmtMoney(n, data.currency);
  const segments = [
    ...(t.productCosts !== null ? [{ label: "Product costs", value: t.productCosts, fill: SEGMENT_FILL.products }] : []),
    ...(t.adSpend !== null && t.adSpend > 0 ? [{ label: "Ad spend", value: t.adSpend, fill: SEGMENT_FILL.ads }] : []),
    { label: "Your variable costs", value: t.yours.byGroup.variable, fill: SEGMENT_FILL.variable },
    { label: "Fixed costs", value: t.fixedCosts, fill: SEGMENT_FILL.fixed },
    { label: "Interest, tax, depreciation", value: t.belowOperating, fill: SEGMENT_FILL.non_operating },
  ];
  const ranked = [
    ...(t.productCosts !== null && t.productCosts > 0 ? [{ key: "products", label: "Product costs", group: "Variable costs", amount: t.productCosts }] : []),
    ...(t.adSpend !== null && t.adSpend > 0 ? [{ key: "ads", label: "Ad spend", group: "Variable costs", amount: t.adSpend }] : []),
    ...t.yours.byCategory.map((c) => ({ key: c.category, label: categoryLabel(c.category, data.categories), group: EXPENSE_SECTION_LABEL[c.section], amount: c.amount })),
  ].sort((a, b) => b.amount - a.amount);
  const top = ranked[0]?.amount ?? 0;
  const trend = data.trend;
  const periods = monthPeriods(trend, data.today);

  return (
    <section className="card min-w-0 animate-rise" aria-labelledby="profit-costs-h" data-testid="profit-expenses">
      <h3 id="profit-costs-h" className="font-semibold">
        Expense breakdown
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        {fmtMonth(data.month, { year: true })}
        {t.to < data.allocation.to ? " so far" : ""}: where the money went
      </p>

      <div className="mt-4">
        <StackedBar label="Costs by kind" segments={segments} format={money} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          {ranked.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium">Highest spending</h4>
              <ul className="mt-2 space-y-3" data-testid="profit-top-costs">
                {ranked.slice(0, 8).map((r) => (
                  <BarRow key={r.key} label={r.label} sub={r.group} value={money(r.amount)} fraction={top > 0 ? r.amount / top : 0} />
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted">No costs in these days yet.</p>
          )}
        </div>
        <div className="min-w-0">
          <h4 className="text-sm font-medium">Expense trend</h4>
          <p className="text-xs text-muted">Each month&apos;s costs; a month with a cost not known has no point for it.</p>
          <div className="mt-2">
            <LineChart
              days={trend.map((m) => `${m.month}-01`)}
              periods={periods}
              series={[
                { key: "variable", label: "Variable costs", color: "var(--warn)", values: trend.map((m) => m.variableCosts) },
                { key: "fixed", label: "Fixed costs", color: "var(--accent)", values: trend.map((m) => m.fixedCosts) },
                { key: "below", label: "Interest, tax, depreciation", color: "var(--danger)", values: trend.map((m) => m.belowOperating) },
              ]}
              format={money}
              fmtAxis={(v) => fmtMoneyCompact(v, data.currency)}
              label="Costs month by month"
              height={200}
            />
          </div>
        </div>
      </div>

      <CostsList p={p} data={data} day={day} />
    </section>
  );
}

/** The owner's costs that count in the month, by group, each with its share of the month and of the day looked at. */
function CostsList({ p, data, day }: { p: ProfitState; data: ProfitAnswer; day: ProfitLoss }) {
  const [editing, setEditing] = useState<{ id: string | null; draft: CostDraft; apply: "next" | "all" } | null>(null);
  const [removing, setRemoving] = useState<Expense | null>(null);
  const { busy, run } = useAction();
  const money = (n: number) => fmtMoney(n, data.currency);
  const open = data.setup.operatingWeekdays;
  const month = { from: data.allocation.from, to: data.allocation.to };
  const customs = p.costs?.categories ?? [];
  const groupOf = (e: Expense) => groupOfSection(categorySection(e.category, customs) ?? "fixed");
  // A cost that follows the sales has no amount of its own until the day's sales: it is listed with its terms.
  const list = (p.costs?.expenses ?? [])
    .map((e) => (e.method && e.method !== "amount" ? { e, month: null, day: null } : { e, month: expenseInRange(e, month, open), day: expenseInRange(e, { from: day.from, to: day.from }, open) }))
    .filter((x) => (x.month === null ? x.e.startsOn <= month.to && (!x.e.endsOn || x.e.endsOn >= month.from) : x.month !== 0));
  const editedCost = editing?.id ? (p.costs?.expenses.find((e) => e.id === editing.id) ?? null) : null;
  async function createCategory(name: string, section: ExpenseSection): Promise<CustomCategory | null> {
    let made: CustomCategory | null = null;
    await run("category", "add the category", async () => {
      made = (await api<{ category: CustomCategory }>(`${p.base}/expense-categories`, { method: "POST", body: { name, section } })).category;
      await p.reloadCosts();
      return `${name} added.`;
    });
    return made;
  }
  const path = p.base ? `${p.base}/expenses` : null;

  const changed = async () => {
    liveDataChanged();
    await p.reloadCosts();
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing || !path) return;
    const { id, draft, apply } = editing;
    const ok = await run("save", id ? "save the cost" : "add the cost", async () => {
      await api(id ? `${path}/${id}?apply=${apply}` : path, { method: id ? "PUT" : "POST", body: inputOf(draft, data.currency) });
      return id ? "Cost saved." : "Cost added.";
    });
    if (ok) {
      setEditing(null);
      await changed();
    }
  }
  async function remove() {
    if (!removing || !path) return;
    const ok = await run("remove", "remove the cost", async () => {
      await api(`${path}/${removing.id}`, { method: "DELETE" });
      return "Cost removed.";
    });
    setRemoving(null);
    if (ok) await changed();
  }

  return (
    <div className="mt-6 border-t border-border pt-4" data-testid="profit-costs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">Your costs in {fmtMonth(data.month, { year: true })}</h4>
          <p className="max-w-2xl text-xs text-muted">
            Fixed costs are kept as monthly (or weekly, yearly) costs and spread over the month&apos;s days, never taken whole off one day. A variable
            cost paid once counts on its day. Each is your own figure, in {data.currency}.
          </p>
        </div>
        {p.canManageCosts && (
          <div className="flex flex-wrap gap-2" data-print-hide>
            {EXPENSE_GROUPS.map((g) => (
              <button
                key={g}
                type="button"
                className={`${g === "fixed" ? "btn-primary" : "btn-secondary"} h-9 gap-1.5 px-3 text-sm`}
                onClick={() => setEditing({ id: null, draft: blankCost(day.from, STARTS[g].category, STARTS[g].cadence), apply: "next" })}
                data-testid={`profit-add-${g}`}
              >
                <Plus aria-hidden className="h-4 w-4" />
                {STARTS[g].label}
              </button>
            ))}
          </div>
        )}
      </div>
      {p.costsError && !p.costs && <p className="mt-2 text-sm text-danger">Couldn&apos;t load your costs. {friendlyError(p.costsError)}</p>}
      {p.costs && list.length === 0 && <p className="mt-3 text-sm text-muted">No cost of yours counts in {fmtMonth(data.month)} yet.</p>}
      {list.length > 0 && (
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          {EXPENSE_GROUPS.map((g) => {
            const rows = list.filter((x) => groupOf(x.e) === g).sort((a, b) => (b.month ?? 0) - (a.month ?? 0));
            return (
              <div key={g} className="min-w-0" data-testid={`profit-costs-${g}`}>
                <p className="flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  <span>{EXPENSE_GROUP_LABEL[g]}</span>
                  <span className="tabular-nums">{money(rows.reduce((a, x) => a + Math.round((x.month ?? 0) * 100), 0) / 100)}</span>
                </p>
                {rows.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">None.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-border text-sm">
                    {rows.map(({ e, month: m, day: d }) => (
                      <li key={e.id} className="py-2" data-testid="profit-cost-row">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate font-medium" title={e.name}>
                            {e.name}
                          </span>
                          <span className="shrink-0 tabular-nums">{m === null ? "Follows sales" : money(m)}</span>
                        </div>
                        <p className="text-xs text-muted">
                          {categoryLabel(e.category, customs)} · {termsOf(e, data.currency)} · {whenOf(e)}
                        </p>
                        {e.cadence !== "once" && d !== null && (
                          <p className="text-xs text-muted">
                            {fmtDay(day.from, { year: false })}: {money(d)}
                          </p>
                        )}
                        {p.canManageCosts && (
                          <p className="mt-0.5 flex gap-3 text-xs" data-print-hide>
                            <button type="button" className="text-accent hover:underline" onClick={() => setEditing({ id: e.id, draft: draftOf(e, customs), apply: "next" })} aria-label={`Change ${e.name}`}>
                              Change
                            </button>
                            <button type="button" className="text-danger hover:underline" onClick={() => setRemoving(e)} aria-label={`Remove ${e.name}`}>
                              Remove
                            </button>
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      <OperatingDays p={p} data={data} />

      <Dialog open={editing !== null} title={editing?.id ? "Change the cost" : "Add a cost"} onClose={() => setEditing(null)}>
        {editing && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" data-testid="profit-cost-form">
            <CostFields draft={editing.draft} currency={data.currency} set={(patch) => setEditing((x) => (x ? { ...x, draft: { ...x.draft, ...patch } } : x))} categories={customs} onCreateCategory={createCategory} />
            {editedCost && asksApplyFrom(editedCost, data.today) && changesPayments(editedCost, editing.draft) && (
              <ApplyChoice value={editing.apply} onChange={(apply) => setEditing((x) => (x ? { ...x, apply } : x))} next={editedCost.nextDue ?? null} />
            )}
            <div className="flex gap-2 sm:col-span-2">
              <button className="btn-primary" disabled={busy === "save"}>
                {busy === "save" ? "Saving…" : editing.id ? "Save" : "Add"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Dialog>
      <ConfirmDialog open={removing !== null} title="Remove this cost?" confirmLabel="Remove" danger busy={busy === "remove"} onConfirm={remove} onCancel={() => setRemoving(null)}>
        <p className="text-sm text-muted">
          {removing ? `${removing.name} (${termsOf(removing, data.currency)}) stops counting on every date, past ones too. To stop it from a day on, give it an end date instead.` : ""}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** How fixed costs are spread: over every calendar day, or only the weekdays the store is open. */
function OperatingDays({ p, data }: { p: ProfitState; data: ProfitAnswer }) {
  const saved = data.setup.operatingWeekdays;
  const [picked, setPicked] = useState<number[] | null>(null);
  const { busy, run } = useAction();
  const days = picked ?? saved;
  const names = weekdayNames("short");
  const longNames = weekdayNames("long");
  const every = days.length === 0;
  const dirty = picked !== null && picked.join() !== saved.join();

  async function save() {
    if (!p.base || !picked) return;
    const ok = await run("days", "save the days the store is open", async () => {
      await api(`${p.base}/expenses/settings`, { method: "PUT", body: { operatingWeekdays: picked } });
      return picked.length ? "Fixed costs are now spread over the days the store is open." : "Fixed costs are now spread over every day.";
    });
    if (ok) {
      setPicked(null);
      liveDataChanged();
    }
  }

  return (
    <div className="mt-5 rounded-lg border border-border bg-bg/50 p-3 text-sm" data-testid="profit-operating-days">
      <p className="font-medium">How fixed costs are spread</p>
      <p className="mt-0.5 text-xs text-muted">
        {every
          ? `Over every calendar day: a month's fixed costs ÷ its ${data.allocation.calendarDays} days (28, 29, 30 or 31, each month its own).`
          : `Over the days the store is open: a month's fixed costs ÷ its ${data.allocation.days} open days; a closed day carries none.`}
      </p>
      {p.canManageCosts ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Days the store is open">
          <button
            type="button"
            aria-pressed={every}
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition ${every ? "border-accent bg-accent/12 text-accent" : "border-border text-muted hover:text-text"}`}
            onClick={() => setPicked([])}
          >
            Every day
          </button>
          {names.map((n, d) => {
            const on = !every && days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={longNames[d]}
                className={`h-8 min-w-10 rounded-lg border px-2 text-xs font-medium transition ${on ? "border-accent bg-accent/12 text-accent" : "border-border text-muted hover:text-text"}`}
                onClick={() => {
                  const base = every ? [0, 1, 2, 3, 4, 5, 6] : days;
                  const next = base.includes(d) ? base.filter((x) => x !== d) : [...base, d].sort();
                  // None open isn't a choice; all seven is every day.
                  if (next.length) setPicked(next.length === 7 ? [] : next);
                }}
              >
                {n}
              </button>
            );
          })}
          <button type="button" className="btn-secondary ml-1 h-8 px-3 text-xs" disabled={!dirty || busy === "days"} onClick={save} data-testid="profit-operating-save">
            {busy === "days" ? "Saving…" : "Save"}
          </button>
        </div>
      ) : (
        !every && <p className="mt-1 text-xs text-muted">Open: {days.map((d) => longNames[d]).join(", ")}.</p>
      )}
    </div>
  );
}

/** "This list holds every cost from …": what operating and net profit wait for. */
export function CompleteControl({ p, data }: { p: ProfitState; data: ProfitAnswer }) {
  const [from, setFrom] = useState(data.setup.completeFrom && data.setup.completeFrom < data.allocation.from ? data.setup.completeFrom : data.allocation.from);
  const { busy, run } = useAction();
  async function save() {
    if (!p.base || !from) return;
    const ok = await run("complete", "mark your costs list complete", async () => {
      await api(`${p.base}/expenses/settings`, { method: "PUT", body: { completeFrom: from } });
      return `Operating and net profit can now be shown from ${fmtLongDay(from)}.`;
    });
    if (ok) liveDataChanged();
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="profit-complete">
      <span className="text-sm">Once your list holds every cost your store has:</span>
      <label className="flex items-center gap-2 text-sm">
        It holds every cost from
        <input aria-label="Complete from" className="input h-8 w-auto py-0" type="date" value={from} max={data.today} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <button type="button" className="btn-secondary h-8 px-3 text-sm" disabled={!from || busy === "complete"} onClick={save} data-testid="profit-complete-save">
        {busy === "complete" ? "Saving…" : "Mark complete"}
      </button>
    </div>
  );
}
