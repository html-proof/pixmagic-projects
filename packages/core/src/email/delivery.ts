/**
 * Sending: the email-send job and the rules around it.
 *
 * A message row is the queue entry and the record. The job claims it (queued/deferred → processing,
 * one attempt counted) so a redelivered queue message can't send it twice, runs the checks that
 * may have changed since it was scheduled (account, workspace, automation, sender, suppression,
 * sending limits), renders it, hands it to the provider, and records exactly what the provider
 * said. Email is an outside side effect, so exactly-once isn't promised: what is promised is that
 * nothing is sent twice by Insights' own retries. A send that may have reached the provider without
 * an answer becomes `unknown` and is never retried on its own.
 */
import { randomBytes } from "node:crypto";
import { Prisma, systemDb, type EmailAccount, type EmailMessage, type EmailSenderIdentity, type Tx } from "@app/db";
import { maskEmail, PROVIDER_LIMITS, type EmailProvider } from "@app/shared/email";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { raiseAlert } from "../notify.js";
import { appHost, recipientHash, safeErrorText, type EmailDeps } from "./common.js";
import { buildMime, MimeError } from "./mime.js";
import { adapterFor, EmailSendError } from "./providers.js";
import { businessInfo, renderEmail, type RenderedEmail } from "./render.js";
import { isSuppressed, addSuppression, unsubscribeOneClickUrl, unsubscribePageUrl, unsubscribeToken } from "./suppressions.js";
import { markDegraded, markReauthorizationRequired } from "./tokens.js";
import { AAD, open, seal } from "./vault.js";

/** Cloudflare Queues delays a message by at most 12 hours; later sends are picked up by the sweep. */
export const MAX_QUEUE_DELAY_S = 12 * 3600;
/** A held message (account disabled or awaiting reconnection, sending paused) looks again after this. */
const HOLD_MS = 60 * 60_000;
/** How long a message may wait for its account to be reconnected before it fails. */
const REAUTH_PATIENCE_MS = 24 * 3600_000;
/** How long a message may wait out a paused workspace before it is cancelled. */
const PAUSE_PATIENCE_MS = 72 * 3600_000;

type Db = Tx | typeof systemDb;

export interface NewMessage {
  workspaceId: string;
  account: Pick<EmailAccount, "id" | "provider">;
  sender: Pick<EmailSenderIdentity, "id" | "senderEmail">;
  to: string;
  subject: string;
  kind: "automation" | "test" | "verification";
  category: string;
  scheduledAt: Date;
  idempotencyKey: string;
  maxAttempts?: number;
  ruleId?: string | null;
  executionId?: string | null;
  eventId?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  storeId?: string | null;
  /** Created already settled (a suppressed recipient): recorded, never sent. */
  status?: "queued" | "suppressed";
  lastErrorCode?: string | null;
}

/** Record a message (and its first event). The recipient is stored encrypted, hashed and masked. */
export async function createMessage(db: Db, m: NewMessage): Promise<EmailMessage> {
  const msg = await db.emailMessage.create({
    data: {
      workspaceId: m.workspaceId,
      emailAccountId: m.account.id,
      senderIdentityId: m.sender.id,
      ruleId: m.ruleId ?? null,
      executionId: m.executionId ?? null,
      eventId: m.eventId ?? null,
      templateId: m.templateId ?? null,
      templateVersion: m.templateVersion ?? null,
      storeId: m.storeId ?? null,
      kind: m.kind,
      category: m.category,
      provider: m.account.provider,
      senderAddress: m.sender.senderEmail,
      recipientEnc: seal(m.to, AAD.recipient(m.workspaceId)),
      recipientHash: recipientHash(m.workspaceId, m.to),
      recipientMasked: maskEmail(m.to),
      subject: m.subject.slice(0, 250),
      idempotencyKey: m.idempotencyKey,
      internetMessageId: `${randomBytes(16).toString("hex")}@${appHost()}`,
      status: m.status ?? "queued",
      maxAttempts: m.maxAttempts ?? 5,
      scheduledAt: m.scheduledAt,
      lastErrorCode: m.lastErrorCode ?? null,
      ...(m.status === "suppressed" ? { cancelledAt: new Date() } : {}),
    },
  });
  await db.emailMessageEvent.create({ data: { workspaceId: m.workspaceId, messageId: msg.id, eventType: m.status ?? "queued", metadata: m.lastErrorCode ? { code: m.lastErrorCode } : undefined } });
  return msg;
}

