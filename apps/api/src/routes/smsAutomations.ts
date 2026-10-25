import { z } from "zod";
import { withTenant } from "@app/db";
import {
  activateAutomation,
  automationOf,
  contactFirstName,
  deleteAutomation,
  duplicateAutomation,
  estimateAudience,
  listAutomations,
  messagingReadiness,
  pauseAutomation,
  saveAutomation,
  sendingProblems,
  smsMode,
  testAutomation,
  triggerCapabilities,
  validateAutomation,
  verifyTriggerSubscriptions,
} from "@app/core/sms";
import { CONSENT_LABEL, SMS_TRIGGERS, smsAudienceSchema } from "@app/shared/sms";
import { body, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { actorOf, base, publicMessage, requireSmsContacts, SMS_MANAGE, SMS_READ, smsDeps, smsStore } from "./smsCommon.js";

/**
 * Automations, the builder (packages/core/src/sms/builder.ts): which triggers the store's Shopify
 * connection delivers, the automations with their real state and last result, who they text, the
 * checks before one is switched on (readiness.ts), and saving, testing, activating, pausing,
 * copying and deleting them. Looking needs Marketing → campaigns (choosing customers by name also
 * "View contact information"); every change is for owners and admins, like the rest of Customer
 * Messaging's. Access is checked before any input is read.
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

  /** The list: every automation, what stops the store's texts reaching anyone right now, and the store's readiness in a word. */
  app.get(auto, async (c) => {
    const { store } = await reader(c);
    const [automations, problems, readiness] = await Promise.all([listAutomations(store), sendingProblems(store), messagingReadiness(store, smsDeps(deps))]);
    return c.json({ mode: smsMode(), timezone: store.timezone, automations, problems, readiness });
  });

  /** Step 2: about how many customers a segment or a choice of customers could reach now (an estimate: changes nothing). */
  app.post(`${auto}/audience`, async (c) => {
    const { store } = await reader(c);
    await limit(deps.coord, `rl:sms-estimate:${store.id}`, LIMITS.smsEstimate);
    const input = z.object({ trigger: z.enum(SMS_TRIGGERS), audience: smsAudienceSchema }).parse(await body(c));
    return c.json(await estimateAudience(store.id, input.trigger, input.audience));
  });

  /**
   * Step 2's "Specific customers": the store's customers with a mobile number, by first name or the
   * number's last digits (masked), or the ones with these ids. Names and numbers need "View contact
   * information".
   */
  app.get(`${auto}/audience/customers`, async (c) => {
    const ws = c.req.param("ws")!;
    await requireSmsContacts(c, deps, ws);
    const store = await smsStore(ws, c.req.param("storeId")!);
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 40);
    const ids = (c.req.query("ids") ?? "").split(",").filter((x) => /^[a-z0-9]{1,40}$/i.test(x)).slice(0, 50);
    const digits = q.replace(/\D/g, "");
    // Names are encrypted: the most recent customers are read and matched here.
    const rows = await withTenant(ws, (tx) =>
      tx.smsContact.findMany({
        where: { workspaceId: ws, storeId: store.id, ...(ids.length ? { id: { in: ids } } : digits.length >= 2 && digits.length === q.length ? { phoneMasked: { endsWith: digits.slice(-3) } } : {}) },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: ids.length ? ids.length : 1000,
      }),
    );
    const found = rows
      .map((r) => ({ id: r.id, name: contactFirstName(r), number: r.phoneMasked, country: r.country, consent: r.consentState, consentLabel: CONSENT_LABEL[r.consentState as keyof typeof CONSENT_LABEL] ?? r.consentState, optedOut: r.suppressedAll, orders: r.ordersCount }))
      .filter((r) => ids.length || !q || digits.length === q.length || (r.name ?? "").toLowerCase().startsWith(q));
    return c.json({ customers: found.slice(0, 50) });
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

  /** The review step's checks, in words, and whether switching it on would be accepted now (activate refuses the same). */
  app.get(`${auto}/:id/checks`, async (c) => {
    const { store } = await reader(c);
    const id = c.req.param("id");
    await automationOf(store, id);
    return c.json(await validateAutomation(store, id, smsDeps(deps)));
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
