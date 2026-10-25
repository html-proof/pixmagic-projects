/**
 * The hub's SMS adapter: Customer Messaging (packages/core/src/sms) seen through the hub's shapes.
 * Every change goes through the SMS builder's own functions (save, activate, pause, delete, test),
 * with all their checks; the hub adds nothing that sends. SMS belongs to a store, so every call
 * needs the page's store.
 */
import { Prisma, systemDb, type SmsMessageJob, type Store } from "@app/db";
import {
  acceptanceRate,
  channelRuns,
  deliveryRate,
  hubActionsFor,
  hubTriggerOfSms,
  HUB_TRIGGER_INFO,
  HUB_TRIGGERS,
  smsHubStatusOf,
  SMS_STATUSES_FOR,
  zeroCounts,
  type HubAction,
  type HubAutomationStatus,
  type HubCounts,
  type HubStatus,
  type HubTrigger,
} from "@app/shared/automations";
import { DELIVERY_EXPLANATION, skipLabel, SMS_STATUS_LABEL, TRIGGER_INFO, type SmsStatus } from "@app/shared/sms";
import {
  activateAutomation,
  automationOf,
  connectSms,
  deleteAutomation,
  disconnectSms,
  listAutomations,
  monthSpend,
  pauseAutomation,
  ruleAction,
  saveAutomation,
  senderOf,
  senderProblem,
  sendingProblems,
  smsDecrypt,
  smsMode,
  testAutomation,
  triggerCapabilities,
  verifyTriggerSubscriptions,
  type AutomationView,
  type TriggerCapability,
} from "../sms/index.js";
import {
  forbidden,
  HubError,
  hubNotFound,
  type ChannelConnection,
  type ChannelProblem,
  type ChannelStats,
  type ChannelTriggerState,
  type HistoryFilter,
  type HubActor,
  type HubAutomation,
  type HubContext,
  type HubMessage,
} from "./common.js";

function storeOf(ctx: HubContext): Store {
  if (!ctx.store) throw new HubError("Choose a store first: texts are about a store's orders and customers.", 409, "store_required");
  return ctx.store;
}

const smsActor = (a: HubActor) => ({ userId: a.userId, ip: a.ip });

// ---------------------------------------------------------------------------
// Step 1: the connection
// ---------------------------------------------------------------------------

const IDENTITY_LABEL: Record<string, string> = { verified: "Approved by AWS", not_found: "Not found at AWS", not_allowed: "Not this workspace's", unverified: "Not checked yet" };

