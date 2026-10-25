/**
 * Automation rules: WHEN an event, IF conditions hold, WAIT a delay, THEN send an approved template.
 *
 * A rule runs only once an owner or admin approved it, and what runs is the approved version
 * (`active_config`); an edit makes a new version that waits for approval while the approved one
 * keeps running. Each version is in sms_audit_logs with its full content. A rule starts in
 * dry-run mode: it records what it would have sent (Message History) and sends nothing.
 *
 * Per event and rule there is one message at most (dedupe key rule:<id>:<subject>), so Shopify's
 * retries and duplicate deliveries never send twice; and the same template reaches a customer once
 * per subject even when two rules match.
 *
 * A rule's audience (smsAudienceSchema) narrows who its event may text: the customer must be in
 * its saved segment (the segment's rules, judged on the event's facts when it happens) or one of
 * the customers it names. A deleted segment lets nobody through.
 */
import { systemDb, type SmsAutomationRule, type SmsContact, type Store } from "@app/db";
import {
  evaluateRuleConditions,
  missingForTrigger,
  mayReceive,
  ORDER_STATUS_WORD,
  RULE_STATUS_AFTER,
  ruleCan,
  segmentConditions,
  segmentFilterSchema,
  smsRuleSchema,
  TRIGGER_INFO,
  type RuleAction,
  type RuleFacts,
  type SegmentFilter,
  type SmsRuleInput,
  type SmsTrigger,
  type SmsValues,
} from "@app/shared/sms";
import { logger } from "../logger.js";
import { senderOf, smsAudit, SmsError, smsMode, transactionalBasisOf, type SmsDeps } from "./common.js";
import { segmentWhere } from "./campaigns.js";
import { scheduleSms } from "./messages.js";
import { approvedVersionOf, type Actor } from "./templates.js";

export function parseRule(raw: unknown): SmsRuleInput | null {
  const r = smsRuleSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Problems that keep a rule from being approved: its template must be approved, of the right category, and fillable by the event. */
async function ruleProblems(storeId: string, cfg: SmsRuleInput): Promise<string[]> {
  const out: string[] = [];
  const info = TRIGGER_INFO[cfg.trigger];
  const t = await approvedVersionOf(storeId, cfg.templateId);
  if (!t) out.push("Its template has no approved version yet.");
  else {
    if (t.category !== info.category) out.push(info.category === "marketing" ? `"${info.label}" texts are marketing: choose a marketing template (they need marketing consent and an opt-out link).` : `"${info.label}" texts are order updates: choose a transactional template.`);
    const missing = missingForTrigger(t.body, cfg.trigger);
    if (missing.length) out.push(`The template uses ${missing.map((m) => `{{${m}}}`).join(", ")}, which "${info.label}" can't fill.`);
    if (t.body.includes("{{discount_code}}") && !cfg.discountCode) out.push("The template shows a discount code: enter it on the rule.");
  }
  if (cfg.audience.kind === "segment" && !(await systemDb.smsSegment.count({ where: { id: cfg.audience.segmentId, storeId } }))) out.push("Its customer segment was deleted: choose another one.");
  return out;
}

// ---------------------------------------------------------------------------
// Audience: who a rule's event may text
// ---------------------------------------------------------------------------

/** A saved segment's filter (null: there is no such segment at this store). */
export async function segmentFilterOf(storeId: string, segmentId: string): Promise<SegmentFilter | null> {
  const seg = await systemDb.smsSegment.findFirst({ where: { id: segmentId, storeId }, select: { filter: true } });
  if (!seg) return null;
  const f = segmentFilterSchema.safeParse(seg.filter);
  return f.success ? f.data : null;
}

/** Segment filters read once per run of a store's rules. */
export type SegmentLookup = (segmentId: string) => Promise<SegmentFilter | null>;
export function segmentLookup(storeId: string): SegmentLookup {
  const seen = new Map<string, Promise<SegmentFilter | null>>();
  return (id) => {
    if (!seen.has(id)) seen.set(id, segmentFilterOf(storeId, id));
    return seen.get(id)!;
  };
}

/**
 * Whether this event's customer is one the rule is for: anyone (the default), a customer matching
 * its segment's rules on the event's facts, or one of the customers it names. Inactive and VIP rules
 * also hold their own thresholds here, so another rule of the same trigger can't text a customer
 * who only qualified for that one.
 */
export async function audiencePasses(cfg: SmsRuleInput, facts: RuleFacts, contactId: string | null, segments: SegmentLookup): Promise<{ pass: boolean; reason: string | null }> {
  if (cfg.trigger === "customer_inactive" && cfg.inactiveDays && !((facts.daysSinceLastOrder ?? -1) >= cfg.inactiveDays)) return { pass: false, reason: "conditions" };
  if (cfg.trigger === "customer_vip") {
    const orders = cfg.vipMinOrders && (facts.customerOrders ?? -1) >= cfg.vipMinOrders;
    const spent = cfg.vipMinSpent && (facts.customerSpent ?? -1) >= cfg.vipMinSpent;
    if (!orders && !spent) return { pass: false, reason: "conditions" };
  }
  const a = cfg.audience;
  if (a.kind === "trigger") return { pass: true, reason: null };
  if (a.kind === "customers") return contactId && a.contactIds.includes(contactId) ? { pass: true, reason: null } : { pass: false, reason: "not_in_audience" };
  const filter = await segments(a.segmentId);
  if (!filter) return { pass: false, reason: "segment_missing" };
  return evaluateRuleConditions(segmentConditions(filter), facts).pass ? { pass: true, reason: null } : { pass: false, reason: "not_in_audience" };
}

export async function createRule(store: Pick<Store, "id" | "workspaceId">, input: unknown, actor: Actor): Promise<SmsAutomationRule> {
  const cfg = smsRuleSchema.parse(input);
  const rule = await systemDb.smsAutomationRule.create({
    data: { workspaceId: store.workspaceId, storeId: store.id, name: cfg.name, status: "draft", config: cfg as object, version: 1, priority: cfg.priority, createdBy: actor.userId },
  });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "rule_created", targetType: "sms_rule", targetId: rule.id, version: 1, snapshot: cfg, ip: actor.ip });
  return rule;
}

