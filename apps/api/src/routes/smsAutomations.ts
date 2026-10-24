import { z } from "zod";
import { withTenant } from "@app/db";
import {
  activateAutomation,
  automationOf,
  deleteAutomation,
  duplicateAutomation,
  listAutomations,
  pauseAutomation,
  saveAutomation,
  sendingProblems,
  smsMode,
  testAutomation,
  triggerCapabilities,
  verifyTriggerSubscriptions,
} from "@app/core/sms";
import { body, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { actorOf, base, publicMessage, SMS_MANAGE, SMS_READ, smsDeps, smsStore } from "./smsCommon.js";

/**
 * Automations, the four-step builder (packages/core/src/sms/builder.ts): which triggers the
 * store's Shopify connection delivers, the automations with their real state and last result,
 * and saving, testing, activating, pausing, copying and deleting them. Looking needs Marketing →
 * campaigns; every change is for owners and admins, like the rest of Customer Messaging's.
 * Access is checked before any input is read.
 */
export function smsAutomationRoutes(app: App, deps: Deps) {
  const auto = `${base}/automations`;

  const reader = async (c: Ctx) => {
    const ws = c.req.param("ws")!;
    await requireWorkspace(c, deps, ws, SMS_READ);
    return { ws, store: await smsStore(ws, c.req.param("storeId")!) };
  };
  const manager = async (c: Ctx) => {
    const ws = c.req.param("ws")!;
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, c.req.param("storeId")!);
    await limit(deps.coord, `rl:sms-setup:${store.id}`, LIMITS.smsSetup);
    return { ws, store, actor: actorOf(c, a) };
  };

  /** The list: every automation, and what stops the store's texts reaching anyone right now. */
  app.get(auto, async (c) => {
    const { store } = await reader(c);
    const [automations, problems] = await Promise.all([listAutomations(store), sendingProblems(store)]);
    return c.json({ mode: smsMode(), timezone: store.timezone, automations, problems });
  });

  /** Step 1: each trigger and whether Shopify sends it for this store, with the evidence. */
  app.get(`${auto}/triggers`, async (c) => {
    const { ws, store } = await reader(c);
    const [triggers, contacts] = await Promise.all([triggerCapabilities(store, deps.coord), withTenant(ws, (tx) => tx.smsContact.count({ where: { workspaceId: ws, storeId: store.id } }))]);
    return c.json({ triggers, contactsSeen: contacts });
  });

  /** "Check with Shopify": the store's per-store subscriptions asked about now (and made where missing). */
  app.post(`${auto}/triggers/verify`, async (c) => {
    const { store } = await manager(c);
    await limit(deps.coord, `rl:sms-verify:${store.id}`, LIMITS.smsVerify);
    return c.json({ triggers: await verifyTriggerSubscriptions(store, deps) });
  });

  app.get(`${auto}/:id`, async (c) => {
    const { store } = await reader(c);
    return c.json({ automation: await automationOf(store, c.req.param("id")) });
  });

  app.post(auto, async (c) => {
    const { store, actor } = await manager(c);
    return c.json({ automation: await saveAutomation(store, null, await body(c), actor) }, 201);
  });

  app.put(`${auto}/:id`, async (c) => {
    const { store, actor } = await manager(c);
    const id = c.req.param("id");
    await automationOf(store, id);
    return c.json({ automation: await saveAutomation(store, id, await body(c), actor) });
  });

  /** On (or the saved changes put live): needs `confirm`, since it may text real customers. */
  app.post(`${auto}/:id/activate`, async (c) => {
    const { store, actor } = await manager(c);
    const id = c.req.param("id");
    await automationOf(store, id);
    const input = z.object({ confirm: z.boolean().optional() }).parse(await body(c));
    return c.json({ automation: await activateAutomation(store, id, input, deps, actor) });
  });

  app.post(`${auto}/:id/pause`, async (c) => {
    const { store, actor } = await manager(c);
    return c.json({ automation: await pauseAutomation(store, c.req.param("id"), actor) });
  });

  app.post(`${auto}/:id/duplicate`, async (c) => {
    const { store, actor } = await manager(c);
    return c.json({ automation: await duplicateAutomation(store, c.req.param("id"), actor) }, 201);
  });

  app.delete(`${auto}/:id`, async (c) => {
    const { store, actor } = await manager(c);
    return c.json(await deleteAutomation(store, c.req.param("id"), actor));
  });

  /** Step 4's test text: the saved message to one of the team's verified numbers (one per press: `requestId`). */
  app.post(`${auto}/:id/test`, async (c) => {
    const { store, actor } = await manager(c);
    const id = c.req.param("id");
    await automationOf(store, id);
    await limit(deps.coord, `rl:sms-test:${store.id}`, LIMITS.smsTest);
    const input = z
      .object({
        testNumberId: z.string().min(1).max(40),
        requestId: z
          .string()
          .regex(/^[A-Za-z0-9-]{8,64}$/)
          .nullish(),
      })
      .parse(await body(c));
    const job = await testAutomation(store, id, input.testNumberId, input.requestId, smsDeps(deps), actor);
    return c.json({ message: publicMessage(job, true) });
  });
}
