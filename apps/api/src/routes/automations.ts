import { z } from "zod";
import {
  actOnHubAutomation,
  decodeCursor,
  deleteHubAutomation,
  emailDisconnect,
  emailTestConnection,
  hubAudit,
  hubAutomation,
  hubAutomations,
  hubConnections,
  hubHistory,
  hubMessageDetail,
  hubPermissions,
  hubStats,
  hubTriggers,
  retryHubMessage,
  saveHubAutomation,
  smsConnect,
  smsDisconnect,
  testHubAutomation,
  type HubActor,
  type HubContext,
} from "@app/core/automations";
import { previewTemplate } from "@app/core";
import { smsMode } from "@app/core/sms";
import { allows, localDay } from "@app/shared";
import {
  checkEmailMessage,
  emailCategoryOf,
  emailEventFor,
  HUB_CHANNELS,
  HUB_STATUSES,
  HUB_TRIGGERS,
  textToEmailHtml,
  type HubChannel,
} from "@app/shared/automations";
import { endOfLocalDay, startOfLocalDay } from "@app/shared/staff";
import { body, clientIp, HttpError, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { smsDeps, smsStore } from "./smsCommon.js";

/**
 * Automations: one four-step setup (connect a channel, choose a trigger, write the message, review
 * and activate) and one place to watch every channel's automated messages
 * (packages/core/src/automations, docs/automations.md). Each channel's own engine does the work
 * and keeps its own rules; this only routes to it.
 *
 * Tenancy: the workspace in the path only selects, membership is checked on every request (a
 * non-member gets 404), and the store is looked up inside that workspace (`?storeId=`, else none).
 * Permissions are each channel's own (hubPermissions): a member sees and changes only the
 * channels their access covers. API keys are refused: the hub changes what customers receive.
 */
export function automationRoutes(app: App, deps: Deps) {
  const base = "/workspaces/:ws/automations";

  /** The member, their permissions per channel, and the page's store (in this workspace, or none). */
  async function hub(c: Ctx): Promise<{ ctx: HubContext; actor: HubActor }> {
    if (c.req.header("authorization")) throw new HttpError(403, "Automations can't be used with an API key", "forbidden");
    const ws = c.req.param("ws")!;
    // Any of the channels' read permissions lets someone in; each call then checks its own channel's.
    const a = await requireWorkspace(c, deps, ws, ["marketing.campaigns", "integrations.status"]);
    const storeId = c.req.query("storeId");
    const store = storeId ? await smsStore(ws, storeId) : null;
    const user = a.user!;
    return {
      ctx: { workspaceId: ws, store, deps: { ...smsDeps(deps), smtpConnect: deps.smtpConnect }, can: hubPermissions(a.access) },
      actor: { userId: user.id, ip: clientIp(c), email: user.email, emailVerified: user.emailVerified },
    };
  }

  const channelParam = (c: Ctx): HubChannel => {
    const ch = c.req.param("channel");
    if (!ch || !(HUB_CHANNELS as readonly string[]).includes(ch)) throw new HttpError(404, "Not found", "not_found");
    return ch as HubChannel;
  };

  /** Writes are paced per workspace (each one may change what customers receive). */
  const paced = (ws: string) => limit(deps.coord, `rl:automations:${ws}`, LIMITS.automations);

  // ---------------------------------------------------------------- overview and step 1

  /** Everything the hub's first page shows: permissions, each channel's connection, every automation. */
  app.get(`${base}`, async (c) => {
    const { ctx } = await hub(c);
    const [connections, automations] = await Promise.all([hubConnections(ctx), hubAutomations(ctx)]);
    return c.json({ permissions: ctx.can, smsMode: smsMode(), storeId: ctx.store?.id ?? null, connections, automations });
  });

  app.get(`${base}/connections`, async (c) => {
    const { ctx } = await hub(c);
    return c.json({ connections: await hubConnections(ctx), permissions: ctx.can });
  });

  /** SMS: connect, reconnect or test (asks AWS about the platform's SMS account now; no keys anywhere). */
  app.post(`${base}/connections/sms/:op{connect|test}`, async (c) => {
    const { ctx, actor } = await hub(c);
    await paced(ctx.workspaceId);
    return c.json({ connection: await smsConnect(ctx, actor) });
  });

  app.post(`${base}/connections/sms/disconnect`, async (c) => {
    const { ctx, actor } = await hub(c);
    await paced(ctx.workspaceId);
    return c.json({ connection: await smsDisconnect(ctx, actor) });
  });

  /** Email: ask the provider whether a connected mailbox can send (connecting itself is the email module's OAuth or SMTP flow). */
  app.post(`${base}/connections/email/:accountId/test`, async (c) => {
    const { ctx, actor } = await hub(c);
    await limit(deps.coord, `rl:email:test:${ctx.workspaceId}`, LIMITS.emailTest);
    return c.json(await emailTestConnection(ctx, c.req.param("accountId"), actor));
  });

  app.post(`${base}/connections/email/:accountId/disconnect`, async (c) => {
    const { ctx, actor } = await hub(c);
    await paced(ctx.workspaceId);
    return c.json({ connection: await emailDisconnect(ctx, c.req.param("accountId"), actor) });
  });

  // ---------------------------------------------------------------- step 2

  app.get(`${base}/triggers`, async (c) => {
    const { ctx } = await hub(c);
    return c.json({ triggers: await hubTriggers(ctx) });
  });

  /** Ask Shopify about the store's per-store subscriptions now (and make missing ones), then answer again. */
  app.post(`${base}/triggers/verify`, async (c) => {
    const { ctx } = await hub(c);
    if (!ctx.can.manage.sms) throw new HttpError(403, "You don't have permission to do that", "forbidden");
    if (ctx.store) await limit(deps.coord, `rl:sms-verify:${ctx.store.id}`, LIMITS.smsVerify);
    return c.json({ triggers: await hubTriggers(ctx, true) });
  });

  // ---------------------------------------------------------------- step 3: the email preview (SMS previews in the browser)

  const previewInput = z.object({
    trigger: z.enum(HUB_TRIGGERS),
    customEvent: z.string().max(130).nullish(),
    category: z.enum(["transactional", "marketing"]).nullish(),
    subject: z.string().max(250),
    text: z.string().max(20_000),
  });

  app.post(`${base}/preview/email`, async (c) => {
    const { ctx, actor } = await hub(c);
    if (!ctx.can.manage.email) throw new HttpError(403, "You don't have permission to do that", "forbidden");
    await limit(deps.coord, `rl:email:preview:${actor.userId}`, LIMITS.emailPreview);
    const input = previewInput.parse(await body(c));
    const eventType = emailEventFor(input.trigger, input.customEvent);
    const category = emailCategoryOf(input);
    const issues = checkEmailMessage(input, eventType, category);
    if (issues.some((i) => i.level === "error")) return c.json({ preview: null, issues });
    const preview = await previewTemplate(ctx.workspaceId, { subject: input.subject, html: textToEmailHtml(input.text), text: input.text, category, eventType });
    return c.json({ preview, issues });
  });

  // ---------------------------------------------------------------- automations (steps 3 and 4, and the list's controls)

  const items = `${base}/items/:channel`;

  app.get(`${items}/:id`, async (c) => {
    const { ctx } = await hub(c);
    return c.json({ automation: await hubAutomation(ctx, channelParam(c), c.req.param("id")) });
  });

  app.post(items, async (c) => {
    const { ctx, actor } = await hub(c);
    const channel = channelParam(c);
    await paced(ctx.workspaceId);
    return c.json({ automation: await saveHubAutomation(ctx, channel, null, await body(c), actor) }, 201);
  });

  app.put(`${items}/:id`, async (c) => {
    const { ctx, actor } = await hub(c);
    const channel = channelParam(c);
    await paced(ctx.workspaceId);
    return c.json({ automation: await saveHubAutomation(ctx, channel, c.req.param("id"), await body(c), actor) });
  });

  /** On, pause, resume, disable. Turning on or resuming may reach real customers, so it needs `confirm`. */
  app.post(`${items}/:id/:action{activate|pause|resume|disable}`, async (c) => {
    const { ctx, actor } = await hub(c);
    const channel = channelParam(c);
    await paced(ctx.workspaceId);
    const { confirm } = z.object({ confirm: z.boolean().optional() }).parse(await body(c));
    const action = c.req.param("action") as "activate" | "pause" | "resume" | "disable";
    return c.json({ automation: await actOnHubAutomation(ctx, channel, c.req.param("id"), action, confirm === true, actor) });
  });

  app.delete(`${items}/:id`, async (c) => {
    const { ctx, actor } = await hub(c);
    const channel = channelParam(c);
    await paced(ctx.workspaceId);
    return c.json(await deleteHubAutomation(ctx, channel, c.req.param("id"), actor));
  });

  /** A test of the saved message: SMS to a verified test number (`requestId` per press), email to the member's own address. */
  app.post(`${items}/:id/test`, async (c) => {
    const { ctx, actor } = await hub(c);
    const channel = channelParam(c);
    const input = z
      .object({
        testNumberId: z.string().min(1).max(40).nullish(),
        requestId: z
          .string()
          .regex(/^[A-Za-z0-9-]{8,64}$/)
          .nullish(),
      })
      .parse(await body(c));
    if (channel === "sms" && ctx.store) await limit(deps.coord, `rl:sms-test:${ctx.store.id}`, LIMITS.smsTest);
    if (channel === "email") await limit(deps.coord, `rl:email:testsend:${ctx.workspaceId}`, LIMITS.emailTestSend);
    return c.json({ message: await testHubAutomation(ctx, channel, c.req.param("id"), input, actor) });
  });

  // ---------------------------------------------------------------- step 4 afterwards: history, figures, audit

  const day = /^\d{4}-\d{2}-\d{2}$/;
  const DAY_MS = 86_400_000;

  /** `?from=&to=` as the store's days (UTC without a store), inclusive; the last 30 days by default, at most 400. */
  function period(c: Ctx, timeZone: string): { from: Date; to: Date } {
    const q = c.req.query();
    if ((q.from && !day.test(q.from)) || (q.to && !day.test(q.to))) throw new HttpError(400, "from and to must be dates (YYYY-MM-DD)", "invalid_range");
    const today = localDay(new Date(), timeZone);
    const to = new Date(endOfLocalDay(q.to ?? today, timeZone));
    const from = q.from ? new Date(startOfLocalDay(q.from, timeZone)) : new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) throw new HttpError(400, "from must be before to", "invalid_range");
    if (to.getTime() - from.getTime() > 400 * DAY_MS) throw new HttpError(400, "A range can be at most 400 days", "invalid_range");
    return { from, to };
  }

  const historyQuery = z.object({
    channel: z.enum(["sms", "email"]).optional(),
    status: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",").filter(Boolean) : []))
      .pipe(z.array(z.enum(HUB_STATUSES)).max(HUB_STATUSES.length)),
    automation: z
      .string()
      .regex(/^(sms|email):[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  app.get(`${base}/messages`, async (c) => {
    const { ctx } = await hub(c);
    const q = historyQuery.parse(c.req.query());
    const { from, to } = period(c, ctx.store?.timezone || "UTC");
    const [ach, aid] = q.automation ? (q.automation.split(":") as [HubChannel, string]) : [null, null];
    const cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) throw new HttpError(400, "That page link has expired: start from the first page.", "invalid_cursor");
    const page = await hubHistory(ctx, { channels: q.channel ? [q.channel] : ["sms", "email"], statuses: q.status, automation: ach && aid ? { channel: ach, id: aid } : null, from, to, cursor, limit: q.limit });
    return c.json({ ...page, timeZone: ctx.store?.timezone || "UTC", from: from.toISOString(), to: to.toISOString(), visible: { sms: ctx.can.history.sms && !!ctx.store, email: ctx.can.history.email } });
  });

  app.get(`${base}/messages/:channel/:id`, async (c) => {
    const { ctx } = await hub(c);
    return c.json(await hubMessageDetail(ctx, channelParam(c), c.req.param("id")));
  });

  /** Send a failed message again: the member's decision (only where the channel allows it; SMS never re-sends by hand). */
  app.post(`${base}/messages/:channel/:id/retry`, async (c) => {
    const { ctx, actor } = await hub(c);
    const channel = channelParam(c);
    await limit(deps.coord, `rl:email:retry:${ctx.workspaceId}`, LIMITS.emailRetry);
    return c.json({ message: await retryHubMessage(ctx, channel, c.req.param("id"), actor) });
  });

  app.get(`${base}/stats`, async (c) => {
    const { ctx } = await hub(c);
    const { from, to } = period(c, ctx.store?.timezone || "UTC");
    return c.json(await hubStats(ctx, from, to));
  });

  /** Every configuration change of the hub's channels (owners and admins). */
  app.get(`${base}/audit`, async (c) => {
    const { ctx } = await hub(c);
    const a = await requireWorkspace(c, deps, ctx.workspaceId, "audit:read");
    if (!allows(a.access, "audit:read")) throw new HttpError(403, "Only owners and admins see the audit trail", "forbidden");
    const before = c.req.query("before");
    const at = before ? new Date(before) : null;
    if (before && (!at || Number.isNaN(at.getTime()))) throw new HttpError(400, "before must be a timestamp", "invalid_before");
    const lim = z.coerce.number().int().min(1).max(100).default(50).parse(c.req.query("limit") ?? undefined);
    return c.json(await hubAudit(ctx, { before: at, limit: lim }));
  });
}
