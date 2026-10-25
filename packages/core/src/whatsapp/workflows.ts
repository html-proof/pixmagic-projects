/**
 * Workflows: trigger → conditions → an approved template → timing. The merchant builds them in the
 * dashboard; Shopify's webhooks (events.ts) and custom events start them.
 *
 * A workflow runs at most once per order, checkout, customer or event (a unique run row), so
 * Shopify's retries and duplicate deliveries message nobody twice. A run that doesn't send says
 * why (its conditions, no number, no consent, the template not approved), and so does every
 * message: the history is the merchant's way to see what happened. Workflows never trigger each
 * other, so they can't loop.
 */
import { randomBytes } from "node:crypto";
import { Prisma, systemDb, type Store, type WaConnection, type WaTemplate, type WaWorkflow } from "@app/db";
import {
  consentProblem,
  CONSENT_SOURCE_LABEL,
  DEFAULT_SEND_WINDOW,
  evaluateWorkflowConditions,
  missingValues,
  normalizePhone,
  renderTemplate,
  sha256Hex,
  templateShape,
  TRIGGER_INFO,
  VARIABLE_INFO,
  workflowSchema,
  type CustomEventInput,
  type NormalizedPhone,
  type SendValues,
  type TemplateComponent,
  type TemplateMapping,
  type WorkflowCondition,
  type WorkflowFacts,
  type WorkflowInput,
  type WorkflowTrigger,
} from "@app/shared";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { canSend, liveConnection, settingsOf, storeLabel, testPhoneOf, waEncrypt, WhatsappError, type WaDeps, type WaSettingsView } from "./common.js";
import { consentFacts, setConsent, upsertContact, type ContactDetails } from "./contacts.js";
import { cancelQueued, queueMessage } from "./messages.js";

/** Events older than this start nothing (a replayed webhook, a backfill): customers aren't told about old news. */
export const STALE_EVENT_MS = 48 * 3600_000;

/** What a workflow row says, as the builder's input. */
export function workflowInput(w: WaWorkflow): WorkflowInput {
  return {
    name: w.name,
    trigger: w.trigger as WorkflowTrigger,
    eventName: w.eventName,
    conditions: (w.conditions ?? []) as unknown as WorkflowCondition[],
    template: { name: w.templateName, language: w.templateLanguage },
    mapping: w.mapping as unknown as TemplateMapping,
    headerMediaUrl: w.headerMediaUrl,
    timing: w.timingMode === "before_event" ? { mode: "before_event", minutes: w.timingMinutes } : { mode: "after_trigger", minutes: w.timingMinutes },
    sendWindow: w.sendWindowStart !== null && w.sendWindowEnd !== null ? { start: w.sendWindowStart, end: w.sendWindowEnd } : null,
  };
}

function rowData(input: WorkflowInput, templateCategory: string | null) {
  // Marketing messages wait for sending hours unless the merchant chose others (or none).
  const window = input.sendWindow === undefined ? (templateCategory === "MARKETING" ? DEFAULT_SEND_WINDOW : null) : input.sendWindow;
  return {
    name: input.name,
    trigger: input.trigger,
    eventName: input.trigger === "custom_event" ? (input.eventName ?? null) : null,
    conditions: input.conditions as unknown as Prisma.InputJsonValue,
    templateName: input.template.name,
    templateLanguage: input.template.language,
    mapping: input.mapping as unknown as Prisma.InputJsonValue,
    headerMediaUrl: input.headerMediaUrl ?? null,
    timingMode: input.timing.mode,
    timingMinutes: input.timing.minutes,
    sendWindowStart: window ? window.start : null,
    sendWindowEnd: window ? window.end : null,
  };
}

/**
 * Why a workflow can't be switched on (empty: it can). The same list the builder shows, so the
 * merchant sees every reason before pressing Activate.
 */
