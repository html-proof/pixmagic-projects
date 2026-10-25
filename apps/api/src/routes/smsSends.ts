import { allows } from "@app/shared";
import { SMS_CATEGORIES, type SmsCategory } from "@app/shared/sms";
import { cancelSend, createSend, listSends, previewSend, sendCustomers, sendSummary, smsMode } from "@app/core/sms";
import { body, HttpError, requireWorkspace, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { actorNames, actorOf, base, requireSmsContacts, SMS_MANAGE, SMS_READ, smsDeps, smsStore } from "./smsCommon.js";

/**
 * Send SMS (packages/core/src/sms/sends.ts): choose customers, choose or write the message,
 * review it, then send now or at a time, follow each text to its delivery, and cancel what hasn't
 * gone. Seeing the sends needs Marketing → campaigns, and each customer's (masked) number also
 * "View contact information"; sending is for owners and admins who may see contact information.
 * Access is checked before any input is read.
 */
export function smsSendRoutes(app: App, deps: Deps) {
  const sends = `${base}/sends`;
  const SEND_ID = /^[A-Za-z0-9-]{8,64}$/;

  const sender = async (c: Ctx) => {
    const ws = c.req.param("ws")!;
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    if (!allows(a.access, "customers.contact")) throw new HttpError(403, "Sending to customers needs “View contact information”, since it shows their (masked) numbers", "forbidden");
    const store = await smsStore(ws, c.req.param("storeId")!);
    return { store, actor: actorOf(c, a) };
  };
  const sendId = (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!SEND_ID.test(id)) throw new HttpError(404, "Send not found.", "not_found");
    return id;
  };

  /** The store's sends of the last 60 days: what each sent and where its texts are, without numbers. */
  app.get(sends, async (c) => {
    const ws = c.req.param("ws")!;
    await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, c.req.param("storeId")!);
    const list = await listSends(store);
    const who = await actorNames(list.map((s) => s.createdBy));
    return c.json({ mode: smsMode(), sends: list.map((s) => ({ ...s, createdBy: who(s.createdBy) })) });
  });

  /** Step 1: customers to choose from, by first name or the number's last digits, each with whether they can get a message of that kind now. */
  app.get(`${sends}/customers`, async (c) => {
    const { store } = await sender(c);
    const category = c.req.query("category");
    const ids = (c.req.query("ids") ?? "").split(",").filter((x) => /^[a-z0-9]{1,40}$/i.test(x));
    return c.json(await sendCustomers(store, { q: c.req.query("q") ?? "", ids, category: (SMS_CATEGORIES as readonly string[]).includes(category ?? "") ? (category as SmsCategory) : undefined }));
  });

  /** Step 3: the text as it will read, its parts, who won't get it and why, the cost and what stops it (changes nothing). */
  app.post(`${sends}/preview`, async (c) => {
    const { store } = await sender(c);
    await limit(deps.coord, `rl:sms-preview:${store.id}`, LIMITS.smsPreview);
    return c.json(await previewSend(store, await body(c), smsDeps(deps)));
  });

  /** Step 4: send now or at a time. `requestId` (one per press of Send) makes a repeat return the send already made. */
  app.post(sends, async (c) => {
    const { store, actor } = await sender(c);
    await limit(deps.coord, `rl:sms-send:${store.id}`, LIMITS.smsSend);
    const send = await createSend(store, await body(c), smsDeps(deps), actor);
    return c.json({ send: { ...send, createdBy: (await actorNames([send.createdBy]))(send.createdBy) } }, 201);
  });

  /** One send as it goes: each customer's text, Queued → Sent → Delivered (or why not). */
  app.get(`${sends}/:id`, async (c) => {
    const ws = c.req.param("ws")!;
    await requireSmsContacts(c, deps, ws);
    const store = await smsStore(ws, c.req.param("storeId")!);
    const send = await sendSummary(store, sendId(c));
    return c.json({ send: { ...send, createdBy: (await actorNames([send.createdBy]))(send.createdBy) } });
  });

  /** Cancel every text of a send that hasn't gone. */
  app.post(`${sends}/:id/cancel`, async (c) => {
    const ws = c.req.param("ws")!;
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, c.req.param("storeId")!);
    const send = await cancelSend(store, sendId(c), actorOf(c, a));
    return c.json({ send: { ...send, createdBy: (await actorNames([send.createdBy]))(send.createdBy) } });
  });
}
