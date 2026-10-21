import { afterAll, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import {
  addSuppression,
  checkDomain,
  connectOAuthAccount,
  createIngestKey,
  createRule,
  createSmtpAccount,
  createTemplate,
  emailOnShopifyEvent,
  ingestCustomEvent,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  processBusinessEvent,
  sendEmailMessage,
  setRuleEnabled,
  addDomain,
  AAD,
  open,
  promoteAbandonedCheckouts,
  type FetchLike,
} from "@app/core";
import { dohResponse, fakeSmtp, isDoh, json } from "../../../test-support/emailFakes.js";

/**
 * Sample data for the LOCAL Email integrations demo (database email_demo; see email.vitest.config.ts).
 * Everything goes through the real code: accounts connect (Google and the SMTP server simulated
 * here, nothing leaves the machine), Shopify webhooks and custom events run automations, and the
 * sender hands messages to the simulated providers. Then timestamps are spread over the past days.
 * Test values only.
 */

afterAll(async () => disconnectDb());

const DOMAIN = "riveragoods.com";
let gmailFail = new Set<string>();
const dns: Record<string, string[]> = { [`smtp.${DOMAIN}|A`]: ["93.184.216.34"], [`${DOMAIN}|TXT`]: ["v=spf1 include:_spf.google.com ~all"], [`_dmarc.${DOMAIN}|TXT`]: ["v=DMARC1; p=none; rua=mailto:dmarc@riveragoods.com"] };
let gm = 0;
const fetchImpl: FetchLike = async (input, init) => {
  const u = new URL(String(input));
  if (isDoh(u)) return dohResponse(u, dns);
  if (u.hostname === "gmail.googleapis.com") {
    const raw = Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString();
    const to = /^To: (.*)$/m.exec(raw)?.[1] ?? "";
    if (gmailFail.has(to)) return json({ error: { message: "Invalid To header", status: "INVALID_ARGUMENT" } }, 400);
    return json({ id: `18c${(++gm).toString(16).padStart(6, "0")}demo` });
  }
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "DEMO_ACCESS", expires_in: 3599 });
  throw new Error(`demo seed: unexpected fetch ${u}`);
};
const smtp = fakeSmtp({ password: "demo-smtp-password" });
const deps = { coord: memoryCoord(), queues: memoryQueues(), mailer: memoryMailer(), fetchImpl, smtpConnect: smtp.connect };

let rnd = 11;
const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]!;

