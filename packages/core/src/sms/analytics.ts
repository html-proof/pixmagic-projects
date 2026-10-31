/**
 * Customer Messaging's figures, all from the rows: what was asked for, what AWS accepted, what the
 * carriers reported, what AWS charged and the orders that followed a text. Nothing is estimated
 * here except where it says so (texts AWS hasn't priced yet), and attributed revenue is shown as
 * what it is: orders that followed a text, not orders a text caused (ATTRIBUTION_RULE).
 */
import { Prisma, systemDb, type SmsSenderConfiguration, type Store } from "@app/db";
import { addDays, localDay } from "@app/shared";
import { billingMonth, smsRoi } from "@app/shared/sms";
import { endOfLocalDay, startOfLocalDay } from "@app/shared/staff";
import { marketingSwitchedOn, monthSpend, senderProblem, smsMode } from "./common.js";

export interface SmsFilters {
  from: string;
  to: string;
  country?: string | null;
  campaignId?: string | null;
  ruleId?: string | null;
}

function where(store: Pick<Store, "id" | "timezone">, f: SmsFilters): Prisma.SmsMessageJobWhereInput {
  return {
    storeId: store.id,
    purpose: { not: "test" },
    createdAt: { gte: new Date(startOfLocalDay(f.from, store.timezone)), lt: new Date(endOfLocalDay(f.to, store.timezone)) },
    ...(f.country ? { destinationCountry: f.country } : {}),
    ...(f.campaignId ? { campaignId: f.campaignId } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

export interface StatusCounts {
  requested: number;
  accepted: number;
  delivered: number;
  carrierAccepted: number;
  pending: number;
  failed: number;
  unknown: number;
  optedOut: number;
  notSent: number;
  dryRun: number;
  scheduled: number;
}

export function countStatuses(groups: Array<{ status: string; _count: number }>): StatusCounts {
  const c = Object.fromEntries(groups.map((g) => [g.status, g._count])) as Record<string, number>;
  const n = (...k: string[]) => k.reduce((s, x) => s + (c[x] ?? 0), 0);
  return {
    // Requested: every text something asked for, sent or not (dry runs aside).
    requested: n("scheduled", "sending", "accepted", "pending", "delivered", "carrier_accepted", "failed", "unknown", "uncertain", "opted_out", "skipped", "cancelled"),
    accepted: n("accepted", "pending", "delivered", "carrier_accepted", "failed", "unknown"),
    delivered: n("delivered"),
    carrierAccepted: n("carrier_accepted"),
    pending: n("sending", "accepted", "pending"),
    failed: n("failed"),
    unknown: n("unknown", "uncertain"),
    optedOut: n("opted_out"),
    notSent: n("skipped", "cancelled"),
    dryRun: n("dry_run"),
    scheduled: n("scheduled"),
  };
}

/**
 * Delivery rate: of the texts whose outcome is final, the share the handset confirmed or the
 * carrier accepted where the network gives no handset receipt. Texts still waiting don't count
 * either way. Null with no final outcome yet.
 */
export function deliveryRate(c: StatusCounts): number | null {
  const final = c.delivered + c.carrierAccepted + c.failed + c.unknown;
  return final ? (c.delivered + c.carrierAccepted) / final : null;
}

export async function smsAnalytics(store: Pick<Store, "id" | "timezone" | "currency">, f: SmsFilters) {
  const w = where(store, f);
  const [statusGroups, byCountry, byCampaign, byRule, attributed, cost, costByCountry, daily] = await Promise.all([
    systemDb.smsMessageJob.groupBy({ by: ["status"], where: w, _count: true }),
    systemDb.smsMessageJob.groupBy({ by: ["destinationCountry", "status"], where: w, _count: true }),
    systemDb.smsMessageJob.groupBy({ by: ["campaignId", "status"], where: { ...w, campaignId: { not: null } }, _count: true }),
    systemDb.smsMessageJob.groupBy({ by: ["ruleId", "status"], where: { ...w, ruleId: { not: null } }, _count: true }),
    systemDb.smsMessageJob.groupBy({ by: ["attributedCurrency"], where: { ...w, attributedOrderId: { not: null } }, _count: true, _sum: { attributedRevenue: true } }),
    systemDb.smsMessageJob.aggregate({ where: w, _sum: { priceUsd: true, carrierFeeUsd: true } }),
    systemDb.smsMessageJob.groupBy({ by: ["destinationCountry"], where: { ...w, priceUsd: { not: null } }, _sum: { priceUsd: true, carrierFeeUsd: true } }),
    systemDb.$queryRaw<Array<{ day: string; status: string; n: bigint }>>`
      SELECT to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE ${store.timezone}, 'YYYY-MM-DD') AS day, status, count(*) AS n
      FROM sms_message_jobs
      WHERE store_id = ${store.id} AND purpose <> 'test'
        AND created_at >= ${new Date(startOfLocalDay(f.from, store.timezone))} AND created_at < ${new Date(endOfLocalDay(f.to, store.timezone))}
        AND (${f.country ?? null}::text IS NULL OR destination_country = ${f.country ?? null})
        AND (${f.campaignId ?? null}::text IS NULL OR campaign_id = ${f.campaignId ?? null})
        AND (${f.ruleId ?? null}::text IS NULL OR rule_id = ${f.ruleId ?? null})
      GROUP BY 1, 2 ORDER BY 1`,
  ]);
  const totals = countStatuses(statusGroups);
  const costUsd = Number(cost._sum.priceUsd ?? 0) + Number(cost._sum.carrierFeeUsd ?? 0);
  const group = <K extends string>(rows: Array<Record<K, string | null> & { status: string; _count: number }>, key: K) => {
    const m = new Map<string | null, Array<{ status: string; _count: number }>>();
    for (const r of rows) m.set(r[key], [...(m.get(r[key]) ?? []), { status: r.status, _count: r._count }]);
    return m;
  };
  const countryCost = new Map(costByCountry.map((g) => [g.destinationCountry, Number(g._sum.priceUsd ?? 0) + Number(g._sum.carrierFeeUsd ?? 0)]));
  const countries = [...group(byCountry as never, "destinationCountry" as never).entries()].map(([country, rows]) => {
    const c = countStatuses(rows);
    return { country, ...c, deliveryRate: deliveryRate(c), costUsd: countryCost.get(country as string | null) ?? 0 };
  });

  const campaignIds = [...new Set(byCampaign.map((g) => g.campaignId).filter((x): x is string => !!x))];
  const ruleIds = [...new Set(byRule.map((g) => g.ruleId).filter((x): x is string => !!x))];
  const [campaigns, rules, campaignCost, ruleCost, campaignAttr, ruleAttr] = await Promise.all([
    systemDb.smsCampaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, status: true } }),
    systemDb.smsAutomationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true, status: true, activeTrigger: true } }),
    systemDb.smsMessageJob.groupBy({ by: ["campaignId"], where: { ...w, campaignId: { in: campaignIds } }, _sum: { priceUsd: true, carrierFeeUsd: true } }),
    systemDb.smsMessageJob.groupBy({ by: ["ruleId"], where: { ...w, ruleId: { in: ruleIds } }, _sum: { priceUsd: true, carrierFeeUsd: true } }),
    systemDb.smsMessageJob.groupBy({ by: ["campaignId", "attributedCurrency"], where: { ...w, campaignId: { in: campaignIds }, attributedOrderId: { not: null } }, _count: true, _sum: { attributedRevenue: true } }),
    systemDb.smsMessageJob.groupBy({ by: ["ruleId", "attributedCurrency"], where: { ...w, ruleId: { in: ruleIds }, attributedOrderId: { not: null } }, _count: true, _sum: { attributedRevenue: true } }),
  ]);
  /** Attributed orders and revenue for one campaign or rule: revenue (and ROI) only when its orders are in one currency. */
  const attributionOf = (rows: Array<{ attributedCurrency: string | null; _count: number; _sum: { attributedRevenue: Prisma.Decimal | null } }>, spend: number) => {
    const orders = rows.reduce((n, r) => n + r._count, 0);
    const single = rows.length === 1 ? rows[0]! : null;
    const revenue = single ? Number(single._sum.attributedRevenue ?? 0) : null;
    return { attributedOrders: orders, attributedRevenue: revenue, attributedCurrency: single?.attributedCurrency ?? null, roi: revenue === null ? null : smsRoi(revenue, spend) };
  };
  const sumCost = (s: { priceUsd: Prisma.Decimal | null; carrierFeeUsd: Prisma.Decimal | null }) => Number(s.priceUsd ?? 0) + Number(s.carrierFeeUsd ?? 0);
  const campaignRows = group(byCampaign as never, "campaignId" as never);
  const ruleRows = group(byRule as never, "ruleId" as never);
  const attributedRevenue = attributed.reduce((s, g) => s + Number(g._sum.attributedRevenue ?? 0), 0);
  return {
    range: { from: f.from, to: f.to },
    totals: { ...totals, deliveryRate: deliveryRate(totals) },
    costUsd,
    byCountry: countries.sort((a, b) => b.requested - a.requested),
    campaigns: campaigns.map((c) => {
      const counts = countStatuses(campaignRows.get(c.id) ?? []);
      const cost = campaignCost.find((g) => g.campaignId === c.id);
      const spend = cost ? sumCost(cost._sum) : 0;
      return { id: c.id, name: c.name, status: c.status, ...counts, deliveryRate: deliveryRate(counts), costUsd: spend, ...attributionOf(campaignAttr.filter((g) => g.campaignId === c.id), spend) };
    }),
    automations: rules.map((r) => {
      const counts = countStatuses(ruleRows.get(r.id) ?? []);
      const cost = ruleCost.find((g) => g.ruleId === r.id);
      const spend = cost ? sumCost(cost._sum) : 0;
      return { id: r.id, name: r.name, status: r.status, trigger: r.activeTrigger, ...counts, deliveryRate: deliveryRate(counts), costUsd: spend, ...attributionOf(ruleAttr.filter((g) => g.ruleId === r.id), spend) };
    }),
    attribution: {
      orders: attributed.reduce((s, g) => s + g._count, 0),
      byCurrency: attributed.map((g) => ({ currency: g.attributedCurrency ?? store.currency, orders: g._count, revenue: Number(g._sum.attributedRevenue ?? 0) })),
      // One total, and ROI, only when every attributed order is in one currency.
      revenue: attributed.length <= 1 ? attributedRevenue : null,
      currency: attributed.length === 1 ? (attributed[0]!.attributedCurrency ?? store.currency) : null,
      roi: attributed.length <= 1 ? smsRoi(attributedRevenue, costUsd) : null,
    },
    daily: daily.map((d) => ({ day: d.day, status: d.status, count: Number(d.n) })),
  };
}

