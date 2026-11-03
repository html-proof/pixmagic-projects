"use client";
import { useState } from "react";
import { CalendarClock, History, Pause, Pencil, Play, Square, Trash2 } from "lucide-react";
import { categoryLabel, EXPENSE_SECTION_LABEL, categorySection } from "@app/shared/expenses";
import { ConfirmDialog, Dialog, Skeleton, useAction } from "@/components/AppUi";
import { draftOf, isRecurring, termsOf, whenOf } from "@/components/costs/CostForm";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtDateTime, fmtDay, fmtSpan } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { api, fmtMoney, useApi } from "@/lib/api";
import type { Editing } from "./ExpenseDialog";
import type { ListedExpense, StatementState } from "./useStatement";

// ---------------------------------------------------------------------------
// The store's recurring costs (docs/kpis.md "Costs and net profit"): each one's next payment and
// state, paused, resumed, ended or changed; every payment recorded so far, changed or skipped one by
// one; and who changed what, from the audit log. Then the costs worked out from the sales.
// ---------------------------------------------------------------------------

type State = "active" | "paused" | "ended" | "scheduled";
const STATE: Record<State, { label: string; tone: Tone }> = { active: { label: "Active", tone: "good" }, paused: { label: "Paused", tone: "warn" }, ended: { label: "Ended", tone: "neutral" }, scheduled: { label: "Starts later", tone: "neutral" } };

const stateOf = (e: ListedExpense, today: string): State => (e.pausedFrom ? "paused" : e.endsOn && e.endsOn < today ? "ended" : e.startsOn > today ? "scheduled" : e.nextDue === null ? "ended" : "active");

