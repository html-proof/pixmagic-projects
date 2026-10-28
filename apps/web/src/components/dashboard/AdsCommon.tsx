"use client";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { adAccountStatusLabel, adErrorMessage, isAdAccountStatus, isAdErrorCode, isClosedAdAccount, type AdErrorCode, type AdProvider } from "@app/shared/ads";
import { addDays } from "@app/shared/dates";
import { weekdayOf } from "@app/shared/sales";
import { Alert } from "@/components/ui";
import { AD_STATE, syncRunning } from "@/lib/adConnections";
import { upToWords } from "./adFigures";
import { fmtDay, fmtMoneyWhole, fmtRelative, fmtSpan, fmtWeekday } from "./format";
import type { Column } from "./ColumnsWithTotal";
import { Badge, Delta, NeutralDelta } from "./Primitives";
import type { AdAccount, AdFigures, Overview } from "./types";

// ---------------------------------------------------------------------------
// What the Advertising section, the Ads panel (money spent) and the Ad earnings panel (money
// earned) show the same way: the day-by-day chart's columns, the state of each connected account,
// why a figure is unavailable, what a change compares, and what each measure means.
//
// A figure exists only for days every account it adds up has stored (packages/core/src/reports/ads.ts):
// a day an account lacks is never shown as 0, and the page says which account lacks it and why.
// ---------------------------------------------------------------------------

export const PLATFORM_NAME: Record<AdProvider, string> = { meta: "Meta Ads", google: "Google Ads", adsense: "Google AdSense" };

/** What a figure some account lacks days of reads as. */
export const UNAVAILABLE = "Unavailable";
/** A figure a platform hasn't given for some of the days yet (older days being read again). */
export const BEING_READ = "Being re-read";

/**
 * One column per day of a money figure (ad spend, AdSense earnings) for ColumnsWithTotal: the
 * biggest day highlighted and always labelled, weekends shaded, today faded, a running total. A day
 * with no figure (null: not read) is a quiet "No data" band, and the running total skips it: the
 * days with figures are one run, so it reads as the total since the first of them.
 */
export function dailyMoneyColumns<D extends { day: string }>(series: D[], value: (d: D) => number | null, today: string, currency: string): Column[] {
  const n = series.length;
  const max = Math.max(0, ...series.map((d) => value(d) ?? 0));
  let running = 0;
  return series.map((d) => {
    const v = value(d);
    const weekend = weekdayOf(d.day) >= 5;
    const isToday = d.day === today;
    const tick = {
      top: n <= 31 ? String(Number(d.day.slice(8))) : fmtDay(d.day, { year: false }),
      bottom: isToday ? "Today" : fmtWeekday(d.day),
      strong: weekend || isToday,
      major: n <= 31 || (n <= 120 ? weekdayOf(d.day) === 0 : d.day.endsWith("-01")),
    };
    if (v === null) return { key: d.day, value: 0, fill: "var(--viz-tier-2)", missing: true, shaded: weekend, running: null, tick };
    running = Math.round((running + v) * 100) / 100;
    return {
      key: d.day,
      value: v,
      fill: v === max && max > 0 ? "var(--viz-tier-3)" : "var(--viz-tier-2)",
      faded: isToday,
      shaded: weekend,
      running,
      tick,
      label: v ? fmtMoneyWhole(v, currency) : undefined,
      keepLabel: v === max && max > 0,
    };
  });
}

type AccountState = Pick<AdAccount, "counted" | "status" | "lastSyncedAt" | "coverage" | "unsplitThrough" | "syncRequestedAt">;

/** Nothing stored yet: never synced (older answers say so by lastSyncedAt alone). Days AdSense didn't split by site were read. */
const neverRead = (acc: Pick<AccountState, "coverage" | "unsplitThrough" | "lastSyncedAt">) => (acc.coverage ? acc.coverage.through === null && !acc.unsplitThrough : !acc.lastSyncedAt);

