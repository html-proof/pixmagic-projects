import { logger, resendMailer, withTimeout, type FetchLike, type Mailer } from "@app/core/mailer";
import { jsonApi, type AwsCredentials } from "./awsClient.js";

/**
 * The owner's daily AWS cost email: the last full day's cost (UTC, Cost Explorer's days) by
 * service, and the month so far. The cron function's `{ "action": "cost-report" }`, run once a day
 * by the CostReport schedule (infra/cdk app-stack.ts, `costReport` in config.ts) and sent through
 * Resend (SES is limited to verified addresses) to the budget's address (COST_REPORT_TO).
 *
 * One Cost Explorer GetCostAndUsage call a day: AWS charges US$0.01 per call, so ~US$0.30 a month.
 * DAILY results grouped by SERVICE from the 1st of the reported day's month to the end of that day
 * give both the day and the month to date. The address is never logged.
 */

export interface ServiceCost {
  service: string;
  /** The reported day. */
  day: number;
  /** The month so far, the reported day included. */
  month: number;
}

export interface CostSummary {
  /** The reported day, YYYY-MM-DD (UTC). */
  day: string;
  /** The first of its month, YYYY-MM-DD. */
  monthStart: string;
  currency: string;
  dayTotal: number;
  monthTotal: number;
  /** Whether Cost Explorer returned the reported day at all (it can lag behind). */
  dayFound: boolean;
  /** Days of the month with any cost (fewer than the days so far when Cost Explorer starts mid-month). */
  daysWithCost: number;
  /** Every service with a cost this month, the reported day's biggest first. */
  services: ServiceCost[];
}

