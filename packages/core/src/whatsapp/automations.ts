/**
 * Automations: trigger → conditions → template → recipient and timing (docs/whatsapp.md,
 * "Automations"). Shopify's verified webhooks (events.ts) and customers' messages (inbound.ts)
 * start them.
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
  waAutomationSchema,
  WaMissingValueError,
  waSetupProgress,
  WA_DEFAULT_REPLY_COOLDOWN,
  waSampleValues,
  WA_TRIGGER_INFO,
  WA_TRIGGERS,
  type NormalizedPhone,
  type WaAutomationInput,
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
import { templateUsable } from "./templates.js";

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
 * them (the first App Store app, "public", gets no order or checkout events: Shopify never approved
 * its protected customer data), new customers only with read_customers. Nothing is offered as working when it
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

/**
 * Why an automation can't be switched on (empty: it can): the same list the builder shows, so the
 * merchant sees every reason before pressing Activate.
 */
export function automationProblems(
  a: WaAutomationInput,
  ctx: { template: WappTemplate | null; conn: WappConnection | null; settings: WaSettingsView; availability: Record<WaTrigger, TriggerAvailability> },
): string[] {
  const out: string[] = [];
  const info = WA_TRIGGER_INFO[a.trigger];
  if (!ctx.conn || ctx.conn.status !== "connected") out.push("WhatsApp isn't connected. Connect it on the Setup step first.");
  const setup = waSetupProgress({
    provider: (ctx.conn?.provider as "qr" | "cloud_api" | undefined) ?? null,
    status: (ctx.conn?.status as "connected" | undefined) ?? null,
    configuredAt: ctx.settings.configuredAt,
    orderUpdates: ctx.settings.orderUpdates,
    testVerifiedAt: ctx.settings.testVerifiedAt,
    testPassedAt: ctx.settings.testPassedAt,
  });
  if (!setup.done.configure) out.push("Finish Step 3 (Configure): choose how customers agree to messages.");
  if (!setup.done.test) out.push("Finish Step 4: verify your test number and send it a test message.");
  if (!ctx.availability[a.trigger].available) out.push(ctx.availability[a.trigger].reason!);
  if (!ctx.template) out.push("Pick a message template.");
  else {
    const usable = templateUsable(ctx.template, ctx.conn);
    if (!usable.ok) out.push(`The template "${ctx.template.name}" can't be used: ${usable.reason}`);
    if (info.category === "marketing" && ctx.template.category !== "marketing") out.push(`"${info.label}" sends marketing: pick a marketing template (it tells customers how to stop).`);
    if (ctx.template.category === "marketing" && !ctx.settings.marketingEnabled) out.push("Marketing messages are switched off in Settings.");
    const missing = variablesIn(ctx.template.body).filter((v) => !(info.variables as string[]).includes(v) && v !== "store_name");
    if (missing.length) out.push(`The template uses ${missing.map((v) => `{{${v}}}`).join(", ")}, which "${info.label}" doesn't provide.`);
  }
  if (ctx.settings.orderUpdates === "unset" && (ctx.template?.category ?? info.category) === "transactional") out.push("Choose how customers agree to order updates in Settings.");
  return out;
}

async function context(store: Store, templateId: string | null) {
  const [conn, settings, template] = await Promise.all([
    liveConnection(store.id),
    settingsOf(store),
    templateId ? systemDb.wappTemplate.findFirst({ where: { id: templateId, storeId: store.id } }) : Promise.resolve(null),
  ]);
  return { conn, settings, template, availability: triggerAvailability(store) };
}

export async function automationProblemsFor(store: Store, a: WappAutomation): Promise<string[]> {
  return automationProblems(automationInput(a), await context(store, a.templateId));
}

/** Creates or edits an automation. Editing a switched-on one keeps it on only while it still has no problems. */
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
  if (input.id) {
    const existing = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
    if (!existing) throw new WhatsappError("Not found", 404, "not_found");
    if (existing.trigger !== a.trigger) throw new WhatsappError("An automation's trigger can't change. Make a new automation instead.", 409, "trigger_fixed");
    if (existing.status === "active") {
      const problems = automationProblems(a, await context(input.store, a.templateId));
      if (problems.length) throw new WhatsappError("This change would stop the automation from working. Pause it first, or fix what's listed.", 409, "automation_blocked", { problems });
    }
    row = await systemDb.wappAutomation.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
  } else {
    row = await systemDb.wappAutomation.create({ data: { ...data, workspaceId: input.store.workspaceId, storeId: input.store.id, status: "draft", createdByUserId: input.userId } });
  }
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: input.id ? "whatsapp.automation_updated" : "whatsapp.automation_created", targetType: "whatsapp_automation", targetId: row.id, metadata: { trigger: a.trigger, testMode: a.testMode }, ip: input.ip });
  return row;
}

/**
 * Switches an automation on once nothing stops it. `subscribeCustomers` asks Shopify for its
 * customers/create webhook ("A customer signs up" only): it returns why it can't, or null.
 */
export async function activateAutomation(input: { store: Store; id: string; userId: string; ip?: string; subscribeCustomers?: () => Promise<string | null> }): Promise<WappAutomation> {
  const a = await systemDb.wappAutomation.findFirst({ where: { id: input.id, storeId: input.store.id } });
  if (!a) throw new WhatsappError("Not found", 404, "not_found");
  const problems = await automationProblemsFor(input.store, a);
  if (problems.length) throw new WhatsappError("This automation can't be switched on yet.", 409, "automation_blocked", { problems });
  if (a.trigger === "customer_created" && input.subscribeCustomers) {
    const why = await input.subscribeCustomers();
    if (why) throw new WhatsappError(why, 409, "automation_blocked", { problems: [why] });
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
