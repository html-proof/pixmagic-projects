import { systemDb } from "@app/db";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { FetchLike } from "./shopify.js";

export interface Mailer {
  /** `html` is an optional rich version of `text` (which is always sent, for plain-text clients). */
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
}

/** "Name <addr@x>" -> { name, email }; a bare address stays a string. */
export function parseFrom(from: string): string | { email: string; name: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return from.trim();
  return m[1] ? { email: m[2]!, name: m[1].replace(/^"|"$/g, "") } : m[2]!;
}

/**
 * Local development: deliver through Mailpit's HTTP send API so codes and
 * invites show up in the Mailpit inbox (http://localhost:8025), as they did
 * with SMTP. Selected when MAILPIT_URL is set (never set it in production).
 */
export function mailpitMailer(baseUrl: string, fetchImpl: FetchLike = fetch): Mailer {
  return {
    async send(to, subject, text, html) {
      const from = parseFrom(env().EMAIL_FROM);
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: typeof from === "string" ? { Email: from } : { Email: from.email, Name: from.name },
          To: [{ Email: to }],
          Subject: subject,
          Text: text,
          ...(html ? { HTML: html } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Mailpit send failed (${res.status})`);
    },
  };
}

/** In-memory mailer for tests. */
export function memoryMailer(): Mailer & { sent: Array<{ to: string; subject: string; text: string; html?: string }> } {
  const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];
  return {
    sent,
    async send(to, subject, text, html) {
      sent.push({ to, subject, text, ...(html ? { html } : {}) });
    },
  };
}

/**
 * Raise a workspace alert: persisted (shown in the UI), emailed to members who
 * opted in to sync-failure notifications, and posted to Slack if configured.
 * De-duplicated: an unresolved alert with the same code+store is not repeated, so
 * whatever fixes the problem must resolve it (see resolveAlerts) or the next
 * incident goes unannounced.
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

  // Each channel and each recipient on its own: one address the sender refuses (or no working
  // sender at all) used to abort the loop, so later members and Slack never heard about it.
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
      await mailer.send(m.user.email, `[${input.severity}] ${input.code}`, input.message).catch((err: unknown) => {
        logger.error({ err, alertId: alert.id, userId: m.userId }, "alert email failed");
      });
    }
  } catch (err) {
    logger.error({ err, alertId: alert.id }, "alert email recipients could not be loaded");
  }
  const hook = env().ALERT_SLACK_WEBHOOK_URL;
  if (hook) {
    try {
      const res = await fetchImpl(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `:warning: ${input.code} (${input.workspaceId}): ${input.message}` }),
      });
      if (!res.ok) logger.error({ status: res.status, alertId: alert.id }, "alert Slack post rejected");
    } catch (err) {
      logger.error({ err, alertId: alert.id }, "alert Slack post failed");
    }
  }
  return alert;
}

/**
 * Close a store's open alerts once the thing they reported works again: the next successful
 * run of the same sync kind, or the next webhook processed for the store. Returns how many.
 */
export async function resolveAlerts(storeId: string, codes: string[]): Promise<number> {
  const { count } = await systemDb.alert.updateMany({
    where: { storeId, code: { in: codes }, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
  if (count) logger.info({ storeId, codes, count }, "alerts resolved");
  return count;
}

/**
 * Record a change in the workspace's audit log. Best effort, and never throws: every caller runs
 * it after the change it records has been committed, so failing here would turn that success into
 * an error (a 500 the client retries, repeating the change; a queue job retried for work already
 * done). A failure is logged, with what was being recorded, instead.
 */
export async function audit(input: {
  workspaceId: string;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}) {
  try {
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
  } catch (err) {
    logger.error({ err, workspaceId: input.workspaceId, action: input.action, targetType: input.targetType, targetId: input.targetId }, "audit log write failed");
  }
}