export async function ruleOf(storeId: string, id: string) {
  const r = await systemDb.smsAutomationRule.findFirst({ where: { id, storeId } });
  if (!r) throw new SmsError("Rule not found.", 404, "not_found");
  return r;
}

/**
 * Edit a rule: a new version. A rule that is running (or paused) keeps its approved version until
 * the new one is approved; any other rule goes back to draft.
 */
export async function updateRule(store: Pick<Store, "id" | "workspaceId">, id: string, input: unknown, actor: Actor): Promise<SmsAutomationRule> {
  const rule = await ruleOf(store.id, id);
  // A client that doesn't know audiences (the advanced rule editor, the hub) keeps the rule's own.
  const previous = parseRule(rule.config);
  const cfg = smsRuleSchema.parse(previous && input && typeof input === "object" && !("audience" in input) ? { ...input, audience: previous.audience } : input);
  const version = rule.version + 1;
  const status = rule.status === "active" || rule.status === "paused" ? rule.status : "draft";
  const updated = await systemDb.smsAutomationRule.update({ where: { id }, data: { name: cfg.name, config: cfg as object, version, status, submittedAt: null, submittedBy: null } });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "rule_edited", targetType: "sms_rule", targetId: id, version, snapshot: cfg, ip: actor.ip });
  return updated;
}

/** Whether the rule's latest version is one that hasn't been approved (a new rule, or an edit of a running one). */
export const hasUnapprovedVersion = (r: Pick<SmsAutomationRule, "version" | "activeVersion">) => r.activeVersion === null || r.version !== r.activeVersion;
/** Whether that version was sent for approval. */
export const awaitingApproval = (r: Pick<SmsAutomationRule, "version" | "activeVersion" | "submittedAt">) => hasUnapprovedVersion(r) && r.submittedAt !== null;

const PAST: Record<RuleAction, string> = { submit: "submitted", approve: "approved", reject: "rejected", pause: "paused", resume: "resumed", disable: "disabled" };

/**
 * submit: send the latest version for approval. approve: it becomes the version that runs (a new
 * rule starts running; a paused one stays paused). reject: back to the author. pause, resume,
 * disable: the running state. Pausing or disabling cancels the rule's texts still waiting.
 */
