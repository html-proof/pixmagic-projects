"use client";
import type { ReactNode } from "react";
import type { AdsenseTotals, AdTotals } from "@app/shared/ads";
import { fmtMoney, fmtNum } from "@/lib/api";
import { BEING_READ, ChangeNote, ComparedLine, SoFarNote, UNAVAILABLE, UnavailableNote } from "@/components/dashboard/AdsCommon";
import { shownFigures } from "@/components/dashboard/adFigures";
import { DemoChip } from "@/components/dashboard/Advertising";
import { fmtMoneyWhole, fmtSpan, fmtTimes } from "@/components/dashboard/format";
import { Delta } from "@/components/dashboard/Primitives";
import type { AdAccount, AdFigures, Overview } from "@/components/dashboard/types";

// ---------------------------------------------------------------------------
// The Advertising overview's headline figures: every spend platform together, each figure with the
// one it is compared with and the change, on the days the API compared (an ad module's `compared`:
// whole days only, never against days an account hasn't stored); with no comparison, why. The
// platforms' own counts are named as theirs; the store's own sales per unit of spend (MER) are
// Shopify's; AdSense's earnings are money in, on a tile of their own, never added to the spend.
// ---------------------------------------------------------------------------

function Tile({ label, source, value, children, testid }: { label: string; source: string; value: string; children?: ReactNode; testid: string }) {
  return (
    <div className="card lift min-w-0" data-testid={testid}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold tabular-nums" data-testid={`${testid}-value`}>
        {value}
      </p>
      <div className="mt-1 space-y-1 text-xs text-muted">{children}</div>
      <p className="mt-2 text-[11px] uppercase tracking-wide text-muted">{source}</p>
    </div>
  );
}

/**
 * One figure of an ad module: its value for the dates (or the days so far, dated; or Unavailable and
 * why), its change, and what was compared.
 */
function FigureTile<T>({
  label,
  source,
  fig,
  accounts,
  ov,
  pick,
  delta,
  invert = false,
  neutral = false,
  testid,
}: {
  label: string;
  source: string;
  fig: AdFigures<T>;
  accounts: AdAccount[];
  ov: Overview;
  /** The figure, shown; null while some of its days are being read again. */
  pick: (t: T) => string | null;
  /** Its change, from the module's `deltas`. */
  delta: number | null;
  invert?: boolean;
  neutral?: boolean;
  testid: string;
}) {
  const { totals, through } = shownFigures(fig);
  if (!totals) {
    return (
      <Tile label={label} source={source} value={UNAVAILABLE} testid={testid}>
        <UnavailableNote fig={fig} accounts={accounts} range={ov.range} show={(t) => pick(t) ?? BEING_READ} />
      </Tile>
    );
  }
  const shown = pick(totals);
  return (
    <Tile label={label} source={source} value={shown ?? BEING_READ} testid={testid}>
      {through && <SoFarNote through={through} accounts={accounts} range={ov.range} />}
      {shown !== null && (
        <>
          <p>
            <ChangeNote fig={fig} value={delta} ov={ov} invert={invert} neutral={neutral} />
          </p>
          {fig.compared && (
            <p data-testid={`${testid}-compared`}>
              <ComparedLine fig={fig} show={(t) => pick(t) ?? BEING_READ} />
            </p>
          )}
        </>
      )}
    </Tile>
  );
}

export function OverviewKpis({ ov }: { ov: Overview }) {
  const a = ov.modules.ads;
  const sense = ov.modules.adsense;
  if (!a && !sense) return null;
  const counted = a?.accounts.filter((acc) => acc.counted) ?? [];
  const money = (n: number) => fmtMoney(n, a?.currency ?? ov.store.currency);
  const s = a?.sales ?? null;
  const vs = s?.previous && a?.compared ? `vs ${fmtSpan(a.compared.previous.from, a.compared.previous.to)}` : null;
  return (
    <section aria-label="Advertising at a glance" className="space-y-2">
      {a?.demo && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="ads-demo-note">
          <DemoChip /> The Google Ads demo&apos;s simulated figures are among these accounts, so they aren&apos;t set against your store&apos;s own sales.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {a && (
          <>
            <FigureTile<AdTotals> label="Ad spend" source={`All platforms · ${a.currency}`} fig={a} accounts={counted} ov={ov} pick={(t) => money(t.spend)} delta={a.deltas.spend} neutral testid="kpi-spend" />
            <FigureTile<AdTotals> label="Purchases" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : fmtNum(t.purchases))} delta={a.deltas.purchases} testid="kpi-purchases" />
            <FigureTile<AdTotals> label="Purchase value" source="Platforms' own count" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchaseValue === null ? null : money(t.purchaseValue))} delta={a.deltas.purchaseValue} testid="kpi-purchase-value" />
            <FigureTile<AdTotals> label="Return on ad spend (ROAS)" source="Platforms' own" fig={a} accounts={counted} ov={ov} pick={(t) => (t.purchases === null ? null : fmtTimes(t.roas))} delta={a.deltas.roas} testid="kpi-roas" />
            <Tile label={`Sales per ${fmtMoneyWhole(1, a.currency)} of ads (MER)`} source="Shopify net sales ÷ ad spend" value={s ? fmtTimes(s.salesPerSpend) : UNAVAILABLE} testid="kpi-mer">
              {s ? (
                vs ? (
                  <>
                    <p>
                      <Delta value={s.deltas.salesPerSpend} label={vs} />
                    </p>
                    <p>Before: {fmtTimes(s.previous!.salesPerSpend)}</p>
                  </>
                ) : (
                  <p>Changes show once the dates picked are over, with your orders imported for the dates compared.</p>
                )
              ) : (
                <p>
                  {a.demo
                    ? "Not with the demo's simulated spend among the accounts."
                    : "Needs every day of the spend, in your store's currency, and permission to see your sales."}
                </p>
              )}
            </Tile>
          </>
        )}
        {sense && (
          <FigureTile<AdsenseTotals>
            label={sense.final ? "AdSense earnings (final)" : "AdSense estimated earnings"}
            source={`Money in, not ad spend · ${sense.currency}`}
            fig={sense}
            accounts={sense.accounts.filter((acc) => acc.counted)}
            ov={ov}
            pick={(t) => fmtMoney(t.earnings, sense.currency)}
            delta={sense.deltas.earnings}
            testid="kpi-adsense"
          />
        )}
      </div>
    </section>
  );
}