/**
 * A sync someone asked for after the first one (Refresh, Sync all now, turning the account back on) is
 * on its way: what Settings shows as "Synchronizing" (connectionState in lib/adConnections), told the
 * same way (syncRunning: asked for, not finished, and not so long ago that it was lost). Never for an
 * account waiting for a reconnect, for which nothing is queued. Every account listed here is shown on
 * the dashboard (the ones hidden from it aren't read), so it counts as enabled.
 */
export function refreshing(acc: Pick<AdAccount, "status" | "lastSyncedAt" | "syncRequestedAt">, now = Date.now()): boolean {
  return acc.status !== "reconnect" && !!acc.lastSyncedAt && syncRunning({ enabled: true, syncRequestedAt: acc.syncRequestedAt ?? null }, now);
}

/**
 * Accounts left out of the totals (another currency), those still being read for the first time,
 * those whose updates don't work (whatever they stored before: their days since are missing), and
 * working ones a refresh is on its way for (their figures are the last sync's meanwhile).
 */
export function accountGroups<A extends AccountState>(accounts: A[]) {
  return {
    left: accounts.filter((acc) => !acc.counted),
    waiting: accounts.filter((acc) => acc.counted && acc.status === "active" && neverRead(acc)),
    failing: accounts.filter((acc) => acc.counted && acc.status !== "active"),
    refreshing: accounts.filter((acc) => acc.counted && acc.status === "active" && !neverRead(acc) && refreshing(acc)),
  };
}

/** Sync data now (Settings → Advertising) asks again for it: its syncs fail, and the platform hasn't closed it. */
const retryable = (acc: Pick<AdAccount, "status" | "errorCode" | "accountStatus">) => (acc.status === "error" || acc.status === "unavailable") && !isClosedAdAccount(acc);

/** When it was last tried, if that was after its last sync that worked (null: not known, or that one worked). */
function lastTried(acc: Pick<AdAccount, "lastSyncedAt" | "lastSyncAttemptAt">): string | null {
  const tried = acc.lastSyncAttemptAt ? Date.parse(acc.lastSyncAttemptAt) : NaN;
  if (Number.isNaN(tried)) return null;
  const worked = acc.lastSyncedAt ? Date.parse(acc.lastSyncedAt) : NaN;
  return Number.isNaN(worked) || tried > worked ? acc.lastSyncAttemptAt! : null;
}

/** The reason an account isn't working, as a code: its own, or for an older answer without one, its status's usual one. */
function codeOf(acc: Pick<AdAccount, "status" | "errorCode" | "accountStatus">): AdErrorCode | null {
  if (acc.status === "active") return null;
  if (isAdErrorCode(acc.errorCode)) return acc.errorCode;
  if (acc.accountStatus === "closed") return "account_closed";
  if (acc.status === "reconnect") return "auth_expired";
  if (acc.status === "permission") return "no_access";
  if (acc.status === "unavailable") return "account_not_ready";
  return "temporary";
}

const nameOf = (acc: Pick<AdAccount, "name" | "accountId" | "provider">) => `${acc.name ?? acc.accountId} (${PLATFORM_NAME[acc.provider]})`;

/**
 * Why an account has no figures for some days of the range, in plain sentences: null when it has
 * them all (or the answer predates coverage).
 */
