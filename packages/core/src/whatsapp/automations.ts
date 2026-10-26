/**
 * Automations: trigger → conditions → template → recipient and timing (docs/whatsapp.md,
 * "Automations"), or a ready-made one turned on in one go (quickAutomation). Shopify's verified
 * webhooks (events.ts) and customers' messages (inbound.ts) start them.
 *
 * An automation runs at most once per order, checkout, customer or message window (a unique run
 * row), so Shopify's retries and duplicate deliveries message nobody twice. A run that doesn't
 * send says why, and so does every message. Automations never trigger each other (a message
 * bizinsights sends starts nothing), a reply to a customer's message waits out its cool-down, and
 * an automation in test mode sends only to the store's own verified number: no loop, no surprise
 * bulk send.
 */
import { systemDb, type Prisma, type Store, type WappAutomation, type WappConnection, type WappTemplate } from "@app/db";
import {
  evaluateWaConditions,
  expandScopes,
  normalizePhone,
  renderWaText,
  variablesIn,
  waAutomationMessageIssues,
  waAutomationSchema,
  waHasErrors,
  WaMissingValueError,
  waMissingVariables,
  waPreset,
  waPresetStarter,
  waQuickAutomationSchema,
  waSetupProgress,
  WA_DEFAULT_REPLY_COOLDOWN,
  waSampleValues,
  WA_TRIGGER_INFO,
  WA_TRIGGERS,
  type NormalizedPhone,
  type WaAutomationFix,
  type WaAutomationInput,
  type WaAutomationIssue,
  type WaCondition,
  type WaFacts,
  type WaRecipient,
  type WaSkipReason,
  type WaTemplateCategory,
  type WaTrigger,
  type WaValues,
} from "@app/shared";
import { appWebhookTopics } from "../apps.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { businessNameOf, connectionListens, liveConnection, settingsOf, verifiedTestPhone, WhatsappError, type WaDeps, type WaSettingsView } from "./common.js";
import { applyShopifyConsent, upsertContact, type ContactDetails } from "./contacts.js";
import { consentBlock, queueMessage } from "./messages.js";
import { setMarketingEnabled } from "./settings.js";
import { createWaTemplate, submitTemplateToMeta, templateUsable } from "./templates.js";

/** Events older than this start nothing (a replayed webhook, a backfill): customers aren't told old news. */
export const STALE_EVENT_MS = 48 * 3600_000;
/** A customer's message older than this gets no automatic reply (a webhook held back): it would answer old news. */
export const STALE_REPLY_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Which triggers this store can use
// ---------------------------------------------------------------------------

export interface TriggerAvailability {
  available: boolean;
  /** Why not, in the merchant's words. */
  reason: string | null;
}

/**
 * What each trigger can do for this store: Shopify's events only where the store's app receives
 * them (the App Store app gets no order or checkout events until Shopify approves protected
 * customer data), new customers only with read_customers. Nothing is offered as working when it
 * can't start a message.
 */
