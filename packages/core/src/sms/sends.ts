/**
 * Send SMS: one message to customers the merchant chooses, now or at a time they pick.
 *
 * A send is a batch of ordinary messages, one sms_message_jobs row per customer (purpose
 * "manual", dedupe key `send:<sendId>:<contactId>`, subject `send:<sendId>`), so the queue, the
 * checks right before each text goes, the provider's answer, delivery events and Message History
 * are the automations' own. What a send adds:
 *
 *  - the browser names it (`requestId`, one per press of Send): the same request again returns
 *    the send already made, so a retry or a double press can't text anyone twice;
 *  - who can get it is worked out first, customer by customer, with the reason in words for
 *    those who can't (consent, an opt-out, the country, marketing switched off, no first name for
 *    a message that uses it). They are recorded as not sent, so Message History says why;
 *  - a message written on the page is saved as a template and approved in the sender's name, as
 *    the automation builder does when one is switched on;
 *  - on a live platform nothing is accepted while the store's setup would stop every text, nor
 *    while the SMS account is still in its provider's sandbox (only verified numbers receive
 *    texts there), nor beyond what is left of the month's limit;
 *  - texts are spread to the sender's pace, a scheduled send waits for its time (in the queue, or
 *    for the sweep beyond the queue's 12 hours), and Cancel stops every text that hasn't gone.
 */
import { systemDb, type SmsContact, type SmsSenderConfiguration, type Store } from "@app/db";
import {
  afterQuietHours,
  budgetAllows,
  checkTemplate,
  CONSENT_LABEL,
  customerTimeZone,
  estimateCostUsd,
  hasErrors,
  mayReceive,
  previewSms,
  renderSms,
  SEND_VALUES_MANY,
  SEND_VALUES_ONE,
  sendValueProblems,
  skipLabel,
  SMS_SEND_MAX_AHEAD_DAYS,
  SMS_STAGE_LABEL,
  SMS_VARIABLE_INFO,
  smsDate,
  smsSegments,
  smsSendPreviewSchema,
  smsSendSchema,
  smsStage,
  templateVariables,
  worstCaseSegments,
  type ConsentState,
  type SmsCategory,
  type SmsSendInput,
  type SmsStage,
  type SmsValues,
  type SmsVariable,
  type TemplateIssue,
} from "@app/shared/sms";
import { env } from "../env.js";
import { sendingProblems, setupBlockers } from "./builder.js";
import { marketingSwitchedOn, monthSpend, optOutUrl, partPrice, senderOf, smsAudit, SmsError, smsMode, smsRegion, transactionalBasisOf, type SmsDeps } from "./common.js";
import { contactFirstName } from "./contacts.js";
import { scheduleSms } from "./messages.js";
import { accountStatus } from "./readiness.js";
import { approvedVersionOf, approveLatestVersion, createTemplate, type Actor } from "./templates.js";

const subjectOf = (sendId: string) => `send:${sendId}`;

type SendStore = Pick<Store, "id" | "workspaceId" | "name" | "shopDomain" | "timezone">;

interface MessageChoice {
  category: SmsCategory;
  body: string;
  templateId: string | null;
  templateName: string;
  version: number | null;
  dltTemplateId: string | null;
}

/** The message a send is for: a saved message's approved version, or the one written on the page. */
async function messageOf(store: Pick<Store, "id">, input: { templateId?: string | null; message?: { name: string; category: SmsCategory; body: string } | null }): Promise<MessageChoice> {
  if (input.templateId) {
    const v = await approvedVersionOf(store.id, input.templateId);
    if (!v) throw new SmsError("Choose an approved message: only approved messages go to customers.", 409, "template_not_approved");
    return { category: v.category as SmsCategory, body: v.body, templateId: v.templateId, templateName: v.template.name, version: v.version, dltTemplateId: v.dltTemplateId };
  }
  const m = input.message!;
  return { category: m.category, body: m.body, templateId: null, templateName: m.name, version: null, dltTemplateId: null };
}

/**
 * Why a customer can't get this message now, or null when they can (it is all checked again
 * right before each text goes). The reasons are the send path's, in SKIP_LABEL.
 */
export function sendBlocker(c: SmsContact, category: SmsCategory, sender: SmsSenderConfiguration | null, uses: readonly SmsVariable[], dltTemplateId: string | null = null): string | null {
  const ok = mayReceive(category, { consent: c.consentState as ConsentState, suppressedAll: c.suppressedAll, suppressedMarketing: c.suppressedMarketing }, transactionalBasisOf(sender));
  if (!ok.ok) return ok.reason;
  if (!c.country) return "country_unknown";
  if (!sender || !sender.countries.includes(c.country)) return "country_not_enabled";
  if (category === "marketing" && !(marketingSwitchedOn() && sender.marketingEnabled)) return "marketing_disabled";
  if (c.country === "IN" && !(sender.dltEntityId && dltTemplateId)) return "dlt_missing";
  if (uses.includes("customer_name") && !contactFirstName(c)) return "no_first_name";
  return null;
}