export function missingReason(acc: AdAccount, range: { from: string; to: string }): string | null {
  if (acc.coversRange !== false || !acc.coverage) return null;
  const name = nameOf(acc);
  const { from, through } = acc.coverage;
  const problem = adErrorMessage(codeOf(acc), acc.provider);
  // Sites are chosen for the store, and AdSense reported the days up to unsplitThrough for every site
  // together: the account's figures start after them (or, when they reach its last day, not at all).
  if (acc.unsplitThrough && (from === null || (from === addDays(acc.unsplitThrough, 1) && from > range.from))) {
    return `AdSense didn't split ${name}'s earnings by site up to ${fmtDay(acc.unsplitThrough)}, so this store's share of those days isn't known.`;
  }
  if (from === null || through === null) {
    return problem ? `Nothing could be read from ${name} yet. ${problem}` : `${name} is being read for the first time: its last 90 days arrive within a few minutes.`;
  }
  if (through < range.to) {
    if (problem) return `${name} has figures up to ${fmtDay(through)} only. ${problem}`;
    if (acc.otherTimeZone && acc.timezone && acc.today && acc.today < range.to) {
      return `${name} follows the ad account's time zone, ${acc.timezone}, where ${fmtDay(range.to)} hasn't started yet.`;
    }
    // As often as the worker refreshes it (apps/worker handlers/integrations.ts recentLeaseMs).
    const next = acc.provider === "google" ? "within three hours" : "within the hour";
    return `${name} has figures up to ${fmtDay(through)}; the next update, ${next}, brings the rest.`;
  }
  return `${name} has figures from ${fmtDay(from)} on: an account brings the 90 days before it was connected.`;
}

/** Every counted account's reason for missing days, in one list (empty: none is missing any). */
export const missingReasons = (accounts: AdAccount[], range: { from: string; to: string }) =>
  accounts.filter((a) => a.counted).map((a) => missingReason(a, range)).filter((r): r is string => r !== null);

/** "Google Ads days follow the ad account's time zone, America/Los_Angeles." for accounts whose days aren't the store's. */
export function timeZoneNote(accounts: AdAccount[]): string | null {
  const other = accounts.filter((a) => a.counted && a.otherTimeZone && a.timezone);
  if (!other.length) return null;
  const zones = [...new Set(other.map((a) => a.timezone!))];
  const providers = [...new Set(other.map((a) => a.provider))];
  const who = providers.length === 1 ? PLATFORM_NAME[providers[0]!] : "Some ad accounts'";
  return providers.length === 1
    ? `${who} days follow the ad account's time zone${zones.length > 1 ? "s" : ""}, ${zones.join(" and ")}, not your store's.`
    : `${who} days follow their own time zones (${zones.join(", ")}), not your store's.`;
}

/**
 * An account's sync state, at the end of its row in the accounts list: while a refresh is on its way,
 * that, with when its figures were last synced; for one whose syncs fail, when it was last tried.
 */
export function AccountStatus({
  acc,
}: {
  acc: Pick<AdAccount, "status" | "lastSyncedAt" | "provider" | "accountStatus" | "coverage" | "syncRequestedAt" | "lastSyncAttemptAt">;
}) {
  const label = adAccountStatusLabel(isAdAccountStatus(acc.accountStatus) ? acc.accountStatus : null, acc.provider);
  const through = acc.coverage?.through;
  const tried = lastTried(acc);
  const [text, tone] =
    acc.status === "reconnect"
      ? ["Needs reconnecting", "text-danger"]
      : refreshing(acc)
        ? [`${AD_STATE.synchronizing.label} · last synced ${fmtRelative(acc.lastSyncedAt!)}`, "text-muted"]
        : acc.status === "permission"
          ? ["No access to this account", "text-danger"]
          : acc.status === "unavailable"
            ? [label ?? `Unavailable at ${PLATFORM_NAME[acc.provider]}`, "text-warn"]
            : acc.status === "error"
              ? [`Sync problem${tried ? ` · last tried ${fmtRelative(tried)}` : ""}`, "text-warn"]
              : [acc.lastSyncedAt ? `Synced ${fmtRelative(acc.lastSyncedAt)}` : "Fetching history…", "text-muted"];
  return (
    <span className={`text-xs ${tone}`} data-testid="ad-account-status">
      {text}
      {acc.status !== "active" && through ? ` · figures up to ${fmtDay(through, { year: false })}` : ""}
    </span>
  );
}

/** A small spinning ring: something is on its way. */
const Spinner = () => <span aria-hidden className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />;

