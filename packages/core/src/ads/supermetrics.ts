/**
 * Supermetrics (https://docs.supermetrics.com/apidocs; docs/supermetrics.md): a second way to read a
 * merchant's Meta Ads, Google Ads and AdSense figures, next to bizinsights' own sign-ins with the
 * platforms. bizinsights holds one Supermetrics team and its API key (a secret, server side only). A
 * merchant connects by signing in to the platform on Supermetrics' own page, reached through a data
 * source login link this team creates for them (Management API, POST /ds/login/link); the login that
 * results belongs to the team, and bizinsights queries it (Data API, /query/data/json) for that
 * merchant's accounts only, naming the login's username (ds_user) and the account (ds_accounts) on
 * every query.
 *
 * What comes back is turned into the same row shapes the platforms' own APIs give (MetaInsightRow,
 * GoogleAdsRow, an AdSense report), so the figures are worked out by the same functions whichever way
 * they were read (@app/shared/ads): a purchase, a link click or an earning means the same thing on the
 * dashboard either way. The fields are Supermetrics' documented ones (docs.supermetrics.com/docs/
 * facebook-ads-fields, google-ads-fields, google-adsense-fields); where they differ from what the
 * platform's own API reports, docs/supermetrics.md says how.
 *
 * Read-only: nothing here creates, changes or pauses anything at a platform. Every function takes its
 * key and a fetch implementation as arguments, so tests run against fakes and nothing here reads the
 * environment.
 */
import {
  adsenseTotals,
  countryName,
  fromAdsenseReport,
  fromGoogleAdsRow,
  fromMetaBreakdownInsight,
  fromMetaInsight,
  fromMetaRangeInsight,
  googleCustomerId,
  googleReportMetrics,
  googleReportRows,
  isDay,
  isMetaBreakdown,
  metaAccountId,
  metaReportMetrics,
  withGooglePurchases,
  type AdAccountStatus,
  type AdDayRow,
  type AdProvider,
  type AdsenseDayRow,
  type AdsenseReport,
  type AdsenseReportLevel,
  type AdsenseReportRow,
  type AdsenseTotals,
  type GoogleAdsRow,
  type GooglePurchaseRow,
  type GoogleReportApiRow,
  type GoogleReportLevel,
  type MetaInsightRow,
  type MetaObjectDetails,
  type MetaRangeInsight,
  type MetaReportLevel,
  type MetaReportView,
} from "@app/shared";
import type { FetchLike } from "../shopify.js";
import {
  AD_ACCOUNT_LIST_MAX_BYTES,
  AD_DISCOVERY_BUDGET_MS,
  adAccountListWithin,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsReportPendingError,
  AdsRetryableError,
  type AdAccount,
  type AdAccountHealth,
  type AdAccountList,
} from "./common.js";
import { withMetaOtherCampaigns, type MetaReport } from "./meta.js";
import type { GoogleReport } from "./googleAds.js";

export interface SupermetricsConfig {
  /** The team's API key (Authorization: Bearer). */
  apiKey: string;
  /** https://api.supermetrics.com: the Data and Management APIs share it. */
  baseUrl: string;
  fetchImpl?: FetchLike;
}

/** Supermetrics' data source for each platform (https://docs.supermetrics.com/apidocs/data-sources). */
export const SUPERMETRICS_DS: Record<AdProvider, string> = { meta: "FA", google: "AW", adsense: "ADM" };

/** What a Supermetrics connection reads with: the login's data source username and the account as Supermetrics names it. */
export interface SupermetricsCredential {
  /** The login's username, sent as ds_user so only that login's access is used. */
  dsUser: string;
  /** The account's id as Supermetrics lists it (ds_accounts). */
  dsAccount: string;
  /** AdSense: earnings in the account's own currency ("account") or Supermetrics' US dollars ("usd", the default); see admMoney. */
  adsenseCurrency?: "account" | "usd";
}

// ---------------------------------------------------------------------------
// HTTP and errors
// ---------------------------------------------------------------------------

/** The error object of every Supermetrics error answer ({ meta, error: { code, message, description } }). */
interface SupermetricsErrorBody {
  code?: string;
  message?: string;
  description?: string;
}

/** Retry-After in whole seconds, when Supermetrics sent one. */
function retryAfter(headers: Headers | null | undefined): number | null {
  const v = headers?.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s > 0) return Math.ceil(s);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - Date.now()) / 1000)) : null;
}

/**
 * A Supermetrics failure sorted the way every ad platform's is (ads/common.ts), from its error code
 * (https://docs.supermetrics.com/apidocs/errors), never its message: the code is what Supermetrics keeps
 * stable. The key refused, a licence that doesn't cover the request, or a query bizinsights built wrong
 * are ours to fix ("not_configured", alerted to the operator, never blamed on the merchant). The
 * platform login ended or failed means connecting again. An account the login can no longer read is
 * "no access". Throttling, the team's daily query allowance and outages are retried.
 */
export function supermetricsError(httpStatus: number, error: SupermetricsErrorBody | null | undefined, retryAfterS: number | null = null): Error {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = `Supermetrics ${code || httpStatus}${error?.message ? `: ${error.message}` : ""}`;
  const err = (() => {
    if (code === "LICENSE_DAILY_QUERY_LIMIT_EXCEEDED") return new AdsRateLimitedError(message, retryAfterS, "quota_exhausted", httpStatus);
    if (code.startsWith("LICENSE_") || code.startsWith("API_KEY_") || code.startsWith("ACCESS_DENIED_") || code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "PERMISSION_ERROR") {
      return new AdsApiError(message, httpStatus || 403, undefined, "not_configured");
    }
    if (code === "QUERY_AUTH_EXPIRED" || code === "QUERY_AUTH_LOGIN_FAILED" || code === "QUERY_AUTH_NOT_FOUND" || code === "QUERY_AUTH_UNAVAILABLE" || code === "QUERY_AUTH_FAILURE") {
      return new AdsAuthError(message);
    }
    if (code === "QUERY_ACCOUNT_INVALID" || code === "QUERY_ACCOUNT_UNAVAILABLE" || code === "ACCOUNT_FILTER_MATCHLESS") return new AdsPermissionError(message);
    if (code === "QUERY_API_RATE_LIMITED" || code === "TOO_MANY_REQUESTS" || httpStatus === 429) return new AdsRateLimitedError(message, retryAfterS, "rate_limited", httpStatus);
    if (code === "STATUS_NOT_FOUND" || code === "WORKFLOW_LISTENER_LIMIT_EXCEEDED" || code === "QUERY_ERROR" || code === "LOCK_TASK_NOT_FOUND" || code === "SERVICE_UNAVAILABLE" || httpStatus >= 500) {
      return new AdsRetryableError(message, httpStatus);
    }
    // A request bizinsights built (a field, a setting, a date): Supermetrics refusing it is a bug of ours.
    if (httpStatus === 400 || httpStatus === 422 || code.endsWith("_INVALID") || code.endsWith("_REQUIRED") || code.startsWith("FIELD")) {
      return new AdsApiError(message, httpStatus || 400, undefined, "not_configured");
    }
    return new AdsApiError(message, httpStatus || 502);
  })();
  (err as { providerCode?: string }).providerCode = code || undefined;
  return err;
}

