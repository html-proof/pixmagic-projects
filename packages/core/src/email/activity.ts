/**
 * What the dashboard shows about sending: the activity log (server-side filters and pages), one
 * message's history, and the numbers. Every number is counted from email_messages; anything the
 * providers don't report (delivery, opens, clicks) is reported as unavailable, never estimated.
 */
import { Prisma, withTenant } from "@app/db";
import { accountNeedsAttention, MESSAGE_STATUSES, normalizeEmail, type MessageStatus } from "@app/shared/email";
import { notFound, recipientHash } from "./common.js";
import { emailOAuthConfigured } from "./oauth.js";
import { AAD, open } from "./vault.js";

export interface MessageFilters {
  from?: Date;
  to?: Date;
  status?: MessageStatus[];
  accountId?: string;
  provider?: string;
  ruleId?: string;
  kind?: string;
  recipient?: string;
  cursor?: string;
  limit: number;
}

function whereFor(workspaceId: string, f: MessageFilters): Prisma.EmailMessageWhereInput {
  const recipient = f.recipient ? normalizeEmail(f.recipient) : null;
  return {
    workspaceId,
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } } : {}),
    ...(f.status?.length ? { status: { in: f.status } } : {}),
    ...(f.accountId ? { emailAccountId: f.accountId } : {}),
    ...(f.provider ? { provider: f.provider } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    // An exact address, matched by its hash: the log can't be searched by fragments of addresses.
    ...(f.recipient ? { recipientHash: recipient ? recipientHash(workspaceId, recipient) : "none" } : {}),
  };
}

export async function listMessages(workspaceId: string, f: MessageFilters) {
  const rows = await withTenant(workspaceId, (tx) =>
    tx.emailMessage.findMany({
      where: whereFor(workspaceId, f),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: f.limit + 1,
      ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    }),
  );
  const page = rows.slice(0, f.limit);
  const [accounts, rules] = await withTenant(workspaceId, (tx) =>
    Promise.all([
      tx.emailAccount.findMany({ where: { workspaceId, id: { in: [...new Set(page.map((m) => m.emailAccountId))] } }, select: { id: true, emailAddress: true, provider: true } }),
      tx.emailAutomationRule.findMany({ where: { workspaceId, id: { in: [...new Set(page.map((m) => m.ruleId).filter((r): r is string => !!r))] } }, select: { id: true, name: true } }),
    ]),
  );
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const rule = new Map(rules.map((r) => [r.id, r.name]));
  return {
    messages: page.map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      scheduledAt: m.scheduledAt,
      recipient: open(m.recipientEnc, AAD.recipient(workspaceId)),
      sender: m.senderAddress,
      account: acct.get(m.emailAccountId)?.emailAddress ?? null,
      accountId: m.emailAccountId,
      provider: m.provider,
      kind: m.kind,
      category: m.category,
      ruleId: m.ruleId,
      rule: m.ruleId ? (rule.get(m.ruleId) ?? null) : null,
      subject: m.subject,
      status: m.status,
      attempts: m.attempts,
      providerAcceptedAt: m.providerAcceptedAt,
      failedAt: m.failedAt,
      errorCode: m.lastErrorCode,
      errorMessage: m.lastErrorMessage,
    })),
    nextCursor: rows.length > f.limit ? page[page.length - 1]!.id : null,
  };
}

export async function getMessage(workspaceId: string, id: string) {
  const m = await withTenant(workspaceId, (tx) => tx.emailMessage.findFirst({ where: { id, workspaceId }, include: { events: { orderBy: { eventTimestamp: "asc" } } } }));
  if (!m) throw notFound();
  const [account, rule, template] = await withTenant(workspaceId, (tx) =>
    Promise.all([
      tx.emailAccount.findFirst({ where: { id: m.emailAccountId, workspaceId }, select: { emailAddress: true, provider: true } }),
      m.ruleId ? tx.emailAutomationRule.findFirst({ where: { id: m.ruleId, workspaceId }, select: { name: true } }) : null,
      m.templateId ? tx.emailTemplate.findFirst({ where: { id: m.templateId, workspaceId }, select: { name: true } }) : null,
    ]),
  );
  return {
    id: m.id,
    createdAt: m.createdAt,
    scheduledAt: m.scheduledAt,
    recipient: open(m.recipientEnc, AAD.recipient(workspaceId)),
    sender: m.senderAddress,
    account: account?.emailAddress ?? null,
    provider: m.provider,
    kind: m.kind,
    category: m.category,
    rule: rule?.name ?? null,
    ruleId: m.ruleId,
    template: template?.name ?? null,
    templateVersion: m.templateVersion,
    subject: m.subject,
    status: m.status,
    attempts: m.attempts,
    maxAttempts: m.maxAttempts,
    messageIdHeader: m.internetMessageId,
    providerMessageId: m.providerMessageId,
    providerAcceptedAt: m.providerAcceptedAt,
    deliveredAt: m.deliveredAt,
    failedAt: m.failedAt,
    cancelledAt: m.cancelledAt,
    errorCode: m.lastErrorCode,
    errorMessage: m.lastErrorMessage,
    events: m.events.map((e) => ({ type: e.eventType, at: e.eventTimestamp, metadata: e.metadata })),
  };
}

