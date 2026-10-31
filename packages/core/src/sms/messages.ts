/**
 * The message queue and the sender.
 *
 *  1. Something schedules a text: a row with a dedupe key, so a Shopify retry, a duplicate queue
 *     delivery or two rules firing at once still make one row.
 *  2. A text due within 12 hours goes on the sync queue (`kind: "sms"`); the 15-minute sweep
 *     catches the rest, and anything a lost queue message left behind.
 *  3. Right before sending, everything is checked again: the platform's mode, the sender, the
 *     template's approval, the customer's consent and suppression, the rule or campaign still
 *     on, the checkout not finished, the order not cancelled, quiet hours, frequency caps, the
 *     country, India's DLT template, the budget and the account's limit, the sender's pace.
 *  4. The row is claimed (scheduled → sending) before AWS is called, so two workers can't both
 *     send it. AWS's answer decides what happens next (classifySendError): throttling waits and
 *     tries again; a refusal fails with its reason; an opt-out suppresses the number; a spending
 *     limit or a broken sender holds texts; and when AWS may have taken the text (a 500, a cut
 *     connection, a timeout) it is marked "uncertain" and never sent again on its own.
 *  5. AWS accepting a text is not a delivery: delivery.ts reads what the carrier reported.
 */
import { Prisma, systemDb, type SmsContact, type SmsMessageJob, type SmsTestNumber, type Store } from "@app/db";
import { normalizePhone } from "@app/shared";
import {
  afterQuietHours,
  budgetAllows,
  classifySendError,
  customerTimeZone,
  DLT_MAX_VALUE,
  dltMatches,
  estimateCostUsd,
  mayReceive,
  renderSms,
  retryDelaySeconds,
  SMS_MAX_ATTEMPTS,
  SMS_MAX_BODY,
  SMS_MAX_SEGMENTS,
  SMS_VARIABLE_INFO,
  smsDate,
  templateVariables,
  type SmsCategory,
  type SmsRuleInput,
  type SmsStatus,
  type SmsTrigger,
  type SmsValues,
} from "@app/shared/sms";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { raiseAlert } from "../notify.js";
import {
  configurationSetFor,
  marketingSwitchedOn,
  MAX_QUEUE_DELAY_S,
  monthSpend,
  newOptOutCode,
  optOutUrl,
  partPrice,
  senderOf,
  senderProblem,
  smsDecrypt,
  smsEncrypt,
  SmsError,
  smsMode,
  smsQueue,
  smsRegion,
  storeById,
  transactionalBasisOf,
  type SmsDeps,
} from "./common.js";
import { contactFirstName, contactPhone, suppressNumber } from "./contacts.js";
import { SmsProviderError } from "./provider.js";
import { approvedVersionOf, sendableVersion, type Actor } from "./templates.js";

export type SmsPurpose = "automation" | "campaign" | "test" | "manual";

export interface ScheduleInput {
  store: Pick<Store, "id" | "workspaceId">;
  purpose: SmsPurpose;
  category: SmsCategory;
  dedupeKey: string;
  trigger?: SmsTrigger | null;
  ruleId?: string | null;
  ruleVersion?: number | null;
  campaignId?: string | null;
  templateId: string;
  templateVersion: number;
  contact?: SmsContact | null;
  testNumber?: SmsTestNumber | null;
  values: SmsValues;
  sendAfter: Date;
  /** Record what would be sent, send nothing. */
  dryRun?: boolean;
  /** Record it as not sent, with this reason (no number, no consent…), so the merchant sees why. */
  skip?: string | null;
  subjectKey?: string | null;
  orderId?: string | null;
  checkoutToken?: string | null;
  createdBy?: string | null;
}