/** Thrown for a 404 on a login or link: it no longer exists at Supermetrics. */
class SupermetricsNotFound extends AdsApiError {
  constructor(message: string) {
    super(message, 404, undefined, "provider_error");
  }
}

async function smRequest<T>(c: SupermetricsConfig, method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: { query?: Record<string, string>; body?: unknown; fetchImpl?: FetchLike } = {}): Promise<T> {
  const query = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
  const res = await (opts.fetchImpl ?? c.fetchImpl ?? fetch)(`${c.baseUrl.replace(/\/+$/, "")}${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${c.apiKey}`,
      accept: "application/json",
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: SupermetricsErrorBody };
  if (res.ok && !body.error) return body;
  if (res.status === 404 && (!body.error?.code || body.error.code === "NOT_FOUND")) throw new SupermetricsNotFound(`Supermetrics 404 ${path.split("/").slice(0, 3).join("/")}`);
  throw supermetricsError(res.status, body.error, retryAfter(res.headers));
}

// ---------------------------------------------------------------------------
// Login links and logins (Management API)
// ---------------------------------------------------------------------------

export interface SupermetricsLoginLink {
  linkId: string;
  /** OPEN | CLOSED | EXPIRED. */
  status: string;
  /** Where the merchant goes to sign in to the platform (Supermetrics' page). */
  loginUrl: string;
  /** Set once someone authenticated through the link. */
  loginId: string | null;
  loginUsername: string | null;
  dsId: string | null;
  expiresAt: string | null;
}

interface LoginLinkData {
  link_id?: string;
  status_code?: string;
  login_url?: string;
  login_id?: string | null;
  login_username?: string | null;
  ds_id?: string;
  expiry_time?: string;
}

const linkOf = (d: LoginLinkData | undefined): SupermetricsLoginLink => {
  if (!d?.link_id) throw new AdsApiError("Supermetrics didn't return a login link", 502);
  return {
    linkId: d.link_id,
    status: d.status_code ?? "OPEN",
    loginUrl: d.login_url ?? "",
    loginId: d.login_id || null,
    loginUsername: d.login_username || null,
    dsId: d.ds_id ?? null,
    expiresAt: d.expiry_time ?? null,
  };
};

/**
 * A login link for one platform: an anonymous, expiring link to Supermetrics' page where the merchant
 * signs in to the platform, after which Supermetrics sends them to `redirectUrl`. `requireUsername`
 * (reconnecting a login that expired): the platform user who must sign in again. The description is
 * for the team's own list of links (it is never shown to the merchant): no personal data in it.
 */
