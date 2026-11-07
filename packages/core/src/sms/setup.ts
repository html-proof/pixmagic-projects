/**
 * Set up SMS: the five steps a merchant goes through in Customer Messaging (connect, sender name,
 * message, test, automatic texts), built on the module's own parts. Nothing here sends any other
 * way: the sender, the templates, the rules and the test texts are the same rows the advanced
 * pages edit, with the same checks. What the setup adds is a draft that survives "Continue
 * later", the sender name a merchant asks for, and one press to approve and start an order update
 * (an owner or admin's approval, recorded as theirs like any other).
 *
 * A sender name is only ever "approved" on AWS's word: AWS has the sender ID, tagged for the
 * workspace, and registered where the country requires it. Asking for one records the request and
 * emails the platform owner (SMS_SENDER_REQUESTS_TO), who requests it from AWS, registers it and
 * tags it (docs/sms.md, "Sender names from Set up SMS"): bizinsights doesn't create sender IDs or
 * submit registrations from a merchant's click, since the account and the registrations are the
 * platform's and a name is someone's brand.
 */
import { Prisma, systemDb, type SmsSenderConfiguration, type SmsSetup, type Store } from "@app/db";
import {
  checkSenderName,
  checkTemplate,
  missingForTrigger,
  senderIdSupport,
  senderNameStatus,
  setupAutomation,
  SETUP_AUTOMATIONS,
  SETUP_FIRST_MESSAGE,
  smsRuleSchema,
  type SenderNameStatus,
  type SmsSenderInput,
  type SmsSetupDraft,
  type SmsTransactionalBasis,
  type SmsTrigger,
} from "@app/shared/sms";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { awaitingApproval, createRule, hasUnapprovedVersion, parseRule, ruleAction, updateRule } from "./automations.js";
import { senderOf, smsAudit, SmsError, smsMode, smsRegion, type SmsDeps } from "./common.js";
import type { SmsIdentityInfo } from "./provider.js";
import { identityAllowed, saveSender, setSending, verifySender, WORKSPACE_TAG } from "./senders.js";
import { approveLatestVersion, createTemplate, templateAction, updateTemplate, type Actor } from "./templates.js";
import { twilioInboundUrl } from "./twilio.js";

/** The template and rule the Automatic SMS step made for each event. */
export type SetupAutomationMap = Partial<Record<SmsTrigger, { templateId?: string | null; ruleId?: string | null }>>;

export const automationsOf = (row: Pick<SmsSetup, "automations">): SetupAutomationMap => (row.automations && typeof row.automations === "object" ? (row.automations as SetupAutomationMap) : {});

/** The country a store's customers are most likely in, from its currency: only where one currency means one country. */
const CURRENCY_COUNTRY: Record<string, string> = { AUD: "AU", NZD: "NZ", GBP: "GB", USD: "US", CAD: "CA", INR: "IN", SGD: "SG", HKD: "HK", ZAR: "ZA", MYR: "MY", PHP: "PH", AED: "AE", JPY: "JP" };
export const defaultCountry = (store: Pick<Store, "currency">): string | null => CURRENCY_COUNTRY[(store.currency ?? "").toUpperCase()] ?? null;

/** The store's setup row, made on first use. */
export async function setupRow(store: Pick<Store, "id" | "workspaceId">): Promise<SmsSetup> {
  return systemDb.smsSetup.upsert({ where: { storeId: store.id }, create: { workspaceId: store.workspaceId, storeId: store.id }, update: {} });
}

// ---------------------------------------------------------------------------
// Step 1: the connection to AWS End User Messaging SMS
// ---------------------------------------------------------------------------

export type ConnectionError = "platform_off" | "not_configured" | "aws_unreachable";

/**
 * "Connect": ask AWS about the platform's SMS account with the function's own role (no keys
 * anywhere: the merchant has none to give, and the browser never sees any). Connected means AWS
 * answered; it says nothing yet about the sender, which is step 2.
 */