/** Schedule a text. Idempotent on (store, dedupe key): a repeat returns the row already there. */
export async function scheduleSms(input: ScheduleInput, deps: Pick<SmsDeps, "queues">, opts: { enqueue?: boolean } = {}): Promise<{ job: SmsMessageJob; created: boolean }> {
  const { store } = input;
  const recipient = input.contact ?? input.testNumber ?? null;
  const now = new Date();
  const status: SmsStatus = input.skip ? "skipped" : input.dryRun ? "dry_run" : "scheduled";
  const values = { ...input.values };
  let bodyEnc: string | null = null;
  if (status === "dry_run") {
    // A dry run keeps what it would have sent (the opt-out link as it would look), so the merchant can read it.
    const v = await systemDb.smsTemplateVersion.findUnique({ where: { templateId_version: { templateId: input.templateId, version: input.templateVersion } } });
    if (v) {
      const r = renderSms(v.body, { ...values, opt_out_url: values.opt_out_url ?? optOutUrl("XXXXXXXXXX") });
      if (r.ok) bodyEnc = smsEncrypt(store.id, "body", r.text);
    }
  }
  try {
    const job = await systemDb.smsMessageJob.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        dedupeKey: input.dedupeKey,
        purpose: input.purpose,
        category: input.category,
        trigger: input.trigger ?? null,
        ruleId: input.ruleId ?? null,
        ruleVersion: input.ruleVersion ?? null,
        campaignId: input.campaignId ?? null,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        contactId: input.contact?.id ?? null,
        testNumberId: input.testNumber?.id ?? null,
        phoneHash: recipient?.phoneHash ?? null,
        phoneMasked: recipient?.phoneMasked ?? null,
        destinationCountry: recipient?.country ?? null,
        valuesEnc: status === "scheduled" ? smsEncrypt(store.id, "values", JSON.stringify(values)) : null,
        bodyEnc,
        status,
        reason: input.skip ?? (status === "dry_run" ? (input.dryRun && smsMode() === "live" ? "rule_dry_run" : "platform_dry_run") : null),
        sendAfter: input.sendAfter,
        dryRun: !!input.dryRun,
        finalAt: status === "scheduled" ? null : now,
        subjectKey: input.subjectKey ?? null,
        orderId: input.orderId ?? null,
        checkoutToken: input.checkoutToken ?? null,
        createdBy: input.createdBy ?? null,
      },
    });
    if (job.status === "scheduled" && opts.enqueue !== false) await enqueueSmsSend(job, deps);
    return { job, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const job = await systemDb.smsMessageJob.findUnique({ where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: input.dedupeKey } } });
      if (job) return { job, created: false };
    }
    throw e;
  }
}

/** Put a scheduled text on the queue if it is due within the queue's longest delay (the sweep takes the rest). */
export async function enqueueSmsSend(job: Pick<SmsMessageJob, "id" | "sendAfter" | "status">, deps: Pick<SmsDeps, "queues">): Promise<boolean> {
  if (job.status !== "scheduled") return false;
  const delay = Math.max(0, Math.ceil((job.sendAfter.getTime() - Date.now()) / 1000));
  if (delay > MAX_QUEUE_DELAY_S) return false;
  await smsQueue(deps.queues).send({ kind: "sms", jobId: job.id }, { delaySeconds: delay });
  await systemDb.smsMessageJob.updateMany({ where: { id: job.id, status: "scheduled" }, data: { enqueuedAt: new Date() } });
  return true;
}

export type SendOutcome = "gone" | "later" | "accepted" | "skipped" | "cancelled" | "dry_run" | "failed" | "opted_out" | "uncertain" | "held" | "retry";

/** End a waiting text without sending it. Only a row still scheduled changes. */
async function finish(job: SmsMessageJob, status: "skipped" | "cancelled" | "opted_out" | "failed", reason: string): Promise<SendOutcome> {
  await systemDb.smsMessageJob.updateMany({ where: { id: job.id, status: "scheduled" }, data: { status, reason, finalAt: new Date(), valuesEnc: null } });
  return status;
}

/** Push a waiting text to later (a hold, quiet hours, a paused campaign): no attempt is spent. */
async function later(job: SmsMessageJob, at: Date, deps: Pick<SmsDeps, "queues">, reason?: string): Promise<SendOutcome> {
  await systemDb.smsMessageJob.updateMany({ where: { id: job.id, status: "scheduled" }, data: { sendAfter: at, enqueuedAt: null, ...(reason ? { reason } : {}) } });
  await enqueueSmsSend({ id: job.id, sendAfter: at, status: "scheduled" }, deps);
  return "later";
}

