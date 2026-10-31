/**
 * The hub's email adapter: the email module (packages/core/src/email) seen through the hub's
 * shapes. An email automation is the module's rule with a template of its own, written in the hub
 * as plain text (turned into simple HTML); every check of the module applies (verified sender,
 * active template, consent, suppression, limits). Email belongs to the workspace: an automation
 * may listen to one store's Shopify events, or to the business's own events through the event API.
 */
import { Prisma, systemDb, withTenant, type EmailMessage, type EmailTemplate } from "@app/db";
import {
  acceptanceRate,
  channelRuns,
  checkEmailMessage,
  deliveryRate,
  emailCategoryOf,
  emailEventFor,
  emailHubStatus,
  EMAIL_STATUSES_FOR,
  hasErrors,
  hubActionsFor,
  hubEmailAutomationSchema,
  hubTriggerOfEmail,
  HUB_TRIGGER_INFO,
  HUB_TRIGGERS,
  textToEmailHtml,
  zeroCounts,
  type HubAction,
  type HubAutomationStatus,
  type HubCounts,
  type HubStatus,
  type HubTrigger,
  type MessageCategory,
} from "@app/shared/automations";
import { ACCOUNT_STATUS_LABEL, accountCanSend, errorLabel, eventLabel, isCustomEventType, MESSAGE_STATUS_LABEL, PROVIDER_LABEL, sanitizeHtml, type AccountStatus, type EmailProvider, type MessageStatus } from "@app/shared/email";
import { appWebhookTopics } from "../apps.js";
import { emailRetryRefusal, retryEmailMessage, sendTemplateTest } from "../email/actions.js";
import { EmailError } from "../email/common.js";
import { createRule, deleteRule, getRule, listRules, setRuleEnabled, updateRule } from "../email/rules.js";
import { getEmailSettings } from "../email/settings.js";
import { createTemplate, updateTemplate } from "../email/templates.js";
import { disconnectEmailAccount, listEmailAccounts, testEmailConnection } from "../email/accounts.js";
import { emailOAuthConfigured } from "../email/oauth.js";
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

const SETTINGS = { label: "Email settings", href: "/settings/email/settings" };
const ACCOUNTS = { label: "Email accounts", href: "/settings/email/accounts" };

// ---------------------------------------------------------------------------
// Step 1: the connection
// ---------------------------------------------------------------------------

