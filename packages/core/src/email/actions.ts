/**
 * What a person does to one message or template by hand: send a failed message again, or send a
 * template to themselves as a test. Settings → Email and the Automations hub both call these, so
 * the rules are the same wherever the button is.
 */
import { systemDb, withTenant } from "@app/db";
import { accountCanSend } from "@app/shared/email";
import { emailAudit, EmailError, notFound, type EmailDeps } from "./common.js";
import { enqueueEmailSend, sendNow } from "./delivery.js";
import { getTemplate, previewTemplate } from "./templates.js";

/** Why a message can't be sent again, or null when it can (automation messages that failed, or whose outcome is unknown). */
export function emailRetryRefusal(m: { kind: string; status: string }): string | null {
  if (m.kind !== "automation") return "Test emails can't be retried; send a new test instead.";
  if (m.status !== "failed" && m.status !== "unknown") return "Only failed messages, or ones whose outcome is unknown, can be retried.";
  return null;
}

/**
 * Send a failed or unknown message again. A person's decision, since an "unknown" one may already
 * have arrived: bizinsights never does this on its own. Only a row still failed or unknown moves,
 * so two presses queue it once.
 */
export async function retryEmailMessage(workspaceId: string, id: string, userId: string, deps: Pick<EmailDeps, "queues">) {
  const m = await withTenant(workspaceId, (tx) => tx.emailMessage.findFirst({ where: { id, workspaceId } }));
  if (!m) throw notFound();
  const refusal = emailRetryRefusal(m);
  if (refusal) throw new EmailError(refusal, 409, "not_retryable");
  const now = new Date();
  const { count } = await systemDb.emailMessage.updateMany({
    where: { id: m.id, workspaceId, status: { in: ["failed", "unknown"] } },
    data: { status: "queued", attempts: 0, scheduledAt: now, enqueuedAt: null, failedAt: null, lastErrorCode: null, lastErrorMessage: null },
  });
  if (!count) throw new EmailError("The message changed in the meantime; reload and try again.", 409, "conflict");
  await systemDb.emailMessageEvent.create({ data: { workspaceId, messageId: m.id, eventType: "queued", metadata: { retriedBy: userId, previousStatus: m.status } } });
  await enqueueEmailSend({ id: m.id, scheduledAt: now }, deps);
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.message.retried", targetType: "email_message", targetId: m.id, metadata: { previousStatus: m.status } });
}

/**
 * Send a template, filled with example data, to the person's own address (marked [Test]). The
 * sender is the one named, else the workspace's default; it must be verified, on an account that
 * can send.
 */
export async function sendTemplateTest(workspaceId: string, templateId: string, to: { email: string; verified: boolean }, senderId: string | null | undefined, deps: EmailDeps) {
  if (!to.verified) throw new EmailError("Verify your own email address first: test emails go to it.", 403, "email_unverified");
  const sender = await withTenant(workspaceId, (tx) =>
    tx.emailSenderIdentity.findFirst({ where: { workspaceId, authorizationStatus: "verified", ...(senderId ? { id: senderId } : { isDefault: true }) }, include: { account: true } }),
  );
  if (!sender || sender.account.deletedAt || !accountCanSend(sender.account.status)) throw new EmailError("Choose a verified sender on a working account (or set a default sender).", 409, "sender_unavailable");
  const t = await getTemplate(workspaceId, templateId);
  const content = await previewTemplate(workspaceId, { subject: t.subjectTemplate, html: t.htmlTemplate, text: t.textTemplate, category: t.category, eventType: t.eventType }, undefined, to.email);
  return sendNow({ workspaceId, account: sender.account, sender, to: to.email, content: { ...content, subject: `[Test] ${content.subject}` }, kind: "test", category: t.category }, deps);
}
