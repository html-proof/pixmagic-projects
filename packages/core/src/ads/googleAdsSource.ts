/**
 * Where a Google Ads connection's figures come from: Google's API (a production connection, read with
 * the person's token) or bizinsights' own generator (a demo connection, which holds no token at all).
 * Both answer the same questions in the same shapes, so the sync, the dashboard and the live report
 * never ask which they are reading; what is shown is marked as demo where it is shown (is_demo on the
 * row, which the API passes on). The two never mix: the demo source makes no network call whatever
 * keys are configured, and the production source never substitutes generated figures when Google
 * doesn't answer.
 */
import type { AdConnection } from "@app/db";
import {
  DEMO_ACCOUNT_NAME,
  DEMO_DEFAULT_CURRENCY,
  DEMO_DEFAULT_SEED,
  DEMO_DEFAULT_TIMEZONE,
  demoCampaignRows,
  demoReport,
  localDay,
  type AdDayRow,
  type DemoContext,
  type GoogleReportLevel,
  type GoogleReportParent,
} from "@app/shared";
import { AdsApiError, type AdAccountHealth } from "./common.js";
import { googleAccountHealth, googleCampaignDays, googleReport, type GoogleConfig, type GoogleReport } from "./googleAds.js";

export type GoogleAdsSourceKind = "demo" | "production";

/** What every source answers: the days to store, the account's health, and the live report. */
export interface GoogleAdsSource {
  readonly kind: GoogleAdsSourceKind;
  /** Cost, impressions, clicks, conversions and their value per campaign per day, for [since, until]. */
  campaignDays(since: string, until: string): Promise<AdDayRow[]>;
  /** The account's status, name, currency and time zone now. */
  accountHealth(): Promise<AdAccountHealth>;
  /** The report by campaign, ad group, device or country for exactly one range; under a parent, one campaign's ad groups or asset groups, one ad group's ads. */
  report(level: GoogleReportLevel, since: string, until: string, parent?: GoogleReportParent): Promise<GoogleReport>;
}

/** What the demo generator reads of a connection. */
export type DemoConnection = Pick<AdConnection, "demoSeed" | "currency" | "timezone" | "createdAt">;

/** What the demo's figures say about the account, under "Details" on its card. */
export const DEMO_ACCOUNT_STATUS_DETAIL = "Demo advertising account: simulated by bizinsights, not verified by Google";

/**
 * The demo's generating context: its seed, its currency and its epoch, the day it was connected in its
 * own time zone. The campaigns' starts and trends are set relative to the epoch, so a demo's figures
 * never shift as days pass; a reset changes the seed and nothing else.
 */
export function demoContextOf(conn: DemoConnection): DemoContext {
  let epoch: string;
  try {
    epoch = localDay(conn.createdAt, conn.timezone || DEMO_DEFAULT_TIMEZONE);
  } catch {
    epoch = localDay(conn.createdAt, "UTC");
  }
  return { seed: conn.demoSeed ?? DEMO_DEFAULT_SEED, currency: conn.currency ?? DEMO_DEFAULT_CURRENCY, epoch };
}

/** The simulated account: every answer generated from the connection's seed, nothing fetched. */
export class GoogleAdsDemoProvider implements GoogleAdsSource {
  readonly kind = "demo" as const;
  readonly context: DemoContext;
  constructor(private readonly conn: DemoConnection) {
    this.context = demoContextOf(conn);
  }
  async campaignDays(since: string, until: string): Promise<AdDayRow[]> {
    return demoCampaignRows(this.context, since, until);
  }
  async accountHealth(): Promise<AdAccountHealth> {
    return { status: "active", detail: DEMO_ACCOUNT_STATUS_DETAIL, name: DEMO_ACCOUNT_NAME, currency: this.context.currency, timezone: this.conn.timezone ?? DEMO_DEFAULT_TIMEZONE };
  }
  async report(level: GoogleReportLevel, since: string, until: string, parent: GoogleReportParent = {}): Promise<GoogleReport> {
    // A campaign's primary status is rated as of the account's today, as Google's is now.
    let today: string;
    try {
      today = localDay(new Date(), this.conn.timezone || DEMO_DEFAULT_TIMEZONE);
    } catch {
      today = localDay(new Date(), "UTC");
    }
    return demoReport(this.context, level, since, until, parent, today);
  }
}

/** A real account: Google's API, with the OAuth client and the person's access token. */
export class GoogleAdsProductionProvider implements GoogleAdsSource {
  readonly kind = "production" as const;
  constructor(
    private readonly cfg: GoogleConfig,
    private readonly accessToken: string,
    private readonly account: { accountId: string; loginCustomerId?: string | null },
  ) {}
  campaignDays(since: string, until: string): Promise<AdDayRow[]> {
    return googleCampaignDays(this.cfg, this.accessToken, this.account, since, until);
  }
  accountHealth(): Promise<AdAccountHealth> {
    return googleAccountHealth(this.cfg, this.accessToken, this.account);
  }
  report(level: GoogleReportLevel, since: string, until: string, parent: GoogleReportParent = {}): Promise<GoogleReport> {
    return googleReport(this.cfg, this.accessToken, this.account, level, since, until, undefined, parent);
  }
}

/** A Google Ads connection whose figures are simulated (never any other platform's row). */
export const isDemoConnection = (conn: Pick<AdConnection, "provider" | "isDemo">): boolean => conn.provider === "google" && conn.isDemo;

/**
 * The source for one connection: the generator for a demo row (whatever Google keys are around, and
 * without any token), Google for every other, which needs the OAuth client (googleClient in
 * adConnections/config.ts) and a usable access token (adAccessToken). Throws `not_configured` for a
 * real connection on a server without the client.
 */
export function googleAdsSource(
  conn: Pick<AdConnection, "provider" | "isDemo" | "accountId" | "loginCustomerId"> & DemoConnection,
  production: { cfg: GoogleConfig | null; accessToken: string },
): GoogleAdsSource {
  if (isDemoConnection(conn)) return new GoogleAdsDemoProvider(conn);
  if (!production.cfg) throw new AdsApiError("Google Ads isn't set up on this server", 503, undefined, "not_configured");
  return new GoogleAdsProductionProvider(production.cfg, production.accessToken, { accountId: conn.accountId, loginCustomerId: conn.loginCustomerId });
}
