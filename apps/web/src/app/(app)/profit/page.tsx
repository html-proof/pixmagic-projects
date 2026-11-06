"use client";
import Link from "next/link";
import { useState } from "react";
import { FolderCog, Plus, Printer, Scale } from "lucide-react";
import { STATEMENT_GRAINS, type StatementGrain } from "@app/shared/profit";
import { canManage as canManageStores, StoresPending, useApp } from "@/components/AppContext";
import { Skeleton, useAction } from "@/components/AppUi";
import { blankCost } from "@/components/costs/CostForm";
import { CompareDates, CompareSelect, CustomDates, DateRangeSelect, periodWords } from "@/components/dashboard/DateRange";
import { fmtDay, fmtRange } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { CategoriesDialog, ExpenseDialog, type Editing } from "@/components/profit/ExpenseDialog";
import { ExpenseTable } from "@/components/profit/ExpenseTable";
import { OverviewCards, OverviewCharts } from "@/components/profit/Overview";
import { PaymentsDialog, RecurringCosts } from "@/components/profit/RecurringCosts";
import { saveFile, Statement, statementCsv } from "@/components/profit/Statement";
import { useStatement, type ListedExpense, type StatementState } from "@/components/profit/useStatement";
import { Alert, EmptyState } from "@/components/ui";
import { api, friendlyError, isTransient } from "@/lib/api";

const GRAIN_LABEL: Record<StatementGrain, string> = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };

/**
 * Profit & Loss (docs/kpis.md "Profit and loss" and "Costs and net profit"): whether the store made
 * money in any dates, laid out as the owner's own workbook (revenue with and without tax, the sales
 * stats, advertising, variable and fixed costs, profit, MER, VCR, FCR and the sitewide ROAS), against
 * the dates it's compared with, a column per day, week, month or year; and the store's own costs,
 * managed here: added, changed, copied and removed, in categories of the store's own, paid once or
 * every period (each payment recorded and kept as paid), or worked out from the sales.
 */
export default function ProfitPage() {
  const { storesStatus, stores, store, workspace } = useApp();
  if (storesStatus !== "ready") return <StoresPending />;
  if (!stores.length || !store) {
    return (
      <EmptyState
        title="Connect your store to see its profit and loss"
        body="Once your Shopify store is connected, this page works out its profit or loss for any dates, from its sales, its products' costs, your ad spend and the costs you add here."
        action={canManageStores(workspace.role) ? <Link className="btn-primary" href={`/onboarding?ws=${encodeURIComponent(workspace.id)}`}>Continue with Shopify</Link> : undefined}
      />
    );
  }
  // A store's own page: switching stores starts again (the dates stay in the address).
  return <ProfitView key={store.id} />;
}

function ProfitView() {
  const s = useStatement();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [payments, setPayments] = useState<{ expense: ListedExpense; focus: string | null } | null>(null);
  const { data } = s;
  const today = s.costs?.today ?? data?.today ?? "";

  if (!s.sees) {
    return (
      <EmptyState
        title="Profit and loss isn't shared with you"
        body="It is worked out from the sales breakdown (shipping, fees and tax) and the store's costs. Ask an owner or admin for “View gross sales, discounts, tax, shipping and total sales” in Team & Access."
      />
    );
  }

  return (
    <div className="space-y-5" data-print-root data-testid="pl-page">
      <Header s={s} onAdd={() => setEditing({ expense: null, draft: blankCost(today) })} onCategories={() => setCategoriesOpen(true)} />

      {s.error && !data && <LoadError what="your profit and loss" error={s.error} onRetry={() => window.dispatchEvent(new Event("insights:retry"))} busy={s.loading} />}
      {s.error && data && s.older && (
        <Alert kind={isTransient(s.error) ? "info" : "error"}>
          Couldn&apos;t load {s.dates.asking?.label}, so the figures below are still for {fmtRange(data.range.from, data.range.to)}. {friendlyError(s.error)}
        </Alert>
      )}
      {!data && !s.error && (
        <div className="card">
          <p className="sr-only" role="status">
            Loading your profit and loss…
          </p>
          <Skeleton lines={8} />
        </div>
      )}

      {data && (
        <>
          <OverviewCards a={data} />
          <Completeness s={s} />
          <OverviewCharts a={data} />
          <Statement a={data} onDownload={s.canExport ? () => saveFile(`profit-and-loss-${data.range.from}-to-${data.range.to}-${data.grain}.csv`, statementCsv(data)) : null} />
          <ExpenseTable s={s} a={data} onEdit={setEditing} onPayment={(expense, due) => setPayments({ expense, focus: due })} />
        </>
      )}
      <RecurringCosts s={s} onEdit={setEditing} onPayments={(expense) => setPayments({ expense, focus: null })} />

      {s.base && (
        <>
          <ExpenseDialog
            editing={editing}
            setEditing={setEditing}
            base={s.base}
            currency={s.costs?.currency ?? data?.currency ?? "USD"}
            today={today}
            categories={s.costs?.categories ?? data?.categories ?? []}
            onSaved={s.changed}
            onCategoryAdded={s.changed}
          />
          <CategoriesDialog open={categoriesOpen} onClose={() => setCategoriesOpen(false)} base={s.base} categories={s.costs?.categories ?? []} canManage={s.canManage} onChanged={s.changed} />
          <PaymentsDialog s={s} expense={payments?.expense ?? null} focus={payments?.focus ?? null} onClose={() => setPayments(null)} />
        </>
      )}
    </div>
  );
}