export async function emailConnection(ctx: HubContext): Promise<ChannelConnection> {
  const base: ChannelConnection = { channel: "email", allowed: ctx.can.read.email, state: "not_connected", summary: "", accounts: [], problems: [], checkedAt: null, actions: [], mode: null, oauth: null };
  if (!ctx.can.read.email) return { ...base, summary: "You don't have access to email integrations." };
  const [accounts, settings] = await Promise.all([listEmailAccounts(ctx.workspaceId), getEmailSettings(ctx.workspaceId)]);
  const oauth = emailOAuthConfigured();
  const connect = ctx.can.connect.email;
  if (!accounts.length) return { ...base, oauth, summary: "No mailbox connected yet.", actions: connect ? ["connect"] : [] };
  const problems: ChannelProblem[] = [];
  for (const a of accounts) {
    if (a.status === "reauthorization_required") problems.push({ code: "reauthorization_required", message: `${a.emailAddress} needs you to sign in again before it can send.`, fix: ACCOUNTS });
    else if (a.status === "failed" || a.status === "degraded") problems.push({ code: `account_${a.status}`, message: `${a.emailAddress}: ${ACCOUNT_STATUS_LABEL[a.status as AccountStatus] ?? a.status}${a.statusReason ? ` (${errorLabel(a.statusReason)})` : ""}.`, fix: ACCOUNTS });
    else if (a.status === "pending") problems.push({ code: "account_pending", message: `${a.emailAddress} hasn't been tested yet.`, fix: ACCOUNTS });
    else if (a.status === "disabled") problems.push({ code: "account_disabled", message: `${a.emailAddress} is switched off.`, fix: ACCOUNTS });
  }
  const sendable = accounts.filter((a) => accountCanSend(a.status));
  const verifiedSender = sendable.some((a) => a.senders.some((s) => s.authorizationStatus === "verified"));
  if (sendable.length && !verifiedSender) problems.push({ code: "no_verified_sender", message: "No sender address is verified yet.", fix: ACCOUNTS });
  if (settings.sendingPaused) problems.push({ code: "sending_paused", message: "Email sending is paused for this workspace: messages wait until it's resumed.", fix: SETTINGS });
  if (settings.suspended) problems.push({ code: "suspended", message: "Email sending was suspended by bizinsights. Contact support.", fix: null });
  const ready = sendable.length > 0 && verifiedSender && !settings.sendingPaused && !settings.suspended;
  const lastChecked = accounts.map((a) => a.lastVerifiedAt).reduce<Date | null>((x, y) => (y && (!x || y > x) ? y : x), null);
  return {
    ...base,
    state: ready && problems.every((p) => p.code === "account_disabled") ? "connected" : "needs_attention",
    summary: ready ? `Sending from ${sendable.map((a) => a.emailAddress).join(", ")}.` : (problems[0]?.message ?? "Connected, but nothing can send yet."),
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.emailAddress,
      detail: PROVIDER_LABEL[a.provider as EmailProvider] ?? a.provider,
      status: a.status,
      statusLabel: ACCOUNT_STATUS_LABEL[a.status as AccountStatus] ?? a.status,
      canSend: accountCanSend(a.status),
    })),
    problems,
    checkedAt: lastChecked,
    oauth,
    actions: connect ? ["connect", "test", ...(accounts.some((a) => a.status === "reauthorization_required") ? (["reconnect"] as const) : []), "disconnect"] : [],
  };
}

/** Ask the provider now whether the account can send (the module records the answer on the account). */
export async function emailTestConnection(ctx: HubContext, accountId: string, actor: HubActor): Promise<{ ok: boolean; code: string | null; message: string | null; connection: ChannelConnection }> {
  if (!ctx.can.connect.email) throw forbidden();
  const r = await testEmailConnection(ctx.workspaceId, accountId, ctx.deps, actor.userId);
  return { ok: r.ok, code: r.ok ? null : r.code, message: r.ok ? null : r.message, connection: await emailConnection(ctx) };
}

/** Disconnect a mailbox: its tokens or password are deleted (and revoked where the provider allows), its automations switched off, its waiting mail cancelled. */
export async function emailDisconnect(ctx: HubContext, accountId: string, actor: HubActor): Promise<ChannelConnection> {
  if (!ctx.can.connect.email) throw forbidden();
  await disconnectEmailAccount(ctx.workspaceId, accountId, actor.userId, ctx.deps);
  return emailConnection(ctx);
}

// ---------------------------------------------------------------------------
// Step 2: triggers
// ---------------------------------------------------------------------------

/** The Shopify topics each email event comes from (core email/events.ts). */
const EVENT_TOPICS: Record<string, string[]> = {
  "order.created": ["orders/create"],
  "order.paid": ["orders/paid"],
  "order.cancelled": ["orders/cancelled"],
  "order.fulfilled": ["orders/fulfilled"],
  "checkout.abandoned": ["checkouts/create", "checkouts/update"],
};

const NOT_SENT =
  "Your store is connected through bizinsights' App Store app, which Shopify doesn't send order and checkout events to until it approves bizinsights' access to protected customer data.";

function categoryFor(trigger: HubTrigger): MessageCategory | "either" {
  const c = HUB_TRIGGER_INFO[trigger].email;
  if (c === "custom") return "either";
  return trigger === "checkout_abandoned" ? "marketing" : "transactional";
}