export async function ruleAction(store: Pick<Store, "id" | "workspaceId">, id: string, action: RuleAction, actor: Actor): Promise<SmsAutomationRule> {
  const rule = await ruleOf(store.id, id);
  const cfg = parseRule(rule.config);
  if (!cfg) throw new SmsError("This rule's settings are no longer valid: edit and save it again.", 409, "rule_invalid");
  const refuse = (why: string) => new SmsError(why, 409, "rule_state");
  const now = new Date();
  let data: Record<string, unknown>;
  switch (action) {
    case "submit":
      if (rule.status === "disabled") throw refuse("Edit the rule to use it again.");
      if (!hasUnapprovedVersion(rule)) throw refuse("This version is approved already.");
      if (awaitingApproval(rule)) throw refuse("This version is waiting for approval already.");
      {
        const problems = await ruleProblems(store.id, cfg);
        if (problems.length) throw new SmsError(problems[0]!, 409, "rule_invalid", { problems });
      }
      data = { submittedBy: actor.userId, submittedAt: now, ...(rule.status === "draft" ? { status: "pending_approval" } : {}) };
      break;
    case "approve": {
      if (!awaitingApproval(rule)) throw refuse("Only a version sent for approval can be approved.");
      const problems = await ruleProblems(store.id, cfg);
      if (problems.length) throw new SmsError(problems[0]!, 409, "rule_invalid", { problems });
      data = {
        status: rule.status === "paused" ? "paused" : "active",
        activeConfig: cfg as object,
        activeVersion: rule.version,
        activeTrigger: cfg.trigger,
        priority: cfg.priority,
        approvedBy: actor.userId,
        approvedAt: now,
        submittedAt: null,
      };
      break;
    }
    case "reject":
      if (!awaitingApproval(rule)) throw refuse("Only a version sent for approval can be sent back.");
      data = { submittedAt: null, submittedBy: null, ...(rule.status === "pending_approval" ? { status: "draft" } : {}) };
      break;
    default:
      if (!ruleCan(rule.status, action)) throw refuse(`This rule can't be ${PAST[action]} now.`);
      data = { status: RULE_STATUS_AFTER[action] };
  }
  const updated = await systemDb.smsAutomationRule.update({ where: { id }, data });
  if (action === "pause" || action === "disable") {
    await systemDb.smsMessageJob.updateMany({ where: { ruleId: id, status: "scheduled" }, data: { status: "cancelled", reason: "rule_inactive", finalAt: now, valuesEnc: null } });
  }
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: `rule_${PAST[action]}`, targetType: "sms_rule", targetId: id, version: rule.version, snapshot: action === "approve" ? cfg : undefined, metadata: action === "approve" && rule.submittedBy === actor.userId ? { selfApproved: true } : undefined, ip: actor.ip });
  return updated;
}

// ---------------------------------------------------------------------------
// Running rules
// ---------------------------------------------------------------------------

export interface RuleSubject {
  /** What the event is about, unique per trigger: "order:<id>", "ful:<id>", "cart:<token>", "customer:<contact>:<period>". */
  key: string;
  store: Store;
  contact: SmsContact | null;
  /** Why there is no contact to text (no_phone, invalid_number): recorded, so the merchant sees it. */
  noContactReason?: string | null;
  facts: RuleFacts;
  values: SmsValues;
  /** When the event happened: the rule's WAIT counts from here. */
  at: Date;
  orderId?: string | null;
  checkoutToken?: string | null;
}

export interface RuleRun {
  ruleId: string;
  outcome: "scheduled" | "dry_run" | "skipped" | "duplicate" | "conditions_failed";
  reason?: string | null;
  jobId?: string;
}

