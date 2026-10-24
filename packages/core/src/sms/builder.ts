/**
 * Automations: the four-step builder in Customer Messaging (choose a trigger, write the message,
 * set the timing, test and activate), over the module's own parts. An automation is a rule
 * (automations.ts) with a template of its own (templates.ts): nothing here sends another way, and
 * every check of the advanced pages applies. What the builder adds:
 *
 *  - which triggers this store's Shopify connection really delivers (`triggerCapabilities`): the
 *    topics its app subscribes to in its toml, the per-store topics Shopify confirmed, and when an
 *    event of each last arrived;
 *  - the message saved with the rule in one go, and both approved and started together by an
 *    owner or admin who confirms it (audited in their name, as Set up SMS does);
 *  - each automation's real state: its rule's status, whether the store can text anyone now, and
 *    the outcome of its last text. "Active" is the rule's status as stored, never the page's.
 */
import { systemDb, type SmsAutomationRule, type Store } from "@app/db";
import { expandScopes } from "@app/shared";
import {
  AUTOMATION_TRIGGER_CARDS,
  automationRule,
  automationTriggerCard,
  checkAutomationMessage,
  hasErrors,
  skipLabel,
  SMS_STATUS_LABEL,
  smsAutomationSchema,
  TRIGGER_INFO,
  TRIGGER_SOURCES,
  type SmsAutomationInput,
  type SmsCategory,
  type SmsRuleInput,
  type SmsStatus,
  type SmsTrigger,
} from "@app/shared/sms";
import { appWebhookTopics } from "../apps.js";
import type { Coord } from "../coord.js";
import { storeGraphql } from "../inventory/shopify.js";
import { logger } from "../logger.js";
import { StoreDisconnectedError } from "../tokens.js";
import { countStatuses } from "./analytics.js";
import { awaitingApproval, createRule, hasUnapprovedVersion, parseRule, ruleAction, ruleOf, updateRule } from "./automations.js";
import { marketingSwitchedOn, senderOf, senderProblem, smsAudit, SmsError, smsMode, transactionalBasisOf, type SmsDeps } from "./common.js";
import { checkSmsWebhooks, lastSmsWebhookCheck } from "./events.js";
import { sendTestSms } from "./messages.js";
import { approveLatestVersion, createTemplate, templateAction, templateOf, updateTemplate, type Actor } from "./templates.js";

type BuilderStore = Pick<Store, "id" | "workspaceId">;

// ---------------------------------------------------------------------------
// Step 1: which triggers this store can use
// ---------------------------------------------------------------------------

/**
 * ready: Shopify sends the event for this store. needs_permission: the store hasn't granted the
 * scope its topic needs. unchecked: granted, but Shopify hasn't been asked yet. not_subscribed:
 * Shopify refused the store's subscription. not_sent: the store's app doesn't receive the topic.
 * unknown_app: the store's app isn't one bizinsights knows the topics of. unavailable: no event.
 */
export type TriggerState = "ready" | "needs_permission" | "unchecked" | "not_subscribed" | "not_sent" | "unknown_app" | "unavailable";

export interface TriggerCapability {
  key: string;
  trigger: SmsTrigger | null;
  state: TriggerState;
  /** Why it can't be used, in the merchant's words (null when ready). */
  reason: string | null;
  /** The Shopify topics that carry it, and when one last reached bizinsights for this store (90 days). */
  topics: string[];
  lastEventAt: Date | null;
  /** When Shopify last confirmed a per-store subscription (null for the app's own topics). */
  checkedAt: string | null;
  /** The scope to ask Shopify for, when that's what it waits on. */
  scope: string | null;
}

const NOT_SENT =
  "Your store is connected through bizinsights' App Store app, which Shopify doesn't send order and checkout events to until it approves bizinsights' access to protected customer data. Orders still reach your dashboard through the regular sync, but too late for a text.";