export async function connectSms(store: Pick<Store, "id" | "workspaceId">, deps: Pick<SmsDeps, "sms">, actor: Actor) {
  const row = await setupRow(store);
  let error: ConnectionError | null = null;
  let account: { sandbox: boolean; tier: string } | null = null;
  if (smsMode() === "off") error = "platform_off";
  else {
    try {
      const a = await deps.sms.account(smsRegion(await senderOf(store.id)));
      if (a.tier === "NOT_CONFIGURED") error = "not_configured";
      else account = { sandbox: a.sandbox, tier: a.tier };
    } catch (err) {
      logger.warn({ err, storeId: store.id }, "sms setup connection check failed");
      error = "aws_unreachable";
    }
  }
  const now = new Date();
  const connected = !error;
  await systemDb.smsSetup.update({
    where: { id: row.id },
    data: {
      connection: connected ? "connected" : "failed",
      connectionError: error,
      connectionCheckedAt: now,
      ...(connected && row.connection !== "connected" ? { connectedAt: now, connectedBy: actor.userId } : {}),
      ...(connected && row.step === "connect" ? { step: "sender" } : {}),
      updatedBy: actor.userId,
    },
  });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: connected ? "setup_connected" : "setup_connect_failed", targetType: "sms_setup", targetId: row.id, metadata: { error, sandbox: account?.sandbox ?? null }, ip: actor.ip });
  return { connected, error, account };
}

/** "Disconnect": texting stops at once (waiting texts are cancelled); the sender, messages and history stay for a later reconnect. */
export async function disconnectSms(store: Pick<Store, "id" | "workspaceId">, actor: Actor) {
  const row = await setupRow(store);
  const sender = await senderOf(store.id);
  if (sender?.sendingEnabled) await setSending(store, { sending: false }, actor);
  await systemDb.smsSetup.update({ where: { id: row.id }, data: { connection: "disconnected", connectionError: null, connectedAt: null, updatedBy: actor.userId } });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "setup_disconnected", targetType: "sms_setup", targetId: row.id, ip: actor.ip });
}

// ---------------------------------------------------------------------------
// The draft ("Save draft", "Continue later")
// ---------------------------------------------------------------------------

/** What saveSender needs to keep a sender as it is, with some fields changed. */
const senderInputOf = (s: SmsSenderConfiguration): SmsSenderInput => ({
  senderType: s.senderType as SmsSenderInput["senderType"],
  originationIdentity: s.originationIdentity,
  countries: s.countries,
  monthlyBudgetUsd: Number(s.monthlyBudgetUsd),
  hardStop: s.hardStop,
  monthlyMessageQuota: s.monthlyMessageQuota,
  transactionalBasis: s.transactionalBasis as SmsTransactionalBasis,
  quietStart: s.quietStart,
  quietEnd: s.quietEnd,
  maxPerCustomerDay: s.maxPerCustomerDay,
  maxMarketingPerWeek: s.maxMarketingPerWeek,
  dltEntityId: s.dltEntityId,
});

/**
 * Keep what the merchant has so far. A different sender name or country starts that part over
 * (what was asked for, or found at AWS, was for the old one); a sender already in use keeps
 * sending until a new one is approved. The budget and the basis for order updates go to the
 * sender when there is one, else wait here for it.
 */
export async function saveSetupDraft(store: Pick<Store, "id" | "workspaceId">, d: SmsSetupDraft, actor: Actor): Promise<SmsSetup> {
  const row = await setupRow(store);
  const data: Prisma.SmsSetupUpdateInput = { updatedBy: actor.userId };
  if (d.step) data.step = d.step;
  if (d.businessName !== undefined) data.businessName = d.businessName?.trim() || null;
  if (d.message !== undefined) data.message = d.message;
  const name = d.senderName === undefined ? row.senderName : d.senderName?.trim() || null;
  const country = d.country === undefined ? row.country : d.country || null;
  if (name !== row.senderName || country !== row.country) {
    Object.assign(data, { senderName: name, country, senderNameStatus: "draft", senderRequestedAt: null, senderRequestedBy: null, senderCheckedAt: null, senderRegistration: null });
  }
  if ((d.monthlyBudgetUsd !== undefined && d.monthlyBudgetUsd !== null) || d.transactionalBasis) {
    const sender = await senderOf(store.id);
    if (sender) {
      await saveSender(
        store,
        {
          ...senderInputOf(sender),
          ...(d.monthlyBudgetUsd !== undefined && d.monthlyBudgetUsd !== null ? { monthlyBudgetUsd: d.monthlyBudgetUsd } : {}),
          ...(d.transactionalBasis ? { transactionalBasis: d.transactionalBasis } : {}),
        },
        actor,
      );
    } else {
      if (d.monthlyBudgetUsd !== undefined && d.monthlyBudgetUsd !== null) data.monthlyBudgetUsd = d.monthlyBudgetUsd;
      if (d.transactionalBasis) data.transactionalBasis = d.transactionalBasis;
    }
  }
  return systemDb.smsSetup.update({ where: { id: row.id }, data });
}