/** Record what a text would have said, instead of sending it (a rule in dry-run mode, or the platform not live). */
async function recordDryRun(job: SmsMessageJob, text: string | null, reason: string): Promise<SendOutcome> {
  await systemDb.smsMessageJob.updateMany({
    where: { id: job.id, status: "scheduled" },
    data: { status: "dry_run", reason, dryRun: true, finalAt: new Date(), valuesEnc: null, ...(text ? { bodyEnc: smsEncrypt(job.storeId, "body", text) } : {}) },
  });
  return "dry_run";
}

const TTL_S: Record<SmsCategory, number> = { transactional: 24 * 3600, marketing: 4 * 3600 };
/** A text pushed past quiet hours more than this long after it was scheduled is no longer worth sending. */
const STALE_AFTER_MS = 36 * 3600_000;
/** How long the circuit stays open after repeated failures, and how many failures in 5 minutes open it. */
const CIRCUIT_OPEN_S = 600;
const CIRCUIT_FAILURES = 5;
export const ACCOUNT_HOLD_KEY = "sms:hold:account";

async function tripCircuit(region: string, deps: Pick<SmsDeps, "coord">) {
  const n = await deps.coord.hit(`sms:failures:${region}`, 300);
  if (n >= CIRCUIT_FAILURES) {
    await deps.coord.put(`sms:circuit:${region}`, "1", CIRCUIT_OPEN_S);
    logger.error({ region, failures: n }, "sms circuit opened: repeated AWS failures, texts wait 10 minutes");
  }
}

function ruleConfig(raw: unknown): Partial<SmsRuleInput> {
  return raw && typeof raw === "object" ? (raw as Partial<SmsRuleInput>) : {};
}