/** What each trigger can do for this store, read from its app, its scopes, Shopify's last answer and the events received. */
export async function triggerCapabilities(store: Pick<Store, "id" | "shopifyAppKey" | "grantedScopes">, coord: Coord): Promise<TriggerCapability[]> {
  const scopes = expandScopes(store.grantedScopes);
  const app = appWebhookTopics(store.shopifyAppKey);
  const check = await lastSmsWebhookCheck(coord, store.id);
  const allTopics = [...new Set(Object.values(TRIGGER_SOURCES).flatMap((s) => (s ? [...s.topics, ...(s.perStore ? [s.perStore.topic] : [])] : [])))];
  const seen = await systemDb.webhookEvent.groupBy({ by: ["topic"], where: { storeId: store.id, topic: { in: allTopics }, receivedAt: { gte: new Date(Date.now() - 90 * 86400_000) } }, _max: { receivedAt: true } });
  const lastOf = new Map(seen.map((s) => [s.topic, s._max.receivedAt]));
  const latest = (topics: string[]) => topics.map((t) => lastOf.get(t) ?? null).reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);

  return AUTOMATION_TRIGGER_CARDS.map((card): TriggerCapability => {
    const source = card.trigger ? TRIGGER_SOURCES[card.trigger] : null;
    const base = { key: card.key, trigger: card.trigger, checkedAt: null, scope: null };
    if (card.unavailable || !source) return { ...base, state: "unavailable", reason: card.unavailable ?? "There is no Shopify event for this.", topics: [], lastEventAt: null };
    if (source.perStore) {
      const { topic, graphqlTopic, scope } = source.perStore;
      const topics = [topic];
      const last = latest(topics);
      if (!scopes.has(scope)) return { ...base, state: "needs_permission", scope, topics, lastEventAt: last, reason: "bizinsights needs permission to read your customers in Shopify to hear about new accounts. Give it in Shopify, then come back." };
      const state = check?.topics[graphqlTopic];
      if (state === "subscribed") return { ...base, state: "ready", reason: null, topics, lastEventAt: last, checkedAt: check!.checkedAt };
      if (state === "refused")
        return {
          ...base,
          state: "not_subscribed",
          topics,
          lastEventAt: last,
          checkedAt: check!.checkedAt,
          reason: "Shopify didn't let bizinsights subscribe to new customer accounts for this store. It allows that only once bizinsights' access to protected customer data is approved (development stores don't need it).",
        };
      return { ...base, state: "unchecked", topics, lastEventAt: last, reason: "Not checked with Shopify yet." };
    }
    const topics = source.topics;
    const last = latest(topics);
    if (!app) return { ...base, state: last ? "ready" : "unknown_app", reason: last ? null : "bizinsights can't tell which events your store's Shopify app sends.", topics, lastEventAt: last };
    if (!topics.some((t) => app.includes(t))) return { ...base, state: "not_sent", reason: NOT_SENT, topics, lastEventAt: last };
    return { ...base, state: "ready", reason: null, topics, lastEventAt: last };
  });
}

/** Ask Shopify about the store's per-store subscriptions now (subscribing what's missing), then answer step 1 again. */
export async function verifyTriggerSubscriptions(store: Store, deps: Pick<SmsDeps, "coord" | "fetchImpl">): Promise<TriggerCapability[]> {
  try {
    await checkSmsWebhooks(store, storeGraphql(store, deps.coord, deps.fetchImpl), deps.coord);
  } catch (err) {
    if (err instanceof StoreDisconnectedError) throw new SmsError("Your store isn't connected to Shopify right now: reconnect it, then check again.", 409, "store_disconnected");
    logger.warn({ err, storeId: store.id }, "sms trigger subscription check failed");
    throw new SmsError("Shopify didn't answer. Try again in a moment.", 409, "shopify_unavailable");
  }
  return triggerCapabilities(store, deps.coord);
}

/** The capability of one trigger (activation refuses anything but ready, or an app whose topics aren't known but whose events arrive). */
async function capabilityOf(store: Store, trigger: SmsTrigger, deps: Pick<SmsDeps, "coord" | "fetchImpl">): Promise<TriggerCapability> {
  const find = (all: TriggerCapability[]) => all.find((c) => c.trigger === trigger)!;
  const now = find(await triggerCapabilities(store, deps.coord));
  // Not asked yet: ask Shopify once now (that also subscribes the store).
  if (now.state === "unchecked") {
    try {
      return find(await verifyTriggerSubscriptions(store, deps));
    } catch {
      return now;
    }
  }
  return now;
}

