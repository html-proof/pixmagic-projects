import { z } from "zod";
import { withTenant } from "@app/db";
import { businessEventInput, isDay } from "@app/shared";
import { audit, createBusinessEvent, deleteBusinessEvent, listBusinessEvents, logger, updateBusinessEvent } from "@app/core";
import { body, clientIp, HttpError, requireWorkspace, type Ctx, type Deps, type WorkspaceAccess } from "../context.js";
import type { App } from "../app.js";

/**
 * A store's business events (the Profit sheet, /sheet; @app/shared/businessEvents): the team's notes
 * of what happened on some days. Whoever sees the store's sales sees them and may add, change or
 * remove them, as the team's shared calendar; a shared (view-only) dashboard and API keys may only
 * read them. Each change is audited.
 */
export function businessEventRoutes(app: App, deps: Deps) {
  const day = z.string().refine((s) => isDay(s), "Pick a real date (YYYY-MM-DD)");
  const listQuery = z.object({ from: day.optional(), to: day.optional() });

  /** The store, checked to be the workspace's: a 404 otherwise, the same as one that doesn't exist. */
  async function storeOf(ws: string, storeId: string) {
    return withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      return store;
    });
  }

  /** A change: someone signed in to the account itself, never a shared link or an API key. */
  function editor(a: WorkspaceAccess): string {
    if (a.link || !a.user) throw new HttpError(403, "The shared dashboard is view-only.", "forbidden");
    return a.user.id;
  }

  const auditEvent = (c: Ctx, ws: string, userId: string, action: string, metadata: Record<string, unknown>) =>
    audit({ workspaceId: ws, actorUserId: userId, action, targetType: "store", targetId: c.req.param("storeId"), metadata, ip: clientIp(c) }).catch((err: unknown) => logger.warn({ err }, "audit failed"));

  /** The store's events running on any day from `from` to `to` (every one without them), earliest first. */
  app.get("/workspaces/:ws/stores/:storeId/business-events", async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "analytics.sales");
    const q = listQuery.parse(c.req.query());
    if (!q.from !== !q.to) throw new HttpError(400, "Give both from and to, or neither.", "invalid_range");
    if (q.from && q.to && q.from > q.to) throw new HttpError(400, "The dates end before they start.", "invalid_range");
    await storeOf(ws, storeId);
    const events = await withTenant(ws, (tx) => listBusinessEvents(tx, { ws, storeId }, q.from && q.to ? { from: q.from, to: q.to } : undefined));
    return c.json({ events });
  });

  app.post("/workspaces/:ws/stores/:storeId/business-events", async (c) => {
    const { ws, storeId } = c.req.param();
    const userId = editor(await requireWorkspace(c, deps, ws, "analytics.sales"));
    const input = businessEventInput.parse(await body(c));
    await storeOf(ws, storeId);
    const event = await withTenant(ws, (tx) => createBusinessEvent(tx, { ws, storeId }, input, userId));
    await auditEvent(c, ws, userId, "business_event.created", { eventId: event.id, kind: event.kind, startsOn: event.startsOn, endsOn: event.endsOn });
    return c.json({ event }, 201);
  });

  app.put("/workspaces/:ws/stores/:storeId/business-events/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const userId = editor(await requireWorkspace(c, deps, ws, "analytics.sales"));
    const input = businessEventInput.parse(await body(c));
    await storeOf(ws, storeId);
    const result = await withTenant(ws, (tx) => updateBusinessEvent(tx, { ws, storeId }, id, input, userId));
    if (!result) throw new HttpError(404, "Not found", "not_found");
    const { saved, before } = result;
    await auditEvent(c, ws, userId, "business_event.updated", { eventId: id, kind: saved.kind, startsOn: saved.startsOn, endsOn: saved.endsOn, before: { kind: before.kind, startsOn: before.startsOn, endsOn: before.endsOn } });
    return c.json({ event: saved });
  });

  app.delete("/workspaces/:ws/stores/:storeId/business-events/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const userId = editor(await requireWorkspace(c, deps, ws, "analytics.sales"));
    await storeOf(ws, storeId);
    const removed = await withTenant(ws, (tx) => deleteBusinessEvent(tx, { ws, storeId }, id));
    if (!removed) throw new HttpError(404, "Not found", "not_found");
    await auditEvent(c, ws, userId, "business_event.deleted", { eventId: id, kind: removed.kind, startsOn: removed.startsOn, endsOn: removed.endsOn });
    return c.json({ ok: true });
  });
}