type Counts = Record<MessageStatus, number>;
const zero = (): Counts => Object.fromEntries(MESSAGE_STATUSES.map((s) => [s, 0])) as Counts;

/** Message counts by status and day (UTC), by account and by automation, for a period. */
export async function emailAnalytics(workspaceId: string, from: Date, to: Date) {
  const [byStatus, byDay, byAccount, byRule] = await withTenant(workspaceId, (tx) =>
    Promise.all([
      tx.emailMessage.groupBy({ by: ["status"], where: { workspaceId, createdAt: { gte: from, lt: to } }, _count: { _all: true } }),
      tx.$queryRaw<Array<{ day: string; status: string; n: bigint }>>`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, status, count(*) AS n
        FROM email_messages WHERE workspace_id = ${workspaceId} AND created_at >= ${from} AND created_at < ${to}
        GROUP BY 1, 2 ORDER BY 1`,
      tx.emailMessage.groupBy({ by: ["emailAccountId", "status"], where: { workspaceId, createdAt: { gte: from, lt: to } }, _count: { _all: true } }),
      tx.emailMessage.groupBy({ by: ["ruleId", "status"], where: { workspaceId, createdAt: { gte: from, lt: to }, ruleId: { not: null } }, _count: { _all: true } }),
    ]),
  );
  const totals = zero();
  for (const r of byStatus) totals[r.status as MessageStatus] = r._count._all;
  const days = new Map<string, Counts>();
  for (const r of byDay) {
    const c = days.get(r.day) ?? zero();
    c[r.status as MessageStatus] = Number(r.n);
    days.set(r.day, c);
  }
  const group = <K extends string>(rows: Array<{ status: string; _count: { _all: number } } & Record<K, string | null>>, key: K) => {
    const out = new Map<string, Counts>();
    for (const r of rows) {
      const id = r[key];
      if (!id) continue;
      const c = out.get(id) ?? zero();
      c[r.status as MessageStatus] = r._count._all;
      out.set(id, c);
    }
    return [...out].map(([id, counts]) => ({ id, counts }));
  };
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals,
    byDay: [...days].map(([day, counts]) => ({ day, counts })),
    byAccount: group(byAccount as never, "emailAccountId"),
    byRule: group(byRule as never, "ruleId"),
    /** Not reported by Gmail, Microsoft Graph or SMTP with send-only access, so never shown as numbers. */
    unavailable: { delivered: "Delivery confirmations aren't reported by the connected providers.", opens: "Opens aren't tracked.", clicks: "Clicks aren't tracked." },
  };
}

/** The Email integrations overview: accounts, domains, automations and the period's messages. */
export async function emailOverview(workspaceId: string, from: Date, to: Date) {
  const [accounts, domains, activeRules, rules, templates, settings] = await withTenant(workspaceId, (tx) =>
    Promise.all([
      tx.emailAccount.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, status: true, provider: true, emailAddress: true, statusReason: true } }),
      tx.emailDomain.groupBy({ by: ["verificationStatus"], where: { workspaceId }, _count: { _all: true } }),
      tx.emailAutomationRule.count({ where: { workspaceId, deletedAt: null, enabled: true } }),
      tx.emailAutomationRule.count({ where: { workspaceId, deletedAt: null } }),
      tx.emailTemplate.count({ where: { workspaceId, deletedAt: null } }),
      tx.emailSettings.findUnique({ where: { workspaceId } }),
    ]),
  );
  const analytics = await emailAnalytics(workspaceId, from, to);
  const domainCount = (s: string) => domains.find((d) => d.verificationStatus === s)?._count._all ?? 0;
  const t = analytics.totals;
  return {
    accounts: {
      total: accounts.length,
      healthy: accounts.filter((a) => a.status === "connected").length,
      attention: accounts.filter((a) => accountNeedsAttention(a.status)).map((a) => ({ id: a.id, email: a.emailAddress, provider: a.provider, status: a.status, reason: a.statusReason })),
      disabled: accounts.filter((a) => a.status === "disabled").length,
    },
    domains: { total: domains.reduce((n, d) => n + d._count._all, 0), verified: domainCount("verified") + domainCount("recheck_required") },
    automations: { active: activeRules, total: rules },
    templates,
    messages: {
      queued: t.queued + t.processing + t.deferred,
      accepted: t.accepted_by_provider,
      // Only with evidence from the recipient's side, which none of today's connections provide.
      delivered: t.delivered > 0 ? t.delivered : null,
      failed: t.failed + t.bounced,
      suppressed: t.suppressed,
      cancelled: t.cancelled,
      unknown: t.unknown,
    },
    analytics,
    sending: { paused: settings?.sendingPaused ?? false, suspended: !!settings?.suspendedAt },
    providersConfigured: emailOAuthConfigured(),
  };
}