// ---------------------------------------------------------------------------
// Step 2: the sender name
// ---------------------------------------------------------------------------

export interface SenderCheckResult {
  status: SenderNameStatus;
  /** AWS's registration status, when it has one. */
  registration: string | null;
  /** What AWS has, when it has something for this workspace: what customers will see. */
  label: string | null;
}

/**
 * The store's sender as AWS has it: for a name, the sender ID of that name in that country; where
 * names aren't shown, a phone number tagged for the workspace. Null when AWS has none.
 */
async function lookUp(store: Pick<Store, "workspaceId">, row: SmsSetup, deps: Pick<SmsDeps, "sms">): Promise<SmsIdentityInfo | null> {
  const region = smsRegion(null);
  if (senderIdSupport(row.country) === "none") return (await deps.sms.taggedNumbers(region, row.country!, WORKSPACE_TAG, store.workspaceId))[0] ?? null;
  const info = await deps.sms.identity(region, row.senderName!, row.country);
  // DescribeSenderIds answers per country, and carriers show the name as registered: the same name, the same country.
  if (!info || info.kind !== "sender_id" || info.id.toUpperCase() !== row.senderName!.toUpperCase() || (info.country && info.country !== row.country)) return null;
  return info;
}

/**
 * Make an approved identity the store's sender (the same row Sender Configuration edits), check it
 * with AWS, and keep sending on if it was on.
 */
async function linkIdentity(store: Pick<Store, "id" | "workspaceId">, info: SmsIdentityInfo, country: string, row: SmsSetup, deps: Pick<SmsDeps, "sms">, actor: Actor): Promise<SmsSenderConfiguration> {
  const before = await senderOf(store.id);
  const same = !!before && (before.originationIdentity === info.arn || before.originationIdentity === info.id);
  if (same && before.identityCheck === "verified") return before;
  await saveSender(
    store,
    before
      ? { ...senderInputOf(before), senderType: info.kind, originationIdentity: info.arn, countries: same ? before.countries : [country] }
      : {
          senderType: info.kind,
          originationIdentity: info.arn,
          countries: [country],
          monthlyBudgetUsd: Number(row.monthlyBudgetUsd ?? 0),
          hardStop: true,
          monthlyMessageQuota: null,
          transactionalBasis: (row.transactionalBasis as SmsTransactionalBasis | null) ?? "none",
          quietStart: 21,
          quietEnd: 9,
          maxPerCustomerDay: 3,
          maxMarketingPerWeek: 2,
          dltEntityId: null,
        },
    actor,
  );
  const verified = await verifySender(store, deps, actor);
  // A new identity turns sending off until it checks out (saveSender); it did, so it goes on as it was.
  if (before?.sendingEnabled && verified.identityCheck === "verified") return setSending(store, { sending: true, ...(before.marketingEnabled ? { marketing: true } : {}) }, actor);
  return verified;
}

/**
 * "Verify" / "Check status": ask AWS whether it has the sender name (or, where names aren't
 * shown, a number) for this workspace, and how far its registration is. Approved only when AWS
 * says so; then it becomes the store's sender.
 */
export async function checkSetupSender(store: Pick<Store, "id" | "workspaceId">, deps: Pick<SmsDeps, "sms">, actor: Actor): Promise<SenderCheckResult> {
  const row = await setupRow(store);
  if (!row.country) throw new SmsError("Choose the country most of your customers are in first.", 400, "no_country");
  const support = senderIdSupport(row.country);
  if (support !== "none" && !row.senderName) throw new SmsError("Enter a sender name first.", 400, "no_sender_name");
  let info: SmsIdentityInfo | null;
  try {
    info = await lookUp(store, row, deps);
  } catch (err) {
    logger.warn({ err, storeId: store.id }, "sms setup sender lookup failed");
    throw new SmsError("The SMS provider didn't answer. Nothing changed: try again in a few minutes.", 409, "provider_error");
  }
  const mine = !!info && (support === "none" || identityAllowed(info, store.workspaceId, row.senderName!));
  // Where the country requires registration, a sender ID AWS reports nothing about isn't registered.
  const registration = info ? (info.registrationStatus ?? (support === "registered" ? "REQUIRED" : null)) : null;
  const status = senderNameStatus(info ? { mine, registration } : null, !!row.senderRequestedAt);
  await systemDb.smsSetup.update({ where: { id: row.id }, data: { senderNameStatus: status, senderCheckedAt: new Date(), senderRegistration: mine ? registration : null } });
  if (status === "approved" && info) await linkIdentity(store, info, row.country, row, deps, actor);
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "setup_sender_checked", targetType: "sms_setup", targetId: row.id, metadata: { name: row.senderName, country: row.country, status, registration: mine ? registration : null }, ip: actor.ip });
  return { status, registration: mine ? registration : null, label: mine && info ? info.label : null };
}

