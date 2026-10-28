// Zapier (docs/zapier.md): the "bizinsights" app on Zapier's Developer Platform. A merchant connects
// their bizinsights store inside their own Zapier account (OAuth: bizinsights is the provider) and
// uses its triggers, searches and its one action in their Zaps. What each trigger is, what it needs,
// how a threshold is crossed, what the WhatsApp action takes, and how a delivery's outcome is worded:
// shared by the API, the worker and the UI.
//
// Imported by the UI through `@app/shared/zapier`: no I/O, relative imports stay extensionless.

import type { AccessKey, AccessNeed } from "./access";
import { WA_VARIABLES } from "./whatsapp";
import { z } from "./zod";

// ---------------------------------------------------------------------------
// Tokens and codes
// ---------------------------------------------------------------------------

/** Prefixes that say what a credential is, so one pasted or logged by mistake is recognised (and rejected where it doesn't belong). */
export const ZAPIER_ACCESS_PREFIX = "zat_";
export const ZAPIER_REFRESH_PREFIX = "zrt_";
export const ZAPIER_CODE_PREFIX = "zac_";

/** An access token lasts an hour; Zapier refreshes it by itself (autoRefresh). */
export const ZAPIER_ACCESS_TTL_S = 3600;
/** A refresh token lasts a year from when it was issued; every refresh issues a new one, so only a connection unused for a year expires. */
export const ZAPIER_REFRESH_TTL_S = 365 * 86_400;
/** An authorization code: single use, five minutes. */
export const ZAPIER_CODE_TTL_S = 300;
/**
 * A refresh token presented again this soon after it was exchanged is a retry or two of Zapier's
 * tasks refreshing at once, not a theft: it gets a new pair too. Later, it revokes the whole grant.
 */
export const ZAPIER_REFRESH_REUSE_GRACE_MS = 60_000;

// ---------------------------------------------------------------------------
// The triggers (REST hooks)
// ---------------------------------------------------------------------------

export const ZAPIER_EVENTS = ["alert_raised", "ad_spend_threshold", "adsense_earnings_threshold", "ads_daily_summary", "whatsapp_message_failed"] as const;
export type ZapierEvent = (typeof ZAPIER_EVENTS)[number];
export const isZapierEvent = (s: string): s is ZapierEvent => (ZAPIER_EVENTS as readonly string[]).includes(s);

export interface ZapierEventInfo {
  label: string;
  /** What the trigger sends, in the merchant's words (the consent page and Settings → Integrations). */
  description: string;
  /**
   * The permission the person who connected Zapier must hold, besides "Manage integrations", for
   * the trigger to be set up and its events to be sent. Alerts follow the bell's own rule per area
   * (mayFixAlert in ./alerts) instead.
   */
  needs: AccessKey | null;
}

export const ZAPIER_EVENT_INFO: Record<ZapierEvent, ZapierEventInfo> = {
  alert_raised: {
    label: "New alert",
    description: "A problem bizinsights raises for the store: a sync or sign-in that stopped working (Shopify, ad accounts, WhatsApp, email), as worded in the bell.",
    needs: null,
  },
  ad_spend_threshold: {
    label: "Ad spend passed an amount",
    description: "Once a day or a month, when the store's Meta or Google Ads spend stored in bizinsights passes the amount you set.",
    needs: "marketing.ads",
  },
  adsense_earnings_threshold: {
    label: "AdSense earnings passed an amount",
    description: "Once a day or a month, when the store's estimated AdSense earnings pass the amount you set.",
    needs: "marketing.ads",
  },
  ads_daily_summary: {
    label: "Daily advertising summary",
    description: "Once a day: yesterday's spend, impressions, clicks and conversions per ad platform, with the store's own sales beside them.",
    needs: "marketing.ads",
  },
  whatsapp_message_failed: {
    label: "WhatsApp message failed",
    description: "A WhatsApp message to a customer couldn't be delivered. The customer's number is masked.",
    needs: "marketing.campaigns",
  },
};

/** The searches Zapier may run, for the consent page. */
export const ZAPIER_SEARCHES = [
  { key: "find_ad_performance", label: "Find ad performance", description: "Totals of the store's Meta and Google Ads figures for chosen dates, as stored in bizinsights." },
  { key: "find_adsense_earnings", label: "Find AdSense earnings", description: "The store's estimated AdSense earnings for chosen dates." },
] as const;

// ---------------------------------------------------------------------------
// What a connection may do beyond triggers and searches (scopes)
// ---------------------------------------------------------------------------

/**
 * Each one ticked by itself on the consent page, by someone who may do it in bizinsights, and kept on
 * the grant (zapier_grants.scopes). A connection made without it can never do it: connect again.
 */