/**
 * What's wrong or still loading, per account, in words: first syncs on their way, refreshes someone
 * asked for (the figures meanwhile are the last sync's), and accounts whose updates stopped (why, and
 * what fixes it: reconnecting, or for a sync that failed, trying again from Settings).
 */
export function AdStatusNotes({ accounts, manage }: { accounts: AdAccount[]; manage: boolean }) {
  const { waiting, failing, refreshing: updating } = accountGroups(accounts);
  if (!waiting.length && !failing.length && !updating.length) return null;
  const reconnect = failing.some((a) => a.status === "reconnect" || a.status === "permission");
  // One already being tried again needs nothing pressed.
  const retry = failing.some((a) => retryable(a) && !refreshing(a));
  return (
    <div className="mb-3 space-y-2" data-testid="ads-status-notes">
      {waiting.length > 0 && (
        <Alert kind="info">
          <span className="inline-flex items-center gap-2">
            <Spinner />
            Fetching the last 90 days from {waiting.map(nameOf).join(", ")}. Their figures fill in within a few minutes; this page updates by itself.
          </span>
        </Alert>
      )}
      {updating.length > 0 && (
        <Alert kind="info">
          <span className="inline-flex items-center gap-2" data-testid="ads-refreshing">
            <Spinner />
            <span>
              {AD_STATE.synchronizing.label} {updating.map((a) => `${nameOf(a)}, last synced ${fmtRelative(a.lastSyncedAt!)}`).join("; ")}. Until the new figures land, the
              ones here are from that sync; this page updates by itself.
            </span>
          </span>
        </Alert>
      )}
      {failing.length > 0 && (
        <Alert kind={reconnect ? "error" : "info"}>
          <ul className="space-y-1">
            {failing.map((a) => (
              <li key={a.id}>
                <span className="font-medium">{nameOf(a)}:</span> {adErrorMessage(codeOf(a), a.provider)}{" "}
                {/* A closed account spends and earns nothing: its days since count as the zeros they are (accountCoverage). */}
                {isClosedAdAccount(a)
                  ? a.coverage?.through
                    ? `A closed account ${a.provider === "adsense" ? "earns" : "spends"} nothing, so its days since it closed count as 0.`
                    : "Nothing could be read from it before it closed."
                  : a.coverage?.through
                    ? `Its figures stop on ${fmtDay(a.coverage.through)}, so the days since show as unavailable, not as 0.`
                    : neverRead(a)
                      ? "Nothing could be read from it yet."
                      : ""}
                {refreshing(a) ? " Trying again now." : ""}
              </li>
            ))}
          </ul>
          {reconnect ? (
            <p className="mt-1">
              {manage ? (
                <Link className="font-medium underline" href="/settings/ads">
                  Reconnect in Settings
                </Link>
              ) : (
                "Ask a workspace owner or admin to reconnect."
              )}
            </p>
          ) : (
            // Sync data now on Settings → Advertising queues its sync again (POST …/ads/sync).
            retry &&
            manage && (
              <p className="mt-1" data-testid="ads-try-again">
                <Link className="font-medium underline" href="/settings/ads">
                  Try again in Settings
                </Link>{" "}
                with Sync data now. bizinsights also keeps trying by itself.
              </p>
            )
          )}
        </Alert>
      )}
    </div>
  );
}

/**
 * Why dates of running days only aren't compared: today isn't over, or (yesterday picked) the day
 * is still running in an ad account's own time zone.
 */
export const runningWords = (ov: Pick<Overview, "today" | "range">) => (ov.range.to >= ov.today ? "today so far" : "still running in an ad account's time zone");

/** What a change is against: "vs before", or "through yesterday" when the running day was left out of both sides. */
export function throughLabel(fig: Pick<AdFigures<unknown>, "compared">, ov: Pick<Overview, "today">): string {
  const c = fig.compared;
  if (!c || c.trimmed === 0) return "vs before";
  return c.current.to === addDays(ov.today, -1) ? "through yesterday" : `through ${fmtDay(c.current.to, { year: false })}`;
}