export async function supermetricsCreateLoginLink(
  c: SupermetricsConfig,
  input: { dsId: string; description: string; expiresAt: Date; redirectUrl: string; requireUsername?: string | null },
): Promise<SupermetricsLoginLink> {
  const res = await smRequest<{ data?: LoginLinkData }>(c, "POST", "/ds/login/link", {
    body: {
      ds_id: input.dsId,
      description: input.description.slice(0, 1000),
      expiry_time: input.expiresAt.toISOString(),
      redirect_url: input.redirectUrl,
      ...(input.requireUsername ? { require_username: input.requireUsername } : {}),
    },
  });
  const link = linkOf(res.data);
  if (!/^https:\/\//.test(link.loginUrl)) throw new AdsApiError("Supermetrics' login link has no usable address", 502);
  return link;
}

/** The link as it stands now: whether someone authenticated through it, and the login that made. */
export async function supermetricsLoginLink(c: SupermetricsConfig, linkId: string): Promise<SupermetricsLoginLink> {
  return linkOf((await smRequest<{ data?: LoginLinkData }>(c, "GET", `/ds/login/link/${encodeURIComponent(linkId)}`)).data);
}

/** Close a link so it can't be used again. Best effort: a link that is closed or gone already is fine. */
export async function supermetricsCloseLoginLink(c: SupermetricsConfig, linkId: string): Promise<void> {
  await smRequest(c, "PUT", `/ds/login/link/${encodeURIComponent(linkId)}/close`).catch((err: unknown) => {
    if (err instanceof SupermetricsNotFound || err instanceof AdsApiError) return;
    throw err;
  });
}

export interface SupermetricsLogin {
  loginId: string;
  /** The login's username at the platform: what queries send as ds_user. */
  username: string;
  displayName: string | null;
  dsId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** Supermetrics can renew it after expiresAt by itself. */
  refreshable: boolean;
}

interface LoginData {
  login_id?: string;
  username?: string;
  display_name?: string;
  ds_info?: { ds_id?: string };
  expiry_time?: string | null;
  revoked_time?: string | null;
  is_refreshable?: boolean;
}

const dateOrNull = (v: string | null | undefined) => {
  const t = v ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : null;
};

/** One login of the team. A login that is gone is an AdsAuthError: only connecting again brings it back. */
export async function supermetricsLogin(c: SupermetricsConfig, loginId: string): Promise<SupermetricsLogin> {
  let d: LoginData | undefined;
  try {
    d = (await smRequest<{ data?: LoginData }>(c, "GET", `/ds/login/${encodeURIComponent(loginId)}`)).data;
  } catch (err) {
    if (err instanceof SupermetricsNotFound) throw new AdsAuthError("The Supermetrics login is gone");
    throw err;
  }
  if (!d?.login_id || !d.username) throw new AdsApiError("Supermetrics didn't describe the login", 502);
  return {
    loginId: d.login_id,
    username: d.username,
    displayName: d.display_name ?? null,
    dsId: d.ds_info?.ds_id ?? null,
    expiresAt: dateOrNull(d.expiry_time),
    revokedAt: dateOrNull(d.revoked_time),
    refreshable: d.is_refreshable === true,
  };
}

/** Whether a login can still be used: not revoked, and not expired unless Supermetrics renews it. */
export function supermetricsLoginUsable(l: Pick<SupermetricsLogin, "expiresAt" | "revokedAt" | "refreshable">, now = new Date()): boolean {
  if (l.revokedAt && l.revokedAt.getTime() <= now.getTime()) return false;
  return !(l.expiresAt && l.expiresAt.getTime() <= now.getTime() && !l.refreshable);
}

/** Revoke one login of the team (its access to the platform ends). "gone": it no longer existed. */
export async function supermetricsRevokeLogin(c: SupermetricsConfig, loginId: string): Promise<"revoked" | "gone"> {
  try {
    await smRequest(c, "DELETE", `/ds/login/${encodeURIComponent(loginId)}`);
    return "revoked";
  } catch (err) {
    if (err instanceof SupermetricsNotFound) return "gone";
    throw err;
  }
}

/**
 * An account id as the rest of bizinsights writes it for the platform, so an account connected through
 * Supermetrics and the same one connected directly are one connection (ad_connections' unique
 * store/platform/account): Meta "act_<digits>", Google Ads the ten digits, AdSense "pub-<digits>".
 */
export function supermetricsAccountId(provider: AdProvider, dsAccount: string): string {
  const id = dsAccount.trim();
  if (provider === "meta") return /^(act_)?\d+$/.test(id) ? metaAccountId(id) : id;
  if (provider === "google") return /^[\d-]+$/.test(id) ? googleCustomerId(id) : id;
  const pub = id.replace(/^accounts\//, "").replace(/^ca-/, "");
  return /^\d+$/.test(pub) ? `pub-${pub}` : pub;
}

/** Pages of a login's accounts read at most (1,000 each). */
const ACCOUNT_PAGES = 10;

/**
 * The accounts one login can report on, as a person picks them: each with its id the way bizinsights
 * writes it (accountId) and the way Supermetrics does (sourceAccountId, sent on queries). Currency and
 * time zone aren't listed; the first sync reads them. Within AD_DISCOVERY_BUDGET_MS and what a pending
 * choice can hold; a list cut short by either is marked `truncated`.
 */
export async function supermetricsLoginAccounts(c: SupermetricsConfig, provider: AdProvider, loginId: string, opts: { budgetMs?: number } = {}): Promise<AdAccountList> {
  const deadline = Date.now() + (opts.budgetMs ?? AD_DISCOVERY_BUDGET_MS);
  type Page = { meta?: { paginate?: { total?: number } }; data?: Array<{ account_id?: string; name?: string; group?: string }> };
  const seen = new Set<string>();
  const out: AdAccount[] = [];
  let truncated = false;
  for (let page = 0; page < ACCOUNT_PAGES; page++) {
    const res = await smRequest<Page>(c, "GET", `/ds/login/${encodeURIComponent(loginId)}/accounts`, { query: { offset: String(page * 1000), limit: "1000" } });
    for (const a of res.data ?? []) {
      const dsAccount = (a.account_id ?? "").trim();
      if (!dsAccount) continue;
      const accountId = supermetricsAccountId(provider, dsAccount);
      if (seen.has(accountId)) continue;
      seen.add(accountId);
      out.push({ accountId, name: a.name?.trim() || null, currency: null, timezone: null, sourceAccountId: dsAccount });
    }
    const total = Number(res.meta?.paginate?.total ?? 0);
    const read = (page + 1) * 1000;
    if (!res.data?.length || !Number.isFinite(total) || read >= total) break;
    if (page === ACCOUNT_PAGES - 1 || Date.now() >= deadline) {
      truncated = true;
      break;
    }
  }
  if (!out.length) throw new AdsNoAccountsError("This login reaches no account Supermetrics can report on");
  return adAccountListWithin(out, truncated, AD_ACCOUNT_LIST_MAX_BYTES);
}

/**
 * Whether the team's licence includes a platform's data source, asked of Supermetrics (Data API
 * /query/accounts, which costs no query): "not_licensed" when it answers with a LICENSE_ error,
 * "unknown" when it can't be told (an outage). Supermetrics has no call that lists a licence's data
 * sources, so this is how a platform the licence doesn't cover is caught before a merchant signs in.
 */
export async function supermetricsSourceLicensed(c: SupermetricsConfig, provider: AdProvider): Promise<"licensed" | "not_licensed" | "unknown"> {
  try {
    await smRequest(c, "GET", "/query/accounts", { query: { ds_id: SUPERMETRICS_DS[provider], cache_minutes: "1440" } });
    return "licensed";
  } catch (err) {
    const code = (err as { providerCode?: string }).providerCode ?? "";
    if (code.startsWith("LICENSE_")) return "not_licensed";
    // The key itself refused: nothing works until it is fixed, whatever the licence says.
    if (err instanceof AdsApiError && err.errorCode === "not_configured") throw err;
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Queries (Data API)
// ---------------------------------------------------------------------------

/** One query: a data source, the login and account it reads, a range of days and the fields asked for. */
export interface SupermetricsQuery {
  dsId: string;
  cred: SupermetricsCredential;
  since: string;
  until: string;
  fields: readonly string[];
  maxRows?: number;
  /** How old a cached answer may be (Supermetrics keeps recent results). */
  cacheMinutes?: number;
  /** Data source settings, on top of no_headers. */
  settings?: Record<string, unknown>;
}

/** A row by the field ids asked for. Values come as Supermetrics sends them (numbers or strings). */
export type SupermetricsRow = Record<string, string | number | null | undefined>;

/** How a query is run. `deadline` (epoch ms): when it must have answered; `stillRunning` is thrown after. */
export interface SupermetricsRunOptions {
  deadline?: number;
  /** Between status checks; grows to five times this. */
  pollMs?: number;
  stillRunning?: () => Error;
}

/** How long a sync's query may take, its status checks included (a queue job has 15 minutes). */
export const SUPERMETRICS_SYNC_BUDGET_MS = 10 * 60_000;
/** How long the API waits for the answer in one call before handing back a status to poll. */
const SYNC_TIMEOUT_S = 20;

interface QueryMeta {
  schedule_id?: string;
  status_code?: string;
  query?: { fields?: Array<{ id?: string; field_id?: string; data_column?: number }> };
}

interface QueryAnswer {
  meta?: QueryMeta;
  data?: unknown[];
  error?: SupermetricsErrorBody;
}

/** The answer's rows keyed by the field ids asked for: by each field's data_column, else in the order asked. */
function rowsOf(answer: QueryAnswer, fields: readonly string[]): SupermetricsRow[] {
  const described = answer.meta?.query?.fields ?? [];
  const column = new Map<string, number>();
  fields.forEach((f, i) => {
    const d = described.find((x) => x.id === f || x.field_id === f);
    column.set(f, typeof d?.data_column === "number" ? d.data_column : i);
  });
  const out: SupermetricsRow[] = [];
  for (const raw of answer.data ?? []) {
    if (!Array.isArray(raw)) continue;
    const row: SupermetricsRow = {};
    for (const f of fields) {
      const v = raw[column.get(f)!] as unknown;
      row[f] = typeof v === "number" || typeof v === "string" ? v : null;
    }
    out.push(row);
  }
  return out;
}

const PENDING = new Set(["SCHEDULED", "QUEUED", "RUNNING"]);

/**
 * Run one query and return its rows. Supermetrics answers within SYNC_TIMEOUT_S when it can; a longer
 * query comes back with a schedule id, whose status is checked (GET /query/status, which carries the
 * rows once it succeeds) until `deadline`. Every row of the range is returned or an error is thrown,
 * never part of them. Sent as a POST body: the login's username never goes into a URL.
 */
export async function supermetricsQuery(c: SupermetricsConfig, q: SupermetricsQuery, opts: SupermetricsRunOptions = {}): Promise<SupermetricsRow[]> {
  if (!isDay(q.since) || !isDay(q.until) || q.since > q.until) throw new AdsApiError(`Invalid date range ${q.since}..${q.until}`, 400);
  const deadline = opts.deadline ?? Date.now() + SUPERMETRICS_SYNC_BUDGET_MS;
  const stillRunning = opts.stillRunning ?? (() => new AdsRetryableError("Supermetrics' query is taking longer than usual"));
  const left = () => deadline - Date.now();
  if (left() <= 0) throw stillRunning();
  let answer = await smRequest<QueryAnswer>(c, "POST", "/query/data/json", {
    body: {
      ds_id: q.dsId,
      ds_user: q.cred.dsUser,
      ds_accounts: [q.cred.dsAccount],
      start_date: q.since,
      end_date: q.until,
      fields: [...q.fields],
      max_rows: q.maxRows ?? 100_000,
      ...(q.cacheMinutes !== undefined ? { cache_minutes: q.cacheMinutes } : {}),
      sync_timeout: Math.max(0, Math.min(SYNC_TIMEOUT_S, Math.floor(left() / 1000) - 5)),
      settings: { no_headers: true, ...q.settings },
    },
  });
  const pollMs = opts.pollMs ?? 2000;
  for (let i = 0; ; i++) {
    const status = answer.meta?.status_code ?? "SUCCESS";
    if (status === "SUCCESS") return rowsOf(answer, q.fields);
    if (!PENDING.has(status)) throw answer.error ? supermetricsError(200, answer.error) : new AdsRetryableError(`Supermetrics' query ended ${status}`);
    const schedule = answer.meta?.schedule_id;
    if (!schedule) throw new AdsRetryableError("Supermetrics' query has no schedule to follow");
    const wait = Math.min(pollMs * Math.min(5, 1 + i), Math.max(0, left() - 2000));
    if (left() <= wait + 2000) throw stillRunning();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    answer = await smRequest<QueryAnswer>(c, "GET", "/query/status", { query: { schedule_id: schedule } });
  }
}

// --- reading values ---

const numOf = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const textOf = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== "(not set)" && s !== "--" ? s : null;
};
const str = (v: string | number | null | undefined): string => String(numOf(v));
const dayOf = (v: string | number | null | undefined): string | null => {
  const s = textOf(v)?.slice(0, 10) ?? null;
  return s && isDay(s) ? s : null;
};
/** The first value a column had in any row (account-wide dimensions: currency, time zone, name). */
const firstText = (rows: SupermetricsRow[], f: string) => rows.map((r) => textOf(r[f])).find((v): v is string => !!v) ?? null;

// ---------------------------------------------------------------------------
// Meta Ads (FA)
// ---------------------------------------------------------------------------

/**
 * The FA fields for spend and results. Purchases are Meta's omni_purchase (Supermetrics'
 * action_omni_purchase and its value, purchase_conversion_value), the first type bizinsights' own Meta
 * reading takes too. Leads are on-Facebook (lead form) leads plus website (pixel) leads, the two parts
 * of Meta's "lead": Supermetrics has no field for the total.
 */
const FA_METRICS = ["cost", "impressions", "Clicks", "inline_link_clicks", "action_omni_purchase", "purchase_conversion_value", "onsite_conversion.lead_grouped", "offsite_conversions_fb_pixel_lead"] as const;
/** Account-wide, the same on every row: read with the account's daily totals. */
const FA_ACCOUNT = ["currency", "timezone_name", "account_status", "profile"] as const;

type FaRow = SupermetricsRow;

/** Supermetrics' FA figures as Meta's own insight fields: spend, clicks and the actions bizinsights reads. */
function faFigures(r: FaRow): Pick<MetaInsightRow, "spend" | "impressions" | "clicks" | "inline_link_clicks" | "actions" | "action_values"> {
  const has = (f: string) => r[f] !== null && r[f] !== undefined && r[f] !== "";
  const actions: Array<{ action_type: string; value: string }> = [];
  const values: Array<{ action_type: string; value: string }> = [];
  if (has("action_omni_purchase")) actions.push({ action_type: "omni_purchase", value: str(r.action_omni_purchase) });
  if (has("purchase_conversion_value")) values.push({ action_type: "omni_purchase", value: str(r.purchase_conversion_value) });
  if (has("onsite_conversion.lead_grouped") || has("offsite_conversions_fb_pixel_lead")) {
    actions.push({ action_type: "lead", value: String(numOf(r["onsite_conversion.lead_grouped"]) + numOf(r.offsite_conversions_fb_pixel_lead)) });
  }
  return {
    spend: str(r.cost),
    impressions: str(r.impressions),
    clicks: str(r.Clicks),
    inline_link_clicks: str(r.inline_link_clicks),
    ...(actions.length ? { actions } : {}),
    ...(values.length ? { action_values: values } : {}),
  };
}

/** Meta's account_status as Supermetrics writes it (a code or its name) → the account's status. */
export function supermetricsMetaAccountStatus(v: string | number | null | undefined): AdAccountStatus | null {
  const s = textOf(v)?.toUpperCase().replace(/\s+/g, "_") ?? null;
  if (!s) return null;
  const byCode: Record<string, AdAccountStatus> = { "1": "active", "201": "active", "2": "disabled", "3": "payment_issue", "8": "payment_issue", "9": "payment_issue", "7": "under_review", "100": "closing", "101": "closed", "202": "closed" };
  const byName: Record<string, AdAccountStatus> = {
    ACTIVE: "active",
    DISABLED: "disabled",
    UNSETTLED: "payment_issue",
    PENDING_SETTLEMENT: "payment_issue",
    IN_GRACE_PERIOD: "payment_issue",
    PENDING_RISK_REVIEW: "under_review",
    PENDING_CLOSURE: "closing",
    CLOSED: "closed",
  };
  return byCode[s] ?? byName[s] ?? null;
}

/** What one sync of an account learns besides its days: its name, currency, time zone and status, when the rows said. */
export interface SupermetricsDays<R> {
  rows: R[];
  account: AdAccountHealth;
}

/**
 * Meta Ads' days for one account: per campaign per day, plus one "Other campaigns" row per day for what
 * the account spent beyond its campaigns (withMetaOtherCampaigns, as bizinsights' own Meta reading does),
 * from the account's daily totals read alongside. Two queries.
 */
export async function supermetricsMetaDays(c: SupermetricsConfig, cred: SupermetricsCredential, since: string, until: string, opts: SupermetricsRunOptions = {}): Promise<SupermetricsDays<AdDayRow>> {
  const campaignFields = ["Date", "adcampaign_id", "adcampaign_name", ...FA_METRICS];
  const accountFields = ["Date", ...FA_ACCOUNT, ...FA_METRICS];
  const base = { dsId: SUPERMETRICS_DS.meta, cred, since, until, cacheMinutes: 30 };
  const [campaigns, account] = await Promise.all([
    supermetricsQuery(c, { ...base, fields: campaignFields }, opts),
    supermetricsQuery(c, { ...base, fields: accountFields }, opts),
  ]);
  const act = supermetricsAccountId("meta", cred.dsAccount);
  const insight = (r: FaRow, campaign: boolean): MetaInsightRow | null => {
    const day = dayOf(r.Date);
    if (!day) return null;
    return { date_start: day, ...(campaign ? { campaign_id: textOf(r.adcampaign_id) ?? "unknown", campaign_name: textOf(r.adcampaign_name) ?? undefined } : {}), ...faFigures(r) };
  };
  const rows = withMetaOtherCampaigns(
    act,
    campaigns.map((r) => insight(r, true)).filter((r): r is MetaInsightRow => !!r).map((r) => fromMetaInsight(act, r)),
    account.map((r) => insight(r, false)).filter((r): r is MetaInsightRow => !!r).map((r) => fromMetaInsight(act, r)),
  );
  return {
    rows,
    account: {
      status: supermetricsMetaAccountStatus(firstText(account, "account_status")),
      detail: null,
      name: firstText(account, "profile"),
      currency: firstText(account, "currency"),
      timezone: firstText(account, "timezone_name"),
    },
  };
}

/** The FA dimensions of each cut of the Meta Ads report. */
const FA_REPORT_FIELDS: Record<MetaReportView, string[]> = {
  campaign: ["adcampaign_id", "adcampaign_name", "campaignstatus", "campaignobjective", "campaignbuyingtype", "campaign_daily_budget", "campaign_lifetime_budget", "campaign_start_time", "campaign_end_time"],
  adset: ["adset_id", "adset_name", "adcampaign_name", "adsetstatus", "adsetdaily_budget", "adsetlifetime_budget", "adsetstart_time_exact", "adsetend_time_exact", "attribution_setting"],
  ad: ["ad_id", "ad_name", "adset_name", "adcampaign_name", "adstatus", "adcreative_id", "attribution_setting"],
  placement: ["publisher_platform", "platform_position"],
  device: ["impression_device"],
  country: ["Country"],
  age: ["Age"],
  gender: ["Gender"],
};
/** Range figures: reach and frequency count each person once over the whole range. */
const FA_RANGE_METRICS = [...FA_METRICS, "reach", "Frequency"] as const;

const budget = (v: string | number | null | undefined) => {
  const n = numOf(v);
  return n > 0 ? Math.round(n * 100) / 100 : null;
};

/** One row of the Meta Ads report from Supermetrics: Meta's own insight fields, then its row as bizinsights words it. */
function faReportRow(view: MetaReportView, r: FaRow) {
  const insight: MetaRangeInsight = {
    campaign_id: textOf(r.adcampaign_id) ?? undefined,
    campaign_name: textOf(r.adcampaign_name) ?? undefined,
    adset_id: textOf(r.adset_id) ?? undefined,
    adset_name: textOf(r.adset_name) ?? undefined,
    ad_id: textOf(r.ad_id) ?? undefined,
    ad_name: textOf(r.ad_name) ?? undefined,
    publisher_platform: textOf(r.publisher_platform)?.toLowerCase() ?? undefined,
    platform_position: textOf(r.platform_position)?.toLowerCase() ?? undefined,
    impression_device: textOf(r.impression_device)?.toLowerCase() ?? undefined,
    country: textOf(r.Country)?.toUpperCase() ?? undefined,
    age: textOf(r.Age) ?? undefined,
    gender: textOf(r.Gender)?.toLowerCase() ?? undefined,
    reach: r.reach === null || r.reach === undefined ? undefined : str(r.reach),
    frequency: r.Frequency === null || r.Frequency === undefined ? undefined : str(r.Frequency),
    attribution_setting: textOf(r.attribution_setting) ?? undefined,
    ...faFigures(r),
  };
  if (isMetaBreakdown(view)) return fromMetaBreakdownInsight(view, insight);
  const row = fromMetaRangeInsight(view as MetaReportLevel, insight);
  const status = textOf(view === "campaign" ? r.campaignstatus : view === "adset" ? r.adsetstatus : r.adstatus);
  const creativeId = textOf(r.adcreative_id);
  const details: MetaObjectDetails = {
    objective: view === "campaign" ? textOf(r.campaignobjective) : null,
    buyingType: view === "campaign" ? textOf(r.campaignbuyingtype) : null,
    // Supermetrics states budgets in the account's currency (Meta's API in its minor unit).
    dailyBudget: budget(view === "campaign" ? r.campaign_daily_budget : view === "adset" ? r.adsetdaily_budget : null),
    lifetimeBudget: budget(view === "campaign" ? r.campaign_lifetime_budget : view === "adset" ? r.adsetlifetime_budget : null),
    startTime: textOf(view === "campaign" ? r.campaign_start_time : view === "adset" ? r.adsetstart_time_exact : null),
    endTime: textOf(view === "campaign" ? r.campaign_end_time : view === "adset" ? r.adsetend_time_exact : null),
    bidStrategy: null,
    optimizationGoal: null,
    billingEvent: null,
    previewLink: null,
    creativeId: creativeId && /^\d{1,30}$/.test(creativeId) ? creativeId : null,
  };
  return { ...row, status: status ? status.toUpperCase().replace(/\s+/g, "_") : null, details };
}

/**
 * The Meta Ads report for one account and range, through Supermetrics: by campaign, ad set or ad (with
 * each one's delivery status and settings, as Supermetrics lists them), or the account split by
 * placement, device, country, age or gender; and the account's totals (reach counted once over the
 * range). Supermetrics reports with the account's attribution setting (by default 7-day click, 1-day
 * view) on the day of the impression. Campaigns aren't counted by state: Supermetrics only returns
 * the ones with activity in the range (`campaigns` null).
 */
export async function supermetricsMetaReport(
  c: SupermetricsConfig,
  cred: SupermetricsCredential,
  view: MetaReportView,
  since: string,
  until: string,
  opts: SupermetricsRunOptions & { maxRows?: number } = {},
): Promise<MetaReport> {
  const run = { ...opts, stillRunning: opts.stillRunning ?? (() => new AdsReportPendingError("Supermetrics is still preparing this report")) };
  const base = { dsId: SUPERMETRICS_DS.meta, cred, since, until, cacheMinutes: 10 };
  const [totals, raw] = await Promise.all([
    supermetricsQuery(c, { ...base, fields: [...FA_RANGE_METRICS], maxRows: 10 }, run),
    supermetricsQuery(c, { ...base, fields: [...FA_REPORT_FIELDS[view], ...FA_RANGE_METRICS], maxRows: 2000 }, run),
  ]);
  const maxRows = opts.maxRows ?? 200;
  const all = raw.map((r) => faReportRow(view, r)).sort((a, b) => b.spend - a.spend || b.impressions - a.impressions);
  const rows = all.slice(0, maxRows);
  const t = totals[0];
  return {
    level: view,
    since,
    until,
    // No row at all: nothing was shown in the range, so nobody was reached.
    totals: metaReportMetrics(t ? { ...faFigures(t), reach: str(t.reach), ...(t.Frequency !== null && t.Frequency !== undefined ? { frequency: str(t.Frequency) } : {}) } : { reach: "0" }),
    rows,
    truncated: all.length > rows.length || raw.length >= 2000,
    attribution: [...new Set(all.map((r) => r.attribution).filter((a): a is string => !!a))],
    campaigns: null,
  };
}

// ---------------------------------------------------------------------------
// Google Ads (AW)
// ---------------------------------------------------------------------------

const AW_METRICS = ["Cost", "Impressions", "Clicks", "Conversions", "ConversionValue"] as const;
const AW_ACCOUNT = ["profile", "Currencycode", "Timezone"] as const;

/** Supermetrics states cost in the account's currency; Google's API in millionths of it. */
const awMetrics = (r: SupermetricsRow): NonNullable<GoogleAdsRow["metrics"]> => ({
  costMicros: Math.round(numOf(r.Cost) * 1_000_000),
  impressions: numOf(r.Impressions),
  clicks: numOf(r.Clicks),
  conversions: numOf(r.Conversions),
  conversionsValue: numOf(r.ConversionValue),
});

/** Google Ads' conversion category names a purchase ("PURCHASE", or "Purchase" as Supermetrics may label it). */
const isPurchaseCategory = (v: string | number | null | undefined) => /^purchase$/i.test(textOf(v)?.replace(/[\s_-]+/g, "") ?? "");

/**
 * Google Ads' days for one account: cost, impressions, clicks, conversions and their value per campaign
 * per day, and (a second query, by conversion category) the purchases among those conversions, as
 * bizinsights' own Google Ads reading splits them.
 */
export async function supermetricsGoogleDays(c: SupermetricsConfig, cred: SupermetricsCredential, since: string, until: string, opts: SupermetricsRunOptions = {}): Promise<SupermetricsDays<AdDayRow>> {
  const base = { dsId: SUPERMETRICS_DS.google, cred, since, until, cacheMinutes: 30 };
  const [campaigns, byCategory] = await Promise.all([
    supermetricsQuery(c, { ...base, fields: ["Date", "CampaignID", "Campaignname", ...AW_ACCOUNT, ...AW_METRICS] }, opts),
    supermetricsQuery(c, { ...base, fields: ["Date", "CampaignID", "ConversionCategory", "Conversions", "ConversionValue"] }, opts),
  ]);
  const accountId = supermetricsAccountId("google", cred.dsAccount);
  const rows = campaigns
    .map((r): AdDayRow | null => {
      const day = dayOf(r.Date);
      if (!day) return null;
      return fromGoogleAdsRow(accountId, { campaign: { id: textOf(r.CampaignID) ?? "unknown", name: textOf(r.Campaignname) ?? undefined }, segments: { date: day }, metrics: awMetrics(r) });
    })
    .filter((r): r is AdDayRow => !!r);
  const purchases: GooglePurchaseRow[] = byCategory
    .filter((r) => isPurchaseCategory(r.ConversionCategory) && dayOf(r.Date))
    .map((r) => ({ campaign: { id: textOf(r.CampaignID) ?? "unknown" }, segments: { date: dayOf(r.Date)! }, metrics: { conversions: numOf(r.Conversions), conversionsValue: numOf(r.ConversionValue) } }));
  return {
    rows: withGooglePurchases(rows, purchases),
    account: { status: null, detail: null, name: firstText(campaigns, "profile"), currency: firstText(campaigns, "Currencycode"), timezone: firstText(campaigns, "Timezone") },
  };
}

/** Supermetrics' device labels (Google's names, or AdWords' older words) → Google's DEVICE enum. */
function googleDevice(v: string | number | null | undefined): string {
  const s = (textOf(v) ?? "").toLowerCase();
  if (!s) return "UNKNOWN";
  if (/tablet/.test(s)) return "TABLET";
  if (/mobile|phone/.test(s)) return "MOBILE";
  if (/computer|desktop/.test(s)) return "DESKTOP";
  if (/tv|television|connected/.test(s)) return "CONNECTED_TV";
  if (/unknown/.test(s)) return "UNKNOWN";
  return "OTHER";
}

const enumWords = (v: string | number | null | undefined) => textOf(v)?.toUpperCase().replace(/[\s-]+/g, "_") ?? undefined;

/** The AW dimensions of each cut of the Google Ads report. */
const AW_REPORT_FIELDS: Record<GoogleReportLevel, string[]> = {
  campaign: ["CampaignID", "Campaignname", "Campaignstatus", "AdvertisingChannelType", "ConfiguredBudget"],
  ad_group: ["AdgroupID", "Adgroupname", "Campaignname", "Adgroupstatus"],
  device: ["Device"],
  country: ["CountryCode"],
};

/**
 * The Google Ads report for one account and range, through Supermetrics: by campaign (with status,
 * channel and daily budget), ad group, device or country, and the account's totals. The rows go through
 * the same grouping as Google's own (googleReportRows), so a country listed under several targeting
 * kinds is one row.
 */
export async function supermetricsGoogleReport(
  c: SupermetricsConfig,
  cred: SupermetricsCredential,
  level: GoogleReportLevel,
  since: string,
  until: string,
  opts: SupermetricsRunOptions & { maxRows?: number } = {},
): Promise<GoogleReport> {
  const run = { ...opts, stillRunning: opts.stillRunning ?? (() => new AdsRetryableError("Supermetrics is still preparing this report")) };
  const base = { dsId: SUPERMETRICS_DS.google, cred, since, until, cacheMinutes: 10 };
  const [totalRows, raw] = await Promise.all([
    supermetricsQuery(c, { ...base, fields: [...AW_METRICS], maxRows: 10 }, run),
    supermetricsQuery(c, { ...base, fields: [...AW_REPORT_FIELDS[level], ...AW_METRICS], maxRows: 2000 }, run),
  ]);
  const apiRows: GoogleReportApiRow[] = raw.map((r) => ({
    campaign: { id: textOf(r.CampaignID) ?? undefined, name: textOf(r.Campaignname) ?? undefined, status: enumWords(r.Campaignstatus), advertisingChannelType: enumWords(r.AdvertisingChannelType) },
    ...(r.ConfiguredBudget !== null && r.ConfiguredBudget !== undefined && r.ConfiguredBudget !== "" ? { campaignBudget: { amountMicros: Math.round(numOf(r.ConfiguredBudget) * 1_000_000) } } : {}),
    adGroup: { id: textOf(r.AdgroupID) ?? undefined, name: textOf(r.Adgroupname) ?? undefined, status: enumWords(r.Adgroupstatus) },
    segments: { device: googleDevice(r.Device) },
    // Supermetrics names the country by its ISO code: it stands in for Google's geo target id here.
    userLocationView: { countryCriterionId: textOf(r.CountryCode)?.toUpperCase() ?? "" },
    metrics: awMetrics(r),
  }));
  const codes = new Map(apiRows.map((r) => String(r.userLocationView?.countryCriterionId ?? "")).filter(Boolean).map((code) => [code, code]));
  const all = googleReportRows(level, apiRows, codes);
  const rows = all.slice(0, opts.maxRows ?? 200);
  const totals = googleReportRows("device", totalRows.map((r) => ({ segments: { device: "ALL" }, metrics: awMetrics(r) })))[0];
  return { level, since, until, totals: totals ?? googleReportMetrics({}), rows, truncated: all.length > rows.length || raw.length >= 2000 };
}

// ---------------------------------------------------------------------------
// AdSense (ADM)
// ---------------------------------------------------------------------------

/**
 * The money column and the currency it is in. Supermetrics' AdSense connector names no currency for an
 * account: its `earnings` are in the account's own, unnamed. So they are read in the account's currency
 * only for an account whose currency bizinsights learnt from AdSense itself before (adsenseCurrency
 * "account", decided once when it is connected, so its stored days never change currency); otherwise
 * as `earnings_usd`, Supermetrics' conversion to US dollars, labelled USD.
 */
function admMoney(cred: SupermetricsCredential, accountCurrency: string | null | undefined): { field: string; currency: string } {
  return cred.adsenseCurrency === "account" && accountCurrency ? { field: "earnings", currency: accountCurrency } : { field: "earnings_usd", currency: "USD" };
}

/** Supermetrics' AdSense figures as an AdSense report (headers by AdSense's names), for the same readers. */
function admReport(rows: SupermetricsRow[], money: string, currency: string, dims: Array<[string, string]>): AdsenseReport {
  const headers = [
    ...dims.map(([name]) => ({ name, type: "DIMENSION" })),
    { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: currency },
    { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
    // Supermetrics' "Ad impressions" (each ad shown): AdSense's own IMPRESSIONS counts ad requests that
    // showed ads, which Supermetrics doesn't offer (docs/supermetrics.md, "Differences").
    { name: "IMPRESSIONS", type: "METRIC_TALLY" },
    { name: "CLICKS", type: "METRIC_TALLY" },
  ];
  return {
    headers,
    rows: rows.map((r) => ({
      cells: [...dims.map(([, f]) => ({ value: textOf(r[f]) ?? "" })), { value: str(r[money]) }, { value: str(r.page_views) }, { value: str(r.individual_ad_impressions) }, { value: str(r.ad_clicks) }],
    })),
  };
}

/**
 * AdSense's days for one account: estimated earnings, page views, ad impressions and clicks per site
 * per day. `accountCurrency`: the connection's currency (admMoney).
 */
export async function supermetricsAdsenseDays(
  c: SupermetricsConfig,
  cred: SupermetricsCredential,
  since: string,
  until: string,
  accountCurrency: string | null | undefined,
  opts: SupermetricsRunOptions = {},
): Promise<{ rows: AdsenseDayRow[]; currency: string }> {
  const money = admMoney(cred, accountCurrency);
  const raw = await supermetricsQuery(c, { dsId: SUPERMETRICS_DS.adsense, cred, since, until, cacheMinutes: 30, fields: ["date", "domain_name", money.field, "page_views", "individual_ad_impressions", "ad_clicks"] }, opts);
  const report = admReport(raw, money.field, money.currency, [["DATE", "date"], ["DOMAIN_CODE", "domain_name"]]);
  const { rows } = fromAdsenseReport(supermetricsAccountId("adsense", cred.dsAccount), report);
  return { rows: rows.map((r) => ({ ...r, site: r.site.toLowerCase() })), currency: money.currency };
}

/** The ADM dimensions of each cut of the AdSense report, after the site (always asked, so the store's sites can be kept). */
const ADM_REPORT_DIMS: Record<AdsenseReportLevel, Array<[string, string]>> = {
  site: [],
  country: [["COUNTRY_CODE", "country_code"], ["COUNTRY_NAME", "country_name"]],
  platform: [["PLATFORM_TYPE_CODE", "platform_type_code"], ["PLATFORM_TYPE_NAME", "platform_type_name"]],
};

/**
 * The AdSense report for one account and range, through Supermetrics, by site, country or device type,
 * limited to the store's own sites (`sites`; empty: every site). Every cut is read with the site too and
 * the other sites' rows are dropped here, so another site's earnings never count as the store's.
 */
export async function supermetricsAdsenseReport(
  c: SupermetricsConfig,
  cred: SupermetricsCredential,
  level: AdsenseReportLevel,
  since: string,
  until: string,
  sites: readonly string[],
  accountCurrency: string | null | undefined,
  opts: SupermetricsRunOptions & { maxRows?: number } = {},
): Promise<{ rows: AdsenseReportRow[]; currency: string; truncated: boolean; totals: AdsenseTotals }> {
  const money = admMoney(cred, accountCurrency);
  const dims = ADM_REPORT_DIMS[level];
  const raw = await supermetricsQuery(
    c,
    { dsId: SUPERMETRICS_DS.adsense, cred, since, until, cacheMinutes: 10, maxRows: 5000, fields: ["domain_name", ...dims.map(([, f]) => f), money.field, "page_views", "individual_ad_impressions", "ad_clicks"] },
    { ...opts, stillRunning: opts.stillRunning ?? (() => new AdsRetryableError("Supermetrics is still preparing this report")) },
  );
  const wanted = new Set(sites.map((s) => s.trim().toLowerCase()));
  const kept = raw.filter((r) => !wanted.size || wanted.has((textOf(r.domain_name) ?? "").toLowerCase()));
  const groups = new Map<string, { name: string; rows: AdsenseDayRow[] }>();
  for (const r of kept) {
    const id = (level === "site" ? textOf(r.domain_name)?.toLowerCase() : textOf(r[dims[0]![1]])) || "unknown";
    const label = level === "site" ? id : textOf(r[dims[1]![1]]);
    const name = label || (level === "country" ? countryName(id === "unknown" ? null : id) : id === "unknown" ? "Unknown" : id);
    const g = groups.get(id) ?? { name, rows: [] };
    g.rows.push({ accountId: "", site: "", day: "", earnings: numOf(r[money.field]), pageViews: Math.round(numOf(r.page_views)), impressions: Math.round(numOf(r.individual_ad_impressions)), clicks: Math.round(numOf(r.ad_clicks)) });
    groups.set(id, g);
  }
  const all = [...groups.entries()]
    .map(([id, g]) => ({ id, name: g.name, ...adsenseTotals(g.rows) }))
    .sort((a, b) => b.earnings - a.earnings || b.pageViews - a.pageViews || a.name.localeCompare(b.name));
  const maxRows = opts.maxRows ?? 1000;
  return {
    rows: all.slice(0, maxRows),
    currency: money.currency,
    truncated: all.length > maxRows || raw.length >= 5000,
    // Every kept row, the ones past maxRows included.
    totals: adsenseTotals([...groups.values()].flatMap((g) => g.rows)),
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * One account's health through Supermetrics, without spending a query: the login still usable (not
 * revoked, not expired past renewal: else connecting again is the fix) and the account still among the
 * ones it can report on (else this login lost it). The platform's own account status isn't listed by
 * Supermetrics; Meta's comes with the daily rows instead (supermetricsMetaDays).
 */
export async function supermetricsAccountHealth(c: SupermetricsConfig, provider: AdProvider, loginId: string, dsAccount: string): Promise<AdAccountHealth> {
  const login = await supermetricsLogin(c, loginId);
  if (!supermetricsLoginUsable(login)) throw new AdsAuthError("The Supermetrics login has expired or was revoked");
  let accounts: AdAccountList;
  try {
    accounts = await supermetricsLoginAccounts(c, provider, loginId, { budgetMs: 15_000 });
  } catch (err) {
    if (err instanceof AdsNoAccountsError) throw new AdsPermissionError("The Supermetrics login no longer reaches this account");
    throw err;
  }
  const mine = accounts.find((a) => a.sourceAccountId === dsAccount || a.accountId === supermetricsAccountId(provider, dsAccount));
  if (!mine && !accounts.truncated) throw new AdsPermissionError("The Supermetrics login no longer reaches this account");
  return { status: null, detail: null, name: mine?.name ?? null, currency: null, timezone: null };
}