/** Send one scheduled text, after checking everything again. Safe to call twice: only one call claims it. */
export async function sendSmsJob(jobId: string, deps: SmsDeps): Promise<SendOutcome> {
  const job = await systemDb.smsMessageJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "scheduled") return "gone";
  const now = new Date();
  if (job.sendAfter.getTime() > now.getTime() + 5000) {
    await enqueueSmsSend(job, deps);
    return "later";
  }
  const isTest = job.purpose === "test";
  const store = await storeById(job.storeId);
  if (!store || store.status === "uninstalled") return finish(job, "cancelled", "store_gone");
  const mode = smsMode();
  if (mode === "off") return finish(job, "skipped", "platform_off");
  const sender = await senderOf(store.id);
  const region = smsRegion(sender);

  // --- The sender.
  if (isTest) {
    if (!sender || sender.identityCheck !== "verified") return finish(job, "failed", "sender_not_ready");
  } else {
    const problem = senderProblem(sender, now);
    if (problem === "held") return later(job, sender!.heldUntil!, deps);
    if (problem === "sending_off") return finish(job, "skipped", "sending_disabled");
    if (problem) return finish(job, "skipped", "sender_not_ready");
  }
  if (!sender) return finish(job, "skipped", "sender_not_ready");

  // --- The template version it was scheduled with must have been approved. A test text may try
  // a version still in review: it goes only to the team's own verified number.
  const version = !job.templateId || !job.templateVersion ? null : isTest ? await anyVersion(job.templateId, job.templateVersion) : await sendableVersion(job.templateId, job.templateVersion);
  if (!version) return finish(job, isTest ? "failed" : "skipped", "template_not_approved");
  // The stricter of the job's category and its text's: a marketing text never goes out under an
  // order-update basis, whatever scheduled it.
  const category: SmsCategory = job.category === "marketing" || version.category === "marketing" ? "marketing" : "transactional";

  // --- The recipient.
  let e164: string;
  let contact: SmsContact | null = null;
  if (isTest) {
    const tn = job.testNumberId ? await systemDb.smsTestNumber.findUnique({ where: { id: job.testNumberId } }) : null;
    if (!tn || tn.status !== "verified") return finish(job, "failed", "sandbox_unverified");
    e164 = smsDecrypt(store.id, "test_phone", tn.phoneEnc);
  } else {
    contact = job.contactId ? await systemDb.smsContact.findUnique({ where: { id: job.contactId } }) : null;
    if (!contact) return finish(job, "cancelled", "contact_gone");
    e164 = contactPhone(contact);
  }
  const country = normalizePhone(e164)?.country ?? contact?.country ?? null;
  if (!isTest && (!country || !sender.countries.includes(country))) return finish(job, "skipped", "country_not_enabled");

  // --- Consent and suppression, read again now.
  if (contact) {
    const ok = mayReceive(category, { consent: contact.consentState as never, suppressedAll: contact.suppressedAll, suppressedMarketing: contact.suppressedMarketing }, transactionalBasisOf(sender));
    if (!ok.ok) return finish(job, ok.reason === "suppressed" ? "opted_out" : "skipped", ok.reason);
    if (category === "marketing" && !(marketingSwitchedOn() && sender.marketingEnabled)) return finish(job, "skipped", "marketing_disabled");
  }

  // --- What it is about is still the case.
  let cfg: Partial<SmsRuleInput> = {};
  if (job.ruleId) {
    const rule = await systemDb.smsAutomationRule.findUnique({ where: { id: job.ruleId } });
    if (!rule || rule.status !== "active") return finish(job, "cancelled", "rule_inactive");
    cfg = ruleConfig(rule.activeConfig);
  }
  if (job.campaignId) {
    const c = await systemDb.smsCampaign.findUnique({ where: { id: job.campaignId } });
    if (!c || c.status === "cancelled" || c.status === "completed") return finish(job, "cancelled", "campaign_stopped");
    if (c.status === "paused") return later(job, new Date(now.getTime() + 15 * 60_000), deps);
  }
  if (job.checkoutToken) {
    const ck = await systemDb.smsCheckout.findUnique({ where: { storeId_checkoutToken: { storeId: store.id, checkoutToken: job.checkoutToken } } });
    if (!ck || ck.status !== "open") return finish(job, "cancelled", "checkout_completed");
  }
  if (job.orderId && job.trigger !== "order_cancelled" && job.trigger !== "refund_issued") {
    const o = await systemDb.smsContactOrder.findUnique({ where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: job.orderId } } });
    if (o?.cancelled) return finish(job, "cancelled", "order_cancelled");
  }

  // --- Not in quiet hours (the rule's, else the sender's), in the customer's time where known.
  if (!isTest) {
    const qs = cfg.quietStart ?? sender.quietStart;
    const qe = cfg.quietEnd ?? sender.quietEnd;
    const tz = customerTimeZone(country, store.timezone, cfg.useCustomerTimezone ?? true);
    const at = afterQuietHours(now, tz, qs, qe);
    if (at.getTime() > now.getTime() + 60_000) {
      if (at.getTime() - job.createdAt.getTime() > STALE_AFTER_MS) return finish(job, "skipped", "quiet_hours");
      return later(job, at, deps, "quiet_hours");
    }
  }

  // --- Frequency caps.
  if (contact && job.phoneHash) {
    const dayAgo = new Date(now.getTime() - 86400_000);
    const today = await systemDb.smsMessageJob.count({ where: { storeId: store.id, phoneHash: job.phoneHash, acceptedAt: { gte: dayAgo }, purpose: { not: "test" } } });
    if (today >= sender.maxPerCustomerDay) return finish(job, "skipped", "frequency_cap");
    if (category === "marketing") {
      const week = await systemDb.smsMessageJob.count({ where: { storeId: store.id, phoneHash: job.phoneHash, category: "marketing", acceptedAt: { gte: new Date(now.getTime() - 7 * 86400_000) } } });
      if (week >= sender.maxMarketingPerWeek) return finish(job, "skipped", "frequency_cap");
    }
    if (job.ruleId) {
      const days = cfg.capDays ?? 30;
      const fromRule = await systemDb.smsMessageJob.count({ where: { ruleId: job.ruleId, phoneHash: job.phoneHash, acceptedAt: { gte: new Date(now.getTime() - days * 86400_000) } } });
      if (fromRule >= (cfg.maxPerCustomer ?? 1)) return finish(job, "skipped", "rule_cap");
    }
  }

  // --- The text.
  let values: SmsValues = {};
  if (job.valuesEnc) {
    try {
      values = JSON.parse(smsDecrypt(store.id, "values", job.valuesEnc)) as SmsValues;
    } catch {
      return finish(job, "failed", "values_unreadable");
    }
  }
  values.store_name ??= store.name ?? store.shopDomain.replace(/\.myshopify\.com$/, "");
  if (contact && values.customer_name === undefined) values.customer_name = contactFirstName(contact);
  const uses = templateVariables(version.body).used;
  // The day it goes, where the customer is: quiet hours or a schedule may have moved it.
  if (uses.includes("date")) values.date = smsDate(now, customerTimeZone(country, store.timezone, cfg.useCustomerTimezone ?? true));
  if (uses.includes("business_name") && !values.business_name) values.business_name = (await businessNameOf(store.id)) ?? values.store_name;
  let optOut: { code: string; hash: string } | null = null;
  if (uses.includes("opt_out_url")) {
    optOut = newOptOutCode();
    values.opt_out_url = optOutUrl(optOut.code);
  }
  const rendered = renderSms(version.body, values);
  if (!rendered.ok) return finish(job, "skipped", rendered.missing.length ? "missing_variable" : "invalid_variable");
  if (Array.from(rendered.text).length > SMS_MAX_BODY || rendered.segments.segments > SMS_MAX_SEGMENTS) return finish(job, "skipped", "too_long");

  // --- India: the text must be the registered DLT template, and DLT's 30-character variables.
  if (country === "IN") {
    if (!sender.dltEntityId || !version.dltTemplateId) return finish(job, "skipped", "dlt_missing");
    if (!dltMatches(version.body, version.dltText)) return finish(job, "skipped", "dlt_mismatch");
    for (const v of uses) if (String(values[v] ?? "").length > DLT_MAX_VALUE && v !== "opt_out_url") return finish(job, "skipped", "dlt_mismatch");
  }

  // --- Dry runs stop here, with the text they would have sent.
  if (job.dryRun) return recordDryRun(job, rendered.text, "rule_dry_run");
  if (!isTest && mode !== "live") return recordDryRun(job, rendered.text, "platform_dry_run");

  // --- What it will cost, and whether the budget and the account's limit allow it.
  const parts = rendered.segments.segments;
  const price = await partPrice(country);
  // Without a known price the most AWS may charge is assumed, so an unknown price can't break a budget.
  const estimate = estimateCostUsd(parts, price?.usd ?? env().SMS_MAX_PRICE_PER_PART_USD) ?? 0;
  if (!isTest) {
    const spend = await monthSpend(store.id);
    if (sender.hardStop && !budgetAllows(spend.totalUsd, estimate, Number(sender.monthlyBudgetUsd))) {
      await raiseAlert({ workspaceId: store.workspaceId, storeId: store.id, severity: "warning", code: "sms_budget_100", message: "SMS budget reached; texts are not sent (hard stop)" }, deps.mailer, deps.fetchImpl).catch((err: unknown) => logger.error({ err }, "sms budget alert failed"));
      return finish(job, "skipped", "budget_reached");
    }
    if (sender.monthlyMessageQuota && spend.messages >= sender.monthlyMessageQuota) return finish(job, "skipped", "budget_reached");
  }
  const platform = await monthSpend(null);
  if (platform.totalUsd + estimate > env().SMS_ACCOUNT_MONTHLY_LIMIT_USD) {
    logger.error({ spentUsd: platform.totalUsd, limitUsd: env().SMS_ACCOUNT_MONTHLY_LIMIT_USD }, "sms platform monthly limit reached: texts are not sent");
    return finish(job, isTest ? "failed" : "skipped", "account_limit");
  }

  // --- The account and the region aren't on hold, and the sender's pace allows another part now.
  if (await deps.coord.peek(ACCOUNT_HOLD_KEY)) return later(job, new Date(now.getTime() + 30 * 60_000), deps, "account_limit");
  if (await deps.coord.peek(`sms:circuit:${region}`)) return later(job, new Date(now.getTime() + CIRCUIT_OPEN_S * 1000), deps);
  const second = Math.floor(now.getTime() / 1000);
  const perSecond = Math.max(1, Math.floor(env().SMS_PARTS_PER_SECOND / parts));
  const used = await deps.coord.hit(`sms:pace:${sender.originationIdentity}:${second}`, 2);
  if (used > perSecond) return later(job, new Date(now.getTime() + 1000 + Math.floor(Math.random() * 2000)), deps);

  // --- Claim it, then send.
  const bodyEnc = smsEncrypt(store.id, "body", rendered.text);
  const claimed = await systemDb.smsMessageJob.updateMany({
    where: { id: job.id, status: "scheduled" },
    data: {
      status: "sending",
      claimedAt: now,
      attempts: { increment: 1 },
      bodyEnc,
      encoding: rendered.segments.encoding,
      segments: parts,
      estimatedCostUsd: estimate,
      awsRegion: region,
      originationIdentity: sender.originationIdentity,
      destinationCountry: country,
      optOutCodeHash: optOut?.hash ?? null,
    },
  });
  if (claimed.count === 0) return "gone";
  const attempts = job.attempts + 1;
  const maxPrice = Math.min(99.99999, env().SMS_MAX_PRICE_PER_PART_USD * parts).toFixed(5);
  try {
    const res = await deps.sms.send({
      region,
      destination: e164,
      body: rendered.text,
      originationIdentity: sender.originationIdentity,
      messageType: category === "marketing" ? "PROMOTIONAL" : "TRANSACTIONAL",
      configurationSet: sender.configurationSet ?? configurationSetFor(region),
      maxPrice,
      ttlSeconds: TTL_S[category],
      context: { job: job.id, ws: job.workspaceId },
      dlt: country === "IN" ? { entityId: sender.dltEntityId!, templateId: version.dltTemplateId! } : null,
    });
    // A delivery event may have got here first (it carries the job id): only a row still "sending" moves to accepted.
    await systemDb.smsMessageJob.updateMany({ where: { id: job.id, status: "sending" }, data: { status: "accepted", providerMessageId: res.messageId, acceptedAt: now, valuesEnc: null, errorCode: null } });
    await systemDb.smsMessageJob.updateMany({ where: { id: job.id, providerMessageId: null }, data: { providerMessageId: res.messageId, acceptedAt: now } });
    if (contact) await systemDb.smsContact.update({ where: { id: contact.id }, data: { lastMessageAt: now } });
    return "accepted";
  } catch (err) {
    return handleSendError(job, store, attempts, region, e164, err, deps);
  }
}