// ---------------------------------------------------------------------------
// Whether the store can text anyone now (store-wide: shown with every automation)
// ---------------------------------------------------------------------------

export interface SendingProblem {
  code: string;
  message: string;
  /** Which texts it stops: all of them, or only order updates or marketing. */
  stops: "all" | SmsCategory;
  /** Where it is fixed. */
  fix: { label: string; href: string } | null;
}

/** What stands between this store's automations and its customers' phones, now. Empty: texts go out. */
export async function sendingProblems(store: BuilderStore): Promise<SendingProblem[]> {
  const out: SendingProblem[] = [];
  const mode = smsMode();
  if (mode === "off") out.push({ code: "platform_off", stops: "all", fix: null, message: "SMS isn't switched on for bizinsights yet, so nothing is sent to anyone." });
  if (mode === "sandbox")
    out.push({ code: "test_mode", stops: "all", fix: null, message: "bizinsights is in test mode: what an automation would send is recorded in Message History instead of reaching customers. Test texts still reach your verified numbers." });
  const sender = await senderOf(store.id);
  const problem = senderProblem(sender);
  const setup = (step: string, label: string) => ({ label, href: `/messaging/setup?step=${step}` });
  if (problem === "missing") out.push({ code: "no_sender", stops: "all", fix: setup("sender", "Choose a sender name"), message: "Your store has no sender yet." });
  if (problem === "unverified") out.push({ code: "sender_unverified", stops: "all", fix: setup("sender", "Check your sender name"), message: "AWS hasn't approved your sender yet." });
  if (problem === "no_countries") out.push({ code: "no_countries", stops: "all", fix: { label: "Sender Configuration", href: "/messaging/sender" }, message: "No destination country is switched on for your sender." });
  if (problem === "held") out.push({ code: "held", stops: "all", fix: { label: "Sender Configuration", href: "/messaging/sender" }, message: "Sending is held for a while after a problem at AWS." });
  if (sender && problem !== "missing") {
    if (!sender.sendingEnabled) out.push({ code: "sending_off", stops: "all", fix: setup("automate", "Turn on Automatic SMS"), message: "Automatic SMS is switched off for your store." });
    if (Number(sender.monthlyBudgetUsd) <= 0) out.push({ code: "no_budget", stops: "all", fix: setup("automate", "Set a monthly limit"), message: "Your monthly SMS spending limit is 0, so nothing can be sent." });
    if (transactionalBasisOf(sender) === "none")
      out.push({ code: "no_basis", stops: "transactional", fix: setup("automate", "Choose how customers agreed"), message: "Order updates go to no one until you choose how your customers agreed to get them by text." });
    if (!sender.marketingEnabled) out.push({ code: "marketing_off", stops: "marketing", fix: { label: "Sender Configuration", href: "/messaging/sender" }, message: "Marketing texts are switched off for your store." });
  }
  if (!marketingSwitchedOn()) out.push({ code: "marketing_platform_off", stops: "marketing", fix: null, message: "Marketing texts (reminders, welcome and win-back texts) aren't switched on for bizinsights yet." });
  return out;
}

// ---------------------------------------------------------------------------
// The automations, as the list and the builder show them
// ---------------------------------------------------------------------------

export interface AutomationView {
  id: string;
  name: string;
  trigger: SmsTrigger | null;
  triggerLabel: string | null;
  category: SmsCategory | null;
  /** The rule's status as stored: draft | pending_approval | active | paused | disabled. */
  status: string;
  /** Saved changes that aren't running yet (the running version stays until they're activated). */
  pendingChanges: boolean;
  /** Practice run: records what it would send, sends nothing. */
  dryRun: boolean;
  /** What the builder edits (null when the saved settings no longer validate). */
  config: SmsAutomationInput | null;
  templateId: string | null;
  /** The message's text with its variables: the latest saved, and the one that sends now. */
  body: string | null;
  liveBody: string | null;
  lastRunAt: Date | null;
  /** The outcome of its most recent text (no number, no customer: just what happened). */
  lastResult: { status: string; statusLabel: string; reason: string | null; reasonLabel: string | null; at: Date; dryRun: boolean } | null;
  last30Days: ReturnType<typeof countStatuses>;
  createdAt: Date;
  updatedAt: Date;
}