it("seeds the email demo", async () => {
  const email = process.env.EMAIL_DEMO_EMAIL ?? "owner@emaildemo.test";
  const user = await systemDb.user.findUniqueOrThrow({ where: { email } });
  const membership =
    (await systemDb.membership.findFirst({ where: { userId: user.id, role: "owner" } })) ??
    (await systemDb.membership.create({ data: { role: "owner", user: { connect: { id: user.id } }, workspace: { create: { name: "Rivera Goods" } } } }));
  const ws = membership.workspaceId;
  // Start over: the demo's own email data only.
  for (const t of ["emailMessageEvent", "emailMessage", "emailAutomationExecution", "emailBusinessEvent", "emailAutomationRule", "emailTemplateVersion", "emailTemplate", "emailSenderIdentity", "emailOAuthCredential", "emailSmtpCredential", "emailAccount", "emailDomain", "emailSuppression", "emailIngestKey", "emailSettings"] as const) {
    await (systemDb[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { workspaceId: ws } });
  }
  await systemDb.auditLog.deleteMany({ where: { workspaceId: ws, action: { startsWith: "email." } } });
  const store =
    (await systemDb.store.findFirst({ where: { workspaceId: ws } })) ??
    (await systemDb.store.create({ data: { workspaceId: ws, shopDomain: "rivera-goods.myshopify.com", name: "Rivera Goods", grantedScopes: ["read_orders", "read_products"], status: "active", currency: "USD" } }));
  await systemDb.emailSettings.create({ data: { workspaceId: ws, businessName: "Rivera Goods", businessAddress: "12 Market St, Springfield, IL 62701" } });

  // Accounts: Google Workspace (connected), SMTP billing (connected, domain-verified sender), Microsoft (needs reconnecting).
  const { account: google } = await connectOAuthAccount({
    workspaceId: ws,
    userId: user.id,
    method: "oauth_google",
    identity: { provider: "google_workspace", providerAccountId: "demo-google-sub", providerTenantId: DOMAIN, email: `sales@${DOMAIN}`, displayName: "Rivera Goods" },
    tokens: { accessToken: "DEMO_ACCESS", refreshToken: "DEMO_REFRESH", expiresAt: new Date(Date.now() + 3600_000), scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"], idToken: null },
  });
  const domain = await addDomain(ws, user.id, { domain: DOMAIN, sendingService: "google", dkimSelectors: [] });
  dns[`_insights-verify.${DOMAIN}|TXT`] = [`insights-verification=${open(domain.verificationTokenEnc, AAD.domainToken(ws, DOMAIN))}`];
  dns[`google._domainkey.${DOMAIN}|TXT`] = [`v=DKIM1; k=rsa; p=${"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".repeat(4)}`];
  await checkDomain(domain, deps);
  await createSmtpAccount(ws, user.id, { emailAddress: `billing@${DOMAIN}`, displayName: "Rivera Goods Billing", host: `smtp.${DOMAIN}`, port: 587, encryption: "starttls", username: `billing@${DOMAIN}`, password: "demo-smtp-password", replyTo: null }, deps);
  const { account: ms } = await connectOAuthAccount({
    workspaceId: ws,
    userId: user.id,
    method: "oauth_microsoft",
    identity: { provider: "microsoft_365", providerAccountId: "demo-ms-oid", providerTenantId: "11111111-2222-3333-4444-555555555555", email: "support@riveragoods.onmicrosoft.com", displayName: "Support" },
    tokens: { accessToken: "DEMO_MS", refreshToken: "DEMO_MS_REFRESH", expiresAt: new Date(Date.now() + 3600_000), scopes: ["Mail.Send", "User.Read"], idToken: null },
  });
  await systemDb.emailAccount.update({ where: { id: ms.id }, data: { status: "reauthorization_required", statusReason: "auth_failed", lastErrorCode: "auth_failed", lastErrorAt: new Date(Date.now() - 2 * 3600_000) } });
  const sender = await systemDb.emailSenderIdentity.findFirstOrThrow({ where: { emailAccountId: google.id } });
  const billingSender = await systemDb.emailSenderIdentity.findFirstOrThrow({ where: { senderEmail: `billing@${DOMAIN}` } });

  // Templates and automations.
  const thanks = await createTemplate(ws, user.id, {
    name: "Thanks for your order",
    category: "transactional",
    eventType: "order.paid",
    subject: "Thanks for your order {{order.id}}, {{customer.first_name | default: \"friend\"}}!",
    html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="color:#4f46e5">Thank you, {{customer.first_name | default: "friend"}}!</h2><p>We've received payment for order <b>{{order.id}}</b> ({{order.total}} {{order.currency}}).</p><p>Items: {{order.product_titles}}</p><p><a href="{{order.status_url}}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Track your order</a></p><p>— {{business.name}}</p></div>`,
    text: "",
    status: "active",
  });
  const cart = await createTemplate(ws, user.id, {
    name: "You left something behind",
    category: "marketing",
    eventType: "checkout.abandoned",
    subject: "Still thinking it over, {{customer.first_name | default: \"there\"}}?",
    html: `<p>Hi {{customer.first_name | default: "there"}},</p><p>Your cart with {{checkout.item_count}} item(s) is waiting: {{checkout.product_titles}}.</p><p><a href="{{checkout.recovery_url}}">Return to checkout</a></p>`,
    text: "",
    status: "active",
  });
  const invoice = await createTemplate(ws, user.id, {
    name: "Invoice overdue reminder",
    category: "transactional",
    eventType: "invoice.overdue",
    subject: "Invoice {{data.invoice}} is overdue",
    html: "<p>Hi {{customer.first_name}},</p><p>Invoice <b>{{data.invoice}}</b> for {{data.amount}} was due on {{data.due_date}}.</p><p>{{business.name}}</p>",
    text: "",
    status: "active",
  });
  await createTemplate(ws, user.id, { name: "Shipping update (draft)", category: "transactional", eventType: "order.fulfilled", subject: "Your order {{order.id}} is on its way", html: "<p>Good news: it shipped.</p>", text: "", status: "draft" });

  const base = { description: null, storeId: null, recipient: { type: "customer" as const }, frequency: { type: "once_per_event" as const }, maxAttempts: 5, priority: 100 };
  const r1 = await createRule(ws, user.id, { ...base, name: "Thank-you for paid orders over $50", eventType: "order.paid", conditions: { op: "and", conditions: [{ op: "greater_than", field: "order.total", value: 50 }, { op: "exists", field: "customer.email" }] }, senderIdentityId: sender.id, templateId: thanks.id, delayMinutes: 5 });
  const r2 = await createRule(ws, user.id, { ...base, name: "Abandoned cart reminder", eventType: "checkout.abandoned", conditions: null, senderIdentityId: sender.id, templateId: cart.id, delayMinutes: 0, frequency: { type: "once_per_recipient", windowHours: 168 } });
  const r3 = await createRule(ws, user.id, { ...base, name: "Overdue invoices", eventType: "invoice.overdue", conditions: null, senderIdentityId: billingSender.id, templateId: invoice.id, delayMinutes: 0 });
  for (const r of [r1, r2, r3]) await setRuleEnabled(ws, r.rule.id, user.id, true);

  // Shopify orders and checkouts through the webhook path; custom events through the event API.
  const names = [["Alex", "alex"], ["Sam", "sam.k"], ["Priya", "priya"], ["Jordan", "jordan.lee"], ["Mia", "mia"], ["Noah", "noah"], ["Lena", "lena.v"], ["Omar", "omar"], ["Bea", "bea"], ["Kai", "kai"]];
  const products = ["Linen shirt", "Canvas tote", "Ceramic mug", "Wool scarf", "Leather wallet"];
  gmailFail = new Set([`omar@example.com`]);
  await addSuppression({ workspaceId: ws, email: "kai@example.com", reason: "unsubscribed", scope: "marketing", source: "unsubscribe_link" });
  await addSuppression({ workspaceId: ws, email: "bounce@example.com", reason: "bounced", scope: "all", source: "smtp_rejection" });
  for (let i = 0; i < 28; i++) {
    const [first, local] = pick(names);
    const total = Math.round((20 + rand() * 180) * 100) / 100;
    const items = [pick(products), pick(products)];
    await emailOnShopifyEvent(
      store,
      "orders/paid",
      { id: 9000 + i, name: `#${1100 + i}`, order_number: 1100 + i, email: `${local}@example.com`, total_price: String(total), subtotal_price: String(total), currency: "USD", financial_status: "paid", line_items: items.map((t) => ({ title: t, quantity: 1 })), customer: { first_name: first, email_marketing_consent: { state: rand() > 0.4 ? "subscribed" : "not_subscribed" } }, order_status_url: "https://rivera-goods.myshopify.com/orders/demo/authenticate" },
      deps,
    );
  }
  for (let i = 0; i < 6; i++) {
    const [first, local] = pick(names);
    await emailOnShopifyEvent(store, "checkouts/update", { token: `demo-ck-${i}`, email: `${local}@example.com`, total_price: "64.00", presentment_currency: "USD", line_items: [{ title: pick(products), quantity: 2 }], abandoned_checkout_url: "https://rivera-goods.myshopify.com/checkouts/recover/demo", buyer_accepts_marketing: i % 3 !== 0, customer: { first_name: first }, updated_at: new Date(Date.now() - 3 * 3600_000).toISOString() }, deps);
  }
  await promoteAbandonedCheckouts(deps);
  for (let i = 0; i < 4; i++) {
    const [first, local] = pick(names);
    await ingestCustomEvent(ws, { id: `inv-${200 + i}`, type: "invoice.overdue", customer: { email: `${local}@example.com`, first_name: first }, data: { invoice: `INV-${200 + i}`, amount: "$120.00", due_date: "2026-10-01" } }, deps);
  }
  await createIngestKey(ws, user.id, "Invoicing system");

  // Run the automations and send what's due (the 5-minute delay is skipped for the demo).
  for (const e of await systemDb.emailBusinessEvent.findMany({ where: { workspaceId: ws, status: "received" } })) await processBusinessEvent(e.id, deps);
  await systemDb.emailMessage.updateMany({ where: { workspaceId: ws, status: "queued" }, data: { scheduledAt: new Date() } });
  const queued = await systemDb.emailMessage.findMany({ where: { workspaceId: ws, status: "queued" }, orderBy: { createdAt: "asc" } });
  for (const [i, m] of queued.entries()) {
    if (i === queued.length - 1) continue; // one stays queued
    if (i === queued.length - 2) {
      // One whose provider never answered.
      await systemDb.emailMessage.update({ where: { id: m.id }, data: { status: "unknown", attempts: 1, lastErrorCode: "send_interrupted", lastErrorMessage: "No answer from the provider: Network connection lost" } });
      await systemDb.emailMessageEvent.create({ data: { workspaceId: ws, messageId: m.id, eventType: "unknown", metadata: { code: "send_interrupted" } } });
      continue;
    }
    await sendEmailMessage(m.id, deps);
  }

  // Spread the history over the past two weeks.
  // Demo only: backdating the history means rewriting delivery events, which are append-only in
  // the database, so the trigger is switched off inside this one transaction.
  const all = await systemDb.emailMessage.findMany({ where: { workspaceId: ws }, select: { id: true } });
  const when = all.map((m) => ({ id: m.id, at: new Date(Date.now() - Math.floor(rand() * 14 * 86_400_000)) }));
  await systemDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE email_message_events DISABLE TRIGGER email_message_events_no_update`);
    for (const { id, at } of when) {
      await tx.emailMessage.update({ where: { id }, data: { createdAt: at, scheduledAt: at } });
      await tx.$executeRaw`UPDATE email_message_events SET event_timestamp = CAST(${at.toISOString()} AS timestamp(3)) + (event_timestamp - (SELECT min(event_timestamp) FROM email_message_events WHERE message_id = ${id})) WHERE message_id = ${id}`;
    }
    await tx.$executeRawUnsafe(`ALTER TABLE email_message_events ENABLE TRIGGER email_message_events_no_update`);
  });
  console.log(`email demo: ${all.length} messages for workspace ${ws}; SMTP deliveries ${smtp.delivered.length}`);
});