export function workflowProblems(input: WorkflowInput, ctx: { template: WaTemplate | null; conn: WaConnection | null; settings: WaSettingsView }): string[] {
  const out: string[] = [];
  if (!canSend(ctx.conn)) out.push("Connect WhatsApp and finish its setup first.");
  const t = ctx.template;
  if (!t) out.push(`The template "${input.template.name}" (${input.template.language}) isn't in your WhatsApp account.`);
  else if (t.status === "PENDING" || t.status === "IN_APPEAL") out.push(`The template "${t.name}" is waiting for Meta's review.`);
  else if (t.status !== "APPROVED") out.push(`Meta didn't approve the template "${t.name}" (${t.status.toLowerCase()}${t.rejectedReason ? `: ${t.rejectedReason}` : ""}).`);
  if (t) {
    const shape = templateShape(t.components as unknown as TemplateComponent[]);
    if (input.mapping.body.length < shape.bodyVars) out.push(`Choose what fills each of the template's ${shape.bodyVars} variables.`);
    if (shape.headerVars && !input.mapping.header) out.push("Choose what fills the template's header.");
    if (input.mapping.buttons.length < shape.dynamicUrlButtons.length) out.push("Choose what completes the template's link button.");
    if (["IMAGE", "VIDEO", "DOCUMENT"].includes(shape.headerFormat) && !input.headerMediaUrl) out.push(`Add the link to the ${shape.headerFormat.toLowerCase()} the template's header shows.`);
    if (t.category === "AUTHENTICATION") out.push("Authentication templates (one-time codes) can't be sent from a workflow.");
    if ((input.trigger === "checkout_abandoned" || input.trigger === "customer_created") && t.category !== "MARKETING") {
      out.push(`${TRIGGER_INFO[input.trigger].label} messages are marketing under WhatsApp's rules: choose a Marketing template.`);
    }
    if (t.category === "UTILITY" && ctx.settings.orderUpdates === "unset") out.push("Choose how customers agree to order updates (WhatsApp Automation → Settings): until then nobody receives this.");
  }
  return out;
}

async function templateOf(storeId: string, ref: { name: string; language: string }) {
  return systemDb.waTemplate.findUnique({ where: { storeId_name_language: { storeId, name: ref.name, language: ref.language } } });
}

/** Save a workflow (new, or an edit). An active workflow stays active only if it still could be switched on. */
export async function saveWorkflow(input: { store: Store; userId: string | null; id?: string; data: unknown; ip?: string }): Promise<WaWorkflow> {
  const data = workflowSchema.parse(input.data);
  const template = await templateOf(input.store.id, data.template);
  if (input.id) {
    const current = await systemDb.waWorkflow.findFirst({ where: { id: input.id, storeId: input.store.id } });
    if (!current) throw new WhatsappError("That workflow wasn't found.", 404, "not_found");
    if (current.status === "active") {
      const problems = workflowProblems(data, { template, conn: await liveConnection(input.store.id), settings: await settingsOf(input.store.id) });
      if (problems.length) throw new WhatsappError(`Pause the workflow before saving this change: ${problems[0]}`, 409, "workflow_problems", { problems });
    }
    const updated = await systemDb.waWorkflow.update({ where: { id: current.id }, data: { ...rowData(data, template?.category ?? null), version: { increment: 1 }, updatedByUserId: input.userId } });
    await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.workflow_updated", targetType: "whatsapp_workflow", targetId: updated.id, metadata: { name: updated.name, trigger: updated.trigger }, ip: input.ip });
    return updated;
  }
  const count = await systemDb.waWorkflow.count({ where: { storeId: input.store.id } });
  if (count >= 50) throw new WhatsappError("A store can have up to 50 workflows. Delete one you no longer use first.", 409, "too_many");
  const made = await systemDb.waWorkflow.create({
    data: { workspaceId: input.store.workspaceId, storeId: input.store.id, ...rowData(data, template?.category ?? null), status: "draft", createdByUserId: input.userId, updatedByUserId: input.userId },
  });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.workflow_created", targetType: "whatsapp_workflow", targetId: made.id, metadata: { name: made.name, trigger: made.trigger }, ip: input.ip });
  return made;
}

async function workflowOf(storeId: string, id: string): Promise<WaWorkflow> {
  const w = await systemDb.waWorkflow.findFirst({ where: { id, storeId } });
  if (!w) throw new WhatsappError("That workflow wasn't found.", 404, "not_found");
  return w;
}