/** Cost Explorer's GetCostAndUsage answer, as much of it as the report reads. */
export interface CostExplorerPage {
  ResultsByTime?: Array<{
    TimePeriod?: { Start?: string; End?: string };
    Groups?: Array<{ Keys?: string[]; Metrics?: Record<string, { Amount?: string; Unit?: string } | undefined> }>;
  }>;
  NextPageToken?: string;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The day to report (yesterday in UTC) and the query's range: the 1st of that day's month to the
 * end of that day (Cost Explorer's End is exclusive), so on the 1st it reports last month whole.
 */
export function reportPeriod(now: Date): { day: string; start: string; end: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = new Date(today.getTime() - 86_400_000);
  return { day: isoDay(day), start: `${isoDay(day).slice(0, 8)}01`, end: isoDay(today) };
}

/** The GetCostAndUsage request for a period (reportPeriod). */
export function costRequest(period: { start: string; end: string }, nextPageToken?: string): Record<string, unknown> {
  return {
    TimePeriod: { Start: period.start, End: period.end },
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
  };
}

/** Cost Explorer's pages as one summary of `day` and its month. Throws on a currency it can't add up. */
export function summarizeCosts(pages: CostExplorerPage[], day: string): CostSummary {
  const byService = new Map<string, ServiceCost>();
  const currencies = new Set<string>();
  const datesWithCost = new Set<string>();
  let dayFound = false;
  for (const page of pages) {
    for (const result of page.ResultsByTime ?? []) {
      const date = result.TimePeriod?.Start;
      if (!date) continue;
      if (date === day) dayFound = true;
      for (const group of result.Groups ?? []) {
        const metric = group.Metrics?.UnblendedCost;
        const amount = Number(metric?.Amount ?? 0);
        if (!Number.isFinite(amount) || amount === 0) continue;
        if (metric?.Unit) currencies.add(metric.Unit);
        datesWithCost.add(date);
        const service = group.Keys?.[0] || "(no service)";
        const row = byService.get(service) ?? { service, day: 0, month: 0 };
        row.month += amount;
        if (date === day) row.day += amount;
        byService.set(service, row);
      }
    }
  }
  if (currencies.size > 1) throw new Error(`Cost Explorer answered in more than one currency: ${[...currencies].join(", ")}`);
  const services = [...byService.values()].sort((a, b) => b.day - a.day || b.month - a.month || a.service.localeCompare(b.service));
  return {
    day,
    monthStart: `${day.slice(0, 8)}01`,
    currency: [...currencies][0] ?? "USD",
    dayTotal: services.reduce((n, s) => n + s.day, 0),
    monthTotal: services.reduce((n, s) => n + s.month, 0),
    dayFound,
    daysWithCost: datesWithCost.size,
    services,
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Sat 17 Oct 2026" for 2026-10-17. */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}`;
}

/** "US$2.41"; a cost under half a cent is "<US$0.01"; credits are negative. */
export function money(amount: number, currency = "USD"): string {
  const prefix = currency === "USD" ? "US$" : `${currency} `;
  if (amount > 0 && amount < 0.005) return `<${prefix}0.01`;
  const rounded = Math.round(amount * 100) / 100;
  return `${rounded < 0 ? "-" : ""}${prefix}${Math.abs(rounded).toFixed(2)}`;
}

/** How many of the day's services the email lists before "Everything else". */
const TOP = 8;
/** A service this big a share of the month is listed even with nothing on the day (one that stopped). */
const MONTH_SHARE = 0.05;

/**
 * Where the figures stop short of the bill. The Bills page on 2026-10-18 (docs/aws-deployment.md,
 * Cost) is the example: of October's US$26.46 so far, US$15.72 was Business Support+.
 */
const CAVEAT =
  "Cost Explorer runs about a day behind the Bills page, and it leaves out the support plan (Business Support+, the greater of US$29 a month or 9% of the bill) and GST (10%) until the month's invoice. " +
  "On 18 Oct 2026 the Bills page showed October at US$26.46, of which US$15.72 was Business Support+. The Bills page has the full figure.";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function costEmail(s: CostSummary, environment = "production"): { subject: string; text: string; html: string } {
  const m = (n: number) => money(n, s.currency);
  const monthName = MONTHS[Number(s.monthStart.slice(5, 7)) - 1]!;
  const days = Number(s.day.slice(8, 10));
  const label = dayLabel(s.day);
  const span = days === 1 ? `1 ${monthName.slice(0, 3)}` : `1-${days} ${monthName.slice(0, 3)}`;
  const short = label.slice(4, -5); // "17 Oct"
  const top = s.services.filter((r) => Math.abs(r.day) >= 0.005).slice(0, TOP);
  for (const r of s.services) if (!top.includes(r) && s.monthTotal > 0 && r.month >= s.monthTotal * MONTH_SHARE) top.push(r);
  const rest = s.services.filter((r) => !top.includes(r));
  const restRow = rest.length ? { service: `Everything else (${rest.length} service${rest.length === 1 ? "" : "s"})`, day: rest.reduce((n, r) => n + r.day, 0), month: rest.reduce((n, r) => n + r.month, 0) } : null;
  const rows = restRow ? [...top, restRow] : top;
  const env = environment === "production" ? "" : ` (${environment})`;

  const subject = `AWS cost${env} ${short}: ${m(s.dayTotal)}, ${monthName} so far ${m(s.monthTotal)}`;
  const missing = s.dayFound ? "" : `Cost Explorer has nothing for ${label} yet: the day's figures are still coming in.`;
  const perDay = `about ${m(s.monthTotal / Math.max(1, s.daysWithCost))} a day${s.daysWithCost < days ? ` over the ${s.daysWithCost} day${s.daysWithCost === 1 ? "" : "s"} Cost Explorer has` : ""}`;

  const width = Math.max(28, ...rows.map((r) => r.service.length)) + 2;
  const line = (a: string, b: string, c: string) => `${a.padEnd(width)}${b.padStart(12)}${c.padStart(16)}`;
  const text = [
    `${label} (UTC): ${m(s.dayTotal)}`,
    `${monthName} so far (${span}): ${m(s.monthTotal)}, ${perDay}`,
    ...(missing ? ["", missing] : []),
    "",
    line("Service", short, `${monthName.slice(0, 3)} so far`),
    ...rows.map((r) => line(r.service, m(r.day), m(r.month))),
    line("Total", m(s.dayTotal), m(s.monthTotal)),
    "",
    CAVEAT,
    "",
    `Sent once a day by insights-${environment}-cron from Cost Explorer (UnblendedCost by service; one call a day, US$0.01). docs/aws-deployment.md, Cost.`,
  ].join("\n");

  const td = 'style="padding:4px 8px;border-bottom:1px solid #e5e7eb;text-align:left"';
  const num = 'style="padding:4px 8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap"';
  const html = [
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827;max-width:640px">',
    `<p style="margin:0 0 4px"><b>${esc(label)} (UTC): ${esc(m(s.dayTotal))}</b></p>`,
    `<p style="margin:0 0 16px">${esc(monthName)} so far (${esc(span)}): <b>${esc(m(s.monthTotal))}</b>, ${esc(perDay)}</p>`,
    missing ? `<p style="margin:0 0 16px;color:#b45309">${esc(missing)}</p>` : "",
    '<table style="border-collapse:collapse;width:100%">',
    `<tr><th ${td}>Service</th><th ${num}>${esc(short)}</th><th ${num}>${esc(monthName.slice(0, 3))} so far</th></tr>`,
    ...rows.map((r) => `<tr><td ${td}>${esc(r.service)}</td><td ${num}>${esc(m(r.day))}</td><td ${num}>${esc(m(r.month))}</td></tr>`),
    `<tr><td ${td}><b>Total</b></td><td ${num}><b>${esc(m(s.dayTotal))}</b></td><td ${num}><b>${esc(m(s.monthTotal))}</b></td></tr>`,
    "</table>",
    `<p style="margin:16px 0 0;font-size:13px;color:#374151">${esc(CAVEAT)}</p>`,
    `<p style="margin:12px 0 0;font-size:12px;color:#6b7280">Sent once a day by insights-${esc(environment)}-cron from Cost Explorer (UnblendedCost by service; one call a day, US$0.01). docs/aws-deployment.md, Cost.</p>`,
    "</div>",
  ].join("");
  return { subject, text, html };
}

/** Pages followed at most: each is another paid call, and a month of ~20 services fits in one. */
const MAX_PAGES = 3;

/** Cost Explorer's answer for a period: one call, more only if it pages (it hasn't at this size). */
export async function fetchCosts(call: <T>(operation: string, body: Record<string, unknown>) => Promise<T>, period: { start: string; end: string }): Promise<CostExplorerPage[]> {
  const pages: CostExplorerPage[] = [];
  let token: string | undefined;
  do {
    const page = await call<CostExplorerPage>("GetCostAndUsage", costRequest(period, token));
    pages.push(page);
    token = page.NextPageToken || undefined;
  } while (token && pages.length < MAX_PAGES);
  if (token) logger.warn({ pages: pages.length }, "cost report: Cost Explorer had more pages than read; the figures are short");
  return pages;
}

export interface CostReportDeps {
  /** Signed Cost Explorer JSON calls (us-east-1: Cost Explorer has one endpoint). */
  call: <T>(operation: string, body: Record<string, unknown>) => Promise<T>;
  mailer: Mailer;
  /** Where the report goes (never logged). */
  to: string;
  environment: string;
  now?: Date;
  /** Makes the provider's idempotency key, so a retried invocation doesn't send a second copy. */
  invocationId?: string;
}

export type CostReportResult = { sent: true; day: string; dayTotal: number; monthTotal: number; services: number; pages: number; provider: string | null; messageId: string | null };

export async function sendCostReport(deps: CostReportDeps): Promise<CostReportResult> {
  const period = reportPeriod(deps.now ?? new Date());
  const pages = await fetchCosts(deps.call, period);
  const summary = summarizeCosts(pages, period.day);
  const message = costEmail(summary, deps.environment);
  const receipt = await deps.mailer.send(deps.to, message.subject, message.text, message.html, deps.invocationId ? { idempotencyKey: `cost-report-${period.day}-${deps.invocationId}` } : undefined);
  const result: CostReportResult = {
    sent: true,
    day: period.day,
    dayTotal: Math.round(summary.dayTotal * 100) / 100,
    monthTotal: Math.round(summary.monthTotal * 100) / 100,
    services: summary.services.length,
    pages: pages.length,
    provider: receipt ? receipt.provider : null,
    messageId: receipt ? receipt.messageId : null,
  };
  logger.info(result, "cost report sent");
  return result;
}

/** The Lambda side: Cost Explorer with the function's role, Resend with the app secret's key. */
export function costReportDeps(e: NodeJS.ProcessEnv, credentials: AwsCredentials, fetchImpl: FetchLike = fetch): Omit<CostReportDeps, "now" | "invocationId"> {
  const to = e.COST_REPORT_TO;
  if (!to) throw new Error("COST_REPORT_TO is not set: the cost report is off in this environment (config.ts costReport)");
  if (!e.RESEND_API_KEY) throw new Error("No mail provider for the cost report: RESEND_API_KEY is not in the app secret");
  return {
    call: jsonApi({ service: "ce", region: "us-east-1", credentials, jsonVersion: "1.1", targetPrefix: "AWSInsightsIndexService", fetchImpl: withTimeout(fetchImpl, 15_000) }),
    mailer: resendMailer({ apiKey: e.RESEND_API_KEY, fetchImpl: withTimeout(fetchImpl, 10_000) }),
    to,
    environment: e.APP_ENVIRONMENT || "production",
  };
}
