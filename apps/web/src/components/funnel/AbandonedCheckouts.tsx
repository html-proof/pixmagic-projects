"use client";
import Link from "next/link";
import { LineChart, type LineSeries } from "@/components/dashboard/LineChart";
import { Empty, NeutralDelta, Panel, Stat } from "@/components/dashboard/Primitives";
import { asOfWords } from "@/components/dashboard/ShopifyReports";
import { fmtDay } from "@/components/dashboard/format";
import { fmtMoney, fmtNum, fmtPct, friendlyError } from "@/lib/api";
import { count } from "./FunnelUi";
import type { AbandonedCheckoutsModule, CheckoutFigures, CheckoutsStatus } from "./useAbandonedCheckouts";
import { useAbandonedCheckouts } from "./useAbandonedCheckouts";

/**
 * Shopify's own abandoned checkouts for the dates (docs/kpis.md "Abandoned checkouts (Shopify)"):
 * how many there were, their value, and how many were recovered, against the comparison. Every
 * figure is Shopify's; a gap says why in words, never as 0. Not the pixel's "left at checkout"
 * (tracked visits) and not Shopify's "sessions that reached checkout": the help line says so.
 */
export function AbandonedCheckoutsCard({ qs, currency, versus }: { qs: string | null; currency: string; versus?: string }) {
  const s = useAbandonedCheckouts(qs);
  if (!s.shown) return null;
  // Never the dates asked before under the new ones: until their answer arrives, it says it's asking.
  const m = s.data && !s.older ? s.data.module : null;
  const when = m ? asOfWords(m) : null;
  return (
    <Panel
      id="abandoned"
      title="Abandoned checkouts (Shopify)"
      help={`Shopify's own abandoned checkouts list: checkouts where the shopper gave an email or phone number and didn't pay, counted on the day each was started (archived ones included). Recovered ones were completed later. Not the visits the bizinsights pixel saw leave at checkout, nor Shopify's sessions that reached checkout.${when ? ` ${when[0]!.toUpperCase()}${when.slice(1)}.` : ""}`}
      aside={
        s.contacts ? (
          <Link href="/dashboard?view=customers" className="text-accent underline underline-offset-2">
            See who to follow up
          </Link>
        ) : null
      }
    >
      {!m ? (
        s.error ? (
          <div className="space-y-3">
            <Empty>Couldn&apos;t load Shopify&apos;s abandoned checkouts. {friendlyError(s.error)}</Empty>
            <button type="button" className="btn-secondary" disabled={s.loading} onClick={s.refresh}>
              {s.loading ? "Trying…" : "Try again"}
            </button>
          </div>
        ) : (
          <Empty>Asking Shopify… This updates by itself in a moment.</Empty>
        )
      ) : !m.current ? (
        <Empty>{statusNote(m.status, m.visibleFrom)}</Empty>
      ) : (
        <Figures m={m} c={m.current} currency={m.current.currency ?? currency} versus={versus} />
      )}
    </Panel>
  );
}

/** Why there are no figures, in words. */
function statusNote(status: CheckoutsStatus, visibleFrom: string | null): string {
  switch (status) {
    case "access_denied":
      return "Shopify hasn't approved bizinsights to read this store's checkouts yet. bizinsights is waiting on Shopify's approval for customer data; nothing is counted until then.";
    case "unsupported":
      return "Shopify can't list abandoned checkouts for this store.";
    case "failed":
      return "Couldn't reach Shopify just now. We'll ask again in a few minutes.";
    case "beyond_history":
      return `Shopify shares the last 60 days of checkouts${visibleFrom ? ` (from ${fmtDay(visibleFrom)})` : ""}. Pick dates from then on to see them.`;
    default:
      return "Asking Shopify… This updates by itself in a moment.";
  }
}

const VALUE_GAP: Record<NonNullable<CheckoutFigures["valueGap"]>, string> = {
  too_many: "More than 2,000 checkouts in these dates: bizinsights adds up the value of 2,000 at most, so it isn't shown. The counts are Shopify's own, in full.",
  mixed_currency: "These checkouts are in more than one currency, so their value isn't added up.",
  withheld: "Shopify withheld the price of some of these checkouts, so their value isn't added up.",
};

const COLORS = { abandoned: "var(--viz-cat-1)", recovered: "var(--viz-cat-2)" };

function Figures({ m, c, currency, versus }: { m: AbandonedCheckoutsModule; c: CheckoutFigures; currency: string; versus?: string }) {
  const money = (n: number | null) => (n === null ? "Not added up" : fmtMoney(n, currency));
  const days = c.days ?? null;
  const series: LineSeries[] = days
    ? [
        { key: "abandoned", label: "Abandoned", color: COLORS.abandoned, values: days.map((d) => d.abandoned) },
        { key: "recovered", label: "Recovered so far", color: COLORS.recovered, values: days.map((d) => d.recovered) },
      ]
    : [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Abandoned checkouts" value={`${fmtNum(c.abandoned)}${c.abandonedExact ? "" : "+"}`} note={<NeutralDelta value={m.deltas.abandoned} label={versus} />} />
        <Stat label="Abandoned checkout value" value={money(c.value)} note={<NeutralDelta value={m.deltas.value} label={versus} />} />
        <Stat
          label="Recovered so far"
          value={`${fmtNum(c.recovered)}${c.recoveredExact ? "" : "+"}`}
          tone="good"
          note={
            // Not toned good or bad: the dates compared with have had longer for their checkouts to be
            // recovered, so a fall is often only timing (docs/kpis.md).
            <>
              {c.recoveredRate !== null ? `${fmtPct(c.recoveredRate)} of them · ` : ""}
              <NeutralDelta value={m.deltas.recoveredRate} label={versus} />
              {m.deltas.recoveredRate !== null && (
                <span className="mt-1 block text-xs text-muted">Recent checkouts can still be recovered, so the newer dates&apos; rate can still rise.</span>
              )}
            </>
          }
        />
        <Stat label="Recovered value" value={money(c.recoveredValue)} note="Checkouts completed later" />
      </div>
      {c.valueGap && (
        <p className="alert alert-warn text-sm" data-testid="abandoned-value-gap">
          {VALUE_GAP[c.valueGap]}
        </p>
      )}
      {m.previousStatus === "beyond_history" && (
        <p className="text-xs text-muted" data-testid="abandoned-previous-beyond">
          The dates compared with are older than the 60 days of checkouts Shopify shares, so there is nothing to compare with.
        </p>
      )}
      {days && days.length > 1 && (
        <div>
          <LineChart
            days={days.map((d) => d.day)}
            series={series}
            label="Abandoned and recovered checkouts, day by day"
            format={(v) => count(v, "checkout")}
            fmtAxis={(v) => fmtNum(v)}
            integer
            bars
            height={180}
          />
          <p className="mt-2 text-xs text-muted">
            Vertical axis: checkouts, on the day each was started. Horizontal axis: date. A recovery counts on the day its checkout was started, so recent days&apos; recoveries can still come in.
          </p>
        </div>
      )}
    </div>
  );
}
