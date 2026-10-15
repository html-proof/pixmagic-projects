import { afterAll, it } from "vitest";
import { disconnectDb, systemDb, type Prisma } from "@app/db";
import {
  applyMetaWebhook,
  purgeStoreData,
  memoryCoord,
  memoryQueues,
  newLinkToken,
  sendWhatsappMessage,
  waEncrypt,
  whatsappOnShopifyEvent,
  type FetchLike,
} from "@app/core";
import { TEMPLATE_LIBRARY, whatsappConfigSchema } from "@app/shared";

/**
 * Sample data for the LOCAL WhatsApp demo (database wa_demo; see vitest.config.ts). Everything goes
 * through the real code: Shopify events → timelines and messages → the sender (Meta simulated
 * here, nothing leaves the machine) → delivery callbacks. Then timestamps are spread over the
 * past days so the history and charts look lived-in. Test values only.
 */

afterAll(async () => disconnectDb());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let wamid = 0;
const failFor = new Set(["919000000013"]);
const fetchImpl: FetchLike = async (input, init) => {
  const u = new URL(String(input));
  if (u.hostname === "graph.facebook.com" && u.pathname.endsWith("/messages")) {
    const to = JSON.parse(String(init?.body)).to as string;
    if (failFor.has(to)) return json({ error: { code: 131026, message: "Message undeliverable", type: "OAuthException" } }, 400);
    return json({ messages: [{ id: `wamid.DEMO${++wamid}` }] });
  }
  throw new Error(`demo seed: unexpected fetch ${u}`);
};
const deps = { coord: memoryCoord(), queues: memoryQueues(), fetchImpl };

let rnd = 7;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]!;

const NAMES = ["Asha", "Rahul", "Meera", "Anand", "Fatima", "Joseph", "Lakshmi", "Arjun", "Divya", "Thomas", "Nisha", "Vivek", "Sana", "Kiran", "Riya", "Manu"];
const PRODUCTS = [
  { id: 801, title: "Kerala Kasavu Saree", price: 3499 },
  { id: 802, title: "Handloom Cotton Kurta", price: 1299 },
  { id: 803, title: "Brass Nilavilakku Lamp", price: 2199 },
  { id: 804, title: "Coir Door Mat", price: 499 },
  { id: 805, title: "Spice Gift Box", price: 899 },
];

