/**
 * The message queue and the sender.
 *
 *  1. Something queues a message (a workflow, a campaign, a person, a test): a row with an
 *     idempotency key, so a Shopify retry, a duplicate queue delivery or a double click still make
 *     one row.
 *  2. A message due within 12 hours goes on the sync queue (`kind: "whatsapp"`); the 15-minute sweep
 *     catches the rest, and anything a lost queue message left behind.
 *  3. Right before sending, everything is checked again: the connection, the customer's consent
 *     (by the category Meta gave the template), the 24-hour window for free-form replies, the
 *     template still approved, the workflow still on, the campaign not cancelled, sending hours, the
 *     store's daily limit and the number's pace.
 *  4. The row is claimed (queued → sending) before Meta is called, so two workers can't both send
 *     it. Meta's answer decides what happens next: accepted (its message id stored), retried later
 *     (rate limits, Meta busy), held (access ended: reconnect), or failed with its reason. A send
 *     with no answer at all may have reached Meta, so it is never repeated on its own: it is marked
 *     failed as "uncertain" and the merchant may retry it.
 *  5. "Accepted" is not "delivered": Meta's status webhooks (webhook.ts) move it on.
 *
 * Two brakes on top: a store that paused all automation holds its workflows' and campaigns'
 * messages (released on resume, cancelled after 48 hours), and a number Meta throttles or can't
 * serve trips a circuit breaker, so its other waiting messages wait it out instead of each being
 * refused in turn (30 s, doubling to 10 minutes while Meta keeps refusing; no attempt is spent).
 */
import { Prisma, systemDb, type Store, type WaConnection, type WaContact, type WaMessage } from "@app/db";
import {
  buildSendComponents,
  consentProblem,
  inSendWindow,
  maskPhone,
  metaErrorExplanation,
  MissingValueError,
  nextSendTime,
  templateShape,
  tierLimit,
  WA_MAX_ATTEMPTS,
  WA_RETRY_DELAYS_S,
  type SendValues,
  type SkipReason,
  type TemplateComponent,
  type TemplateMapping,
} from "@app/shared";
import { logger } from "../logger.js";
import { WA_MAX_QUEUE_DELAY_S, settingsOf, waDecrypt, waEncrypt, waPhoneHash, waQueue, WhatsappError, type WaDeps } from "./common.js";
import { consentFacts, setConsent } from "./contacts.js";
import { sendMessage, WhatsappApiError } from "./graph.js";
import { NangoTokenGoneError, NangoUnavailableError, waTokenFor } from "./nango.js";
import { markAccountProblem, markReconnect, markWorking } from "./tokens.js";

export type MessageSource = "workflow" | "campaign" | "manual" | "test" | "team_alert";

/** What a send needs besides the recipient and the template's name: kept encrypted until it is final. */
export type SendPayload =
  | { kind: "template"; mapping: TemplateMapping; values: SendValues; headerMediaUrl?: string | null }
  | { kind: "text"; body: string; previewUrl?: boolean }
  | { kind: "media"; mediaType: "image" | "document" | "video"; link: string; caption?: string | null; filename?: string | null };

export interface QueueInput {
  store: Pick<Store, "id" | "workspaceId">;
  connectionId: string | null;
  contact?: WaContact | null;
  /** A number without a contact (E.164): the store's own test phone or its team. No consent record applies. */
  to?: string | null;
  source: MessageSource;
  idempotencyKey: string;
  workflowId?: string | null;
  workflowRunId?: string | null;
  campaignId?: string | null;
  template?: { name: string; language: string; category: string } | null;
  payload: SendPayload;
  /** What the customer will read, for the history (encrypted). */
  preview: string;
  sendAfter?: Date;
  createdByUserId?: string | null;
  /** Record it as not sent, with this reason, so the merchant sees why. */
  skip?: SkipReason | null;
}

const digits = (e164: string) => e164.replace(/\D/g, "");

