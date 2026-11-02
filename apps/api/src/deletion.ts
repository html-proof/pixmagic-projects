import { z } from "zod";
import type { User } from "@app/db";
import { AppError, deleteWorkspace, env, logger, type EmailPurpose } from "@app/core";
import { EMAIL_CODE_RE, safeEqual } from "@app/shared";
import { clientIp, HttpError, type Ctx, type Deps } from "./context.js";
import { recordAuthEvent } from "./identity.js";
import {
  challengeTiming,
  CODE_TTL_S,
  CODE_UNAVAILABLE,
  codeExpired,
  codeHash,
  coordinatorDown,
  countAttempt,
  expiredCode,
  incorrectCode,
  limitCodeSends,
  MAX_ATTEMPTS,
  newCode,
  RECORD_GRACE_S,
  requireResendAllowed,
  tooManyAttempts,
  type CodeChallenge,
} from "./emailCode.js";

/**
 * The codes that confirm a deletion: the account's (routes/account.ts) and a workspace's
 * (routes/workspaces.ts). Each is emailed to the account's own address, whatever the session signed
 * in with (a Google account linked under another address can't prove that one), and follows the
 * sign-in code's rules (emailCode.ts: a minute's life, five guesses, one a minute, the address's
 * hourly and daily caps). Its minute and its guesses are checked before the code is looked at, and
 * the right one is spent with one atomic take, so of two answers racing only one goes on.
 *
 * What is kept, in the coordinator under the target's key: the code's HMAC (codeHash, bound to the
 * target and the moment it was issued), never the code, and when it was issued. A code asked for one
 * target confirms nothing else: not the account, not another workspace.
 */
export interface DeletionTarget {
  /** Where the standing code is kept. */
  key: string;
  /** What its HMAC and its guesses are bound to. */
  scope(issuedAt: number): string;
}

/** What a deletion is confirmed with: DELETE typed out, and the emailed code. */
export const deletionConfirmation = z.object({
  confirm: z.literal("DELETE", { error: "Type DELETE to confirm." }),
  code: z.string().trim().regex(EMAIL_CODE_RE, "Enter the 6-digit code from the email."),
});

export const accountDeletion = (userId: string): DeletionTarget => ({ key: `auth:code:delete:${userId}`, scope: (t) => `delete:${userId}:${t}` });
export const workspaceDeletion = (userId: string, workspaceId: string): DeletionTarget => ({
  key: `auth:code:delete-ws:${userId}:${workspaceId}`,
  scope: (t) => `delete-ws:${userId}:${workspaceId}:${t}`,
});

interface DeletionCode {
  v: 1;
  codeHash: string;
  issuedAt: number;
}

async function standingCode(deps: Pick<Deps, "coord">, target: DeletionTarget): Promise<DeletionCode | null> {
  const raw = await deps.coord.peek(target.key).catch((err: unknown) => {
    logger.error({ err }, "could not read a deletion code");
    throw coordinatorDown();
  });
  if (!raw) return null;
  const rec = JSON.parse(raw) as DeletionCode;
  return rec?.v === 1 && typeof rec.issuedAt === "number" ? rec : null;
}

/** Email `user` a new code for `target` (`mail` words it) and record it; its countdowns for the page. */
export async function sendDeletionCode(
  c: Ctx,
  deps: Pick<Deps, "coord" | "mailer">,
  user: User,
  target: DeletionTarget,
  mail: (code: string) => { subject: string; text: string; html: string; purpose: EmailPurpose },
): Promise<CodeChallenge> {
  const standing = await standingCode(deps, target);
  if (standing) requireResendAllowed(standing.issuedAt);
  await limitCodeSends(deps.coord, user.email, clientIp(c));
  const now = Date.now();
  const code = newCode();
  const m = mail(code);
  // The email goes first: a code that couldn't be sent is never recorded as standing.
  await deps.mailer.send(user.email, m.subject, m.text, m.html, { purpose: m.purpose }).catch((err: unknown) => {
    logger.error({ err }, "could not email a deletion code");
    throw new HttpError(503, CODE_UNAVAILABLE, "email_unavailable");
  });
  const rec: DeletionCode = { v: 1, codeHash: codeHash(target.scope(now), code), issuedAt: now };
  await deps.coord.put(target.key, JSON.stringify(rec), CODE_TTL_S + RECORD_GRACE_S).catch((err: unknown) => {
    logger.error({ err }, "could not store a deletion code");
    throw coordinatorDown();
  });
  return challengeTiming(now, now);
}

/**
 * The code given for `target`, checked and counted as a guess but not spent: a refusal for another
 * reason after this (the person became a sole owner meanwhile) leaves it standing. The fifth wrong
 * guess ends it.
 */
export async function checkDeletionCode(deps: Pick<Deps, "coord">, target: DeletionTarget, code: string): Promise<void> {
  const pending = await standingCode(deps, target);
  if (!pending) throw new HttpError(400, "Ask for a code first: we'll email it to your account's address.", "code_required");
  if (codeExpired(pending.issuedAt)) throw expiredCode();
  const scope = target.scope(pending.issuedAt);
  const attempt = await countAttempt(deps.coord, scope);
  if (safeEqual(pending.codeHash, codeHash(scope, code))) return;
  if (attempt >= MAX_ATTEMPTS) {
    await deps.coord.take(target.key).catch((err: unknown) => logger.warn({ err }, "could not discard a deletion code"));
    throw tooManyAttempts();
  }
  throw incorrectCode();
}

/** Spend the code checkDeletionCode accepted: of two answers racing, the second finds it gone (expired_code). */
export async function spendDeletionCode(deps: Pick<Deps, "coord">, target: DeletionTarget): Promise<void> {
  const spent = await deps.coord.take(target.key).catch((err: unknown) => {
    logger.error({ err }, "could not spend a deletion code");
    throw coordinatorDown();
  });
  if (!spent) throw expiredCode();
}

/**
 * Delete a workspace once its code is spent (core workspaceDeletion.ts). A rule it checks first
 * (paid_plan) is answered as is. Anything else stopped it part way: logged as deletion_incomplete
 * and recorded as the person's workspace_deletion_incomplete event (docs/RUNBOOK.md, "Deleting a
 * workspace"), and the person is told to try again, which finishes it.
 */
export async function runWorkspaceDeletion(c: Ctx, deps: Pick<Deps, "fetchImpl">, user: User, workspaceId: string, via: "workspace" | "account") {
  try {
    return await deleteWorkspace(workspaceId, { userId: user.id, ip: clientIp(c), via }, deps);
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err, workspaceId, userId: user.id, via, code: "deletion_incomplete" }, "workspace deletion incomplete: the code was spent but the workspace is still there; ask the owner to try again or finish it by hand (docs/RUNBOOK.md)");
    await recordAuthEvent("workspace_deletion_incomplete", user.id, clientIp(c), { workspaceId, via });
    const support = env().SUPPORT_EMAIL;
    throw new HttpError(
      503,
      `We couldn't finish deleting the workspace. What was already removed stays removed. Try again in a few minutes${support ? `; if it fails again, email ${support} and we'll finish it` : ""}.`,
      "deletion_incomplete",
    );
  }
}
