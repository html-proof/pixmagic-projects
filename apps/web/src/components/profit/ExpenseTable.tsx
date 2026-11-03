"use client";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Download, Pencil, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { categoryLabel, EXPENSE_CADENCE_LABEL, EXPENSE_SECTION_LABEL, EXPENSE_SECTIONS, type ExpenseSection } from "@app/shared/expenses";
import { ConfirmDialog, useAction } from "@/components/AppUi";
import { blankCost, copyOf, draftOf, termsOf } from "@/components/costs/CostForm";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtDay, fmtSpan, plural } from "@/components/dashboard/format";
import { csvField } from "@/components/sheet/sheetUi";
import { api, fmtMoney } from "@/lib/api";
import type { Editing } from "./ExpenseDialog";
import { PLATFORM_NAME } from "./profitUi";
import { saveFile } from "./Statement";
import type { ExpenseLine, ListedExpense, StatementAnswer, StatementState } from "./useStatement";

// ---------------------------------------------------------------------------
// Every expense of the dates, a row each (docs/kpis.md "Costs and net profit"): the owner's costs paid
// once, each payment of a recurring cost, what each cost that follows the sales comes to, and the
// costs synced from Shopify and the ad accounts, each with where it comes from. Searched, filtered
// by category, kind, source and date, sorted by date or amount, removed several at once, and
// downloaded. A synced figure is never changed here: an adjustment is a cost of its own beside it.
// ---------------------------------------------------------------------------

