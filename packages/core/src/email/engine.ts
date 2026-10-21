/**
 * The rule engine: one business event in, at most one scheduled email per matching rule out.
 *
 *   event → enabled rules for its type (and store) → per rule: execution row (idempotency key) →
 *   conditions → recipient → sender → template → consent → suppression → frequency → message
 *   (queued, delayed) → send job.
 *
 * Each rule handles an event once: the execution's key `rule:<id>:event:<id>` is unique, and so is
 * the message's, so a redelivered event, a retried job or two workers racing schedule one email.
 * Actions never raise events, so rules can't trigger each other. Nothing here runs customer code:
 * conditions are a bounded declarative tree, templates a placeholder language.
 */
import { systemDb, type EmailAutomationRule, type EmailBusinessEvent } from "@app/db";
import {
  accountCanSend,
  evaluateConditions,
  isShopifyEventType,
  normalizeEmail,
  readPath,
  renderTemplate,
  type ConditionTrace,
  type EventData,
  type RuleInput,
} from "@app/shared/email";
import { logger } from "../logger.js";
import { isUniqueViolation, recipientHash, type EmailDeps } from "./common.js";
import { createMessage, enqueueEmailSend } from "./delivery.js";
import { businessInfo, renderEmail, type Business, type RenderedEmail } from "./render.js";
import { parseEmailRule, ruleAsInput, type ParsedRule } from "./rules.js";
import { isSuppressed } from "./suppressions.js";
import { previewData } from "./templates.js";
import { AAD, open } from "./vault.js";

const MAX_RULES_PER_EVENT = 50;

export async function processBusinessEvent(eventId: string, deps: EmailDeps): Promise<{ rules: number; scheduled: number }> {
  const evt = await systemDb.emailBusinessEvent.findUnique({ where: { id: eventId } });
  if (!evt || evt.status !== "received") return { rules: 0, scheduled: 0 };
  let data: EventData | null = null;
  if (evt.payloadEnc) {
    try {
      data = JSON.parse(open(evt.payloadEnc, AAD.eventPayload(evt.workspaceId, evt.source, evt.externalId))) as EventData;
    } catch (err) {
      logger.error({ err, eventId }, "couldn't open an email event's data");
    }
  }
  if (!data) {
    await systemDb.emailBusinessEvent.update({ where: { id: evt.id }, data: { status: "failed", error: "The event's data couldn't be read", processedAt: new Date() } });
    return { rules: 0, scheduled: 0 };
  }
  const rules = await systemDb.emailAutomationRule.findMany({
    where: { workspaceId: evt.workspaceId, eventType: evt.eventType, enabled: true, deletedAt: null, ...(evt.storeId ? { OR: [{ storeId: null }, { storeId: evt.storeId }] } : { storeId: null }) },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: MAX_RULES_PER_EVENT,
  });
  const business = await businessInfo(evt.workspaceId);
  let scheduled = 0;
  for (const rule of rules) {
    try {
      if (await runRule(rule, evt, data, business, deps)) scheduled++;
    } catch (err) {
      logger.error({ err, ruleId: rule.id, eventId }, "email automation failed for an event");
      await systemDb.emailAutomationExecution
        .updateMany({ where: { workspaceId: evt.workspaceId, idempotencyKey: execKey(rule.id, evt.id), status: "pending" }, data: { status: "failed", failureReason: "render_failed", detail: "Something went wrong running this automation.", completedAt: new Date() } })
        .catch(() => undefined);
    }
  }
  await systemDb.emailBusinessEvent.update({ where: { id: evt.id }, data: { status: "processed", rulesMatched: rules.length, processedAt: new Date() } });
  if (rules.length) await systemDb.emailAutomationRule.updateMany({ where: { id: { in: rules.map((r) => r.id) } }, data: { lastTriggeredAt: new Date() } });
  return { rules: rules.length, scheduled };
}

const execKey = (ruleId: string, eventId: string) => `rule:${ruleId}:event:${eventId}`;

type Verdict =
  | { ok: false; status: "skipped" | "failed"; reason: string; detail: string }
  | { ok: true; to: string; hash: string; sender: NonNullable<Awaited<ReturnType<typeof loadSender>>>; template: NonNullable<Awaited<ReturnType<typeof loadTemplate>>> };

const loadSender = (workspaceId: string, id: string) =>
  systemDb.emailSenderIdentity.findUnique({ where: { id_workspaceId: { id, workspaceId } }, include: { account: true } });
const loadTemplate = (workspaceId: string, id: string) => systemDb.emailTemplate.findUnique({ where: { id_workspaceId: { id, workspaceId } } });