async function handleSendError(job: SmsMessageJob, store: Store, attempts: number, region: string, e164: string, err: unknown, deps: SmsDeps): Promise<SendOutcome> {
  const facts = err instanceof SmsProviderError ? { type: err.type, reason: err.reason, status: err.status, notSent: err.notSent } : { type: "unknown", reason: null, status: null, notSent: false };
  const { action, code } = classifySendError(facts);
  const now = new Date();
  // Never the destination or the text: AWS's exception name and reason only.
  logger.warn({ jobId: job.id, storeId: job.storeId, type: facts.type, reason: facts.reason, action, attempts }, "sms send refused");
  const back = (at: Date, extra: Record<string, unknown> = {}) =>
    systemDb.smsMessageJob.updateMany({ where: { id: job.id, status: "sending" }, data: { status: "scheduled", sendAfter: at, claimedAt: null, enqueuedAt: null, errorCode: code, optOutCodeHash: null, ...extra } });
  const end = (status: SmsStatus, reason: string) => systemDb.smsMessageJob.updateMany({ where: { id: job.id, status: "sending" }, data: { status, reason, errorCode: code, finalAt: now, valuesEnc: null } });

  switch (action) {
    case "retry": {
      if (attempts >= SMS_MAX_ATTEMPTS) {
        await end("failed", "too_many_retries");
        return "failed";
      }
      const at = new Date(now.getTime() + retryDelaySeconds(attempts) * 1000);
      await back(at);
      await enqueueSmsSend({ id: job.id, sendAfter: at, status: "scheduled" }, deps);
      return "retry";
    }
    case "fail":
      await end("failed", code);
      if (code === "invalid_number" && job.purpose !== "test") await suppressNumber(store, e164, "all", "invalid_number", { evidence: { jobId: job.id } });
      return "failed";
    case "opt_out":
      await end("opted_out", "aws_opt_out");
      if (job.purpose !== "test") await suppressNumber(store, e164, "all", "aws_opt_out", { evidence: { jobId: job.id, source: "SendTextMessage ConflictException" } });
      return "opted_out";
    case "hold_account": {
      await deps.coord.put(ACCOUNT_HOLD_KEY, "1", 3600);
      await back(new Date(now.getTime() + 3600_000), { attempts: { decrement: 1 } });
      logger.error({ jobId: job.id }, "sms held: AWS's monthly SMS spending limit is reached");
      await raiseAlert({ workspaceId: store.workspaceId, storeId: store.id, severity: "critical", code: "sms_account_limit", message: "AWS refused texts: account monthly spend limit reached" }, deps.mailer, deps.fetchImpl).catch(() => {});
      return "held";
    }
    case "hold_sender": {
      const until = new Date(now.getTime() + 3600_000);
      await systemDb.smsSenderConfiguration.updateMany({ where: { storeId: store.id }, data: { heldUntil: until, heldReason: code, ...(code === "sender_not_found" ? { identityCheck: "not_found" } : {}) } });
      await back(until, { attempts: { decrement: 1 } });
      await tripCircuit(region, deps);
      await raiseAlert({ workspaceId: store.workspaceId, storeId: store.id, severity: "warning", code: "sms_sender_problem", message: `AWS refused the sender (${code})` }, deps.mailer, deps.fetchImpl).catch(() => {});
      return "held";
    }
    case "uncertain":
      await end("uncertain", code);
      await tripCircuit(region, deps);
      return "uncertain";
  }
}

