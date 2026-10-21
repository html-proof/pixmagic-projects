/**
 * The merchant's own rules: trigger → conditions → action.
 *
 * Loops can't happen: actions never raise triggers (a rule's message going out is not an "order
 * created"), and each rule runs at most once per trigger and subject (order, checkout or customer),
 * enforced by a unique row in whatsapp_automation_runs that is written before the action. Two rules
 * that would send the same template to the same customer for the same subject send it once
 * (the message's dedupe key is per rule and subject, and the template guard below).
 */
import { Prisma, systemDb, withTenant, type AbandonedCheckout, type OrderTracking, type Store, type WhatsappAutomationRule, type WhatsappContact } from "@app/db";
import {
  automationActionSchema,
  conditionSchema,
  evaluateConditions,
  normalizePhone,
  ruleConflicts,
  templateShape,
  TRIGGER_LABEL,
  type AutomationAction,
  type AutomationFacts,
  type AutomationTrigger,
  type Condition,
  type RuleConflict,
  type RuleLike,
  type TemplateComponent,
  type WhatsappConfig,
} from "@app/shared";
import { z } from "zod";
import { audit } from "../notify.js";
import { logger } from "../logger.js";
import { WhatsappError } from "./errors.js";
import { cancelScheduled, marketingAllowed, scheduleMessage, type WaDeps } from "./messages.js";
import { contactFirstName, numberOptedOut, parseConfig } from "./store.js";
import { orderValues, sampleValues, type Values } from "./values.js";

export interface AutomationSubject {
  /** "order:<shopify id>" | "checkout:<token>" | "contact:<id>" */
  key: string;
  store: Pick<Store, "id" | "workspaceId">;
  cfg: WhatsappConfig;
  contact: WhatsappContact | null;
  tracking?: OrderTracking | null;
  checkout?: AbandonedCheckout | null;
  facts: AutomationFacts;
  values: Values;
  /** The trigger fires this long after the event (review_request_due, checkout_abandoned). */
  delayMinutes?: number;
}

const conditionsSchema = z.array(conditionSchema).max(20);

export function parseRule(rule: Pick<WhatsappAutomationRule, "conditions" | "action">): { conditions: Condition[]; action: AutomationAction } | null {
  const c = conditionsSchema.safeParse(rule.conditions);
  const a = automationActionSchema.safeParse(rule.action);
  return c.success && a.success ? { conditions: c.data, action: a.data } : null;
}

/** A stored rule as the conflict checker sees it, or null when its settings aren't valid. */
export function ruleLike(r: WhatsappAutomationRule): RuleLike | null {
  const p = parseRule(r);
  return p ? { id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger as AutomationTrigger, conditions: p.conditions, action: p.action } : null;
}

/** A store's rules as the conflict checker sees them (invalid ones left out). */
export const rulesLike = (rules: WhatsappAutomationRule[]): RuleLike[] => rules.map(ruleLike).filter((r): r is RuleLike => !!r);

/**
 * Check a new or changed rule before it is saved. A conflict that blocks it, or a template that
 * isn't in the account or can't be filled, throws; conflicts that only warn come back for the
 * merchant to see.
 */
export async function validateRule(workspaceId: string, storeId: string, candidate: RuleLike): Promise<RuleConflict[]> {
  const others = rulesLike(await systemDb.whatsappAutomationRule.findMany({ where: { storeId, workspaceId } }));
  const conflicts = ruleConflicts(candidate, others);
  const blocking = conflicts.find((x) => x.severity === "block");
  if (blocking) throw new WhatsappError(blocking.message, 409, "rule_conflict");
  const a = candidate.action;
  if (a.type === "send_template" || a.type === "schedule_reminder") {
    const conn = await systemDb.whatsappConnection.findUnique({ where: { storeId } });
    const t = conn ? await systemDb.whatsappTemplate.findUnique({ where: { connectionId_name_language: { connectionId: conn.id, name: a.templateName, language: a.language } } }) : null;
    if (!t) throw new WhatsappError(`"${a.templateName}" (${a.language}) isn't in your WhatsApp account.`, 400, "template_missing");
    const shape = templateShape(t.components as unknown as TemplateComponent[]);
    if (a.mapping.body.length < shape.bodyVars) throw new WhatsappError(`The template has ${shape.bodyVars} variables; fill each one.`, 400, "mapping_incomplete");
  }
  return conflicts;
}

/** Status of the last message about this subject, for the "previous message status" condition. */
async function previousStatus(subject: AutomationSubject): Promise<string> {
  const where = subject.tracking ? { trackingId: subject.tracking.id } : subject.checkout ? { checkoutId: subject.checkout.id } : subject.contact ? { contactId: subject.contact.id } : null;
  if (!where) return "none";
  const last = await systemDb.whatsappMessage.findFirst({ where: { ...where, test: false }, orderBy: { createdAt: "desc" }, select: { status: true } });
  return last?.status ?? "none";
}

