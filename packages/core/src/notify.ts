import { systemDb } from "@app/db";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { FetchLike } from "./shopify.js";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Minimal shape of the Cloudflare Email Sending binding (`send_email`). */
export interface SendEmailBinding {
  send(message: { to: string; from: string | { email: string; name: string }; subject: string; text: string }): Promise<unknown>;
}

/** "Name <addr@x>" -> { name, email }; a bare address stays a string. */
export function parseFrom(from: string): string | { email: string; name: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return from.trim();
  return m[1] ? { email: m[2]!, name: m[1].replace(/^"|"$/g, "") } : m[2]!;
}

/** Sends through Cloudflare Email Sending. The From domain must be onboarded. */
export function cloudflareMailer(binding: SendEmailBinding): Mailer {
  return {
    async send(to, subject, text) {
      await binding.send({ to, from: parseFrom(env().EMAIL_FROM), subject, text });
    },
  };
}

/**
 * Local development: deliver through Mailpit's HTTP send API so codes and
 * invites show up in the Mailpit inbox (http://localhost:8025), as they did
 * with SMTP. Selected when MAILPIT_URL is set (never set it in production).
 */
export function mailpitMailer(baseUrl: string, fetchImpl: FetchLike = fetch): Mailer {
  return {
    async send(to, subject, text) {
      const from = parseFrom(env().EMAIL_FROM);
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: typeof from === "string" ? { Email: from } : { Email: from.email, Name: from.name },
          To: [{ Email: to }],
          Subject: subject,
          Text: text,
        }),
      });
      if (!res.ok) throw new Error(`Mailpit send failed (${res.status})`);
    },
  };
}

/** In-memory mailer for tests. */
export function memoryMailer(): Mailer & { sent: Array<{ to: string; subject: string; text: string }> } {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  return {
    sent,
    async send(to, subject, text) {
      sent.push({ to, subject, text });
    },
  };
}

/**
 * Raise a workspace alert: persisted (shown in the UI), emailed to members who
 * opted in to sync-failure notifications, and posted to Slack if configured.
 * De-duplicated: an unresolved alert with the same code+store is not repeated.
 */
export async function raiseAlert(
  input: { workspaceId: string; storeId?: string | null; severity: "info" | "warning" | "critical"; code: string; message: string },
  mailer: Mailer,
  fetchImpl: FetchLike = fetch,
) {
  const open = await systemDb.alert.findFirst({
    where: { workspaceId: input.workspaceId, storeId: input.storeId ?? null, code: input.code, resolvedAt: null },
  });
  if (open) return open;
  const alert = await systemDb.alert.create({ data: { ...input, storeId: input.storeId ?? null } });
  logger.warn({ alert }, "alert raised");

  try {
    const recipients = await systemDb.membership.findMany({
      where: { workspaceId: input.workspaceId, role: { in: ["owner", "admin"] } },
      include: { user: true },
    });
    const prefs = await systemDb.notificationPreference.findMany({
      where: { workspaceId: input.workspaceId, syncFailures: false },
    });
    const optedOut = new Set(prefs.map((p) => p.userId));
    for (const m of recipients) {
      if (optedOut.has(m.userId)) continue;
      await mailer.send(m.user.email, `[${input.severity}] ${input.code}`, input.message);
    }
    const hook = env().ALERT_SLACK_WEBHOOK_URL;
    if (hook) {
      await fetchImpl(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `:warning: ${input.code} (${input.workspaceId}): ${input.message}` }),
      });
    }
  } catch (err) {
    logger.error({ err }, "alert notification failed");
  }
  return alert;
}

export async function audit(input: {
  workspaceId: string;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}) {
  await systemDb.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: (input.metadata ?? undefined) as never,
      ip: input.ip,
    },
  });
}
