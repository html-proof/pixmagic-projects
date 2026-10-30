/**
 * Advertising numbers from Meta Ads and Google Ads, normalized to one shape so the dashboard can
 * add them up and compare them with the store's own sales. And AdSense, which runs the other way:
 * what the store's site earns from Google ads shown on it.
 *
 * Everything here is what the ad platforms report about themselves: "conversions" and their value
 * are the platforms' own attribution, which overlaps between platforms and with Shopify. They are
 * shown as the platforms' claims, never mixed into the store's sales figures.
 */
// Without the ".js" the rest of the package uses: the web app imports this file directly
// (@app/shared/ads), and its bundler doesn't map "./dates.js" to dates.ts.
import { addDays, eachDay, isDay, localDay, localTime, periodsOf, type PeriodGranularity } from "./dates";

/** Everything that can be connected on Settings → Ad accounts. */
export const AD_PROVIDERS = ["meta", "google", "adsense"] as const;
export type AdProvider = (typeof AD_PROVIDERS)[number];
/** The platforms a store pays to advertise on. AdSense pays the store instead, so it is never added into spend. */
export type AdSpendProvider = Exclude<AdProvider, "adsense">;

// ---------------------------------------------------------------------------
// Where a connection stands, and why: what ad_connections.status, error_code and account_status hold.
// The API, the worker and both settings pages read these, so a state is named and worded once.
// ---------------------------------------------------------------------------

/**
 * ad_connections.status. "reconnect": the sign-in ended (expired, revoked, permission taken back), so
 * connecting again fixes it. "permission": this login can no longer read this one account (removed
 * from it, the manager link is gone), so connecting with a login that has access fixes it.
 * "unavailable": the platform won't report on the account (closed, cancelled, set-up unfinished).
 * "error": a failure a retry may fix; syncs keep trying, less often after several in a row.
 */
export const AD_CONNECTION_STATUSES = ["active", "reconnect", "permission", "unavailable", "error"] as const;
export type AdConnectionStatus = (typeof AD_CONNECTION_STATUSES)[number];

/**
 * Why a connected sign-in has no ad account connected yet (ad_logins.reason): it stays connected, and
 * bizinsights connects its ad accounts by itself once the platform lists some.
 * "no_ads_account": the login reaches no ad account (none of its own, or not assigned to one in a business portfolio).
 * "none_shared": no ad account was ticked on the platform's screen.
 * "unanswered": the platform didn't list the login's ad accounts in time.
 * "choose": it lists more than bizinsights connects without asking (AD_LOGIN_AUTO_CONNECT_MAX).
 */
export const AD_LOGIN_REASONS = ["no_ads_account", "none_shared", "unanswered", "choose"] as const;
export type AdLoginReason = (typeof AD_LOGIN_REASONS)[number];
/** The most ad accounts a waiting sign-in connects by itself once they appear; more wait for the person's choice. */
export const AD_LOGIN_AUTO_CONNECT_MAX = 10;

/**
 * Why a connection isn't working (ad_connections.error_code). The platform's own words go to the
 * logs (through providerDetail()); people read the wording below.
 */
export const AD_ERROR_CODES = [
  /** The sign-in expired or was revoked (Google invalid_grant, Meta 190/102). */
  "auth_expired",
  /** The reporting permission was taken back or never granted. */
  "scope_missing",
  /** The person whose login powered it has left bizinsights or the workspace. */
  "connector_left",
  /** This login can no longer read this account. */
  "no_access",
  /** The platform closed or cancelled the account. */
  "account_closed",
  /** The platform disabled or suspended the account. */
  "account_disabled",
  /** The account's set-up at the platform isn't finished (or awaits the platform's approval). */
  "account_not_ready",
  /** bizinsights' own app isn't approved for this yet (Google Ads API access level, Meta App Review): on our side. */
  "not_approved",
  /** The platform's API isn't switched on for bizinsights, or refuses bizinsights' own keys: on our side. */
  "not_configured",
  /** The platform asked bizinsights to slow down for a while. */
  "rate_limited",
  /** bizinsights' daily allowance at the platform is used up (Google Ads API operations). */
  "quota_exhausted",
  /** The platform or the network didn't answer. */
  "temporary",
  /** The platform refused for another reason. */
  "provider_error",
  /** Something went wrong in bizinsights. */
  "internal",
] as const;
export type AdErrorCode = (typeof AD_ERROR_CODES)[number];

export const isAdErrorCode = (v: unknown): v is AdErrorCode => typeof v === "string" && (AD_ERROR_CODES as readonly string[]).includes(v);

/** The status each code leaves a connection in. */
export const AD_ERROR_STATUS: Record<AdErrorCode, AdConnectionStatus> = {
  auth_expired: "reconnect",
  scope_missing: "reconnect",
  connector_left: "reconnect",
  no_access: "permission",
  account_closed: "unavailable",
  account_disabled: "unavailable",
  account_not_ready: "unavailable",
  not_approved: "error",
  not_configured: "error",
  rate_limited: "error",
  quota_exhausted: "error",
  temporary: "error",
  provider_error: "error",
  internal: "error",
};

/** Codes that are bizinsights' to fix, never the merchant's: worded as such, and alerted to the operator. */
export const AD_ERROR_OURS: ReadonlySet<AdErrorCode> = new Set(["not_approved", "not_configured", "quota_exhausted", "internal"]);

const PLATFORM_NAME: Record<AdProvider, string> = { meta: "Meta", google: "Google Ads", adsense: "Google AdSense" };
const PLATFORM_HOME_NAME: Record<AdProvider, string> = { meta: "Meta Ads Manager", google: "ads.google.com", adsense: "AdSense" };

/** The code that words each status when a connection has none of its own (marked before codes were kept, or by another status). */
const STATUS_CODE: Record<Exclude<AdConnectionStatus, "active">, AdErrorCode> = { reconnect: "auth_expired", permission: "no_access", unavailable: "account_not_ready", error: "provider_error" };

/**
 * The code a connection's status is worded by: its own code when that code belongs to the status
 * (AD_ERROR_STATUS), else the status's own wording; null when it is active. A code left over from an
 * earlier failure (a writer that changed only the status) would word the status as something else.
 */
export function adStatusCode(status: string, errorCode: string | null | undefined): AdErrorCode | null {
  if (status === "active") return null;
  if (isAdErrorCode(errorCode) && AD_ERROR_STATUS[errorCode] === status) return errorCode;
  return STATUS_CODE[status as Exclude<AdConnectionStatus, "active">] ?? "provider_error";
}

/** What a code means for the merchant, in one or two plain sentences. Null code: nothing is wrong. */
export function adErrorMessage(code: AdErrorCode | null | undefined, provider: AdProvider): string | null {
  if (!code) return null;
  const p = PLATFORM_NAME[provider];
  const home = PLATFORM_HOME_NAME[provider];
  switch (code) {
    case "auth_expired":
      return `bizinsights' access to ${p} has ended. Press Reconnect and sign in again to keep the numbers coming.`;
    case "scope_missing":
      return `The permission to read ${p} reports was taken back. Press Reconnect and leave it ticked on ${provider === "meta" ? "Facebook's" : "Google's"} screen.`;
    case "connector_left":
      return "The person who connected this account no longer has access to bizinsights. Someone with access to the account needs to press Reconnect.";
    case "no_access":
      return provider === "meta"
        ? "This Facebook login can no longer see this ad account. Ask the account's admin to assign you to it in Meta Business settings, or reconnect with a login that has access."
        : `This Google login can no longer read this ${provider === "adsense" ? "AdSense" : "Google Ads"} account. Ask its owner to add you as a user, or reconnect with a Google account that has access.`;
    case "account_closed":
      return `${p} says this account is closed, so there is nothing new to read. Its earlier numbers stay on the dashboard.`;
    case "account_disabled":
      return `${p} has disabled this account. Check it in ${home}; the numbers resume once ${p} enables it again.`;
    case "account_not_ready":
      return `This account isn't ready at ${p} yet (its set-up isn't finished or awaits ${p}'s approval). Finish it in ${home}, then press Refresh.`;
    case "not_approved":
      return `${p} is still approving bizinsights for this. It's on our side, not yours: the numbers start once it's approved.`;
    case "not_configured":
      return `${p} isn't fully switched on for bizinsights yet. It's on our side, not yours: we're on it.`;
    case "rate_limited":
      return `${p} asked bizinsights to slow down for a while. The next update tries again by itself.`;
    case "quota_exhausted":
      return `bizinsights has used today's allowance of ${p} requests. Updates resume by themselves tomorrow; nothing is lost.`;
    case "temporary":
      return `${p} didn't answer the last update. bizinsights tries again by itself.`;
    case "provider_error":
      return `${p} refused the last update. bizinsights tries again by itself; if it keeps happening, reconnect.`;
    case "internal":
      return "Something went wrong on our side with the last update. We'll try again by ourselves.";
  }
}

/**
 * The ad account's own health at the platform (ad_connections.account_status), normalized. Meta's
 * account_status, Google's customer status and AdSense's account state all map onto these.
 */
export const AD_ACCOUNT_STATUSES = ["active", "payment_issue", "under_review", "disabled", "closing", "closed", "needs_attention", "setup_unfinished"] as const;
export type AdAccountStatus = (typeof AD_ACCOUNT_STATUSES)[number];

export const isAdAccountStatus = (v: unknown): v is AdAccountStatus => typeof v === "string" && (AD_ACCOUNT_STATUSES as readonly string[]).includes(v);

/**
 * Meta's account_status code (https://developers.facebook.com/docs/marketing-api/reference/ad-account/):
 * 1 ACTIVE, 2 DISABLED, 3 UNSETTLED, 7 PENDING_RISK_REVIEW, 8 PENDING_SETTLEMENT, 9 IN_GRACE_PERIOD,
 * 100 PENDING_CLOSURE, 101 CLOSED, 201 ANY_ACTIVE, 202 ANY_CLOSED.
 */