export function describeAction(a: AutomationAction): string {
  switch (a.type) {
    case "send_template":
      return `Send the approved template "${a.templateName}" (${a.language})`;
    case "schedule_reminder":
      return `Send the approved template "${a.templateName}" (${a.language}) after ${a.delayMinutes} minutes`;
    case "cancel_pending":
      return `Cancel pending messages: ${a.kinds.join(", ")}`;
    case "internal_notification":
      return `Show a notification to your team: "${a.message}"`;
    case "record_event":
      return `Record "${a.label}" in the audit log`;
  }
}

async function perform(rule: WhatsappAutomationRule, action: AutomationAction, trigger: AutomationTrigger, subject: AutomationSubject, deps: Pick<WaDeps, "queues">): Promise<{ outcome: "done" | "skipped"; detail: string; messageId?: string }> {
  switch (action.type) {
    case "send_template":
    case "schedule_reminder": {
      if (!subject.contact) return { outcome: "skipped", detail: "No WhatsApp number for this customer" };
      const delay = (subject.delayMinutes ?? 0) + (action.type === "schedule_reminder" ? action.delayMinutes : 0);
      const { message, created } = await scheduleMessage(
        {
          store: subject.store,
          kind: "automation",
          dedupeKey: `rule:${rule.id}:${subject.key}`,
          contact: subject.contact,
          template: { name: action.templateName, language: action.language },
          mapping: action.mapping,
          values: subject.values,
          scheduledFor: new Date(Date.now() + delay * 60_000),
          trackingId: subject.tracking?.id ?? null,
          orderName: subject.tracking?.orderName ?? null,
          checkoutId: subject.checkout?.id ?? null,
          ruleId: rule.id,
          clickUrl: subject.values.checkout_url ?? null,
        },
        deps,
      );
      return { outcome: "done", detail: created ? describeAction(action) : "Already scheduled", messageId: message.id };
    }
    case "cancel_pending": {
      const where = subject.tracking ? { trackingId: subject.tracking.id } : subject.checkout ? { checkoutId: subject.checkout.id } : null;
      if (!where) return { outcome: "skipped", detail: "Nothing to cancel for this subject" };
      const n = await cancelScheduled({ ...where, kinds: action.kinds }, `rule:${rule.name}`.slice(0, 120));
      return { outcome: "done", detail: `Cancelled ${n} pending message${n === 1 ? "" : "s"}` };
    }
    case "internal_notification": {
      const about = subject.tracking ? ` (order ${subject.tracking.orderName})` : subject.checkout ? " (abandoned checkout)" : "";
      // An in-app notification, not an email: an "info" alert, listed under the top bar's bell for a
      // week with this message as is (@app/shared/alerts).
      await systemDb.alert.create({
        data: { workspaceId: subject.store.workspaceId, storeId: subject.store.id, severity: "info", code: `wa_rule_${rule.id}`, message: `${action.message}${about}`.slice(0, 500) },
      });
      return { outcome: "done", detail: "Notification created" };
    }
    case "record_event":
      await audit({
        workspaceId: subject.store.workspaceId,
        action: "whatsapp.automation_event",
        targetType: "whatsapp_automation_rule",
        targetId: rule.id,
        metadata: { label: action.label, trigger, subject: subject.key },
      });
      return { outcome: "done", detail: `Recorded "${action.label}"` };
  }
}

