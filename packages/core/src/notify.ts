import { systemDb } from "@app/db";
import { ALERT_PATH, describeAlert } from "@app/shared/alerts";
import { escapeHtml } from "@app/shared/email";
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

type StoredAlert = { id: string; code: string; severity: string; message: string };

/**
 * The email an owner or admin gets for an alert: the bell's wording (describeAlert) and a link to
 * the page where it gets fixed. Never the stored message as is: for sync and webhook failures it
 * ends with the error's own text, which only the logs keep.
 */
export function alertEmail(alert: StoredAlert, where: { workspace: string | null; store: string | null }) {
  const w = describeAlert(alert);
  const fixUrl = `${env().APP_URL}${ALERT_PATH[w.area]}`;
  const prefsUrl = `${env().APP_URL}/settings/notifications`;
  const action = w.area === "general" ? "Get help" : "Open bizinsights";
  const context = [where.store && `Store: ${where.store}`, where.workspace && `Workspace: ${where.workspace}`].filter(Boolean).join(" · ");
  const member = where.workspace ? `an owner or admin of ${where.workspace}` : "a workspace owner or admin";
  const why = `You get this email as ${member}. To stop these emails, turn off "Sync problems" in`;
  const text = [w.title, "", w.body, ...(context ? ["", context] : []), "", `${action}: ${fixUrl}`, "", `${why} Settings → Notifications: ${prefsUrl}`].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1b18">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e0;border-radius:12px;padding:28px">
<tr><td>
${context ? `<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#2f6f4f">${e(context)}</p>\n` : ""}<h1 style="margin:0 0 16px;font-size:20px">${e(w.title)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.5">${e(w.body)}</p>
<p style="margin:0 0 24px"><a href="${e(fixUrl)}" style="display:inline-block;background:#2f6f4f;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">${action}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6b63">Button not working? Paste this into your browser:<br><span style="word-break:break-all">${e(fixUrl)}</span></p>
</td></tr></table>
<p style="font-size:12px;color:#6b6b63">${e(why)} <a href="${e(prefsUrl)}" style="color:#6b6b63">Settings → Notifications</a>.</p>
</td></tr></table></body></html>`;
  return { subject: w.title, text, html };
}

/**
 * Raise a workspace alert: persisted (shown in the UI), emailed to members who
 * opted in to sync-failure notifications, and posted to Slack if configured.
 * De-duplicated: an unresolved alert with the same code+store is not repeated, so
 * whatever fixes the problem must resolve it (see resolveAlerts) or the next
 * incident goes unannounced.
 *
 * The message is internal: it is logged here and nowhere else. The email and the Slack post are
 * worded from the code (alertEmail, describeAlert); Slack adds the ids that find this log line.
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
  // The logger drops any `code` key (it can be an OAuth code), so the alert's goes in as alertCode.
  logger.warn({ alertId: alert.id, alertCode: alert.code, alert }, "alert raised");

  // Names for the email and Slack. Best effort: without them both still go out.
  const [workspace, store] = await Promise.all([
    systemDb.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true } }),
    input.storeId ? systemDb.store.findUnique({ where: { id: input.storeId }, select: { name: true, shopDomain: true } }) : null,
  ]).catch((err: unknown) => {
    logger.error({ err, alertId: alert.id }, "alert workspace and store names could not be loaded");
    return [null, null] as const;
  });

  // Each channel and each recipient on its own: one address the sender refuses (or no working
  // sender at all) used to abort the loop, so later members and Slack never heard about it.
  try {
    const email = alertEmail(alert, { workspace: workspace?.name ?? null, store: store ? (store.name ?? store.shopDomain) : null });
    const recipients = await systemDb.membership.findMany({
      where: { workspaceId: input.workspaceId, role: { in: ["owner", "admin"] }, revokedAt: null },
      include: { user: true },
    });
    const prefs = await systemDb.notificationPreference.findMany({
      where: { workspaceId: input.workspaceId, syncFailures: false },
    });
    const optedOut = new Set(prefs.map((p) => p.userId));
    for (const m of recipients) {
      if (optedOut.has(m.userId)) continue;
      await mailer.send(m.user.email, email.subject, email.text, email.html).catch((err: unknown) => {
        logger.error({ err, alertId: alert.id, userId: m.userId }, "alert email failed");
      });
    }
  } catch (err) {
    logger.error({ err, alertId: alert.id }, "alert email recipients could not be loaded");
  }
  // The team's channel, but a third party's history all the same: the code and ids to look into it
  // with, not the error's text (in the "alert raised" log line, found by its alertId).
  const hook = env().ALERT_SLACK_WEBHOOK_URL;
  if (hook) {
    try {
      const where = [store && `store ${store.shopDomain}`, `workspace ${input.workspaceId}`].filter(Boolean).join(", ");
      const text = `:warning: [${alert.severity}] ${alert.code}: ${describeAlert(alert).title} (${where}). Error details: logs, alertId ${alert.id}`;
      const res = await fetchImpl(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
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
