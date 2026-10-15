/**
 * Sender identities: the From addresses each account may use. Never a typed-in address on its own:
 *
 *  - Google and Microsoft accounts send as the address they signed in as (provider_oauth). Aliases
 *    would need permission to read Gmail's send-as settings, which bizinsights doesn't ask for.
 *  - SMTP accounts send as an address once there is evidence the service lets them: either a code
 *    sent through the account to that address comes back (smtp_confirmation: the server relayed
 *    mail from it, and someone reads that mailbox), or the account signs in successfully and the
 *    address's domain is verified in this workspace (domain_ownership).
 */
import { createHmac, randomInt } from "node:crypto";
import { systemDb, withTenant, type EmailAccount, type EmailSenderIdentity, type Tx } from "@app/db";
import { accountCanSend, addressInDomain, emailDomain, escapeHtml, normalizeEmail } from "@app/shared/email";
import { safeEqual } from "@app/shared";
import { env } from "../env.js";
import { emailAudit, EmailError, notFound, type EmailDeps } from "./common.js";
import { sendNow } from "./delivery.js";
import { businessInfo } from "./render.js";

const CODE_TTL_MS = 30 * 60_000;
const CODE_ATTEMPTS = 5;

const codeHash = (senderId: string, code: string) => createHmac("sha256", env().OTP_PEPPER).update(`email-sender:${senderId}:${code}`).digest("hex");

export function publicSender(s: EmailSenderIdentity) {
  return {
    id: s.id,
    accountId: s.emailAccountId,
    email: s.senderEmail,
    name: s.senderName,
    status: s.authorizationStatus,
    method: s.verificationMethod,
    verifiedAt: s.verifiedAt,
    isDefault: s.isDefault,
    codeSentAt: s.verificationCodeExpiresAt ? new Date(s.verificationCodeExpiresAt.getTime() - CODE_TTL_MS) : null,
  };
}

/** The account's own address as a sender: verified for OAuth accounts, pending for SMTP until proven. */
export async function ensurePrimarySender(tx: Tx, account: Pick<EmailAccount, "id" | "workspaceId" | "emailAddress" | "connectionMethod" | "displayName">) {
  const oauth = account.connectionMethod !== "smtp";
  const existing = await tx.emailSenderIdentity.findUnique({ where: { emailAccountId_senderEmail: { emailAccountId: account.id, senderEmail: account.emailAddress } } });
  const sender = existing
    ? await tx.emailSenderIdentity.update({
        where: { id: existing.id },
        data: oauth ? { authorizationStatus: "verified", verificationMethod: "provider_oauth", verifiedAt: existing.verifiedAt ?? new Date() } : existing.authorizationStatus === "revoked" ? { authorizationStatus: "pending" } : {},
      })
    : await tx.emailSenderIdentity.create({
        data: {
          workspaceId: account.workspaceId,
          emailAccountId: account.id,
          senderEmail: account.emailAddress,
          senderName: account.displayName,
          authorizationStatus: oauth ? "verified" : "pending",
          verificationMethod: oauth ? "provider_oauth" : null,
          verifiedAt: oauth ? new Date() : null,
        },
      });
  // The workspace's first usable sender becomes its default.
  if (sender.authorizationStatus === "verified" && !(await tx.emailSenderIdentity.findFirst({ where: { workspaceId: account.workspaceId, isDefault: true }, select: { id: true } }))) {
    return tx.emailSenderIdentity.update({ where: { id: sender.id }, data: { isDefault: true } });
  }
  return sender;
}

/**
 * Authorize an SMTP sender whose domain this workspace has verified, once its account has signed in
 * successfully. Returns whether it did.
 */
