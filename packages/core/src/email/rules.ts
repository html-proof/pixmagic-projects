/**
 * Automation rules: saving them (validated against the event, the workspace's own senders and
 * templates), turning them on and off, and their history. Running them is engine.ts.
 *
 * Every reference is checked inside the workspace (withTenant): a rule can't name another
 * workspace's sender or template, and the database's composite foreign keys refuse it too.
 */
import { systemDb, withTenant, type EmailAutomationRule } from "@app/db";
import {
  accountCanSend,
  conditionNodeSchema,
  conditionProblems,
  describeConditions,
  eventLabel,
  frequencySchema,
  isAllowedVariable,
  isEventType,
  isShopifyEventType,
  recipientSchema,
  type ConditionNode,
  type FrequencyPolicy,
  type RecipientSelection,
  type RuleInput,
} from "@app/shared/email";
import { z } from "zod";
import { emailAudit, EmailError, notFound } from "./common.js";
import { cancelPending } from "./delivery.js";

const MAX_RULES = 200;

export const actionSchema = z.object({ type: z.literal("send_email"), recipient: recipientSchema });

export interface ParsedRule {
  conditions: ConditionNode | null;
  recipient: RecipientSelection;
  frequency: FrequencyPolicy;
}

/** A stored rule's JSON, checked again on the way out (it may predate a schema change). */
export function parseEmailRule(r: Pick<EmailAutomationRule, "conditionJson" | "actionJson" | "frequencyPolicy">): ParsedRule | null {
  const c = r.conditionJson === null ? { success: true as const, data: null } : conditionNodeSchema.safeParse(r.conditionJson);
  const a = actionSchema.safeParse(r.actionJson);
  const f = frequencySchema.safeParse(r.frequencyPolicy);
  return c.success && a.success && f.success ? { conditions: c.data, recipient: a.data.recipient, frequency: f.data } : null;
}

export function publicRule(r: EmailAutomationRule & { sender?: { senderEmail: string; authorizationStatus: string } | null; template?: { name: string; status: string; category: string } | null }) {
  const parsed = parseEmailRule(r);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    eventType: r.eventType,
    eventLabel: eventLabel(r.eventType),
    storeId: r.storeId,
    conditions: parsed?.conditions ?? null,
    conditionsText: parsed ? describeConditions(parsed.conditions, r.eventType) : "Invalid conditions",
    recipient: parsed?.recipient ?? null,
    frequency: parsed?.frequency ?? null,
    senderIdentityId: r.senderIdentityId,
    sender: r.sender ? { email: r.sender.senderEmail, status: r.sender.authorizationStatus } : null,
    templateId: r.templateId,
    template: r.template ? { name: r.template.name, status: r.template.status, category: r.template.category } : null,
    delayMinutes: r.delayMinutes,
    maxAttempts: r.maxAttempts,
    priority: r.priority,
    enabled: r.enabled,
    valid: parsed !== null,
    lastTriggeredAt: r.lastTriggeredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const INCLUDE = { sender: { select: { senderEmail: true, authorizationStatus: true } }, template: { select: { name: true, status: true, category: true } } } as const;

export async function listRules(workspaceId: string) {
  return withTenant(workspaceId, (tx) => tx.emailAutomationRule.findMany({ where: { workspaceId, deletedAt: null }, include: INCLUDE, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] }));
}

export async function getRule(workspaceId: string, id: string) {
  const r = await withTenant(workspaceId, (tx) => tx.emailAutomationRule.findFirst({ where: { id, workspaceId, deletedAt: null }, include: INCLUDE }));
  if (!r) throw notFound();
  return r;
}

/**
 * Everything that makes a rule unsavable (thrown) or not ready to run (`blocking`, refused when
 * enabling). References that don't exist in this workspace are "not found", whether they exist
 * elsewhere or not.
 */