export function metaAccountStatus(code: number | string | null | undefined): AdAccountStatus | null {
  switch (Number(code)) {
    case 1:
    case 201:
      return "active";
    case 2:
      return "disabled";
    case 3:
    case 8:
    case 9:
      return "payment_issue";
    case 7:
      return "under_review";
    case 100:
      return "closing";
    case 101:
    case 202:
      return "closed";
    default:
      return null;
  }
}

/** Google Ads customer.status: ENABLED, CANCELED, SUSPENDED, CLOSED. */
export function googleAccountStatus(status: string | null | undefined): AdAccountStatus | null {
  switch (status) {
    case "ENABLED":
      return "active";
    case "SUSPENDED":
      return "disabled";
    case "CANCELED":
    case "CLOSED":
      return "closed";
    default:
      return null;
  }
}

/** AdSense v2 Account.state (READY, NEEDS_ATTENTION, CLOSED) and its pendingTasks. */
export function adsenseAccountStatus(state: string | null | undefined, pendingTasks: readonly string[] = []): AdAccountStatus | null {
  if (state === "CLOSED") return "closed";
  if (state === "NEEDS_ATTENTION") return "needs_attention";
  if (state === "READY") return pendingTasks.length ? "setup_unfinished" : "active";
  return null;
}

/** A short label for an account status that isn't plain "active" (null for active or unknown). */
export function adAccountStatusLabel(status: AdAccountStatus | null | undefined, provider: AdProvider): string | null {
  const p = PLATFORM_NAME[provider];
  switch (status) {
    case "payment_issue":
      return `Payment needed at ${p}`;
    case "under_review":
      return `Under review by ${p}`;
    case "disabled":
      return `Disabled by ${p}`;
    case "closing":
      return "Closing";
    case "closed":
      return "Closed";
    case "needs_attention":
      return `Needs attention in ${p}`;
    case "setup_unfinished":
      return "Set-up not finished";
    default:
      return null;
  }
}

/** One campaign on one day, as stored (ad_campaign_daily). */
export interface AdDayRow {
  provider: AdSpendProvider;
  accountId: string;
  campaignId: string;
  campaignName: string;
  /** The ad account's own calendar day. */
  day: string;
  spend: number;
  impressions: number;
  /** Every click the platform counts: Meta's "clicks (all)" include likes, comments and profile clicks. */
  clicks: number;
  /** Clicks on the ad's link (Meta's inline_link_clicks; Google's clicks). Null: not read yet (older rows). */
  linkClicks: number | null;
  /** The platform's own conversions: Meta's purchases; Google's every primary conversion action (leads, sign-ups, calls, purchases...). */
  conversions: number;
  conversionValue: number;
  /** Purchases only, as the platform credits them (Google: conversion actions of category PURCHASE). Null: not read yet. */
  purchases: number | null;
  purchaseValue: number | null;
  /** Leads from lead forms and lead events (Meta); 0 where the platform has none. */
  leads: number;
  /**
   * The campaign's delivery status as the platform states it now (Google's campaign.status; Meta's
   * effective_status, read alongside), kept per campaign (ad_campaigns), not per day. Absent: not read.
   */
  campaignStatus?: string | null;
}

/**
 * A campaign's delivery status as the Advertising pages filter by it, from the platform's own word
 * (Google's campaign.status, Meta's effective_status): running ("active"), paused (Meta also by its
 * campaign or ad set), "ended" (removed, deleted, archived), or "other" (in review, with issues,
 * billing needed, anything new). Null: the status hasn't been read yet.
 */
export const CAMPAIGN_STATUS_GROUPS = ["active", "paused", "ended", "other"] as const;
export type CampaignStatusGroup = (typeof CAMPAIGN_STATUS_GROUPS)[number];
export const CAMPAIGN_STATUS_GROUP_LABEL: Record<CampaignStatusGroup, string> = { active: "Active", paused: "Paused", ended: "Removed or archived", other: "Other" };

export function campaignStatusGroup(status: string | null | undefined): CampaignStatusGroup | null {
  if (!status) return null;
  const s = status.toUpperCase();
  if (s === "ACTIVE" || s === "ENABLED") return "active";
  if (s === "PAUSED" || s === "CAMPAIGN_PAUSED" || s === "ADSET_PAUSED") return "paused";
  if (s === "REMOVED" || s === "DELETED" || s === "ARCHIVED") return "ended";
  return "other";
}

/**
 * A set of campaign-days added up. Clicks, click-through rate and cost per click are on link clicks,
 * the one click every platform means the same way (Meta's "clicks (all)" count likes and comments
 * too). Purchases, their value and return on ad spend are on purchases only: Google's conversions
 * count every action set as one (leads, sign-ups, calls...), so they stay as "conversions" and are
 * never called purchases. A figure some day doesn't have yet (rows stored before it was read) makes
 * the total null, never a short count.
 */