export interface SendBlocker {
  code: string;
  message: string;
  fix: { label: string; href: string } | null;
}

/** What stops this store's texts of `category` from reaching anyone now: the platform, its setup, the SMS account. */
async function sendBlockers(store: SendStore, category: SmsCategory, sender: SmsSenderConfiguration | null, deps: Pick<SmsDeps, "coord" | "sms">): Promise<SendBlocker[]> {
  const mode = smsMode();
  if (mode === "off") return [{ code: "platform_off", message: "SMS isn't available for your account yet, so nothing can be sent.", fix: null }];
  const problems = await sendingProblems(store);
  const out: SendBlocker[] = setupBlockers(problems, category).map((p) => ({ code: p.code, message: p.message, fix: p.fix }));
  if (category === "marketing" && !marketingSwitchedOn()) out.push({ code: "marketing_platform_off", message: "Marketing texts aren't available for your account yet.", fix: null });
  if (mode === "live") {
    const account = await accountStatus(smsRegion(sender), deps);
    if (account.reachable && account.sandbox) {
      out.push({
        code: "account_sandbox",
        message: "Your SMS account is still being verified. Until it is, texts only reach your approved test recipients: send yourself a test instead.",
        fix: { label: "View setup requirements", href: "/messaging/settings" },
      });
    }
  }
  return out;
}

const valuesTyped = (recipients: number) => (recipients > 1 ? SEND_VALUES_MANY : SEND_VALUES_ONE) as readonly SmsVariable[];

/** The details the merchant typed that this send uses, trimmed. */
function typedValues(body: string, recipients: number, values: SmsValues): SmsValues {
  const used = templateVariables(body).used;
  const out: SmsValues = {};
  for (const v of valuesTyped(recipients)) {
    const raw = String(values[v] ?? "").trim();
    if (used.includes(v) && raw) out[v] = raw;
  }
  return out;
}

async function businessName(store: SendStore): Promise<string> {
  const setup = await systemDb.smsSetup.findUnique({ where: { storeId: store.id }, select: { businessName: true } });
  return setup?.businessName?.trim() || store.name || store.shopDomain.replace(/\.myshopify\.com$/, "");
}

const messageIssues = (msg: MessageChoice, recipients: number, values: SmsValues): TemplateIssue[] => [
  ...checkTemplate({ category: msg.category, body: msg.body, dltTemplateId: msg.dltTemplateId }),
  ...sendValueProblems(msg.body, recipients, values),
];

// ---------------------------------------------------------------------------
// Choosing customers and reviewing the message
// ---------------------------------------------------------------------------

/**
 * Customers for the Send SMS page's list (masked numbers, first names), each with whether they
 * can get a message of `category` now. Names are encrypted, so the most recent customers are read
 * and matched here, as the automation builder's chooser does.
 */