/** Who, from whom and what: the checks a dry run shows and a real run acts on (suppression and frequency are separate). */
async function decide(workspaceId: string, parsed: ParsedRule, input: Pick<RuleInput, "senderIdentityId" | "templateId" | "eventType">, data: EventData, trace: ConditionTrace[] | null): Promise<Verdict> {
  const cond = evaluateConditions(parsed.conditions, data, input.eventType);
  if (trace) trace.push(...cond.trace);
  if (!cond.pass) {
    const failed = cond.trace.filter((t) => !t.pass).map((t) => t.field);
    return { ok: false, status: "skipped", reason: "conditions_not_met", detail: `Conditions not met: ${[...new Set(failed)].join(", ") || "none passed"}` };
  }
  const raw = parsed.recipient.type === "fixed" ? parsed.recipient.address : readPath(data, "customer.email");
  if (raw === undefined || raw === null || raw === "") return { ok: false, status: "failed", reason: "missing_recipient", detail: "The event has no customer email address." };
  const to = normalizeEmail(raw);
  if (!to) return { ok: false, status: "failed", reason: "invalid_recipient", detail: "The event's email address isn't valid." };
  const sender = await loadSender(workspaceId, input.senderIdentityId);
  if (!sender || sender.authorizationStatus !== "verified" || sender.account.deletedAt || sender.account.status === "revoked") {
    return { ok: false, status: "failed", reason: "sender_unavailable", detail: "The sender address isn't verified, or its account was disconnected." };
  }
  const template = await loadTemplate(workspaceId, input.templateId);
  if (!template || template.deletedAt || template.status !== "active") return { ok: false, status: "failed", reason: "template_unavailable", detail: "The template isn't active." };
  // Marketing to a customer needs their consent; a fixed recipient is the business's own address.
  if (template.category === "marketing" && parsed.recipient.type === "customer" && readPath(data, "customer.accepts_marketing") !== true) {
    return { ok: false, status: "skipped", reason: "no_marketing_consent", detail: "The customer hasn't agreed to marketing email." };
  }
  return { ok: true, to, hash: recipientHash(workspaceId, to), sender, template };
}

/** Within the rule's frequency limit for this recipient? */
async function underFrequencyLimit(rule: Pick<EmailAutomationRule, "id">, parsed: ParsedRule, hash: string): Promise<boolean> {
  if (parsed.frequency.type === "once_per_event") return true;
  const max = parsed.frequency.type === "once_per_recipient" ? 1 : parsed.frequency.max;
  const since = new Date(Date.now() - parsed.frequency.windowHours * 3600_000);
  const n = await systemDb.emailAutomationExecution.count({ where: { ruleId: rule.id, recipientHash: hash, status: "scheduled", createdAt: { gte: since } } });
  return n < max;
}

/** Run one rule for one event. Returns whether an email was scheduled. */
async function runRule(rule: EmailAutomationRule, evt: EmailBusinessEvent, data: EventData, business: Business, deps: EmailDeps): Promise<boolean> {
  const key = execKey(rule.id, evt.id);
  let exec;
  try {
    exec = await systemDb.emailAutomationExecution.create({ data: { workspaceId: evt.workspaceId, ruleId: rule.id, eventId: evt.id, idempotencyKey: key } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Done before (a redelivery). Only an execution a crash left half way is picked up again.
    exec = await systemDb.emailAutomationExecution.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: evt.workspaceId, idempotencyKey: key } } });
    if (!exec || exec.status !== "pending") return false;
  }
  const settle = (status: string, reason: string | null, detail: string, extra: Record<string, unknown> = {}) =>
    systemDb.emailAutomationExecution.update({ where: { id: exec.id }, data: { status, failureReason: reason, detail, completedAt: new Date(), ...extra } });

  const parsed = parseEmailRule(rule);
  if (!parsed) {
    await settle("failed", "invalid_rule", "The automation's settings are no longer valid; edit and save it again.");
    return false;
  }
  const v = await decide(evt.workspaceId, parsed, rule, data, null);
  if (!v.ok) {
    await settle(v.status, v.reason, v.detail);
    return false;
  }
  const sup = await isSuppressed(evt.workspaceId, v.hash, v.template.category);
  if (!sup.suppressed && !(await underFrequencyLimit(rule, parsed, v.hash))) {
    await settle("skipped", "frequency_limit", "The frequency limit for this recipient was reached.", { recipientHash: v.hash });
    return false;
  }
  const subject = renderTemplate(v.template.subjectTemplate, { ...data, business: { name: business.name, address: business.address ?? "" }, recipient: { email: v.to } }, "subject") || "(no subject)";
  const scheduledAt = new Date(Math.max(Date.now(), evt.occurredAt.getTime()) + rule.delayMinutes * 60_000);
  const message = await systemDb.$transaction(async (tx) => {
    const m = await createMessage(tx, {
      workspaceId: evt.workspaceId,
      account: v.sender.account,
      sender: v.sender,
      to: v.to,
      subject,
      kind: "automation",
      category: v.template.category,
      scheduledAt: sup.suppressed ? new Date() : scheduledAt,
      idempotencyKey: key,
      maxAttempts: rule.maxAttempts,
      ruleId: rule.id,
      executionId: exec.id,
      eventId: evt.id,
      templateId: v.template.id,
      templateVersion: v.template.version,
      storeId: evt.storeId,
      ...(sup.suppressed ? { status: "suppressed" as const, lastErrorCode: "suppressed" } : {}),
    });
    await tx.emailAutomationExecution.update({
      where: { id: exec.id },
      data: sup.suppressed
        ? { status: "suppressed", failureReason: "suppressed", detail: `The recipient is suppressed (${sup.reason}).`, messageId: m.id, recipientHash: v.hash, completedAt: new Date() }
        : { status: "scheduled", detail: rule.delayMinutes ? `Scheduled to send after ${rule.delayMinutes} minutes.` : "Scheduled to send now.", messageId: m.id, recipientHash: v.hash, scheduledAt, completedAt: new Date() },
    });
    return m;
  });
  if (sup.suppressed) return false;
  await enqueueEmailSend(message, deps);
  return true;
}

