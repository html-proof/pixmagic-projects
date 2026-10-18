"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { AdTotals } from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { AccountStatus, accountGroups, AdStatusNotes, BEING_READ, ChangeNote, ComparedLine, dailyMoneyColumns, missingReason, missingReasons, runningWords, throughLabel, timeZoneNote, UNAVAILABLE } from "./AdsCommon";
import { noEarlierData } from "./DateRange";
import { fmtLongDay, fmtMoneyCompact, fmtMoneyWhole, fmtRange, fmtSpan, fmtTimes, plural } from "./format";
import { Icon } from "./Icons";
import { GoogleReportPanel } from "./GoogleReport";
import { MetaReportPanel } from "./MetaReport";
import { B, comparedOnWholeDays } from "./Narrative";
import { Panel, Stat } from "./Primitives";
import { ColumnsWithTotal } from "./ColumnsWithTotal";
import type { AdsModule, Overview } from "./types";

// ---------------------------------------------------------------------------
// The Ads panel: what connected Meta and Google ad accounts spent, and what they say it brought.
// Figures exist only for days every counted account has stored; a gap is "Unavailable" with its
// reason, never 0. Purchases are purchases only: Google's other conversions are named as such.
// ---------------------------------------------------------------------------

const PLATFORM: Record<"meta" | "google", { name: string; Icon: (p: { size?: number }) => ReactNode }> = {
  meta: { name: "Meta", Icon: MetaIcon },
  google: { name: "Google Ads", Icon: GoogleIcon },
};

/** A figure some days don't have yet (older days being read again from the platform). */
const known = (v: number | null, show: (n: number) => string) => (v === null ? BEING_READ : show(v));

function SpendChart({ a, ov }: { a: AdsModule; ov: Overview }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  const columns = dailyMoneyColumns(a.series, (d) => d.spend, ov.today, a.currency);
  return (
    <ColumnsWithTotal
      columns={columns}
      label={`Ad spend per day, ${fmtSpan(ov.range.from, ov.range.to)}, with the running total below`}
      fmtAxis={(v) => fmtMoneyCompact(v, a.currency)}
      runningLabel="Spent so far"
      fmtRunning={(v) => fmtMoneyWhole(v, a.currency)}
      tooltip={(i) => {
        const d = a.series[i]!;
        return (
          <>
            <div className="text-muted">{fmtLongDay(d.day)}{d.day === ov.today ? " · today so far" : ""}</div>
            {d.spend === null ? (
              <div className="mt-0.5 text-sm font-semibold">No figures for this day yet</div>
            ) : (
              <>
                <div className="mt-0.5 text-sm font-semibold tabular-nums">{money(d.spend)} spent</div>
                <div className="text-muted">
                  {d.linkClicks === null ? "link clicks being re-read" : plural(d.linkClicks, "link click")} · {plural(d.impressions ?? 0, "impression")}
                </div>
                {(d.purchases ?? 0) > 0 && <div className="text-muted">{fmtNum(d.purchases)} purchases (platforms&apos; count)</div>}
              </>
            )}
          </>
        );
      }}
      describe={(i) => {
        const d = a.series[i]!;
        if (d.spend === null) return `${fmtLongDay(d.day)}: no figures for this day yet.`;
        return `${fmtLongDay(d.day)}: ${money(d.spend)} spent, ${d.linkClicks === null ? "link clicks being re-read" : `${fmtNum(d.linkClicks)} link clicks`}, ${d.purchases === null ? "purchases being re-read" : `${fmtNum(d.purchases)} purchases`}.`;
      }}
      missingLabel="No data"
    />
  );
}

