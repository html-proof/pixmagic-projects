/**
 * Workflows: trigger → conditions → an approved template → timing. The merchant builds them in the
 * dashboard; Shopify's webhooks (events.ts) and custom events start them.
 *
 * A workflow runs at most once per order, checkout, customer or event (a unique run row), so
 * Shopify's retries and duplicate deliveries message nobody twice. A run that doesn't send says
 * why (its conditions, no number, no consent, the template not approved), and so does every
 * message: the history is the merchant's way to see what happened. Workflows never trigger each
 * other, so they can't loop.
 *
 * "Customer sends a message" workflows (`runReplyWorkflows`) answer a customer's message with the
 * merchant's own text: WhatsApp allows that without a template because the customer has just
 * written (its 24-hour window is open). They run once per message, and the same customer gets a
 * workflow's reply at most once in its cool-down, so a conversation isn't answered over and over.
 *
 * While the store has paused all automation, every trigger is recorded as a run that sent nothing
 * ("automation_paused"), so the merchant sees what they missed.
 */
import { randomBytes } from "node:crypto";
import { Prisma, systemDb, type Store, type WaConnection, type WaContact, type WaTemplate, type WaWorkflow } from "@app/db";
import {
  consentProblem,
  CONSENT_SOURCE_LABEL,
  DEFAULT_REPLY_COOLDOWN_MINUTES,
  DEFAULT_SEND_WINDOW,
  evaluateWorkflowConditions,
  expandScopes,
  missingValues,
  normalizePhone,
  renderTemplate,
  sha256Hex,
  templateShape,
  TRIGGER_INFO,
  VARIABLE_INFO,
  WORKFLOW_TRIGGERS,
  workflowSchema,
  zonedHour,
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
import { appWebhookTopics } from "../apps.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { canSend, liveConnection, settingsOf, storeLabel, testPhoneOf, waEncrypt, WhatsappError, type WaDeps, type WaSettingsView } from "./common.js";
import { consentFacts, setConsent, upsertContact, type ContactDetails } from "./contacts.js";
import { cancelQueued, queueMessage } from "./messages.js";

/** Events older than this start nothing (a replayed webhook, a backfill): customers aren't told about old news. */
export const STALE_EVENT_MS = 48 * 3600_000;
/** A customer's message older than this gets no automatic reply (a webhook Meta held back): it would answer old news. */
export const STALE_REPLY_MS = 60 * 60_000;

const isReply = (trigger: WorkflowTrigger) => TRIGGER_INFO[trigger].sends === "reply";

/** What a workflow row says, as the builder's input. */
export function workflowInput(w: WaWorkflow): WorkflowInput {
  const trigger = w.trigger as WorkflowTrigger;
  return {
    name: w.name,
    trigger,
    eventName: w.eventName,
    conditions: (w.conditions ?? []) as unknown as WorkflowCondition[],
    template: w.templateName ? { name: w.templateName, language: w.templateLanguage } : null,
    mapping: w.mapping as unknown as TemplateMapping,
    headerMediaUrl: w.headerMediaUrl,
    replyText: w.replyText,
    replyCooldownMinutes: w.replyCooldownMinutes,
    timing: w.timingMode === "before_event" ? { mode: "before_event", minutes: w.timingMinutes } : { mode: "after_trigger", minutes: w.timingMinutes },
    sendWindow: w.sendWindowStart !== null && w.sendWindowEnd !== null ? { start: w.sendWindowStart, end: w.sendWindowEnd } : null,
  };
}

function rowData(input: WorkflowInput, templateCategory: string | null) {
  // Marketing messages wait for sending hours unless the merchant chose others (or none).
  const window = input.sendWindow === undefined ? (templateCategory === "MARKETING" ? DEFAULT_SEND_WINDOW : null) : input.sendWindow;
  const reply = isReply(input.trigger);
  return {
    name: input.name,
    trigger: input.trigger,
    eventName: input.trigger === "custom_event" ? (input.eventName ?? null) : null,
    conditions: input.conditions as unknown as Prisma.InputJsonValue,
    // A reply workflow has no template: "" keeps the columns as the release before reads them.
    templateName: reply ? "" : (input.template?.name ?? ""),
    templateLanguage: reply ? "" : (input.template?.language ?? ""),
    mapping: input.mapping as unknown as Prisma.InputJsonValue,
    headerMediaUrl: reply ? null : (input.headerMediaUrl ?? null),
    replyText: reply ? (input.replyText ?? null) : null,
    replyCooldownMinutes: reply ? (input.replyCooldownMinutes ?? DEFAULT_REPLY_COOLDOWN_MINUTES) : null,
    timingMode: input.timing.mode,
    timingMinutes: input.timing.minutes,
    sendWindowStart: window ? window.start : null,
    sendWindowEnd: window ? window.end : null,
  };
}

// ---------------------------------------------------------------------------
// Which triggers this store can use
// ---------------------------------------------------------------------------

export interface TriggerAvailability {
  available: boolean;
  /** Why not, in the merchant's words (null when it is). */
  reason: string | null;
  /** What fixes it: Shopify access to grant, or WhatsApp's webhooks to finish. */
  fix: "shopify_access" | "whatsapp_webhooks" | null;
}

const NOT_SENT_BY_APP =
  "Your store is connected through bizinsights' App Store app, which Shopify doesn't send order and checkout events to until it approves bizinsights' access to protected customer data. This trigger can't start a message yet.";

/**
 * What each trigger can do for this store: Shopify's events only where the store's app receives
 * them (an App Store store gets no order or checkout events until Shopify approves protected
 * customer data), new customers only with read_customers, customers' messages only once WhatsApp's
 * webhooks reach bizinsights. Nothing is offered as working when it can't start a message.
 */
export function triggerAvailability(store: Pick<Store, "shopifyAppKey" | "grantedScopes">, conn: Pick<WaConnection, "subscribedAt"> | null): Record<WorkflowTrigger, TriggerAvailability> {
  const app = appWebhookTopics(store.shopifyAppKey);
  const scopes = expandScopes(store.grantedScopes);
  const ok: TriggerAvailability = { available: true, reason: null, fix: null };
  const out = {} as Record<WorkflowTrigger, TriggerAvailability>;
  for (const t of WORKFLOW_TRIGGERS) {
    const info = TRIGGER_INFO[t];
    if (t === "message_received") {
      out[t] = conn?.subscribedAt ? ok : { available: false, reason: "Customers' messages aren't reaching bizinsights yet. Press Check again on the Overview; once WhatsApp's webhooks are set up this trigger works.", fix: "whatsapp_webhooks" };
    } else if (t === "customer_created") {
      out[t] = scopes.has("read_customers")
        ? ok
        : { available: false, reason: "bizinsights needs permission to read your customers in Shopify to hear about new ones. Update the bizinsights app's access in Shopify, then come back.", fix: "shopify_access" };
    } else if (info.topics.length && app && !info.topics.some((topic) => app.includes(topic))) {
      out[t] = { available: false, reason: NOT_SENT_BY_APP, fix: null };
    } else {
      out[t] = ok;
    }
  }
  return out;
}

/**
 * Why a workflow can't be switched on (empty: it can). The same list the builder shows, so the
 * merchant sees every reason before pressing Activate.
 */
export function workflowProblems(input: WorkflowInput, ctx: { template: WaTemplate | null; conn: WaConnection | null; settings: WaSettingsView; availability?: Record<WorkflowTrigger, TriggerAvailability> | null }): string[] {
  const out: string[] = [];
  if (!canSend(ctx.conn)) out.push("Connect WhatsApp and finish its setup first.");
  const available = ctx.availability?.[input.trigger];
  if (available && !available.available && available.reason) out.push(available.reason);
  if (isReply(input.trigger)) {
    if (!input.replyText?.trim()) out.push("Write the reply customers receive.");
    return out;
  }
  if (!input.template) {
    out.push("Choose the approved template to send.");
    return out;
  }
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

async function templateOf(storeId: string, ref: { name: string; language: string } | null | undefined) {
  if (!ref?.name) return null;
  return systemDb.waTemplate.findUnique({ where: { storeId_name_language: { storeId, name: ref.name, language: ref.language } } });
}

/** Everything workflowProblems reads, for one store. */
export async function workflowContext(store: Pick<Store, "id" | "shopifyAppKey" | "grantedScopes">, template: { name: string; language: string } | null | undefined) {
  const conn = await liveConnection(store.id);
  return { template: await templateOf(store.id, template), conn, settings: await settingsOf(store.id), availability: triggerAvailability(store, conn) };
}

/** Save a workflow (new, or an edit). An active workflow stays active only if it still could be switched on. */
export async function saveWorkflow(input: { store: Store; userId: string | null; id?: string; data: unknown; ip?: string }): Promise<WaWorkflow> {
  const data = workflowSchema.parse(input.data);
  const template = await templateOf(input.store.id, data.template);
  if (input.id) {
    const current = await systemDb.waWorkflow.findFirst({ where: { id: input.id, storeId: input.store.id } });
    if (!current) throw new WhatsappError("That workflow wasn't found.", 404, "not_found");
    if (current.status === "active") {
      const problems = workflowProblems(data, await workflowContext(input.store, data.template));
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

/** Problems of a stored workflow, as the builder and Activate see them (`store`: its store, when the caller has it). */
export async function storedWorkflowProblems(w: WaWorkflow, store?: Pick<Store, "id" | "shopifyAppKey" | "grantedScopes"> | null): Promise<string[]> {
  const input = workflowInput(w);
  const s = store ?? (await systemDb.store.findUnique({ where: { id: w.storeId }, select: { id: true, shopifyAppKey: true, grantedScopes: true } }));
  if (!s) return ["The store isn't connected to bizinsights any more."];
  return workflowProblems(input, await workflowContext(s, input.template));
}

/**
 * The store's switched-on workflows that something stops from sending (a template Meta rejected
 * later, the consent choice undone, a trigger the store's Shopify app no longer receives), with why.
 * The overview reads it to say "Needs attention" rather than "Active".
 */
export async function blockedActiveWorkflows(store: Pick<Store, "id" | "shopifyAppKey" | "grantedScopes">): Promise<Array<{ id: string; name: string; problems: string[] }>> {
  const active = await systemDb.waWorkflow.findMany({ where: { storeId: store.id, status: "active" }, orderBy: { createdAt: "asc" }, take: 50 });
  if (!active.length) return [];
  const conn = await liveConnection(store.id);
  const [settings, templates] = await Promise.all([settingsOf(store.id), systemDb.waTemplate.findMany({ where: { storeId: store.id } })]);
  const availability = triggerAvailability(store, conn);
  const byRef = new Map(templates.map((t) => [`${t.name}|${t.language}`, t]));
  const out: Array<{ id: string; name: string; problems: string[] }> = [];
  for (const w of active) {
    const input = workflowInput(w);
    const problems = workflowProblems(input, { template: input.template ? (byRef.get(`${input.template.name}|${input.template.language}`) ?? null) : null, conn, settings, availability });
    if (problems.length) out.push({ id: w.id, name: w.name, problems });
  }
  return out;
}

/**
 * Switch a workflow on: from now on its trigger sends (it doesn't reach back to earlier events).
 * `subscribeCustomers` subscribes the store to customers/create for a "New customer" workflow
 * (events.ts ensureCustomerWebhook), and says why it can't.
 */
export async function activateWorkflow(input: { store: Store; id: string; userId: string | null; ip?: string; subscribeCustomers?: () => Promise<string | null> }): Promise<WaWorkflow> {
  const w = await workflowOf(input.store.id, input.id);
  const problems = await storedWorkflowProblems(w, input.store);
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
    if (settings.automationPausedAt) {
      await skip("automation_paused");
      continue;
    }
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

/** A customer's message, as "Customer sends a message" workflows read it. */
export interface InboundSubject {
  conn: WaConnection;
  contact: WaContact;
  /** Meta's id of the customer's message: each workflow answers a message once. */
  wamid: string;
  /** What it says (null: media without a caption, a location...). */
  text: string | null;
  at: Date;
}

/**
 * Answer a customer's message with every switched-on "Customer sends a message" workflow whose
 * conditions hold. Safe to run again for the same message (one run per workflow and message), and
 * the same customer gets a workflow's reply at most once in its cool-down. STOP and START never get
 * here (webhook.ts handles them); a customer who stopped messages gets nothing.
 */
export async function runReplyWorkflows(deps: Pick<WaDeps, "queues" | "coord">, s: InboundSubject): Promise<RunResult> {
  const result: RunResult = { workflows: 0, scheduled: 0, skipped: 0 };
  if (!canSend(s.conn)) return result;
  const workflows = await systemDb.waWorkflow.findMany({ where: { storeId: s.conn.storeId, trigger: "message_received", status: "active" }, orderBy: { createdAt: "asc" } });
  if (!workflows.length) return result;
  const [store, settings] = await Promise.all([systemDb.store.findUnique({ where: { id: s.conn.storeId }, select: { id: true, workspaceId: true, timezone: true, status: true } }), settingsOf(s.conn.storeId)]);
  if (!store || store.status === "uninstalled") return result;
  const now = Date.now();
  const facts: WorkflowFacts = {
    orderTotal: null,
    country: s.contact.country,
    productTitles: [],
    customerType: null,
    tags: [],
    paymentMethods: [],
    messageText: s.text,
    localHour: zonedHour(s.at, store.timezone || "UTC").hour,
  };
  for (const wf of workflows) {
    result.workflows++;
    let run;
    try {
      run = await systemDb.waWorkflowRun.create({
        data: { workspaceId: wf.workspaceId, storeId: wf.storeId, workflowId: wf.id, workflowVersion: wf.version, trigger: "message_received", subjectKey: `message:${s.wamid}`, subjectLabel: `Message from ${s.contact.phoneMasked}`.slice(0, 120), outcome: "pending", contactId: s.contact.id },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
    const skip = async (reason: string, detail?: string) => {
      await systemDb.waWorkflowRun.update({ where: { id: run.id }, data: { outcome: "skipped", reason: detail ? `${reason}: ${detail}`.slice(0, 300) : reason } });
      result.skipped++;
    };
    if (settings.automationPausedAt) {
      await skip("automation_paused");
      continue;
    }
    if (s.contact.optedOut) {
      await skip("opted_out");
      continue;
    }
    if (now - s.at.getTime() > STALE_REPLY_MS) {
      await skip("stale");
      continue;
    }
    const input = workflowInput(wf);
    const cond = evaluateWorkflowConditions(input.conditions, facts);
    if (!cond.pass) {
      await skip("conditions_not_met", cond.failed.join("; "));
      continue;
    }
    const text = input.replyText?.trim();
    if (!text) {
      await skip("missing_values", "the reply is empty");
      continue;
    }
    // Once per customer per cool-down: the lease stops two messages answered at the same moment,
    // the run history stops it across leases (a lost lease, a lease shorter than a long cool-down).
    const cooldown = input.replyCooldownMinutes ?? DEFAULT_REPLY_COOLDOWN_MINUTES;
    const lease = `wa:reply:${wf.id}:${s.contact.id}`;
    if (cooldown > 0) {
      const recent = await systemDb.waWorkflowRun.findFirst({ where: { workflowId: wf.id, contactId: s.contact.id, outcome: "scheduled", createdAt: { gte: new Date(now - cooldown * 60_000) } }, select: { id: true } });
      if (recent || !(await deps.coord.acquire(lease, cooldown * 60_000).catch(() => true))) {
        await skip("recently_replied");
        continue;
      }
    }
    let message;
    try {
      ({ message } = await queueMessage(
        {
          store,
          connectionId: s.conn.id,
          contact: s.contact,
          source: "workflow",
          idempotencyKey: `wf:${wf.id}:message:${s.wamid}`,
          workflowId: wf.id,
          workflowRunId: run.id,
          template: null,
          payload: { kind: "text", body: text },
          preview: text,
          sendAfter: new Date(Math.max(now, s.at.getTime() + input.timing.minutes * 60_000)),
        },
        deps,
      ));
    } catch (err) {
      // Nothing was queued: the next message (or this one, retried) may still be answered.
      if (cooldown > 0) await deps.coord.release(lease).catch(() => undefined);
      await systemDb.waWorkflowRun.delete({ where: { id: run.id } }).catch(() => undefined);
      throw err;
    }
    await systemDb.waWorkflowRun.update({ where: { id: run.id }, data: { outcome: "scheduled", messageId: message.id } });
    await systemDb.waWorkflow.update({ where: { id: wf.id }, data: { lastRunAt: new Date() } });
    result.scheduled++;
  }
  if (result.workflows) logger.info({ storeId: s.conn.storeId, trigger: "message_received", ...result }, "whatsapp workflows ran");
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

/**
 * A reply workflow's text to the merchant's own test number. WhatsApp delivers text without a
 * template only within 24 hours of that number's last message to the business, so Meta refuses it
 * otherwise (the history then says so in plain words).
 */
export async function sendTestReply(deps: Pick<WaDeps, "queues">, input: { store: Store; userId: string | null; text: string; label: string }) {
  const conn = await liveConnection(input.store.id);
  if (!canSend(conn)) throw new WhatsappError("Connect WhatsApp and finish its setup before sending a test.", 409, "not_connected");
  const to = await testPhoneOf(input.store.id);
  if (!to) throw new WhatsappError("Add your own WhatsApp number in Settings first: tests go only to it.", 409, "no_test_phone");
  const { message } = await queueMessage(
    {
      store: input.store,
      connectionId: conn!.id,
      to,
      source: "test",
      idempotencyKey: `test:${input.label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      template: null,
      payload: { kind: "text", body: input.text },
      preview: input.text,
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