/** Put a send job on the queue, delayed to its time (the sweep catches anything later than the queue can wait). */
export async function enqueueEmailSend(msg: Pick<EmailMessage, "id" | "scheduledAt">, deps: Pick<EmailDeps, "queues">) {
  const wait = Math.max(0, Math.ceil((msg.scheduledAt.getTime() - Date.now()) / 1000));
  if (wait > MAX_QUEUE_DELAY_S) return;
  try {
    await deps.queues.email.send({ kind: "email_send", messageId: msg.id }, wait ? { delaySeconds: wait } : undefined);
    await systemDb.emailMessage.updateMany({ where: { id: msg.id }, data: { enqueuedAt: new Date() } });
  } catch (err) {
    // The row is the source of truth: the sweep sends it on its next pass.
    logger.warn({ err, messageId: msg.id }, "could not queue an email; the sweep will pick it up");
  }
}

async function event(m: Pick<EmailMessage, "id" | "workspaceId">, eventType: string, metadata?: Record<string, unknown>) {
  await systemDb.emailMessageEvent.create({ data: { workspaceId: m.workspaceId, messageId: m.id, eventType, metadata: (metadata ?? undefined) as never } });
}

export type EmailSendOutcome = "accepted" | "deferred" | "held" | "failed" | "bounced" | "suppressed" | "cancelled" | "unknown" | "not_due" | "gone";

