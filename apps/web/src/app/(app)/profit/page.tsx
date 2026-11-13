"use client";
import Link from "next/link";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { CalendarPlus, ChartColumn, CircleDollarSign, Download, LayoutGrid, Plus, Printer, Sheet, TrendingUp, type LucideIcon } from "lucide-react";
import type { BusinessEvent } from "@app/shared/businessEvents";
import { STATEMENT_GRAINS, type StatementGrain } from "@app/shared/profit";
import type { SheetGrain } from "@app/shared/sheet";
import { useQueryParam } from "@/components/advertising/useAdvertising";
import { canManage as canManageStores, StoresPending, useApp } from "@/components/AppContext";
import { Skeleton, useAction } from "@/components/AppUi";
import { blankCost } from "@/components/costs/CostForm";
import { CustomDates, DateRangeSelect } from "@/components/dashboard/DateRange";
import { fmtDay, fmtRange } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { CategoriesDialog, ExpenseDialog, type Editing } from "@/components/profit/ExpenseDialog";
import { ExpenseTable } from "@/components/profit/ExpenseTable";
import { KpiCards } from "@/components/profit/Kpis";
import { OverviewTab } from "@/components/profit/Overview";
import { PaymentsDialog, RecurringCosts } from "@/components/profit/RecurringCosts";
import { AnalysisTab, ExpensesSummary, OperatingDays, RevenueTab } from "@/components/profit/Sections";
import { saveFile, Statement, statementCsv } from "@/components/profit/Statement";
import { useStatement, type ListedExpense, type StatementState } from "@/components/profit/useStatement";
import { EventDialog, type EventDraft } from "@/components/sheet/EventDialog";
import { SheetSection } from "@/components/sheet/SheetSection";
import { Alert, EmptyState } from "@/components/ui";
import { api, friendlyError, isTransient, useApi } from "@/lib/api";

const GRAIN_LABEL: Record<StatementGrain, string> = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };

/** The page's sections, in the design's order. `?tab=` keeps the one open, so a link reproduces the view. */
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "revenue", label: "Revenue", icon: TrendingUp },
  { id: "expenses", label: "Expenses", icon: CircleDollarSign },
  { id: "analysis", label: "Profit Analysis", icon: ChartColumn },
  { id: "table", label: "Detailed Table", icon: Sheet },
];
type Tab = "overview" | "revenue" | "expenses" | "analysis" | "table";
const isTab = (v: string): v is Tab => TABS.some((t) => t.id === v);