/** Run every enabled rule for this trigger against the subject. Returns how many ran. */
export async function runAutomations(trigger: AutomationTrigger, subject: AutomationSubject, deps: Pick<WaDeps, "queues">): Promise<number> {
  const rules = await systemDb.whatsappAutomationRule.findMany({ where: { storeId: subject.store.id, trigger, enabled: true }, orderBy: { createdAt: "asc" } });
  if (!rules.length) return 0;
  const facts: AutomationFacts = { ...subject.facts, previousMessageStatus: await previousStatus(subject) };
  let ran = 0;
  for (const rule of rules) {
    let runId: string;
    try {
      const run = await systemDb.whatsappAutomationRun.create({
        data: { workspaceId: subject.store.workspaceId, storeId: subject.store.id, ruleId: rule.id, trigger, subjectKey: subject.key, outcome: "pending" },
      });
      runId = run.id;
    } catch (err) {
      // Already ran for this subject (a webhook retry, a duplicate delivery): never twice.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
    const parsed = parseRule(rule);
    if (!parsed) {
      await systemDb.whatsappAutomationRun.update({ where: { id: runId }, data: { outcome: "error", detail: "The rule's settings are no longer valid; edit and save it again." } });
      continue;
    }
    const verdict = evaluateConditions(parsed.conditions, facts);
    if (!verdict.pass) {
      const failed = verdict.results.filter((r) => !r.pass).map((r) => r.condition.field).join(", ");
      await systemDb.whatsappAutomationRun.update({ where: { id: runId }, data: { outcome: "skipped", detail: `Conditions not met: ${failed}` } });
      continue;
    }
    try {
      const r = await perform(rule, parsed.action, trigger, subject, deps);
      await systemDb.whatsappAutomationRun.update({ where: { id: runId }, data: { outcome: r.outcome, detail: r.detail, messageId: r.messageId ?? null } });
      ran++;
    } catch (err) {
      logger.error({ err, ruleId: rule.id, trigger }, "automation action failed");
      await systemDb.whatsappAutomationRun.update({ where: { id: runId }, data: { outcome: "error", detail: (err as Error).message.slice(0, 300) } });
    }
  }
  return ran;
}

/** "Test" in the dashboard: what the rule would do for a subject, without doing it. */
export async function dryRunAutomation(rule: WhatsappAutomationRule, subject: AutomationSubject) {
  const parsed = parseRule(rule);
  if (!parsed) return { valid: false as const, error: "The rule's settings are not valid." };
  const facts: AutomationFacts = { ...subject.facts, previousMessageStatus: await previousStatus(subject) };
  const verdict = evaluateConditions(parsed.conditions, facts);
  return {
    valid: true as const,
    trigger: TRIGGER_LABEL[rule.trigger as AutomationTrigger] ?? rule.trigger,
    subject: subject.key,
    facts,
    conditions: verdict.results,
    wouldRun: verdict.pass,
    action: describeAction(parsed.action),
    hasPhone: !!subject.contact,
  };
}

/**
 * "Test" in the dashboard: evaluate the rule against a recent order (or the one given) without
 * doing anything. With a phone number, a send action's template also goes to that number with
 * example values; `beforeSend` runs right before it is queued (the API's rate limit).
 */
export async function testAutomation(
  store: Store,
  rule: WhatsappAutomationRule,
  input: { trackingId?: string; phone?: string },
  deps: Pick<WaDeps, "queues"> & { beforeSend?: () => Promise<void> },
) {
  const { id: storeId, workspaceId } = store;
  const settings = await systemDb.whatsappSettings.findUnique({ where: { storeId } });
  const cfg = parseConfig(settings?.config);
  const tracking = await withTenant(workspaceId, (tx) =>
    tx.orderTracking.findFirst({ where: { storeId, workspaceId, ...(input.trackingId ? { id: input.trackingId } : {}) }, orderBy: { orderCreatedAt: "desc" } }),
  );
  const contact = tracking?.contactId ? await systemDb.whatsappContact.findUnique({ where: { id: tracking.contactId } }) : null;
  const items = (tracking?.items as Array<{ productId: string; title: string }>) ?? [];
  const subject: AutomationSubject = {
    key: tracking ? `order:${tracking.shopifyOrderId}` : "example",
    store,
    cfg,
    contact,
    tracking,
    facts: tracking
      ? { orderValue: Number(tracking.totalPrice), productIds: items.map((i) => i.productId), productTitles: items.map((i) => i.title), orderStatus: tracking.status, country: tracking.country, marketingConsent: contact ? marketingAllowed(cfg, contact) : false }
      : { orderValue: 0, marketingConsent: false },
    values: tracking ? orderValues(store, cfg, tracking, contact ? contactFirstName(contact) : null) : sampleValues(store, cfg),
  };
  const result = await dryRunAutomation(rule, subject);
  let testMessageId: string | null = null;
  const parsed = parseRule(rule);
  if (input.phone && parsed && (parsed.action.type === "send_template" || parsed.action.type === "schedule_reminder")) {
    const phone = normalizePhone(input.phone, null);
    if (!phone) throw new WhatsappError("Enter the number in international format, starting with + and the country code.", 400, "invalid_phone");
    if (await numberOptedOut(storeId, phone.waId)) throw new WhatsappError("That number replied STOP to this store, so nothing (not even a test) can be sent to it.", 409, "opted_out");
    await deps.beforeSend?.();
    const { message } = await scheduleMessage(
      {
        store,
        kind: "test",
        dedupeKey: `test:rule:${rule.id}:${Date.now()}`,
        contact: null,
        template: { name: parsed.action.templateName, language: parsed.action.language },
        mapping: parsed.action.mapping,
        values: { ...sampleValues(store, cfg), ...subject.values, customer_name: "Test" },
        scheduledFor: new Date(),
        ruleId: rule.id,
        test: { to: phone.waId },
      },
      deps,
    );
    testMessageId = message.id;
  }
  // The rule's history shows the test; failing to record it mustn't fail the test itself.
  await systemDb.whatsappAutomationRun
    .create({ data: { workspaceId, storeId, ruleId: rule.id, trigger: rule.trigger, subjectKey: `test:${Date.now()}`, outcome: "test", detail: result.valid ? (result.wouldRun ? "Would run" : "Conditions not met") : result.error, messageId: testMessageId } })
    .catch((err: unknown) => logger.warn({ err, ruleId: rule.id }, "could not record an automation test run"));
  return { ...result, order: tracking ? { id: tracking.id, orderName: tracking.orderName } : null, testMessageId };
}