export async function smsConnection(ctx: HubContext): Promise<ChannelConnection> {
  const base: ChannelConnection = { channel: "sms", allowed: ctx.can.read.sms, state: "not_connected", summary: "", accounts: [], problems: [], checkedAt: null, actions: [], mode: null, oauth: null };
  if (!ctx.can.read.sms) return { ...base, summary: "You don't have access to Customer Messaging." };
  if (!ctx.store) return { ...base, state: "unavailable", summary: "Connect a Shopify store first: texts are about a store's orders and customers." };
  const store = ctx.store;
  const mode = smsMode();
  const [row, sender, problems] = await Promise.all([systemDb.smsSetup.findUnique({ where: { storeId: store.id } }), senderOf(store.id), sendingProblems(store)]);
  const out: ChannelProblem[] = problems.map((p) => ({ code: p.code, message: p.message, fix: p.fix }));
  const accounts = sender
    ? [
        {
          id: store.id,
          label: sender.identityLabel ?? sender.originationIdentity,
          detail: sender.countries.length ? `Texts to ${sender.countries.join(", ")}` : "No destination country switched on",
          status: sender.identityCheck ?? "unverified",
          statusLabel: IDENTITY_LABEL[sender.identityCheck ?? "unverified"] ?? sender.identityCheck ?? "Not checked yet",
          canSend: !senderProblem(sender) && sender.sendingEnabled,
        },
      ]
    : [];
  const connection = row?.connection ?? "not_connected";
  const manage = ctx.can.connect.sms;
  if (mode === "off") return { ...base, state: "unavailable", mode, accounts, problems: out, summary: "SMS isn't switched on for bizinsights yet." };
  if (connection === "connected") {
    // Test mode is the platform's state, not the store's: it doesn't stop the store being set up.
    const blocking = out.filter((p) => p.code !== "test_mode" && p.code !== "marketing_platform_off" && p.code !== "marketing_off");
    return {
      ...base,
      state: blocking.length ? "needs_attention" : "connected",
      mode,
      accounts,
      problems: out,
      checkedAt: row?.connectionCheckedAt ?? null,
      summary: blocking.length ? blocking[0]!.message : `Connected to AWS End User Messaging${accounts[0] ? `, sender ${accounts[0].label}` : ""}.`,
      actions: manage ? ["test", "disconnect"] : [],
    };
  }
  if (connection === "failed") {
    const why = row?.connectionError === "aws_unreachable" ? "AWS didn't answer. Try again in a moment." : row?.connectionError === "not_configured" ? "The platform's SMS account isn't set up at AWS yet." : "The connection check failed.";
    return { ...base, state: "needs_attention", mode, accounts, problems: [{ code: "connection_failed", message: why, fix: null }, ...out], checkedAt: row?.connectionCheckedAt ?? null, summary: why, actions: manage ? ["reconnect"] : [] };
  }
  return {
    ...base,
    mode,
    accounts,
    problems: out,
    summary: connection === "disconnected" ? "Disconnected: no texts go out until you reconnect." : "Not connected yet.",
    actions: manage ? [connection === "disconnected" ? "reconnect" : "connect"] : [],
  };
}

/** Connect, reconnect or test: ask AWS about the platform's SMS account now (the function's own role; no keys anywhere). */
export async function smsConnect(ctx: HubContext, actor: HubActor): Promise<ChannelConnection> {
  if (!ctx.can.connect.sms) throw forbidden();
  await connectSms(storeOf(ctx), ctx.deps, smsActor(actor));
  return smsConnection(ctx);
}

/** Texting stops at once (waiting texts are cancelled); the sender, messages and history stay. */
export async function smsDisconnect(ctx: HubContext, actor: HubActor): Promise<ChannelConnection> {
  if (!ctx.can.connect.sms) throw forbidden();
  await disconnectSms(storeOf(ctx), smsActor(actor));
  return smsConnection(ctx);
}

// ---------------------------------------------------------------------------
// Step 2: triggers
// ---------------------------------------------------------------------------

function triggerStateOf(cap: TriggerCapability | undefined, trigger: HubTrigger): ChannelTriggerState {
  const sms = HUB_TRIGGER_INFO[trigger].sms;
  const category = sms ? TRIGGER_INFO[sms].category : null;
  const runs = channelRuns(trigger, "sms");
  if (!runs.ok || !cap) return { state: "unavailable", reason: runs.ok ? "Not available for SMS." : runs.reason, lastEventAt: null, fix: null, category };
  const edit = { label: "Open it in Customer Messaging", href: `/messaging/automations/edit?trigger=${sms}` };
  switch (cap.state) {
    case "ready":
      return { state: "ready", reason: null, lastEventAt: cap.lastEventAt, fix: null, category };
    case "needs_permission":
      return { state: "needs_setup", reason: cap.reason, lastEventAt: cap.lastEventAt, fix: { label: "Give permission in Shopify", href: edit.href }, category };
    case "unchecked":
      return { state: "needs_setup", reason: "Not checked with Shopify yet: check it, and Shopify subscribes the store.", lastEventAt: cap.lastEventAt, fix: null, category };
    default:
      return { state: "unavailable", reason: cap.reason, lastEventAt: cap.lastEventAt, fix: null, category };
  }
}