export async function smsBilling(store: Pick<Store, "id">, sender: SmsSenderConfiguration | null, month = billingMonth(new Date())) {
  const [spend, byCountry, byCampaign, byRule, records] = await Promise.all([
    monthSpend(store.id, new Date(`${month}-15T00:00:00Z`)),
    systemDb.smsCostRecord.groupBy({ by: ["country"], where: { storeId: store.id, month }, _sum: { totalUsd: true, parts: true }, _count: true }),
    systemDb.smsCostRecord.groupBy({ by: ["campaignId"], where: { storeId: store.id, month, campaignId: { not: null } }, _sum: { totalUsd: true }, _count: true }),
    systemDb.smsCostRecord.groupBy({ by: ["ruleId"], where: { storeId: store.id, month, ruleId: { not: null } }, _sum: { totalUsd: true }, _count: true }),
    systemDb.smsCostRecord.findMany({ where: { storeId: store.id, month }, orderBy: { recordedAt: "desc" }, take: 50 }),
  ]);
  const names = async () => {
    const [c, r] = await Promise.all([
      systemDb.smsCampaign.findMany({ where: { id: { in: byCampaign.map((g) => g.campaignId!).filter(Boolean) } }, select: { id: true, name: true } }),
      systemDb.smsAutomationRule.findMany({ where: { id: { in: byRule.map((g) => g.ruleId!).filter(Boolean) } }, select: { id: true, name: true } }),
    ]);
    return { c: new Map(c.map((x) => [x.id, x.name])), r: new Map(r.map((x) => [x.id, x.name])) };
  };
  const n = await names();
  const budget = sender ? Number(sender.monthlyBudgetUsd) : 0;
  return {
    month,
    budgetUsd: budget,
    hardStop: sender?.hardStop ?? true,
    quota: sender?.monthlyMessageQuota ?? null,
    billedUsd: spend.billedUsd,
    pendingUsd: spend.pendingUsd,
    totalUsd: spend.totalUsd,
    messages: spend.messages,
    usedPct: budget > 0 ? Math.min(999, (spend.totalUsd / budget) * 100) : null,
    alertsRaised: ((sender?.budgetAlerts ?? {}) as { month?: string; levels?: number[] }).month === month ? (((sender?.budgetAlerts ?? {}) as { levels?: number[] }).levels ?? []) : [],
    byCountry: byCountry.map((g) => ({ country: g.country, messages: g._count, parts: g._sum.parts ?? 0, costUsd: Number(g._sum.totalUsd ?? 0) })).sort((a, b) => b.costUsd - a.costUsd),
    byCampaign: byCampaign.map((g) => ({ id: g.campaignId, name: n.c.get(g.campaignId!) ?? "Deleted campaign", messages: g._count, costUsd: Number(g._sum.totalUsd ?? 0) })),
    byRule: byRule.map((g) => ({ id: g.ruleId, name: n.r.get(g.ruleId!) ?? "Deleted rule", messages: g._count, costUsd: Number(g._sum.totalUsd ?? 0) })),
    records: records.map((r) => ({ id: r.id, jobId: r.jobId, country: r.country, parts: r.parts, priceUsd: Number(r.priceUsd), carrierFeeUsd: Number(r.carrierFeeUsd), totalUsd: Number(r.totalUsd), recordedAt: r.recordedAt })),
  };
}