function Header({ s, onAdd, onCategories }: { s: StatementState; onAdd: () => void; onCategories: () => void }) {
  const { stores, store, setStoreId } = useApp();
  const { dates, shown, data } = s;
  return (
    <header className="animate-rise">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="page-title flex items-center gap-2">
            <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-accent/12 text-accent">
              <Scale className="h-[18px] w-[18px]" />
            </span>
            Profit &amp; Loss
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Your profit or loss {shown ? periodWords(dates, shown) : "for the dates you pick"}: revenue with and without tax, every cost (synced from Shopify and your ad accounts, and your own), and what is left. Add, change
            and remove your expenses here; the figures follow at once.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-print-hide>
          {s.canManage && (
            <button type="button" className="btn-primary h-9 gap-1.5 px-3 text-sm" onClick={onAdd} disabled={!s.costs} data-testid="pl-add-expense">
              <Plus aria-hidden className="h-4 w-4" />
              Add Expense
            </button>
          )}
          <button type="button" className="btn-secondary h-9 gap-1.5 px-3 text-sm" onClick={onCategories} disabled={!s.costs} data-testid="pl-categories-open">
            <FolderCog aria-hidden className="h-4 w-4" />
            Categories
          </button>
          <button type="button" className="btn-secondary h-9 gap-1.5 px-3 text-sm" onClick={() => window.print()}>
            <Printer aria-hidden className="h-4 w-4" />
            Print
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2" data-print-hide>
        {stores.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Store
            <select className="input h-9 w-auto max-w-[14rem] py-0 text-sm" aria-label="Store" value={store?.id ?? ""} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name ?? x.shopDomain}
                </option>
              ))}
            </select>
          </label>
        )}
        <DateRangeSelect r={dates} shown={shown} id="pl-dates" label="Dates" size="sm" />
        <CompareSelect r={dates} shown={shown} current={!s.older} id="pl-compare" label="Compare with" size="sm" />
        <div className="flex items-center rounded-lg border border-border bg-bg p-0.5" role="group" aria-label="Report by" data-testid="pl-grain">
          {STATEMENT_GRAINS.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={s.grain === g}
              className={`h-8 rounded-md px-3 text-sm font-medium transition ${s.grain === g ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}
              onClick={() => s.setGrain(g)}
            >
              {GRAIN_LABEL[g]}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 empty:hidden" data-print-hide>
        {dates.preset === "custom" && <CustomDates r={dates} />}
        {dates.compare === "custom" && <CompareDates r={dates} />}
      </div>
      {data && (
        <p className="mt-3 text-xs text-muted">
          Days in the store&apos;s time zone ({data.timezone}), in {data.currency}; weeks run Monday to Sunday.
          {data.grain !== s.grain && s.grain ? " Too many columns for those dates: shown a period coarser." : ""}
        </p>
      )}
    </header>
  );
}

/** Whether the costs list holds every cost: profit is called profit only for dates from that day. */
function Completeness({ s }: { s: StatementState }) {
  const data = s.data!;
  const [from, setFrom] = useState(data.setup.completeFrom ?? data.range.from);
  const { busy, run } = useAction();
  if (!data.total.gaps.includes("costs_not_complete")) return null;
  async function save() {
    const ok = await run("complete", "mark your costs list complete", async () => {
      await api(`${s.base}/expenses/settings`, { method: "PUT", body: { completeFrom: from } });
      return `Profit can now be shown for dates from ${fmtDay(from)}.`;
    });
    if (ok) await s.changed();
  }
  return (
    <div className="card border-warn/30 bg-warn/5 text-sm" data-testid="pl-complete">
      <p className="font-medium">Profit shows once your expenses list is complete</p>
      <p className="mt-0.5 text-muted">
        Until you say the list holds every cost your store has, bizinsights shows what is left after the costs it knows and never calls it profit.
        {data.setup.completeFrom ? ` It is marked complete from ${fmtDay(data.setup.completeFrom)}, after these dates start.` : ""}
      </p>
      {s.canManage ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            It holds every cost from
            <input aria-label="Complete from" className="input h-8 w-auto py-0" type="date" value={from} max={data.today} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <button type="button" className="btn-secondary h-8 px-3 text-sm" disabled={!from || busy === "complete"} onClick={save} data-testid="pl-complete-save">
            {busy === "complete" ? "Saving…" : "Mark complete"}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-muted">An owner or admin (or a member with &ldquo;Manage costs&rdquo;) marks the list complete.</p>
      )}
    </div>
  );
}
