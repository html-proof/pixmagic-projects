/**
 * The Automations hub over its channel adapters: who may do what (from the member's access), the
 * connection cards, the triggers each channel can run for the store, every automation, one
 * message history across channels with one cursor, the period's figures and the audit trail.
 * Each call goes to the adapter of its channel; the hub itself keeps no state of its own.
 */
import { systemDb, withTenant } from "@app/db";
import { allows, type MemberAccess } from "@app/shared/access";
import {
  acceptanceRate,
  deliveryRate,
  HUB_BUILDABLE,
  HUB_TRIGGER_INFO,
  HUB_TRIGGERS,
  zeroCounts,
  type HubAction,
  type HubChannel,
  type HubCounts,
  type HubStatus,
} from "@app/shared/automations";
import {
  CHANNEL_RANK,
  encodeCursor,
  HubError,
  hubNotFound,
  type ChannelConnection,
  type ChannelStats,
  type HistoryFilter,
  type HubActor,
  type HubAutomation,
  type HubContext,
  type HubMessage,
  type HubPermissions,
  type HubTriggerState,
} from "./common.js";
import {
  actOnEmail,
  deleteEmailAutomation,
  emailAutomation,
  emailAutomations,
  emailConnection,
  emailDaily,
  emailHistory,
  emailMessageDetail,
  emailRetry,
  emailStats,
  emailTriggerStates,
  saveEmailAutomation,
  testEmailAutomation,
} from "./email.js";
import {
  actOnSms,
  deleteSmsAutomation,
  saveSmsAutomation,
  smsAutomation,
  smsAutomations,
  smsConnection,
  smsDaily,
  smsHistory,
  smsMessageDetail,
  smsRetry,
  smsStats,
  smsTriggerStates,
  testSmsAutomation,
} from "./sms.js";
import { whatsappConnection, whatsappTriggerStates } from "./whatsapp.js";

/** What a member may do on each channel: the same permissions each channel's own pages ask for. */
export function hubPermissions(access: MemberAccess): HubPermissions {
  const sms = allows(access, "marketing.campaigns");
  return {
    read: { sms, email: allows(access, "email:read"), whatsapp: sms },
    manage: { sms: allows(access, "stores:manage"), email: allows(access, "email:automate"), whatsapp: false },
    connect: { sms: allows(access, "stores:manage"), email: allows(access, "email:manage"), whatsapp: false },
    history: { sms, email: allows(access, "email:activity"), whatsapp: false },
    contacts: allows(access, "customers.contact"),
  };
}

const buildable = (channel: HubChannel) => {
  if (!HUB_BUILDABLE.includes(channel)) throw new HubError("WhatsApp automations are set up on the WhatsApp Automation page.", 409, "channel_elsewhere");
};

// ---------------------------------------------------------------------------
// Connections and triggers
// ---------------------------------------------------------------------------

export async function hubConnections(ctx: HubContext): Promise<ChannelConnection[]> {
  const [sms, email] = await Promise.all([smsConnection(ctx), emailConnection(ctx)]);
  return [whatsappConnection(ctx), sms, email];
}