/** Whether each trigger reaches email automations for this store (the store's app's topics, and when its events last arrived). */
export async function emailTriggerStates(ctx: HubContext, storeId: string | null = ctx.store?.id ?? null): Promise<Map<HubTrigger, ChannelTriggerState>> {
  const out = new Map<HubTrigger, ChannelTriggerState>();
  const store = storeId ? await withTenant(ctx.workspaceId, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ctx.workspaceId, status: { not: "uninstalled" } } })) : null;
  const topics = [...new Set(Object.values(EVENT_TOPICS).flat())];
  const seen = store
    ? await systemDb.webhookEvent.groupBy({ by: ["topic"], where: { storeId: store.id, topic: { in: topics }, receivedAt: { gte: new Date(Date.now() - 90 * 86400_000) } }, _max: { receivedAt: true } })
    : [];
  const lastOf = new Map(seen.map((s) => [s.topic, s._max.receivedAt]));
  const app = store ? appWebhookTopics(store.shopifyAppKey) : null;
  for (const t of HUB_TRIGGERS) {
    const runs = channelRuns(t, "email");
    const category = categoryFor(t);
    if (!ctx.can.read.email) {
      out.set(t, { state: "unavailable", reason: "You don't have access to email integrations.", lastEventAt: null, fix: null, category });
      continue;
    }
    if (!runs.ok) {
      out.set(t, { state: "unavailable", reason: runs.reason, lastEventAt: null, fix: null, category });
      continue;
    }
    const event = HUB_TRIGGER_INFO[t].email!;
    if (event === "custom") {
      out.set(t, { state: "ready", reason: "Your own system sends the event with an event API key.", lastEventAt: null, fix: { label: "Event API keys", href: SETTINGS.href }, category });
      continue;
    }
    if (!store) {
      out.set(t, { state: "unavailable", reason: "Connect a Shopify store first.", lastEventAt: null, fix: null, category });
      continue;
    }
    const its = EVENT_TOPICS[event] ?? [];
    const last = its.map((x) => lastOf.get(x) ?? null).reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);
    if (app && !its.some((x) => app.includes(x))) out.set(t, { state: "unavailable", reason: NOT_SENT, lastEventAt: last, fix: null, category });
    else if (!app && !last) out.set(t, { state: "unavailable", reason: "bizinsights can't tell which events your store's Shopify app sends.", lastEventAt: null, fix: null, category });
    else out.set(t, { state: "ready", reason: null, lastEventAt: last, fix: null, category });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

type RuleWithParts = Awaited<ReturnType<typeof listRules>>[number];

/** A template the hub wrote (plain text, turned into simple HTML), which its builder can edit without losing anything. */
const hubWritten = (t: Pick<EmailTemplate, "htmlTemplate" | "textTemplate">) => t.htmlTemplate === sanitizeHtml(textToEmailHtml(t.textTemplate), { allowPlaceholders: true });