export async function smsTriggerStates(ctx: HubContext, verify = false): Promise<Map<HubTrigger, ChannelTriggerState>> {
  const out = new Map<HubTrigger, ChannelTriggerState>();
  if (!ctx.store || !ctx.can.read.sms) {
    for (const t of HUB_TRIGGERS) out.set(t, { state: "unavailable", reason: ctx.store ? "You don't have access to Customer Messaging." : "Connect a Shopify store first.", lastEventAt: null, fix: null, category: null });
    return out;
  }
  const caps = verify ? await verifyTriggerSubscriptions(ctx.store, ctx.deps) : await triggerCapabilities(ctx.store, ctx.deps.coord);
  for (const t of HUB_TRIGGERS) {
    const sms = HUB_TRIGGER_INFO[t].sms;
    out.set(t, triggerStateOf(sms ? caps.find((c) => c.trigger === sms) : undefined, t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

/** Each rule's messages of the last 30 days, on the hub's scale (a failure after AWS accepted it is "undelivered"). */
async function countsByRule(storeId: string, ruleIds: string[]): Promise<Map<string, HubCounts>> {
  const out = new Map<string, HubCounts>();
  if (!ruleIds.length) return out;
  const since = new Date(Date.now() - 30 * 86400_000);
  const where = { storeId, ruleId: { in: ruleIds }, createdAt: { gte: since } };
  const [groups, undelivered] = await Promise.all([
    systemDb.smsMessageJob.groupBy({ by: ["ruleId", "status"], where, _count: { _all: true } }),
    systemDb.smsMessageJob.groupBy({ by: ["ruleId"], where: { ...where, status: "failed", acceptedAt: { not: null } }, _count: { _all: true } }),
  ]);
  for (const g of groups) {
    if (!g.ruleId) continue;
    const c = out.get(g.ruleId) ?? zeroCounts();
    c[smsHubStatusOf({ status: g.status, acceptedAt: null })] += g._count._all;
    out.set(g.ruleId, c);
  }
  for (const u of undelivered) {
    const c = u.ruleId ? out.get(u.ruleId) : undefined;
    if (!c) continue;
    c.failed -= u._count._all;
    c.undelivered += u._count._all;
  }
  return out;
}

function hubAutomationOf(a: AutomationView, counts: HubCounts | undefined, storeId: string, manage: boolean): HubAutomation {
  const trigger = hubTriggerOfSms(a.trigger);
  const status = a.status as HubAutomationStatus;
  return {
    channel: "sms",
    id: a.id,
    name: a.name,
    trigger,
    triggerLabel: trigger ? HUB_TRIGGER_INFO[trigger].label : (a.triggerLabel ?? "Its settings need fixing"),
    channelTrigger: a.trigger,
    category: a.category,
    status,
    actions: manage && a.config ? hubActionsFor("sms", status) : [],
    pendingChanges: a.pendingChanges,
    testMode: a.dryRun,
    subject: null,
    body: a.body,
    storeId,
    delayMinutes: a.config?.delayMinutes ?? 0,
    lastRunAt: a.lastRunAt,
    lastResult: a.lastResult ? { status: smsHubStatusOf({ status: a.lastResult.status, acceptedAt: null }), reason: a.lastResult.reasonLabel, at: a.lastResult.at } : null,
    last30Days: counts ?? zeroCounts(),
    editable: !!a.config,
    editHref: a.config ? `/automations/new?channel=sms&id=${encodeURIComponent(a.id)}` : `/messaging/automations/edit?id=${encodeURIComponent(a.id)}`,
    config: a.config ? { ...a.config } : null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export async function smsAutomations(ctx: HubContext): Promise<HubAutomation[]> {
  if (!ctx.store || !ctx.can.read.sms) return [];
  const list = await listAutomations(ctx.store);
  const counts = await countsByRule(ctx.store.id, list.map((a) => a.id));
  return list.map((a) => hubAutomationOf(a, counts.get(a.id), ctx.store!.id, ctx.can.manage.sms));
}

export async function smsAutomation(ctx: HubContext, id: string): Promise<HubAutomation> {
  if (!ctx.can.read.sms) throw hubNotFound();
  const store = storeOf(ctx);
  const a = await automationOf(store, id);
  return hubAutomationOf(a, (await countsByRule(store.id, [id])).get(id), store.id, ctx.can.manage.sms);
}

/** Save (new: id null): the message as the automation's own template, the settings as its rule. Nothing is sent by saving. */
export async function saveSmsAutomation(ctx: HubContext, id: string | null, input: unknown, actor: HubActor): Promise<HubAutomation> {
  if (!ctx.can.manage.sms) throw forbidden();
  const store = storeOf(ctx);
  if (id) await automationOf(store, id);
  const saved = await saveAutomation(store, id, input, smsActor(actor));
  return smsAutomation(ctx, saved.id);
}

/**
 * Turn on (or resume, or put saved changes live), pause or disable. Turning on approves the
 * message and the rule in the member's name and needs their confirmation; the SMS builder refuses
 * it for a trigger Shopify doesn't send this store.
 */
export async function actOnSms(ctx: HubContext, id: string, action: HubAction, confirm: boolean, actor: HubActor): Promise<HubAutomation> {
  if (!ctx.can.manage.sms) throw forbidden();
  const store = storeOf(ctx);
  const current = await automationOf(store, id);
  if (!hubActionsFor("sms", current.status as HubAutomationStatus).includes(action) && !(action === "activate" && current.status === "active" && current.pendingChanges)) {
    throw new HubError(`This automation can't be ${action === "activate" ? "turned on" : `${action}d`} while it is ${current.status.replace("_", " ")}.`, 409, "automation_state");
  }
  switch (action) {
    case "activate":
    case "resume":
      await activateAutomation(store, id, { confirm }, ctx.deps, smsActor(actor));
      break;
    case "pause":
      await pauseAutomation(store, id, smsActor(actor));
      break;
    case "disable":
      await ruleAction(store, id, "disable", smsActor(actor));
      break;
  }
  return smsAutomation(ctx, id);
}

export async function deleteSmsAutomation(ctx: HubContext, id: string, actor: HubActor): Promise<{ cancelled: number }> {
  if (!ctx.can.manage.sms) throw forbidden();
  const store = storeOf(ctx);
  await automationOf(store, id);
  return deleteAutomation(store, id, smsActor(actor));
}

/** The automation's saved message, with sample values, to one of the team's verified test numbers (one `requestId` per press). */
export async function testSmsAutomation(ctx: HubContext, id: string, testNumberId: string, requestId: string | null, actor: HubActor): Promise<HubMessage> {
  if (!ctx.can.manage.sms) throw forbidden();
  const store = storeOf(ctx);
  await automationOf(store, id);
  const job = await testAutomation(store, id, testNumberId, requestId, ctx.deps, smsActor(actor));
  return smsMessageOf(job, null, ctx.can.contacts);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const RETRY_NOTE: Partial<Record<HubStatus, string>> = {
  failed: "Texts AWS couldn't take because it was busy are retried automatically, up to 6 times. This one failed for the reason shown: fix it, and later texts will go.",
  undelivered: "The carrier refused it after AWS took it; sending it again would be refused the same way.",
  unknown: "AWS may have sent it, so it's never sent again: the customer can't get it twice.",
};

/** Why a text is where it is, in words: AWS's delivery report, or the reason it wasn't sent. */
function reasonOf(m: SmsMessageJob, status: HubStatus): string | null {
  const report = m.providerStatus ? (DELIVERY_EXPLANATION[m.providerStatus.toUpperCase()] ?? null) : null;
  if (status === "sent" || status === "delivered") return report;
  if (status === "undelivered") return report ?? skipLabel(m.reason) ?? "The carrier reported it undelivered.";
  return skipLabel(m.reason) ?? (m.errorCode ? m.errorCode.replace(/_/g, " ") : null);
}

function smsMessageOf(m: SmsMessageJob, ruleName: string | null, contacts: boolean): HubMessage {
  const status = smsHubStatusOf(m);
  const price = m.priceUsd === null ? null : Number(m.priceUsd) + Number(m.carrierFeeUsd ?? 0);
  return {
    channel: "sms",
    id: m.id,
    createdAt: m.createdAt,
    kind: m.purpose,
    automation: m.ruleId ? { id: m.ruleId, name: ruleName } : null,
    trigger: hubTriggerOfSms(m.trigger),
    to: contacts ? m.phoneMasked : null,
    subject: null,
    status,
    channelStatus: m.status,
    channelStatusLabel: SMS_STATUS_LABEL[m.status as SmsStatus] ?? m.status,
    reason: reasonOf(m, status),
    providerMessageId: m.providerMessageId,
    acceptedAt: m.acceptedAt,
    deliveredAt: m.status === "delivered" ? (m.providerStatusAt ?? m.finalAt) : null,
    finalAt: m.finalAt,
    attempts: m.attempts,
    costUsd: price,
    retryable: false,
    retryNote: RETRY_NOTE[status] ?? null,
  };
}

/** The rows behind a hub status filter (a failure after AWS accepted it is "undelivered"). */
function statusWhere(statuses: HubStatus[]): Prisma.SmsMessageJobWhereInput {
  if (!statuses.length) return {};
  return {
    OR: statuses.map((s): Prisma.SmsMessageJobWhereInput => {
      if (s === "failed") return { status: "failed", acceptedAt: null };
      if (s === "undelivered") return { status: "failed", acceptedAt: { not: null } };
      return { status: { in: [...SMS_STATUSES_FOR[s]] } };
    }),
  };
}

/** One page of the store's texts for the merged history, newest first (`limit + 1` rows, so the caller knows if there are more). */
export async function smsHistory(ctx: HubContext, f: HistoryFilter): Promise<HubMessage[]> {
  if (!ctx.store || !ctx.can.history.sms || !f.channels.includes("sms")) return [];
  if (f.automation && f.automation.channel !== "sms") return [];
  const c = f.cursor;
  // At the cursor's instant SMS comes first: after an SMS row, older ids; after an email row, none.
  const page: Prisma.SmsMessageJobWhereInput = !c ? {} : c.channel === "sms" ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] } : { createdAt: { lt: c.at } };
  const rows = await systemDb.smsMessageJob.findMany({
    where: { AND: [{ workspaceId: ctx.workspaceId, storeId: ctx.store.id, createdAt: { gte: f.from, lt: f.to } }, f.automation ? { ruleId: f.automation.id } : {}, statusWhere(f.statuses), page] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: f.limit + 1,
  });
  const names = await ruleNames(rows.map((r) => r.ruleId));
  return rows.map((r) => smsMessageOf(r, r.ruleId ? (names.get(r.ruleId) ?? null) : null, ctx.can.contacts));
}

async function ruleNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rules = await systemDb.smsAutomationRule.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(rules.map((r) => [r.id, r.name]));
}

/** One text with its delivery reports, and its words only for members who may see customers' details (and only while it is kept). */
export async function smsMessageDetail(ctx: HubContext, id: string) {
  if (!ctx.can.history.sms) throw hubNotFound();
  const store = storeOf(ctx);
  const m = await systemDb.smsMessageJob.findFirst({ where: { id, workspaceId: ctx.workspaceId, storeId: store.id }, include: { events: { orderBy: { eventAt: "asc" } } } });
  if (!m) throw hubNotFound();
  const names = await ruleNames([m.ruleId]);
  let text: string | null = null;
  if (ctx.can.contacts && m.bodyEnc) {
    try {
      text = smsDecrypt(m.storeId, "body", m.bodyEnc);
    } catch {
      text = null;
    }
  }
  return {
    message: smsMessageOf(m, m.ruleId ? (names.get(m.ruleId) ?? null) : null, ctx.can.contacts),
    text,
    timeline: [
      { at: m.createdAt, label: "Scheduled", detail: null as string | null },
      ...(m.acceptedAt ? [{ at: m.acceptedAt, label: "Accepted by AWS", detail: m.providerMessageId ? `Message id ${m.providerMessageId}` : null }] : []),
      ...m.events.map((e) => ({ at: e.eventAt, label: `AWS: ${e.messageStatus ?? e.eventType}`, detail: e.messageStatus ? (DELIVERY_EXPLANATION[e.messageStatus.toUpperCase()] ?? null) : null })),
      ...(m.finalAt && !m.events.length ? [{ at: m.finalAt, label: SMS_STATUS_LABEL[m.status as SmsStatus] ?? m.status, detail: skipLabel(m.reason) }] : []),
    ],
  };
}

export async function smsRetry(ctx: HubContext, id: string): Promise<never> {
  const { message } = await smsMessageDetail(ctx, id);
  throw new HubError(message.retryNote ?? "Only messages that failed can be retried.", 409, "not_retryable");
}

/** The period's texts on the hub's scale, what AWS billed for them, and this month's spend against the store's limit. */
export async function smsStats(ctx: HubContext, from: Date, to: Date): Promise<ChannelStats | null> {
  if (!ctx.store || !ctx.can.history.sms) return null;
  const where = { workspaceId: ctx.workspaceId, storeId: ctx.store.id, createdAt: { gte: from, lt: to } };
  const [groups, undelivered, billed, month, sender] = await Promise.all([
    systemDb.smsMessageJob.groupBy({ by: ["status"], where, _count: { _all: true } }),
    systemDb.smsMessageJob.count({ where: { ...where, status: "failed", acceptedAt: { not: null } } }),
    systemDb.smsMessageJob.aggregate({ where, _sum: { priceUsd: true, carrierFeeUsd: true } }),
    monthSpend(ctx.store.id),
    senderOf(ctx.store.id),
  ]);
  const totals = zeroCounts();
  for (const g of groups) totals[smsHubStatusOf({ status: g.status, acceptedAt: null })] += g._count._all;
  totals.failed -= undelivered;
  totals.undelivered += undelivered;
  const cost = billed._sum.priceUsd === null ? null : Number(billed._sum.priceUsd) + Number(billed._sum.carrierFeeUsd ?? 0);
  const usd = (n: number) => `US$${n.toFixed(2)}`;
  const rate = deliveryRate(totals);
  return {
    channel: "sms",
    totals,
    deliveryRate: rate,
    acceptanceRate: acceptanceRate(totals),
    deliveryNote: rate === null ? "No delivery reports in this period yet. AWS reports them up to 72 hours after a text." : null,
    usage: [
      { label: "Texts this month", value: String(month.messages) },
      { label: "Spent this month", value: sender && Number(sender.monthlyBudgetUsd) > 0 ? `${usd(month.totalUsd)} of ${usd(Number(sender.monthlyBudgetUsd))}` : usd(month.totalUsd) },
    ],
    costUsd: cost,
  };
}

/** The period's texts per day in `timeZone` (YYYY-MM-DD), on the hub's scale. */
export async function smsDaily(ctx: HubContext, from: Date, to: Date, timeZone: string): Promise<Array<{ day: string; status: HubStatus; n: number }>> {
  if (!ctx.store || !ctx.can.history.sms) return [];
  const rows = await systemDb.$queryRaw<Array<{ day: string; status: string; accepted: boolean; n: bigint }>>`
    SELECT to_char(date_trunc('day', (created_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS day, status, (accepted_at IS NOT NULL) AS accepted, count(*) AS n
    FROM sms_message_jobs
    WHERE workspace_id = ${ctx.workspaceId} AND store_id = ${ctx.store.id} AND created_at >= ${from} AND created_at < ${to}
    GROUP BY 1, 2, 3`;
  return rows.map((r) => ({ day: r.day, status: smsHubStatusOf({ status: r.status, acceptedAt: r.accepted ? from : null }), n: Number(r.n) }));
}