/** Texts stuck in "sending" (the worker was cut off mid-call): AWS may have them, so they become "uncertain", never re-sent. */
export async function settleStuckSends(olderThanMs = 10 * 60_000): Promise<number> {
  const { count } = await systemDb.smsMessageJob.updateMany({
    where: { status: "sending", claimedAt: { lt: new Date(Date.now() - olderThanMs) } },
    data: { status: "uncertain", reason: "cut_off", errorCode: "cut_off", finalAt: new Date(), valuesEnc: null },
  });
  if (count) logger.warn({ count }, "sms sends cut off mid-call marked uncertain");
  return count;
}

// ---------------------------------------------------------------------------
// Test texts and one-off sends from the Send SMS page
// ---------------------------------------------------------------------------

/** What {{business_name}} says for a store: the name given in Set up SMS, or null (then the store's name). */
async function businessNameOf(storeId: string): Promise<string | null> {
  const setup = await systemDb.smsSetup.findUnique({ where: { storeId }, select: { businessName: true } });
  return setup?.businessName?.trim() || null;
}

/** Sample values for a test text: what the preview shows. The store's and business's names are the store's own, filled in when it is sent. */
export function sampleValues(): SmsValues {
  const out: SmsValues = {};
  for (const [k, info] of Object.entries(SMS_VARIABLE_INFO)) if (k !== "opt_out_url" && k !== "store_name" && k !== "business_name") out[k as keyof SmsValues] = info.sample;
  return out;
}

