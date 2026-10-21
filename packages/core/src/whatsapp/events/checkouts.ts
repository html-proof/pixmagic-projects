/**
 * Checkouts: abandoned cart reminders, and crediting an order to the cart reminder or campaign before it.
 */
import { Prisma, systemDb, type AbandonedCheckout, type OrderTracking, type WhatsappContact } from "@app/db";
import { kindSetting, type NotificationKind } from "@app/shared";
import { customerKey } from "../../persist.js";
import type { AutomationCheckout } from "../../shopifyPayloads.js";
import { runAutomations } from "../automations.js";
import { OPEN_CHECKOUT } from "../carts.js";
import { cancelScheduled, marketingAllowed, scheduleMessage } from "../messages.js";
import { upsertContact, waEncrypt } from "../store.js";
import { cartValues } from "../values.js";
import { automate, date, firstNameOf, itemsOf, phoneOf, smsSignal, valuesFor, type Ctx } from "./context.js";

/** A recovered cart: the order came within this long of a reminder that was sent. */
export const CART_ATTRIBUTION_MS = 7 * 86_400_000;

export async function onCheckout(ctx: Ctx, p: AutomationCheckout) {
  const token = p.token;
  const existing = await systemDb.abandonedCheckout.findUnique({ where: { storeId_checkoutToken: { storeId: ctx.store.id, checkoutToken: token } } });
  if (p.completed_at) {
    if (existing && OPEN_CHECKOUT.includes(existing.status)) {
      await systemDb.abandonedCheckout.update({ where: { id: existing.id }, data: { status: "completed", completedAt: date(p.completed_at) } });
      await cancelScheduled({ checkoutId: existing.id }, "checkout_completed");
    }
    return;
  }
  const phone = phoneOf(p);
  // Anonymous checkouts are never stored or messaged: only someone who typed a number at checkout can be reminded.
  if (!phone) return;
  const updatedAt = date(p.updated_at ?? p.created_at);
  if (existing && (!OPEN_CHECKOUT.includes(existing.status) || existing.lastActivityAt > updatedAt)) return;

  const ck = p.customer?.id ? customerKey(ctx.store, String(p.customer.id)) : null;
  const firstName = firstNameOf(p);
  const contact = await upsertContact(ctx.store, phone, { firstName, customerKey: ck, marketing: smsSignal(p) });
  const consent = marketingAllowed(ctx.cfg, contact);
  const items = itemsOf(p).map(({ title, quantity, price }) => ({ title, quantity, price }));
  const data = {
    contactId: contact.id,
    customerNameEnc: firstName ? waEncrypt(ctx.store.id, "name", firstName) : null,
    phoneMasked: contact.phoneMasked,
    currency: String(p.presentment_currency ?? p.currency ?? ctx.store.currency),
    totalPrice: new Prisma.Decimal(String(p.total_price ?? "0")),
    items: items as unknown as Prisma.InputJsonValue,
    recoveryUrlEnc: p.abandoned_checkout_url ? waEncrypt(ctx.store.id, "recovery", String(p.abandoned_checkout_url)) : null,
    marketingConsent: consent,
    lastActivityAt: updatedAt,
  };
  let checkout: AbandonedCheckout;
  try {
    checkout = existing
      ? await systemDb.abandonedCheckout.update({ where: { id: existing.id }, data })
      : await systemDb.abandonedCheckout.create({
          data: { ...data, workspaceId: ctx.store.workspaceId, storeId: ctx.store.id, checkoutToken: token, checkoutCreatedAt: date(p.created_at) },
        });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    return; // checkouts/create and /update raced: the other one stored it.
  }
  if (!ctx.connection) return;

  const values = cartValues(ctx.store, ctx.cfg, firstName?.split(/\s+/)[0] ?? null, data.totalPrice, data.currency);
  const recoveryUrl = p.abandoned_checkout_url ? String(p.abandoned_checkout_url) : null;
  let ineligible: string | null = null;
  for (const n of [1, 2] as const) {
    const kind: NotificationKind = n === 1 ? "abandoned_cart_1" : "abandoned_cart_2";
    const s = kindSetting(ctx.cfg, kind);
    if (!s.enabled || !s.templateName) continue;
    const template = await systemDb.whatsappTemplate.findUnique({
      where: { connectionId_name_language: { connectionId: ctx.connection.id, name: s.templateName, language: s.language } },
      select: { category: true },
    });
    // Cart reminders are marketing on WhatsApp: no consent, no reminder (and the dashboard says why).
    if ((template?.category ?? "MARKETING").toUpperCase() === "MARKETING" && !consent) {
      ineligible = "no_marketing_consent";
      continue;
    }
    if (!recoveryUrl) {
      ineligible = "no_checkout_link";
      continue;
    }
    const delay = n === 1 ? ctx.cfg.cartFirstDelayMinutes : ctx.cfg.cartFirstDelayMinutes + ctx.cfg.cartSecondDelayMinutes;
    const due = new Date(updatedAt.getTime() + delay * 60_000);
    // A checkout we hear about long after it was left: a reminder now would arrive days late.
    if (due.getTime() < Date.now() - 6 * 3600_000) continue;
    const { message, created } = await scheduleMessage(
      { store: ctx.store, kind, dedupeKey: `cart:${token}:${n}`, contact, template: { name: s.templateName, language: s.language }, mapping: s.mapping, values, scheduledFor: due, checkoutId: checkout.id, clickUrl: recoveryUrl },
      ctx.deps,
    );
    // Still shopping: the reminder moves back with every update.
    if (!created && message.status === "scheduled" && message.scheduledFor.getTime() !== due.getTime()) {
      await systemDb.whatsappMessage.update({ where: { id: message.id }, data: { scheduledFor: due, enqueuedAt: null } });
    }
  }
  if (ineligible && checkout.status === "open") {
    await systemDb.abandonedCheckout.update({ where: { id: checkout.id }, data: { status: "ineligible", ineligibleReason: ineligible } });
  } else if (!ineligible && checkout.status === "ineligible") {
    await systemDb.abandonedCheckout.update({ where: { id: checkout.id }, data: { status: "open", ineligibleReason: null } });
  }
  if (!existing) {
    await runAutomations(
      "checkout_abandoned",
      {
        key: `checkout:${token}`,
        store: ctx.store,
        cfg: ctx.cfg,
        contact,
        checkout,
        facts: { orderValue: Number(data.totalPrice), productTitles: items.map((i) => i.title), country: contact.country, marketingConsent: consent },
        values: { ...values, checkout_url: recoveryUrl },
        delayMinutes: ctx.cfg.cartFirstDelayMinutes,
      },
      ctx.deps,
    );
  }
}

