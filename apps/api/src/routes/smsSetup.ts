import { z } from "zod";
import { withTenant } from "@app/db";
import {
  checkSetupSender,
  connectSms,
  disconnectSms,
  partPrice,
  requestSetupSender,
  saveSetupDraft,
  saveSetupMessage,
  setAutomaticSms,
  setSetupAutomation,
  setupState,
  smsMode,
  useSharedSender,
} from "@app/core/sms";
import { can } from "@app/shared";
import { SETUP_AUTOMATIONS, smsSetupDraftSchema, type SmsTrigger } from "@app/shared/sms";
import { body, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { actorOf, base, publicMessage, publicSender, SMS_MANAGE, SMS_READ, smsDeps, smsStore } from "./smsCommon.js";

/**
 * Set up SMS (packages/core/src/sms/setup.ts): the five-step setup and the SMS Settings page read
 * GET …/sms/setup; every change is for owners and admins, like the rest of Customer Messaging's.
 * AWS is reached with the function's role: no key or secret is ever asked for or answered.
 */

const SETUP_TRIGGERS = SETUP_AUTOMATIONS.filter((a) => a.trigger && !a.unavailable).map((a) => a.trigger as string);

export function smsSetupRoutes(app: App, deps: Deps) {
  const setupBase = `${base}/setup`;

  /** The setup's state. Members who can't change it see it too (without the AWS identity or the test numbers). */
  const answer = async (ws: string, store: Awaited<ReturnType<typeof smsStore>>, manage: boolean, showText: boolean) => {
    const s = await setupState(store);
    const [price, testNumbers] = await Promise.all([
      partPrice(s.senderName.country),
      manage ? withTenant(ws, (tx) => tx.smsTestNumber.findMany({ where: { workspaceId: ws, storeId: store.id }, orderBy: { createdAt: "asc" } })) : [],
    ]);
    return {
      mode: smsMode(),
      step: s.step,
      businessName: s.businessName,
      defaultBusinessName: s.defaultBusinessName,
      connection: { ...s.connection, provider: "AWS End User Messaging SMS" },
      senderName: s.senderName,
      sender: s.sender ? publicSender(s.sender, manage) : null,
      message: s.message,
      templateId: s.templateId,
      automations: s.automations,
      sending: s.sending,
      price: price ? { country: s.senderName.country, perPartUsd: price.usd, source: price.source } : null,
      testNumbers: testNumbers.map((t) => ({ id: t.id, number: t.phoneMasked, country: t.country, status: t.status })),
      lastTest: s.lastTest ? publicMessage(s.lastTest, showText) : null,
      completedAt: s.completedAt,
      done: s.done,
    };
  };

  /** An owner or admin changing the setup: who, which store, within the setup's rate. */
  const manager = async (c: Ctx) => {
    const ws = c.req.param("ws")!;
    const storeId = c.req.param("storeId")!;
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-setup:${storeId}`, LIMITS.smsSetup);
    return { ws, a, store, actor: actorOf(c, a) };
  };

  app.get(setupBase, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    const manage = can(a.role, SMS_MANAGE) && !a.link && !!a.user;
    return c.json(await answer(ws, store, manage, manage));
  });

  /** "Save draft": whatever the merchant has so far, and the step to come back to. */
  app.put(setupBase, async (c) => {
    const { ws, store, actor } = await manager(c);
    await saveSetupDraft(store, smsSetupDraftSchema.parse(await body(c)), actor);
    return c.json(await answer(ws, store, true, true));
  });

  app.post(`${setupBase}/connect`, async (c) => {
    const { ws, store, actor } = await manager(c);
    await limit(deps.coord, `rl:sms-verify:${store.id}`, LIMITS.smsVerify);
    const r = await connectSms(store, smsDeps(deps), actor);
    return c.json({ result: r, setup: await answer(ws, store, true, true) });
  });

  app.post(`${setupBase}/disconnect`, async (c) => {
    const { ws, store, actor } = await manager(c);
    await disconnectSms(store, actor);
    return c.json(await answer(ws, store, true, true));
  });

  /** "Check status": what AWS has for the sender name (approved only on AWS's word). */
  app.post(`${setupBase}/sender/check`, async (c) => {
    const { ws, store, actor } = await manager(c);
    await limit(deps.coord, `rl:sms-verify:${store.id}`, LIMITS.smsVerify);
    const r = await checkSetupSender(store, smsDeps(deps), actor);
    return c.json({ result: r, setup: await answer(ws, store, true, true) });
  });

  /** "Request sender name": recorded, and sent to the platform owner to set up with AWS. */
  app.post(`${setupBase}/sender/request`, async (c) => {
    const { ws, a, store, actor } = await manager(c);
    await limit(deps.coord, `rl:sms-sender-request:${store.id}`, LIMITS.smsSenderRequest);
    const r = await requestSetupSender(store, smsDeps(deps), { ...actor, email: a.user?.email ?? null });
    return c.json({ result: r, setup: await answer(ws, store, true, true) });
  });

  app.post(`${setupBase}/sender/shared`, async (c) => {
    const { ws, store, actor } = await manager(c);
    await limit(deps.coord, `rl:sms-verify:${store.id}`, LIMITS.smsVerify);
    await useSharedSender(store, smsDeps(deps), actor);
    return c.json(await answer(ws, store, true, true));
  });

  /** Step 3: the order confirmation, saved as its template. */
  app.post(`${setupBase}/message`, async (c) => {
    const { ws, store, actor } = await manager(c);
    const input = z.object({ body: z.string().max(2000) }).parse(await body(c));
    const r = await saveSetupMessage(store, input.body, actor);
    return c.json({ result: r, setup: await answer(ws, store, true, true) });
  });

  /** Step 5: one order update's message, on or off (on needs `confirm`: it may text real customers). */
  app.put(`${setupBase}/automations/:trigger`, async (c) => {
    const { ws, store, actor } = await manager(c);
    const { trigger } = c.req.param();
    if (!SETUP_TRIGGERS.includes(trigger)) return c.json({ error: "automation_unavailable", message: "This automatic text isn't available." }, 400);
    const input = z.object({ body: z.string().max(2000).nullish(), on: z.boolean(), confirm: z.boolean().optional() }).parse(await body(c));
    const r = await setSetupAutomation(store, trigger as SmsTrigger, input, actor);
    return c.json({ result: r, setup: await answer(ws, store, true, true) });
  });

  /** "Enable Automatic SMS": the store's sending switch. */
  app.post(`${setupBase}/automatic`, async (c) => {
    const { ws, store, actor } = await manager(c);
    const input = z.object({ on: z.boolean() }).parse(await body(c));
    await setAutomaticSms(store, input.on, actor);
    return c.json(await answer(ws, store, true, true));
  });
}