/**
 * "Request sender name" (or, where names aren't shown, "Request a number"): checked here as in the
 * browser, then looked up at AWS (it may be there already); otherwise recorded as requested and
 * sent to the platform owner, once per name and country.
 */
export async function requestSetupSender(store: Pick<Store, "id" | "workspaceId" | "shopDomain" | "name">, deps: Pick<SmsDeps, "sms" | "mailer">, actor: Actor & { email?: string | null }): Promise<SenderCheckResult> {
  const row = await setupRow(store);
  if (!row.country) throw new SmsError("Choose the country most of your customers are in first.", 400, "no_country");
  if (row.country === "IN") {
    throw new SmsError("Texts to India need your own DLT registration with an Indian operator. Set them up on the SMS Sender page with your DLT Principal Entity ID.", 409, "india_dlt");
  }
  const support = senderIdSupport(row.country);
  if (support !== "none") {
    const check = checkSenderName(row.senderName ?? "", row.country);
    if (check.problems.length) throw new SmsError(check.problems[0]!, 400, "sender_name_invalid", { problems: check.problems });
  }
  const found = await checkSetupSender(store, deps, actor).catch((err: unknown) => {
    if (err instanceof SmsError && err.code === "provider_error") return null;
    throw err;
  });
  if (found?.status === "unavailable") throw new SmsError("This sender name is already set up for another business. Choose another name.", 409, "sender_name_taken");
  if (found && found.status !== "draft" && found.status !== "requested") return found;
  const fresh = await systemDb.smsSetup.findUniqueOrThrow({ where: { id: row.id } });
  const first = !fresh.senderRequestedAt;
  await systemDb.smsSetup.update({
    where: { id: row.id },
    data: { senderNameStatus: "requested", ...(first ? { senderRequestedAt: new Date(), senderRequestedBy: actor.userId } : {}) },
  });
  if (first) await tellPlatformOwner(store, fresh, actor.email ?? null, deps);
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "setup_sender_requested", targetType: "sms_setup", targetId: row.id, metadata: { name: support === "none" ? null : fresh.senderName, country: fresh.country, support }, ip: actor.ip });
  return { status: "requested", registration: null, label: null };
}