/** Every trigger with its state on each channel for the page's store. `verify` asks Shopify about the store's per-store subscriptions first (SMS). */
export async function hubTriggers(ctx: HubContext, verify = false): Promise<HubTriggerState[]> {
  const [sms, email] = await Promise.all([smsTriggerStates(ctx, verify), emailTriggerStates(ctx)]);
  const wa = whatsappTriggerStates();
  return HUB_TRIGGERS.map((key) => {
    const info = HUB_TRIGGER_INFO[key];
    return { key, label: info.label, description: info.description, icon: info.icon, main: info.main, instead: info.instead ?? null, channels: { sms: sms.get(key)!, email: email.get(key)!, whatsapp: wa.get(key)! } };
  });
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export async function hubAutomations(ctx: HubContext): Promise<HubAutomation[]> {
  const [sms, email] = await Promise.all([smsAutomations(ctx), emailAutomations(ctx)]);
  return [...sms, ...email].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export function hubAutomation(ctx: HubContext, channel: HubChannel, id: string): Promise<HubAutomation> {
  buildable(channel);
  return channel === "sms" ? smsAutomation(ctx, id) : emailAutomation(ctx, id);
}

export function saveHubAutomation(ctx: HubContext, channel: HubChannel, id: string | null, input: unknown, actor: HubActor): Promise<HubAutomation> {
  buildable(channel);
  return channel === "sms" ? saveSmsAutomation(ctx, id, input, actor) : saveEmailAutomation(ctx, id, input, actor);
}

export function actOnHubAutomation(ctx: HubContext, channel: HubChannel, id: string, action: HubAction, confirm: boolean, actor: HubActor): Promise<HubAutomation> {
  buildable(channel);
  return channel === "sms" ? actOnSms(ctx, id, action, confirm, actor) : actOnEmail(ctx, id, action, confirm, actor);
}

export function deleteHubAutomation(ctx: HubContext, channel: HubChannel, id: string, actor: HubActor): Promise<{ cancelled: number }> {
  buildable(channel);
  return channel === "sms" ? deleteSmsAutomation(ctx, id, actor) : deleteEmailAutomation(ctx, id, actor);
}

/** A test of the automation's saved message: SMS to one of the team's verified numbers, email to the member's own address. */
export function testHubAutomation(ctx: HubContext, channel: HubChannel, id: string, input: { testNumberId?: string | null; requestId?: string | null }, actor: HubActor): Promise<HubMessage> {
  buildable(channel);
  if (channel === "sms") {
    if (!input.testNumberId) throw new HubError("Choose one of your verified test numbers.", 400, "test_number_required");
    return testSmsAutomation(ctx, id, input.testNumberId, input.requestId ?? null, actor);
  }
  return testEmailAutomation(ctx, id, actor);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Newest first; at the same instant SMS before email; within a channel, its own order (id descending). */
function merge(a: HubMessage[], b: HubMessage[]): HubMessage[] {
  const out: HubMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (!y || (x && (x.createdAt.getTime() > y.createdAt.getTime() || (x.createdAt.getTime() === y.createdAt.getTime() && CHANNEL_RANK[x.channel] <= CHANNEL_RANK[y.channel])))) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}

/** One page of the merged history. Each channel is asked for one more than a page, so the merge knows whether anything is left. */
export async function hubHistory(ctx: HubContext, f: HistoryFilter): Promise<{ messages: HubMessage[]; nextCursor: string | null }> {
  const [sms, email] = await Promise.all([smsHistory(ctx, f), emailHistory(ctx, f)]);
  const all = merge(sms, email);
  const page = all.slice(0, f.limit);
  const last = page[page.length - 1];
  return { messages: page, nextCursor: all.length > f.limit && last ? encodeCursor({ at: last.createdAt, channel: last.channel, id: last.id }) : null };
}

export function hubMessageDetail(ctx: HubContext, channel: HubChannel, id: string) {
  if (channel === "sms") return smsMessageDetail(ctx, id);
  if (channel === "email") return emailMessageDetail(ctx, id);
  throw hubNotFound();
}

export function retryHubMessage(ctx: HubContext, channel: HubChannel, id: string, actor: HubActor): Promise<HubMessage> {
  if (channel === "sms") return smsRetry(ctx, id);
  if (channel === "email") return emailRetry(ctx, id, actor);
  throw hubNotFound();
}

/** The period's figures per channel, all channels together, and per day (in the store's time zone, else UTC). */
export async function hubStats(ctx: HubContext, from: Date, to: Date) {
  const timeZone = ctx.store?.timezone || "UTC";
  const [sms, email, smsDays, emailDays] = await Promise.all([smsStats(ctx, from, to), emailStats(ctx, from, to), smsDaily(ctx, from, to, timeZone), emailDaily(ctx, from, to, timeZone)]);
  const channels = [sms, email].filter((c): c is ChannelStats => !!c);
  const totals = zeroCounts();
  for (const c of channels) for (const [k, v] of Object.entries(c.totals)) totals[k as HubStatus] += v;
  const days = new Map<string, HubCounts>();
  for (const r of [...smsDays, ...emailDays]) {
    const c = days.get(r.day) ?? zeroCounts();
    c[r.status] += r.n;
    days.set(r.day, c);
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    timeZone,
    channels,
    totals,
    deliveryRate: deliveryRate(totals),
    acceptanceRate: acceptanceRate(totals),
    byDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, counts]) => ({ day, counts })),
  };
}

// ---------------------------------------------------------------------------
// The audit trail: every configuration change of both channels, newest first
// ---------------------------------------------------------------------------

