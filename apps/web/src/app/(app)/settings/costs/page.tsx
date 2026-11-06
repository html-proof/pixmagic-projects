"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { categoryLabel, type CustomCategory, type Expense, type ExpenseSection, type ExpenseTotals } from "@app/shared/expenses";
import { useApp } from "@/components/AppContext";
import { ConfirmDialog, Skeleton, useAction } from "@/components/AppUi";
import { blankCost, CostFields, draftOf, inputOf, termsOf, whenOf, type CostDraft } from "@/components/costs/CostForm";
import { fmtDay } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { api, fmtMoney, useApi } from "@/lib/api";

/**
 * Settings → Costs (docs/kpis.md, "Costs and net profit"): the store's own costs, which neither
 * Shopify nor the ad accounts can tell bizinsights, and from which day the owner says the list holds
 * every one. The dashboard spreads each cost over the days it covers and gives net profit only for
 * dates the list is complete for. Owners and admins change them; members who may see the sales
 * breakdown read them.
 */

interface Answer {
  currency: string;
  today: string;
  expenses: Expense[];
  /** The store's own categories (absent from older answers). */
  categories?: CustomCategory[];
  settings: { completeFrom: string | null; operatingWeekdays: number[]; updatedAt: string | null };
  thisMonth: ExpenseTotals & { from: string; to: string };
}

type Draft = CostDraft;