export function RecurringCosts({ s, onEdit, onPayments }: { s: StatementState; onEdit: (e: Editing) => void; onPayments: (e: ListedExpense) => void }) {
  const { busy, run } = useAction();
  const [ending, setEnding] = useState<ListedExpense | null>(null);
  const [removing, setRemoving] = useState<ListedExpense | null>(null);
  const costs = s.costs;
  if (!costs) {
    return (
      <section className="card" aria-labelledby="pl-recurring-h">
        <h2 id="pl-recurring-h" className="font-semibold">
          Recurring expenses
        </h2>
        {s.costsError ? <LoadError what="your recurring expenses" error={s.costsError} onRetry={() => void s.changed()} /> : <Skeleton lines={3} />}
      </section>
    );
  }
  const today = costs.today;
  const money = (n: number) => fmtMoney(n, costs.currency);
  const recurring = costs.expenses.filter(isRecurring);
  const rules = costs.expenses.filter((e) => (e.method ?? "amount") !== "amount");
  const order: State[] = ["active", "paused", "scheduled", "ended"];
  const sorted = [...recurring].sort((a, b) => order.indexOf(stateOf(a, today)) - order.indexOf(stateOf(b, today)) || (a.nextDue ?? "9").localeCompare(b.nextDue ?? "9"));
  const monthly = recurring.filter((e) => stateOf(e, today) === "active").reduce((n, e) => n + monthlyOf(e), 0);

  const act = (e: ListedExpense, action: "pause" | "resume") =>
    run(action, action === "pause" ? `pause ${e.name}` : `resume ${e.name}`, async () => {
      await api(`${s.base}/expenses/${e.id}/${action}`, { method: "POST", body: {} });
      await s.changed();
      return action === "pause" ? `${e.name} is paused: no payment falls due until you resume it.` : `${e.name} is running again.`;
    });
  async function end() {
    if (!ending) return;
    await run("end", `end ${ending.name}`, async () => {
      await api(`${s.base}/expenses/${ending.id}/end`, { method: "POST", body: {} });
      await s.changed();
      return `${ending.name} ends after its current payment.`;
    });
    setEnding(null);
  }
  async function remove() {
    if (!removing) return;
    await run("remove", `remove ${removing.name}`, async () => {
      await api(`${s.base}/expenses/${removing.id}`, { method: "DELETE" });
      await s.changed();
      return `${removing.name} removed.`;
    });
    setRemoving(null);
  }

  const icon = "grid size-8 place-items-center rounded-md text-muted transition hover:bg-bg hover:text-text disabled:opacity-40";
  return (
    <section className="card min-w-0" aria-labelledby="pl-recurring-h" data-testid="pl-recurring">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="pl-recurring-h" className="font-semibold">
            Recurring expenses
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-muted">
            Each payment is recorded on the day it falls due, once, and kept as it was paid: changing a cost from its next payment leaves the months already reported as they were.
            {monthly > 0 && ` Running costs come to about ${money(monthly)} a month.`}
          </p>
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No recurring expenses yet. Add one with a payment frequency (every week, month, quarter…).</p>
      ) : (
        <div className="relative mt-3 overflow-x-auto rounded-lg border border-border" role="region" aria-label="Recurring expenses" tabIndex={0}>
          <table className="min-w-full text-sm">
            <thead className="bg-bg/60 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Expense
                </th>
                <th scope="col" className="whitespace-nowrap px-3 py-2 text-right font-semibold">
                  Amount
                </th>
                <th scope="col" className="whitespace-nowrap px-3 py-2 font-semibold">
                  Next payment
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((e) => {
                const st = stateOf(e, today);
                return (
                  <tr key={e.id} className="align-top" data-testid="pl-recurring-row" data-state={st}>
                    <td className="min-w-[12rem] px-3 py-2.5">
                      <span className="font-medium">{e.name}</span>
                      <span className="block text-xs text-muted">
                        {categoryLabel(e.category, costs.categories)} · {EXPENSE_SECTION_LABEL[categorySection(e.category, costs.categories) ?? "fixed"]} · {whenOf(e)}
                        {e.vendor ? ` · ${e.vendor}` : ""}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{termsOf(e, costs.currency)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{e.nextDue ? fmtDay(e.nextDue) : e.pausedFrom ? `Paused from ${fmtDay(e.pausedFrom)}` : "—"}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={STATE[st].tone}>{STATE[st].label}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-0.5">
                        <button type="button" className={icon} aria-label={`Payments and history of ${e.name}`} title="Payments and history" onClick={() => onPayments(e)} data-testid="pl-recurring-payments">
                          <History aria-hidden className="h-4 w-4" />
                        </button>
                        {s.canManage && (
                          <>
                            <button type="button" className={icon} aria-label={`Edit ${e.name}`} title="Edit schedule" onClick={() => onEdit({ expense: e, draft: draftOf(e, costs.categories) })}>
                              <Pencil aria-hidden className="h-4 w-4" />
                            </button>
                            {st === "paused" ? (
                              <button type="button" className={icon} aria-label={`Resume ${e.name}`} title="Resume" disabled={busy === "resume"} onClick={() => void act(e, "resume")} data-testid="pl-recurring-resume">
                                <Play aria-hidden className="h-4 w-4" />
                              </button>
                            ) : (
                              <button type="button" className={icon} aria-label={`Pause ${e.name}`} title="Pause" disabled={st !== "active" || busy === "pause"} onClick={() => void act(e, "pause")} data-testid="pl-recurring-pause">
                                <Pause aria-hidden className="h-4 w-4" />
                              </button>
                            )}
                            <button type="button" className={icon} aria-label={`End ${e.name}`} title="End (cancel) after the current payment" disabled={st === "ended" || st === "scheduled"} onClick={() => setEnding(e)} data-testid="pl-recurring-end">
                              <Square aria-hidden className="h-4 w-4" />
                            </button>
                            <button type="button" className={`${icon} hover:bg-danger/10 hover:text-danger`} aria-label={`Remove ${e.name}`} title="Remove" onClick={() => setRemoving(e)}>
                              <Trash2 aria-hidden className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rules.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Worked out from your sales</h3>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm" data-testid="pl-rules">
            {rules.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{e.name}</span>
                  <span className="block text-xs text-muted">
                    {categoryLabel(e.category, costs.categories)} · {whenOf(e)}
                  </span>
                </span>
                <span className="tabular-nums">{termsOf(e, costs.currency)}</span>
                {s.canManage && (
                  <button type="button" className={icon} aria-label={`Edit ${e.name}`} title="Edit" onClick={() => onEdit({ expense: e, draft: draftOf(e, costs.categories) })}>
                    <Pencil aria-hidden className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog open={ending !== null} title="End this recurring expense?" confirmLabel="End it" busy={busy === "end"} onConfirm={end} onCancel={() => setEnding(null)}>
        <p className="text-sm text-muted">
          {ending ? `${ending.name} ends after its current payment${ending.nextDue ? `: no payment falls due from ${fmtDay(ending.nextDue)} on` : ""}. The payments made stay in your reports.` : ""}
        </p>
      </ConfirmDialog>
      <ConfirmDialog open={removing !== null} title="Remove this recurring expense?" confirmLabel="Remove" danger busy={busy === "remove"} onConfirm={remove} onCancel={() => setRemoving(null)}>
        <p className="text-sm text-muted">{removing ? `${removing.name} and every payment of it stop counting on every date, past ones too. To keep the past, end it instead.` : ""}</p>
      </ConfirmDialog>
    </section>
  );
}

/** A recurring cost's monthly equivalent, for the summary line. */
function monthlyOf(e: ListedExpense): number {
  const per: Record<string, number> = { daily: 365 / 12, weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, half_yearly: 1 / 6, yearly: 1 / 12 };
  return e.amount * (per[e.cadence] ?? 0);
}

interface PaymentView {
  due: string;
  to: string;
  amount: number;
  scheduledAmount: number;
  status: "posted" | "skipped" | "upcoming";
  edited: boolean;
  note: string | null;
}
interface HistoryEntry {
  id: string;
  action: string;
  at: string;
  actor: string | null;
  detail: Record<string, unknown>;
}

const ACTION_WORDS: Record<string, string> = {
  "expense.added": "Added",
  "expense.changed": "Changed",
  "expense.removed": "Removed",
  "expense.paused": "Paused",
  "expense.resumed": "Resumed",
  "expense.ended": "Ended",
  "expense.payment_changed": "Payment changed",
};

/** What an audit entry changed, in a line: "amount 2,300 → 2,500", "payment of 1 Oct: 2,300 → 2,450". */
function detailWords(h: HistoryEntry, currency: string): string {
  const d = h.detail as { before?: Record<string, unknown> | null; after?: Record<string, unknown>; due?: string; amount?: number; endsOn?: string; pausedFrom?: string; skipped?: number; replaces?: string };
  const money = (n: unknown) => (typeof n === "number" ? fmtMoney(n, currency) : "—");
  if (h.action === "expense.payment_changed") return `Payment due ${d.due ? fmtDay(d.due) : ""}: ${money(d.before?.amount ?? d.after?.scheduledAmount)} → ${d.after?.status === "skipped" ? "skipped" : money(d.after?.amount)}`;
  if (h.action === "expense.changed" && d.before && d.after) {
    const changed = Object.keys(d.after).filter((k) => JSON.stringify(d.after![k]) !== JSON.stringify(d.before![k]));
    return changed.length ? changed.map((k) => `${k}: ${k === "amount" ? `${money(d.before![k])} → ${money(d.after![k])}` : `${String(d.before![k] ?? "—")} → ${String(d.after![k] ?? "—")}`}`).join(" · ") : "No change to its terms";
  }
  if (h.action === "expense.ended") return d.endsOn ? `Last day ${fmtDay(d.endsOn)}` : "";
  if (h.action === "expense.paused") return d.pausedFrom ? `No payment from ${fmtDay(d.pausedFrom)}` : "";
  if (h.action === "expense.resumed") return d.skipped ? `${d.skipped} payment${d.skipped === 1 ? "" : "s"} skipped while paused` : "";
  if (h.action === "expense.added") return `${money(d.amount)}${d.replaces ? ", taking over from the earlier terms" : ""}`;
  return "";
}

/**
 * A recurring cost's payments (recorded, and the next to come) and its history. A payment is
 * changed or skipped on its own, keeping what the cost said; `focus` is the payment opened from the
 * expenses table.
 */
export function PaymentsDialog({ s, expense, focus, onClose }: { s: StatementState; expense: ListedExpense | null; focus: string | null; onClose: () => void }) {
  const path = expense && s.base ? `${s.base}/expenses/${expense.id}` : null;
  const payments = useApi<{ currency: string; payments: PaymentView[] }>(path ? `${path}/payments` : null);
  const history = useApi<{ history: HistoryEntry[] }>(path ? `${path}/history` : null);
  const [editing, setEditing] = useState<{ due: string; amount: string; note: string } | null>(null);
  const [tab, setTab] = useState<"payments" | "history">("payments");
  const { busy, run } = useAction();
  const currency = payments.data?.currency ?? s.costs?.currency ?? "USD";
  const money = (n: number) => fmtMoney(n, currency);

  async function save(due: string, body: Record<string, unknown>, what: string) {
    if (!path) return;
    const ok = await run("payment", what, async () => {
      await api(`${path}/payments/${due}`, { method: "PUT", body });
      return "Payment saved.";
    });
    if (ok) {
      setEditing(null);
      await Promise.all([payments.reload(), history.reload(), s.changed()]);
    }
  }

  return (
    <Dialog
      open={expense !== null}
      title={expense ? `${expense.name}: payments` : "Payments"}
      onClose={() => {
        setEditing(null);
        setTab("payments");
        onClose();
      }}
    >
      {expense && (
        <div className="space-y-3 text-sm" data-testid="pl-payments">
          <p className="text-muted">
            {termsOf(expense, currency)} · {whenOf(expense)}
          </p>
          <div className="flex gap-1 rounded-lg border border-border bg-bg p-0.5" role="tablist" aria-label="Payments or history">
            {(["payments", "history"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={`h-8 flex-1 rounded-md text-sm font-medium ${tab === t ? "bg-surface shadow-sm" : "text-muted"}`} onClick={() => setTab(t)}>
                {t === "payments" ? "Payments" : "History"}
              </button>
            ))}
          </div>
          {tab === "payments" ? (
            payments.error && !payments.data ? (
              <LoadError what="the payments" error={payments.error} onRetry={payments.reload} />
            ) : !payments.data ? (
              <Skeleton lines={4} />
            ) : payments.data.payments.length === 0 ? (
              <p className="text-muted">No payment has fallen due yet.</p>
            ) : (
              <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {payments.data.payments.map((p) => (
                  <li key={p.due} className={`px-3 py-2 ${p.due === focus ? "bg-accent/8" : ""}`} data-testid="pl-payment-row">
                    <div className="flex flex-wrap items-center gap-2">
                      <CalendarClock aria-hidden className="h-4 w-4 text-muted" />
                      <span className="font-medium">{fmtDay(p.due)}</span>
                      <span className="text-xs text-muted">covers {fmtSpan(p.due, p.to)}</span>
                      <span className={`ml-auto tabular-nums ${p.status === "skipped" ? "text-muted line-through" : "font-medium"}`}>{money(p.status === "skipped" ? p.scheduledAmount : p.amount)}</span>
                      <Badge tone={p.status === "upcoming" ? "warn" : p.status === "skipped" ? "neutral" : "good"}>{p.status === "upcoming" ? "Upcoming" : p.status === "skipped" ? "Skipped" : p.edited ? "Changed" : "Paid"}</Badge>
                    </div>
                    {p.edited && p.status !== "skipped" && p.amount !== p.scheduledAmount && <p className="mt-0.5 text-xs text-muted">Scheduled {money(p.scheduledAmount)}</p>}
                    {p.note && <p className="mt-0.5 text-xs text-muted">{p.note}</p>}
                    {s.canManage &&
                      (editing?.due === p.due ? (
                        <form
                          className="mt-2 flex flex-wrap items-end gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void save(p.due, { amount: Number(editing.amount), note: editing.note.trim() ? editing.note : null }, "save the payment");
                          }}
                        >
                          <label className="flex flex-col gap-1 text-xs text-muted">
                            Amount ({currency})
                            <input className="input h-9 w-32" required type="number" min={0} step="0.01" value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} data-testid="pl-payment-amount" />
                          </label>
                          <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-muted">
                            Note
                            <input className="input h-9" maxLength={500} value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                          </label>
                          <button className="btn-primary h-9 px-3 text-sm" disabled={busy === "payment"}>
                            Save
                          </button>
                          <button type="button" className="btn-secondary h-9 px-3 text-sm" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <p className="mt-1 flex flex-wrap gap-3 text-xs">
                          <button type="button" className="text-accent hover:underline" onClick={() => setEditing({ due: p.due, amount: String(p.amount || p.scheduledAmount), note: p.note ?? "" })} data-testid="pl-payment-change">
                            Change amount
                          </button>
                          {p.status !== "skipped" ? (
                            <button type="button" className="text-accent hover:underline" disabled={busy === "payment"} onClick={() => void save(p.due, { skipped: true }, "skip the payment")}>
                              Skip
                            </button>
                          ) : null}
                          {(p.edited || p.status === "skipped") && (
                            <button type="button" className="text-accent hover:underline" disabled={busy === "payment"} onClick={() => void save(p.due, { reset: true }, "put the payment back")}>
                              Back to {money(p.scheduledAmount)}
                            </button>
                          )}
                        </p>
                      ))}
                  </li>
                ))}
              </ul>
            )
          ) : history.error && !history.data ? (
            <LoadError what="the history" error={history.error} onRetry={history.reload} />
          ) : !history.data ? (
            <Skeleton lines={4} />
          ) : (
            <ul className="max-h-[50vh] space-y-2 overflow-y-auto" data-testid="pl-history">
              {history.data.history.map((h) => (
                <li key={h.id} className="rounded-lg border border-border px-3 py-2">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{ACTION_WORDS[h.action] ?? h.action}</span>
                    <span className="text-xs text-muted">
                      {fmtDateTime(h.at, s.data?.timezone ?? "UTC")}
                      {h.actor ? ` · ${h.actor}` : ""}
                    </span>
                  </p>
                  {detailWords(h, currency) && <p className="mt-0.5 text-xs text-muted">{detailWords(h, currency)}</p>}
                </li>
              ))}
              {history.data.history.length === 0 && <p className="text-muted">No changes recorded.</p>}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
