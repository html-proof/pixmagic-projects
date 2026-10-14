import { z } from "zod";
import { systemDb, withTenant } from "@app/db";
import {
  addSuppression,
  createIngestKey,
  emailAnalytics,
  emailAudit,
  emailOverview,
  enqueueEmailSend,
  getEmailSettings,
  getMessage,
  listIngestKeys,
  listMessages,
  revokeIngestKey,
  updateEmailSettings,
} from "@app/core";
import { emailSettingsSchema, MESSAGE_STATUSES, suppressionCreateSchema } from "@app/shared/email";
import { body, HttpError, type Deps } from "../context.js";
import type { App } from "../app.js";
import { rangeQuery, requireEmail } from "../emailAccess.js";
import { cursorPage } from "../pagination.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Settings → Email → Overview and Activity, and the workspace-level email settings: numbers,
 * the message log (filtered and paged on the server), message details, retry and cancel,
 * suppressions, event API keys and the email part of the audit log.
 */
export function emailActivityRoutes(app: App, deps: Deps) {
  const base = "/workspaces/:ws/email";

  app.get(`${base}/overview`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    const { from, to } = rangeQuery(c.req.query());
    return c.json(await emailOverview(ws, from, to));
  });

  app.get(`${base}/analytics`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    const { from, to } = rangeQuery(c.req.query());
    return c.json(await emailAnalytics(ws, from, to));
  });

  // ---------------- Activity ----------------

  const filters = z.object({
    status: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",").filter(Boolean) : []))
      .pipe(z.array(z.enum(MESSAGE_STATUSES)).max(10)),
    accountId: z.string().max(64).optional(),
    provider: z.string().max(40).optional(),
    ruleId: z.string().max(64).optional(),
    kind: z.enum(["automation", "test", "verification"]).optional(),
    recipient: z.string().max(254).optional(),
  });

  app.get(`${base}/messages`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:activity");
    const q = c.req.query();
    const f = filters.parse(q);
    const { from, to } = rangeQuery(q);
    const page = cursorPage(q, 50);
    return c.json(await listMessages(ws, { ...f, from, to, cursor: q.cursor, limit: page.size }));
  });

  app.get(`${base}/messages/:id`, async (c) => {
    const { ws, id } = c.req.param();
    await requireEmail(c, deps, ws, "email:activity");
    return c.json({ message: await getMessage(ws, id) });
  });

  /**
   * Send a failed or unknown message again. A person's decision, since an "unknown" one may already
   * have arrived: Insights never does this on its own.
   */
  app.post(`${base}/messages/:id/retry`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    await limit(deps.coord, `rl:email:retry:${ws}`, LIMITS.emailRetry);
    const m = await withTenant(ws, (tx) => tx.emailMessage.findFirst({ where: { id, workspaceId: ws } }));
    if (!m) throw new HttpError(404, "Not found", "not_found");
    if (m.kind !== "automation") throw new HttpError(409, "Test emails can't be retried; send a new test instead.", "not_retryable");
    if (m.status !== "failed" && m.status !== "unknown") throw new HttpError(409, "Only failed messages, or ones whose outcome is unknown, can be retried.", "not_retryable");
    const now = new Date();
    const { count } = await systemDb.emailMessage.updateMany({
      where: { id: m.id, workspaceId: ws, status: { in: ["failed", "unknown"] } },
      data: { status: "queued", attempts: 0, scheduledAt: now, enqueuedAt: null, failedAt: null, lastErrorCode: null, lastErrorMessage: null },
    });
    if (!count) throw new HttpError(409, "The message changed in the meantime; reload and try again.", "conflict");
    await systemDb.emailMessageEvent.create({ data: { workspaceId: ws, messageId: m.id, eventType: "queued", metadata: { retriedBy: user.id, previousStatus: m.status } } });
    await enqueueEmailSend({ id: m.id, scheduledAt: now }, deps);
    await emailAudit({ workspaceId: ws, actorUserId: user.id, action: "email.message.retried", targetType: "email_message", targetId: m.id, metadata: { previousStatus: m.status } });
    return c.json({ message: await getMessage(ws, id) });
  });

  app.post(`${base}/messages/:id/cancel`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    const { count } = await systemDb.emailMessage.updateMany({
      where: { id, workspaceId: ws, status: { in: ["queued", "deferred"] } },
      data: { status: "cancelled", cancelledAt: new Date(), lastErrorCode: "cancelled_by_user" },
    });
    if (!count) throw new HttpError(409, "Only messages still waiting to send can be cancelled.", "not_cancellable");
    await systemDb.emailMessageEvent.create({ data: { workspaceId: ws, messageId: id, eventType: "cancelled", metadata: { code: "cancelled_by_user" } } });
    await emailAudit({ workspaceId: ws, actorUserId: user.id, action: "email.message.cancelled", targetType: "email_message", targetId: id });
    return c.json({ message: await getMessage(ws, id) });
  });

  // ---------------- Settings ----------------

  app.get(`${base}/settings`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    return c.json({ settings: await getEmailSettings(ws) });
  });

  app.patch(`${base}/settings`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const patch = emailSettingsSchema.parse(await body(c));
    return c.json({ settings: await updateEmailSettings(ws, user.id, patch, deps) });
  });

  // ---------------- Suppressions ----------------

  app.get(`${base}/suppressions`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:activity");
    const page = cursorPage(c.req.query(), 50);
    const rows = await withTenant(ws, (tx) => tx.emailSuppression.findMany({ where: { workspaceId: ws }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...page.args }));
    const { items, nextCursor } = page.split(rows);
    return c.json({ suppressions: items.map((s) => ({ id: s.id, email: s.emailMasked, reason: s.reason, scope: s.scope, source: s.source, createdAt: s.createdAt })), nextCursor });
  });

  app.post(`${base}/suppressions`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const input = suppressionCreateSchema.parse(await body(c));
    const r = await addSuppression({ workspaceId: ws, email: input.email, reason: input.reason, scope: input.scope, source: "manual", userId: user.id });
    await emailAudit({ workspaceId: ws, actorUserId: user.id, action: "email.suppression.added", metadata: { reason: input.reason, scope: input.scope, created: r.created } });
    return c.json(r);
  });

  app.delete(`${base}/suppressions/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const { count } = await withTenant(ws, (tx) => tx.emailSuppression.deleteMany({ where: { id, workspaceId: ws } }));
    if (!count) throw new HttpError(404, "Not found", "not_found");
    await emailAudit({ workspaceId: ws, actorUserId: user.id, action: "email.suppression.removed", targetType: "email_suppression", targetId: id });
    return c.json({ ok: true });
  });

  // ---------------- Event API keys ----------------

  app.get(`${base}/ingest-keys`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:manage");
    return c.json({ keys: await listIngestKeys(ws) });
  });

  app.post(`${base}/ingest-keys`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(await body(c));
    await limit(deps.coord, `rl:email:ingestkey:${ws}`, LIMITS.apiKeyCreate);
    return c.json(await createIngestKey(ws, user.id, name));
  });

  app.delete(`${base}/ingest-keys/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    await revokeIngestKey(ws, id, user.id);
    return c.json({ ok: true });
  });

  // ---------------- Audit ----------------

  /** The workspace's audit log, email entries only. */
  app.get(`${base}/audit-logs`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "audit:read");
    const page = cursorPage(c.req.query(), 50);
    const rows = await withTenant(ws, (tx) => tx.auditLog.findMany({ where: { workspaceId: ws, action: { startsWith: "email." } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...page.args }));
    const { items, nextCursor } = page.split(rows);
    const actorIds = [...new Set(items.map((r) => r.actorUserId).filter((a): a is string => !!a))];
    const actors = await systemDb.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } });
    const byId = new Map(actors.map((a) => [a.id, a.email]));
    return c.json({
      items: items.map((r) => ({ id: r.id, action: r.action, actor: r.actorUserId ? (byId.get(r.actorUserId) ?? null) : null, targetType: r.targetType, targetId: r.targetId, metadata: r.metadata, createdAt: r.createdAt })),
      nextCursor,
    });
  });
}