it("seeds the WhatsApp demo", async () => {
  const email = process.env.WA_DEMO_EMAIL ?? "demo.merchant@example.com";
  const user = await systemDb.user.findUnique({ where: { email } });
  if (!user) throw new Error(`Sign in as ${email} on http://localhost:8793 first`);

  // ---- workspace and store (a re-run starts over)
  await purgeStoreData("wa_demo_store");
  await systemDb.workspace.deleteMany({ where: { id: "wa_demo_ws" } });
  await systemDb.store.deleteMany({ where: { id: "wa_demo_store" } });
  const ws = await systemDb.workspace.create({ data: { id: "wa_demo_ws", name: "Green Leaf Sarees" } });
  await systemDb.membership.create({ data: { workspaceId: ws.id, userId: user.id, role: "owner" } });
  await systemDb.subscription.create({ data: { workspaceId: ws.id, plan: "free" } });
  const store = await systemDb.store.create({
    data: {
      id: "wa_demo_store",
      workspaceId: ws.id,
      shopDomain: "green-leaf-sarees.myshopify.com",
      name: "Green Leaf Sarees (sample data)",
      timezone: "Asia/Kolkata",
      currency: "INR",
      status: "active",
      grantedScopes: ["read_orders", "read_products"],
      pixelIngestKey: "pk_wa_demo",
      installedAt: new Date(Date.now() - 60 * 86_400_000),
      lastSyncedAt: new Date(),
    },
  });

  // ---- WhatsApp: settings, connection, templates
  const lib = (name: string) => TEMPLATE_LIBRARY.find((t) => t.name === name)!;
  const on = (name: string) => ({ enabled: true, templateName: name, language: "en", mapping: lib(name).mapping });
  const config = whatsappConfigSchema.parse({
    transactionalBasis: "checkout_notice",
    smsConsentCountsForMarketing: true,
    sendWindowStart: 0,
    sendWindowEnd: 23,
    supportPhone: "+91 484 290 1234",
    supportEmail: "care@greenleaf.example",
    notifications: {
      order_confirmation: on("insights_order_confirmation"),
      payment_confirmed: on("insights_payment_confirmed"),
      order_shipped: on("insights_order_shipped"),
      out_for_delivery: on("insights_out_for_delivery"),
      order_delivered: on("insights_order_delivered"),
      delivery_failed: on("insights_delivery_failed"),
      order_cancelled: on("insights_order_cancelled"),
      abandoned_cart_1: on("insights_cart_reminder"),
      review_request: on("insights_review_request"),
    },
  });
  await systemDb.whatsappSettings.create({ data: { storeId: store.id, workspaceId: ws.id, config: config as unknown as Prisma.InputJsonValue, basisSetByUserId: user.id, basisSetAt: new Date() } });
  const verify = newLinkToken();
  const conn = await systemDb.whatsappConnection.create({
    data: {
      workspaceId: ws.id,
      storeId: store.id,
      mode: "manual",
      wabaId: "1029384756",
      wabaName: "Green Leaf Sarees",
      phoneNumberId: "1122334455",
      displayPhoneNumber: "+91 484 290 1234",
      verifiedName: "Green Leaf Sarees",
      nameStatus: "APPROVED",
      qualityRating: "GREEN",
      messagingLimitTier: "TIER_1K",
      registered: true,
      status: "active",
      accessTokenEnc: waEncrypt(store.id, "access", "EAAdemo-not-a-real-token"),
      appSecretEnc: waEncrypt(store.id, "app_secret", "0".repeat(32)),
      verifyTokenEnc: waEncrypt(store.id, "verify", `wa_vt_${verify.token.slice(0, 20)}`),
      verifyTokenHash: verify.hash,
      tokenKeyVersion: 1,
      webhookVerifiedAt: new Date(Date.now() - 6 * 86_400_000),
      lastWebhookAt: new Date(Date.now() - 4 * 60_000),
      lastSyncedAt: new Date(Date.now() - 2 * 3600_000),
      connectedByUserId: user.id,
    },
  });
  for (const t of TEMPLATE_LIBRARY) {
    const components: Array<Record<string, unknown>> = [{ type: "BODY", text: t.body }];
    const buttons: Array<Record<string, unknown>> = [];
    if (t.urlButton) buttons.push({ type: "URL", text: t.urlButton.text, url: `http://localhost:8793${t.urlButton.base === "api" ? "/api" : ""}${t.urlButton.path}{{1}}` });
    if (t.stopButton) buttons.push({ type: "QUICK_REPLY", text: "Stop promotions" });
    if (buttons.length) components.push({ type: "BUTTONS", buttons });
    const status = t.name === "insights_order_packed" ? "PENDING" : t.name === "insights_refund_processed" ? "REJECTED" : "APPROVED";
    await systemDb.whatsappTemplate.create({
      data: {
        workspaceId: ws.id,
        storeId: store.id,
        connectionId: conn.id,
        metaId: `demo-${t.name}`,
        name: t.name,
        language: "en",
        category: t.category,
        status,
        components: components as Prisma.InputJsonValue,
        rejectedReason: status === "REJECTED" ? "INCORRECT_CATEGORY" : null,
        qualityScore: status === "APPROVED" ? "GREEN" : null,
      },
    });
  }

  // ---- orders through the real pipeline
  const send = async () => {
    for (const m of await systemDb.whatsappMessage.findMany({ where: { storeId: store.id, status: "scheduled", scheduledFor: { lte: new Date(Date.now() + 1000) } } })) {
      await sendWhatsappMessage(m.id, deps);
    }
  };
  const status = async (id: string, s: string) => {
    await applyMetaWebhook(
      { object: "whatsapp_business_account", entry: [{ id: conn.wabaId, changes: [{ field: "messages", value: { metadata: { phone_number_id: conn.phoneNumberId }, statuses: [{ id, status: s, timestamp: String(Math.floor(Date.now() / 1000)), pricing: { billable: true, category: "utility" } }] } }] }] },
      "all",
      deps,
    );
  };
  const orders: Array<{ id: number; ageH: number; phone: string }> = [];
  for (let i = 0; i < 26; i++) {
    const id = 6_000_100 + i;
    const name = NAMES[i % NAMES.length]!;
    const phone = `9190000000${String(i).padStart(2, "0")}`;
    const items = [pick(PRODUCTS), ...(rand() < 0.4 ? [pick(PRODUCTS)] : [])].filter((p, n, a) => a.findIndex((x) => x.id === p.id) === n);
    const total = items.reduce((s, p) => s + p.price, 0);
    const p = {
      id,
      name: `#${1040 + i}`,
      currency: "INR",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cancelled_at: i === 21 ? new Date().toISOString() : null,
      financial_status: i % 7 === 3 ? "pending" : "paid",
      total_price: String(total),
      tags: "",
      customer: { id: 900 + (i % 14), first_name: name, sms_marketing_consent: { state: i % 3 === 0 ? "subscribed" : "not_subscribed" } },
      shipping_address: { first_name: name, address1: `${10 + i} MG Road`, city: pick(["Kochi", "Thrissur", "Kozhikode", "Bengaluru", "Dubai"]), zip: "682016", country: "India", country_code: "IN", phone: `+${phone}` },
      line_items: items.map((it, n) => ({ id: id * 10 + n, product_id: it.id, title: it.title, quantity: 1, price: String(it.price) })),
      checkout_token: i === 5 || i === 9 ? `ck-demo-${i}` : null,
      fulfillments: [] as unknown[],
    };
    if (i === 5 || i === 9) {
      // These two started as abandoned checkouts that got a reminder first.
      await whatsappOnShopifyEvent(store, "checkouts/create", { token: `ck-demo-${i}`, created_at: new Date().toISOString(), updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(), currency: "INR", total_price: String(total), abandoned_checkout_url: `https://green-leaf-sarees.myshopify.com/7/checkouts/ck${i}/recover?key=demo`, buyer_accepts_sms_marketing: true, phone: `+${phone}`, shipping_address: { first_name: name, country_code: "IN" }, line_items: items.map((it) => ({ title: it.title, quantity: 1, price: String(it.price), product_id: it.id })) }, deps);
      await systemDb.whatsappMessage.updateMany({ where: { storeId: store.id, kind: "abandoned_cart_1", status: "scheduled" }, data: { scheduledFor: new Date(Date.now() - 1000) } });
      await send();
    }
    // The order comes after the reminder (it's what made the cart "recovered").
    p.created_at = p.updated_at = new Date().toISOString();
    await whatsappOnShopifyEvent(store, "orders/create", p, deps);
    if (p.financial_status === "pending" && i < 15) await whatsappOnShopifyEvent(store, "orders/paid", { ...p, financial_status: "paid", updated_at: new Date().toISOString() }, deps);
    if (i === 21) await whatsappOnShopifyEvent(store, "orders/cancelled", p, deps);
    if (i < 18 && i !== 21) {
      const fid = id * 3;
      await whatsappOnShopifyEvent(store, "orders/updated", { ...p, updated_at: new Date().toISOString(), fulfillments: [{ id: fid, status: "success", created_at: new Date().toISOString(), tracking_company: pick(["Blue Dart", "Delhivery", "India Post", "DTDC"]), tracking_number: `DEMO${id}`, tracking_url: i % 4 === 0 ? null : `https://courier.example/track/DEMO${id}` }] }, deps);
      if (i < 13) await whatsappOnShopifyEvent(store, "fulfillment_events/create", { id: id * 7, fulfillment_id: fid, order_id: id, status: "out_for_delivery", happened_at: new Date().toISOString() }, deps);
      if (i < 11) await whatsappOnShopifyEvent(store, "fulfillment_events/create", { id: id * 7 + 1, fulfillment_id: fid, order_id: id, status: "delivered", happened_at: new Date().toISOString(), estimated_delivery_at: null }, deps);
      if (i === 12) await whatsappOnShopifyEvent(store, "fulfillment_events/create", { id: id * 7 + 2, fulfillment_id: fid, order_id: id, status: "attempted_delivery", happened_at: new Date().toISOString() }, deps);
    }
    await send();
    orders.push({ id, ageH: i < 18 ? 24 * (9 - i / 2.2) : 3 + i, phone });
  }
  // Review requests for the first few deliveries: due now.
  await systemDb.whatsappMessage.updateMany({ where: { storeId: store.id, kind: "review_request", trackingId: { not: null } }, data: { scheduledFor: new Date(Date.now() - 1000) } });
  const reviewMsgs = await systemDb.whatsappMessage.findMany({ where: { storeId: store.id, kind: "review_request" }, take: 6 });
  for (const m of reviewMsgs) await sendWhatsappMessage(m.id, deps);
  await systemDb.whatsappMessage.updateMany({ where: { storeId: store.id, kind: "review_request", status: "scheduled" }, data: { scheduledFor: new Date(Date.now() + 2 * 86_400_000) } });

  // Delivery callbacks: most delivered, many read.
  for (const m of await systemDb.whatsappMessage.findMany({ where: { storeId: store.id, providerMessageId: { not: null } } })) {
    if (rand() < 0.93) await status(m.providerMessageId!, "delivered");
    if (rand() < 0.62) await status(m.providerMessageId!, "read");
  }

  // ---- open abandoned checkouts (one without consent)
  for (let i = 0; i < 4; i++) {
    const phone = `+9190000001${i}`;
    await whatsappOnShopifyEvent(store, "checkouts/create", {
      token: `ck-open-${i}`,
      created_at: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
      updated_at: new Date(Date.now() - (i + 0.5) * 3600_000).toISOString(),
      currency: "INR",
      total_price: String(PRODUCTS[i]!.price),
      abandoned_checkout_url: `https://green-leaf-sarees.myshopify.com/7/checkouts/open${i}/recover?key=demo`,
      buyer_accepts_sms_marketing: i !== 2,
      phone,
      shipping_address: { first_name: NAMES[(i + 5) % NAMES.length], country_code: "IN" },
      line_items: [{ title: PRODUCTS[i]!.title, quantity: 1, price: String(PRODUCTS[i]!.price), product_id: PRODUCTS[i]!.id }],
    }, deps);
  }
  const firstOpen = await systemDb.whatsappMessage.findFirst({ where: { storeId: store.id, kind: "abandoned_cart_1", status: "scheduled" } });
  if (firstOpen) {
    await systemDb.whatsappMessage.update({ where: { id: firstOpen.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    await sendWhatsappMessage(firstOpen.id, deps);
  }

  // ---- reviews from customers whose orders were delivered
  const delivered = await systemDb.orderTracking.findMany({ where: { storeId: store.id, deliveredAt: { not: null } }, orderBy: { orderCreatedAt: "asc" }, take: 7 });
  const texts: Array<[number, string, string]> = [
    [5, "Beautiful saree, exactly as pictured. Packed with care.", "published"],
    [4, "Lovely quality, delivery took a day longer than expected.", "published"],
    [5, "The lamp is gorgeous. Will order again for Vishu.", "published"],
    [2, "The box arrived crushed and one corner of the mat was damaged.", "pending"],
    [3, "Good product but the colour is a little lighter than the photo.", "pending"],
    [1, "BUY CHEAP FOLLOWERS at spam.example", "rejected"],
    [5, "", "pending"],
  ];
  for (const [n, t] of delivered.entries()) {
    const [rating, body, st] = texts[n]!;
    const items = t.items as Array<{ productId: string; title: string }>;
    await systemDb.customerReview.create({
      data: {
        workspaceId: ws.id,
        storeId: store.id,
        trackingId: t.id,
        shopifyOrderId: t.shopifyOrderId,
        orderName: t.orderName,
        productId: n % 2 ? items[0]!.productId : "",
        productTitle: n % 2 ? items[0]!.title : null,
        rating,
        body: body || null,
        reviewerName: n === 5 ? "Promo" : `${NAMES[n]} ${"KMRSTV"[n % 6]}.`,
        status: st,
        moderationReason: st === "rejected" ? "spam" : null,
        moderatedAt: st === "pending" ? null : new Date(),
        moderatedByUserId: st === "pending" ? null : user.id,
        submittedAt: new Date(Date.now() - (7 - n) * 86_400_000),
      },
    });
  }

  // ---- marketing: opted-in contacts, one STOP, a finished campaign and a draft
  const contacts = await systemDb.whatsappContact.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } });
  for (const [n, c] of contacts.entries()) {
    if (n % 4 === 1) await systemDb.whatsappContact.update({ where: { id: c.id }, data: { marketingStatus: "opted_in", marketingSource: "whatsapp_keyword", marketingUpdatedAt: new Date() } });
  }
  await systemDb.whatsappContact.update({ where: { id: contacts[7]!.id }, data: { optedOut: true, optedOutAt: new Date(Date.now() - 3 * 86_400_000), optOutSource: "whatsapp_keyword", marketingStatus: "opted_out", marketingSource: "whatsapp_keyword" } });
  const onam = await systemDb.whatsappCampaign.create({
    data: {
      workspaceId: ws.id,
      storeId: store.id,
      name: "Onam festival offers",
      occasion: "onam",
      objective: "Bring back last season's saree buyers",
      templateName: "insights_seasonal_offer",
      templateLanguage: "en",
      mapping: lib("insights_seasonal_offer").mapping as Prisma.InputJsonValue,
      variables: { greeting: "Happy Onam", discountPercentage: "20", endDate: "15 September" },
      linkUrl: "https://green-leaf-sarees.myshopify.com/collections/onam",
      discountCode: "ONAM20",
      audience: { segment: "all_opted_in" },
      startAt: new Date(Date.now() - 8 * 86_400_000),
      endAt: new Date(Date.now() - 1 * 86_400_000),
      status: "completed",
      estimatedRecipients: 0,
      approvedByUserId: user.id,
      approvedAt: new Date(Date.now() - 9 * 86_400_000),
      startedAt: new Date(Date.now() - 8 * 86_400_000),
      completedAt: new Date(Date.now() - 1 * 86_400_000),
      createdByUserId: user.id,
    },
  });
  const eligible = await systemDb.whatsappContact.findMany({ where: { storeId: store.id, marketingStatus: "opted_in", optedOut: false } });
  for (const [n, c] of eligible.entries()) {
    const sentAt = new Date(Date.now() - 8 * 86_400_000 + n * 60_000);
    await systemDb.whatsappMessage.create({
      data: {
        workspaceId: ws.id,
        storeId: store.id,
        contactId: c.id,
        kind: "campaign",
        category: "marketing",
        templateName: "insights_seasonal_offer",
        templateLanguage: "en",
        dedupeKey: `campaign:${onam.id}:${c.id}`,
        phoneMasked: c.phoneMasked,
        campaignId: onam.id,
        status: n % 5 === 4 ? "delivered" : "read",
        scheduledFor: sentAt,
        sentAt,
        deliveredAt: new Date(sentAt.getTime() + 20_000),
        readAt: n % 5 === 4 ? null : new Date(sentAt.getTime() + 3600_000),
        providerMessageId: `wamid.ONAM${n}`,
        pricingCategory: "marketing",
        billable: true,
        clickCode: `onamdemo${String(n).padStart(4, "0")}`,
        clickedAt: n % 2 ? new Date(sentAt.getTime() + 4000_000) : null,
        ...(n === 1 ? { attributedOrderId: String(6_000_100 + 30), attributedRevenue: 3499, attributedAt: new Date(sentAt.getTime() + 86_400_000) } : {}),
        createdAt: sentAt,
      },
    });
  }
  await systemDb.whatsappCampaign.update({ where: { id: onam.id }, data: { estimatedRecipients: eligible.length } });
  await systemDb.whatsappCampaign.create({
    data: {
      workspaceId: ws.id,
      storeId: store.id,
      name: "Diwali lights sale",
      occasion: "diwali",
      objective: "Lamps and gift boxes before Diwali",
      templateName: "insights_seasonal_offer",
      templateLanguage: "en",
      mapping: lib("insights_seasonal_offer").mapping as Prisma.InputJsonValue,
      variables: { greeting: "Happy Diwali", discountPercentage: "15", endDate: "22 October" },
      linkUrl: "https://green-leaf-sarees.myshopify.com/collections/diwali",
      discountCode: "DIWALI15",
      audience: { segment: "recent_buyers", days: 90 },
      startAt: new Date(Date.now() + 5 * 86_400_000),
      endAt: new Date(Date.now() + 12 * 86_400_000),
      createdByUserId: user.id,
    },
  });

  // ---- automation rules
  await systemDb.whatsappAutomationRule.create({
    data: {
      workspaceId: ws.id,
      storeId: store.id,
      name: "Tell the team about big orders",
      enabled: true,
      trigger: "order_created",
      conditions: [{ field: "order_value", op: "gte", value: 5000 }],
      action: { type: "internal_notification", message: "A big order came in: worth a personal thank-you" },
      createdByUserId: user.id,
    },
  });
  await systemDb.whatsappAutomationRule.create({
    data: {
      workspaceId: ws.id,
      storeId: store.id,
      name: "Stop review requests after a failed delivery",
      enabled: false,
      trigger: "tracking_updated",
      conditions: [{ field: "previous_message_status", op: "eq", value: "failed" }],
      action: { type: "cancel_pending", kinds: ["review_request"] },
      createdByUserId: user.id,
    },
  });

  // ---- spread the orders over the past days (history and charts)
  for (const o of orders) {
    const t = await systemDb.orderTracking.findUnique({ where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(o.id) } } });
    if (!t) continue;
    const shift = o.ageH * 3600_000;
    await systemDb.$executeRaw`UPDATE order_trackings SET order_created_at = order_created_at - (${shift} * interval '1 millisecond'), paid_at = paid_at - (${shift} * interval '1 millisecond'), delivered_at = delivered_at - (${shift * 0.4} * interval '1 millisecond') WHERE id = ${t.id}`;
    await systemDb.$executeRaw`UPDATE order_tracking_events SET occurred_at = occurred_at - (${shift} * interval '1 millisecond') + (EXTRACT(EPOCH FROM (occurred_at - created_at)) * interval '1 second') + (CASE type WHEN 'shipped' THEN interval '20 hours' WHEN 'out_for_delivery' THEN interval '50 hours' WHEN 'delivered' THEN interval '58 hours' WHEN 'delivery_failed' THEN interval '55 hours' ELSE interval '0' END) WHERE tracking_id = ${t.id}`;
    await systemDb.$executeRaw`UPDATE whatsapp_messages SET created_at = created_at - (${shift} * interval '1 millisecond') + (CASE kind WHEN 'order_shipped' THEN interval '20 hours' WHEN 'out_for_delivery' THEN interval '50 hours' WHEN 'order_delivered' THEN interval '58 hours' WHEN 'review_request' THEN interval '130 hours' ELSE interval '0' END),
      sent_at = sent_at - (${shift} * interval '1 millisecond') + (CASE kind WHEN 'order_shipped' THEN interval '20 hours' WHEN 'out_for_delivery' THEN interval '50 hours' WHEN 'order_delivered' THEN interval '58 hours' WHEN 'review_request' THEN interval '130 hours' ELSE interval '0' END),
      delivered_at = delivered_at - (${shift} * interval '1 millisecond') + interval '1 minute' + (CASE kind WHEN 'order_shipped' THEN interval '20 hours' WHEN 'out_for_delivery' THEN interval '50 hours' WHEN 'order_delivered' THEN interval '58 hours' WHEN 'review_request' THEN interval '130 hours' ELSE interval '0' END),
      read_at = read_at - (${shift} * interval '1 millisecond') + interval '40 minutes' + (CASE kind WHEN 'order_shipped' THEN interval '20 hours' WHEN 'out_for_delivery' THEN interval '50 hours' WHEN 'order_delivered' THEN interval '58 hours' WHEN 'review_request' THEN interval '130 hours' ELSE interval '0' END)
      WHERE tracking_id = ${t.id} AND status <> 'scheduled'`;
  }
  // Nothing in the future but what is genuinely scheduled.
  // (LEAST skips NULLs, so each column keeps its NULL.)
  await systemDb.$executeRaw`UPDATE whatsapp_messages SET created_at = LEAST(created_at, now()),
    sent_at = CASE WHEN sent_at IS NULL THEN NULL ELSE LEAST(sent_at, now()) END,
    delivered_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE LEAST(delivered_at, now()) END,
    read_at = CASE WHEN read_at IS NULL THEN NULL ELSE LEAST(read_at, now()) END
    WHERE store_id = ${store.id}`;
  await systemDb.$executeRaw`UPDATE order_tracking_events SET occurred_at = LEAST(occurred_at, now()) WHERE store_id = ${store.id}`;
});
