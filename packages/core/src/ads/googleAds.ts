/**
 * Google Ads API: the accounts a login reaches (directly or under a manager account), daily numbers
 * per campaign, and the report by campaign, ad group, device or country. Read-only GAQL.
 */
import {
  fromGoogleAdsRow,
  googleCustomerId,
  googleReportMetrics,
  googleReportRows,
  isDay,
  type AdDayRow,
  type GoogleAdsRow,
  type GoogleReportApiRow,
  type GoogleReportLevel,
  type GoogleReportMetrics,
  type GoogleReportRow,
} from "@app/shared";
import { AdsApiError, AdsAuthError, AdsNoAccountsError, AdsNotApprovedError, AdsRetryableError, REQUIRED_AD_SCOPE, type AdAccount } from "./common.js";
import { googleConsentUrl, type GoogleOAuthClient } from "./googleOAuth.js";

/**
 * Google Ads API access follows the Cloud project that owns the OAuth client (Google retired developer
 * tokens on 2026-09-09), so the client and an API version are all a call needs.
 */
export interface GoogleConfig extends GoogleOAuthClient {
  /** Google Ads API version, e.g. "v25". */
  version: string;
}

export const GOOGLE_ADS_SCOPE = REQUIRED_AD_SCOPE.google;

export function googleAuthorizeUrl(c: GoogleConfig, redirectUri: string, state: string, codeChallenge?: string): string {
  return googleConsentUrl(c, GOOGLE_ADS_SCOPE, redirectUri, state, codeChallenge);
}

async function googleAds<T>(c: GoogleConfig, accessToken: string, path: string, init: { method: "GET" | "POST"; body?: unknown; loginCustomerId?: string | null }): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.loginCustomerId) headers["login-customer-id"] = googleCustomerId(init.loginCustomerId);
  const res = await (c.fetchImpl ?? fetch)(`https://googleads.googleapis.com/${c.version}/${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  type GoogleError = { message?: string; status?: string; details?: unknown };
  const body = (await res.json().catch(() => ({}))) as T & { error?: GoogleError };
  const err = Array.isArray(body) ? (body[0] as { error?: GoogleError })?.error : (body as { error?: GoogleError }).error;
  if (res.ok && !err) return body;
  const msg = err?.message ?? `Google Ads returned ${res.status}`;
  // A Google login with no Google Ads account answers NOT_ADS_USER: that's "no accounts", not ended access.
  if (/NOT_ADS_USER/.test(JSON.stringify(err?.details ?? ""))) throw new AdsNoAccountsError(msg);
  if (res.status === 401 || err?.status === "UNAUTHENTICATED") throw new AdsAuthError(msg);
  // The project's access level doesn't cover production accounts (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION
  // and its kin): bizinsights' own approval, not the merchant's account.
  if (/NOT_APPROVED/.test(JSON.stringify(err?.details ?? "")) || /not approved for production/i.test(msg)) throw new AdsNotApprovedError(msg);
  if (res.status === 429 || res.status >= 500 || err?.status === "RESOURCE_EXHAUSTED" || err?.status === "UNAVAILABLE") throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

type SearchStream<R> = Array<{ results?: R[] }>;

async function googleSearch<R>(c: GoogleConfig, accessToken: string, customerId: string, query: string, loginCustomerId?: string | null): Promise<R[]> {
  const batches = await googleAds<SearchStream<R>>(c, accessToken, `customers/${googleCustomerId(customerId)}/googleAds:searchStream`, { method: "POST", body: { query }, loginCustomerId });
  return batches.flatMap((b) => b.results ?? []);
}

interface CustomerRow {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean };
}
interface CustomerClientRow {
  customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string };
}

/**
 * Every ad account the person can report on: the ones they reach directly, and the clients of
 * any manager account they reach (which need the manager's id on every call). Never empty: with
 * nothing to connect it throws AdsNoAccountsError, saying why, so the person is told what to do.
 */
export async function googleAdAccounts(c: GoogleConfig, accessToken: string): Promise<AdAccount[]> {
  const list = await googleAds<{ resourceNames?: string[] }>(c, accessToken, "customers:listAccessibleCustomers", { method: "GET" });
  const ids = (list.resourceNames ?? []).map((r) => r.split("/").pop()!).filter(Boolean);
  if (!ids.length) throw new AdsNoAccountsError("This Google login has no Google Ads account");
  const out = new Map<string, AdAccount>();
  const unreadable: string[] = [];
  for (const id of ids) {
    let me: CustomerRow["customer"];
    try {
      me = (await googleSearch<CustomerRow>(c, accessToken, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer"))[0]?.customer;
    } catch (err) {
      // A cancelled, suspended or half-set-up account in the list: skip it rather than fail the connection.
      if (err instanceof AdsApiError && !(err instanceof AdsNotApprovedError)) {
        unreadable.push(`${id}: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (!me) {
      unreadable.push(`${id}: no account details`);
      continue;
    }
    if (!me.manager) {
      out.set(id, { accountId: id, name: me.descriptiveName ?? null, currency: me.currencyCode ?? null, timezone: me.timeZone ?? null, loginCustomerId: null });
      continue;
    }
    const clients = await googleSearch<CustomerClientRow>(
      c,
      accessToken,
      id,
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'",
      id,
    ).catch((err) => {
      if (err instanceof AdsApiError && !(err instanceof AdsNotApprovedError)) return [] as CustomerClientRow[];
      throw err;
    });
    for (const cl of clients) {
      const cid = cl.customerClient?.id ? String(cl.customerClient.id) : null;
      if (!cid || out.has(cid)) continue;
      out.set(cid, { accountId: cid, name: cl.customerClient?.descriptiveName ?? null, currency: cl.customerClient?.currencyCode ?? null, timezone: cl.customerClient?.timeZone ?? null, loginCustomerId: id });
    }
  }
  if (out.size) return [...out.values()];
  // Accounts exist but none can be read: unfinished or closed accounts first, since they're the person's own.
  if (unreadable.length) throw new AdsNoAccountsError(`Google Ads won't report on ${unreadable.join("; ")}`, "not_ready");
  throw new AdsNoAccountsError(`Only manager accounts with no active ad account under them: ${ids.join(", ")}`, "manager_only");
}