/** The request, to the platform owner: what to create at the SMS provider, and how to tag it so only this workspace can use it. */
async function tellPlatformOwner(store: Pick<Store, "id" | "workspaceId" | "shopDomain" | "name">, row: SmsSetup, requester: string | null, deps: Pick<SmsDeps, "mailer">) {
  const support = senderIdSupport(row.country);
  const country = row.country!;
  const region = smsRegion(null);
  logger.info({ storeId: store.id, workspaceId: store.workspaceId, senderName: row.senderName, country, support }, "sms sender requested in setup");
  const to = env().SMS_SENDER_REQUESTS_TO.trim();
  if (!to) return;
  const twilio = env().SMS_PROVIDER === "twilio";
  const tag = `Key=${WORKSPACE_TAG},Value=${store.workspaceId}`;
  // Twilio has no tags: the friendly name carries them (core/sms/twilio.ts twilioTags).
  const twilioTag = `${WORKSPACE_TAG}=${store.workspaceId}`;
  const who = [`Store: ${store.name ?? store.shopDomain} (${store.shopDomain})`, `Workspace: ${store.workspaceId}`, `Asked by: ${requester ?? "a team member"}`];
  const steps = twilio
    ? support === "none"
      ? [
          `${country} doesn't show sender names. Buy the store a number that can text ${country} (Twilio console → Phone Numbers → Buy a number; US: toll-free with its verification, or 10DLC), then set its Friendly Name to:`,
          `  ${twilioTag}`,
          `and its "A message comes in" webhook to ${twilioInboundUrl()} (HTTP POST), so STOP replies reach bizinsights.`,
        ]
      : [
          `1. Check the name is theirs to use (their business or brand name, not someone else's).`,
          support === "registered" || support === "unknown"
            ? `2. ${country} ${support === "registered" ? "requires" : "may require"} the name's registration with Twilio (console → Messaging → Regulatory Compliance → Sender ID registration, with the merchant's business details). Wait until Twilio shows it approved for ${country}.`
            : `2. ${country} needs no registration of the name.`,
          `3. Twilio console → Messaging → Services → Create: Friendly Name exactly "${twilioTag}". Sender Pool → Add Senders → Alpha Sender ID: ${row.senderName}. Integration → Incoming messages: Send a webhook to ${twilioInboundUrl()}.`,
          `4. The name is approved for them as soon as the service has it, so add it only after step 2.`,
        ]
    : support === "none"
      ? [
          `${country} doesn't show sender names. Get the store a number that can text ${country} (AWS console, ${region} → Phone numbers → Request originator; US: a toll-free number with its verification, or 10DLC), then tag it:`,
          `  aws pinpoint-sms-voice-v2 tag-resource --region ${region} --resource-arn <the number's ARN> --tags ${tag}`,
        ]
      : [
          `1. Check the name is theirs to use (their business or brand name, not someone else's).`,
          `2. aws pinpoint-sms-voice-v2 request-sender-id --region ${region} --sender-id ${row.senderName} --iso-country-code ${country} --message-types TRANSACTIONAL --tags ${tag}`,
          support === "registered" || support === "unknown"
            ? `3. ${country} ${support === "registered" ? "requires" : "may require"} registration: AWS console, ${region} → Registrations → create the ${country} sender ID registration with the merchant's business details, and associate the sender ID. The name is approved for them once AWS shows the registration as Complete.`
            : `3. ${country} needs no registration: the name is approved for them as soon as the sender ID exists with the tag.`,
        ];
  const subject = support === "none" ? `SMS number wanted for ${country}: ${store.shopDomain}` : `SMS sender name wanted: ${row.senderName} (${country}) for ${store.shopDomain}`;
  const text = [
    "A merchant asked for an SMS sender in Customer Messaging → Set up SMS.",
    "",
    ...who,
    support === "none" ? `Country: ${country}` : `Sender name: ${row.senderName}  Country: ${country}  (${support})`,
    "",
    ...steps,
    "",
    `Nothing more to do in bizinsights: the merchant's "Check status" finds it at ${twilio ? "Twilio" : "AWS"} by its tag and makes it their sender (docs/sms.md, "Sender names from Set up SMS").`,
  ].join("\n");
  await deps.mailer.send(to, subject, text, undefined, { idempotencyKey: `sms-sender-request:${store.id}:${row.senderName ?? "number"}:${country}` }).catch((err: unknown) => logger.error({ err, storeId: store.id }, "sms sender request email failed"));
}

/** Use the platform's shared sender (SMS_SHARED_SENDER) while the store's own isn't approved: AWS must still say it is the shared one. */
export async function useSharedSender(store: Pick<Store, "id" | "workspaceId">, deps: Pick<SmsDeps, "sms">, actor: Actor): Promise<SmsSenderConfiguration> {
  const shared = env().SMS_SHARED_SENDER.trim();
  if (!shared) throw new SmsError("bizinsights has no shared sender to offer right now.", 409, "no_shared_sender");
  const row = await setupRow(store);
  let info: SmsIdentityInfo | null;
  try {
    info = await deps.sms.identity(smsRegion(null), shared, row.country);
  } catch (err) {
    logger.warn({ err, storeId: store.id }, "sms shared sender lookup failed");
    throw new SmsError("The SMS provider didn't answer. Try again in a few minutes.", 409, "provider_error");
  }
  if (!info || !identityAllowed(info, store.workspaceId, shared)) throw new SmsError("The shared sender isn't available right now.", 409, "no_shared_sender");
  const country = row.country ?? info.country;
  if (!country) throw new SmsError("Choose the country most of your customers are in first.", 400, "no_country");
  if (info.country && info.country !== country) throw new SmsError(`The shared sender only reaches customers in ${info.country}.`, 409, "shared_sender_country");
  const s = await linkIdentity(store, info, country, row, deps, actor);
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "setup_shared_sender", targetType: "sms_setup", targetId: row.id, metadata: { country }, ip: actor.ip });
  return s;
}