export async function authorizeByDomain(workspaceId: string, sender: EmailSenderIdentity, account: Pick<EmailAccount, "status" | "connectionMethod">): Promise<boolean> {
  if (sender.authorizationStatus === "verified" || account.connectionMethod !== "smtp" || !accountCanSend(account.status)) return false;
  const domains = await systemDb.emailDomain.findMany({ where: { workspaceId, verificationStatus: { in: ["verified", "recheck_required"] } }, select: { id: true, domain: true } });
  const match = domains.find((d) => addressInDomain(sender.senderEmail, d.domain));
  if (!match) return false;
  await systemDb.emailSenderIdentity.update({
    where: { id: sender.id },
    data: { authorizationStatus: "verified", verificationMethod: "domain_ownership", domainId: match.id, verifiedAt: new Date(), verificationCodeHash: null },
  });
  if (!(await systemDb.emailSenderIdentity.findFirst({ where: { workspaceId, isDefault: true }, select: { id: true } }))) {
    await systemDb.emailSenderIdentity.update({ where: { id: sender.id }, data: { isDefault: true } }).catch(() => undefined);
  }
  return true;
}

export async function listSenders(workspaceId: string) {
  return withTenant(workspaceId, (tx) => tx.emailSenderIdentity.findMany({ where: { workspaceId, account: { deletedAt: null } }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }));
}

async function ownSender(workspaceId: string, senderId: string) {
  const s = await withTenant(workspaceId, (tx) => tx.emailSenderIdentity.findFirst({ where: { id: senderId, workspaceId }, include: { account: true } }));
  if (!s || s.account.deletedAt) throw notFound();
  return s;
}

/** Another From address for an SMTP account (an alias the server lets it send as). Starts pending. */
export async function addSender(workspaceId: string, accountId: string, input: { senderEmail: string; senderName?: string }, userId: string) {
  const account = await withTenant(workspaceId, (tx) => tx.emailAccount.findFirst({ where: { id: accountId, workspaceId, deletedAt: null } }));
  if (!account) throw notFound();
  if (account.connectionMethod !== "smtp") {
    throw new EmailError("Google and Microsoft accounts send from the address that signed in. Connect the other address as its own account.", 400, "aliases_unsupported");
  }
  const senderEmail = normalizeEmail(input.senderEmail);
  if (!senderEmail) throw new EmailError("Enter a valid email address", 400, "invalid_email");
  const existing = await systemDb.emailSenderIdentity.findUnique({ where: { emailAccountId_senderEmail: { emailAccountId: account.id, senderEmail } } });
  if (existing && existing.authorizationStatus !== "revoked") throw new EmailError("That address is already a sender for this account", 409, "sender_exists");
  const sender = existing
    ? await systemDb.emailSenderIdentity.update({ where: { id: existing.id }, data: { authorizationStatus: "pending", senderName: input.senderName || null, verificationCodeHash: null, verificationAttempts: 0 } })
    : await systemDb.emailSenderIdentity.create({ data: { workspaceId, emailAccountId: account.id, senderEmail, senderName: input.senderName || null } });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.sender.added", targetType: "email_sender", targetId: sender.id, metadata: { domain: emailDomain(senderEmail) } });
  await authorizeByDomain(workspaceId, sender, account);
  return systemDb.emailSenderIdentity.findUniqueOrThrow({ where: { id: sender.id } });
}

/** Email a six-digit code, through the account, to the sender address. */
export async function sendSenderCode(workspaceId: string, senderId: string, userId: string, deps: EmailDeps) {
  const s = await ownSender(workspaceId, senderId);
  if (s.authorizationStatus === "verified") throw new EmailError("This sender is already verified", 409, "already_verified");
  if (!accountCanSend(s.account.status)) throw new EmailError("Fix the account's connection first: it can't send right now.", 409, "account_unavailable");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await systemDb.emailSenderIdentity.update({
    where: { id: s.id },
    data: { verificationCodeHash: codeHash(s.id, code), verificationCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS), verificationAttempts: 0 },
  });
  const business = await businessInfo(workspaceId);
  const text = `Your bizinsights verification code for sending as ${s.senderEmail} is ${code}.\n\nEnter it in ${business.name}'s bizinsights settings within 30 minutes. If you didn't expect this, you can ignore it.`;
  const result = await sendNow(
    {
      workspaceId,
      account: s.account,
      sender: s,
      to: s.senderEmail,
      kind: "verification",
      content: { subject: `Verification code: ${code}`, text, html: `<p>Your bizinsights verification code for sending as <b>${escapeHtml(s.senderEmail)}</b> is:</p><p style="font-size:24px;letter-spacing:4px"><b>${code}</b></p><p>Enter it within 30 minutes. If you didn't expect this, you can ignore it.</p>` },
    },
    deps,
  );
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.sender.code_sent", targetType: "email_sender", targetId: s.id, metadata: { status: result.status } });
  if (result.status !== "accepted_by_provider") {
    throw new EmailError(`The account couldn't send the code: ${result.message ?? result.code ?? result.status}`, 422, result.code ?? "send_failed", { messageId: result.messageId });
  }
  return { messageId: result.messageId };
}

