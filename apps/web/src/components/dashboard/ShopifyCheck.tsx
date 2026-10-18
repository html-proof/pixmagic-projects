"use client";
import { useState } from "react";
import { actionError, api, fmtMoney, fmtNum, useApi } from "@/lib/api";
import { fmtRange, fmtRelative } from "./format";
import { Dot, type Tone } from "./Primitives";
import type { CheckDetail, CheckMetric, CheckSummary } from "./types";

/**
 * "Checked against Shopify" (packages/core/src/reconcile.ts, docs/kpis.md): every day bizinsights
 * reads a week of the store's orders back from Shopify, compares its figures with them, and puts
 * right any order that differs. This says how the last check came out: a pill beside the store's
 * status, and under "About this data" the figures side by side (for those who may see the sales
 * breakdown) with a button to check again now.
 */

const METRIC_LABEL: Record<CheckMetric, string> = {
  orders: "Orders",
  grossSales: "Gross sales",
  discounts: "Discounts",
  returns: "Returns",
  netSales: "Net sales",
  shipping: "Shipping charges",
  taxes: "Taxes",
  totalSales: "Total sales",
  units: "Items sold (net)",
};

const COUNTS: ReadonlySet<CheckMetric> = new Set(["orders", "units"]);

const RESULT_LABEL: Record<string, string> = {
  match: "Matches",
  repaired: "Fixed",
  difference: "Differs",
  sync_delay: "Changing",
  not_verifiable: "Couldn't check",
};

const FINDING_WORDS: Record<string, (n: number) => string> = {
  missing: (n) => `${n} ${n === 1 ? "order was" : "orders were"} missing`,
  deleted: (n) => `${n} ${n === 1 ? "order was" : "orders were"} deleted in Shopify`,
  outdated: (n) => `${n} ${n === 1 ? "order was" : "orders were"} out of date`,
  sales_differ: (n) => `${n} ${n === 1 ? "order's" : "orders'"} sales differed`,
  test_order: (n) => `${n} test ${n === 1 ? "order was" : "orders were"} counted`,
  changed_during_check: (n) => `${n} ${n === 1 ? "order" : "orders"} changed while checking`,
  not_listed: (n) => `${n} ${n === 1 ? "order" : "orders"} Shopify no longer shares`,
  stale_day: (n) => `${n} ${n === 1 ? "day's total was" : "days' totals were"} behind`,
};

/** The pill: how the last check came out, in a word, with the details on hover. */
export function checkPill(check: CheckSummary | undefined, now: number): { tone: Tone; label: string; title: string } | null {
  if (!check) return null;
  const last = check.last;
  if (!last) return check.running ? { tone: "neutral", label: "Checking with Shopify…", title: "bizinsights is reading your orders back from Shopify to check its figures." } : null;
  const when = fmtRelative(last.checkedAt, now);
  const days = fmtRange(last.from, last.to);
  const of = `${last.matched} of ${last.compared} figures`;
  if (last.status === "verified") return { tone: "good", label: "Matches Shopify", title: `Checked against your Shopify orders ${when}: ${days} match, all ${last.compared} figures to the cent.` };
  if (last.status === "repaired")
    return {
      tone: "good",
      label: "Matches Shopify",
      title: `Checked against your Shopify orders ${when}: ${days} match after bizinsights brought ${last.repaired === 1 ? "1 order" : `${fmtNum(last.repaired)} orders`} up to date.`,
    };
  if (last.status === "incomplete")
    return { tone: "neutral", label: "Mostly matches Shopify", title: `Checked against your Shopify orders ${when} for ${days}: ${of} match; the rest were still changing or couldn't be checked.` };
  return { tone: "warn", label: "Differs from Shopify", title: `Checked against your Shopify orders ${when} for ${days}: ${of} match. See About this data for which.` };
}

export function CheckPill({ check, now }: { check: CheckSummary | undefined; now: number }) {
  const p = checkPill(check, now);
  if (!p) return null;
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-sm font-medium shadow-[var(--shadow)]" title={p.title} data-testid="shopify-check">
      <Dot tone={p.tone} />
      {p.label}
    </span>
  );
}

const fmt = (m: CheckMetric, v: number | null, currency: string) => (v === null ? "—" : COUNTS.has(m) ? fmtNum(v) : fmtMoney(v, currency));

/**
 * Under "About this data": what the last check found, and (with the sales breakdown permission) its
 * figures; owners and admins can check again now.
 */
export function CheckDetails({ ws, storeId, check, seesFigures, canRun }: { ws: string; storeId: string; check: CheckSummary | undefined; seesFigures: boolean; canRun: boolean }) {
  const detail = useApi<CheckDetail>(seesFigures ? `/workspaces/${ws}/stores/${storeId}/check` : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const last = check?.last ?? null;
  const d = detail.data?.last ?? null;

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api(`/workspaces/${ws}/stores/${storeId}/check`, { method: "POST" });
      setNote("Checking now. This takes a minute or two; the result shows here and beside the store's status.");
    } catch (e) {
      setNote(actionError(e, "start the check"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2" data-testid="check-details">
      <p className="font-medium text-text">Checked against Shopify</p>
      {last ? (
        <p>
          {fmtRange(last.from, last.to)}, checked {fmtRelative(last.checkedAt)}: {last.matched} of {last.compared} figures match Shopify&apos;s orders
          {last.repaired > 0 ? <> after {last.repaired === 1 ? "1 order was" : `${fmtNum(last.repaired)} orders were`} brought up to date</> : null}.
          {d && Object.keys(d.findings).length > 0 && (
            <>
              {" "}
              It found:{" "}
              {Object.entries(d.findings)
                .map(([k, n]) => FINDING_WORDS[k]?.(n ?? 0))
                .filter(Boolean)
                .join("; ")}
              .
            </>
          )}
        </p>
      ) : (
        <p>{check?.running ? "The first check is running." : "Not checked yet: bizinsights checks each store's last 7 finished days every day."}</p>
      )}
      <p>
        Every day bizinsights reads the last week of orders back from Shopify, with each one&apos;s sales records, and adds them up again. Any order that differs (missing, out of
        date, or deleted in Shopify) is put right at once. Today is left out until it is over.
      </p>
      {seesFigures && d && d.results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-left text-xs tabular-nums" data-testid="check-table">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Figure</th>
                <th className="py-1 pr-3 font-medium">Shopify</th>
                <th className="py-1 pr-3 font-medium">bizinsights</th>
                <th className="py-1 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {d.results.map((r) => (
                <tr key={r.metric} className="border-t border-border">
                  <td className="py-1 pr-3 text-text">{METRIC_LABEL[r.metric] ?? r.metric}</td>
                  <td className="py-1 pr-3">{fmt(r.metric, r.shopify, d.currency)}</td>
                  <td className="py-1 pr-3">{fmt(r.metric, r.bizinsights, d.currency)}</td>
                  <td className="py-1">{RESULT_LABEL[r.status] ?? r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canRun && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={run} disabled={busy || !!check?.running} data-testid="check-now">
            {check?.running ? "Checking…" : busy ? "Starting…" : "Check now"}
          </button>
          {note && <span role="status">{note}</span>}
        </div>
      )}
    </div>
  );
}