export function triggerAvailability(store: Pick<Store, "shopifyAppKey" | "grantedScopes">): Record<WaTrigger, TriggerAvailability> {
  const app = appWebhookTopics(store.shopifyAppKey);
  const scopes = expandScopes(store.grantedScopes);
  const out = {} as Record<WaTrigger, TriggerAvailability>;
  for (const t of WA_TRIGGERS) {
    const info = WA_TRIGGER_INFO[t];
    if (t === "customer_created" && !scopes.has("read_customers")) {
      out[t] = { available: false, reason: "bizinsights needs permission to read your customers in Shopify to hear about new ones. Update the bizinsights app's access in Shopify, then come back." };
    } else if (t !== "customer_created" && info.topics.length && app && !info.topics.some((topic) => app.includes(topic))) {
      out[t] = {
        available: false,
        reason: "Your store is connected through bizinsights' App Store app, which Shopify doesn't send order and checkout events to until it approves bizinsights' access to protected customer data.",
      };
    } else {
      out[t] = { available: true, reason: null };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saving and switching on
// ---------------------------------------------------------------------------

export function automationInput(a: WappAutomation): WaAutomationInput {
  return {
    name: a.name,
    description: a.description,
    trigger: a.trigger as WaTrigger,
    conditions: a.conditions as unknown as WaCondition[],
    templateId: a.templateId,
    recipient: a.recipient as WaRecipient,
    delayMinutes: a.delayMinutes,
    sendWindow: a.sendWindowStart != null && a.sendWindowEnd != null ? { start: a.sendWindowStart, end: a.sendWindowEnd } : null,
    testMode: a.testMode,
    cooldownMinutes: a.cooldownMinutes,
  };
}

type ProblemContext = { template: WappTemplate | null; conn: WappConnection | null; settings: WaSettingsView; availability: Record<WaTrigger, TriggerAvailability> };

/**
 * Why an automation can't be switched on (empty: it can), each with the tab of the page that fixes
 * it: the same list the builder and the ready-made cards show, so the merchant sees every reason
 * before switching it on.
 */
export function automationIssues(a: WaAutomationInput, ctx: ProblemContext): WaAutomationIssue[] {
  const out: WaAutomationIssue[] = [];
  const add = (message: string, fix: WaAutomationFix) => out.push({ message, fix });
  const info = WA_TRIGGER_INFO[a.trigger];
  if (!ctx.conn || ctx.conn.status !== "connected") add("WhatsApp isn't connected. Connect it on the Setup step first.", "setup");
  const setup = waSetupProgress({
    provider: (ctx.conn?.provider as "qr" | "cloud_api" | undefined) ?? null,
    status: (ctx.conn?.status as "connected" | undefined) ?? null,
    configuredAt: ctx.settings.configuredAt,
    orderUpdates: ctx.settings.orderUpdates,
    testVerifiedAt: ctx.settings.testVerifiedAt,
    testPassedAt: ctx.settings.testPassedAt,
  });
  if (!setup.done.configure) add("Finish Step 3 (Configure): choose how customers agree to messages.", "setup");
  if (!setup.done.test) add("Finish Step 4: verify your test number and send it a test message.", "setup");
  if (!ctx.availability[a.trigger].available) add(ctx.availability[a.trigger].reason!, null);
  if (!ctx.template) add("Pick a message template.", "templates");
  else {
    const usable = templateUsable(ctx.template, ctx.conn);
    if (!usable.ok) add(`The template "${ctx.template.name}" can't be used: ${usable.reason}`, "templates");
    if (info.category === "marketing" && ctx.template.category !== "marketing") add(`"${info.label}" sends marketing: pick a marketing template (it tells customers how to stop).`, "templates");
    if (ctx.template.category === "marketing" && !ctx.settings.marketingEnabled) add("Marketing messages are switched off in Settings.", "settings");
    const missing = waMissingVariables(ctx.template.body, a.trigger);
    if (missing.length) add(`The template uses ${missing.map((v) => `{{${v}}}`).join(", ")}, which "${info.label}" doesn't provide.`, "templates");
  }
  if (ctx.settings.orderUpdates === "unset" && (ctx.template?.category ?? info.category) === "transactional") add("Choose how customers agree to order updates in Settings.", "settings");
  return out;
}

/** automationIssues' messages alone: what every answer has said since automations existed. */
export const automationProblems = (a: WaAutomationInput, ctx: ProblemContext): string[] => automationIssues(a, ctx).map((i) => i.message);

async function context(store: Store, templateId: string | null) {
  const [conn, settings, template] = await Promise.all([
    liveConnection(store.id),
    settingsOf(store),
    templateId ? systemDb.wappTemplate.findFirst({ where: { id: templateId, storeId: store.id } }) : Promise.resolve(null),
  ]);
  return { conn, settings, template, availability: triggerAvailability(store) };
}

export async function automationIssuesFor(store: Store, a: WappAutomation): Promise<WaAutomationIssue[]> {
  return automationIssues(automationInput(a), await context(store, a.templateId));
}

export async function automationProblemsFor(store: Store, a: WappAutomation): Promise<string[]> {
  return (await automationIssuesFor(store, a)).map((i) => i.message);
}

/**
 * Cancels what an automation still waits to send to customers (a reminder due later, a message held
 * for the sending hours) once it sends only to the store's verified number (test mode). The sender
 * checks again at the moment of sending (sendQueuedMessage), for a message this misses.
 */
async function cancelCustomerMessages(automationId: string): Promise<number> {
  const { count } = await systemDb.wappMessage.updateMany({ where: { automationId, status: "queued", contactId: { not: null } }, data: { status: "cancelled", reason: "manual_cancel", finalAt: new Date(), payloadEnc: null } });
  return count;
}

/**
 * Creates or edits an automation. Editing a switched-on one keeps it on only while it still has no
 * problems. Saved in test mode, what it still waits to send to customers is cancelled, as the
 * "Sending to" switch does (setAutomationTestMode); the audit records how many.
 */
export async function saveAutomation(input: { store: Store; userId: string; id?: string; data: unknown; ip?: string }): Promise<WappAutomation> {
  const a = waAutomationSchema.parse(input.data);
  const template = await systemDb.wappTemplate.findFirst({ where: { id: a.templateId, storeId: input.store.id } });
  if (!template) throw new WhatsappError("Pick one of this store's templates.", 400, "template_not_found");
  const data = {
    name: a.name,
    description: a.description ?? null,
    trigger: a.trigger,
    conditions: a.conditions as unknown as Prisma.InputJsonValue,
    templateId: a.templateId,
    recipient: a.recipient,
    delayMinutes: a.delayMinutes,
    sendWindowStart: a.sendWindow?.start ?? null,
    sendWindowEnd: a.sendWindow?.end ?? null,
    testMode: a.testMode,
    cooldownMinutes: a.trigger === "message_received" ? (a.cooldownMinutes ?? WA_DEFAULT_REPLY_COOLDOWN) : null,
    updatedByUserId: input.userId,
  };
  let row: WappAutomation;
  let cancelled = 0;
  if (input.id) {
    const existing = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
    if (!existing) throw new WhatsappError("Not found", 404, "not_found");
    if (existing.trigger !== a.trigger) throw new WhatsappError("An automation's trigger can't change. Make a new automation instead.", 409, "trigger_fixed");
    if (existing.status === "active") {
      const issues = automationIssues(a, await context(input.store, a.templateId));
      if (issues.length) throw new WhatsappError("This change would stop the automation from working. Pause it first, or fix what's listed.", 409, "automation_blocked", { problems: issues.map((i) => i.message), issues });
    }
    row = await systemDb.wappAutomation.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
    // The builder's "Test mode" box: nothing more reaches a customer from it, as with the switch.
    if (row.testMode) cancelled = await cancelCustomerMessages(row.id);
  } else {
    row = await systemDb.wappAutomation.create({ data: { ...data, workspaceId: input.store.workspaceId, storeId: input.store.id, status: "draft", createdByUserId: input.userId } });
  }
  await audit({
    workspaceId: input.store.workspaceId,
    actorUserId: input.userId,
    action: input.id ? "whatsapp.automation_updated" : "whatsapp.automation_created",
    targetType: "whatsapp_automation",
    targetId: row.id,
    metadata: { trigger: a.trigger, testMode: a.testMode, ...(input.id ? { cancelled } : {}) },
    ip: input.ip,
  });
  return row;
}

/**
 * Switches an automation on once nothing stops it. `subscribeCustomers` asks Shopify for its
 * customers/create webhook ("A customer signs up" only): it returns why it can't, or null.
 */
export async function activateAutomation(input: { store: Store; id: string; userId: string; ip?: string; subscribeCustomers?: () => Promise<string | null> }): Promise<WappAutomation> {
  const a = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!a) throw new WhatsappError("Not found", 404, "not_found");
  const issues = await automationIssuesFor(input.store, a);
  if (issues.length) throw new WhatsappError("This automation can't be switched on yet.", 409, "automation_blocked", { problems: issues.map((i) => i.message), issues });
  if (a.trigger === "customer_created" && input.subscribeCustomers) {
    const why = await input.subscribeCustomers();
    if (why) throw new WhatsappError(why, 409, "automation_blocked", { problems: [why], issues: [{ message: why, fix: null }] });
  }
  const row = await systemDb.wappAutomation.update({ where: { id: a.id }, data: { status: "active", activatedAt: new Date(), updatedByUserId: input.userId } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.automation_activated", targetType: "whatsapp_automation", targetId: a.id, metadata: { trigger: a.trigger, testMode: a.testMode }, ip: input.ip });
  return row;
}

/** Pauses an automation; its messages still waiting are cancelled. */
export async function pauseAutomation(input: { store: Store; id: string; userId: string; ip?: string }): Promise<{ automation: WappAutomation; cancelled: number }> {
  const a = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!a) throw new WhatsappError("Not found", 404, "not_found");
  const row = await systemDb.wappAutomation.update({ where: { id: a.id }, data: { status: "paused", updatedByUserId: input.userId } });
  const { count } = await systemDb.wappMessage.updateMany({ where: { automationId: a.id, status: "queued" }, data: { status: "cancelled", reason: "automation_off", finalAt: new Date(), payloadEnc: null } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.automation_paused", targetType: "whatsapp_automation", targetId: a.id, metadata: { cancelled: count }, ip: input.ip });
  return { automation: row, cancelled: count };
}

export async function deleteAutomation(input: { store: Store; id: string; userId: string; ip?: string }): Promise<void> {
  const a = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!a) throw new WhatsappError("Not found", 404, "not_found");
  await systemDb.wappMessage.updateMany({ where: { automationId: a.id, status: "queued" }, data: { status: "cancelled", reason: "automation_off", finalAt: new Date(), payloadEnc: null } });
  await systemDb.$transaction([systemDb.wappAutomationRun.deleteMany({ where: { automationId: a.id } }), systemDb.wappAutomation.delete({ where: { id: a.id } })]);
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.automation_deleted", targetType: "whatsapp_automation", targetId: a.id, metadata: { name: a.name }, ip: input.ip });
}

/**
 * The list's "Sending to: your customers / only you" switch. Switched to only you, what the
 * automation still waits to send to customers is cancelled (a reminder due later, a message held for
 * the sending hours): nothing more reaches a customer from it until it is switched back. The
 * builder's "Test mode" box does the same (saveAutomation), and so does the sender at the moment of
 * sending.
 */
export async function setAutomationTestMode(input: { store: Store; id: string; userId: string; testMode: boolean; ip?: string }): Promise<{ automation: WappAutomation; cancelled: number }> {
  const a = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!a) throw new WhatsappError("Not found", 404, "not_found");
  const row = a.testMode === input.testMode ? a : await systemDb.wappAutomation.update({ where: { id: a.id }, data: { testMode: input.testMode, version: { increment: 1 }, updatedByUserId: input.userId } });
  const count = input.testMode ? await cancelCustomerMessages(a.id) : 0;
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.automation_test_mode", targetType: "whatsapp_automation", targetId: a.id, metadata: { testMode: input.testMode, cancelled: count }, ip: input.ip });
  return { automation: row, cancelled: count };
}

// ---------------------------------------------------------------------------
// Ready-made automations in one go
// ---------------------------------------------------------------------------

/** How long one store's "Turn on" may hold its lock (it may wait on Meta's review call and Shopify's webhooks). */
const QUICK_LOCK_MS = 60_000;

export interface QuickAutomationResult {
  automation: WappAutomation;
  template: WappTemplate;
  /** Switched on now (false: saved off, `issues` says why). */
  activated: boolean;
  problems: string[];
  issues: WaAutomationIssue[];
  /** Something the merchant should know that isn't a problem of theirs (Meta reviewing the message). */
  notice: string | null;
}

/** The first of "Order confirmation", "Order confirmation 2", "Order confirmation 3"… no template of the store is called (names are unique per store). */
async function freeTemplateName(storeId: string, name: string): Promise<string> {
  const taken = new Set((await systemDb.wappTemplate.findMany({ where: { storeId, name: { startsWith: name } }, select: { name: true } })).map((t) => t.name));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * "Turn on" a ready-made automation: its message (the starter, or as the merchant edited it) becomes
 * a template, or reuses the store's own with the same text, and the automation is saved and, when
 * nothing stops it, switched on, to the store's customers or only the merchant's verified number
 * (test mode). A trigger already has its automation: two would message a customer twice. On the
 * Cloud API the new template goes to Meta for review and the automation stays off until Meta
 * approves it. One store's "Turn on" runs one at a time.
 */
export async function quickAutomation(
  deps: Pick<WaDeps, "coord" | "fetchImpl">,
  input: { store: Store; userId: string; data: unknown; ip?: string; subscribeCustomers?: () => Promise<string | null> },
): Promise<QuickAutomationResult> {
  const d = waQuickAutomationSchema.parse(input.data);
  const preset = waPreset(d.preset);
  const info = WA_TRIGGER_INFO[preset.trigger];
  const lock = `wapp:quick:${input.store.id}`;
  if (!(await deps.coord.acquire(lock, QUICK_LOCK_MS))) throw new WhatsappError("Another automation is being switched on for this store. Try again in a moment.", 409, "busy");
  try {
    const existing = await systemDb.wappAutomation.findFirst({ where: { storeId: input.store.id, trigger: preset.trigger }, orderBy: { createdAt: "asc" } });
    if (existing) throw new WhatsappError(`"${existing.name}" already sends when ${info.label.toLowerCase()}. Switch that one on or edit it: two would message a customer twice.`, 409, "automation_exists", { id: existing.id });
    const availability = triggerAvailability(input.store)[preset.trigger];
    if (!availability.available) throw new WhatsappError(availability.reason!, 409, "trigger_unavailable");

    const body = d.body ?? waPresetStarter(preset).body;
    const issues = waAutomationMessageIssues(body, preset.trigger);
    if (waHasErrors(issues)) throw new WhatsappError(issues.filter((i) => i.level === "error").map((i) => i.message).join(" "), 400, "template_invalid", { issues });

    // The store's own template with this exact text, switched on (one that works now first); else a new one.
    const conn = await liveConnection(input.store.id);
    const same = await systemDb.wappTemplate.findMany({ where: { storeId: input.store.id, body, category: info.category, active: true }, orderBy: { createdAt: "asc" } });
    let template = same.find((t) => templateUsable(t, conn).ok) ?? same[0] ?? null;
    if (!template) {
      template = await createWaTemplate(input.store, { data: { name: await freeTemplateName(input.store.id, preset.name), category: info.category, body, active: true }, userId: input.userId, ip: input.ip });
    }
    let notice: string | null = null;
    if (conn?.provider === "cloud_api" && conn.status === "connected" && !template.metaStatus) {
      try {
        // The same samples the Templates tab's "Submit to Meta for review" sends.
        template = await submitTemplateToMeta(deps, conn, template, waSampleValues(input.store.name) as Record<string, string>);
        if (!templateUsable(template, conn).ok) notice = "Meta reviews every new WhatsApp message before it can be sent, usually within minutes and at most a day. Switch the automation on here once Meta approves it.";
      } catch (e) {
        logger.warn({ storeId: input.store.id, err: e instanceof Error ? e.message : String(e) }, "whatsapp quick automation: Meta's review couldn't be asked for");
        notice = "Meta couldn't be asked to review the message just now. Submit it for review on the Templates tab, then switch the automation on.";
      }
    }

    const settings = await settingsOf(input.store);
    if (info.category === "marketing" && d.enableMarketing && !settings.marketingEnabled) await setMarketingEnabled({ store: input.store, userId: input.userId, enabled: true, ip: input.ip });

    let automation = await saveAutomation({
      store: input.store,
      userId: input.userId,
      ip: input.ip,
      data: {
        name: preset.name,
        description: preset.description,
        trigger: preset.trigger,
        conditions: [],
        templateId: template.id,
        recipient: "customer",
        delayMinutes: preset.delayMinutes,
        sendWindow: null,
        testMode: d.sendTo === "me",
        cooldownMinutes: preset.trigger === "message_received" ? WA_DEFAULT_REPLY_COOLDOWN : null,
      },
    });
    let found = await automationIssuesFor(input.store, automation);
    let activated = false;
    if (!found.length) {
      try {
        automation = await activateAutomation({ store: input.store, id: automation.id, userId: input.userId, ip: input.ip, subscribeCustomers: input.subscribeCustomers });
        activated = true;
      } catch (e) {
        if (e instanceof WhatsappError && e.code === "automation_blocked") {
          // Shopify refused the new customers' webhook ("A customer signs up"): saved, off, and why.
          found = (e.detail as { issues?: WaAutomationIssue[] } | undefined)?.issues ?? [{ message: e.message, fix: null }];
        } else {
          // It is saved already: an error now (Shopify unreachable, throttled or refusing its token)
          // leaves it off on its card, with why, never a half-made automation the page can't see.
          logger.warn({ storeId: input.store.id, automationId: automation.id, trigger: preset.trigger, err: e instanceof Error ? e.message : String(e) }, "whatsapp quick automation: switching on failed");
          found = [
            {
              message:
                preset.trigger === "customer_created"
                  ? "Shopify couldn't be reached to tell bizinsights about new customers just now. Switch it on from its card in a moment."
                  : "It couldn't be switched on just now. Switch it on from its card in a moment.",
              fix: null,
            },
          ];
        }
      }
    }
    return { automation, template, activated, problems: found.map((i) => i.message), issues: found, notice };
  } finally {
    // A failed release (DynamoDB throttled) mustn't turn the answer into an error: the lock's TTL frees it.
    await deps.coord.release(lock).catch((err: unknown) => logger.warn({ storeId: input.store.id, err: err instanceof Error ? err.message : String(err) }, "whatsapp quick automation: lock release failed"));
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** A Shopify event (or a customer's message) as the automations see it. */
export interface AutomationSubject {
  store: Store;
  trigger: WaTrigger;
  /** "order:<id>", "checkout:<token>", "customer:<id>", "inbound:<contact>"... */
  key: string;
  label: string;
  phones: Partial<Record<WaRecipient, NormalizedPhone | null>>;
  contact: ContactDetails;
  /** Shopify's text-message marketing consent state on the event. */
  shopifyConsent?: string | null;
  values: WaValues;
  facts: WaFacts;
  occurredAt: Date;
  /** A checkout's later update: a waiting reminder is timed again from the customer's latest change. */
  retime?: boolean;
  /** Only these automations (a customer's message runs each reply automation in its own cool-down window). */
  automationIds?: string[];
}

export interface RunResult {
  queued: number;
  skipped: number;
}

async function recordRun(a: WappAutomation, s: { store: Store; key: string; label: string }, outcome: "queued" | "skipped", reason: WaSkipReason | null, extra: { detail?: string | null; contactId?: string | null; testMode?: boolean } = {}) {
  try {
    return await systemDb.wappAutomationRun.create({
      data: {
        workspaceId: s.store.workspaceId,
        storeId: s.store.id,
        automationId: a.id,
        automationVersion: a.version,
        trigger: a.trigger,
        subjectKey: s.key,
        subjectLabel: s.label.slice(0, 120),
        outcome,
        reason,
        detail: extra.detail?.slice(0, 500) ?? null,
        contactId: extra.contactId ?? null,
        testMode: extra.testMode ?? false,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return null;
    throw e;
  }
}

/** Runs every switched-on automation of the subject's trigger. Idempotent per automation and subject. */
export async function runAutomations(deps: Pick<WaDeps, "queues">, s: AutomationSubject): Promise<RunResult> {
  const result: RunResult = { queued: 0, skipped: 0 };
  const conn = await liveConnection(s.store.id);
  if (!connectionListens(conn)) return result;
  const automations = await systemDb.wappAutomation.findMany({ where: { storeId: s.store.id, trigger: s.trigger, status: "active", ...(s.automationIds ? { id: { in: s.automationIds } } : {}) } });
  if (!automations.length) return result;
  const settings = await settingsOf(s.store);
  const values: WaValues = { ...s.values, store_name: businessNameOf(s.store, settings) };

  for (const a of automations) {
    const key = s.key;
    // A checkout's update re-times its waiting reminder instead of running again.
    if (s.retime) {
      const run = await systemDb.wappAutomationRun.findUnique({ where: { automationId_subjectKey: { automationId: a.id, subjectKey: key } } });
      if (run) {
        if (run.messageId) {
          const due = new Date(s.occurredAt.getTime() + a.delayMinutes * 60_000);
          await systemDb.wappMessage.updateMany({ where: { id: run.messageId, status: "queued" }, data: { sendAfter: due, enqueuedAt: null } });
        }
        continue;
      }
    }
    const skip = async (reason: WaSkipReason, extra: { detail?: string | null; contactId?: string | null } = {}) => {
      const run = await recordRun(a, { store: s.store, key, label: s.label }, "skipped", reason, extra);
      if (run) result.skipped++;
    };
    if (settings.automationPausedAt) {
      await skip("automation_paused");
      continue;
    }
    if (Date.now() - s.occurredAt.getTime() > (s.trigger === "message_received" ? STALE_REPLY_MS : STALE_EVENT_MS)) {
      await skip("stale_event");
      continue;
    }
    const cond = evaluateWaConditions(a.conditions as unknown as WaCondition[], s.facts);
    if (!cond.pass) {
      await skip("conditions", { detail: cond.failed.join("; ") });
      continue;
    }
    const template = await systemDb.wappTemplate.findFirst({ where: { id: a.templateId, storeId: s.store.id } });
    if (!template || !templateUsable(template, conn).ok) {
      await skip("template_unavailable");
      continue;
    }
    const phone = s.phones[a.recipient as WaRecipient] ?? null;
    if (!phone) {
      await skip("no_phone");
      continue;
    }
    let text: string;
    try {
      text = renderWaText(template.body, values);
    } catch (e) {
      if (e instanceof WaMissingValueError) {
        await skip("missing_values", { detail: e.missing.map((v) => `{{${v}}}`).join(", ") });
        continue;
      }
      throw e;
    }
    let contact = await upsertContact(s.store, phone, s.contact);
    contact = await applyShopifyConsent(contact, s.shopifyConsent, settings.shopifySmsConsent, s.occurredAt);
    const category = template.category as WaTemplateCategory;
    const block = await consentBlock(contact, category, settings, { reply: s.trigger === "message_received" });
    if (block) {
      await skip(block, { contactId: contact.id });
      continue;
    }
    // Test mode: the store's own verified number gets it instead of the customer.
    let to: NormalizedPhone = phone;
    if (a.testMode) {
      const test = normalizePhone(await verifiedTestPhone(s.store.id), null);
      if (!test) {
        await skip("test_mode", { detail: "Test mode is on but the store has no verified test number.", contactId: contact.id });
        continue;
      }
      to = test;
    }
    let run = await recordRun(a, { store: s.store, key, label: s.label }, "queued", a.testMode ? "test_mode" : null, { contactId: contact.id, testMode: a.testMode });
    if (!run) {
      // This automation already ran for this subject. A run whose message was never linked (an earlier
      // try failed between the two) is finished now: its message has one idempotency key, so one message.
      const earlier = await systemDb.wappAutomationRun.findUnique({ where: { automationId_subjectKey: { automationId: a.id, subjectKey: key } } });
      if (!earlier || earlier.outcome !== "queued" || earlier.messageId) continue;
      run = earlier;
    }
    const due = new Date(s.occurredAt.getTime() + a.delayMinutes * 60_000);
    const { message } = await queueMessage(deps, {
      store: s.store,
      conn,
      source: "automation",
      category,
      phone: to,
      contactId: a.testMode ? null : contact.id,
      payload: { text, meta: conn?.provider === "cloud_api" && template.metaName ? { name: template.metaName, language: template.metaLanguage ?? "en", params: variablesIn(template.body).map((v) => (values as Record<string, string>)[v] ?? "") } : null },
      templateId: template.id,
      idempotencyKey: `auto:${a.id}:${key}`,
      automationId: a.id,
      runId: run.id,
      sendAfter: due < new Date() ? new Date() : due,
    });
    await systemDb.wappAutomationRun.update({ where: { id: run.id }, data: { messageId: message.id } });
    await systemDb.wappAutomation.update({ where: { id: a.id }, data: { lastRunAt: new Date() } });
    result.queued++;
  }
  if (result.queued || result.skipped) logger.info({ storeId: s.store.id, trigger: s.trigger, ...result }, "whatsapp automations ran");
  return result;
}

/**
 * Cancels what automations still wait to send about a subject: an order cancelled (except its own
 * "order cancelled" message), a checkout finished.
 */
export async function cancelSubject(storeId: string, subjectKey: string, reason: "order_cancelled" | "checkout_completed", exceptTrigger?: WaTrigger): Promise<number> {
  const runs = await systemDb.wappAutomationRun.findMany({ where: { storeId, subjectKey, messageId: { not: null }, ...(exceptTrigger ? { trigger: { not: exceptTrigger } } : {}) }, select: { messageId: true } });
  const ids = runs.map((r) => r.messageId!).filter(Boolean);
  if (!ids.length) return 0;
  const { count } = await systemDb.wappMessage.updateMany({ where: { id: { in: ids }, status: "queued" }, data: { status: "cancelled", reason, finalAt: new Date(), payloadEnc: null } });
  return count;
}

/** "Test": runs an automation once for a made-up event with sample values, to the store's verified test number. */
export async function testAutomation(deps: Pick<WaDeps, "queues">, input: { store: Store; id: string; userId: string }): Promise<{ messageId: string }> {
  const a = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!a) throw new WhatsappError("Not found", 404, "not_found");
  const conn = await liveConnection(input.store.id);
  if (!conn || conn.status !== "connected") throw new WhatsappError("WhatsApp isn't connected. Connect it first.", 409, "not_connected");
  const template = await systemDb.wappTemplate.findFirst({ where: { id: a.templateId, storeId: input.store.id } });
  if (!template || !templateUsable(template, conn).ok) throw new WhatsappError("The automation's template can't be used. Check it on the Templates tab.", 409, "template_unavailable");
  const testPhone = normalizePhone(await verifiedTestPhone(input.store.id), null);
  if (!testPhone) throw new WhatsappError("Verify your test number first (Step 4).", 409, "no_test_number");
  const settings = await settingsOf(input.store);
  const values = waSampleValues(businessNameOf(input.store, settings));
  const text = renderWaText(template.body, values, { lenient: true });
  const nonce = `${Date.now()}`;
  const { message } = await queueMessage(deps, {
    store: input.store,
    conn,
    source: "test",
    category: template.category as WaTemplateCategory,
    phone: testPhone,
    payload: { text, meta: conn.provider === "cloud_api" && template.metaName ? { name: template.metaName, language: template.metaLanguage ?? "en", params: variablesIn(template.body).map((v) => (values as Record<string, string>)[v] ?? "") } : null },
    templateId: template.id,
    idempotencyKey: `autotest:${a.id}:${nonce}`,
    automationId: a.id,
    createdByUserId: input.userId,
  });
  return { messageId: message.id };
}