/** The figures at a glance: for the whole range, or, when that's unavailable, for the days every account has. */
function Glance({ a, t, ov, partial }: { a: AdsModule; t: AdTotals; ov: Overview; partial: boolean }) {
  const money = (n: number) => fmtMoney(n, a.currency);
  // Changes belong to the whole range only.
  const change = (value: number | null, neutral = false) => (partial ? undefined : <ChangeNote fig={a} value={value} ov={ov} neutral={neutral} />);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Ad spend" value={money(t.spend)} note={change(a.deltas.spend, true)} />
      <Stat label="Link clicks" value={known(t.linkClicks, fmtNum)} note={change(a.deltas.linkClicks)} />
      <Stat label="Purchases (platforms' count)" value={known(t.purchases, fmtNum)} note={change(a.deltas.purchases)} />
      <Stat label="Return on ad spend (platforms' own)" value={t.purchases === null ? BEING_READ : fmtTimes(t.roas)} note={change(a.deltas.roas)} />
      <Stat label="Purchase value (platforms' count)" value={known(t.purchaseValue, money)} />
      <Stat label="Cost per purchase" value={t.purchases === null ? BEING_READ : t.costPerPurchase !== null ? money(t.costPerPurchase) : "—"} />
      <Stat label="Cost per click" value={t.linkClicks === null ? BEING_READ : t.cpc !== null ? money(t.cpc) : "—"} note="Spend ÷ link clicks" />
      <Stat label="Click-through rate" value={t.linkClicks === null ? BEING_READ : fmtPct(t.ctr)} note={`${fmtNum(t.impressions)} impressions`} />
      <Stat label="Cost per 1,000 impressions" value={t.cpm !== null ? money(t.cpm) : "—"} />
      {!partial && <Stat label="Ads as share of sales" value={fmtPct(a.shareOfSales)} note="Ad spend ÷ your net sales" />}
      {t.leads > 0 && <Stat label="Leads" value={fmtNum(t.leads)} />}
    </div>
  );
}