export async function sendCustomers(store: Pick<Store, "id">, o: { q?: string; ids?: string[]; category?: SmsCategory }) {
  const q = (o.q ?? "").trim().toLowerCase().slice(0, 40);
  const ids = (o.ids ?? []).slice(0, 200);
  const digits = q.replace(/\D/g, "");
  const category = o.category ?? "transactional";
  const sender = await senderOf(store.id);
  const rows = await systemDb.smsContact.findMany({
    where: { storeId: store.id, ...(ids.length ? { id: { in: ids } } : digits.length >= 2 && digits.length === q.length ? { phoneMasked: { endsWith: digits.slice(-3) } } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: ids.length ? ids.length : 1000,
  });
  const found = rows
    .map((r) => {
      const why = sendBlocker(r, category, sender, []);
      return {
        id: r.id,
        name: contactFirstName(r),
        number: r.phoneMasked,
        country: r.country,
        consent: r.consentState,
        consentLabel: CONSENT_LABEL[r.consentState as ConsentState] ?? r.consentState,
        orders: r.ordersCount,
        canReceive: !why,
        reason: why,
        reasonLabel: skipLabel(why),
      };
    })
    .filter((r) => ids.length || !q || digits.length === q.length || (r.name ?? "").toLowerCase().startsWith(q));
  return { category, customers: found.slice(0, ids.length ? 200 : 50), more: found.length > 50 && !ids.length };
}

/**
 * The review before Send: the text as the first customer who can get it will read it (their first
 * name, the date where they are), its length and parts, who won't get it and why, what it may
 * cost, how many fall in quiet hours at that time, and what stops the send altogether.
 */
export async function previewSend(store: SendStore, raw: unknown, deps: Pick<SmsDeps, "coord" | "sms">) {
  const input = smsSendPreviewSchema.parse(raw);
  const msg = await messageOf(store, input);
  const sender = await senderOf(store.id);
  const ids = [...new Set(input.contactIds)];
  const contacts = ids.length ? await systemDb.smsContact.findMany({ where: { storeId: store.id, id: { in: ids } } }) : [];
  const uses = templateVariables(msg.body).used;
  const recipients = ids
    .map((id) => contacts.find((c) => c.id === id))
    .filter((c): c is SmsContact => !!c)
    .map((c) => {
      const why = sendBlocker(c, msg.category, sender, uses, msg.dltTemplateId);
      return { contact: c, why };
    });
  const going = recipients.filter((r) => !r.why);
  const now = new Date();
  const at = input.scheduledAt && input.scheduledAt > now ? input.scheduledAt : now;
  const first = going[0]?.contact ?? null;
  const tz = customerTimeZone(first?.country ?? null, store.timezone);
  const values: SmsValues = {
    ...typedValues(msg.body, Math.max(1, ids.length), input.values),
    store_name: store.name ?? store.shopDomain.replace(/\.myshopify\.com$/, ""),
    business_name: await businessName(store),
    date: smsDate(at, tz),
    customer_name: first ? (contactFirstName(first) ?? undefined) : SMS_VARIABLE_INFO.customer_name.sample,
    opt_out_url: optOutUrl("XXXXXXXXXX"),
  };
  const rendered = renderSms(msg.body, values);
  const text = rendered.ok ? rendered.text : previewSms(msg.body, values);
  const segments = smsSegments(text);
  const issues = messageIssues(msg, Math.max(1, ids.length), input.values);

  // Cost: each country's price per part (what AWS billed this account lately, else the price list).
  let estimatedUsd = 0;
  let unpriced = 0;
  const prices = new Map<string, number | null>();
  for (const r of going) {
    const country = r.contact.country!;
    if (!prices.has(country)) prices.set(country, (await partPrice(country))?.usd ?? null);
    const one = estimateCostUsd(segments.segments, prices.get(country));
    if (one === null) unpriced++;
    else estimatedUsd += one;
  }

  // Quiet hours at that time, in each customer's zone (their texts wait until the morning).
  let quiet = 0;
  if (sender) {
    for (const r of going) {
      const zone = customerTimeZone(r.contact.country, store.timezone);
      if (afterQuietHours(at, zone, sender.quietStart, sender.quietEnd).getTime() > at.getTime() + 60_000) quiet++;
    }
  }

  const reasons = new Map<string, number>();
  for (const r of recipients) if (r.why) reasons.set(r.why, (reasons.get(r.why) ?? 0) + 1);
  const spend = sender ? await monthSpend(store.id) : null;
  return {
    mode: smsMode(),
    category: msg.category,
    templateName: msg.templateName,
    text,
    characters: Array.from(text).length,
    segments,
    worst: worstCaseSegments(msg.body),
    issues,
    blockers: await sendBlockers(store, msg.category, sender, deps),
    scheduledAt: at,
    recipients: {
      chosen: ids.length,
      notFound: ids.length - recipients.length,
      sending: going.length,
      quietHours: quiet,
      notSending: [...reasons].map(([reason, count]) => ({ reason, label: skipLabel(reason), count })),
      list: recipients.map((r) => ({ id: r.contact.id, name: contactFirstName(r.contact), number: r.contact.phoneMasked, country: r.contact.country, canReceive: !r.why, reason: r.why, reasonLabel: skipLabel(r.why) })),
    },
    cost: { estimatedUsd: Math.round(estimatedUsd * 1e6) / 1e6, unpricedRecipients: unpriced },
    limit: sender && spend ? { monthlyUsd: Number(sender.monthlyBudgetUsd), usedUsd: Math.round(spend.totalUsd * 100) / 100, hardStop: sender.hardStop } : null,
  };
}

// ---------------------------------------------------------------------------
// Sending, following and cancelling
// ---------------------------------------------------------------------------

/** How long a send being made keeps a second request with its id out (a double press while the first is still working). */
const MAKING_MS = 120_000;

/** Make a send: check it all, record one message per chosen customer, queue the ones that may go. Idempotent on `requestId`. */
export async function createSend(store: SendStore, raw: unknown, deps: SmsDeps, actor: Actor) {
  const input = smsSendSchema.parse(raw);
  const sendId = input.requestId;
  const subject = subjectOf(sendId);
  if (await systemDb.smsMessageJob.count({ where: { storeId: store.id, subjectKey: subject } })) return sendSummary(store, sendId);
  const lock = `sms:send:${store.id}:${sendId}`;
  if (!(await deps.coord.acquire(lock, MAKING_MS))) throw new SmsError("This send is already being made: its texts show here in a moment.", 409, "send_in_progress");
  try {
    return await makeSend(store, input, deps, actor);
  } finally {
    await deps.coord.release(lock);
  }
}

async function makeSend(store: SendStore, input: SmsSendInput, deps: SmsDeps, actor: Actor) {
  const sendId = input.requestId;
  const subject = subjectOf(sendId);
  // A request that waited on the lock behind its twin finds the send made.
  if (await systemDb.smsMessageJob.count({ where: { storeId: store.id, subjectKey: subject } })) return sendSummary(store, sendId);
  const now = new Date();
  const at = input.scheduledAt && input.scheduledAt.getTime() > now.getTime() ? input.scheduledAt : now;
  if (at.getTime() > now.getTime() + SMS_SEND_MAX_AHEAD_DAYS * 86400_000) throw new SmsError(`A send can be scheduled at most ${SMS_SEND_MAX_AHEAD_DAYS} days ahead.`, 400, "too_far_ahead");
  const ids = [...new Set(input.contactIds)];
  const msg = await messageOf(store, input);
  const issues = messageIssues(msg, ids.length, input.values);
  if (hasErrors(issues)) throw new SmsError(issues.find((i) => i.level === "error")!.message, 400, "message_invalid", { issues });

  const sender = await senderOf(store.id);
  const stop = await sendBlockers(store, msg.category, sender, deps);
  if (stop.length) {
    const own = new Set(["platform_off", "marketing_platform_off", "account_sandbox"]);
    throw new SmsError(stop[0]!.message, 409, own.has(stop[0]!.code) ? stop[0]!.code : "setup_incomplete", { blockers: stop });
  }

  const contacts = await systemDb.smsContact.findMany({ where: { storeId: store.id, id: { in: ids } } });
  if (contacts.length !== ids.length) throw new SmsError("Some of the chosen customers aren't here any more: choose them again.", 404, "not_found");
  const uses = templateVariables(msg.body).used;
  const plan = ids.map((id) => {
    const c = contacts.find((x) => x.id === id)!;
    return { contact: c, why: sendBlocker(c, msg.category, sender, uses, msg.dltTemplateId) };
  });
  const going = plan.filter((p) => !p.why);
  if (!going.length) {
    const why = plan[0]!.why;
    throw new SmsError(`None of the chosen customers can get this message. ${plan.length === 1 ? skipLabel(why) : `For example: ${skipLabel(why)?.toLowerCase()}`}.`, 409, "no_recipients", { reasons: plan.map((p) => p.why) });
  }

  // The most it can cost (the longest each text can be, at each country's price, or the most AWS
  // may charge where no price is known) against what's left of the month: a hard stop refuses it.
  const parts = Math.max(1, worstCaseSegments(msg.body).segments);
  if (smsMode() === "live" && sender!.hardStop) {
    let worst = 0;
    for (const p of going) worst += estimateCostUsd(parts, (await partPrice(p.contact.country))?.usd ?? env().SMS_MAX_PRICE_PER_PART_USD) ?? 0;
    const spend = await monthSpend(store.id);
    if (!budgetAllows(spend.totalUsd, worst, Number(sender!.monthlyBudgetUsd))) {
      const left = Math.max(0, Number(sender!.monthlyBudgetUsd) - spend.totalUsd);
      throw new SmsError(`These texts could cost up to US$${worst.toFixed(2)}, more than is left of this month's messaging limit (US$${left.toFixed(2)}).`, 409, "over_budget");
    }
  }

  // A message written here becomes a template, approved in the sender's name: only after every check passed, so a refused send leaves nothing behind.
  let templateId = msg.templateId;
  let version = msg.version;
  if (!templateId) {
    const { template } = await createTemplate(store, { name: msg.templateName, category: msg.category, body: msg.body }, actor);
    await approveLatestVersion(store, template.id, actor, "Approved by its author when sending it from Send SMS");
    const v = await approvedVersionOf(store.id, template.id);
    if (!v) throw new SmsError("The message couldn't be approved.", 409, "template_not_approved");
    templateId = v.templateId;
    version = v.version;
  }

  const values = typedValues(msg.body, ids.length, input.values);
  const spacingMs = Math.ceil((1000 * parts) / Math.max(1, env().SMS_PARTS_PER_SECOND));
  const dryRun = smsMode() !== "live";
  let i = 0;
  for (const p of plan) {
    await scheduleSms(
      {
        store,
        purpose: "manual",
        category: msg.category,
        dedupeKey: `${subject}:${p.contact.id}`,
        templateId: templateId!,
        templateVersion: version!,
        contact: p.contact,
        values,
        sendAfter: p.why ? at : new Date(at.getTime() + i++ * spacingMs),
        dryRun,
        skip: p.why,
        subjectKey: subject,
        createdBy: actor.userId,
      },
      deps,
    );
  }
  await smsAudit({
    workspaceId: store.workspaceId,
    storeId: store.id,
    actorUserId: actor.userId,
    action: at > now ? "send_scheduled" : "send_created",
    targetType: "sms_send",
    targetId: sendId,
    metadata: { templateId, version, category: msg.category, recipients: plan.length, going: going.length, notSending: plan.length - going.length, scheduledAt: at.toISOString() },
    ip: actor.ip,
  });
  return sendSummary(store, sendId);
}

/** A send as its page follows it: how many texts are at each stage, and each customer's. */
export async function sendSummary(store: Pick<Store, "id">, sendId: string, o: { messages?: boolean } = {}) {
  const jobs = await systemDb.smsMessageJob.findMany({
    where: { storeId: store.id, subjectKey: subjectOf(sendId) },
    select: { id: true, status: true, reason: true, errorCode: true, providerStatus: true, sendAfter: true, createdAt: true, createdBy: true, templateId: true, category: true, phoneMasked: true, destinationCountry: true, dryRun: true },
    orderBy: [{ sendAfter: "asc" }, { id: "asc" }],
  });
  if (!jobs.length) throw new SmsError("Send not found.", 404, "not_found");
  const counts = Object.fromEntries(Object.keys(SMS_STAGE_LABEL).map((k) => [k, 0])) as Record<SmsStage, number>;
  for (const j of jobs) counts[smsStage(j)]++;
  const template = jobs[0]!.templateId ? await systemDb.smsTemplate.findUnique({ where: { id: jobs[0]!.templateId }, select: { name: true } }) : null;
  const waiting = counts.queued + counts.sending;
  return {
    id: sendId,
    templateId: jobs[0]!.templateId,
    templateName: template?.name ?? null,
    category: jobs[0]!.category,
    createdAt: jobs.reduce((a, j) => (j.createdAt < a ? j.createdAt : a), jobs[0]!.createdAt),
    createdBy: jobs[0]!.createdBy,
    scheduledAt: jobs[0]!.sendAfter,
    recipients: jobs.length,
    counts,
    waiting,
    done: waiting === 0,
    practice: jobs.some((j) => j.dryRun),
    messages:
      o.messages === false
        ? []
        : jobs.map((j) => {
            const stage = smsStage(j);
            return { id: j.id, to: j.phoneMasked, country: j.destinationCountry, stage, stageLabel: SMS_STAGE_LABEL[stage], reasonLabel: skipLabel(j.reason), sendAfter: j.sendAfter };
          }),
  };
}

/** The store's sends of the last 60 days, newest first. */
export async function listSends(store: Pick<Store, "id">) {
  const groups = await systemDb.smsMessageJob.groupBy({
    by: ["subjectKey"],
    where: { storeId: store.id, purpose: "manual", subjectKey: { startsWith: "send:" }, createdAt: { gte: new Date(Date.now() - 60 * 86400_000) } },
    _min: { createdAt: true },
    orderBy: { _min: { createdAt: "desc" } },
    take: 20,
  });
  return Promise.all(groups.map((g) => sendSummary(store, g.subjectKey!.slice("send:".length), { messages: false })));
}

/** Stop every text of a send that hasn't gone (one being handed to the provider at that moment still goes). */
export async function cancelSend(store: Pick<Store, "id" | "workspaceId">, sendId: string, actor: Actor) {
  await sendSummary(store, sendId, { messages: false });
  const { count } = await systemDb.smsMessageJob.updateMany({
    where: { storeId: store.id, subjectKey: subjectOf(sendId), status: "scheduled" },
    data: { status: "cancelled", reason: "send_cancelled", finalAt: new Date(), valuesEnc: null },
  });
  if (!count) throw new SmsError("Nothing is left to cancel: every text of this send has gone.", 409, "nothing_to_cancel");
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "send_cancelled", targetType: "sms_send", targetId: sendId, metadata: { cancelled: count }, ip: actor.ip });
  return sendSummary(store, sendId);
}