/**
 * The change under a figure, against what was compared (whole days only). With nothing compared, the
 * reason in neutral words: today isn't over, no earlier data, or days missing.
 */
export function ChangeNote({
  fig,
  value,
  ov,
  neutral = false,
  invert = false,
}: {
  fig: Pick<AdFigures<unknown>, "compared" | "notCompared">;
  value: number | null;
  ov: Pick<Overview, "today" | "range">;
  neutral?: boolean;
  invert?: boolean;
}) {
  if (fig.notCompared === "running") return <span className="text-xs text-muted">{runningWords(ov)}: nothing to compare yet</span>;
  if (fig.notCompared === "no_history") return <span className="text-xs text-muted">no earlier data to compare</span>;
  if (fig.notCompared === "incomplete" || !fig.compared) return <span className="text-xs text-muted">not compared: some days are missing</span>;
  if (value === null) return <span className="text-xs text-muted">nothing to compare with</span>;
  const label = throughLabel(fig, ov);
  return neutral ? <NeutralDelta value={value} label={label} /> : <Delta value={value} invert={invert} label={label} />;
}

/**
 * The figures a change compares, so they can be checked: "Before (6–11 Oct): $60", or while today
 * was left out of both sides, "13–18 Oct: $62 · before (6–11 Oct): $60".
 */
export function ComparedLine<T>({ fig, show, what }: { fig: Pick<AdFigures<T>, "compared">; show: (t: T) => string; what?: string }) {
  const c = fig.compared;
  if (!c) return null;
  const before = `before (${fmtSpan(c.previous.from, c.previous.to)}): ${show(c.previous.totals)}`;
  const line = c.trimmed === 0 ? before : `${fmtSpan(c.current.from, c.current.to)}: ${show(c.current.totals)} · ${before}`;
  const said = what ? `${what} ${line}` : line;
  return <>{said[0]!.toUpperCase() + said.slice(1)}</>;
}

/** "Unavailable" with why, and what is known of the dates when some of them are. */
export function UnavailableNote<T>({ fig, accounts, range, show }: { fig: Pick<AdFigures<T>, "partial">; accounts: AdAccount[]; range: { from: string; to: string }; show: (t: T) => string }) {
  const reasons = missingReasons(accounts, range);
  return (
    <span className="block space-y-0.5">
      {fig.partial && (
        <span className="block font-medium text-text">
          {fmtSpan(fig.partial.from, fig.partial.to)} only: {show(fig.partial.totals)}
        </span>
      )}
      {(reasons.length ? reasons : ["Some days of these dates aren't read yet."]).map((r) => (
        <span key={r} className="block">
          {r}
        </span>
      ))}
    </span>
  );
}

/** Under a figure of the dates so far (`shownFigures`): the day it stops on, and why the days after it aren't in yet. */
export function SoFarNote({ through, accounts, range }: { through: string; accounts: AdAccount[]; range: { from: string; to: string } }) {
  const reasons = missingReasons(accounts, range);
  const up = upToWords(through);
  return (
    <span className="block" data-testid="ads-so-far">
      {up[0]!.toUpperCase() + up.slice(1)}: {reasons.length ? reasons.join(" ") : "the days after it aren't in yet."}
    </span>
  );
}