export async function checkRule(workspaceId: string, input: RuleInput): Promise<{ blocking: string[] }> {
  if (!isEventType(input.eventType)) throw new EmailError(`"${input.eventType}" isn't an event automations can use.`, 400, "invalid_event");
  if (input.storeId) {
    if (!isShopifyEventType(input.eventType)) throw new EmailError("Only Shopify events can be limited to one store.", 400, "invalid_store");
    const store = await withTenant(workspaceId, (tx) => tx.store.findFirst({ where: { id: input.storeId!, workspaceId, status: { not: "uninstalled" } }, select: { id: true } }));
    if (!store) throw new EmailError("That store isn't connected to this workspace.", 400, "invalid_store");
  }
  const problems = conditionProblems(input.conditions, input.eventType);
  if (problems.length) throw new EmailError(problems[0]!, 400, "invalid_conditions", { problems });
  const [sender, template] = await withTenant(workspaceId, (tx) =>
    Promise.all([
      tx.emailSenderIdentity.findFirst({ where: { id: input.senderIdentityId, workspaceId }, include: { account: { select: { status: true, deletedAt: true } } } }),
      tx.emailTemplate.findFirst({ where: { id: input.templateId, workspaceId, deletedAt: null } }),
    ]),
  );
  if (!sender || sender.account.deletedAt) throw new EmailError("That sender doesn't exist in this workspace.", 400, "sender_not_found");
  if (!template) throw new EmailError("That template doesn't exist in this workspace.", 400, "template_not_found");
  if (template.eventType && template.eventType !== input.eventType) throw new EmailError(`That template is written for "${eventLabel(template.eventType)}", not this event.`, 400, "template_mismatch");
  const unknown = template.allowedVariables.filter((v) => !isAllowedVariable(input.eventType, template.category as "transactional" | "marketing", v));
  if (unknown.length) throw new EmailError(`The template uses ${unknown.map((v) => `{{${v}}}`).join(", ")}, which this event doesn't have.`, 400, "template_mismatch");
  const blocking: string[] = [];
  if (sender.authorizationStatus !== "verified") blocking.push("The sender address isn't verified yet.");
  if (sender.account.status === "revoked" || sender.account.status === "disabled") blocking.push("The sending account is disconnected or disabled.");
  else if (!accountCanSend(sender.account.status)) blocking.push("The sending account needs attention before it can send.");
  if (template.status !== "active") blocking.push("The template is a draft. Make it active first.");
  return { blocking };
}

const toRow = (input: RuleInput) => ({
  name: input.name,
  description: input.description ?? null,
  eventType: input.eventType,
  storeId: input.storeId,
  conditionJson: (input.conditions ?? null) as never,
  actionJson: { type: "send_email", recipient: input.recipient } as never,
  senderIdentityId: input.senderIdentityId,
  templateId: input.templateId,
  delayMinutes: input.delayMinutes,
  frequencyPolicy: input.frequency as never,
  maxAttempts: input.maxAttempts,
  priority: input.priority,
});

export async function createRule(workspaceId: string, userId: string, input: RuleInput) {
  if ((await systemDb.emailAutomationRule.count({ where: { workspaceId, deletedAt: null } })) >= MAX_RULES) throw new EmailError(`A workspace can have at most ${MAX_RULES} automations.`, 409, "too_many_rules");
  const { blocking } = await checkRule(workspaceId, input);
  // New rules start off: they are switched on deliberately, after a preview (Step 7 in the builder).
  const r = await systemDb.emailAutomationRule.create({ data: { workspaceId, ...toRow(input), enabled: false, createdByUserId: userId, updatedByUserId: userId } });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.automation.created", targetType: "email_automation", targetId: r.id, metadata: { name: r.name, eventType: r.eventType } });
  return { rule: r, blocking };
}