/** Run every active rule for `trigger` on one event, highest priority first. */
export async function runSmsRules(trigger: SmsTrigger, subject: RuleSubject, deps: Pick<SmsDeps, "queues">): Promise<RuleRun[]> {
  const rules = await systemDb.smsAutomationRule.findMany({ where: { storeId: subject.store.id, activeTrigger: trigger, status: "active" }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
  if (!rules.length) return [];
  const sender = await senderOf(subject.store.id);
  const basis = transactionalBasisOf(sender);
  const out: RuleRun[] = [];
  const templatesUsed = new Set<string>();
  const segments = segmentLookup(subject.store.id);
  for (const rule of rules) {
    const cfg = parseRule(rule.activeConfig);
    if (!cfg) {
      logger.warn({ ruleId: rule.id }, "sms rule's approved config no longer validates; skipped");
      continue;
    }
    const cond = evaluateRuleConditions(cfg.conditions, subject.facts);
    if (!cond.pass) {
      out.push({ ruleId: rule.id, outcome: "conditions_failed" });
      continue;
    }
    const audience = await audiencePasses(cfg, subject.facts, subject.contact?.id ?? null, segments);
    if (!audience.pass) {
      if (audience.reason === "segment_missing") logger.warn({ ruleId: rule.id }, "sms rule's segment is gone; nobody qualifies");
      out.push({ ruleId: rule.id, outcome: "conditions_failed", reason: audience.reason });
      continue;
    }
    const version = await approvedVersionOf(subject.store.id, cfg.templateId);
    const dedupeKey = `rule:${rule.id}:${subject.key}`;
    const category = TRIGGER_INFO[trigger].category;
    let skip: string | null = null;
    if (!version) skip = "template_not_approved";
    // Re-approved since the rule was, as the other category: its consent rule would no longer be the trigger's.
    else if (version.category !== category) skip = "template_category_changed";
    else if (!subject.contact) skip = subject.noContactReason ?? "no_phone";
    else {
      const ok = mayReceive(category, { consent: subject.contact.consentState as never, suppressedAll: subject.contact.suppressedAll, suppressedMarketing: subject.contact.suppressedMarketing }, basis);
      if (!ok.ok) skip = ok.reason;
      else if (templatesUsed.has(cfg.templateId)) skip = "duplicate_template";
      else {
        // The same template for the same subject from another rule (an earlier event or rule) reaches the customer once.
        const earlier = await systemDb.smsMessageJob.findFirst({ where: { storeId: subject.store.id, templateId: cfg.templateId, contactId: subject.contact.id, subjectKey: subject.key, status: { notIn: ["skipped", "cancelled", "dry_run"] }, NOT: { dedupeKey } }, select: { id: true } });
        if (earlier) skip = "duplicate_template";
      }
    }
    // Nothing to record for a rule that can't reach anyone at all on a store without a sender: keep history meaningful.
    const { job, created } = await scheduleSms(
      {
        store: subject.store,
        purpose: "automation",
        category,
        dedupeKey,
        trigger,
        ruleId: rule.id,
        ruleVersion: rule.activeVersion,
        templateId: cfg.templateId,
        templateVersion: version?.version ?? 0,
        contact: subject.contact,
        values: { order_status: ORDER_STATUS_WORD[trigger] ?? null, ...subject.values, ...(cfg.discountCode ? { discount_code: cfg.discountCode } : {}) },
        sendAfter: new Date(subject.at.getTime() + cfg.delayMinutes * 60_000),
        dryRun: cfg.dryRun || smsMode() !== "live",
        skip,
        subjectKey: subject.key,
        orderId: subject.orderId ?? null,
        checkoutToken: subject.checkoutToken ?? null,
      },
      deps,
    );
    if (!skip && version) templatesUsed.add(cfg.templateId);
    out.push({ ruleId: rule.id, outcome: !created ? "duplicate" : job.status === "dry_run" ? "dry_run" : job.status === "skipped" ? "skipped" : "scheduled", reason: job.reason, jobId: job.id });
  }
  await systemDb.smsAutomationRule.updateMany({ where: { id: { in: rules.map((r) => r.id) } }, data: { lastRunAt: new Date() } });
  return out;
}

/**
 * What a rule would do with its store's recent events, sending nothing: the subjects its trigger
 * is about (the last orders; for abandoned checkouts, the last checkouts; for inactive and VIP
 * customers, the customers who qualify now), whether its conditions pass, and whether the
 * customer could receive it. The rule's own edited version is tested, approved or not.
 */
export async function dryRunRule(store: Pick<Store, "id" | "workspaceId">, id: string): Promise<{ checked: number; wouldSend: number; results: Array<{ subject: string; pass: boolean; reason: string | null }> }> {
  const rule = await ruleOf(store.id, id);
  const cfg = parseRule(rule.config);
  if (!cfg) throw new SmsError("This rule's settings are no longer valid: edit and save it again.", 409, "rule_invalid");
  const sender = await senderOf(store.id);
  const basis = transactionalBasisOf(sender);
  const category = TRIGGER_INFO[cfg.trigger].category;
  const now = Date.now();
  const facts = (c: SmsContact, orderTotal: number | null, productTitles: string[] = []): RuleFacts => ({
    orderTotal,
    country: c.country,
    productTitles,
    customerOrders: c.ordersCount,
    customerSpent: Number(c.totalSpent),
    daysSinceLastOrder: c.lastOrderAt ? Math.floor((now - c.lastOrderAt.getTime()) / 86400_000) : null,
  });
  const segments = segmentLookup(store.id);
  const judge = async (subject: string, c: SmsContact, f: RuleFacts) => {
    const cond = evaluateRuleConditions(cfg.conditions, f);
    const audience = cond.pass ? await audiencePasses(cfg, f, c.id, segments) : { pass: false, reason: "conditions" };
    const ok = mayReceive(category, { consent: c.consentState as never, suppressedAll: c.suppressedAll, suppressedMarketing: c.suppressedMarketing }, basis);
    return { subject, pass: cond.pass && audience.pass && ok.ok, reason: !cond.pass ? "conditions" : !audience.pass ? audience.reason : ok.ok ? null : ok.reason };
  };
  let results: Array<{ subject: string; pass: boolean; reason: string | null }>;
  if (cfg.trigger === "checkout_abandoned") {
    const checkouts = await systemDb.smsCheckout.findMany({ where: { storeId: store.id, contactId: { not: null } }, orderBy: { lastActivityAt: "desc" }, take: 20 });
    const contacts = await systemDb.smsContact.findMany({ where: { id: { in: checkouts.map((k) => k.contactId!) } } });
    results = await Promise.all(
      checkouts.flatMap((k) => {
        const c = contacts.find((x) => x.id === k.contactId);
        if (!c) return [];
        if (k.status !== "open") return [Promise.resolve({ subject: `Checkout ${c.phoneMasked}`, pass: false, reason: "checkout_completed" })];
        return [judge(`Checkout ${c.phoneMasked}`, c, facts(c, k.total === null ? null : Number(k.total), k.productTitle ? [k.productTitle] : []))];
      }),
    );
  } else if (cfg.trigger === "customer_inactive" || cfg.trigger === "customer_vip" || cfg.trigger === "customer_segment") {
    const base = { storeId: store.id };
    const filter = cfg.audience.kind === "segment" ? await segments(cfg.audience.segmentId) : null;
    const contacts =
      cfg.trigger === "customer_inactive"
        ? await systemDb.smsContact.findMany({ where: { ...base, ordersCount: { gte: 1 }, lastOrderAt: { lt: new Date(now - (cfg.inactiveDays ?? 90) * 86400_000) } }, orderBy: { lastOrderAt: "desc" }, take: 20 })
        : cfg.trigger === "customer_vip"
          ? await systemDb.smsContact.findMany({ where: { ...base, OR: [...(cfg.vipMinOrders ? [{ ordersCount: { gte: cfg.vipMinOrders } }] : []), ...(cfg.vipMinSpent ? [{ totalSpent: { gte: cfg.vipMinSpent } }] : [])] }, orderBy: { totalSpent: "desc" }, take: 20 })
          : filter
            ? await systemDb.smsContact.findMany({ where: segmentWhere(store.id, filter), orderBy: { updatedAt: "desc" }, take: 20 })
            : [];
    results = await Promise.all(contacts.map((c) => judge(`Customer ${c.phoneMasked}`, c, facts(c, null))));
  } else {
    const orders = await systemDb.smsContactOrder.findMany({ where: { storeId: store.id }, orderBy: { placedAt: "desc" }, take: 20, include: { contact: true } });
    results = await Promise.all(orders.map((o) => judge(o.orderName ?? `Order ${o.shopifyOrderId}`, o.contact, facts(o.contact, Number(o.total)))));
  }
  return { checked: results.length, wouldSend: results.filter((r) => r.pass).length, results };
}