/**
 * Profit & Loss (docs/kpis.md "Profit & Loss page"): whether the store made money in any dates, in one
 * place (the owner's design, 13 Nov 2026). Four figures at the top (revenue, expenses, profit, margin),
 * then five sections: Overview (the trend, what stands out, where the money went, the statement),
 * Revenue, Expenses (the store's own costs, managed here: added,
 * changed, copied and removed, in categories of the store's own, paid once or every period),
 * Profit Analysis, and the Detailed Table: the statement period by period and the day-by-day sheet
 * with the team's business events (the Profit sheet page, /sheet, until this design folded it in).
 *
 * A member shown the sales but not their breakdown ("View gross sales, discounts, tax, shipping and
 * total sales") gets the day-by-day sheet alone, as /sheet gave them.
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
  // A store's own page: switching stores starts again (the dates and the section stay in the address).
  return <ProfitView key={store.id} />;
}

function ProfitView() {
  const s = useStatement();
  const { allowed, me } = useApp();
  const [tabParam, setTab] = useQueryParam("tab", isTab);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [payments, setPayments] = useState<{ expense: ListedExpense; focus: string | null } | null>(null);
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null);
  // Goes up when a business event is added from the page's quick action, so the sheet asks for its events again.
  const [eventsVersion, setEventsVersion] = useState(0);
  const { data } = s;
  const today = s.costs?.today ?? data?.today ?? s.dates.today;
  const tab: Tab = s.sees ? (tabParam ?? "overview") : "table";
  // The business events of the dates on screen: how many there are is one of the Overview's insights.
  const events = useApi<{ events: BusinessEvent[] }>(s.base && data ? `${s.base}/business-events?from=${data.range.from}&to=${data.range.to}` : null);
  // Whoever sees the sales marks events, signed in to the account (not from a shared link).
  const canAddEvent = allowed("analytics.sales") && !me.shared;
  // The sheet's columns follow the page's Daily / Weekly / Monthly (it has no column per year).
  const by: SheetGrain | null = s.grain === "year" ? "month" : (s.grain ?? null);
  const download = data && s.canExport ? () => saveFile(`profit-and-loss-${data.range.from}-to-${data.range.to}-${data.grain}.csv`, statementCsv(data)) : null;
  const addExpense = () => setEditing({ expense: null, draft: blankCost(today) });
  const addEvent = () => setEventDraft({ from: s.dates.today, to: s.dates.today });
  const eventsChanged = () => void events.reload();

  const sheet = <SheetSection dates={s.dates} by={by} eventsVersion={eventsVersion} onEventsChanged={eventsChanged} />;

  return (
    <div className="space-y-5" data-print-root data-testid="pl-page">
      <Header s={s} onDownload={download} />

      {!s.sees ? (
        <>
          <section className="home-card p-5 text-sm text-muted" data-testid="profit-no-access">
            <h2 className="font-semibold text-text">Profit and loss isn&apos;t shared with you</h2>
            <p className="mt-1">
              It is worked out from the sales breakdown (shipping, fees and tax) and the store&apos;s costs. Ask an owner or admin for &ldquo;View gross sales, discounts, tax, shipping and total sales&rdquo; in Team &amp; Access. The day-by-day
              sheet below is yours to use meanwhile.
            </p>
          </section>
          {sheet}
        </>
      ) : (
        <>
          {s.error && !data && <LoadError what="your profit and loss" error={s.error} onRetry={() => window.dispatchEvent(new Event("insights:retry"))} busy={s.loading} />}
          {s.error && data && s.older && (
            <Alert kind={isTransient(s.error) ? "info" : "error"}>
              Couldn&apos;t load {s.dates.asking?.label}, so the figures below are still for {fmtRange(data.range.from, data.range.to)}. {friendlyError(s.error)}
            </Alert>
          )}
          {!data && !s.error && (
            <div className="home-card p-5">
              <p className="sr-only" role="status">
                Loading your profit and loss…
              </p>
              <Skeleton lines={8} />
            </div>
          )}
          {data && <KpiCards a={data} />}

          <Tabs
            tab={tab}
            onTab={setTab}
            actions={
              <>
                {s.canManage && (
                  <button type="button" className="home-btn border border-home-line bg-surface" onClick={addExpense} disabled={!s.costs} data-testid="pl-add-expense">
                    <Plus aria-hidden className="h-4 w-4" />
                    Add Expense
                  </button>
                )}
                {canAddEvent && (
                  <button type="button" className="home-btn border border-home-line bg-surface" onClick={addEvent} data-testid="pl-add-event">
                    <CalendarPlus aria-hidden className="h-4 w-4" />
                    Add Business Event
                  </button>
                )}
              </>
            }
          />

          <div role="tabpanel" id="pl-panel" aria-labelledby={`pl-tab-${tab}`} className="space-y-4" data-testid={`pl-panel-${tab}`}>
            {data && tab !== "revenue" && tab !== "table" && <Completeness s={s} />}
            {data && tab === "overview" && <OverviewTab a={data} events={events.data ? events.data.events.length : null} onAddEvent={canAddEvent ? addEvent : null} onDownload={download} onDetails={() => goTo(setTab, "table")} />}
            {data && tab === "revenue" && <RevenueTab a={data} />}
            {tab === "expenses" && (
              <>
                {data && (
                  <>
                    <ExpensesSummary a={data} s={s} onCategories={() => setCategoriesOpen(true)} />
                    <ExpenseTable s={s} a={data} onEdit={setEditing} onPayment={(expense, due) => setPayments({ expense, focus: due })} />
                  </>
                )}
                <RecurringCosts s={s} onEdit={setEditing} onPayments={(expense) => setPayments({ expense, focus: null })} />
                {data && <OperatingDays a={data} s={s} />}
              </>
            )}
            {data && tab === "analysis" && <AnalysisTab a={data} />}
            {tab === "table" && (
              <>
                {data && <Statement a={data} onDownload={download} />}
                {sheet}
              </>
            )}
          </div>
        </>
      )}

      {s.base && s.sees && (
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
      {s.base && (
        <EventDialog
          draft={eventDraft}
          base={s.base}
          today={s.dates.today}
          onClose={() => setEventDraft(null)}
          onSaved={() => {
            eventsChanged();
            setEventsVersion((v) => v + 1);
          }}
          onRemoved={() => {
            eventsChanged();
            setEventsVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

/** Opens a section from inside another (the Overview's "View Details") and brings its top into view. */
function goTo(setTab: (t: Tab) => void, tab: Tab) {
  setTab(tab);
  window.requestAnimationFrame(() => document.getElementById("pl-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function Header({ s, onDownload }: { s: StatementState; onDownload: (() => void) | null }) {
  const { stores, store, setStoreId } = useApp();
  const { dates, shown, data } = s;
  return (
    <header className="animate-rise space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
            <ChartColumn className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="page-title">Profit &amp; Loss</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">Understand your revenue, expenses and actual profit, all in one place.</p>
            {shown && (
              <p className="mt-1 hidden text-sm print:block">
                {store?.name ?? store?.shopDomain} · {fmtRange(shown.range.from, shown.range.to)}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-print-hide>
          {stores.length > 1 && (
            <select className="input h-9 w-auto max-w-[14rem] py-0 text-sm" aria-label="Store" value={store?.id ?? ""} onChange={(e) => setStoreId(e.target.value)} data-testid="pl-store">
              {stores.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name ?? x.shopDomain}
                </option>
              ))}
            </select>
          )}
          <DateRangeSelect r={dates} shown={shown} id="pl-dates" label="Dates" size="sm" />
          <div className="flex items-center rounded-lg border border-home-line bg-surface p-0.5" role="group" aria-label="Show by" data-testid="pl-grain">
            {STATEMENT_GRAINS.map((g) => (
              <button key={g} type="button" aria-pressed={s.grain === g} className={`h-8 rounded-md px-3 text-[13px] font-medium transition ${s.grain === g ? "bg-accent text-accent-ink shadow-sm" : "text-muted hover:text-text"}`} onClick={() => s.setGrain(g)}>
                {GRAIN_LABEL[g]}
              </button>
            ))}
          </div>
          {onDownload && (
            <button type="button" className="home-btn border border-home-line bg-surface" onClick={onDownload} title="Download the profit and loss statement as a CSV file" data-testid="pl-export">
              <Download aria-hidden className="h-4 w-4" />
              Export
            </button>
          )}
          <button type="button" className="home-btn border border-home-line bg-surface" onClick={() => window.print()} aria-label="Print">
            <Printer aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 empty:hidden" data-print-hide>
        {dates.preset === "custom" && <CustomDates r={dates} />}
      </div>
      {data && (
        <p className="text-xs text-muted">
          Days in the store&apos;s time zone ({data.timezone}), in {data.currency}; weeks run Monday to Sunday.
          {data.grain !== s.picked && s.picked ? " Too many columns for those dates: shown a period coarser." : ""}
        </p>
      )}
    </header>
  );
}

/** The row of sections (the design's pills, the open one filled) with the page's quick actions on its right. */
function Tabs({ tab, onTab, actions }: { tab: Tab; onTab: (t: Tab) => void; actions: ReactNode }) {
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    onTab(next.id);
    document.getElementById(`pl-tab-${next.id}`)?.focus();
  };
  return (
    <div id="pl-tabs" className="flex scroll-mt-20 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-home-line pb-3" data-print-hide>
      <div role="tablist" aria-label="Profit and loss sections" className="-mx-4 flex max-w-[100vw] gap-1 overflow-x-auto px-4 sm:mx-0 sm:max-w-full sm:px-0" onKeyDown={keys}>
        {TABS.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`pl-tab-${t.id}`}
              aria-selected={on}
              aria-controls="pl-panel"
              tabIndex={on ? 0 : -1}
              className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-4 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${on ? "bg-accent text-accent-ink shadow-sm" : "text-muted hover:bg-home-soft hover:text-text"}`}
              onClick={() => onTab(t.id)}
              data-testid={`pl-tab-${t.id}`}
            >
              <t.icon aria-hidden className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quick actions" data-testid="pl-quick-actions">
        {actions}
      </div>
    </div>
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
