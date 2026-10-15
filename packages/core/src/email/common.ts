/**
 * What every part of the email module shares: its dependencies, its error type, and the keyed
 * hash that stands in for an email address wherever one only needs to be recognised.
 */
import { createHmac } from "node:crypto";
import { normalizeEmail } from "@app/shared/email";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import type { Mailer } from "../notify.js";
import type { Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import type { SmtpConnect } from "./smtp.js";

export interface EmailDeps {
  coord: Coord;
  queues: Queues;
  fetchImpl: FetchLike;
  /** Insights' own mailer: alerts to the workspace's admins (an account needs reconnecting). */
  mailer: Mailer;
  /** Outbound TCP for SMTP accounts (apps/aws/src/nodeSmtp.ts). Absent: SMTP can't connect. */
  smtpConnect?: SmtpConnect;
}

/**
 * A rule of the email module the person using the app broke, or a state they must fix. The API
 * answers it with its status and code; the message is written for them.
 */
export class EmailError extends AppError {
  constructor(message: string, status: number, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "EmailError";
  }
}

export const notFound = (what = "Not found") => new EmailError(what, 404, "not_found");

/**
 * HMAC of an address, scoped to the workspace: finds suppressions, frequency limits and a
 * customer's events without storing the address, and can't be matched across workspaces.
 */
export function recipientHash(workspaceId: string, email: string): string {
  const normalized = normalizeEmail(email) ?? email.trim().toLowerCase();
  return createHmac("sha256", env().CUSTOMER_HASH_KEY).update(`email:${workspaceId}:${normalized}`).digest("hex");
}

/** The host part of APP_URL: our EHLO name and the right-hand side of our Message-IDs. */
export function appHost(): string {
  try {
    return new URL(env().APP_URL).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/** Audit an email change. Never fails the action it records (the action already happened). */
export async function emailAudit(input: {
  workspaceId: string;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}) {
  await audit(input).catch((err: unknown) => logger.warn({ err, action: input.action }, "email audit entry failed"));
}

/** Postgres unique violation, as Prisma reports it. */
export const isUniqueViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";

/** A short, safe excerpt of a provider's error text for storing and showing (no tokens, no addresses). */
export function safeErrorText(s: string | null | undefined, max = 300): string | null {
  if (!s) return null;
  const cleaned = s
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[token]")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "[token]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "$1***@$2")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