/** What the builder edits, from a rule and its template's latest text. */
function inputOf(cfg: SmsRuleInput, body: string): SmsAutomationInput {
  return {
    name: cfg.name,
    trigger: cfg.trigger,
    body,
    conditions: cfg.conditions,
    delayMinutes: cfg.delayMinutes,
    discountCode: cfg.discountCode ?? null,
    quietStart: cfg.quietStart,
    quietEnd: cfg.quietEnd,
    useCustomerTimezone: cfg.useCustomerTimezone,
    maxPerCustomer: cfg.maxPerCustomer,
    capDays: cfg.capDays,
    priority: cfg.priority,
    dryRun: cfg.dryRun,
    inactiveDays: cfg.inactiveDays ?? null,
    vipMinOrders: cfg.vipMinOrders ?? null,
    vipMinSpent: cfg.vipMinSpent ?? null,
  };
}

async function views(store: BuilderStore, rules: SmsAutomationRule[]): Promise<AutomationView[]> {
  if (!rules.length) return [];
  const cfgs = new Map(rules.map((r) => [r.id, parseRule(r.config)]));
  const templateIds = [...new Set([...cfgs.values()].map((c) => c?.templateId).filter((x): x is string => !!x))];
  const since = new Date(Date.now() - 30 * 86400_000);
  const [templates, groups, lasts] = await Promise.all([
    systemDb.smsTemplate.findMany({ where: { storeId: store.id, id: { in: templateIds } }, include: { versions: { orderBy: { version: "desc" } } } }),
    systemDb.smsMessageJob.groupBy({ by: ["ruleId", "status"], where: { storeId: store.id, ruleId: { in: rules.map((r) => r.id) }, createdAt: { gte: since } }, _count: true }),
    Promise.all(rules.map((r) => systemDb.smsMessageJob.findFirst({ where: { storeId: store.id, ruleId: r.id }, orderBy: { createdAt: "desc" }, select: { status: true, reason: true, createdAt: true, dryRun: true } }))),
  ]);
  const templateById = new Map(templates.map((t) => [t.id, t]));
  return rules.map((r, i) => {
    const cfg = cfgs.get(r.id) ?? null;
    const t = cfg ? templateById.get(cfg.templateId) : undefined;
    const latest = t?.versions[0];
    const live = t?.versions.find((v) => v.version === t.approvedVersion);
    const last = lasts[i];
    const status = last?.status as SmsStatus | undefined;
    return {
      id: r.id,
      name: r.name,
      trigger: cfg?.trigger ?? null,
      triggerLabel: cfg ? automationTriggerCard(cfg.trigger).label : null,
      category: cfg ? TRIGGER_INFO[cfg.trigger].category : null,
      status: r.status,
      // Once activated, an edit of the rule or of its message waits until it's activated too.
      pendingChanges: r.activeVersion !== null && (hasUnapprovedVersion(r) || (!!latest && latest.status !== "approved")),
      dryRun: parseRule(r.activeConfig)?.dryRun ?? cfg?.dryRun ?? false,
      config: cfg && latest ? inputOf(cfg, latest.body) : null,
      templateId: cfg?.templateId ?? null,
      body: latest?.body ?? null,
      liveBody: r.status === "active" || r.status === "paused" ? (live?.body ?? null) : null,
      lastRunAt: r.lastRunAt,
      lastResult: last && status ? { status, statusLabel: SMS_STATUS_LABEL[status] ?? status, reason: last.reason, reasonLabel: skipLabel(last.reason), at: last.createdAt, dryRun: last.dryRun } : null,
      last30Days: countStatuses(groups.filter((g) => g.ruleId === r.id).map((g) => ({ status: g.status, _count: g._count }))),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

/** Every automation of the store (rules made here, in Set up SMS or on the advanced page alike), newest first. */
export async function listAutomations(store: BuilderStore): Promise<AutomationView[]> {
  const rules = await systemDb.smsAutomationRule.findMany({ where: { storeId: store.id }, orderBy: [{ updatedAt: "desc" }] });
  return views(store, rules);
}

export async function automationOf(store: BuilderStore, id: string): Promise<AutomationView> {
  return (await views(store, [await ruleOf(store.id, id)]))[0]!;
}

// ---------------------------------------------------------------------------
// Saving, activating, pausing, duplicating, deleting
// ---------------------------------------------------------------------------

/** The automation's template is its own unless another rule uses it too (then an edit makes it a template of its own). */
async function sharedWithOthers(storeId: string, templateId: string, ruleId: string | null): Promise<boolean> {
  const n = await systemDb.smsAutomationRule.count({ where: { storeId, ...(ruleId ? { NOT: { id: ruleId } } : {}), OR: [{ config: { path: ["templateId"], equals: templateId } }, { activeConfig: { path: ["templateId"], equals: templateId } }] } });
  if (n) return true;
  return (await systemDb.smsCampaign.count({ where: { storeId, templateId } })) > 0;
}

/** A new template for an automation, named after it ("Order shipped", else "Order shipped (automation)"…). */
async function newTemplate(store: BuilderStore, name: string, category: SmsCategory, body: string, actor: Actor): Promise<string> {
  const short = name.slice(0, 60);
  for (const n of [name, `${short} (automation)`, `${short} (automation ${Date.now().toString(36)})`]) {
    try {
      return (await createTemplate(store, { name: n, category, body }, actor)).template.id;
    } catch (e) {
      if (e instanceof SmsError && e.code === "template_exists") continue;
      throw e;
    }
  }
  throw new SmsError("Couldn't name the message's template: rename the automation and try again.", 409, "template_exists");
}

/** The message's problems that stop it being saved, as one refusal with all of them. */
function refuseMessage(a: SmsAutomationInput) {
  const issues = checkAutomationMessage(a.body, a.trigger, a.discountCode);
  if (hasErrors(issues)) throw new SmsError(issues.find((i) => i.level === "error")!.message, 400, "message_invalid", { issues });
  return issues;
}

/**
 * Save an automation (new: id null). The message goes into the automation's template as a new
 * version, the settings into its rule as a new version; a running automation keeps running what
 * was activated until the changes are activated too. Nothing new is sent by saving.
 */
export async function saveAutomation(store: BuilderStore, id: string | null, raw: unknown, actor: Actor): Promise<AutomationView> {
  const a = smsAutomationSchema.parse(raw);
  refuseMessage(a);
  const category = TRIGGER_INFO[a.trigger].category;
  const rule = id ? await ruleOf(store.id, id) : null;
  const current = rule ? parseRule(rule.config) : null;
  let templateId: string | null = current?.templateId ?? null;
  if (templateId) {
    const t = await systemDb.smsTemplate.findFirst({ where: { id: templateId, storeId: store.id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!t || (await sharedWithOthers(store.id, templateId, rule!.id))) templateId = null;
    else {
      if (t.status === "archived") await templateAction(store, t.id, "restore", actor);
      const latest = t.versions[0];
      if (latest?.body !== a.body || latest?.category !== category) await updateTemplate(store, t.id, { name: t.name, category, body: a.body, countries: t.countries }, actor);
    }
  }
  templateId ??= await newTemplate(store, a.name, category, a.body, actor);
  const cfg = automationRule(a, templateId);
  let saved: SmsAutomationRule;
  if (!rule) saved = await createRule(store, cfg, actor);
  else if (!current || JSON.stringify(current) !== JSON.stringify(cfg) || rule.status === "disabled") saved = await updateRule(store, rule.id, cfg, actor);
  else saved = rule;
  return (await views(store, [saved]))[0]!;
}

/**
 * Turn an automation on (or put its saved changes live): its message's latest version and its
 * rule's are approved in the member's name, and the rule runs. Refused unless the member
 * confirmed that it may text real customers, Shopify sends its trigger for this store, and the
 * message has no errors. Store-wide problems (sender, Automatic SMS, test mode) don't stop it:
 * they stop the texts, and every page says so (sendingProblems).
 */
export async function activateAutomation(store: Store, id: string, input: { confirm?: boolean }, deps: Pick<SmsDeps, "coord" | "fetchImpl">, actor: Actor): Promise<AutomationView> {
  if (!input.confirm) throw new SmsError("Confirm that this automation may text your customers.", 400, "confirm_required");
  let rule = await ruleOf(store.id, id);
  const cfg = parseRule(rule.config);
  if (!cfg) throw new SmsError("This automation's settings are no longer valid: edit and save it again.", 409, "rule_invalid");
  const cap = await capabilityOf(store, cfg.trigger, deps);
  if (cap.state !== "ready") throw new SmsError(cap.reason ?? "Shopify doesn't send this trigger for your store.", 409, "trigger_unavailable", { state: cap.state });
  const t = await templateOf(store.id, cfg.templateId);
  refuseMessage(inputOf(cfg, t.versions[0]!.body));
  // Already running: this puts its saved changes live.
  const wasActive = rule.status === "active";
  await approveLatestVersion(store, cfg.templateId, actor, "Approved when the automation was turned on");
  if (rule.status === "disabled") rule = await updateRule(store, rule.id, cfg, actor);
  if (hasUnapprovedVersion(rule)) {
    if (!awaitingApproval(rule)) rule = await ruleAction(store, rule.id, "submit", actor);
    rule = await ruleAction(store, rule.id, "approve", actor);
  }
  if (rule.status === "paused") rule = await ruleAction(store, rule.id, "resume", actor);
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: wasActive ? "automation_republished" : "automation_activated", targetType: "sms_rule", targetId: rule.id, version: rule.activeVersion, ip: actor.ip });
  return automationOf(store, rule.id);
}

/** Pause a running automation: it stops at once and its texts still waiting are cancelled. */
export async function pauseAutomation(store: BuilderStore, id: string, actor: Actor): Promise<AutomationView> {
  const rule = await ruleOf(store.id, id);
  if (rule.status !== "active") throw new SmsError("This automation isn't running.", 409, "rule_state");
  await ruleAction(store, id, "pause", actor);
  return automationOf(store, id);
}

/** A copy as a draft, with a template of its own ("… (copy)"). */
export async function duplicateAutomation(store: BuilderStore, id: string, actor: Actor): Promise<AutomationView> {
  const src = await automationOf(store, id);
  if (!src.config) throw new SmsError("This automation's settings are no longer valid: edit and save it before copying it.", 409, "rule_invalid");
  return saveAutomation(store, null, { ...src.config, name: `${src.config.name.slice(0, 73)} (copy)` }, actor);
}

/**
 * Delete an automation: its texts still waiting are cancelled, the rule goes (its history and
 * audit trail stay, under its id), and its template is archived unless something else uses it.
 */
export async function deleteAutomation(store: BuilderStore, id: string, actor: Actor): Promise<{ cancelled: number }> {
  const rule = await ruleOf(store.id, id);
  const cfg = parseRule(rule.config);
  const now = new Date();
  const { count } = await systemDb.smsMessageJob.updateMany({ where: { storeId: store.id, ruleId: id, status: "scheduled" }, data: { status: "cancelled", reason: "rule_inactive", finalAt: now, valuesEnc: null } });
  await systemDb.smsAutomationRule.delete({ where: { id } });
  const templateIds = [...new Set([cfg?.templateId, parseRule(rule.activeConfig)?.templateId].filter((x): x is string => !!x))];
  for (const templateId of templateIds) {
    if (await sharedWithOthers(store.id, templateId, null)) continue;
    await templateAction(store, templateId, "archive", actor).catch((err: unknown) => logger.info({ err, storeId: store.id }, "sms automation's template left as it was"));
  }
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "rule_deleted", targetType: "sms_rule", targetId: id, version: rule.version, snapshot: cfg ?? undefined, metadata: { cancelled: count }, ip: actor.ip });
  return { cancelled: count };
}

/** Step 4's test: the automation's saved message (sample values) to one of the team's verified numbers. */
export async function testAutomation(store: Store, id: string, testNumberId: string, requestId: string | null | undefined, deps: SmsDeps, actor: Actor) {
  const cfg = parseRule((await ruleOf(store.id, id)).config);
  if (!cfg) throw new SmsError("This automation's settings are no longer valid: edit and save it again.", 409, "rule_invalid");
  return sendTestSms(store, cfg.templateId, testNumberId, deps, actor, requestId);
}