/** Exponential backoff with jitter: about 1, 2, 4, 8... minutes, at most an hour. */
export function retryDelaySeconds(attempt: number, providerSays?: number): number {
  const base = Math.min(3600, 60 * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
  return Math.max(providerSays ?? 0, jittered);
}

/** Back to waiting without spending the attempt (not the message's fault). */
async function hold(m: EmailMessage, until: Date, code: string, deps: Pick<EmailDeps, "queues">): Promise<EmailSendOutcome> {
  await systemDb.emailMessage.updateMany({
    where: { id: m.id, status: "processing" },
    data: { status: m.attempts > 1 ? "deferred" : "queued", attempts: { decrement: 1 }, scheduledAt: until, lastErrorCode: code, enqueuedAt: null },
  });
  await event(m, "held", { code, until: until.toISOString() });
  await enqueueEmailSend({ id: m.id, scheduledAt: until }, deps);
  return "held";
}

async function finish(m: EmailMessage, status: "failed" | "cancelled" | "suppressed" | "unknown" | "bounced", code: string, message?: string | null): Promise<EmailSendOutcome> {
  const now = new Date();
  await systemDb.emailMessage.updateMany({
    where: { id: m.id },
    data: {
      status,
      lastErrorCode: code,
      lastErrorMessage: safeErrorText(message ?? null),
      ...(status === "failed" || status === "bounced" ? { failedAt: now } : status === "unknown" ? {} : { cancelledAt: now }),
    },
  });
  await event(m, status, { code, attempt: m.attempts });
  return status;
}

/** Sending limits: per workspace and per account, per minute and per day. Returns when to try again, or null to go ahead. */
async function limitWait(m: EmailMessage, account: EmailAccount, dailyLimit: number, deps: Pick<EmailDeps, "coord">): Promise<{ until: Date; code: string } | null> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const minute = Math.floor(now.getTime() / 60_000);
  const nextMinute = new Date((minute + 1) * 60_000 + Math.floor(Math.random() * 20_000));
  const nextDay = new Date(`${day}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const limits = PROVIDER_LIMITS[account.provider as EmailProvider] ?? PROVIDER_LIMITS.smtp;
  const e = env();
  const checks: Array<[string, number, number, Date, string]> = [
    [`email:rl:ws:${m.workspaceId}:${minute}`, 90, e.EMAIL_WORKSPACE_PER_MINUTE, nextMinute, "rate_limited"],
    [`email:rl:acct:${account.id}:${minute}`, 90, limits.perMinute, nextMinute, "rate_limited"],
    [`email:day:ws:${m.workspaceId}:${day}`, 90_000, dailyLimit, nextDay, "quota_exceeded"],
    [`email:day:acct:${account.id}:${day}`, 90_000, Math.min(account.dailyLimit ?? limits.perDay, limits.perDay * 5), nextDay, "quota_exceeded"],
  ];
  for (const [key, window, max, until, code] of checks) {
    if ((await deps.coord.hit(key, window)) > max) return { until, code };
  }
  return null;
}

/** The job: send one message if it is (still) due and allowed. Idempotent. */
export async function sendEmailMessage(messageId: string, deps: EmailDeps): Promise<EmailSendOutcome> {
  const row = await systemDb.emailMessage.findUnique({ where: { id: messageId } });
  if (!row || (row.status !== "queued" && row.status !== "deferred")) return "gone";
  if (row.scheduledAt.getTime() > Date.now() + 30_000) {
    if (!row.enqueuedAt || row.enqueuedAt.getTime() < Date.now() - 60_000) await enqueueEmailSend(row, deps);
    return "not_due";
  }
  const claimed = await systemDb.emailMessage.updateMany({
    where: { id: row.id, status: { in: ["queued", "deferred"] }, scheduledAt: { lte: new Date(Date.now() + 30_000) } },
    data: { status: "processing", processingStartedAt: new Date(), attempts: { increment: 1 } },
  });
  if (!claimed.count) return "gone";
  const m = await systemDb.emailMessage.findUniqueOrThrow({ where: { id: row.id } });
  return deliver(m, deps);
}

/**
 * Send a claimed (processing) message. `content` is given for test and verification sends, which
 * have no event; automation messages are rendered from their event and template here.
 */
export async function deliver(m: EmailMessage, deps: EmailDeps, content?: RenderedEmail): Promise<EmailSendOutcome> {
  let handedOver = false;
  try {
    return await deliverClaimed(m, deps, content, () => (handedOver = true));
  } catch (err) {
    // An unexpected failure (the database, most likely). Before the provider had it: put it back to
    // be tried again. After: it may have gone, so it stays `processing` and the sweep marks it unknown.
    if (!handedOver) {
      await systemDb.emailMessage
        .updateMany({ where: { id: m.id, status: "processing" }, data: { status: "deferred", attempts: { decrement: 1 }, scheduledAt: new Date(Date.now() + 60_000), enqueuedAt: null } })
        .catch(() => undefined);
    }
    throw err;
  }
}

async function deliverClaimed(m: EmailMessage, deps: EmailDeps, content: RenderedEmail | undefined, handOver: () => void): Promise<EmailSendOutcome> {
  const age = Date.now() - m.createdAt.getTime();
  const self = m.kind !== "automation";
  const account = await systemDb.emailAccount.findUnique({ where: { id_workspaceId: { id: m.emailAccountId, workspaceId: m.workspaceId } } });
  if (!account || account.deletedAt || account.status === "revoked") return finish(m, "cancelled", "account_disconnected");
  if (account.status === "disabled") return self ? finish(m, "failed", "account_disabled") : hold(m, new Date(Date.now() + HOLD_MS), "account_disabled", deps);
  if (account.status === "reauthorization_required" || account.status === "failed") {
    const code = account.status === "failed" ? "account_failed" : "account_reauthorization_required";
    if (self || age > REAUTH_PATIENCE_MS) return finish(m, "failed", code);
    return hold(m, new Date(Date.now() + HOLD_MS), code, deps);
  }

  const settings = await systemDb.emailSettings.findUnique({ where: { workspaceId: m.workspaceId } });
  if (!self && (settings?.sendingPaused || settings?.suspendedAt)) {
    const code = settings.suspendedAt ? "workspace_suspended" : "workspace_paused";
    if (age > PAUSE_PATIENCE_MS) return finish(m, "cancelled", code);
    return hold(m, new Date(Date.now() + HOLD_MS), code, deps);
  }

  if (m.ruleId) {
    const rule = await systemDb.emailAutomationRule.findUnique({ where: { id_workspaceId: { id: m.ruleId, workspaceId: m.workspaceId } }, select: { enabled: true, deletedAt: true } });
    if (!rule || !rule.enabled || rule.deletedAt) return finish(m, "cancelled", "rule_disabled");
  }

  const sender = m.senderIdentityId
    ? await systemDb.emailSenderIdentity.findUnique({ where: { id_workspaceId: { id: m.senderIdentityId, workspaceId: m.workspaceId } } })
    : null;
  if (!sender || sender.emailAccountId !== account.id || (sender.authorizationStatus !== "verified" && m.kind !== "verification")) return finish(m, "failed", "sender_unavailable");

  if (m.kind === "automation") {
    const sup = await isSuppressed(m.workspaceId, m.recipientHash, m.category);
    if (sup.suppressed) return finish(m, "suppressed", "suppressed", sup.reason);
  }

  const dailyLimit = Math.min(settings?.dailyLimit ?? env().EMAIL_DEFAULT_DAILY_LIMIT, env().EMAIL_MAX_DAILY_LIMIT);
  const wait = await limitWait(m, account, dailyLimit, deps);
  if (wait) {
    if (self) return finish(m, "failed", wait.code);
    return hold(m, wait.until, wait.code, deps);
  }

  const to = open(m.recipientEnc, AAD.recipient(m.workspaceId));
  const unsubToken = m.category === "marketing" ? unsubscribeToken({ w: m.workspaceId, h: m.recipientHash, e: m.recipientMasked, m: m.id }) : null;
  let rendered = content;
  if (!rendered) {
    const r = await renderAutomationMessage(m, to, unsubToken);
    if ("error" in r) return finish(m, "failed", r.error);
    rendered = r.email;
    if (rendered.subject !== m.subject) await systemDb.emailMessage.updateMany({ where: { id: m.id }, data: { subject: rendered.subject.slice(0, 250) } });
  }

  let mime: string;
  try {
    mime = buildMime({
      from: { email: sender.senderEmail, name: sender.senderName || account.displayName },
      to,
      replyTo: account.replyToAddress,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      messageId: m.internetMessageId,
      headers: {
        ...(unsubToken ? { "List-Unsubscribe": `<${unsubscribeOneClickUrl(unsubToken)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
        ...(m.kind === "automation" ? { "Auto-Submitted": "auto-generated" } : {}),
      },
    });
  } catch (err) {
    if (err instanceof MimeError) return finish(m, "failed", "invalid_message", err.message);
    throw err;
  }

  await event(m, "processing", { attempt: m.attempts });
  const adapter = adapterFor(account.connectionMethod);
  handOver();
  try {
    const r = await adapter.sendEmail(account, { from: sender.senderEmail, to, mime }, deps);
    const now = new Date();
    await systemDb.emailMessage.updateMany({
      where: { id: m.id },
      data: { status: "accepted_by_provider", providerMessageId: r.providerMessageId, providerAcceptedAt: now, lastErrorCode: null, lastErrorMessage: null },
    });
    await event(m, "accepted", { attempt: m.attempts, providerMessageId: r.providerMessageId, detail: r.detail });
    await systemDb.emailAccount.updateMany({
      where: { id: account.id, workspaceId: account.workspaceId },
      data: { lastSuccessfulSendAt: now, ...(account.status === "degraded" || account.status === "pending" || account.status === "testing" ? { status: "connected", statusReason: null } : {}) },
    });
    return "accepted";
  } catch (err) {
    const e = adapter.normalizeProviderError(err);
    return onSendError(m, account, sender, e, deps);
  }
}