export interface AdTotals {
  spend: number;
  impressions: number;
  /** Every click the platform counts (Meta's include likes, comments and profile clicks). */
  clicks: number;
  /** Clicks on the ad's link (Google: clicks on the ad); null while some day's aren't read yet. */
  linkClicks: number | null;
  /** The platform's own conversions: Meta's purchases; Google's every conversion action in "Conversions". */
  conversions: number;
  conversionValue: number;
  /** Purchases as the platform credits them to its ads; null while some day's aren't read yet. */
  purchases: number | null;
  purchaseValue: number | null;
  leads: number;
  /** Link clicks per impression. */
  ctr: number | null;
  /** Spend per link click. */
  cpc: number | null;
  /** Spend per thousand impressions. */
  cpm: number | null;
  /** Spend per conversion (the platform's own, every conversion action). */
  costPerConversion: number | null;
  /** Spend per purchase. */
  costPerPurchase: number | null;
  /** Purchase value per unit of spend: the platform's own return on ad spend. */
  roas: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
/** a ÷ b when both are known. */
const known = (a: number | null, b: number | null) => (a === null || b === null ? null : ratio(a, b));
const cents = (n: number | null) => (n === null ? null : r2(n));

/** The sum of a figure some rows may not have yet: null as soon as one hasn't. */
function sumKnown<R>(rows: R[], pick: (r: R) => number | null): number | null {
  let sum = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

export function adTotals(rows: AdDayRow[]): AdTotals {
  const t = rows.reduce(
    (a, r) => {
      a.spend += r.spend;
      a.impressions += r.impressions;
      a.clicks += r.clicks;
      a.conversions += r.conversions;
      a.conversionValue += r.conversionValue;
      a.leads += r.leads;
      return a;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, leads: 0 },
  );
  const spend = r2(t.spend);
  const conversions = r2(t.conversions);
  const linkClicks = sumKnown(rows, (r) => r.linkClicks);
  const purchases = cents(sumKnown(rows, (r) => r.purchases));
  const purchaseValue = cents(sumKnown(rows, (r) => r.purchaseValue));
  return {
    spend,
    impressions: t.impressions,
    clicks: t.clicks,
    linkClicks,
    conversions,
    conversionValue: r2(t.conversionValue),
    purchases,
    purchaseValue,
    leads: t.leads,
    ctr: known(linkClicks, t.impressions),
    cpc: cents(known(spend, linkClicks)),
    cpm: cents(ratio(spend * 1000, t.impressions)),
    costPerConversion: cents(ratio(spend, conversions)),
    costPerPurchase: cents(known(spend, purchases)),
    roas: known(purchaseValue, spend),
  };
}

// ---------------------------------------------------------------------------
// What the stored days cover. A day an ad account has no figures stored for (it was never read, its
// syncs stopped, or the day hasn't started yet in the account's time zone) is missing: it is never
// added in as 0, and a total that would need it isn't given.
// ---------------------------------------------------------------------------

/** The days an account's stored figures cover, both included (the account's own days); null: none stored. */
export interface AdCoverage {
  from: string | null;
  through: string | null;
}

const NO_COVERAGE: AdCoverage = { from: null, through: null };

/** A closed ad account: the platform says so (error code or the account's own status). */
export const isClosedAdAccount = (c: { errorCode?: string | null; accountStatus?: string | null }) => c.errorCode === "account_closed" || c.accountStatus === "closed";

/**
 * The days one account covers: from where its history starts (history_from) to the last day stored
 * without a gap (synced_through). A closed account spends and earns nothing after it closed, so its
 * days run on to its own today as real zeros; any other account whose syncs stopped covers only what
 * it stored. Never synced: nothing.
 */
export function accountCoverage(
  c: { historyFrom: string | null; syncedThrough: string | null; errorCode?: string | null; accountStatus?: string | null },
  accountToday: string,
): AdCoverage {
  if (!c.historyFrom || !c.syncedThrough || c.syncedThrough < c.historyFrom) return NO_COVERAGE;
  return { from: c.historyFrom, through: isClosedAdAccount(c) && accountToday > c.syncedThrough ? accountToday : c.syncedThrough };
}

/** Whether a comparison can be worked out from these days: it starts on or after the day they start. */
export const canCompareFrom = (c: AdCoverage, previous: { from: string }) => c.from !== null && previous.from >= c.from;

/** The days every one of these accounts covers: the latest start to the earliest end (nothing if one has none). */
export function commonCoverage(list: AdCoverage[]): AdCoverage {
  if (!list.length) return NO_COVERAGE;
  let from = "";
  let through = "9999-12-31";
  for (const c of list) {
    if (c.from === null || c.through === null) return NO_COVERAGE;
    if (c.from > from) from = c.from;
    if (c.through < through) through = c.through;
  }
  return from > through ? NO_COVERAGE : { from, through };
}

/** The days of `c` after `day` (nothing when none are left). */
export function coverageAfter(c: AdCoverage, day: string): AdCoverage {
  if (c.from === null || c.through === null) return NO_COVERAGE;
  const next = addDays(day, 1);
  const from = next > c.from ? next : c.from;
  return from > c.through ? NO_COVERAGE : { from, through: c.through };
}

/** Whether `c` covers every day of `w`. */
export const coversDays = (c: AdCoverage, w: { from: string; to: string }) => c.from !== null && c.through !== null && c.from <= w.from && w.to <= c.through;

/** The part of `range` that `c` covers, or null when they don't meet. */
export function coveredPart(c: AdCoverage, range: { from: string; to: string }): { from: string; to: string } | null {
  if (c.from === null || c.through === null) return null;
  const from = c.from > range.from ? c.from : range.from;
  const to = c.through < range.to ? c.through : range.to;
  return from <= to ? { from, to } : null;
}

/**
 * The days a change is worked out on. Ad platforms report whole days, and a day still running (the
 * store's today, or an ad account's today in its own zone) holds only part of its figures: set
 * against a whole day it reads as a drop that never happened. So while the range reaches past
 * `lastWholeDay` (the last day finished everywhere), the range and the comparison both lose that
 * many days at their end, and the change is "through" the range's last whole day. A range of running
 * days only (Today) has nothing to compare: null.
 */
export function adComparisonWindows(range: { from: string; to: string }, previous: { from: string; to: string }, lastWholeDay: string) {
  if (range.to <= lastWholeDay) return { current: { from: range.from, to: range.to }, previous: { from: previous.from, to: previous.to }, trimmed: 0 };
  if (lastWholeDay < range.from) return null;
  const trimmed = eachDay(addDays(lastWholeDay, 1), range.to).length;
  const prevTo = addDays(previous.to, -trimmed);
  if (prevTo < previous.from) return null;
  return { current: { from: range.from, to: lastWholeDay }, previous: { from: previous.from, to: prevTo }, trimmed };
}

/** The last day that is over for the store and for each of these ad accounts, in its own time zone. */
export function lastWholeAdDay(storeToday: string, accountTodays: readonly string[]): string {
  let today = storeToday;
  for (const t of accountTodays) if (t < today) today = t;
  return addDays(today, -1);
}

/**
 * Whether two time zones have the same calendar days: the same local date and time now and half a
 * year either side (so summer time counts). "Australia/Melbourne" and "Australia/Sydney" do.
 */
export function sameDays(a: string, b: string, now: Date): boolean {
  if (a === b) return true;
  try {
    return [0, 182, -182].every((n) => {
      const t = new Date(now.getTime() + n * 86_400_000);
      return localDay(t, a) === localDay(t, b) && localTime(t, a).slice(0, 5) === localTime(t, b).slice(0, 5);
    });
  } catch {
    // A zone Intl doesn't know: nothing to tell the merchant.
    return true;
  }
}

/** One day of the ads chart. Every figure is null on a day a counted account has no figures for. */
export interface AdSeriesDay {
  day: string;
  spend: number | null;
  impressions: number | null;
  /** Every click the platforms count. */
  clicks: number | null;
  /** Link clicks; also null on a covered day whose link clicks aren't read yet. */
  linkClicks: number | null;
  conversions: number | null;
  conversionValue: number | null;
  /** Also null on a covered day whose purchases aren't read yet. */
  purchases: number | null;
  purchaseValue: number | null;
}

/**
 * A daily series (ads, AdSense) added up into weeks (Monday to Sunday) or calendar months
 * (`periodsOf`): each figure is the sum of the period's days, or null when any of its days in the
 * range lacks it, as every figure over days is here: never a part of a week passed off as the whole.
 * `day` is the period's first day in the range; `from` and `to` its days in the range.
 */
export function groupSeries<T extends { day: string }>(series: readonly T[], range: { from: string; to: string }, g: PeriodGranularity): Array<T & { key: string; from: string; to: string }> {
  const byDay = new Map(series.map((d) => [d.day, d]));
  return periodsOf(range, g).flatMap((p) => {
    const days = eachDay(p.from, p.to).flatMap((d) => byDay.get(d) ?? []);
    if (!days.length) return [];
    const sums: Record<string, number | null> = {};
    for (const d of days) {
      for (const [k, v] of Object.entries(d)) {
        if (k === "day" || (typeof v !== "number" && v !== null)) continue;
        const before = k in sums ? sums[k]! : 0;
        sums[k] = before === null || v === null ? null : Math.round((before + (v as number)) * 100) / 100;
      }
    }
    return [{ ...days[0]!, ...sums, day: p.from, key: p.key, from: p.from, to: p.to }];
  });
}

/**
 * One point per day of the range. A day `coverage` includes and nothing ran on is a real 0; a day
 * outside it is missing (every figure null). Without a coverage every day counts as covered.
 */
export function adSeries(rows: AdDayRow[], range: { from: string; to: string }, coverage?: AdCoverage): AdSeriesDay[] {
  const by = new Map<string, AdDayRow[]>();
  for (const r of rows) {
    const list = by.get(r.day) ?? [];
    list.push(r);
    by.set(r.day, list);
  }
  return eachDay(range.from, range.to).map((day) => {
    if (coverage && !coversDays(coverage, { from: day, to: day })) {
      return { day, spend: null, impressions: null, clicks: null, linkClicks: null, conversions: null, conversionValue: null, purchases: null, purchaseValue: null };
    }
    const t = adTotals(by.get(day) ?? []);
    return {
      day,
      spend: t.spend,
      impressions: t.impressions,
      clicks: t.clicks,
      linkClicks: t.linkClicks,
      conversions: t.conversions,
      conversionValue: t.conversionValue,
      purchases: t.purchases,
      purchaseValue: t.purchaseValue,
    };
  });
}

/** Totals per campaign, biggest spend first. */
export function campaignTotals(rows: AdDayRow[], limit = 10) {
  const by = new Map<string, AdDayRow[]>();
  for (const r of rows) {
    const key = `${r.provider}:${r.accountId}:${r.campaignId}`;
    const list = by.get(key) ?? [];
    list.push(r);
    by.set(key, list);
  }
  return [...by.values()]
    .map((list) => {
      // The name the campaign has now: the latest day's.
      const latest = list.reduce((a, r) => (r.day > a.day ? r : a));
      return { provider: latest.provider, accountId: latest.accountId, campaignId: latest.campaignId, name: latest.campaignName, ...adTotals(list) };
    })
    .sort((a, b) => b.spend - a.spend || b.clicks - a.clicks)
    .slice(0, limit);
}

/** The range just before, as many days long (the dashboard's comparison period). */
export function previousRange(range: { from: string; to: string }) {
  const days = eachDay(range.from, range.to).length;
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** Meta reports every action type it tracks; these are the ones that mean a purchase or a lead, best first. */
const META_PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
const META_LEAD = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
/** A landing page loaded after a link click, as Meta counts it (the omni count first: they overlap). */
const META_LANDING_PAGE_VIEW = ["omni_landing_page_view", "landing_page_view"];

type MetaAction = { action_type: string; value: string | number };

/**
 * Meta lists overlapping action types for one purchase (omni_purchase includes purchase, which
 * includes the pixel's own): take the first that's present, never the sum, or every sale counts
 * two or three times.
 */
function firstAction(actions: MetaAction[] | undefined, types: string[]): number {
  if (!actions) return 0;
  for (const t of types) {
    const a = actions.find((x) => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}

/** One row of GET /act_<id>/insights?level=campaign&time_increment=1. */
export interface MetaInsightRow {
  campaign_id?: string;
  campaign_name?: string;
  date_start: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
}

/**
 * One campaign-day as stored. `linkClicks` is null only when the row didn't come from a query that
 * asked for inline_link_clicks (Meta leaves the field out on a day without link clicks: zero then).
 */
export function fromMetaInsight(accountId: string, r: MetaInsightRow, opts: { linkClicksAsked?: boolean } = { linkClicksAsked: true }): AdDayRow {
  const purchases = firstAction(r.actions, META_PURCHASE);
  const purchaseValue = r2(firstAction(r.action_values, META_PURCHASE));
  return {
    provider: "meta",
    accountId,
    campaignId: r.campaign_id ?? "account",
    campaignName: r.campaign_name ?? "All campaigns",
    day: r.date_start,
    spend: r2(Number(r.spend ?? 0)),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    linkClicks: r.inline_link_clicks !== undefined ? Math.round(Number(r.inline_link_clicks) || 0) : opts.linkClicksAsked ? 0 : null,
    // Meta's conversions are its purchases: the same figure.
    conversions: purchases,
    conversionValue: purchaseValue,
    purchases,
    purchaseValue,
    leads: Math.round(firstAction(r.actions, META_LEAD)),
  };
}

// ---------------------------------------------------------------------------
// The Meta Ads report: one date range at a time, asked of Meta directly (not added up from the
// stored days), because reach and frequency count people once over the whole range.
// ---------------------------------------------------------------------------

export const META_REPORT_LEVELS = ["campaign", "adset", "ad"] as const;
export type MetaReportLevel = (typeof META_REPORT_LEVELS)[number];

/**
 * Whole-account splits: where the ads ran (Facebook Feed, Instagram Stories...), on which devices, in
 * which countries, and to which age groups and genders (Meta's own aggregates; nothing about a person).
 */
export const META_REPORT_BREAKDOWNS = ["placement", "device", "country", "age", "gender"] as const;
export type MetaReportBreakdown = (typeof META_REPORT_BREAKDOWNS)[number];

/** Every way the Meta Ads report can be cut. */
export const META_REPORT_VIEWS = [...META_REPORT_LEVELS, ...META_REPORT_BREAKDOWNS] as const;
export type MetaReportView = (typeof META_REPORT_VIEWS)[number];

export const isMetaBreakdown = (v: MetaReportView): v is MetaReportBreakdown => (META_REPORT_BREAKDOWNS as readonly string[]).includes(v);

/** A Meta campaign, ad set or ad id as the Graph API writes it: digits only. */
export const isMetaObjectId = (v: unknown): v is string => typeof v === "string" && /^\d{1,30}$/.test(v);

/**
 * A drill-down in the Meta Ads report: only the ad sets of one campaign, or only the ads of one ad set
 * (or of one campaign). Meta's own ids (isMetaObjectId). Both given: the ad set must be in that campaign.
 */
export interface MetaReportParent {
  campaign?: string;
  adset?: string;
}

/**
 * Whether `level` can be read under `parent`: a campaign's ad sets or ads, an ad set's ads. A campaign
 * has no parent, and a split of the whole account (placement, device...) none either.
 */
export function metaParentFits(level: MetaReportView, parent: MetaReportParent): boolean {
  if (parent.adset !== undefined) return level === "ad";
  if (parent.campaign !== undefined) return level === "adset" || level === "ad";
  return true;
}

/**
 * The Insights API `breakdowns` for each split. The device split asks for one of Meta's documented
 * combinations, publisher_platform with impression_device
 * (https://developers.facebook.com/docs/marketing-api/insights/breakdowns), and its rows are added up
 * per device afterwards (core's metaReport).
 */
export const META_BREAKDOWN_PARAM: Record<MetaReportBreakdown, string> = {
  placement: "publisher_platform,platform_position",
  device: "publisher_platform,impression_device",
  country: "country",
  age: "age",
  gender: "gender",
};

/** One row of GET /act_<id>/insights for a whole range (no time_increment). */
export interface MetaRangeInsight {
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  /** Breakdown keys, present only when the report was split by them. */
  publisher_platform?: string;
  platform_position?: string;
  impression_device?: string;
  country?: string;
  /** "18-24", "25-34", ... "65+", "Unknown". */
  age?: string;
  /** "female", "male", "unknown". */
  gender?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
  attribution_setting?: string;
}

export interface MetaReportMetrics {
  spend: number;
  impressions: number;
  /** People who saw an ad at least once in the range; null when Meta didn't say. */
  reach: number | null;
  /** Impressions per person reached. */
  frequency: number | null;
  /** Every click, including likes, comments and profile clicks. */
  clicks: number;
  /** Clicks on the ad's link (to the store, the app, WhatsApp...). */
  linkClicks: number;
  /** Link clicks per impression. */
  linkCtr: number | null;
  costPerLinkClick: number | null;
  /** Spend per thousand impressions. */
  cpm: number | null;
  /**
   * Link clicks after which the landing page loaded, as Meta's pixel saw it: Meta's count, not the
   * store's sessions (a visit Meta can't see isn't one, and one person can land twice).
   */
  landingPageViews: number;
  costPerLandingPageView: number | null;
  /** Purchases Meta attributes to the ads (its own count, not the store's orders). */
  purchases: number;
  purchaseValue: number;
  costPerPurchase: number | null;
  /** Purchase value per unit of spend. */
  roas: number | null;
  leads: number;
}

/**
 * What a campaign, ad set or ad is set to at Meta (read from the account's own list of them, with
 * its delivery status): its objective, budget, schedule and bidding. Money is in the ad account's
 * currency. A field Meta didn't say, or that doesn't apply to the level, is null.
 */
export interface MetaObjectDetails {
  /** Campaigns: Meta's objective (OUTCOME_SALES, OUTCOME_LEADS...; see metaObjectiveLabel). */
  objective: string | null;
  /** Campaigns: AUCTION or RESERVED. */
  buyingType: string | null;
  /** Campaigns and ad sets: the daily budget, or the lifetime budget, whichever is set. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  /** Campaigns and ad sets: when delivery is scheduled to start and end (ISO 8601; end null when open-ended). */
  startTime: string | null;
  endTime: string | null;
  /** Campaigns and ad sets: LOWEST_COST_WITHOUT_CAP, COST_CAP... (see metaWords). */
  bidStrategy: string | null;
  /** Ad sets: what delivery is optimized for (OFFSITE_CONVERSIONS, LINK_CLICKS...) and what is billed (IMPRESSIONS, LINK_CLICKS). */
  optimizationGoal: string | null;
  billingEvent: string | null;
  /** Ads: Meta's shareable preview of the ad, and its creative's id. */
  previewLink: string | null;
  creativeId: string | null;
}

export interface MetaReportRow extends MetaReportMetrics {
  id: string;
  name: string;
  /** The campaign an ad set or ad is in, its id and name (null on the campaign level and in a split). */
  campaignId: string | null;
  campaignName: string | null;
  /** The ad set an ad is in (null above the ad level). */
  adsetId: string | null;
  adsetName: string | null;
  /** Meta's effective_status (ACTIVE, PAUSED, CAMPAIGN_PAUSED, WITH_ISSUES...), null when unknown. */
  status: string | null;
  /** How Meta credited purchases, e.g. "7d_click_1d_view". */
  attribution: string | null;
  /** The object's own settings at Meta (campaign, ad set and ad levels); absent or null when not read. */
  details?: MetaObjectDetails | null;
}

/** How many campaigns an ad account has in each state at Meta now (its whole list, not only the ones that spent). */
export interface MetaCampaignCounts {
  /** effective_status ACTIVE. */
  active: number;
  /** PAUSED (by the advertiser). */
  paused: number;
  /** Everything else: archived, deleted, in review, with issues. */
  other: number;
  total: number;
  /** False when the list was cut short (more campaigns than were read): the counts are of those read. */
  complete: boolean;
}

/** The empty counts, to add campaigns into (metaCountCampaign). */
export const noMetaCampaignCounts = (): MetaCampaignCounts => ({ active: 0, paused: 0, other: 0, total: 0, complete: true });

/** Count one campaign by its effective_status into `counts`. */
export function metaCountCampaign(counts: MetaCampaignCounts, effectiveStatus: string | null | undefined): void {
  counts.total++;
  if (effectiveStatus === "ACTIVE") counts.active++;
  else if (effectiveStatus === "PAUSED") counts.paused++;
  else counts.other++;
}

/** The fields each level's list is read with: the delivery status, and the object's settings (MetaObjectDetails). */
export const META_OBJECT_FIELDS: Record<MetaReportLevel, string> = {
  campaign: "id,effective_status,objective,buying_type,daily_budget,lifetime_budget,start_time,stop_time,bid_strategy",
  adset: "id,effective_status,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,start_time,end_time",
  ad: "id,effective_status,preview_shareable_link,creative{id}",
};

/** One campaign, ad set or ad as Meta lists it (the fields of META_OBJECT_FIELDS; each level leaves out the others'). */
export interface MetaListedObject {
  id?: string;
  effective_status?: string;
  objective?: string;
  buying_type?: string;
  /** Budgets come in the currency's minor unit (cents for most currencies), as strings. */
  daily_budget?: string | number;
  lifetime_budget?: string | number;
  start_time?: string;
  /** Campaigns say stop_time, ad sets end_time. */
  stop_time?: string;
  end_time?: string;
  bid_strategy?: string;
  optimization_goal?: string;
  billing_event?: string;
  preview_shareable_link?: string;
  creative?: { id?: string };
}

/**
 * How many of a currency's minor units make one unit: 100 for most, 1 for currencies without a
 * minor unit (JPY, KRW...), 1000 for a few (KWD, BHD), as ISO 4217 has them (Intl knows the list).
 * Meta states budgets in minor units.
 */
export function minorUnitsPerUnit(currency: string | null | undefined): number {
  if (!currency) return 100;
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return 10 ** digits;
  } catch {
    return 100;
  }
}

/** A budget as Meta states it (minor units) in the account's currency; null when not set or not a number. */
export function metaBudget(minor: string | number | null | undefined, currency: string | null | undefined): number | null {
  if (minor === null || minor === undefined || minor === "") return null;
  const n = Number(minor);
  if (!Number.isFinite(n) || n <= 0) return null;
  return r2(n / minorUnitsPerUnit(currency));
}

/** A listed campaign, ad set or ad → its settings (MetaObjectDetails), budgets in `currency`. */
export function metaObjectDetails(o: MetaListedObject, currency: string | null | undefined): MetaObjectDetails {
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const creativeId = text(o.creative?.id);
  const preview = text(o.preview_shareable_link);
  return {
    objective: text(o.objective),
    buyingType: text(o.buying_type),
    dailyBudget: metaBudget(o.daily_budget, currency),
    lifetimeBudget: metaBudget(o.lifetime_budget, currency),
    startTime: text(o.start_time),
    endTime: text(o.stop_time ?? o.end_time),
    bidStrategy: text(o.bid_strategy),
    optimizationGoal: text(o.optimization_goal),
    billingEvent: text(o.billing_event),
    // Only Meta's own preview pages: a link elsewhere would be shown as if Meta's.
    previewLink: preview && /^https:\/\/(www\.|business\.)?facebook\.com\//i.test(preview) ? preview : null,
    creativeId: creativeId && /^\d{1,30}$/.test(creativeId) ? creativeId : null,
  };
}

/** Meta's campaign objectives in everyday words (the ODAX ones, and the older ones still on old campaigns). */
const META_OBJECTIVE: Record<string, string> = {
  OUTCOME_SALES: "Sales",
  OUTCOME_LEADS: "Leads",
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_ENGAGEMENT: "Engagement",
  OUTCOME_AWARENESS: "Awareness",
  OUTCOME_APP_PROMOTION: "App promotion",
  CONVERSIONS: "Conversions",
  LINK_CLICKS: "Traffic",
  LEAD_GENERATION: "Lead generation",
  MESSAGES: "Messages",
  POST_ENGAGEMENT: "Post engagement",
  PAGE_LIKES: "Page likes",
  EVENT_RESPONSES: "Event responses",
  VIDEO_VIEWS: "Video views",
  REACH: "Reach",
  BRAND_AWARENESS: "Brand awareness",
  APP_INSTALLS: "App installs",
  PRODUCT_CATALOG_SALES: "Catalog sales",
  STORE_VISITS: "Store visits",
  LOCAL_AWARENESS: "Local awareness",
};

/** "OUTCOME_SALES" → "Sales"; anything else as Meta wrote it, in words. Null for none. */
export function metaObjectiveLabel(objective: string | null | undefined): string | null {
  if (!objective) return null;
  return META_OBJECTIVE[objective] ?? metaWords(objective);
}

/** "LOWEST_COST_WITHOUT_CAP" → "Lowest cost without cap": Meta's constants as words. Null for none. */
export function metaWords(value: string | null | undefined): string | null {
  if (!value) return null;
  const words = value.replace(/_/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : null;
}

/**
 * Where a row's delivery status puts it, for the report's status filter: ACTIVE is "active"; PAUSED,
 * CAMPAIGN_PAUSED and ADSET_PAUSED are "paused"; anything else (archived, deleted, in review, with
 * issues, billing needed) is "other"; unknown statuses fall under "other" too.
 */
export type MetaStatusGroup = "active" | "paused" | "other";
export function metaStatusGroup(status: string | null | undefined): MetaStatusGroup {
  if (status === "ACTIVE") return "active";
  if (status === "PAUSED" || status === "CAMPAIGN_PAUSED" || status === "ADSET_PAUSED") return "paused";
  return "other";
}

// ---------------------------------------------------------------------------
// The store's own sales next to its ad spend: Shopify's figures (net sales, orders), never an ad
// platform's attribution. Two measures, kept apart on purpose: a platform's ROAS is the purchase
// value it credits to its own ads ÷ what it charged (its claim); the store's sales per unit of ad
// spend (MER, marketing efficiency ratio) is every sale the store made ÷ everything spent on ads.
// ---------------------------------------------------------------------------

export interface AdsVsSales {
  /** The store's net sales and orders for the same dates (Shopify's own figures, in the store's currency). */
  netSales: number;
  orders: number;
  /** Net sales ÷ ad spend: the store's sales per unit of ad spend (MER); null while nothing was spent. */
  salesPerSpend: number | null;
  /** Ad spend ÷ net sales; null while there were no sales. */
  shareOfSales: number | null;
  /** Ad spend ÷ the store's orders (every order, whatever brought it): a derived cost, not an attribution; null without orders. */
  costPerOrder: number | null;
}

/** The store's sales set against `spend` (adsVsSales is null when either side isn't known). */
export function adsVsSales(spend: number | null, netSales: number | null, orders: number | null): AdsVsSales | null {
  if (spend === null || netSales === null || orders === null) return null;
  const sps = ratio(netSales, spend);
  return {
    netSales,
    orders,
    salesPerSpend: sps === null ? null : Math.round(sps * 100) / 100,
    shareOfSales: ratio(spend, netSales),
    costPerOrder: cents(ratio(spend, orders)),
  };
}

/** The ad platforms a Shopify traffic source belongs to: Facebook and Instagram are Meta's, Google and YouTube are Google Ads'. */
export function trafficSourcePlatform(source: string | null | undefined): AdSpendProvider | null {
  if (source === "facebook" || source === "instagram") return "meta";
  if (source === "google" || source === "youtube") return "google";
  return null;
}

const num = (s: string | undefined) => {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function metaReportMetrics(r: MetaRangeInsight): MetaReportMetrics {
  const spend = r2(num(r.spend));
  const impressions = Math.round(num(r.impressions));
  const linkClicks = Math.round(num(r.inline_link_clicks));
  const purchases = firstAction(r.actions, META_PURCHASE);
  const purchaseValue = r2(firstAction(r.action_values, META_PURCHASE));
  const reach = r.reach === undefined ? null : Math.round(num(r.reach));
  const frequency = r.frequency !== undefined ? Math.round(num(r.frequency) * 100) / 100 : reach ? Math.round((impressions / reach) * 100) / 100 : null;
  const cpl = ratio(spend, linkClicks);
  const cpm = ratio(spend * 1000, impressions);
  const cpp = ratio(spend, purchases);
  const landingPageViews = Math.round(firstAction(r.actions, META_LANDING_PAGE_VIEW));
  const cplpv = ratio(spend, landingPageViews);
  return {
    spend,
    impressions,
    reach,
    frequency,
    clicks: Math.round(num(r.clicks)),
    linkClicks,
    linkCtr: ratio(linkClicks, impressions),
    costPerLinkClick: cpl === null ? null : r2(cpl),
    cpm: cpm === null ? null : r2(cpm),
    landingPageViews,
    costPerLandingPageView: cplpv === null ? null : r2(cplpv),
    purchases,
    purchaseValue,
    costPerPurchase: cpp === null ? null : r2(cpp),
    roas: ratio(purchaseValue, spend),
    leads: Math.round(firstAction(r.actions, META_LEAD)),
  };
}

export function fromMetaRangeInsight(level: MetaReportLevel, r: MetaRangeInsight): MetaReportRow {
  const id = (level === "campaign" ? r.campaign_id : level === "adset" ? r.adset_id : r.ad_id) ?? "unknown";
  const name = (level === "campaign" ? r.campaign_name : level === "adset" ? r.adset_name : r.ad_name) ?? id;
  return {
    id,
    name,
    campaignId: level === "campaign" ? null : (r.campaign_id ?? null),
    campaignName: level === "campaign" ? null : (r.campaign_name ?? null),
    adsetId: level === "ad" ? (r.adset_id ?? null) : null,
    adsetName: level === "ad" ? (r.adset_name ?? null) : null,
    status: null,
    attribution: r.attribution_setting ?? null,
    ...metaReportMetrics(r),
  };
}

const META_PLATFORM: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", messenger: "Messenger", audience_network: "Audience Network", threads: "Threads", whatsapp: "WhatsApp" };
const META_DEVICE: Record<string, string> = {
  desktop: "Computers",
  iphone: "iPhone",
  ipad: "iPad",
  ipod: "iPod",
  android_smartphone: "Android phones",
  android_tablet: "Android tablets",
  other: "Other devices",
  unknown: "Unknown",
};

const META_GENDER: Record<string, string> = { female: "Women", male: "Men", unknown: "Unknown" };

/** "instagram_stories" → "Stories", "an_classic" → "Classic": the position without its platform's prefix. */
const positionLabel = (p: string) => {
  const words = p.replace(/^(facebook|instagram|messenger|an|threads)_/, "").replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : p;
};

/** "US" → "United States" (English, wherever this runs); an unknown code stays as it is. */
export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** One placement, device or country of a whole-account split. */
export function fromMetaBreakdownInsight(breakdown: MetaReportBreakdown, r: MetaRangeInsight): MetaReportRow {
  let id: string;
  let name: string;
  if (breakdown === "placement") {
    const platform = r.publisher_platform ?? "unknown";
    id = `${platform}:${r.platform_position ?? ""}`;
    const p = META_PLATFORM[platform] ?? positionLabel(platform);
    name = r.platform_position ? `${p} · ${positionLabel(r.platform_position)}` : p;
  } else if (breakdown === "device") {
    id = r.impression_device ?? "unknown";
    name = META_DEVICE[id] ?? positionLabel(id);
  } else if (breakdown === "age") {
    id = r.age ?? "unknown";
    name = !r.age || r.age.toLowerCase() === "unknown" ? "Unknown age" : `Aged ${r.age}`;
  } else if (breakdown === "gender") {
    id = r.gender ?? "unknown";
    name = META_GENDER[id] ?? "Unknown";
  } else {
    id = r.country ?? "unknown";
    name = r.country ? countryName(r.country) : "Unknown";
  }
  return { id, name, campaignId: null, campaignName: null, adsetId: null, adsetName: null, status: null, attribution: r.attribution_setting ?? null, ...metaReportMetrics(r) };
}

/** "7d_click_1d_view" → "7-day click, 1-day view"; anything unrecognised is shown as Meta wrote it. */
export function metaAttributionLabel(setting: string | null | undefined): string | null {
  if (!setting) return null;
  const parts = setting.split(/[,_](?=\d)/).map((p) => {
    const m = /^(\d+)d_(click|view|ev)$/.exec(p.trim());
    if (!m) return null;
    return `${m[1]}-day ${m[2] === "click" ? "click" : m[2] === "view" ? "view" : "engaged view"}`;
  });
  return parts.every((p) => p !== null) ? parts.join(", ") : setting;
}

/** One result of googleAds:searchStream for the campaign query (JSON field names are camelCase). */
export interface GoogleAdsRow {
  campaign?: { id?: string; name?: string; status?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string | number; impressions?: string | number; clicks?: string | number; conversions?: string | number; conversionsValue?: string | number };
}

export function fromGoogleAdsRow(accountId: string, r: GoogleAdsRow): AdDayRow | null {
  const day = r.segments?.date;
  if (!day) return null;
  const m = r.metrics ?? {};
  return {
    provider: "google",
    accountId,
    campaignId: String(r.campaign?.id ?? "account"),
    campaignName: r.campaign?.name ?? "All campaigns",
    day,
    // Google reports money in millionths of the account's currency.
    spend: r2(Number(m.costMicros ?? 0) / 1_000_000),
    impressions: Number(m.impressions ?? 0),
    clicks: Number(m.clicks ?? 0),
    // Google's clicks are clicks on the ad (its link, call button, ...): the comparable figure.
    linkClicks: Number(m.clicks ?? 0),
    conversions: Math.round(Number(m.conversions ?? 0) * 100) / 100,
    conversionValue: r2(Number(m.conversionsValue ?? 0)),
    // Purchases need their own query (conversion segments can't sit next to cost): merged in by the caller.
    purchases: null,
    purchaseValue: null,
    leads: 0,
    campaignStatus: r.campaign?.status ?? null,
  };
}

/** One result of the purchase-only query: conversions of category PURCHASE per campaign per day. */
export interface GooglePurchaseRow {
  campaign?: { id?: string | number };
  segments?: { date?: string };
  metrics?: { conversions?: string | number; conversionsValue?: string | number };
}

/**
 * Put each campaign-day's purchases (from the purchase-only query) on its row. Rows the purchase query
 * didn't return had none: zero, since that query ran for the same days.
 */
export function withGooglePurchases(rows: AdDayRow[], purchases: GooglePurchaseRow[]): AdDayRow[] {
  const by = new Map<string, { n: number; v: number }>();
  for (const p of purchases) {
    const key = `${String(p.campaign?.id ?? "account")}|${p.segments?.date ?? ""}`;
    const d = by.get(key) ?? { n: 0, v: 0 };
    d.n += Number(p.metrics?.conversions ?? 0) || 0;
    d.v += Number(p.metrics?.conversionsValue ?? 0) || 0;
    by.set(key, d);
  }
  return rows.map((r) => {
    const d = by.get(`${r.campaignId}|${r.day}`);
    return { ...r, purchases: Math.round((d?.n ?? 0) * 100) / 100, purchaseValue: r2(d?.v ?? 0) };
  });
}

// ---------------------------------------------------------------------------
// The Google Ads report: one date range at a time, asked of Google directly, by campaign (with its
// status, type and budget), ad group, device or country; and down from one campaign to its ad groups
// (a Performance Max campaign's asset groups, which it has instead), and from one ad group to its ads.
// Keywords and search terms too, for the account, one campaign or (keywords) one ad group.
// ---------------------------------------------------------------------------

/** `asset_group` and `ad` are read only under a parent (googleParentFits): one campaign's, one ad group's. */
export const GOOGLE_REPORT_LEVELS = ["campaign", "ad_group", "device", "country", "asset_group", "ad", "keyword", "search_term"] as const;
export type GoogleReportLevel = (typeof GOOGLE_REPORT_LEVELS)[number];

/**
 * Keywords (Google's keyword_view) and the search terms people typed (campaign_search_term_view): long
 * lists, read only when someone opens them, Google itself picking the biggest spenders, and each read held
 * to its own share of bizinsights' daily Google Ads operations (the API's guards). Their top row is the
 * account's, campaign's or ad group's own figures, which their rows add up to less than.
 */
export const GOOGLE_DETAIL_LEVELS = ["keyword", "search_term"] as const satisfies readonly GoogleReportLevel[];
export type GoogleDetailLevel = (typeof GOOGLE_DETAIL_LEVELS)[number];
export const isGoogleDetailLevel = (level: GoogleReportLevel): level is GoogleDetailLevel => (GOOGLE_DETAIL_LEVELS as readonly string[]).includes(level);

/** A Google Ads campaign, ad group or ad id as the API writes it: digits only (an int64). */
export const isGoogleObjectId = (v: unknown): v is string => typeof v === "string" && /^\d{1,20}$/.test(v);

/**
 * A drill-down in the Google Ads report: one campaign's ad groups or asset groups, or one ad group's
 * ads. Google's own ids (isGoogleObjectId), or the demo's own (isDemoObjectId in ./adsDemo) on a demo
 * connection. Both given: the ad group must be in that campaign.
 */
export interface GoogleReportParent {
  campaign?: string;
  adGroup?: string;
}

/**
 * Whether `level` can be read under `parent`: ad groups for the whole account or one campaign, asset
 * groups for one campaign, ads for one ad group; keywords for the account, one campaign or one ad group;
 * search terms for the account or one campaign (Google gives them by campaign, so that Performance Max's
 * are among them); campaigns, devices and countries for the whole account.
 */
export function googleParentFits(level: GoogleReportLevel, parent: GoogleReportParent): boolean {
  if (level === "ad") return parent.adGroup !== undefined;
  if (level === "asset_group") return parent.campaign !== undefined && parent.adGroup === undefined;
  if (level === "keyword") return true;
  if (level === "ad_group" || level === "search_term") return parent.adGroup === undefined;
  return parent.campaign === undefined && parent.adGroup === undefined;
}

/** "EXACT" → "Exact match": a keyword's match type in Google's own words. */
export function googleMatchTypeLabel(type: string | null | undefined): string | null {
  if (!type || type === "UNKNOWN" || type === "UNSPECIFIED") return null;
  const words = type.replace(/_/g, " ").trim().toLowerCase();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)} match` : null;
}

/** "RESPONSIVE_SEARCH_AD" → "Responsive search ad": Google's ad types in words. */
export function googleAdTypeLabel(type: string | null | undefined): string {
  if (!type || type === "UNKNOWN" || type === "UNSPECIFIED") return "Ad";
  const words = type.replace(/_/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Ad";
}

/**
 * An ad's name as the report shows it: Google's own (ad.name), which most ad types don't have
 * (responsive search ads, for one), else its type and id, so two unnamed ads never read alike.
 */
export function googleAdName(name: string | null | undefined, type: string | null | undefined, id: string): string {
  const own = typeof name === "string" ? name.trim() : "";
  return own || `${googleAdTypeLabel(type)} ${id}`;
}

export interface GoogleReportMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  /** Clicks per impression. */
  ctr: number | null;
  /** Spend per click (Google's "average CPC"). */
  cpc: number | null;
  /** Spend per thousand impressions. */
  cpm: number | null;
  /** Google's own count, by each conversion action's own attribution model. */
  conversions: number;
  /** Conversions per click (Google's "conv. rate", on every conversion action). */
  conversionRate: number | null;
  conversionValue: number;
  costPerConversion: number | null;
  /** Conversion value per unit of spend. */
  roas: number | null;
}

export interface GoogleReportRow extends GoogleReportMetrics {
  id: string;
  name: string;
  /** The campaign an ad group, asset group or ad is in, its id and name (null on other levels). */
  campaignId: string | null;
  campaignName: string | null;
  /** The ad group an ad or keyword is in (null on other levels). */
  adGroupId: string | null;
  adGroupName: string | null;
  /** An ad's type (RESPONSIVE_SEARCH_AD, RESPONSIVE_DISPLAY_AD...; see googleAdTypeLabel); null on other levels. */
  adType: string | null;
  /** ENABLED, PAUSED or REMOVED, for campaigns, ad groups, asset groups, ads and keywords (a removed one is listed when it spent in the dates). */
  status: string | null;
  /** SEARCH, SHOPPING, PERFORMANCE_MAX, DISPLAY, VIDEO... (campaigns, and the campaign a search term is in). */
  channel: string | null;
  /** The campaign budget per day, in the account's currency (campaigns). */
  dailyBudget: number | null;
  /** A keyword's match type: EXACT, PHRASE or BROAD (googleMatchTypeLabel); null on other levels. */
  matchType: string | null;
  /**
   * A keyword's Quality Score, 1 to 10, as Google rates it now (not for the dates). Null when Google has
   * too little data to give one, and on other levels.
   */
  qualityScore: number | null;
}

/** One result of googleAds:searchStream for a report query (JSON field names are camelCase). */
export interface GoogleReportApiRow {
  campaign?: { id?: string | number; name?: string; status?: string; advertisingChannelType?: string };
  campaignBudget?: { amountMicros?: string | number };
  adGroup?: { id?: string | number; name?: string; status?: string };
  /** The ad level (FROM ad_group_ad): the ad's own status, and the ad's id, name (most types have none) and type. */
  adGroupAd?: { status?: string; ad?: { id?: string | number; name?: string; type?: string } };
  /** Performance Max (FROM asset_group). */
  assetGroup?: { id?: string | number; name?: string; status?: string };
  /** The keyword level (FROM keyword_view): the keyword's criterion id, status, text, match type and Quality Score. */
  adGroupCriterion?: { criterionId?: string | number; status?: string; keyword?: { text?: string; matchType?: string }; qualityInfo?: { qualityScore?: string | number } };
  /** The search-term level (FROM campaign_search_term_view): what was typed, by campaign. */
  campaignSearchTermView?: { searchTerm?: string };
  segments?: { device?: string };
  userLocationView?: { countryCriterionId?: string | number };
  metrics?: { costMicros?: string | number; impressions?: string | number; clicks?: string | number; conversions?: string | number; conversionsValue?: string | number };
}

const GOOGLE_DEVICE: Record<string, string> = { MOBILE: "Phones", DESKTOP: "Computers", TABLET: "Tablets", CONNECTED_TV: "TV screens", OTHER: "Other devices", UNKNOWN: "Unknown" };

const n0 = (v: string | number | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Ratios worked out from the sums, so a row that groups several of Google's rows stays right. */
export function googleReportMetrics(m: GoogleReportApiRow["metrics"]): GoogleReportMetrics {
  // Google reports money in millionths of the account's currency.
  const spend = r2(n0(m?.costMicros) / 1_000_000);
  const impressions = Math.round(n0(m?.impressions));
  const clicks = Math.round(n0(m?.clicks));
  const conversions = Math.round(n0(m?.conversions) * 100) / 100;
  const conversionValue = r2(n0(m?.conversionsValue));
  const cpc = ratio(spend, clicks);
  const cpm = ratio(spend * 1000, impressions);
  const cpa = ratio(spend, conversions);
  return {
    spend,
    impressions,
    clicks,
    ctr: ratio(clicks, impressions),
    cpc: cpc === null ? null : r2(cpc),
    cpm: cpm === null ? null : r2(cpm),
    conversions,
    conversionRate: ratio(conversions, clicks),
    conversionValue,
    costPerConversion: cpa === null ? null : r2(cpa),
    roas: ratio(conversionValue, spend),
  };
}

/** A Quality Score as Google gives it (1 to 10); anything else, Google's "too little data" included, is none. */
const qualityScoreOf = (v: string | number | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
};

/**
 * Google's rows for one level, grouped (a country comes back once per targeting kind, a device
 * once per campaign...) and biggest spend first. `countries` maps a geo target id to its ISO code.
 * A keyword is one per ad group (`<ad group id>~<criterion id>`), a search term one per campaign
 * (`<campaign id>~<term>`), as Google's views key them.
 */
export function googleReportRows(level: GoogleReportLevel, rows: GoogleReportApiRow[], countries: Map<string, string> = new Map()): GoogleReportRow[] {
  const groups = new Map<string, { row: Omit<GoogleReportRow, keyof GoogleReportMetrics>; sums: Required<NonNullable<GoogleReportApiRow["metrics"]>> }>();
  for (const r of rows) {
    let key: string;
    let head: Omit<GoogleReportRow, keyof GoogleReportMetrics>;
    const blank = { campaignId: null, campaignName: null, adGroupId: null, adGroupName: null, adType: null, status: null, channel: null, dailyBudget: null, matchType: null, qualityScore: null };
    const id = (v: string | number | undefined) => (v === undefined || v === null || v === "" ? null : String(v));
    const campaign = { campaignId: id(r.campaign?.id), campaignName: r.campaign?.name ?? null };
    if (level === "campaign") {
      key = String(r.campaign?.id ?? "unknown");
      const budget = r.campaignBudget?.amountMicros;
      head = {
        ...blank,
        id: key,
        name: r.campaign?.name ?? key,
        status: r.campaign?.status ?? null,
        channel: r.campaign?.advertisingChannelType ?? null,
        dailyBudget: budget === undefined ? null : r2(n0(budget) / 1_000_000),
      };
    } else if (level === "ad_group") {
      key = String(r.adGroup?.id ?? "unknown");
      head = { ...blank, ...campaign, id: key, name: r.adGroup?.name ?? key, status: r.adGroup?.status ?? null };
    } else if (level === "asset_group") {
      key = String(r.assetGroup?.id ?? "unknown");
      head = { ...blank, ...campaign, id: key, name: r.assetGroup?.name ?? key, status: r.assetGroup?.status ?? null };
    } else if (level === "ad") {
      key = String(r.adGroupAd?.ad?.id ?? "unknown");
      const type = r.adGroupAd?.ad?.type ?? null;
      head = {
        ...blank,
        ...campaign,
        id: key,
        name: googleAdName(r.adGroupAd?.ad?.name, type, key),
        adGroupId: id(r.adGroup?.id),
        adGroupName: r.adGroup?.name ?? null,
        adType: type,
        status: r.adGroupAd?.status ?? null,
      };
    } else if (level === "keyword") {
      const k = r.adGroupCriterion;
      const criterion = id(k?.criterionId) ?? "unknown";
      key = `${id(r.adGroup?.id) ?? "unknown"}~${criterion}`;
      head = {
        ...blank,
        ...campaign,
        id: key,
        name: k?.keyword?.text || `Keyword ${criterion}`,
        adGroupId: id(r.adGroup?.id),
        adGroupName: r.adGroup?.name ?? null,
        status: k?.status ?? null,
        matchType: k?.keyword?.matchType ?? null,
        qualityScore: qualityScoreOf(k?.qualityInfo?.qualityScore),
      };
    } else if (level === "search_term") {
      const term = r.campaignSearchTermView?.searchTerm ?? "";
      key = `${id(r.campaign?.id) ?? "unknown"}~${term}`;
      // The view has no status of its own (search_term_view's added/excluded is per ad group).
      head = { ...blank, ...campaign, id: key, name: term || "Unknown search term", channel: r.campaign?.advertisingChannelType ?? null };
    } else if (level === "device") {
      key = r.segments?.device ?? "UNKNOWN";
      head = { ...blank, id: key, name: GOOGLE_DEVICE[key] ?? key };
    } else if (level === "country") {
      const geo = String(r.userLocationView?.countryCriterionId ?? "");
      const code = countries.get(geo) ?? null;
      key = geo || "unknown";
      head = { ...blank, id: key, name: code ? countryName(code) : geo ? `Location ${geo}` : "Unknown" };
    } else {
      // Every level has its own branch: a new one must never be read as another's rows.
      const unknown: never = level;
      throw new Error(`No rows for Google Ads report level ${String(unknown)}`);
    }
    const g = groups.get(key) ?? { row: head, sums: { costMicros: 0, impressions: 0, clicks: 0, conversions: 0, conversionsValue: 0 } };
    const m = r.metrics ?? {};
    g.sums.costMicros = n0(g.sums.costMicros) + n0(m.costMicros);
    g.sums.impressions = n0(g.sums.impressions) + n0(m.impressions);
    g.sums.clicks = n0(g.sums.clicks) + n0(m.clicks);
    g.sums.conversions = n0(g.sums.conversions) + n0(m.conversions);
    g.sums.conversionsValue = n0(g.sums.conversionsValue) + n0(m.conversionsValue);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g.row, ...googleReportMetrics(g.sums) }))
    .sort((a, b) => b.spend - a.spend || b.impressions - a.impressions || a.name.localeCompare(b.name));
}

/** Every row's metrics added up as Google reports them (money in micros), the ratios worked out from the sums. */
export function googleReportTotals(rows: GoogleReportApiRow[]): GoogleReportMetrics {
  const s = { costMicros: 0, impressions: 0, clicks: 0, conversions: 0, conversionsValue: 0 };
  for (const r of rows) {
    const m = r.metrics ?? {};
    s.costMicros += n0(m.costMicros);
    s.impressions += n0(m.impressions);
    s.clicks += n0(m.clicks);
    s.conversions += n0(m.conversions);
    s.conversionsValue += n0(m.conversionsValue);
  }
  return googleReportMetrics(s);
}

/** Google shows customer ids as 123-456-7890; the API wants the digits. */
export const googleCustomerId = (id: string) => id.replace(/[^\d]/g, "");
/** Meta ad account ids are "act_<digits>" in the API. */
export const metaAccountId = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

// ---------------------------------------------------------------------------
// AdSense: what the store's site earns from Google ads shown on its pages.
// ---------------------------------------------------------------------------

/** One site on one day, as stored (adsense_daily). */
export interface AdsenseDayRow {
  accountId: string;
  /** The host the ads were shown on (AdSense's DOMAIN_CODE); "" when the report isn't split by site. */
  site: string;
  /** The AdSense account's own calendar day. */
  day: string;
  /** Estimated earnings: AdSense finalizes them after the month ends. */
  earnings: number;
  pageViews: number;
  /** AdSense's IMPRESSIONS: ad requests where at least one ad was shown (not each ad shown). */
  impressions: number;
  clicks: number;
}

export interface AdsenseTotals {
  earnings: number;
  pageViews: number;
  impressions: number;
  clicks: number;
  /** Earnings per thousand page views ("page RPM"). */
  pageRpm: number | null;
  /** Earnings per click. */
  perClick: number | null;
  /** Clicks per impression (AdSense's impression CTR). */
  ctr: number | null;
}

export function adsenseTotals(rows: AdsenseDayRow[]): AdsenseTotals {
  const t = rows.reduce(
    (a, r) => {
      a.earnings += r.earnings;
      a.pageViews += r.pageViews;
      a.impressions += r.impressions;
      a.clicks += r.clicks;
      return a;
    },
    { earnings: 0, pageViews: 0, impressions: 0, clicks: 0 },
  );
  const earnings = r2(t.earnings);
  const rpm = ratio(earnings * 1000, t.pageViews);
  const perClick = ratio(earnings, t.clicks);
  return {
    earnings,
    pageViews: t.pageViews,
    impressions: t.impressions,
    clicks: t.clicks,
    pageRpm: rpm === null ? null : r2(rpm),
    perClick: perClick === null ? null : r2(perClick),
    ctr: ratio(t.clicks, t.impressions),
  };
}

/** One day of the AdSense chart: every figure null on a day a counted account has no figures for. */
export interface AdsenseSeriesDay {
  day: string;
  earnings: number | null;
  pageViews: number | null;
  impressions: number | null;
  clicks: number | null;
}

/**
 * One point per day of the range: a covered day without earnings is a real 0, a day outside
 * `coverage` is missing (null). Without a coverage every day counts as covered.
 */
export function adsenseSeries(rows: AdsenseDayRow[], range: { from: string; to: string }, coverage?: AdCoverage): AdsenseSeriesDay[] {
  const by = new Map<string, { earnings: number; pageViews: number; impressions: number; clicks: number }>();
  for (const r of rows) {
    const d = by.get(r.day) ?? { earnings: 0, pageViews: 0, impressions: 0, clicks: 0 };
    d.earnings += r.earnings;
    d.pageViews += r.pageViews;
    d.impressions += r.impressions;
    d.clicks += r.clicks;
    by.set(r.day, d);
  }
  return eachDay(range.from, range.to).map((day) => {
    if (coverage && !coversDays(coverage, { from: day, to: day })) return { day, earnings: null, pageViews: null, impressions: null, clicks: null };
    const d = by.get(day);
    return { day, earnings: r2(d?.earnings ?? 0), pageViews: d?.pageViews ?? 0, impressions: d?.impressions ?? 0, clicks: d?.clicks ?? 0 };
  });
}

/**
 * Whether an AdSense row's site belongs to the store: the connection's chosen sites
 * (ad_connections.sites, AdSense's DOMAIN_CODE values), or every site when none are chosen.
 */
export function adsenseSiteChosen(sites: readonly string[], site: string): boolean {
  if (!sites.length) return true;
  const s = site.trim().toLowerCase();
  return sites.some((x) => x.trim().toLowerCase() === s);
}

/** Totals per site, biggest earner first. */
export function siteTotals(rows: AdsenseDayRow[], limit = 10) {
  const by = new Map<string, AdsenseDayRow[]>();
  for (const r of rows) {
    const list = by.get(r.site) ?? [];
    list.push(r);
    by.set(r.site, list);
  }
  return [...by.entries()]
    .map(([site, list]) => ({ site, ...adsenseTotals(list) }))
    .sort((a, b) => b.earnings - a.earnings || b.pageViews - a.pageViews)
    .slice(0, limit);
}

/** The parts of an AdSense reports:generate result (v2 ReportResult) read here. */
export interface AdsenseReport {
  headers?: Array<{ name?: string; type?: string; currencyCode?: string }>;
  rows?: Array<{ cells?: Array<{ value?: string }> }>;
  /** The whole report's totals: a row like the others, its dimension cells empty. */
  totals?: { cells?: Array<{ value?: string }> };
}

/**
 * The rows of a report by DATE (and DOMAIN_CODE, when it was split by site), and the currency its
 * money is in. Columns are found by name, so their order doesn't matter.
 */
export function fromAdsenseReport(accountId: string, report: AdsenseReport): { rows: AdsenseDayRow[]; currency: string | null } {
  const headers = report.headers ?? [];
  const col = (name: string) => headers.findIndex((h) => h.name === name);
  const at = { day: col("DATE"), site: col("DOMAIN_CODE"), earnings: col("ESTIMATED_EARNINGS"), pageViews: col("PAGE_VIEWS"), impressions: col("IMPRESSIONS"), clicks: col("CLICKS") };
  const num = (cells: Array<{ value?: string }>, i: number) => (i < 0 ? 0 : Number(cells[i]?.value ?? 0) || 0);
  const rows: AdsenseDayRow[] = [];
  for (const r of report.rows ?? []) {
    const cells = r.cells ?? [];
    const day = at.day < 0 ? undefined : cells[at.day]?.value;
    if (!isDay(day)) continue;
    rows.push({
      accountId,
      site: at.site < 0 ? "" : (cells[at.site]?.value ?? ""),
      day,
      earnings: r2(num(cells, at.earnings)),
      pageViews: Math.round(num(cells, at.pageViews)),
      impressions: Math.round(num(cells, at.impressions)),
      clicks: Math.round(num(cells, at.clicks)),
    });
  }
  return { rows, currency: headers.find((h) => h.type === "METRIC_CURRENCY")?.currencyCode ?? null };
}

/** AdSense names accounts "accounts/pub-<digits>"; the publisher id is the part after the slash. */
export const adsenseAccountId = (name: string) => name.replace(/^accounts\//, "");

/**
 * Up to this day of a month, the daily re-check reads the whole month before again (recheckDays in
 * packages/core/src/adConnections/sync.ts): AdSense finalizes a month's estimated earnings in the
 * first days of the next.
 */
export const ADSENSE_FINALIZED_BY_DAY = 10;

/**
 * The last day of AdSense figures read on `readOn` (the account's own day) that are final rather
 * than AdSense's estimate: every month that ended before the month before `readOn`'s, and that month
 * too once `readOn` is past the 10th, when the re-reads of its first ten days have all had their turn.
 * Null: nothing read yet. For stored days, `readOn` is the day of the last sync that worked
 * (lastSyncedAt): the figures stay as they were then, so an account whose syncs stopped is final
 * only as far as it was when it last synced.
 */
export function adsenseFinalThrough(readOn: string | null): string | null {
  if (!isDay(readOn)) return null;
  const [y, m, d] = readOn.split("-").map(Number) as [number, number, number];
  // The first of the month whose day before is the last one final: readOn's month, or by the 10th the one before.
  const month = d > ADSENSE_FINALIZED_BY_DAY ? m : m - 1;
  const first = month >= 1 ? `${y}-${String(month).padStart(2, "0")}-01` : `${y - 1}-12-01`;
  return addDays(first, -1);
}

// ---------------------------------------------------------------------------
// The AdSense report: one date range at a time, asked of AdSense directly, by site, country, device
// type (AdSense's PLATFORM_TYPE: desktop, high-end mobile, tablet...) or ad unit. Besides the stored
// days' figures it gives three of AdSense's own that are never stored: ad requests, their coverage
// and Active View viewability.
// ---------------------------------------------------------------------------

export const ADSENSE_REPORT_LEVELS = ["site", "country", "platform", "ad_unit"] as const;
export type AdsenseReportLevel = (typeof ADSENSE_REPORT_LEVELS)[number];

/**
 * The AdSense dimensions each level is split by (reports:generate `dimensions`): an id, then a name
 * when AdSense has one. AD_UNIT_ID is AdSense's reporting id of the ad unit, AD_UNIT_NAME the name it
 * was given in AdSense (https://developers.google.com/adsense/management/reference/rest/v2/Dimension).
 */
export const ADSENSE_REPORT_DIMENSIONS: Record<AdsenseReportLevel, string[]> = {
  site: ["DOMAIN_CODE"],
  country: ["COUNTRY_CODE", "COUNTRY_NAME"],
  platform: ["PLATFORM_TYPE_CODE", "PLATFORM_TYPE_NAME"],
  ad_unit: ["AD_UNIT_ID", "AD_UNIT_NAME"],
};

/**
 * The stored days' measures (the sync reads the same), which every report has. Earnings are estimated
 * until AdSense finalizes the month (adsenseFinalThrough).
 */
export const ADSENSE_REPORT_DAY_METRICS = ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS"] as const;

/**
 * The three metrics only the report reads, never stored. AD_REQUESTS: ad units that asked for ads (one
 * request can show none, one or several); AD_REQUESTS_COVERAGE: the share of them that got an ad back;
 * ACTIVE_VIEW_VIEWABILITY: the share of the impressions Active View could measure that were viewable.
 * The last two are ratios (0 to 1). Google's reference doesn't say which dimensions they go with, so a
 * report AdSense refuses with them is read again without them (adsenseReport in packages/core).
 */
export const ADSENSE_REPORT_EXTRA_METRICS = ["AD_REQUESTS", "AD_REQUESTS_COVERAGE", "ACTIVE_VIEW_VIEWABILITY"] as const;

/**
 * The metrics the report asks for (https://developers.google.com/adsense/management/reference/rest/v2/Metric):
 * the stored days' measures, then the three only it reads.
 */
export const ADSENSE_REPORT_METRICS = [...ADSENSE_REPORT_DAY_METRICS, ...ADSENSE_REPORT_EXTRA_METRICS] as const;

/** A report's figures: the stored days' measures and the three only the live report gives (null: AdSense didn't send that column, or there is nothing to work it out on). */
export interface AdsenseReportTotals extends AdsenseTotals {
  adRequests: number | null;
  /** Ad requests that got an ad back ÷ ad requests. */
  coverage: number | null;
  /** Viewable impressions ÷ the impressions Active View could measure. */
  viewability: number | null;
}

export interface AdsenseReportRow extends AdsenseReportTotals {
  id: string;
  name: string;
}

/** The columns of a report's metrics, by name (-1: not in the report). */
function metricColumns(report: AdsenseReport) {
  const headers = report.headers ?? [];
  const col = (name: string) => headers.findIndex((h) => h.name === name);
  return {
    earnings: col("ESTIMATED_EARNINGS"),
    pageViews: col("PAGE_VIEWS"),
    impressions: col("IMPRESSIONS"),
    clicks: col("CLICKS"),
    adRequests: col("AD_REQUESTS"),
    coverage: col("AD_REQUESTS_COVERAGE"),
    viewability: col("ACTIVE_VIEW_VIEWABILITY"),
  };
}

/** One row's (or the totals row's) figures; a ratio AdSense left empty is unknown, never 0. */
function readMetrics(cells: Array<{ value?: string }>, at: ReturnType<typeof metricColumns>) {
  const num = (i: number) => (i < 0 ? 0 : Number(cells[i]?.value ?? 0) || 0);
  const known = (i: number) => {
    const v = i < 0 ? undefined : cells[i]?.value;
    const n = v === undefined || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    earnings: num(at.earnings),
    pageViews: Math.round(num(at.pageViews)),
    impressions: Math.round(num(at.impressions)),
    clicks: Math.round(num(at.clicks)),
    adRequests: at.adRequests < 0 ? null : Math.round(num(at.adRequests)),
    coverage: known(at.coverage),
    viewability: known(at.viewability),
  };
}
type ReportMetrics = ReturnType<typeof readMetrics>;

/**
 * Rows' figures added up. Ad requests add; coverage is worked back to the requests that got an ad
 * (coverage × requests, exactly what AdSense divided) and divided again; viewability can't be, since
 * the impressions Active View measured aren't read, so it is known only for a single row.
 */
function reportTotals(list: readonly ReportMetrics[]): AdsenseReportTotals {
  const base = adsenseTotals(list.map((r) => ({ accountId: "", site: "", day: "", earnings: r.earnings, pageViews: r.pageViews, impressions: r.impressions, clicks: r.clicks })));
  const requests = list.length && list.every((r) => r.adRequests !== null) ? list.reduce((s, r) => s + r.adRequests!, 0) : null;
  const matched = requests !== null && list.every((r) => r.coverage !== null) ? list.reduce((s, r) => s + r.coverage! * r.adRequests!, 0) : null;
  return {
    ...base,
    adRequests: requests,
    coverage: list.length === 1 ? list[0]!.coverage : matched === null || requests === null ? null : ratio(matched, requests),
    viewability: list.length === 1 ? list[0]!.viewability : null,
  };
}

/**
 * A report's totals: AdSense's own totals row when it sent one (it covers every matched row, also the
 * ones a cut-off report leaves out, and its ratios are AdSense's over all of them), else `rows` added up.
 */
export function adsenseReportTotals(report: AdsenseReport, rows: readonly AdsenseReportTotals[]): AdsenseReportTotals {
  const at = metricColumns(report);
  const cells = report.totals?.cells;
  if (cells && at.earnings >= 0) return reportTotals([readMetrics(cells, at)]);
  return reportTotals(rows);
}

/** A report split by one level → its rows, biggest earner first, and the currency its money is in. */
export function adsenseReportRows(level: AdsenseReportLevel, report: AdsenseReport): { rows: AdsenseReportRow[]; currency: string | null } {
  const headers = report.headers ?? [];
  const col = (name: string) => headers.findIndex((h) => h.name === name);
  const [idDim, nameDim] = ADSENSE_REPORT_DIMENSIONS[level];
  const at = { id: col(idDim!), name: nameDim ? col(nameDim) : -1 };
  const metrics = metricColumns(report);
  const groups = new Map<string, { name: string; rows: ReportMetrics[] }>();
  for (const r of report.rows ?? []) {
    const cells = r.cells ?? [];
    const id = (at.id < 0 ? "" : cells[at.id]?.value) || "unknown";
    const label = at.name >= 0 ? cells[at.name]?.value : undefined;
    const name = label || (level === "country" ? countryName(id === "unknown" ? null : id) : id === "unknown" ? "Unknown" : id);
    const g = groups.get(id) ?? { name, rows: [] };
    g.rows.push(readMetrics(cells, metrics));
    groups.set(id, g);
  }
  const rows = [...groups.entries()]
    .map(([id, g]) => ({ id, name: g.name, ...reportTotals(g.rows) }))
    .sort((a, b) => b.earnings - a.earnings || b.pageViews - a.pageViews || a.name.localeCompare(b.name));
  return { rows, currency: headers.find((h) => h.type === "METRIC_CURRENCY")?.currencyCode ?? null };
}