// ---------------------------------------------------------------------------
// Steps 3 and 5: messages and the order updates that send them
// ---------------------------------------------------------------------------

/** Create or edit the template an automatic text uses. A new one is named for its event ("Order shipped"), or "… (SMS setup)" when the store has that name already. */
async function upsertSetupTemplate(store: Pick<Store, "id" | "workspaceId">, existingId: string | null | undefined, trigger: SmsTrigger, body: string, actor: Actor): Promise<string> {
  if (existingId) {
    const t = await systemDb.smsTemplate.findFirst({ where: { id: existingId, storeId: store.id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (t) {
      if (t.status === "archived") await templateAction(store, t.id, "restore", actor);
      if (t.versions[0]?.body !== body || t.versions[0]?.category !== "transactional") await updateTemplate(store, t.id, { name: t.name, category: "transactional", body, countries: t.countries }, actor);
      return t.id;
    }
  }
  const label = setupAutomation(trigger)!.label;
  for (const name of [label, `${label} (SMS setup)`, `${label} (SMS setup ${Date.now().toString(36)})`]) {
    try {
      return (await createTemplate(store, { name, category: "transactional", body }, actor)).template.id;
    } catch (e) {
      if (e instanceof SmsError && e.code === "template_exists") continue;
      throw e;
    }
  }
  throw new SmsError("Couldn't name the template: rename one of your templates and try again.", 409, "template_exists");
}

/** A message the setup is about to save: an order update (no marketing variables), that its event can fill. */
function checkSetupMessage(body: string, trigger: SmsTrigger) {
  const issues = checkTemplate({ category: "transactional", body });
  const error = issues.find((i) => i.level === "error");
  if (error) throw new SmsError(error.message, 400, "template_invalid", { issues });
  const missing = missingForTrigger(body, trigger);
  if (missing.length) throw new SmsError(`"${setupAutomation(trigger)!.label}" texts can't fill ${missing.map((m) => `{{${m}}}`).join(", ")}: take ${missing.length === 1 ? "it" : "them"} out.`, 400, "template_invalid", { issues });
  return issues;
}

/** Step 3: the order confirmation, saved as its template (a draft: it is approved when the merchant turns it on in step 5). */
export async function saveSetupMessage(store: Pick<Store, "id" | "workspaceId">, body: string, actor: Actor) {
  const issues = checkSetupMessage(body, "order_created");
  const row = await setupRow(store);
  const map = automationsOf(row);
  const templateId = await upsertSetupTemplate(store, map.order_created?.templateId ?? row.templateId, "order_created", body, actor);
  map.order_created = { ...map.order_created, templateId };
  await systemDb.smsSetup.update({ where: { id: row.id }, data: { message: body, templateId, automations: map as object, updatedBy: actor.userId } });
  return { templateId, issues };
}

/** Make the event's rule run the template: created, or edited to it, then approved and running. A rule's own conditions and limits (set on the advanced page) are kept. */
async function startRule(store: Pick<Store, "id" | "workspaceId">, ruleId: string | null | undefined, trigger: SmsTrigger, templateId: string, actor: Actor): Promise<string> {
  const sender = await senderOf(store.id);
  const label = setupAutomation(trigger)!.label;
  // Order updates: right after the event, outside the store's quiet hours, at most 10 a day from one rule (each order once: the dedupe key).
  const fresh = { name: label, trigger, conditions: [], delayMinutes: 0, templateId, quietStart: sender?.quietStart ?? 21, quietEnd: sender?.quietEnd ?? 9, useCustomerTimezone: true, maxPerCustomer: 10, capDays: 1, priority: 50, dryRun: false };
  let rule = ruleId ? await systemDb.smsAutomationRule.findFirst({ where: { id: ruleId, storeId: store.id } }) : null;
  if (!rule) rule = await createRule(store, fresh, actor);
  else {
    const current = parseRule(rule.config);
    const cfg = current ? { ...current, trigger, templateId, dryRun: false } : fresh;
    if (!current || current.templateId !== templateId || current.trigger !== trigger || current.dryRun || rule.status === "disabled") rule = await updateRule(store, rule.id, smsRuleSchema.parse(cfg), actor);
  }
  if (hasUnapprovedVersion(rule)) {
    if (!awaitingApproval(rule)) rule = await ruleAction(store, rule.id, "submit", actor);
    rule = await ruleAction(store, rule.id, "approve", actor);
  }
  if (rule.status === "paused") rule = await ruleAction(store, rule.id, "resume", actor);
  return rule.id;
}

/**
 * Step 5, one order update: save its message, and turn it on (approve the message and the rule,
 * and start it) or off (pause it: its waiting texts are cancelled). Turning one on needs the
 * merchant's confirmation that it may text real customers; saving a new message for one that is
 * on approves the new text at once (an owner or admin pressed Save on a running automation).
 */
export async function setSetupAutomation(store: Pick<Store, "id" | "workspaceId">, trigger: SmsTrigger, input: { body?: string | null; on: boolean; confirm?: boolean }, actor: Actor) {
  const auto = setupAutomation(trigger);
  if (!auto || auto.unavailable) throw new SmsError("This automatic text isn't available.", 400, "automation_unavailable");
  const row = await setupRow(store);
  const map = automationsOf(row);
  const current = map[trigger] ?? {};
  const rule = current.ruleId ? await systemDb.smsAutomationRule.findFirst({ where: { id: current.ruleId, storeId: store.id } }) : null;
  const wasOn = rule?.status === "active";
  if (input.on && !wasOn && !input.confirm) throw new SmsError("Confirm that this automatic text may go to your customers.", 400, "confirm_required");
  let templateId = current.templateId ?? (trigger === "order_created" ? row.templateId : null) ?? null;
  const body = input.body?.trim() ? input.body : templateId ? null : auto.body;
  if (body !== null) {
    checkSetupMessage(body, trigger);
    templateId = await upsertSetupTemplate(store, templateId, trigger, body, actor);
  }
  let ruleId = current.ruleId ?? null;
  if (input.on) {
    await approveLatestVersion(store, templateId!, actor, "Approved in Set up SMS");
    ruleId = await startRule(store, ruleId, trigger, templateId!, actor);
  } else if (rule && rule.status === "active") {
    await ruleAction(store, rule.id, "pause", actor);
  }
  map[trigger] = { templateId, ruleId };
  await systemDb.smsSetup.update({
    where: { id: row.id },
    data: { automations: map as object, ...(trigger === "order_created" && templateId ? { templateId, ...(body !== null ? { message: body } : {}) } : {}), updatedBy: actor.userId },
  });
  if (input.on !== wasOn) await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: input.on ? "setup_automation_on" : "setup_automation_off", targetType: "sms_setup", targetId: row.id, metadata: { trigger, ruleId }, ip: actor.ip });
  return { templateId, ruleId, on: input.on };
}

/**
 * The master switch, "Enable Automatic SMS": the store's sending switch (the same as Sender
 * Configuration's "Send texts"). On needs the connection, an approved sender, a budget above 0
 * and a basis for order updates; off cancels texts waiting to go.
 */
export async function setAutomaticSms(store: Pick<Store, "id" | "workspaceId">, on: boolean, actor: Actor): Promise<SmsSenderConfiguration> {
  const row = await setupRow(store);
  const sender = await senderOf(store.id);
  if (on) {
    if (row.connection !== "connected") throw new SmsError("Connect SMS first (step 1).", 409, "not_connected");
    if (!sender || sender.identityCheck !== "verified") throw new SmsError("Your sender isn't approved yet: automatic texts can start once it is.", 409, "sender_unverified");
    if (sender.transactionalBasis === "none") throw new SmsError("Choose how your customers agreed to get order updates by text first.", 409, "no_basis");
  }
  if (!sender) throw new SmsError("There is no sender to switch off.", 409, "no_sender");
  const s = await setSending(store, { sending: on }, actor);
  if (on && !row.completedAt) {
    const ruleIds = Object.values(automationsOf(row))
      .map((a) => a?.ruleId)
      .filter((x): x is string => !!x);
    if (ruleIds.length && (await systemDb.smsAutomationRule.count({ where: { id: { in: ruleIds }, status: "active" } }))) await systemDb.smsSetup.update({ where: { id: row.id }, data: { completedAt: new Date() } });
  }
  return s;
}

// ---------------------------------------------------------------------------
// What the setup page shows
// ---------------------------------------------------------------------------

/** Statuses of a test text that mean AWS took it (not that the phone has it: "delivered" says that). */
const TEST_TAKEN = ["accepted", "pending", "delivered", "carrier_accepted"];

/** A store's setup before anything was saved (reading the page writes nothing). */
function blankSetup(store: Pick<Store, "id" | "workspaceId">): SmsSetup {
  const now = new Date();
  return {
    id: "",
    workspaceId: store.workspaceId,
    storeId: store.id,
    step: "connect",
    connection: null,
    connectionError: null,
    connectionCheckedAt: null,
    connectedBy: null,
    connectedAt: null,
    businessName: null,
    senderName: null,
    country: null,
    senderNameStatus: "draft",
    senderRequestedAt: null,
    senderRequestedBy: null,
    senderCheckedAt: null,
    senderRegistration: null,
    message: null,
    templateId: null,
    automations: {},
    monthlyBudgetUsd: null,
    transactionalBasis: null,
    completedAt: null,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** The setup as the page draws it: each step's state, read from the rows (never from what the page last said). */
export async function setupState(store: Pick<Store, "id" | "workspaceId" | "name" | "shopDomain" | "currency">) {
  const row = (await systemDb.smsSetup.findUnique({ where: { storeId: store.id } })) ?? blankSetup(store);
  const sender = await senderOf(store.id);
  const map = automationsOf(row);
  const ruleIds = Object.values(map)
    .map((a) => a?.ruleId)
    .filter((x): x is string => !!x);
  const templateIds = [...new Set([...Object.values(map).map((a) => a?.templateId), row.templateId].filter((x): x is string => !!x))];
  const [rules, templates, lastTest] = await Promise.all([
    ruleIds.length ? systemDb.smsAutomationRule.findMany({ where: { id: { in: ruleIds }, storeId: store.id } }) : [],
    templateIds.length ? systemDb.smsTemplate.findMany({ where: { id: { in: templateIds }, storeId: store.id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } }) : [],
    systemDb.smsMessageJob.findFirst({ where: { storeId: store.id, purpose: "test" }, orderBy: { createdAt: "desc" } }),
  ]);
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const automations = SETUP_AUTOMATIONS.map((a) => {
    const m = a.trigger ? map[a.trigger] : undefined;
    const t = m?.templateId ? templateById.get(m.templateId) : undefined;
    const r = m?.ruleId ? ruleById.get(m.ruleId) : undefined;
    return {
      key: a.key,
      trigger: a.trigger,
      label: a.label,
      help: a.help,
      unavailable: a.unavailable ?? null,
      body: t?.versions[0]?.body ?? a.body,
      on: r?.status === "active",
      ruleStatus: r?.status ?? null,
      templateId: t?.id ?? null,
      templateStatus: t?.status ?? null,
    };
  });
  const mainTemplate = row.templateId ? templateById.get(row.templateId) : undefined;
  const country = row.country ?? defaultCountry(store);
  const verified = sender?.identityCheck === "verified";
  return {
    row,
    step: row.step,
    businessName: row.businessName,
    defaultBusinessName: store.name ?? store.shopDomain.replace(/\.myshopify\.com$/, ""),
    connection: {
      status: (row.connection ?? "not_connected") as "not_connected" | "connected" | "failed" | "disconnected",
      error: row.connectionError,
      checkedAt: row.connectionCheckedAt,
      connectedAt: row.connectedAt,
      region: smsRegion(sender),
    },
    senderName: {
      name: row.senderName,
      country,
      countryChosen: !!row.country,
      status: row.senderNameStatus as SenderNameStatus,
      support: senderIdSupport(country),
      requestedAt: row.senderRequestedAt,
      checkedAt: row.senderCheckedAt,
      registration: row.senderRegistration,
      sharedAvailable: !!env().SMS_SHARED_SENDER.trim(),
    },
    sender,
    message: row.message ?? mainTemplate?.versions[0]?.body ?? SETUP_FIRST_MESSAGE,
    templateId: mainTemplate?.id ?? null,
    automations,
    sending: {
      monthlyBudgetUsd: sender ? Number(sender.monthlyBudgetUsd) : row.monthlyBudgetUsd === null ? null : Number(row.monthlyBudgetUsd),
      transactionalBasis: (sender?.transactionalBasis ?? row.transactionalBasis ?? "none") as SmsTransactionalBasis,
      on: !!sender?.sendingEnabled,
    },
    lastTest,
    completedAt: row.completedAt,
    done: {
      connect: row.connection === "connected",
      sender: verified,
      message: !!mainTemplate,
      test: !!lastTest && TEST_TAKEN.includes(lastTest.status),
      automate: !!sender?.sendingEnabled && automations.some((a) => a.on),
    },
  };
}