export async function confirmSender(workspaceId: string, senderId: string, code: string, userId: string) {
  const s = await ownSender(workspaceId, senderId);
  if (s.authorizationStatus === "verified") return s;
  if (!s.verificationCodeHash || !s.verificationCodeExpiresAt || s.verificationCodeExpiresAt < new Date()) throw new EmailError("The code has expired. Send a new one.", 410, "code_expired");
  if (s.verificationAttempts >= CODE_ATTEMPTS) throw new EmailError("Too many wrong codes. Send a new one.", 429, "too_many_attempts");
  const ok = /^\d{6}$/.test(code) && safeEqual(codeHash(s.id, code), s.verificationCodeHash);
  if (!ok) {
    await systemDb.emailSenderIdentity.update({ where: { id: s.id }, data: { verificationAttempts: { increment: 1 } } });
    throw new EmailError("That code isn't right.", 400, "wrong_code");
  }
  const verified = await systemDb.emailSenderIdentity.update({
    where: { id: s.id },
    data: { authorizationStatus: "verified", verificationMethod: "smtp_confirmation", verifiedAt: new Date(), verificationCodeHash: null, verificationCodeExpiresAt: null, verificationAttempts: 0 },
  });
  if (!(await systemDb.emailSenderIdentity.findFirst({ where: { workspaceId, isDefault: true }, select: { id: true } }))) {
    await systemDb.emailSenderIdentity.update({ where: { id: s.id }, data: { isDefault: true } }).catch(() => undefined);
  }
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.sender.verified", targetType: "email_sender", targetId: s.id, metadata: { method: "smtp_confirmation" } });
  return systemDb.emailSenderIdentity.findUniqueOrThrow({ where: { id: verified.id } });
}

export async function setDefaultSender(workspaceId: string, senderId: string, userId: string) {
  const s = await ownSender(workspaceId, senderId);
  if (s.authorizationStatus !== "verified" || !accountCanSend(s.account.status)) throw new EmailError("Only a verified sender on a working account can be the default.", 409, "sender_unavailable");
  await systemDb.$transaction([
    systemDb.emailSenderIdentity.updateMany({ where: { workspaceId, isDefault: true }, data: { isDefault: false } }),
    systemDb.emailSenderIdentity.update({ where: { id: s.id }, data: { isDefault: true } }),
  ]);
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.sender.default_set", targetType: "email_sender", targetId: s.id });
}

export async function removeSender(workspaceId: string, senderId: string, userId: string) {
  const s = await ownSender(workspaceId, senderId);
  if (s.senderEmail === s.account.emailAddress) throw new EmailError("The account's own address can't be removed; disconnect the account instead.", 409, "primary_sender");
  const inUse = await systemDb.emailAutomationRule.count({ where: { workspaceId, senderIdentityId: s.id, deletedAt: null, enabled: true } });
  if (inUse) throw new EmailError(`${inUse} active automation${inUse === 1 ? " uses" : "s use"} this sender. Change or turn them off first.`, 409, "sender_in_use");
  await systemDb.emailSenderIdentity.update({ where: { id: s.id }, data: { authorizationStatus: "revoked", isDefault: false, verificationCodeHash: null } });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.sender.removed", targetType: "email_sender", targetId: s.id });
}