/** Problems of a stored workflow, as the builder and Activate see them. */
export async function storedWorkflowProblems(w: WaWorkflow): Promise<string[]> {
  return workflowProblems(workflowInput(w), { template: await templateOf(w.storeId, { name: w.templateName, language: w.templateLanguage }), conn: await liveConnection(w.storeId), settings: await settingsOf(w.storeId) });
}

/**
 * Switch a workflow on: from now on its trigger sends (it doesn't reach back to earlier events).
 * `subscribeCustomers` subscribes the store to customers/create for a "New customer" workflow
 * (events.ts ensureCustomerWebhook), and says why it can't.
 */
export async function activateWorkflow(input: { store: Store; id: string; userId: string | null; ip?: string; subscribeCustomers?: () => Promise<string | null> }): Promise<WaWorkflow> {
  const w = await workflowOf(input.store.id, input.id);
  const problems = await storedWorkflowProblems(w);
  if (problems.length) throw new WhatsappError(problems[0]!, 409, "workflow_problems", { problems });
  if (w.trigger === "customer_created" && input.subscribeCustomers) {
    const why = await input.subscribeCustomers().catch((err: unknown) => {
      logger.warn({ err, storeId: input.store.id }, "whatsapp: customers/create subscription failed");
      return "Shopify didn't answer while bizinsights asked to hear about new customers. Try again in a minute.";
    });
    if (why) throw new WhatsappError(why, 409, "workflow_problems", { problems: [why] });
  }
  const updated = await systemDb.waWorkflow.update({ where: { id: w.id }, data: { status: "active", activatedAt: new Date(), updatedByUserId: input.userId } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.workflow_activated", targetType: "whatsapp_workflow", targetId: w.id, metadata: { name: w.name, trigger: w.trigger }, ip: input.ip });
  return updated;
}

/** Pause a workflow: what it was still waiting to send is cancelled. */
export async function pauseWorkflow(input: { store: Store; id: string; userId: string | null; ip?: string }): Promise<{ workflow: WaWorkflow; cancelled: number }> {
  const w = await workflowOf(input.store.id, input.id);
  const updated = await systemDb.waWorkflow.update({ where: { id: w.id }, data: { status: "paused", updatedByUserId: input.userId } });
  const cancelled = await cancelQueued({ workflowId: w.id }, "workflow_paused");
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.workflow_paused", targetType: "whatsapp_workflow", targetId: w.id, metadata: { name: w.name, cancelled }, ip: input.ip });
  return { workflow: updated, cancelled };
}

/** Delete a workflow and its runs; its messages stay in the history, what was waiting is cancelled. */
export async function deleteWorkflow(input: { store: Store; id: string; userId: string | null; ip?: string }): Promise<void> {
  const w = await workflowOf(input.store.id, input.id);
  await cancelQueued({ workflowId: w.id }, "workflow_paused");
  await systemDb.$transaction([systemDb.waWorkflowRun.deleteMany({ where: { workflowId: w.id } }), systemDb.waWorkflow.delete({ where: { id: w.id } })]);
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.workflow_deleted", targetType: "whatsapp_workflow", targetId: w.id, metadata: { name: w.name }, ip: input.ip });
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** What an event is about, as the workflows it starts read it. */
export interface WorkflowSubject {
  store: Store;
  trigger: WorkflowTrigger;
  /** custom_event: the event's name. */
  eventName?: string | null;
  /** Once per workflow: "order:<id>", "checkout:<token>", "customer:<id>", "event:<name>:<id>". */
  key: string;
  /** What the merchant recognises in the history. */
  label: string;
  phone: NormalizedPhone | null;
  contact: ContactDetails;
  /** Shopify's text-message consent on the event (used only when the store says it covers WhatsApp). */
  shopifyConsent?: "opted_in" | "opted_out" | null;
  /** A custom event saying the customer agreed to WhatsApp marketing in the store's own tool. */
  merchantConsent?: boolean;
  values: SendValues;
  facts: WorkflowFacts;
  /** When it happened (stale events start nothing); for a checkout, the customer's last change. */
  occurredAt: Date;
  /** Custom events: when the appointment or event itself is (for "before the event" timing). */
  eventAt?: Date | null;
  /** A checkout the customer is still changing: an existing run's waiting reminder moves later. */
  retime?: boolean;
}

export interface RunResult {
  workflows: number;
  scheduled: number;
  skipped: number;
}

/** Record consent the event carries, before any workflow reads it. */
async function captureConsent(subject: WorkflowSubject, settings: WaSettingsView) {
  if (!subject.phone) return null;
  const shopify = settings.shopifySmsConsent ? (subject.shopifyConsent ?? null) : null;
  if (!shopify && !subject.merchantConsent) return null;
  let contact = await upsertContact(subject.store, subject.phone, subject.contact);
  const at = subject.occurredAt;
  if (shopify) contact = (await setConsent(contact, { scope: "marketing", status: shopify, source: "shopify_sms", at })).contact;
  if (subject.merchantConsent) contact = (await setConsent(contact, { scope: "marketing", status: "opted_in", source: "merchant", at, note: `${CONSENT_SOURCE_LABEL.merchant}: sent with the event "${subject.eventName ?? ""}"` })).contact;
  return contact;
}

/** Start every active workflow on this trigger. A no-op for a store without a live WhatsApp connection. */
export async function runWorkflows(deps: Pick<WaDeps, "queues">, subject: WorkflowSubject): Promise<RunResult> {
  const result: RunResult = { workflows: 0, scheduled: 0, skipped: 0 };
  const conn = await liveConnection(subject.store.id);
  if (!conn) return result;
  const settings = await settingsOf(subject.store.id);
  let captured = await captureConsent(subject, settings);
  const workflows = await systemDb.waWorkflow.findMany({
    where: { storeId: subject.store.id, trigger: subject.trigger, status: "active", ...(subject.trigger === "custom_event" ? { eventName: subject.eventName ?? "" } : {}) },
  });
  const now = Date.now();
  for (const wf of workflows) {
    result.workflows++;
    const input = workflowInput(wf);
    let run;
    try {
      run = await systemDb.waWorkflowRun.create({
        data: { workspaceId: wf.workspaceId, storeId: wf.storeId, workflowId: wf.id, workflowVersion: wf.version, trigger: subject.trigger, subjectKey: subject.key, subjectLabel: subject.label.slice(0, 120), outcome: "pending" },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      // Ran already. A checkout still being changed moves its waiting reminder later, with the newest values.
      if (subject.retime) await retimeRun(wf, subject, input);
      continue;
    }
    const skip = async (reason: string, detail?: string) => {
      await systemDb.waWorkflowRun.update({ where: { id: run.id }, data: { outcome: "skipped", reason: detail ? `${reason}: ${detail}`.slice(0, 300) : reason } });
      result.skipped++;
    };
    if (now - subject.occurredAt.getTime() > STALE_EVENT_MS) {
      await skip("stale");
      continue;
    }
    const cond = evaluateWorkflowConditions(input.conditions, subject.facts);
    if (!cond.pass) {
      await skip("conditions_not_met", cond.failed.join("; "));
      continue;
    }
    if (!subject.phone) {
      await skip("no_phone");
      continue;
    }
    const template = await templateOf(wf.storeId, input.template);
    if (!template || template.status !== "APPROVED") {
      await skip("template_not_approved");
      continue;
    }
    const shape = templateShape(template.components as unknown as TemplateComponent[]);
    const missing = missingValues(shape, input.mapping, subject.values);
    if (missing.length) {
      await skip("missing_values", missing.join(", "));
      continue;
    }
    const contact = captured ?? (await upsertContact(subject.store, subject.phone, subject.contact));
    captured = contact;
    const problem = consentProblem(template.category, consentFacts(contact), { orderUpdates: settings.orderUpdates });
    if (problem) {
      await systemDb.waWorkflowRun.update({ where: { id: run.id }, data: { contactId: contact.id } });
      await skip(problem);
      continue;
    }
    let sendAfter: Date;
    if (input.timing.mode === "before_event") {
      if (!subject.eventAt || subject.eventAt.getTime() <= now) {
        await skip("stale", "the event's time has passed");
        continue;
      }
      sendAfter = new Date(Math.max(now, subject.eventAt.getTime() - input.timing.minutes * 60_000));
    } else {
      sendAfter = new Date(Math.max(now, subject.occurredAt.getTime() + input.timing.minutes * 60_000));
    }
    const { message } = await queueMessage(
      {
        store: subject.store,
        connectionId: conn.id,
        contact,
        source: "workflow",
        idempotencyKey: `wf:${wf.id}:${subject.key}`,
        workflowId: wf.id,
        workflowRunId: run.id,
        template: { name: template.name, language: template.language, category: template.category },
        payload: { kind: "template", mapping: input.mapping, values: subject.values, headerMediaUrl: input.headerMediaUrl ?? null },
        preview: renderTemplate(template.components as unknown as TemplateComponent[], input.mapping, subject.values).body,
        sendAfter,
      },
      deps,
    );
    await systemDb.waWorkflowRun.update({ where: { id: run.id }, data: { outcome: "scheduled", messageId: message.id, contactId: contact.id } });
    await systemDb.waWorkflow.update({ where: { id: wf.id }, data: { lastRunAt: new Date() } });
    result.scheduled++;
  }
  if (result.workflows) logger.info({ storeId: subject.store.id, trigger: subject.trigger, ...result }, "whatsapp workflows ran");
  return result;
}

/** A checkout reminder still waiting moves to `delay` after the customer's latest change. */
async function retimeRun(wf: WaWorkflow, subject: WorkflowSubject, input: WorkflowInput) {
  const run = await systemDb.waWorkflowRun.findUnique({ where: { workflowId_subjectKey: { workflowId: wf.id, subjectKey: subject.key } } });
  if (!run?.messageId || input.timing.mode !== "after_trigger") return;
  const sendAfter = new Date(Math.max(Date.now(), subject.occurredAt.getTime() + input.timing.minutes * 60_000));
  await systemDb.waMessage.updateMany({
    where: { id: run.messageId, status: "queued" },
    data: { sendAfter, enqueuedAt: null, payloadEnc: waEncrypt(wf.storeId, "payload", JSON.stringify({ kind: "template", mapping: input.mapping, values: subject.values, headerMediaUrl: input.headerMediaUrl ?? null })) },
  });
}

/** Cancel what workflows still wait to send about one order or checkout (it was cancelled, or completed). */
export async function cancelSubject(storeId: string, subjectKey: string, reason: "order_cancelled" | "checkout_completed", exceptTrigger?: WorkflowTrigger): Promise<number> {
  const runs = await systemDb.waWorkflowRun.findMany({
    where: { storeId, subjectKey, messageId: { not: null }, ...(exceptTrigger ? { trigger: { not: exceptTrigger } } : {}) },
    select: { messageId: true },
  });
  if (!runs.length) return 0;
  return cancelQueued({ id: { in: runs.map((r) => r.messageId!) } }, reason);
}

// ---------------------------------------------------------------------------
// Tests and custom events
// ---------------------------------------------------------------------------

/** Values that fill a test message: the store's real name, sample values for the rest. */
export function sampleValues(store: Pick<Store, "name" | "shopDomain">, eventValues: Record<string, string> = {}): SendValues {
  const v: SendValues = {};
  for (const [k, info] of Object.entries(VARIABLE_INFO)) if (k !== "custom_text" && k !== "event_value") (v as Record<string, string>)[k] = info.sample;
  v.store_name = storeLabel(store);
  v.event = { ...eventValues };
  return v;
}

/** Send a workflow's (or any approved template's) message to the merchant's own test number now. */
export async function sendTest(deps: Pick<WaDeps, "queues">, input: { store: Store; userId: string | null; template: { name: string; language: string }; mapping: TemplateMapping; headerMediaUrl?: string | null; label: string }) {
  const conn = await liveConnection(input.store.id);
  if (!canSend(conn)) throw new WhatsappError("Connect WhatsApp and finish its setup before sending a test.", 409, "not_connected");
  const to = await testPhoneOf(input.store.id);
  if (!to) throw new WhatsappError("Add your own WhatsApp number in Settings first: tests go only to it.", 409, "no_test_phone");
  const template = await templateOf(input.store.id, input.template);
  if (!template || template.status !== "APPROVED") throw new WhatsappError("Only a template Meta approved can be sent. Wait for the review, or choose another.", 409, "template_not_approved");
  const values = sampleValues(input.store, Object.fromEntries(input.mapping.body.filter((r) => r.source === "event_value" && r.text).map((r) => [r.text!, `[${r.text}]`])));
  const { message } = await queueMessage(
    {
      store: input.store,
      connectionId: conn!.id,
      to,
      source: "test",
      idempotencyKey: `test:${input.label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      template: { name: template.name, language: template.language, category: template.category },
      payload: { kind: "template", mapping: input.mapping, values, headerMediaUrl: input.headerMediaUrl ?? null },
      preview: renderTemplate(template.components as unknown as TemplateComponent[], input.mapping, values).body,
      createdByUserId: input.userId,
    },
    deps,
  );
  return message;
}

/** Format a time in the store's time zone for event_date / event_time. */
function eventDateParts(at: Date, timeZone: string): { date: string; time: string } {
  const tz = timeZone || "UTC";
  return {
    date: new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(at),
    time: new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at),
  };
}

/**
 * A custom event from the store's own tools (an appointment booked, a service visit): starts the
 * workflows listening for its name. Idempotent per event id.
 */
export async function receiveCustomEvent(deps: Pick<WaDeps, "queues">, input: { store: Store; event: CustomEventInput }): Promise<RunResult> {
  const e = input.event;
  const phone = normalizePhone(e.phone, e.country ?? null);
  if (!phone) throw new WhatsappError("That phone number can't be read as an international number. Send it with its country code, like +61412345678.", 400, "invalid_phone");
  const conn = await liveConnection(input.store.id);
  if (!conn) throw new WhatsappError("Connect WhatsApp first.", 409, "not_connected");
  const at = e.at ? new Date(e.at) : null;
  const parts = at ? eventDateParts(at, input.store.timezone ?? "UTC") : null;
  return runWorkflows(deps, {
    store: input.store,
    trigger: "custom_event",
    eventName: e.event,
    key: `event:${e.event}:${e.eventId}`,
    label: `Event ${e.event}`,
    phone,
    contact: { firstName: e.firstName ?? null },
    merchantConsent: e.marketingConsent === true,
    values: {
      customer_first_name: e.firstName ?? undefined,
      store_name: storeLabel(input.store),
      ...(parts ? { event_date: parts.date, event_time: parts.time } : {}),
      event: e.values ?? {},
    },
    facts: { orderTotal: null, country: phone.country, productTitles: [], customerType: null, tags: [], paymentMethods: [] },
    occurredAt: new Date(),
    eventAt: at,
  });
}

// ---------------------------------------------------------------------------
// The store's custom-event key: how its own tools (a booking system, a form, Zapier) send events
// ---------------------------------------------------------------------------

const EVENT_KEY_PREFIX = "whev_";

/**
 * Make a new custom-event key for the store (the old one stops working at once). The key is shown
 * this once; only its SHA-256 is kept. Tools send it as `Authorization: Bearer whev_...`.
 */
export async function rotateEventKey(input: { store: Store; userId: string | null; ip?: string }): Promise<string> {
  const key = `${EVENT_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const data = { eventKeyHash: sha256Hex(key), eventKeyHint: key.slice(-4), eventKeyCreatedAt: new Date(), updatedByUserId: input.userId };
  await systemDb.waSettings.upsert({ where: { storeId: input.store.id }, create: { storeId: input.store.id, workspaceId: input.store.workspaceId, ...data }, update: data });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.event_key_created", targetType: "store", targetId: input.store.id, ip: input.ip });
  return key;
}

/** Turn the custom-event key off. */
export async function revokeEventKey(input: { store: Store; userId: string | null; ip?: string }): Promise<void> {
  await systemDb.waSettings.updateMany({ where: { storeId: input.store.id }, data: { eventKeyHash: null, eventKeyHint: null, eventKeyCreatedAt: null } });
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.event_key_revoked", targetType: "store", targetId: input.store.id, ip: input.ip });
}

/** The store a custom-event key belongs to (null: no such key, or the store left). */
export async function storeForEventKey(key: string): Promise<Store | null> {
  if (!key.startsWith(EVENT_KEY_PREFIX) || key.length > 100) return null;
  const s = await systemDb.waSettings.findUnique({ where: { eventKeyHash: sha256Hex(key) }, select: { storeId: true } });
  if (!s) return null;
  const store = await systemDb.store.findUnique({ where: { id: s.storeId } });
  return store && store.status !== "uninstalled" ? store : null;
}