export const ZAPIER_SCOPES = ["whatsapp_send"] as const;
export type ZapierScope = (typeof ZAPIER_SCOPES)[number];
export const isZapierScope = (s: string): s is ZapierScope => (ZAPIER_SCOPES as readonly string[]).includes(s);

export const ZAPIER_SCOPE_INFO: Record<ZapierScope, { label: string; description: string; needs: AccessNeed; needsLabel: string }> = {
  whatsapp_send: {
    label: "Send WhatsApp template messages to your customers",
    description:
      "From your Zaps (a new Meta or Google Ads lead, an order, a form), with templates Meta approved only, to customers who agreed, within your WhatsApp settings' sending hours and limits. A customer who replied STOP never gets one.",
    // The same people who may send from the WhatsApp page (docs/whatsapp.md, "Who may do what").
    needs: "stores:manage",
    needsLabel: "the store's owners and admins",
  },
};

/** The actions Zapier may run, for the consent page; each needs its scope. */
export const ZAPIER_ACTIONS = [
  { key: "send_whatsapp_template", label: "Send WhatsApp Template Message", description: "Sends one customer a WhatsApp template Meta approved, with the values your Zap maps in.", scope: "whatsapp_send" },
] as const satisfies ReadonlyArray<{ key: string; label: string; description: string; scope: ZapierScope }>;

/** What the consent page says Zapier can't do once allowed, given what was ticked. */
export function zapierCannot(scopes: readonly string[]): string[] {
  return [
    "Change anything in bizinsights, Shopify or your ad accounts",
    scopes.includes("whatsapp_send") ? "Send customers anything but a WhatsApp template Meta approved, or message anyone who replied STOP" : "Send messages to your customers",
    "See customers' names, emails or full phone numbers",
    "Reach your other stores or workspaces",
  ];
}

// ---------------------------------------------------------------------------
// The action "Send WhatsApp Template Message"
// ---------------------------------------------------------------------------

/** Messages one store may hand bizinsights from Zapier a minute (a burst of leads); more are answered 429 and Zapier tries again. */
export const ZAPIER_WA_SENDS_PER_MINUTE = 60;
/** The longest value a Zap may put in a template's variable. */
export const ZAPIER_WA_VALUE_MAX = 200;
/** Variables a Zap fills in: every template variable but the business's name, which is the store's own. */
export const ZAPIER_WA_VARIABLES = WA_VARIABLES.filter((v) => v !== "store_name");

/** Zapier sends an unfilled optional field as "", and booleans mapped from another app as words. */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const yes = (v: unknown) => (typeof v === "string" ? ["true", "yes", "1", "y"].includes(v.trim().toLowerCase()) : v === true || v === 1);

/**
 * A template's value as Meta takes it: one line (Meta refuses a parameter with a new line, a tab or
 * more than four spaces in a row), trimmed.
 */
export const zapierWaValue = (v: string) => v.replace(/\s+/g, " ").trim();

export const zapierWhatsappSendSchema = z.object({
  phone: z.string().trim().min(6).max(32),
  /** The country to read a number written without "+" in (ISO 3166-1 alpha-2). */
  country: z.preprocess(blankToUndefined, z.string().trim().length(2).toUpperCase().optional()),
  template_id: z.string().trim().min(1).max(40),
  /** The template's variables, by name ({{order_number}} → "order_number"). */
  values: z.preprocess(
    (v) => (v && typeof v === "object" ? v : {}),
    z.record(z.string().max(40), z.preprocess((x) => (x == null ? "" : typeof x === "number" ? String(x) : x), z.string().max(ZAPIER_WA_VALUE_MAX * 2))),
  ),
  /** The customer's first name, kept on their WhatsApp contact (and {{customer_first_name}} when the Zap gives none). */
  first_name: z.preprocess(blankToUndefined, z.string().trim().max(60).optional()),
  /** The store says this customer agreed to WhatsApp messages from it: recorded as their consent, with the note. */
  customer_agreed: z.preprocess((v) => yes(v), z.boolean()),
  consent_note: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  /** Messages with the same key go once (a lead's id). Without one: the same Zap, number, template and values on the same day go once. */
  unique_key: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  zap_id: z.preprocess((v) => (typeof v === "number" ? String(v) : blankToUndefined(v)), z.string().max(40).optional()),
});
export type ZapierWhatsappSendInput = z.infer<typeof zapierWhatsappSendSchema>;

/** The variables a Zap may fill in, in a template's text. */
export const zapierFillable = (variables: readonly string[]) => variables.filter((v) => (ZAPIER_WA_VARIABLES as readonly string[]).includes(v));

/** Threshold triggers' inputs. */
export const ZAPIER_SPEND_PLATFORMS = ["meta", "google", "any"] as const;
export type ZapierSpendPlatform = (typeof ZAPIER_SPEND_PLATFORMS)[number];
export const ZAPIER_PERIODS = ["day", "month"] as const;
export type ZapierPeriod = (typeof ZAPIER_PERIODS)[number];