/** The measures the ad platforms report, defined once for every ads card and panel. */
export const AD_DEFINITIONS: Array<[string, ReactNode]> = [
  ["Ad spend", "What the platform charged for your ads on those days, in the ad account's currency."],
  ["Impressions", "Times an ad was shown."],
  ["Link clicks", "Clicks on the ad's link, to your store or another page. Meta's own \"clicks (all)\" also count likes, comments and profile taps, so they aren't used here."],
  ["Click-through rate (CTR)", "Link clicks ÷ impressions: how often people who saw an ad clicked it."],
  ["Cost per click (CPC)", "Spend ÷ link clicks."],
  ["Cost per 1,000 impressions (CPM)", "Spend × 1,000 ÷ impressions."],
  ["Purchases (platform's count)", "Purchases a platform credits to its own ads, from its pixel or conversion tracking. Two platforms can claim the same sale, and neither is your Shopify orders."],
  ["Return on ad spend (ROAS)", "The purchase value a platform credits to its ads ÷ what you spent there: its own figure. 3× means it counts $3 of purchases for every $1."],
  ["Cost per purchase", "Spend ÷ the purchases the platform credits to its ads."],
  ["Conversions (all conversion actions)", "Google Ads' own conversions: every action set to count (purchases, and also leads, sign-ups, calls...). Never added to purchases."],
  ["Cost per conversion", "Spend ÷ those conversions."],
];

export const ADSENSE_DEFINITIONS: Array<[string, ReactNode]> = [
  ["Estimated earnings", "What AdSense estimates the ads on your site earned. AdSense finalizes each month in the first days of the next, so recent days can still change."],
  [
    "Estimated or Final",
    "Final: every day of the figures is in a month AdSense has finalized, and bizinsights has read it again since. Estimated: some of the days can still change.",
  ],
  ["Page views", "Pages on your site that showed AdSense ads, as AdSense counts them."],
  ["Impressions", "AdSense counts one for each ad request where at least one ad was delivered to the page, not one for every ad shown."],
  ["Click-through rate (CTR)", "Clicks ÷ impressions."],
  ["Earnings per click", "Estimated earnings ÷ clicks."],
  ["Page RPM", "Estimated earnings × 1,000 ÷ page views: what a thousand page views earn."],
  ["Impression RPM", "Estimated earnings × 1,000 ÷ impressions."],
];

/** The live AdSense report's own figures (never stored), beside the ones above. */
export const ADSENSE_REPORT_DEFINITIONS: Array<[string, ReactNode]> = [
  ["Ad requests", "Times an ad unit on your pages asked AdSense for ads. One request can show no ad, one, or several."],
  ["Coverage", "The share of those requests that got an ad back."],
  ["Active View viewable", "Of the impressions Active View could measure, the share that were viewable: at least half of the ad on screen for at least a second."],
  ["Ad unit", "An ad unit as it is named in your AdSense account. Its row counts only what it earned on this store's sites."],
];

/**
 * Whether AdSense earnings are final or still AdSense's estimate (`final` in the API's AdSense
 * figures, or the live report's dates against adsenseFinalThrough). Nothing for an answer from
 * before the API said.
 */
export function EarningsState({ final }: { final: boolean | undefined }) {
  if (final === undefined) return null;
  return (
    <span
      data-testid="adsense-final"
      data-final={final}
      title={final ? "AdSense has finalized every day of these figures." : "AdSense's estimate: it finalizes each month in the first days of the next, so these can still change."}
    >
      <Badge tone={final ? "good" : "neutral"}>{final ? "Final" : "Estimated"}</Badge>
    </span>
  );
}

/** The earnings' name beside the figure: AdSense's own "Estimated earnings" until they are final. */
export const earningsLabel = (final: boolean | undefined) => (final ? "Earnings (final)" : "Estimated earnings");

/** A small, folded list of what each measure means, under a card or a report. */
export function Definitions({ items, title = "What these figures mean" }: { items: Array<[string, ReactNode]>; title?: string }) {
  return (
    <details className="mt-3 text-xs text-muted" data-testid="ads-definitions">
      <summary className="cursor-pointer select-none text-accent underline-offset-2 hover:underline">{title}</summary>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[13rem_1fr]">
        {items.map(([term, text]) => (
          <Fragment key={term}>
            <dt className="font-medium text-text">{term}</dt>
            <dd>{text}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}