async function countsByRule(workspaceId: string, ruleIds: string[]): Promise<Map<string, HubCounts>> {
  const out = new Map<string, HubCounts>();
  if (!ruleIds.length) return out;
  const groups = await withTenant(workspaceId, (tx) =>
    tx.emailMessage.groupBy({ by: ["ruleId", "status"], where: { workspaceId, ruleId: { in: ruleIds }, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _count: { _all: true } }),
  );
  for (const g of groups) {
    if (!g.ruleId) continue;
    const c = out.get(g.ruleId) ?? zeroCounts();
    c[emailHubStatus(g.status)] += g._count._all;
    out.set(g.ruleId, c);
  }
  return out;
}

async function views(ctx: HubContext, rules: RuleWithParts[]): Promise<HubAutomation[]> {
  if (!rules.length) return [];
  const ids = rules.map((r) => r.id);
  const [templates, everOn, counts, lasts] = await Promise.all([
    withTenant(ctx.workspaceId, (tx) => tx.emailTemplate.findMany({ where: { workspaceId: ctx.workspaceId, id: { in: [...new Set(rules.map((r) => r.templateId))] } } })),
    // "Paused" or "Draft" when off: whether it was ever switched on.
    withTenant(ctx.workspaceId, (tx) => tx.auditLog.findMany({ where: { workspaceId: ctx.workspaceId, action: "email.automation.enabled", targetId: { in: ids } }, select: { targetId: true }, distinct: ["targetId"] })),
    countsByRule(ctx.workspaceId, ids),
    Promise.all(ids.map((id) => withTenant(ctx.workspaceId, (tx) => tx.emailMessage.findFirst({ where: { workspaceId: ctx.workspaceId, ruleId: id }, orderBy: { createdAt: "desc" }, select: { status: true, lastErrorCode: true, createdAt: true } })))),
  ]);
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const wasOn = new Set(everOn.map((e) => e.targetId));
  return rules.map((r, i): HubAutomation => {
    const t = templateById.get(r.templateId);
    const trigger = hubTriggerOfEmail(r.eventType);
    const status: HubAutomationStatus = r.enabled ? "active" : wasOn.has(r.id) ? "paused" : "draft";
    const editable = !!t && hubWritten(t) && !!trigger;
    const freq = r.frequencyPolicy as Prisma.JsonValue;
    const last = lasts[i];
    return {
      channel: "email",
      id: r.id,
      name: r.name,
      trigger,
      triggerLabel: trigger ? (trigger === "external_event" ? `Event: ${r.eventType}` : HUB_TRIGGER_INFO[trigger].label) : eventLabel(r.eventType),
      channelTrigger: r.eventType,
      category: (t?.category as MessageCategory | undefined) ?? null,
      status,
      actions: ctx.can.manage.email ? hubActionsFor("email", status) : [],
      pendingChanges: false,
      testMode: false,
      subject: t?.subjectTemplate ?? null,
      body: t ? t.textTemplate || null : null,
      storeId: r.storeId,
      delayMinutes: r.delayMinutes,
      lastRunAt: r.lastTriggeredAt,
      lastResult: last ? { status: emailHubStatus(last.status), reason: errorLabel(last.lastErrorCode), at: last.createdAt } : null,
      last30Days: counts.get(r.id) ?? zeroCounts(),
      editable,
      editHref: editable ? `/automations/new?channel=email&id=${encodeURIComponent(r.id)}` : `/settings/email/automations/edit?id=${encodeURIComponent(r.id)}`,
      config:
        editable && t
          ? {
              name: r.name,
              trigger,
              customEvent: isCustomEventType(r.eventType) ? r.eventType : null,
              storeId: r.storeId,
              category: t.category,
              senderIdentityId: r.senderIdentityId,
              subject: t.subjectTemplate,
              text: t.textTemplate,
              delayMinutes: r.delayMinutes,
              frequency: freq,
            }
          : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function emailAutomations(ctx: HubContext): Promise<HubAutomation[]> {
  if (!ctx.can.read.email) return [];
  return views(ctx, await listRules(ctx.workspaceId));
}

export async function emailAutomation(ctx: HubContext, id: string): Promise<HubAutomation> {
  if (!ctx.can.read.email) throw hubNotFound();
  return (await views(ctx, [await getRule(ctx.workspaceId, id)]))[0]!;
}

/** A template for an automation, named after it ("Order shipped", else "Order shipped (automation)"…). */
async function newTemplate(ctx: HubContext, actor: HubActor, name: string, content: { category: MessageCategory; eventType: string; subject: string; html: string; text: string }): Promise<string> {
  const short = name.slice(0, 70);
  for (const n of [name, `${short} (automation)`, `${short} (automation ${Date.now().toString(36)})`]) {
    try {
      return (await createTemplate(ctx.workspaceId, actor.userId, { name: n, description: "Written in Automations", ...content, status: "active", replyTo: null })).id;
    } catch (e) {
      if (e instanceof EmailError && e.code === "template_exists") continue;
      throw e;
    }
  }
  throw new HubError("Couldn't name the message's template: rename the automation and try again.", 409, "template_exists");
}

/**
 * Save an email automation (new: id null): the message into its own template (a new version when
 * it changes), the settings into its rule. A new one starts off; saving an active one changes it
 * at once, as the email module does. Nothing is sent by saving.
 */
export async function saveEmailAutomation(ctx: HubContext, id: string | null, raw: unknown, actor: HubActor): Promise<HubAutomation> {
  if (!ctx.can.manage.email) throw forbidden();
  const a = hubEmailAutomationSchema.parse(raw);
  const eventType = emailEventFor(a.trigger, a.customEvent)!;
  const category = emailCategoryOf(a);
  const issues = checkEmailMessage({ subject: a.subject, text: a.text }, eventType, category);
  if (hasErrors(issues)) throw new HubError(issues.find((i) => i.level === "error")!.message, 400, "message_invalid", { issues });
  // Shopify's events can be limited to one store (the page's, unless another of the workspace's is named); the business's own can't.
  const storeId = HUB_TRIGGER_INFO[a.trigger].email === "custom" ? null : (a.storeId ?? ctx.store?.id ?? null);
  const content = { category, eventType, subject: a.subject, html: textToEmailHtml(a.text), text: a.text };
  const rule = id ? await getRule(ctx.workspaceId, id) : null;
  let templateId: string | null = null;
  if (rule) {
    const t = await withTenant(ctx.workspaceId, (tx) => tx.emailTemplate.findFirst({ where: { id: rule.templateId, workspaceId: ctx.workspaceId, deletedAt: null } }));
    const shared = await systemDb.emailAutomationRule.count({ where: { workspaceId: ctx.workspaceId, templateId: rule.templateId, deletedAt: null, NOT: { id: rule.id } } });
    if (t && !shared && hubWritten(t)) {
      await updateTemplate(ctx.workspaceId, t.id, actor.userId, { ...content, ...(t.status !== "active" ? { status: "active" as const } : {}) });
      templateId = t.id;
    }
  }
  templateId ??= await newTemplate(ctx, actor, a.name, content);
  const fields = { name: a.name, eventType, storeId, senderIdentityId: a.senderIdentityId, templateId, delayMinutes: a.delayMinutes, frequency: a.frequency };
  const saved = rule
    ? (await updateRule(ctx.workspaceId, rule.id, actor.userId, fields)).rule
    : (await createRule(ctx.workspaceId, actor.userId, { ...fields, description: null, conditions: null, recipient: { type: "customer" }, maxAttempts: 5, priority: 100 })).rule;
  return emailAutomation(ctx, saved.id);
}

/** On or resume (needs the member's confirmation and a trigger that reaches email for its store), or pause. */
export async function actOnEmail(ctx: HubContext, id: string, action: HubAction, confirm: boolean, actor: HubActor): Promise<HubAutomation> {
  if (!ctx.can.manage.email) throw forbidden();
  const current = await emailAutomation(ctx, id);
  if (!current.actions.includes(action)) throw new HubError(`This automation can't be ${action === "activate" ? "turned on" : `${action}d`} while it is ${current.status}.`, 409, "automation_state");
  if (action === "activate" || action === "resume") {
    if (!confirm) throw new HubError("Confirm that this automation may email your customers.", 400, "confirm_required");
    if (current.trigger) {
      const state = (await emailTriggerStates(ctx, current.storeId ?? ctx.store?.id ?? null)).get(current.trigger);
      if (state?.state === "unavailable") throw new HubError(state.reason ?? "This trigger doesn't reach email automations for your store.", 409, "trigger_unavailable");
    }
    await setRuleEnabled(ctx.workspaceId, id, actor.userId, true);
  } else {
    await setRuleEnabled(ctx.workspaceId, id, actor.userId, false);
  }
  return emailAutomation(ctx, id);
}

/** Delete: it stops at once, its waiting mail is cancelled, and its own template is archived (kept for the history). */
export async function deleteEmailAutomation(ctx: HubContext, id: string, actor: HubActor): Promise<{ cancelled: number }> {
  if (!ctx.can.manage.email) throw forbidden();
  const rule = await getRule(ctx.workspaceId, id);
  const r = await deleteRule(ctx.workspaceId, id, actor.userId);
  const t = await withTenant(ctx.workspaceId, (tx) => tx.emailTemplate.findFirst({ where: { id: rule.templateId, workspaceId: ctx.workspaceId, deletedAt: null } }));
  const others = await systemDb.emailAutomationRule.count({ where: { workspaceId: ctx.workspaceId, templateId: rule.templateId, deletedAt: null } });
  if (t && !others && hubWritten(t) && t.status !== "archived") await updateTemplate(ctx.workspaceId, t.id, actor.userId, { status: "archived" }).catch(() => undefined);
  return r;
}

/** The automation's message, with example data, to the member's own (verified) address, from its sender. */
export async function testEmailAutomation(ctx: HubContext, id: string, actor: HubActor): Promise<HubMessage> {
  if (!ctx.can.manage.email) throw forbidden();
  const rule = await getRule(ctx.workspaceId, id);
  const r = await sendTemplateTest(ctx.workspaceId, rule.templateId, { email: actor.email, verified: actor.emailVerified }, rule.senderIdentityId, ctx.deps);
  const m = await systemDb.emailMessage.findUniqueOrThrow({ where: { id: r.messageId } });
  return emailMessageOf(m, rule.name, true, ctx.can.manage.email);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const RETRY_NOTE: Partial<Record<HubStatus, string>> = {
  undelivered: "The recipient's mail server refused the address; it is on the suppression list now.",
};

function emailMessageOf(m: EmailMessage, ruleName: string | null, contacts: boolean, manage: boolean): HubMessage {
  const status = emailHubStatus(m.status);
  const refusal = emailRetryRefusal(m);
  const bad = status === "failed" || status === "unknown" || status === "undelivered";
  return {
    channel: "email",
    id: m.id,
    createdAt: m.createdAt,
    kind: m.kind,
    automation: m.ruleId ? { id: m.ruleId, name: ruleName } : null,
    trigger: null,
    to: contacts ? m.recipientMasked : null,
    subject: m.subject,
    status,
    channelStatus: m.status,
    channelStatusLabel: MESSAGE_STATUS_LABEL[m.status as MessageStatus] ?? m.status,
    reason: m.lastErrorMessage ?? errorLabel(m.lastErrorCode),
    providerMessageId: m.providerMessageId,
    acceptedAt: m.providerAcceptedAt,
    deliveredAt: m.deliveredAt,
    finalAt: m.failedAt ?? m.cancelledAt ?? m.deliveredAt ?? m.providerAcceptedAt,
    attempts: m.attempts,
    costUsd: null,
    retryable: manage && !refusal,
    retryNote: bad && refusal ? (RETRY_NOTE[status] ?? refusal) : null,
  };
}

function statusWhere(statuses: HubStatus[]): Prisma.EmailMessageWhereInput {
  const wanted = [...new Set(statuses.flatMap((s) => EMAIL_STATUSES_FOR[s]))];
  return statuses.length ? { status: { in: wanted } } : {};
}

/** One page of the workspace's email for the merged history (`limit + 1` rows). Sender-verification codes aren't part of it. */
export async function emailHistory(ctx: HubContext, f: HistoryFilter): Promise<HubMessage[]> {
  if (!ctx.can.history.email || !f.channels.includes("email")) return [];
  if (f.automation && f.automation.channel !== "email") return [];
  if (f.statuses.length && !f.statuses.some((s) => EMAIL_STATUSES_FOR[s].length)) return [];
  const c = f.cursor;
  // At the cursor's instant SMS comes first: after an SMS row, every email row of that instant is still to come.
  const page: Prisma.EmailMessageWhereInput = !c ? {} : c.channel === "email" ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] } : { createdAt: { lte: c.at } };
  const rows = await withTenant(ctx.workspaceId, (tx) =>
    tx.emailMessage.findMany({
      where: { AND: [{ workspaceId: ctx.workspaceId, kind: { not: "verification" }, createdAt: { gte: f.from, lt: f.to } }, f.automation ? { ruleId: f.automation.id } : {}, statusWhere(f.statuses), page] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: f.limit + 1,
    }),
  );
  const names = await ruleNames(ctx.workspaceId, rows.map((r) => r.ruleId));
  return rows.map((r) => emailMessageOf(r, r.ruleId ? (names.get(r.ruleId) ?? null) : null, ctx.can.contacts, ctx.can.manage.email));
}

async function ruleNames(workspaceId: string, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rules = await withTenant(workspaceId, (tx) => tx.emailAutomationRule.findMany({ where: { workspaceId, id: { in: wanted } }, select: { id: true, name: true } }));
  return new Map(rules.map((r) => [r.id, r.name]));
}

export async function emailMessageDetail(ctx: HubContext, id: string) {
  if (!ctx.can.history.email) throw hubNotFound();
  const m = await withTenant(ctx.workspaceId, (tx) => tx.emailMessage.findFirst({ where: { id, workspaceId: ctx.workspaceId, kind: { not: "verification" } }, include: { events: { orderBy: { eventTimestamp: "asc" } } } }));
  if (!m) throw hubNotFound();
  const names = await ruleNames(ctx.workspaceId, [m.ruleId]);
  return {
    message: emailMessageOf(m, m.ruleId ? (names.get(m.ruleId) ?? null) : null, ctx.can.contacts, ctx.can.manage.email),
    text: null as string | null,
    timeline: m.events.map((e) => ({ at: e.eventTimestamp, label: MESSAGE_STATUS_LABEL[e.eventType as MessageStatus] ?? e.eventType.replace(/_/g, " "), detail: null as string | null })),
  };
}

/** Send a failed or unknown automation email again: the member's decision (an unknown one may have arrived). */
export async function emailRetry(ctx: HubContext, id: string, actor: HubActor): Promise<HubMessage> {
  if (!ctx.can.manage.email) throw forbidden();
  await retryEmailMessage(ctx.workspaceId, id, actor.userId, ctx.deps);
  return (await emailMessageDetail(ctx, id)).message;
}

export async function emailStats(ctx: HubContext, from: Date, to: Date): Promise<ChannelStats | null> {
  if (!ctx.can.history.email) return null;
  const dayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const [groups, today, settings] = await Promise.all([
    withTenant(ctx.workspaceId, (tx) => tx.emailMessage.groupBy({ by: ["status"], where: { workspaceId: ctx.workspaceId, kind: { not: "verification" }, createdAt: { gte: from, lt: to } }, _count: { _all: true } })),
    withTenant(ctx.workspaceId, (tx) => tx.emailMessage.count({ where: { workspaceId: ctx.workspaceId, providerAcceptedAt: { gte: dayStart } } })),
    getEmailSettings(ctx.workspaceId),
  ]);
  const totals = zeroCounts();
  for (const g of groups) totals[emailHubStatus(g.status)] += g._count._all;
  const rate = totals.delivered > 0 ? deliveryRate(totals) : null;
  return {
    channel: "email",
    totals,
    deliveryRate: rate,
    acceptanceRate: acceptanceRate(totals),
    deliveryNote: rate === null ? "Gmail, Microsoft and SMTP servers don't report deliveries to bizinsights: \"Accepted by provider\" is as far as email can be followed. Bounces the server reports at once show as Undelivered." : null,
    usage: [{ label: "Sent today (UTC)", value: `${today} of ${settings.effectiveDailyLimit}` }],
    costUsd: null,
  };
}

/** The period's email per day in `timeZone` (YYYY-MM-DD), on the hub's scale. */
export async function emailDaily(ctx: HubContext, from: Date, to: Date, timeZone: string): Promise<Array<{ day: string; status: HubStatus; n: number }>> {
  if (!ctx.can.history.email) return [];
  const rows = await withTenant(ctx.workspaceId, (tx) =>
    tx.$queryRaw<Array<{ day: string; status: string; n: bigint }>>`
      SELECT to_char(date_trunc('day', (created_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS day, status, count(*) AS n
      FROM email_messages
      WHERE workspace_id = ${ctx.workspaceId} AND kind <> 'verification' AND created_at >= ${from} AND created_at < ${to}
      GROUP BY 1, 2`,
  );
  return rows.map((r) => ({ day: r.day, status: emailHubStatus(r.status), n: Number(r.n) }));
}