async function onSendError(m: EmailMessage, account: EmailAccount, sender: EmailSenderIdentity, e: EmailSendError, deps: EmailDeps): Promise<EmailSendOutcome> {
  logger.warn({ messageId: m.id, accountId: account.id, kind: e.kind, code: e.code }, "email send failed");
  switch (e.kind) {
    case "uncertain":
      return finish(m, "unknown", e.code, e.message);
    case "auth":
      await markReauthorizationRequired(account, e.code, deps);
      return finish(m, "failed", "account_reauthorization_required", e.message);
    case "account_unusable":
      await systemDb.emailAccount.updateMany({
        where: { id: account.id, workspaceId: account.workspaceId, deletedAt: null },
        data: { status: "failed", statusReason: e.code, lastErrorCode: e.code, lastErrorAt: new Date() },
      });
      return finish(m, "failed", e.code, e.message);
    case "sender_rejected":
      // The provider says this address isn't ours to send as: stop using it until someone checks.
      await systemDb.emailSenderIdentity.updateMany({ where: { id: sender.id, workspaceId: sender.workspaceId }, data: { authorizationStatus: "revoked", isDefault: false } });
      await raiseAlert(
        { workspaceId: m.workspaceId, severity: "warning", code: `email_sender_rejected:${sender.id}`, message: `${account.emailAddress} isn't allowed to send as ${sender.senderEmail}. Automations using it are paused until the sender is verified again.` },
        deps.mailer,
        deps.fetchImpl,
      ).catch(() => undefined);
      return finish(m, "failed", "sender_rejected", e.message);
    case "recipient_rejected":
      if (e.opts.bounce) {
        await addSuppression({ workspaceId: m.workspaceId, hash: m.recipientHash, masked: m.recipientMasked, reason: "bounced", scope: "all", source: "smtp_rejection", messageId: m.id }).catch(() => undefined);
        return finish(m, "bounced", "recipient_rejected", e.message);
      }
      return finish(m, "failed", e.code, e.message);
    case "invalid":
      return finish(m, "failed", e.code, e.message);
    case "rate_limited":
    case "transient": {
      if (e.code === "provider_unavailable" || e.code === "connect_failed" || e.code === "tls_failed" || e.code === "timeout") await markDegraded(account, e.code);
      if (m.kind !== "automation" || m.attempts >= m.maxAttempts) return finish(m, "failed", m.kind === "automation" ? "retries_exhausted" : e.code, e.message);
      const delay = retryDelaySeconds(m.attempts, e.opts.retryAfterSec);
      const at = new Date(Date.now() + delay * 1000);
      await systemDb.emailMessage.updateMany({
        where: { id: m.id },
        data: { status: "deferred", scheduledAt: at, lastErrorCode: e.code, lastErrorMessage: safeErrorText(e.message), enqueuedAt: null },
      });
      await event(m, "retry_scheduled", { attempt: m.attempts, code: e.code, retryAt: at.toISOString() });
      await enqueueEmailSend({ id: m.id, scheduledAt: at }, deps);
      return "deferred";
    }
  }
}

