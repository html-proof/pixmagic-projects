/**
 * The merchant's own rules: trigger → conditions → action.
 *
 * Loops can't happen: actions never raise triggers (a rule's message going out is not an "order
 * created"), and each rule runs at most once per trigger and subject (order, checkout or customer),
 * enforced by a unique row in whatsapp_automation_runs that is written before the action. Two rules
 * that would send the same template to the same customer for the same subject send it once
 * (the message's dedupe key is per rule and subject, and the template guard below).
 */
import { Prisma, systemDb, type AbandonedCheckout, type OrderTracking, type Store, type WhatsappAutomationRule, type WhatsappContact } from "@app/db";
import {
  automationActionSchema,
  conditionSchema,
  evaluateConditions,
  TRIGGER_LABEL,
  type AutomationAction,
  type AutomationFacts,
  type AutomationTrigger,
  type Condition,
  type WhatsappConfig,
} from "@app/shared";
import { z } from "zod";
import { audit } from "../notify.js";
import { logger } from "../logger.js";
import { cancelScheduled, scheduleMessage, type WaDeps } from "./messages.js";
import type { Values } from "./values.js";

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
      // An in-app notification, not an email: alerts with severity "info" show on the dashboard.
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