/** The overview: what's set up, what's running, the last 7 days and what needs attention. */
export async function smsOverview(store: Pick<Store, "id" | "timezone" | "currency">) {
  const sender = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  const today = localDay(new Date(), store.timezone);
  const from = addDays(today, -6);
  const w = where(store, { from, to: today });
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  const [statusGroups, templates, rules, campaigns, contacts, subscribed, testNumbers, problems, scheduled, spend, sendableTemplates, pendingCampaigns] = await Promise.all([
    systemDb.smsMessageJob.groupBy({ by: ["status"], where: w, _count: true }),
    systemDb.smsTemplate.groupBy({ by: ["status"], where: { storeId: store.id }, _count: true }),
    systemDb.smsAutomationRule.groupBy({ by: ["status"], where: { storeId: store.id }, _count: true }),
    systemDb.smsCampaign.findMany({ where: { storeId: store.id, status: { in: ["pending_approval", "approved", "scheduled", "sending", "paused"] } }, select: { id: true, name: true, status: true, scheduledAt: true }, orderBy: { updatedAt: "desc" }, take: 5 }),
    systemDb.smsContact.count({ where: { storeId: store.id } }),
    systemDb.smsContact.count({ where: { storeId: store.id, consentState: "subscribed", suppressedAll: false, suppressedMarketing: false } }),
    systemDb.smsTestNumber.count({ where: { storeId: store.id, status: "verified" } }),
    systemDb.smsMessageJob.groupBy({ by: ["status"], where: { storeId: store.id, status: { in: ["failed", "uncertain", "unknown"] }, createdAt: { gte: weekAgo } }, _count: true }),
    systemDb.smsMessageJob.count({ where: { storeId: store.id, status: "scheduled" } }),
    monthSpend(store.id),
    // A template being edited after approval still sends its approved version.
    systemDb.smsTemplate.count({ where: { storeId: store.id, approvedVersion: { not: null }, status: { not: "archived" } } }),
    systemDb.smsCampaign.count({ where: { storeId: store.id, status: "pending_approval" } }),
  ]);
  const monthStart = `${localDay(new Date(), store.timezone).slice(0, 7)}-01`;
  const [pendingRules, monthGroups] = await Promise.all([
    systemDb.smsAutomationRule.count({ where: { storeId: store.id, submittedAt: { not: null } } }),
    systemDb.smsMessageJob.groupBy({ by: ["status"], where: where(store, { from: monthStart, to: today }), _count: true }),
  ]);
  const month = countStatuses(monthGroups);
  const totals = countStatuses(statusGroups);
  const byStatus = (g: Array<{ status: string; _count: number }>) => Object.fromEntries(g.map((x) => [x.status, x._count])) as Record<string, number>;
  const tpl = byStatus(templates);
  const rl = byStatus(rules);
  const budget = sender ? Number(sender.monthlyBudgetUsd) : 0;
  return {
    mode: smsMode(),
    marketingSwitch: marketingSwitchedOn(),
    sender: sender
      ? {
          problem: senderProblem(sender),
          identityCheck: sender.identityCheck,
          identityLabel: sender.identityLabel,
          registrationStatus: sender.registrationStatus,
          countries: sender.countries,
          sendingEnabled: sender.sendingEnabled,
          marketingEnabled: sender.marketingEnabled,
          transactionalBasis: sender.transactionalBasis,
          heldUntil: sender.heldUntil,
          heldReason: sender.heldReason,
        }
      : null,
    setup: {
      sender: !!sender,
      verified: sender?.identityCheck === "verified",
      budget: budget > 0,
      basis: (sender?.transactionalBasis ?? "none") !== "none",
      approvedTemplate: sendableTemplates > 0,
      activeRule: (rl.active ?? 0) > 0,
      testNumber: testNumbers > 0,
      sending: !!sender?.sendingEnabled,
    },
    last7Days: { ...totals, deliveryRate: deliveryRate(totals) },
    /** The store's calendar month so far (its time zone): what was sent and how it ended, and the cap on texts, if any. */
    thisMonth: { ...month, deliveryRate: deliveryRate(month), from: monthStart, quota: sender?.monthlyMessageQuota ?? null },
    scheduled,
    templates: tpl,
    rules: rl,
    pendingApprovals: { rules: pendingRules, templates: tpl.in_review ?? 0, campaigns: pendingCampaigns },
    campaigns,
    contacts,
    subscribed,
    attention: byStatus(problems),
    spend: { month: billingMonth(new Date()), totalUsd: spend.totalUsd, budgetUsd: budget, usedPct: budget > 0 ? (spend.totalUsd / budget) * 100 : null },
  };
}