type Source = "manual" | "recurring" | "calculated" | "synced";
const SOURCE_LABEL: Record<Source, string> = { manual: "Manual", recurring: "Recurring", calculated: "Calculated", synced: "Synced" };
const STATUS: Record<ExpenseLine["status"], { label: string; tone: Tone }> = {
  posted: { label: "Paid", tone: "good" },
  edited: { label: "Changed", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
  upcoming: { label: "Upcoming", tone: "warn" },
};

/** A row of the table: one of the owner's lines, or a synced figure. */
interface Row {
  key: string;
  line: ExpenseLine | null;
  expense: ListedExpense | null;
  source: Source;
  date: string;
  to: string;
  name: string;
  category: string;
  categoryText: string;
  section: ExpenseSection;
  vendor: string | null;
  how: string;
  amount: number | null;
  /** A synced figure's adjustment: the category and name it is added in. */
  adjust?: { category: string; name: string };
}

const sourceOf = (l: ExpenseLine): Source => (l.kind === "payment" ? "recurring" : l.kind === "rule" ? "calculated" : "manual");

function rowsOf(a: StatementAnswer, expenses: readonly ListedExpense[]): Row[] {
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const t = a.total;
  const synced: Row[] = [
    ...(a.setup.productCosts === "known"
      ? [
          {
            key: "synced-products",
            line: null,
            expense: null,
            source: "synced" as const,
            date: a.range.from,
            to: a.range.to,
            name: "Product costs",
            category: "products",
            categoryText: "Product costs (Shopify)",
            section: "variable" as const,
            vendor: "Shopify",
            how: "Items sold × each product's cost per item in Shopify",
            amount: t.grossGaps.length ? null : t.productCosts,
            adjust: { category: "product_cost_adjustment", name: "Product cost adjustment" },
          },
        ]
      : []),
    ...Object.entries(t.adSpendBy).map(([p, v]) => ({
      key: `synced-ads-${p}`,
      line: null,
      expense: null,
      source: "synced" as const,
      date: a.range.from,
      to: a.range.to,
      name: `${PLATFORM_NAME[p] ?? p} ad spend`,
      category: `ads-${p}`,
      categoryText: `${PLATFORM_NAME[p] ?? p} Ads`,
      section: "advertising" as const,
      vendor: `${PLATFORM_NAME[p] ?? p} Ads`,
      how: "Synced from the connected ad account",
      amount: v,
      adjust: { category: "ad_spend_adjustment", name: `${PLATFORM_NAME[p] ?? p} ad spend adjustment` },
    })),
  ];
  const own = a.lines.map((l): Row => {
    const e = byId.get(l.expenseId) ?? null;
    const how = e ? (l.kind === "payment" ? `${EXPENSE_CADENCE_LABEL[e.cadence]}${l.scheduledAmount !== null ? ` (scheduled ${fmtMoney(l.scheduledAmount, a.currency)})` : ""}` : termsOf(e, a.currency)) : "";
    return { key: l.key, line: l, expense: e, source: sourceOf(l), date: l.date, to: l.to, name: l.name, category: l.category, categoryText: categoryLabel(l.category, a.categories), section: l.section, vendor: l.vendor, how, amount: l.amount };
  });
  // A synced figure of 0 (nothing sold, nothing spent) says nothing: only those with an amount, or missing data, are listed.
  return [...own, ...synced.filter((r) => r.amount !== 0)];
}

type Sort = { by: "date" | "amount"; desc: boolean };

export function ExpenseTable({ s, a, onEdit, onPayment }: { s: StatementState; a: StatementAnswer; onEdit: (e: Editing) => void; onPayment: (expense: ListedExpense, due: string) => void }) {
  const expenses = useMemo(() => s.costs?.expenses ?? [], [s.costs]);
  const all = useMemo(() => rowsOf(a, expenses), [a, expenses]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [section, setSection] = useState<"all" | ExpenseSection>("all");
  const [source, setSource] = useState<"all" | Source>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<Sort>({ by: "date", desc: true });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<ListedExpense[] | null>(null);
  const [filters, setFilters] = useState(false);
  const { busy, run } = useAction();
  const money = (n: number) => fmtMoney(n, a.currency);

  const q = query.trim().toLowerCase();
  const rows = all
    .filter((r) => !q || [r.name, r.vendor, r.categoryText, r.line?.description, r.line?.note].some((x) => x?.toLowerCase().includes(q)))
    .filter((r) => category === "all" || r.category === category)
    .filter((r) => section === "all" || r.section === section)
    .filter((r) => source === "all" || r.source === source)
    .filter((r) => (!from || r.to >= from) && (!to || r.date <= to))
    .sort((x, y) => {
      const d = sort.by === "amount" ? (x.amount ?? 0) - (y.amount ?? 0) : x.date < y.date ? -1 : x.date > y.date ? 1 : 0;
      return (sort.desc ? -d : d) || x.name.localeCompare(y.name);
    });
  const categories = [...new Map(all.map((r) => [r.category, r.categoryText])).entries()].sort((x, y) => x[1].localeCompare(y[1]));
  // Only a whole cost is removed: a cost paid once, or one that follows the sales. A recurring cost's payments are changed or skipped one by one.
  const removable = (r: Row) => s.canManage && r.expense !== null && r.source !== "recurring";
  const shownPicked = rows.filter((r) => picked.has(r.key) && removable(r));
  const total = rows.reduce((n, r) => n + Math.round((r.amount ?? 0) * 100), 0) / 100;
  const filtered = !!(q || category !== "all" || section !== "all" || source !== "all" || from || to);

  const toggle = (key: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const allPicked = rows.some(removable) && rows.filter(removable).every((r) => picked.has(r.key));

  async function remove() {
    if (!removing) return;
    const ids = removing.map((e) => e.id);
    const ok = await run("remove", ids.length === 1 ? "remove the expense" : "remove the expenses", async () => {
      if (ids.length === 1) await api(`${s.base}/expenses/${ids[0]}`, { method: "DELETE" });
      else await api(`${s.base}/expenses/bulk-delete`, { method: "POST", body: { ids } });
      return ids.length === 1 ? "Expense removed." : `${ids.length} expenses removed.`;
    });
    setRemoving(null);
    if (ok) {
      setPicked(new Set());
      await s.changed();
    }
  }

  function download() {
    const head = ["Date", "To", "Expense", "Category", "Type", "Source", "How it's worked out", "Vendor", `Amount (${a.currency})`, "Status", "Description", "Note"];
    const lines = rows.map((r) => [r.date, r.to, r.name, r.categoryText, EXPENSE_SECTION_LABEL[r.section], SOURCE_LABEL[r.source], r.how, r.vendor ?? "", r.amount === null ? "" : r.amount.toFixed(2), r.line ? STATUS[r.line.status].label : "", r.line?.description ?? "", r.line?.note ?? ""]);
    const text = [head, ...lines].map((l) => l.map((v) => csvField(v)).join(",")).join("\r\n");
    saveFile(`expenses-${a.range.from}-to-${a.range.to}.csv`, `${String.fromCharCode(0xfeff)}${text}\r\n`);
  }

  const SortButton = ({ by, label }: { by: Sort["by"]; label: string }) => (
    <button type="button" className="inline-flex items-center gap-1 font-semibold hover:text-text" onClick={() => setSort((x) => (x.by === by ? { by, desc: !x.desc } : { by, desc: true }))} aria-label={`Sort by ${label.toLowerCase()}`}>
      {label}
      {sort.by === by && (sort.desc ? <ArrowDown aria-hidden className="h-3.5 w-3.5" /> : <ArrowUp aria-hidden className="h-3.5 w-3.5" />)}
    </button>
  );

  return (
    <section className="card min-w-0" aria-labelledby="pl-expenses-h" data-testid="pl-expenses">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="pl-expenses-h" className="font-semibold">
            Expenses
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-muted">
            Every cost of {fmtSpan(a.range.from, a.range.to, { year: true })}: yours (paid once, recurring payments, and those worked out from your sales) and those synced from Shopify and your ad accounts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-print-hide>
          {s.canManage && (
            <button type="button" className="btn-primary h-9 gap-1.5 px-3 text-sm" onClick={() => onEdit({ expense: null, draft: blankCost(a.today, "other", "once") })} data-testid="pl-add-expense-table">
              <Plus aria-hidden className="h-4 w-4" />
              Add expense
            </button>
          )}
          {s.canExport && (
            <button type="button" className="btn-secondary h-9 gap-1.5 px-3 text-sm" onClick={download} disabled={!rows.length} data-testid="pl-expenses-csv">
              <Download aria-hidden className="h-4 w-4" />
              Export CSV
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" data-print-hide>
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Search expenses</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input h-9 pl-8 text-sm" type="search" placeholder="Search by name, vendor, category or note" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="pl-expenses-search" />
        </label>
        <select className="input h-9 w-auto py-0 text-sm" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} data-testid="pl-expenses-category">
          <option value="all">Every category</option>
          {categories.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className={`btn-secondary h-9 gap-1.5 px-3 text-sm ${filters ? "border-accent text-accent" : ""}`} aria-expanded={filters} onClick={() => setFilters((x) => !x)}>
          <SlidersHorizontal aria-hidden className="h-4 w-4" />
          More filters
        </button>
      </div>
      {filters && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-bg/50 p-2" data-print-hide>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Type
            <select className="input h-9 w-auto py-0 text-sm" value={section} onChange={(e) => setSection(e.target.value as "all" | ExpenseSection)}>
              <option value="all">Every type</option>
              {EXPENSE_SECTIONS.map((x) => (
                <option key={x} value={x}>
                  {EXPENSE_SECTION_LABEL[x]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Source
            <select className="input h-9 w-auto py-0 text-sm" value={source} onChange={(e) => setSource(e.target.value as "all" | Source)}>
              <option value="all">Every source</option>
              {(Object.keys(SOURCE_LABEL) as Source[]).map((x) => (
                <option key={x} value={x}>
                  {SOURCE_LABEL[x]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            From
            <input className="input h-9 w-auto py-0 text-sm" type="date" min={a.range.from} max={a.range.to} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            To
            <input className="input h-9 w-auto py-0 text-sm" type="date" min={a.range.from} max={a.range.to} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {filtered && (
            <button
              type="button"
              className="h-9 px-2 text-sm text-muted hover:text-text"
              onClick={() => {
                setQuery("");
                setCategory("all");
                setSection("all");
                setSource("all");
                setFrom("");
                setTo("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {shownPicked.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm" data-print-hide>
          <span>{plural(shownPicked.length, "expense")} selected</span>
          <button type="button" className="inline-flex items-center gap-1.5 font-medium text-danger hover:underline" onClick={() => setRemoving(shownPicked.map((r) => r.expense!))} data-testid="pl-expenses-bulk-delete">
            <Trash2 aria-hidden className="h-4 w-4" />
            Remove selected
          </button>
          <button type="button" className="text-muted hover:text-text" onClick={() => setPicked(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted" data-testid="pl-expenses-empty">
          {filtered ? "No expense matches these filters." : "No expenses in these dates yet."}
        </p>
      ) : (
        <div className="relative mt-3 overflow-x-auto overscroll-x-contain rounded-lg border border-border" role="region" aria-label="Expenses" tabIndex={0}>
          <table className="min-w-full text-sm">
            <thead className="bg-bg/60 text-left text-xs text-muted">
              <tr>
                {s.canManage && (
                  <th scope="col" className="w-9 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select every expense shown"
                      checked={allPicked}
                      disabled={!rows.some(removable)}
                      onChange={() => setPicked(allPicked ? new Set() : new Set(rows.filter(removable).map((r) => r.key)))}
                    />
                  </th>
                )}
                <th scope="col" className="whitespace-nowrap px-3 py-2">
                  <SortButton by="date" label="Date" />
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Expense
                </th>
                <th scope="col" className="hidden px-3 py-2 font-semibold md:table-cell">
                  Category
                </th>
                <th scope="col" className="hidden px-3 py-2 font-semibold lg:table-cell">
                  Source
                </th>
                <th scope="col" className="whitespace-nowrap px-3 py-2 text-right">
                  <SortButton by="amount" label="Amount" />
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold" data-print-hide>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.key} className="align-top hover:bg-bg/50" data-testid="pl-expense-row" data-source={r.source}>
                  {s.canManage && (
                    <td className="px-3 py-2.5">
                      {removable(r) && <input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.has(r.key)} onChange={() => toggle(r.key)} />}
                    </td>
                  )}
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{r.source === "synced" || r.source === "calculated" ? fmtSpan(r.date, r.to) : fmtDay(r.date)}</td>
                  <td className="min-w-[12rem] px-3 py-2.5">
                    <span className="font-medium">{r.name}</span>
                    <span className="block text-xs text-muted">
                      <span className="md:hidden">{r.categoryText} · </span>
                      {r.how}
                      {r.vendor && r.source !== "synced" ? ` · ${r.vendor}` : ""}
                    </span>
                    {r.line?.description && <span className="block text-xs text-muted">{r.line.description}</span>}
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    {r.categoryText}
                    <span className="block text-xs text-muted">{EXPENSE_SECTION_LABEL[r.section]}</span>
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2.5 lg:table-cell">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {SOURCE_LABEL[r.source]}
                      {r.line && r.source === "recurring" && <Badge tone={STATUS[r.line.status].tone}>{STATUS[r.line.status].label}</Badge>}
                    </span>
                  </td>
                  <td className={`whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums ${r.amount !== null && r.amount < 0 ? "text-good" : ""} ${r.line?.status === "skipped" ? "text-muted line-through" : ""}`}>
                    {r.amount === null ? <span className="text-xs text-warn">Missing data</span> : money(r.amount)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right" data-print-hide>
                    <RowActions r={r} s={s} a={a} onEdit={onEdit} onPayment={onPayment} onRemove={(e) => setRemoving([e])} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-bg/60 text-sm">
              <tr>
                <th scope="row" colSpan={s.canManage ? 2 : 1} className="px-3 py-2 text-left font-semibold">
                  {plural(rows.length, "row")}
                </th>
                <td className="px-3 py-2 text-xs text-muted" colSpan={1}>
                  {filtered ? "Filtered" : ""}
                </td>
                <td className="hidden md:table-cell" />
                <td className="hidden lg:table-cell" />
                <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">{money(total)}</td>
                <td data-print-hide />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">
        A recurring payment is shown on the day it falls due; the profit and loss spreads it over the days it pays for (a monthly cost over its month). A cost below 0 is a refund or a credit.
      </p>

      <ConfirmDialog open={removing !== null} title={removing && removing.length > 1 ? `Remove ${removing.length} expenses?` : "Remove this expense?"} confirmLabel="Remove" danger busy={busy === "remove"} onConfirm={remove} onCancel={() => setRemoving(null)}>
        <p className="text-sm text-muted">
          {removing?.length === 1
            ? `${removing[0]!.name} (${termsOf(removing[0]!, a.currency)}) stops counting on every date, past ones too. To stop a recurring cost from a day on, end it instead.`
            : "They stop counting on every date, past ones too. Each removal is kept in the audit log."}
        </p>
      </ConfirmDialog>
    </section>
  );
}

function RowActions({ r, s, a, onEdit, onPayment, onRemove }: { r: Row; s: StatementState; a: StatementAnswer; onEdit: (e: Editing) => void; onPayment: (expense: ListedExpense, due: string) => void; onRemove: (e: ListedExpense) => void }) {
  if (!s.canManage) return null;
  const icon = "grid size-8 place-items-center rounded-md text-muted transition hover:bg-bg hover:text-text";
  if (r.source === "synced") {
    return (
      <button
        type="button"
        className="text-xs font-medium text-accent hover:underline"
        onClick={() => onEdit({ expense: null, draft: { ...blankCost(a.range.to > a.today ? a.today : a.range.to, r.adjust!.category, "once"), name: r.adjust!.name } })}
        title="Add an adjustment beside the synced figure, which stays as it was"
        data-testid="pl-expense-adjust"
      >
        Adjust
      </button>
    );
  }
  const e = r.expense;
  if (!e) return null;
  const customs = a.categories;
  return (
    <span className="inline-flex items-center gap-0.5">
      {r.source === "recurring" && r.line && (
        <button type="button" className="mr-1 text-xs font-medium text-accent hover:underline" onClick={() => onPayment(e, r.line!.date)} data-testid="pl-expense-payment">
          This payment
        </button>
      )}
      <button type="button" className={icon} aria-label={`Edit ${e.name}`} title="Edit" onClick={() => onEdit({ expense: e, draft: draftOf(e, customs) })} data-testid="pl-expense-edit">
        <Pencil aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className={icon} aria-label={`Duplicate ${e.name}`} title="Duplicate" onClick={() => onEdit({ expense: null, draft: copyOf(e, a.today, customs), copy: true })} data-testid="pl-expense-duplicate">
        <Copy aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className={`${icon} hover:bg-danger/10 hover:text-danger`} aria-label={`Remove ${e.name}`} title="Remove" onClick={() => onRemove(e)} data-testid="pl-expense-remove">
        <Trash2 aria-hidden className="h-4 w-4" />
      </button>
    </span>
  );
}