/** The rule as a full input (what an update merges into). */
export function ruleAsInput(r: EmailAutomationRule): RuleInput {
  const parsed = parseEmailRule(r);
  return {
    name: r.name,
    description: r.description,
    eventType: r.eventType,
    storeId: r.storeId,
    conditions: parsed?.conditions ?? null,
    senderIdentityId: r.senderIdentityId,
    templateId: r.templateId,
    recipient: parsed?.recipient ?? { type: "customer" },
    delayMinutes: r.delayMinutes,
    frequency: parsed?.frequency ?? { type: "once_per_event" },
    maxAttempts: r.maxAttempts,
    priority: r.priority,
  };
}

export async function updateRule(workspaceId: string, id: string, userId: string, patch: Partial<RuleInput>) {
  const r = await getRule(workspaceId, id);
  const input = { ...ruleAsInput(r), ...patch } as RuleInput;
  const { blocking } = await checkRule(workspaceId, input);
  if (r.enabled && blocking.length) throw new EmailError(`This change would stop the automation from working: ${blocking[0]} Turn it off first.`, 409, "rule_not_ready", { blocking });
  const updated = await systemDb.emailAutomationRule.update({ where: { id: r.id }, data: { ...toRow(input), updatedByUserId: userId } });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.automation.updated", targetType: "email_automation", targetId: r.id, metadata: { fields: Object.keys(patch) } });
  return { rule: updated, blocking };
}

export async function setRuleEnabled(workspaceId: string, id: string, userId: string, enabled: boolean) {
  const r = await getRule(workspaceId, id);
  if (enabled) {
    if (!parseEmailRule(r)) throw new EmailError("This automation's settings are no longer valid. Edit and save it first.", 409, "rule_invalid");
    const { blocking } = await checkRule(workspaceId, ruleAsInput(r));
    if (blocking.length) throw new EmailError(blocking[0]!, 409, "rule_not_ready", { blocking });
  }
  await systemDb.emailAutomationRule.update({ where: { id: r.id }, data: { enabled, updatedByUserId: userId } });
  // Off means off: mail it scheduled and hasn't sent yet doesn't go either.
  const cancelled = enabled ? 0 : await cancelPending({ workspaceId, ruleId: r.id }, "rule_disabled");
  await emailAudit({ workspaceId, actorUserId: userId, action: enabled ? "email.automation.enabled" : "email.automation.disabled", targetType: "email_automation", targetId: r.id, metadata: { cancelled } });
  return { cancelled };
}

export async function deleteRule(workspaceId: string, id: string, userId: string) {
  const r = await getRule(workspaceId, id);
  await systemDb.emailAutomationRule.update({ where: { id: r.id }, data: { enabled: false, deletedAt: new Date(), updatedByUserId: userId } });
  const cancelled = await cancelPending({ workspaceId, ruleId: r.id }, "rule_disabled");
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.automation.deleted", targetType: "email_automation", targetId: r.id, metadata: { name: r.name, cancelled } });
  return { cancelled };
}

/** What a rule did with each event, newest first, with its message's outcome. */
export async function ruleExecutions(workspaceId: string, id: string, opts: { cursor?: string; limit: number }) {
  await getRule(workspaceId, id);
  const rows = await withTenant(workspaceId, (tx) =>
    tx.emailAutomationExecution.findMany({
      where: { workspaceId, ruleId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { event: { select: { eventType: true, externalId: true, source: true, occurredAt: true } } },
    }),
  );
  const page = rows.slice(0, opts.limit);
  const messageIds = page.map((e) => e.messageId).filter((m): m is string => !!m);
  const messages = messageIds.length
    ? await withTenant(workspaceId, (tx) => tx.emailMessage.findMany({ where: { workspaceId, id: { in: messageIds } }, select: { id: true, status: true, recipientMasked: true, lastErrorCode: true } }))
    : [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    executions: page.map((e) => ({
      id: e.id,
      status: e.status,
      detail: e.detail,
      failureReason: e.failureReason,
      evaluatedAt: e.evaluatedAt,
      scheduledAt: e.scheduledAt,
      event: { type: e.event.eventType, source: e.event.source, occurredAt: e.event.occurredAt },
      message: e.messageId ? (byId.get(e.messageId) ?? null) : null,
    })),
    nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
  };
}