const ACTION_WORDS: Record<string, string> = {
  automation_activated: "Turned an automation on",
  automation_republished: "Put an automation's changes live",
  rule_created: "Created an automation",
  rule_updated: "Changed an automation",
  rule_paused: "Paused an automation",
  rule_resumed: "Resumed an automation",
  rule_disabled: "Disabled an automation",
  rule_deleted: "Deleted an automation",
  rule_approved: "Approved an automation",
  rule_submitted: "Sent an automation for approval",
  template_created: "Wrote a message",
  template_updated: "Changed a message",
  setup_connected: "Connected SMS",
  setup_connect_failed: "Tried to connect SMS",
  setup_disconnected: "Disconnected SMS",
  sending_enabled: "Switched texting on",
  sending_disabled: "Switched texting off",
  "email.automation.created": "Created an automation",
  "email.automation.updated": "Changed an automation",
  "email.automation.enabled": "Turned an automation on",
  "email.automation.disabled": "Turned an automation off",
  "email.automation.deleted": "Deleted an automation",
  "email.template.created": "Wrote a message",
  "email.template.updated": "Changed a message",
  "email.account.connected": "Connected a mailbox",
  "email.account.disconnected": "Disconnected a mailbox",
  "email.account.tested": "Tested a mailbox",
  "email.message.retried": "Sent a message again",
  "email.message.cancelled": "Cancelled a message",
};

export const auditWords = (action: string) => ACTION_WORDS[action] ?? action.replace(/^email\./, "").replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Only what doesn't identify a customer or carry a secret: the change's own small facts. */
function safeMetadata(m: unknown): Record<string, string | number | boolean> | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (/number|phone|email|address|token|secret|password|code/i.test(k)) continue;
    if (typeof v === "string" ? v.length <= 120 : typeof v === "number" || typeof v === "boolean") out[k] = v as string | number | boolean;
    if (Object.keys(out).length >= 8) break;
  }
  return Object.keys(out).length ? out : null;
}

export interface AuditEntry {
  channel: HubChannel;
  id: string;
  at: Date;
  action: string;
  label: string;
  actor: string;
  target: { type: string | null; id: string | null };
  detail: Record<string, string | number | boolean> | null;
}

/**
 * Both channels' audit trails merged (owners and admins: the API checks audit:read). SMS's is the
 * store's; email's is the workspace's email entries. `before` pages back by time.
 */
export async function hubAudit(ctx: HubContext, opts: { before: Date | null; limit: number }): Promise<{ entries: AuditEntry[]; nextBefore: string | null }> {
  const before = opts.before ? { lt: opts.before } : undefined;
  const [sms, email] = await Promise.all([
    ctx.store && ctx.can.read.sms
      ? systemDb.smsAuditLog.findMany({ where: { workspaceId: ctx.workspaceId, storeId: ctx.store.id, ...(before ? { createdAt: before } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.limit + 1 })
      : [],
    ctx.can.read.email
      ? withTenant(ctx.workspaceId, (tx) => tx.auditLog.findMany({ where: { workspaceId: ctx.workspaceId, action: { startsWith: "email." }, ...(before ? { createdAt: before } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.limit + 1 }))
      : [],
  ]);
  const actorIds = [...new Set([...sms, ...email].map((e) => e.actorUserId).filter((x): x is string => !!x))];
  const users = actorIds.length ? await systemDb.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, displayName: true } }) : [];
  const who = new Map(users.map((u) => [u.id, u.displayName || u.email]));
  const name = (id: string | null) => (id ? (who.get(id) ?? "A former member") : "bizinsights");
  const all: AuditEntry[] = [
    ...sms.map((e) => ({ channel: "sms" as const, id: e.id, at: e.createdAt, action: e.action, label: auditWords(e.action), actor: name(e.actorUserId), target: { type: e.targetType, id: e.targetId }, detail: safeMetadata(e.metadata) })),
    ...email.map((e) => ({ channel: "email" as const, id: e.id, at: e.createdAt, action: e.action, label: auditWords(e.action), actor: name(e.actorUserId), target: { type: e.targetType, id: e.targetId }, detail: safeMetadata(e.metadata) })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  // A page ends where a whole instant ends, so paging by time never skips an entry.
  let page = all.slice(0, opts.limit);
  const more = all.length > opts.limit;
  if (more) {
    const cut = page[page.length - 1]!.at.getTime();
    const whole = page.filter((e) => e.at.getTime() !== cut);
    if (whole.length) page = whole;
  }
  return { entries: page, nextBefore: more ? page[page.length - 1]!.at.toISOString() : null };
}