/** An automation message's content, from its event and its template's current active version. */
async function renderAutomationMessage(m: EmailMessage, to: string, unsubToken: string | null): Promise<{ email: RenderedEmail } | { error: string }> {
  if (!m.templateId || !m.eventId) return { error: "render_failed" };
  const [template, evt] = await Promise.all([
    systemDb.emailTemplate.findUnique({ where: { id_workspaceId: { id: m.templateId, workspaceId: m.workspaceId } } }),
    systemDb.emailBusinessEvent.findUnique({ where: { id_workspaceId: { id: m.eventId, workspaceId: m.workspaceId } } }),
  ]);
  if (!template || template.deletedAt || template.status !== "active") return { error: "template_unavailable" };
  if (!evt?.payloadEnc) return { error: "render_failed" };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(open(evt.payloadEnc, AAD.eventPayload(evt.workspaceId, evt.source, evt.externalId))) as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, messageId: m.id }, "couldn't open an email event's data");
    return { error: "render_failed" };
  }
  const email = renderEmail(
    { subject: template.subjectTemplate, html: template.htmlTemplate, text: template.textTemplate, category: template.category },
    { data, business: await businessInfo(m.workspaceId), recipient: to, unsubscribeUrl: unsubToken ? unsubscribePageUrl(unsubToken) : null },
  );
  if (template.version !== m.templateVersion) await systemDb.emailMessage.updateMany({ where: { id: m.id }, data: { templateVersion: template.version } });
  return { email };
}

/**
 * Send right now, in the request (test sends and sender verification codes): one attempt, the
 * outcome returned to the person who pressed the button.
 */
export async function sendNow(
  input: { workspaceId: string; account: EmailAccount; sender: EmailSenderIdentity; to: string; content: RenderedEmail; kind: "test" | "verification"; category?: string },
  deps: EmailDeps,
): Promise<{ messageId: string; status: string; code: string | null; message: string | null }> {
  const msg = await createMessage(systemDb, {
    workspaceId: input.workspaceId,
    account: input.account,
    sender: input.sender,
    to: input.to,
    subject: input.content.subject,
    kind: input.kind,
    category: input.category ?? "transactional",
    scheduledAt: new Date(),
    idempotencyKey: `${input.kind}:${randomBytes(12).toString("hex")}`,
    maxAttempts: 1,
  });
  await systemDb.emailMessage.update({ where: { id: msg.id }, data: { status: "processing", processingStartedAt: new Date(), attempts: 1 } });
  await deliver({ ...msg, status: "processing", attempts: 1 }, deps, input.content);
  const after = await systemDb.emailMessage.findUniqueOrThrow({ where: { id: msg.id } });
  return { messageId: after.id, status: after.status, code: after.lastErrorCode, message: after.lastErrorMessage };
}

/** Cancel what's still waiting, by account or rule (disconnect, disable). Returns how many. */
export async function cancelPending(where: { workspaceId: string; emailAccountId?: string; ruleId?: string }, code: string): Promise<number> {
  const pending = await systemDb.emailMessage.findMany({ where: { ...where, status: { in: ["queued", "deferred"] } }, select: { id: true, workspaceId: true } });
  if (!pending.length) return 0;
  const { count } = await systemDb.emailMessage.updateMany({
    where: { id: { in: pending.map((p) => p.id) }, status: { in: ["queued", "deferred"] } },
    data: { status: "cancelled", cancelledAt: new Date(), lastErrorCode: code },
  });
  await systemDb.emailMessageEvent.createMany({ data: pending.map((p) => ({ workspaceId: p.workspaceId, messageId: p.id, eventType: "cancelled", metadata: { code } as Prisma.InputJsonValue })) });
  return count;
}