/** Cost, impressions, clicks, conversions and their value per campaign per day. */
export async function googleCampaignDays(c: GoogleConfig, accessToken: string, account: { accountId: string; loginCustomerId?: string | null }, since: string, until: string): Promise<AdDayRow[]> {
  // The days go into the query text: only ever real YYYY-MM-DD days.
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const rows = await googleSearch<GoogleAdsRow>(
    c,
    accessToken,
    account.accountId,
    `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`,
    account.loginCustomerId,
  );
  return rows.map((r) => fromGoogleAdsRow(googleCustomerId(account.accountId), r)).filter((r): r is AdDayRow => r !== null);
}

export interface GoogleReport {
  level: GoogleReportLevel;
  since: string;
  until: string;
  /** The whole account's totals for the range. */
  totals: GoogleReportMetrics;
  /** Biggest spend first. */
  rows: GoogleReportRow[];
  /** More rows had spend than are listed. */
  truncated: boolean;
}

const GOOGLE_METRICS = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value";

/** The query for each level. Without segments.date in SELECT, Google sums the metrics over the range. */
function googleReportQuery(level: GoogleReportLevel, since: string, until: string): string {
  const during = `segments.date BETWEEN '${since}' AND '${until}'`;
  switch (level) {
    case "campaign":
      return `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, ${GOOGLE_METRICS} FROM campaign WHERE ${during}`;
    case "ad_group":
      return `SELECT campaign.name, ad_group.id, ad_group.name, ad_group.status, ${GOOGLE_METRICS} FROM ad_group WHERE ${during}`;
    case "device":
      return `SELECT segments.device, ${GOOGLE_METRICS} FROM customer WHERE ${during}`;
    case "country":
      // Where the people who saw the ads were (not the places targeted).
      return `SELECT user_location_view.country_criterion_id, ${GOOGLE_METRICS} FROM user_location_view WHERE ${during}`;
  }
}

/** Geo target ids (2840) → ISO country codes (US), so countries can be named. */
async function googleCountryCodes(c: GoogleConfig, accessToken: string, account: { accountId: string; loginCustomerId?: string | null }, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = [...new Set(ids)].filter((id) => /^\d{1,12}$/.test(id));
  for (let i = 0; i < valid.length; i += 200) {
    const names = valid.slice(i, i + 200).map((id) => `'geoTargetConstants/${id}'`).join(", ");
    const rows = await googleSearch<{ geoTargetConstant?: { id?: string | number; countryCode?: string } }>(
      c,
      accessToken,
      account.accountId,
      `SELECT geo_target_constant.id, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${names})`,
      account.loginCustomerId,
    );
    for (const r of rows) if (r.geoTargetConstant?.id && r.geoTargetConstant.countryCode) out.set(String(r.geoTargetConstant.id), r.geoTargetConstant.countryCode);
  }
  return out;
}

/**
 * The Google Ads report for one account and range, by campaign, ad group, device or country, plus
 * the account's own totals. Read-only GAQL; dates are validated before they go into the query.
 */
export async function googleReport(
  c: GoogleConfig,
  accessToken: string,
  account: { accountId: string; loginCustomerId?: string | null },
  level: GoogleReportLevel,
  since: string,
  until: string,
  maxRows = 200,
): Promise<GoogleReport> {
  if (!isDay(since) || !isDay(until)) throw new AdsApiError(`Invalid date range ${since}..${until}`, 400);
  const [totalRows, raw] = await Promise.all([
    googleSearch<GoogleReportApiRow>(c, accessToken, account.accountId, `SELECT ${GOOGLE_METRICS} FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`, account.loginCustomerId),
    googleSearch<GoogleReportApiRow>(c, accessToken, account.accountId, googleReportQuery(level, since, until), account.loginCustomerId),
  ]);
  let countries = new Map<string, string>();
  if (level === "country") {
    // A name that can't be looked up leaves the row as "Location <id>", not the report broken.
    countries = await googleCountryCodes(c, accessToken, account, raw.map((r) => String(r.userLocationView?.countryCriterionId ?? ""))).catch((err: unknown) => {
      if (err instanceof AdsApiError) return new Map<string, string>();
      throw err;
    });
  }
  const all = googleReportRows(level, raw, countries);
  const rows = all.slice(0, maxRows);
  const totals = googleReportRows("device", totalRows.map((r) => ({ ...r, segments: { device: "ALL" } })))[0];
  return { level, since, until, totals: totals ?? googleReportMetrics({}), rows, truncated: all.length > rows.length };
}