export function AdsDetail({ ov }: { ov: Overview }) {
  const { allowed } = useApp();
  const a = ov.modules.ads!;
  const c = a.current;
  const money = (n: number) => fmtMoney(n, a.currency);
  const { left } = accountGroups(a.accounts);
  const counted = a.accounts.filter((acc) => acc.counted);
  const reasons = missingReasons(counted, ov.range);
  const split = c && a.byProvider.length > 1 ? a.byProvider.map((p) => `${PLATFORM[p.provider].name} ${p.spend === null ? UNAVAILABLE.toLowerCase() : money(p.spend)}`).join(", ") : null;
  const google = a.byProvider.find((p) => p.provider === "google")?.current ?? null;
  const missing = a.notCompared === "no_history" ? noEarlierData(a.historyFrom, "ads") : null;
  const on = comparedOnWholeDays(ov);
  const through = throughLabel(a, ov);
  const change = (d: number | null) =>
    a.notCompared === "running"
      ? `, ${runningWords(ov)}: nothing to compare yet`
      : a.notCompared === "no_history"
        ? ", with no earlier data to compare"
        : a.notCompared === "incomplete" || d === null
          ? ""
          : d === 0
            ? `, the same as ${on}${through === "vs before" ? "" : ` (${through})`}`
            : `, ${d > 0 ? "up" : "down"} ${fmtPct(Math.abs(d))} on ${on}${through === "vs before" ? "" : ` (${through}: whole days only)`}`;
  const shown = c ?? a.partial?.totals ?? null;
  const reports = a.campaigns !== undefined;
  const readable = a.accounts.filter((acc) => acc.status !== "reconnect" && acc.status !== "permission");

  return (
    <>
      <AdStatusNotes accounts={a.accounts} manage={allowed("integrations.manage")} />
      <div className="card flex items-start gap-3 border-accent/30 bg-accent/5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1 text-sm leading-relaxed">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">In short</p>
          {!c && (
            <p>
              These dates&apos; ad figures aren&apos;t complete, so no total is shown for them. {reasons.join(" ")}
              {a.partial ? (
                <>
                  {" "}
                  Every account has {fmtSpan(a.partial.from, a.partial.to)}: <B>{money(a.partial.totals.spend)}</B> spent then.
                </>
              ) : null}{" "}
              <Link className="text-accent underline" href="/settings/ads">
                Check the accounts in Settings
              </Link>
              .
            </p>
          )}
          {c && (
            <>
              <p>
                You spent <B>{money(c.spend)}</B> on ads{split ? <> ({split})</> : null}
                {change(a.deltas.spend)}.
              </p>
              <p>
                {c.linkClicks === null ? (
                  <>Their link clicks for some of these days are still being read again from the platforms</>
                ) : (
                  <>
                    They brought <B>{plural(c.linkClicks, "link click")}</B>
                    {c.cpc !== null ? <>, about {money(c.cpc)} each</> : null}
                  </>
                )}
                {c.purchases === null ? (
                  <>; their purchases for some of these days are still being read again, so none are counted yet.</>
                ) : c.purchases > 0 ? (
                  <>
                    , and by the platforms&apos; own count <B>{fmtNum(c.purchases)} purchases</B> worth {c.purchaseValue === null ? "an amount still being read" : money(c.purchaseValue)}: <B>{fmtTimes(c.roas)}</B>{" "}
                    what you spent.
                  </>
                ) : (
                  <>, and no purchases the platforms credit to them.</>
                )}
              </p>
              {google && google.conversions > 0 && (
                <p>
                  Google Ads also counts <B>{fmtNum(google.conversions)} conversions</B> in all: every conversion action it&apos;s set to count (purchases, and
                  also leads, sign-ups or calls), so they&apos;re shown apart from purchases.
                </p>
              )}
              {a.shareOfSales !== null && (
                <p>
                  Ads cost <B>{fmtPct(a.shareOfSales)}</B> of your store&apos;s net sales in these dates.
                </p>
              )}
              {c.leads > 0 && <p>{plural(c.leads, "lead")} from lead forms too.</p>}
            </>
          )}
          {timeZoneNote(counted) && <p className="text-muted">{timeZoneNote(counted)}</p>}
          {left.length > 0 && (
            <p className="text-muted">
              Not added in: {left.map((acc) => `${acc.name ?? acc.accountId} (${acc.currency ?? "currency not known yet"})`).join(", ")}, because they&apos;re in another currency.
            </p>
          )}
        </div>
      </div>

      <Panel
        id="d-ads-glance"
        title="At a glance"
        help={
          <>
            {c || !a.partial ? fmtRange(ov.range.from, ov.range.to) : `${fmtRange(a.partial.from, a.partial.to)} only, the days every account has`}.{" "}
            {a.compared && !(!c && a.partial) ? (
              <>
                <ComparedLine fig={a} show={(t) => money(t.spend)} what="spend" />.{" "}
              </>
            ) : null}
            {missing ? `${missing} ` : ""}In {a.currency}.
          </>
        }
      >
        {shown ? (
          <Glance a={a} t={shown} ov={ov} partial={!c} />
        ) : (
          <div className="space-y-1 text-sm text-muted">
            <p className="text-xl font-semibold text-text">{UNAVAILABLE}</p>
            {reasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </div>
        )}
      </Panel>

      {a.series.length > 1 && (
        <section className="card animate-rise min-w-0" data-testid="ads-daily">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{fmtSpan(ov.range.from, ov.range.to)} · Ad spend per day</p>
          <p className="mt-1 text-3xl font-semibold">{c ? money(c.spend) : UNAVAILABLE}</p>
          {!c && <p className="text-xs text-muted">Days with no figures yet are marked, not drawn as $0.</p>}
          <ColumnsLegend />
          <SpendChart a={a} ov={ov} />
        </section>
      )}

      <Panel id="d-ads-platforms" title="By platform" help="Each platform's own numbers for these dates. Purchases are purchases only; Google Ads' conversions count every conversion action.">
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Platform</th>
                <th className="px-1 pb-2 text-right font-normal">Spend</th>
                <th className="px-1 pb-2 text-right font-normal">Link clicks</th>
                <th className="px-1 pb-2 text-right font-normal">Purchases</th>
                <th className="px-1 pb-2 text-right font-normal">Purchase value</th>
                <th className="px-1 pb-2 text-right font-normal">ROAS (platform&apos;s own)</th>
                <th className="px-1 pb-2 text-right font-normal">Per purchase</th>
                <th className="px-1 pb-2 text-right font-normal">Conversions (all conversion actions)</th>
                <th className="px-1 pb-2 text-right font-normal">Per conversion</th>
              </tr>
            </thead>
            <tbody>
              {a.byProvider.map((p) => {
                const P = PLATFORM[p.provider];
                const t = p.current;
                const why = t ? null : a.accounts.filter((acc) => acc.counted && acc.provider === p.provider).map((acc) => missingReason(acc, ov.range)).filter(Boolean).join(" ");
                return (
                  <tr key={p.provider} className="border-t border-border">
                    <td className="px-1 py-2">
                      <span className="inline-flex items-center gap-2 font-medium">
                        <P.Icon size={16} />
                        {P.name}
                      </span>
                    </td>
                    {t ? (
                      <>
                        <td className="px-1 py-2 text-right tabular-nums">{money(t.spend)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(t.linkClicks, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(t.purchases, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(t.purchaseValue, money)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{t.purchases === null ? BEING_READ : fmtTimes(t.roas)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{t.purchases === null ? BEING_READ : t.costPerPurchase !== null ? money(t.costPerPurchase) : "—"}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{p.provider === "google" ? fmtNum(t.conversions) : "—"}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{p.provider === "google" && t.costPerConversion !== null ? money(t.costPerConversion) : "—"}</td>
                      </>
                    ) : (
                      <td colSpan={8} className="px-1 py-2 text-right text-xs text-muted">
                        {UNAVAILABLE}
                        {why ? `: ${why}` : ""}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {a.campaigns && (
        <Panel id="d-ads-campaigns" title="Campaigns" help="The campaigns that spent most in these dates.">
          {a.campaigns.length === 0 ? (
            <p className="text-sm text-muted">{c ? "No campaign spent anything in these dates." : "No campaign figures for these dates yet."}</p>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-1 pb-2 font-normal">Campaign</th>
                    <th className="px-1 pb-2 text-right font-normal">Spend</th>
                    <th className="px-1 pb-2 text-right font-normal">Link clicks</th>
                    <th className="px-1 pb-2 text-right font-normal">Click-through rate</th>
                    <th className="px-1 pb-2 text-right font-normal">Purchases</th>
                    <th className="px-1 pb-2 text-right font-normal">ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {a.campaigns.map((cmp) => {
                    const P = PLATFORM[cmp.provider];
                    return (
                      <tr key={`${cmp.provider}:${cmp.accountId}:${cmp.campaignId}`} className="border-t border-border">
                        <td className="px-1 py-2">
                          <span className="inline-flex items-center gap-2">
                            <P.Icon size={14} />
                            <span className="font-medium">{cmp.name}</span>
                          </span>
                          {cmp.complete === false && <span className="block text-xs text-muted">Its account&apos;s figures stop before these dates end</span>}
                        </td>
                        <td className="px-1 py-2 text-right tabular-nums">{money(cmp.spend)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(cmp.linkClicks, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{cmp.linkClicks === null ? BEING_READ : fmtPct(cmp.ctr)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{known(cmp.purchases, fmtNum)}</td>
                        <td className="px-1 py-2 text-right tabular-nums">{cmp.purchases === null ? BEING_READ : fmtTimes(cmp.roas)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* The live reports need "View campaigns" (Team & Access): the server leaves campaigns out without it. */}
      {reports && readable.some((acc) => acc.provider === "google") && <GoogleReportPanel ov={ov} accounts={readable} />}
      {reports && readable.some((acc) => acc.provider === "meta") && <MetaReportPanel ov={ov} accounts={readable} />}

      <Panel id="d-ads-accounts" title="Ad accounts" help="Read-only. Turn accounts on or off, reconnect or disconnect them in Settings." aside={<Link className="text-xs text-accent underline" href="/settings/ads">Manage ad accounts</Link>}>
        <ul className="divide-y divide-border">
          {a.accounts.map((acc) => {
            const P = PLATFORM[acc.provider];
            return (
              <li key={acc.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="inline-flex items-center gap-2">
                  <P.Icon size={16} />
                  <span className="font-medium">{acc.name ?? acc.accountId}</span>
                  <span className="text-xs text-muted">
                    {acc.accountId}
                    {acc.currency ? ` · ${acc.currency}` : ""}
                    {acc.otherTimeZone && acc.timezone ? ` · days in ${acc.timezone}` : ""}
                  </span>
                </span>
                <AccountStatus acc={acc} />
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Purchases and their value are what Meta and Google each credit to their own ads (for Google, its conversion actions of the Purchase category). A sale can be
          counted by both, and the numbers won&apos;t match your Shopify orders exactly; your store&apos;s own sales are on the Sales page.
        </p>
      </Panel>
    </>
  );
}

function ColumnsLegend() {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--viz-tier-2)" }} />Spend</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--viz-tier-3)" }} />Biggest day</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--border)", opacity: 0.6 }} />Weekend</span>
    </div>
  );
}