/** Most triggers one Zapier connection may hold (each Zap's trigger is one). */
export const ZAPIER_MAX_HOOKS_PER_GRANT = 50;

/**
 * Where Zapier may ask bizinsights to send events: Zapier's own hook host, over https, and nothing
 * else (no other host, port, credentials or IP address). bizinsights posts server-side, so any other
 * address would let a connection make it call into networks it can reach (SSRF).
 */
export function isZapierHookUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === "hooks.zapier.com" && u.port === "" && !u.username && !u.password && u.pathname.startsWith("/hooks/");
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** The period a day falls in: the day itself, or its month ("2026-10"). */
export function periodKey(day: string, period: ZapierPeriod): string {
  return period === "day" ? day : day.slice(0, 7);
}

/** The first and last day of a period key ("2026-10" → 2026-10-01..2026-10-31). */
export function periodRange(key: string): { since: string; until: string } {
  if (key.length === 10) return { since: key, until: key };
  const [y, m] = key.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { since: `${key}-01`, until: `${key}-${String(last).padStart(2, "0")}` };
}

/** Money per currency, as stored rows report it. */
export interface CurrencyAmount {
  currency: string | null;
  amount: number;
}

/**
 * One total for amounts in one currency. Amounts in different currencies can't be added up (there
 * is no exchange rate in bizinsights), so then there is no total: `mixed` lists the currencies.
 */
export function singleCurrencyTotal(rows: readonly CurrencyAmount[]): { total: number; currency: string | null } | { mixed: string[] } {
  const currencies = [...new Set(rows.map((r) => r.currency ?? "").filter(Boolean))].sort();
  if (currencies.length > 1) return { mixed: currencies };
  const total = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  return { total, currency: currencies[0] ?? null };
}

/** Whether a total has reached the amount a trigger was set to. */
export const thresholdReached = (total: number, amount: number): boolean => total >= amount;

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** Attempts at one event for one Zap before it is marked failed. */
export const ZAPIER_MAX_ATTEMPTS = 8;

/**
 * The wait before attempt `attempt + 1` (seconds): 30 s doubling to at most an hour, give or take a
 * fifth so many retries don't land at once. `random` is injectable for tests.
 */
export function zapierBackoffSeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(base * (0.8 + 0.4 * random())));
}

export const ZAPIER_DELIVERY_STATUSES = ["pending", "delivering", "retrying", "delivered", "failed", "cancelled"] as const;
export type ZapierDeliveryStatus = (typeof ZAPIER_DELIVERY_STATUSES)[number];

/** Why a delivery didn't land (zapier_deliveries.error_code). */
export const ZAPIER_DELIVERY_ERRORS = {
  timeout: "Zapier didn't answer in time",
  network: "Zapier couldn't be reached",
  server_error: "Zapier had a problem receiving it",
  rate_limited: "Zapier asked bizinsights to slow down",
  redirect_refused: "Zapier answered with a redirect, which bizinsights doesn't follow",
  rejected: "Zapier refused it",
  hook_gone: "The Zap was turned off or deleted in Zapier",
  hook_removed: "The trigger was removed before it could be sent",
  invalid_target: "The address Zapier gave isn't one of Zapier's",
  authorizer_no_access: "The person who connected Zapier no longer has access to this",
  grant_revoked: "Zapier was disconnected",
  gave_up: "Not delivered after several tries",
} as const;
export type ZapierDeliveryError = keyof typeof ZAPIER_DELIVERY_ERRORS;

/** How a delivery reads on Settings → Integrations. */
export function deliveryOutcome(d: { status: string; errorCode: string | null; responseStatus: number | null }): { label: string; tone: "good" | "warn" | "danger" | "neutral"; reason: string | null } {
  const reason = d.errorCode && d.errorCode in ZAPIER_DELIVERY_ERRORS ? ZAPIER_DELIVERY_ERRORS[d.errorCode as ZapierDeliveryError] : null;
  const withStatus = (r: string | null) => (r && d.responseStatus ? `${r} (HTTP ${d.responseStatus})` : r);
  switch (d.status) {
    case "delivered":
      return { label: "Delivered", tone: "good", reason: null };
    case "pending":
    case "delivering":
      return { label: "Sending", tone: "neutral", reason: null };
    case "retrying":
      return { label: "Retrying", tone: "warn", reason: withStatus(reason) };
    case "cancelled":
      return { label: "Not sent", tone: "neutral", reason };
    default:
      return { label: "Failed", tone: "danger", reason: withStatus(reason) ?? ZAPIER_DELIVERY_ERRORS.gave_up };
  }
}