/** Queue a message. Idempotent on (store, key): a repeat returns the row already there. */
export async function queueMessage(input: QueueInput, deps: Pick<WaDeps, "queues">, opts: { enqueue?: boolean } = {}): Promise<{ message: WaMessage; created: boolean }> {
  const { store } = input;
  const to = input.contact ? null : input.to;
  const now = new Date();
  const type = input.payload.kind === "template" ? "template" : input.payload.kind === "text" ? "text" : input.payload.mediaType;
  try {
    const message = await systemDb.waMessage.create({
      data: {
        workspaceId: store.workspaceId,
        storeId: store.id,
        connectionId: input.connectionId,
        direction: "out",
        contactId: input.contact?.id ?? null,
        phoneHash: input.contact?.phoneHash ?? (to ? waPhoneHash(store.id, digits(to)) : null),
        phoneEnc: to ? waEncrypt(store.id, "phone", to) : null,
        phoneMasked: input.contact?.phoneMasked ?? (to ? maskPhone(to) : null),
        source: input.source,
        workflowId: input.workflowId ?? null,
        workflowRunId: input.workflowRunId ?? null,
        campaignId: input.campaignId ?? null,
        idempotencyKey: input.idempotencyKey,
        type,
        templateName: input.template?.name ?? null,
        templateLanguage: input.template?.language ?? null,
        category: input.template?.category ?? "SERVICE",
        payloadEnc: input.skip ? null : waEncrypt(store.id, "payload", JSON.stringify(input.payload)),
        previewEnc: input.preview ? waEncrypt(store.id, "preview", input.preview.slice(0, 2000)) : null,
        status: input.skip ? "skipped" : "queued",
        reason: input.skip ?? null,
        sendAfter: input.sendAfter ?? now,
        finalAt: input.skip ? now : null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    if (message.status === "queued" && opts.enqueue !== false) await enqueueSend(message, deps);
    return { message, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const message = await systemDb.waMessage.findUnique({ where: { storeId_idempotencyKey: { storeId: store.id, idempotencyKey: input.idempotencyKey } } });
      if (message) return { message, created: false };
    }
    throw e;
  }
}

/** Put a queued message on the queue when it is due within the queue's longest delay (the sweep takes the rest). */
export async function enqueueSend(m: Pick<WaMessage, "id" | "sendAfter" | "status">, deps: Pick<WaDeps, "queues">): Promise<boolean> {
  if (m.status !== "queued") return false;
  const delay = Math.max(0, Math.ceil((m.sendAfter.getTime() - Date.now()) / 1000));
  if (delay > WA_MAX_QUEUE_DELAY_S) return false;
  await waQueue(deps.queues).send({ kind: "whatsapp", messageId: m.id }, { delaySeconds: delay });
  await systemDb.waMessage.updateMany({ where: { id: m.id, status: "queued" }, data: { enqueuedAt: new Date() } });
  return true;
}

export type SendOutcome = "gone" | "later" | "accepted" | "skipped" | "cancelled" | "failed" | "held" | "retry";

/** End a message without sending it (only one still being worked on changes). */
async function finish(m: WaMessage, status: "skipped" | "cancelled" | "failed", reason: string, extra: Prisma.WaMessageUpdateManyMutationInput = {}): Promise<SendOutcome> {
  const keep = status === "failed" && reason !== "template_not_approved";
  await systemDb.waMessage.updateMany({
    where: { id: m.id, status: { in: ["queued", "sending"] } },
    // A failed message keeps what it needs for a retry (cleared by the retention sweep after 7 days).
    data: { status, reason, finalAt: new Date(), ...(keep ? {} : { payloadEnc: null }), ...(status === "failed" ? { failedAt: new Date() } : {}), ...extra },
  });
  return status;
}

/** Back to queued for later; `spend` is false for a wait that isn't the message's fault (no attempt counted). */
async function later(m: WaMessage, at: Date, deps: Pick<WaDeps, "queues">, reason: string | null, spend = false): Promise<SendOutcome> {
  await systemDb.waMessage.updateMany({
    where: { id: m.id, status: "sending" },
    data: { status: "queued", sendAfter: at, enqueuedAt: null, reason, ...(spend ? {} : { attempts: { decrement: 1 } }) },
  });
  await enqueueSend({ id: m.id, sendAfter: at, status: "queued" }, deps);
  return "later";
}

/** Messages a store's number hands to Meta per second at most (Meta allows 80 by default). */
const SENDS_PER_SECOND = 20;
/** Waiting messages are held this long while the connection needs the merchant, then cancelled by the sweep. */
export const HOLD_LIMIT_MS = 48 * 3600_000;

// ---------------------------------------------------------------------------
// The circuit breaker: one per sending number
// ---------------------------------------------------------------------------

/** How long a number waits after Meta throttles it or can't serve it: 30 s, doubling while it keeps happening, at most 10 minutes. */
export const BREAKER_BASE_S = 30;
export const BREAKER_MAX_S = 600;
const breakerKey = (phoneNumberId: string) => `wa:breaker:${phoneNumberId}`;

/** Meta codes that say the number (not one message) is throttled, or Meta itself is busy. */
const NUMBER_WIDE = new Set([4, 80007, 130429, 131048, 131000, 1, 2, 133004]);

/**
 * The number's breaker as stored: "<open until, ms>:<trips in a row>". The record outlives the wait
 * by BREAKER_MAX_S, so a refusal soon after it closed waits twice as long; a send Meta takes clears it.
 */
async function readBreaker(coord: WaDeps["coord"], phoneNumberId: string): Promise<{ until: number; trips: number } | null> {
  const raw = await coord.peek(breakerKey(phoneNumberId)).catch(() => null);
  if (!raw) return null;
  const [until, trips] = raw.split(":").map(Number);
  return Number.isFinite(until) && Number.isFinite(trips) && trips! > 0 ? { until: until!, trips: trips! } : null;
}

/** Until when the number's breaker is open (null: closed). */
export async function breakerOpenUntil(coord: WaDeps["coord"], phoneNumberId: string): Promise<number | null> {
  const b = await readBreaker(coord, phoneNumberId);
  return b && b.until > Date.now() ? b.until : null;
}

/** Open the number's breaker after a refusal that holds for every message it sends. Returns until when. */
export async function tripBreaker(coord: WaDeps["coord"], phoneNumberId: string): Promise<number> {
  const prev = await readBreaker(coord, phoneNumberId);
  // Several sends refused in the same moment trip it once.
  if (prev && prev.until > Date.now()) return prev.until;
  const trips = (prev?.trips ?? 0) + 1;
  const wait = Math.min(BREAKER_MAX_S, BREAKER_BASE_S * 2 ** (trips - 1));
  const until = Date.now() + wait * 1000;
  await coord.put(breakerKey(phoneNumberId), `${until}:${trips}`, wait + BREAKER_MAX_S).catch(() => undefined);
  logger.warn({ phoneNumberId, wait, trips }, "whatsapp: Meta throttled the number; its sends wait");
  return until;
}

/** Meta took a message from the number again: the breaker closes. */
async function closeBreaker(coord: WaDeps["coord"], phoneNumberId: string): Promise<void> {
  await coord.put(breakerKey(phoneNumberId), "0:0", 1).catch(() => undefined);
}

/** A refusal that holds for every message the number sends (a throttle, Meta busy), not just this one. */
const numberWide = (err: WhatsappApiError) => (err.code !== null && NUMBER_WIDE.has(err.code)) || (err.code === null && (err.httpStatus >= 500 || err.httpStatus === 429));

/** Messages held while their store paused automation are released at once on resume (the sweep takes the rest). */
export async function releasePausedMessages(storeId: string, deps: Pick<WaDeps, "queues">): Promise<number> {
  const now = new Date();
  await systemDb.waMessage.updateMany({ where: { storeId, status: "queued", reason: "automation_paused" }, data: { reason: null, sendAfter: now, enqueuedAt: null } });
  const rows = await systemDb.waMessage.findMany({ where: { storeId, status: "queued", enqueuedAt: null, sendAfter: { lte: now } }, select: { id: true, sendAfter: true, status: true }, take: 1000 });
  for (const m of rows) await enqueueSend(m, deps);
  return rows.length;
}

/** How many customers the store started conversations with in the last 24 hours (template sends). */
async function recipientsToday(storeId: string, coord: WaDeps["coord"]): Promise<number> {
  const key = `wa:daily:${storeId}`;
  const cached = await coord.peek(key).catch(() => null);
  if (cached !== null) return Number(cached);
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await systemDb.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(DISTINCT phone_hash) AS n FROM wa_messages
    WHERE store_id = ${storeId} AND direction = 'out' AND type = 'template' AND source <> 'test'
      AND accepted_at >= ${since} AND created_at >= ${new Date(since.getTime() - 24 * 3600_000)}`;
  const n = Number(rows[0]?.n ?? 0);
  await coord.put(key, String(n), 60).catch(() => undefined);
  return n;
}

/** The send's message object for Meta (everything but the envelope). */
function messageBody(m: WaMessage, payload: SendPayload, components: TemplateComponent[] | null): Record<string, unknown> {
  if (payload.kind === "template") {
    const shape = templateShape(components ?? []);
    const parts = buildSendComponents(shape, payload.mapping, payload.values, payload.headerMediaUrl);
    return { type: "template", template: { name: m.templateName, language: { code: m.templateLanguage }, ...(parts.length ? { components: parts } : {}) } };
  }
  if (payload.kind === "text") return { type: "text", text: { body: payload.body, preview_url: !!payload.previewUrl } };
  const media: Record<string, unknown> = { link: payload.link };
  if (payload.caption && payload.mediaType !== "document") media.caption = payload.caption;
  if (payload.mediaType === "document") {
    if (payload.caption) media.caption = payload.caption;
    if (payload.filename) media.filename = payload.filename;
  }
  return { type: payload.mediaType, [payload.mediaType]: media };
}

/** Send one queued message. Never throws for Meta's or Nango's answers: the row records them. */
export async function sendWaMessage(messageId: string, deps: WaDeps): Promise<SendOutcome> {
  const m0 = await systemDb.waMessage.findUnique({ where: { id: messageId } });
  if (!m0 || m0.status !== "queued") return "gone";
  if (m0.sendAfter.getTime() > Date.now() + 5000) {
    await enqueueSend(m0, deps);
    return "later";
  }
  // Claimed before anything else: a second delivery of the same job finds it taken.
  const claimed = await systemDb.waMessage.updateMany({ where: { id: m0.id, status: "queued" }, data: { status: "sending", attempts: { increment: 1 }, enqueuedAt: null } });
  if (!claimed.count) return "gone";
  const m = { ...m0, status: "sending", attempts: m0.attempts + 1 };

  const [conn, store] = await Promise.all([systemDb.waConnection.findUnique({ where: { storeId: m.storeId } }), systemDb.store.findUnique({ where: { id: m.storeId }, select: { status: true, timezone: true } })]);
  if (!conn || conn.status === "disconnected") return finish(m, "cancelled", conn ? "disconnected" : "not_connected");
  // The store left bizinsights (the Shopify app uninstalled): nothing more is sent about it.
  if (!store || store.status === "uninstalled") return finish(m, "cancelled", "not_connected");
  if (conn.status !== "active" || !conn.registered || !conn.phoneNumberId || !conn.nangoConnectionId) {
    // Waiting for the merchant (reconnect, an account problem, a step): held; the sweep cancels after 48 hours.
    if (conn.reconnectSince && Date.now() - conn.reconnectSince.getTime() > HOLD_LIMIT_MS) return finish(m, "cancelled", "reconnect_timeout");
    return later(m, new Date(Date.now() + 30 * 60_000), deps, "waiting_for_connection");
  }

  let payload: SendPayload;
  try {
    if (!m.payloadEnc) return finish(m, "failed", "nothing_to_send");
    payload = JSON.parse(waDecrypt(m.storeId, "payload", m.payloadEnc)) as SendPayload;
  } catch (err) {
    logger.error({ err, messageId: m.id }, "whatsapp message payload unreadable");
    return finish(m, "failed", "unreadable");
  }

  // The recipient, and whether they may receive it.
  let to: string | null = null;
  let contact: WaContact | null = null;
  if (m.contactId) {
    contact = await systemDb.waContact.findUnique({ where: { id: m.contactId } });
    if (!contact) return finish(m, "cancelled", "erased");
    to = waDecrypt(contact.storeId, "phone", contact.phoneEnc);
  } else if (m.phoneEnc) {
    to = waDecrypt(m.storeId, "phone", m.phoneEnc);
  }
  if (!to) return finish(m, "skipped", "no_phone");

  let components: TemplateComponent[] | null = null;
  let category = m.category ?? "SERVICE";
  if (m.type === "template") {
    const t = await systemDb.waTemplate.findUnique({ where: { storeId_name_language: { storeId: m.storeId, name: m.templateName ?? "", language: m.templateLanguage ?? "" } } });
    if (!t || t.status !== "APPROVED") return finish(m, "failed", "template_not_approved", { errorTitle: "The template isn't approved by Meta (any more)." });
    components = t.components as unknown as TemplateComponent[];
    // Meta's category now decides who may receive it (Meta can move a template to Marketing).
    category = t.category;
  }
  const settings = await settingsOf(m.storeId);
  // "Pause all automation": workflows' and campaigns' messages wait (released on resume), for 48 hours at most.
  if ((m.source === "workflow" || m.source === "campaign") && settings.automationPausedAt) {
    const pausedAt = settings.automationPausedAt.getTime();
    if (Date.now() - pausedAt > HOLD_LIMIT_MS) return finish(m, "cancelled", "automation_paused");
    return later(m, new Date(pausedAt + HOLD_LIMIT_MS + 60_000), deps, "automation_paused");
  }
  if (contact) {
    if (m.type === "template") {
      const problem = consentProblem(category, consentFacts(contact), { orderUpdates: settings.orderUpdates });
      if (problem) return finish(m, "skipped", problem);
    } else {
      if (contact.optedOut) return finish(m, "skipped", "opted_out");
      // Free-form messages only within 24 hours of the customer's last message (Meta's rule).
      if (!contact.lastInboundAt || Date.now() - contact.lastInboundAt.getTime() > 24 * 3600_000) return finish(m, "skipped", "outside_window");
    }
  }

  // Still wanted?
  if (m.workflowId) {
    const wf = await systemDb.waWorkflow.findUnique({ where: { id: m.workflowId }, select: { status: true, sendWindowStart: true, sendWindowEnd: true } });
    if (!wf || wf.status !== "active") return finish(m, "cancelled", "workflow_paused");
    if (wf.sendWindowStart !== null && wf.sendWindowEnd !== null) {
      const tz = store.timezone || "UTC";
      if (!inSendWindow(new Date(), tz, wf.sendWindowStart, wf.sendWindowEnd)) return later(m, nextSendTime(new Date(), tz, wf.sendWindowStart, wf.sendWindowEnd), deps, "sending_hours");
    }
  }
  if (m.campaignId) {
    const c = await systemDb.waCampaign.findUnique({ where: { id: m.campaignId }, select: { status: true } });
    if (!c || c.status !== "sending") return finish(m, "cancelled", "campaign_cancelled");
  }

  // The store's daily limit (its own, else Meta's tier) and the number's pace.
  if (m.type === "template" && m.source !== "test" && m.source !== "team_alert") {
    const tier = tierLimit(conn.messagingLimitTier);
    const cap = [tier, settings.dailyLimit].filter((x): x is number => x !== null).reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    if (Number.isFinite(cap) && (await recipientsToday(m.storeId, deps.coord)) >= cap) return later(m, new Date(Date.now() + 3600_000), deps, "daily_limit");
  }
  // Meta throttled this number a moment ago: wait it out (no attempt spent) instead of being refused again.
  const breaker = await readBreaker(deps.coord, conn.phoneNumberId);
  if (breaker && breaker.until > Date.now()) return later(m, new Date(breaker.until + Math.floor(Math.random() * 5000)), deps, "meta_throttled");
  const second = Math.floor(Date.now() / 1000);
  if ((await deps.coord.hit(`wa:pace:${conn.phoneNumberId}:${second}`, 2).catch(() => 0)) > SENDS_PER_SECOND) {
    return later(m, new Date(Date.now() + 1000 + Math.floor(Math.random() * 2000)), deps, null);
  }

  let body: Record<string, unknown>;
  try {
    body = messageBody(m, payload, components);
  } catch (err) {
    if (err instanceof MissingValueError) return finish(m, "skipped", "missing_values", { errorTitle: `No value for: ${err.missing.join(", ")}`.slice(0, 300) });
    throw err;
  }

  let token: string;
  try {
    token = await waTokenFor(conn.nangoConnectionId, deps.fetchImpl);
  } catch (err) {
    if (err instanceof NangoTokenGoneError) {
      await markReconnect(conn, "bizinsights' access to your WhatsApp was removed", deps);
      return later(m, new Date(Date.now() + 30 * 60_000), deps, "waiting_for_connection");
    }
    if (err instanceof NangoUnavailableError || err instanceof WhatsappError) return retryLater(m, deps, "nango_unavailable");
    throw err;
  }

  try {
    const wamid = await sendMessage(conn.phoneNumberId, token, digits(to), body, m.id, deps.fetchImpl);
    const now = new Date();
    await systemDb.waMessage.updateMany({
      where: { id: m.id, status: "sending" },
      data: { status: "accepted", wamid, acceptedAt: now, reason: null, errorCode: null, errorTitle: null, payloadEnc: null },
    });
    if (conn.status !== "active") await markWorking(conn);
    if (breaker) await closeBreaker(deps.coord, conn.phoneNumberId);
    return "accepted";
  } catch (err) {
    if (!(err instanceof WhatsappApiError)) throw err;
    return onMetaError(m, conn, contact, err, deps);
  }
}

async function retryLater(m: WaMessage, deps: Pick<WaDeps, "queues">, reason: string): Promise<SendOutcome> {
  if (m.attempts >= WA_MAX_ATTEMPTS) return finish(m, "failed", reason, { errorTitle: "WhatsApp kept refusing for now; it was tried several times." });
  const wait = WA_RETRY_DELAYS_S[Math.min(m.attempts - 1, WA_RETRY_DELAYS_S.length - 1)]! * 1000;
  // A little jitter, so a burst that was throttled together doesn't come back together.
  await later(m, new Date(Date.now() + wait + Math.floor(Math.random() * wait * 0.2)), deps, reason, true);
  return "retry";
}

async function onMetaError(m: WaMessage, conn: WaConnection, contact: WaContact | null, err: WhatsappApiError, deps: WaDeps): Promise<SendOutcome> {
  const code = err.code !== null ? String(err.code) : null;
  const explained = metaErrorExplanation(err.code, null).slice(0, 300);
  logger.warn({ messageId: m.id, storeId: m.storeId, httpStatus: err.httpStatus, code: err.code, action: err.action }, "whatsapp send refused");
  switch (err.action) {
    case "network":
      // Meta may have it: never sent again on its own.
      return finish(m, "failed", "uncertain", { errorTitle: "WhatsApp didn't answer, so it may or may not have been sent. Check with the customer before sending it again." });
    case "retry":
      if (conn.phoneNumberId && numberWide(err)) await tripBreaker(deps.coord, conn.phoneNumberId);
      return retryLater(m, deps, `meta_${code ?? err.httpStatus}`);
    case "reconnect":
      await markReconnect(conn, "Meta no longer accepts bizinsights' access", deps);
      return later(m, new Date(Date.now() + 30 * 60_000), deps, "waiting_for_connection");
    case "account":
      await markAccountProblem(conn, explained, deps, { holdSending: err.code === 133010 || err.code === 131031 || err.code === 368 });
      return finish(m, "failed", "account", { errorCode: code, errorTitle: explained });
    case "marketing_opt_out":
      if (contact) await setConsent(contact, { scope: "marketing", status: "opted_out", source: "meta_error", at: new Date() }).catch(() => undefined);
      return finish(m, "failed", "no_marketing_consent", { errorCode: code, errorTitle: explained });
    default:
      return finish(m, "failed", "refused", { errorCode: code, errorTitle: metaErrorExplanation(err.code, err.title).slice(0, 300) });
  }
}

/**
 * "Retry" on a failed message: queued again as it was. Not for one Meta delivered (or reported as
 * delivered later), nor one whose details are gone (older than 7 days).
 */
export async function retryMessage(deps: Pick<WaDeps, "queues">, input: { storeId: string; messageId: string }): Promise<WaMessage> {
  const m = await systemDb.waMessage.findFirst({ where: { id: input.messageId, storeId: input.storeId, direction: "out" } });
  if (!m) throw new WhatsappError("That message wasn't found.", 404, "not_found");
  if (m.status !== "failed") throw new WhatsappError("Only a failed message can be sent again.", 409, "not_failed");
  if (!m.payloadEnc) throw new WhatsappError("This message is too old to send again. Send a new one instead.", 409, "too_old");
  const now = new Date();
  const r = await systemDb.waMessage.updateMany({
    where: { id: m.id, status: "failed" },
    data: { status: "queued", reason: null, attempts: 0, sendAfter: now, finalAt: null, failedAt: null, errorCode: null, errorTitle: null, enqueuedAt: null },
  });
  if (!r.count) throw new WhatsappError("Only a failed message can be sent again.", 409, "not_failed");
  const updated = { ...m, status: "queued", sendAfter: now };
  await enqueueSend(updated, deps);
  return updated;
}

/** Cancel what is still waiting (a workflow paused, a campaign cancelled, an order cancelled). Returns how many. */
export async function cancelQueued(where: Prisma.WaMessageWhereInput, reason: SkipReason): Promise<number> {
  const r = await systemDb.waMessage.updateMany({ where: { ...where, status: "queued" }, data: { status: "cancelled", reason, finalAt: new Date(), payloadEnc: null } });
  return r.count;
}

/** A message's preview text, or null (an unreadable one is shown as unknown). */
export function messagePreview(m: Pick<WaMessage, "storeId" | "previewEnc" | "id">): string | null {
  if (!m.previewEnc) return null;
  try {
    return waDecrypt(m.storeId, "preview", m.previewEnc);
  } catch (err) {
    logger.warn({ err, messageId: m.id }, "whatsapp message preview unreadable");
    return null;
  }
}