/** How long the same test text to the same number is refused after one went: a double click, or a second press while the first is on its way. */
export const TEST_REPEAT_WAIT_S = 30;

/**
 * Send an approved template (or the latest version, for a test) to one of the team's verified test
 * numbers, now. `requestId` (the browser's, one per press of the button) makes a retried request
 * return the text already sent instead of sending another; the same template to the same number
 * again within TEST_REPEAT_WAIT_S is refused.
 */
export async function sendTestSms(store: Store, templateId: string, testNumberId: string, deps: SmsDeps, actor: Actor, requestId?: string | null): Promise<SmsMessageJob> {
  if (smsMode() === "off") throw new SmsError("SMS isn't switched on for bizinsights yet.", 409, "platform_off");
  const dedupeKey = requestId ? `test:req:${requestId}` : `test:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  if (requestId) {
    const already = await systemDb.smsMessageJob.findUnique({ where: { storeId_dedupeKey: { storeId: store.id, dedupeKey } } });
    if (already) return already;
  }
  const tn = await systemDb.smsTestNumber.findFirst({ where: { id: testNumberId, storeId: store.id } });
  if (!tn) throw new SmsError("Test number not found.", 404, "not_found");
  if (tn.status !== "verified") throw new SmsError("Verify this number with the code AWS texted it first.", 409, "test_number_unverified");
  const t = await systemDb.smsTemplate.findFirst({ where: { id: templateId, storeId: store.id } });
  if (!t) throw new SmsError("Template not found.", 404, "not_found");
  // A test may try the latest version, approved or not: that is what reviewing it needs. It goes only to the team's own number.
  const v = await systemDb.smsTemplateVersion.findUnique({ where: { templateId_version: { templateId, version: t.latestVersion } } });
  if (!v) throw new SmsError("Template not found.", 404, "not_found");
  const sender = await senderOf(store.id);
  if (!sender || sender.identityCheck !== "verified") throw new SmsError("Verify the sender with AWS first (Sender configuration).", 409, "sender_unverified");
  if ((await deps.coord.hit(`sms:test-repeat:${tn.id}:${templateId}`, TEST_REPEAT_WAIT_S)) > 1) {
    throw new SmsError(`A test text just went to this number. Wait ${TEST_REPEAT_WAIT_S} seconds and check your phone before sending another.`, 429, "test_repeat");
  }
  const { job } = await scheduleSms(
    {
      store,
      purpose: "test",
      category: v.category as SmsCategory,
      dedupeKey,
      templateId,
      templateVersion: v.version,
      testNumber: tn,
      values: sampleValues(),
      sendAfter: new Date(),
      createdBy: actor.userId,
    },
    deps,
    { enqueue: false },
  );
  await sendSmsJob(job.id, deps);
  return systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } });
}

const anyVersion = async (templateId: string, version: number) => systemDb.smsTemplateVersion.findUnique({ where: { templateId_version: { templateId, version } }, include: { template: true } });

/**
 * One approved template to one customer, now. Every consent and budget check applies, as for a
 * rule. `requestId` (one per press of the button) makes a retried request return the text already
 * sent instead of sending another.
 */
export async function sendManualSms(store: Store, templateId: string, contactId: string, values: SmsValues, deps: SmsDeps, actor: Actor, requestId?: string | null): Promise<SmsMessageJob> {
  const dedupeKey = requestId ? `manual:req:${requestId}` : `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  if (requestId) {
    const already = await systemDb.smsMessageJob.findUnique({ where: { storeId_dedupeKey: { storeId: store.id, dedupeKey } } });
    if (already) return already;
  }
  const contact = await systemDb.smsContact.findFirst({ where: { id: contactId, storeId: store.id } });
  if (!contact) throw new SmsError("Customer not found.", 404, "not_found");
  const v = await approvedVersionOf(store.id, templateId);
  if (!v) throw new SmsError("Choose an approved template: only approved templates go to customers.", 409, "template_not_approved");
  const { job } = await scheduleSms(
    {
      store,
      purpose: "manual",
      // The approved version's category: that is the text that goes, so its consent rule applies.
      category: v.category as SmsCategory,
      dedupeKey,
      templateId,
      templateVersion: v.version,
      contact,
      values,
      sendAfter: new Date(),
      dryRun: smsMode() !== "live",
      createdBy: actor.userId,
    },
    deps,
    { enqueue: false },
  );
  if (job.status === "scheduled") await sendSmsJob(job.id, deps);
  return systemDb.smsMessageJob.findUniqueOrThrow({ where: { id: job.id } });
}