export default function CostsPage() {
  const { workspace, store, allowed, me } = useApp();
  const path = store ? `/workspaces/${workspace.id}/stores/${store.id}/expenses` : null;
  const { data, error, loading, reload } = useApi<Answer>(path);
  // Owners, admins and members given "Manage costs", signed in to their account (a shared link only reads).
  const editable = allowed("finance.costs") && !me.shared;
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [removing, setRemoving] = useState<Expense | null>(null);
  const [complete, setComplete] = useState<{ on: boolean; from: string } | null>(null);
  // Another store or workspace: whatever was being edited was that one's.
  useEffect(() => {
    setEditing(null);
    setComplete(null);
  }, [path]);

  if (!store) return <EmptyState title="No store yet" body="Connect a Shopify store first: costs are kept per store, in its currency." />;
  if (!data) {
    if (error) return <LoadError what="your costs" error={error} onRetry={reload} busy={loading} />;
    return (
      <section className="card">
        <Skeleton lines={4} />
      </section>
    );
  }

  const money = (n: number) => fmtMoney(n, data.currency);
  const shownComplete = complete ?? { on: data.settings.completeFrom !== null, from: data.settings.completeFrom ?? `${data.today.slice(0, 8)}01` };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing || !path) return;
    const { id, draft } = editing;
    const ok = await run("save", id ? "save the cost" : "add the cost", async () => {
      await api(id ? `${path}/${id}` : path, { method: id ? "PUT" : "POST", body: inputOf(draft, data!.currency) });
      return id ? "Cost saved." : "Cost added.";
    });
    if (ok) {
      setEditing(null);
      await reload();
    }
  }

  async function remove() {
    if (!removing || !path) return;
    const ok = await run("remove", "remove the cost", async () => {
      await api(`${path}/${removing.id}`, { method: "DELETE" });
      return "Cost removed.";
    });
    setRemoving(null);
    if (ok) await reload();
  }

  async function saveComplete(next: { on: boolean; from: string }) {
    if (!path) return;
    const ok = await run("complete", "save whether your costs list is complete", async () => {
      await api(`${path}/settings`, { method: "PUT", body: { completeFrom: next.on ? next.from : null } });
      return next.on ? `Net profit can now be shown for dates from ${fmtDay(next.from)}.` : "Your costs list is no longer marked complete.";
    });
    if (ok) {
      setComplete(null);
      await reload();
    }
  }

  const set = (patch: Partial<Draft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const categories = data.categories ?? [];
  async function createCategory(name: string, section: ExpenseSection): Promise<CustomCategory | null> {
    let made: CustomCategory | null = null;
    await run("category", "add the category", async () => {
      made = (await api<{ category: CustomCategory }>(`/workspaces/${workspace.id}/stores/${store!.id}/expense-categories`, { method: "POST", body: { name, section } })).category;
      await reload();
      return `${name} added.`;
    });
    return made;
  }

  return (
    <>
      <section className="card space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="card-title">Costs</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              The costs bizinsights can&apos;t read from Shopify or your ad accounts: rent, salaries, software, your Shopify plan and apps,
              shipping labels, packaging, payment fees, ads on platforms you haven&apos;t connected, and loan interest or income tax. Each is
              spread over the days it covers (a monthly cost counts in full for a whole month), in {data.currency}, and shown on the dashboard
              and in the Profit sheet&apos;s profit and loss as fixed, variable or below operating profit. They are your own figures: bizinsights
              doesn&apos;t check them.
            </p>
          </div>
          {editable && !editing && (
            <button type="button" className="btn-primary" onClick={() => setEditing({ id: null, draft: blankCost(data.today) })} data-testid="cost-add">
              Add a cost
            </button>
          )}
        </div>
        <p className="text-sm" data-testid="costs-this-month">
          This month so far ({fmtDay(data.thisMonth.from, { year: false })} – {fmtDay(data.thisMonth.to, { year: false })}): <b className="tabular-nums">{money(data.thisMonth.total)}</b>
          {data.thisMonth.byCategory.length > 0 && (
            <span className="text-muted"> · {data.thisMonth.byCategory.map((c) => `${categoryLabel(c.category, categories)} ${money(c.amount)}`).join(" · ")}</span>
          )}
        </p>
        <p className="text-sm">
          <Link className="font-medium text-accent hover:underline" href="/profit">
            Profit &amp; Loss
          </Link>{" "}
          has the full list: every payment of your recurring costs, pausing and resuming them, your own categories, and the profit and loss they give.
        </p>
        {!editable && <Alert kind="info">Ask an owner or admin for &ldquo;Manage costs&rdquo; in Team &amp; Access to change the costs.</Alert>}
      </section>

      {editing && (
        <section className="card">
          <h2 className="font-semibold">{editing.id ? "Change the cost" : "Add a cost"}</h2>
          <form onSubmit={save} className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="cost-form">
            <CostFields draft={editing.draft} currency={data.currency} set={set} categories={categories} onCreateCategory={createCategory} />
            <div className="flex gap-2 sm:col-span-2">
              <button className="btn-primary" disabled={busy === "save"}>{busy === "save" ? "Saving…" : editing.id ? "Save" : "Add"}</button>
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="font-semibold">Your costs</h2>
        {data.expenses.length === 0 ? (
          <EmptyState title="No costs yet" body="Add what your store pays for besides its products and the ad accounts you've connected." />
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="cost-list">
            {data.expenses.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5" data-testid="cost-row">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{e.name}</span>
                  <span className="block text-xs text-muted">
                    {categoryLabel(e.category, categories)} · {whenOf(e)}
                    {e.endsOn && e.endsOn < data.today ? " · ended" : ""}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                </span>
                <span className="tabular-nums">{termsOf(e, data.currency)}</span>
                {editable && (
                  <span className="flex gap-3">
                    <button type="button" className="text-accent hover:underline" onClick={() => setEditing({ id: e.id, draft: draftOf(e, categories) })} aria-label={`Change ${e.name}`}>
                      Change
                    </button>
                    <button type="button" className="text-danger hover:underline" onClick={() => setRemoving(e)} aria-label={`Remove ${e.name}`}>
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3" data-testid="costs-complete">
        <h2 className="font-semibold">Net profit</h2>
        <p className="max-w-2xl text-sm text-muted">
          The dashboard shows net profit only once you say this list holds every cost your store has, and only for dates from that day: it is
          your revenue (net sales, shipping and fees, without tax) less Shopify&apos;s product costs, your connected ad accounts&apos; spend and the
          costs above. Until then it shows what&apos;s left after the costs it can see, and says that isn&apos;t net profit.
        </p>
        {data.settings.completeFrom ? (
          <p className="text-sm">
            Marked complete from <b>{fmtDay(data.settings.completeFrom)}</b>.
          </p>
        ) : (
          <p className="text-sm">Not marked complete.</p>
        )}
        {editable && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={shownComplete.on} onChange={(e) => setComplete({ ...shownComplete, on: e.target.checked })} />
              This list holds every cost from
            </label>
            <input aria-label="Complete from" className="input w-auto py-1.5" type="date" disabled={!shownComplete.on} value={shownComplete.from} onChange={(e) => setComplete({ ...shownComplete, from: e.target.value })} />
            <button type="button" className="btn-secondary" disabled={!complete || busy === "complete" || (complete.on && !complete.from)} onClick={() => complete && saveComplete(complete)}>
              {busy === "complete" ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </section>

      <ConfirmDialog open={removing !== null} title="Remove this cost?" confirmLabel="Remove" danger busy={busy === "remove"} onConfirm={remove} onCancel={() => setRemoving(null)}>
        <p className="text-sm text-muted">
          {removing ? `${removing.name} (${termsOf(removing, data.currency)}) stops counting on every date, past ones too. To stop it from a day on, give it an end date instead.` : ""}
        </p>
      </ConfirmDialog>
    </>
  );
}