/** The order for a checkout came in: reminders stop, and if one had been sent, the cart counts as recovered. */
export async function completeCheckout(ctx: Ctx, checkoutToken: string, t: OrderTracking, contact: WhatsappContact | null) {
  const c = await systemDb.abandonedCheckout.findUnique({ where: { storeId_checkoutToken: { storeId: ctx.store.id, checkoutToken } } });
  if (!c || c.status === "recovered") return;
  const reminder = await systemDb.whatsappMessage.findFirst({
    where: {
      checkoutId: c.id,
      status: { in: ["sent", "delivered", "read"] },
      sentAt: { lte: t.orderCreatedAt, gte: new Date(t.orderCreatedAt.getTime() - CART_ATTRIBUTION_MS) },
    },
    orderBy: { sentAt: "desc" },
  });
  await systemDb.abandonedCheckout.update({
    where: { id: c.id },
    data: reminder
      ? { status: "recovered", completedAt: t.orderCreatedAt, recoveredOrderId: t.shopifyOrderId, recoveredOrderName: t.orderName, recoveredRevenue: t.totalPrice }
      : { status: "completed", completedAt: t.orderCreatedAt },
  });
  await cancelScheduled({ checkoutId: c.id }, "checkout_completed");
  if (reminder) await automate(ctx, "cart_recovered", `checkout:${checkoutToken}`, t, contact, valuesFor(ctx, t, contact));
}

/**
 * Credit an order to the most recent campaign message its customer received within the store's
 * attribution window ("last touch"). An order is credited at most once (a unique index), and only
 * to a message that was actually sent before it. This says the order followed the message, not
 * that the message caused it; the dashboard says so too.
 */
export async function attributeOrder(ctx: Ctx, contact: WhatsappContact | null, t: OrderTracking) {
  if (!contact || t.cancelledAt) return;
  const since = new Date(t.orderCreatedAt.getTime() - ctx.cfg.attributionDays * 86_400_000);
  const msg = await systemDb.whatsappMessage.findFirst({
    where: {
      storeId: ctx.store.id,
      contactId: contact.id,
      campaignId: { not: null },
      test: false,
      attributedOrderId: null,
      status: { in: ["sent", "delivered", "read"] },
      sentAt: { gte: since, lte: t.orderCreatedAt },
    },
    orderBy: { sentAt: "desc" },
  });
  if (!msg) return;
  try {
    await systemDb.whatsappMessage.update({ where: { id: msg.id }, data: { attributedOrderId: t.shopifyOrderId, attributedRevenue: t.totalPrice, attributedAt: new Date() } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
}