export interface DryRunStep {
  step: "event" | "conditions" | "recipient" | "sender" | "template" | "consent" | "suppression" | "frequency" | "timing";
  ok: boolean;
  detail: string;
}

/**
 * "Preview and test" in the builder: what the rule would do with an event, without doing any of it.
 * Uses example data for the event type, optionally overridden; never a real customer's.
 */
export async function dryRunRule(workspaceId: string, input: RuleInput, sampleOverrides?: unknown) {
  const data = previewData(input.eventType, sampleOverrides);
  const parsed: ParsedRule = { conditions: input.conditions, recipient: input.recipient, frequency: input.frequency };
  const trace: ConditionTrace[] = [];
  const steps: DryRunStep[] = [{ step: "event", ok: true, detail: `${isShopifyEventType(input.eventType) ? "Shopify" : "Custom"} event "${input.eventType}" with example data.` }];
  const v = await decide(workspaceId, parsed, input, data, trace);
  let preview: RenderedEmail | null = null;
  if (!v.ok) {
    const step: DryRunStep["step"] =
      v.reason === "conditions_not_met" ? "conditions" : v.reason.includes("recipient") ? "recipient" : v.reason === "sender_unavailable" ? "sender" : v.reason === "template_unavailable" ? "template" : "consent";
    if (step !== "conditions") steps.push({ step: "conditions", ok: true, detail: "Conditions met." });
    steps.push({ step, ok: false, detail: v.detail });
  } else {
    steps.push({ step: "conditions", ok: true, detail: parsed.conditions ? "Conditions met." : "No conditions: every event." });
    steps.push({ step: "recipient", ok: true, detail: parsed.recipient.type === "fixed" ? `Sends to ${parsed.recipient.address}.` : "Sends to the customer in the event." });
    steps.push({ step: "sender", ok: accountCanSend(v.sender.account.status), detail: `From ${v.sender.senderEmail}${accountCanSend(v.sender.account.status) ? "" : " (its account needs attention: mail will wait until it is fixed)"}.` });
    steps.push({ step: "template", ok: true, detail: `Template "${v.template.name}" (version ${v.template.version}).` });
    const sup = await isSuppressed(workspaceId, v.hash, v.template.category);
    steps.push({ step: "suppression", ok: !sup.suppressed, detail: sup.suppressed ? `That address is suppressed (${sup.reason}).` : "Not suppressed." });
    steps.push({ step: "timing", ok: true, detail: input.delayMinutes ? `Sends ${input.delayMinutes} minutes after the event.` : "Sends right after the event." });
    preview = renderEmail(
      { subject: v.template.subjectTemplate, html: v.template.htmlTemplate, text: v.template.textTemplate, category: v.template.category },
      { data, business: await businessInfo(workspaceId), recipient: v.to, unsubscribeUrl: v.template.category === "marketing" ? "https://example.com/unsubscribe-preview" : null },
    );
  }
  return { wouldSend: steps.every((s) => s.ok), steps, conditions: trace, preview };
}

/** A saved rule's dry run. */
export async function dryRunSavedRule(workspaceId: string, rule: EmailAutomationRule, sampleOverrides?: unknown) {
  return dryRunRule(workspaceId, ruleAsInput(rule), sampleOverrides);
}
