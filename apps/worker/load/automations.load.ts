import { afterAll, beforeAll, expect, it } from "vitest";
import { disconnectDb, systemDb, type Store } from "@app/db";
import { resetDb } from "@app/db/testing";
import { connectOAuthAccount, createRule as createEmailRule, createTemplate as createEmailTemplate, emailOnShopifyEvent, memoryBlobs, memoryCoord, memoryMailer, memoryQueues, processBusinessEvent, resetEnvCache, sendEmailMessage, setRuleEnabled, type FetchLike } from "@app/core";
import { createRule, createTemplate, fakeSmsProvider, ruleAction, saveSender, sendSmsJob, smsOnShopifyEvent, templateAction, verifySender } from "@app/core/sms";
import type { WorkerDeps } from "../src/handlers.js";

/**
 * A load and concurrency run of both automation engines (docs/automations.md, "Capacity"): many
 * stores, many orders, every Shopify webhook delivered twice at once, every event and every send
 * worked by two workers racing each other. AWS and Gmail are faked and answer at once, so this
 * measures bizinsights' own pipeline on this machine's Postgres: never a provider's throughput.
 *
 *   TEST_PG_PORT=<port> TEST_DB=load_test LOAD_STORES=10 LOAD_ORDERS=100 LOAD_CONCURRENCY=16 pnpm --filter @app/worker load:automations
 *
 * It fails if any order texts or emails a customer twice, or not at all (beyond what a limit held
 * back on purpose), and prints what it measured. Not part of CI: it is slow by design.
 */

const STORES = Number(process.env.LOAD_STORES ?? 5);
const ORDERS = Number(process.env.LOAD_ORDERS ?? 60);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 12);
const actor = { userId: null, ip: "127.0.0.1" };

const queues = memoryQueues();
const coord = memoryCoord();
const sms = fakeSmsProvider();
const gmail: string[] = [];
const fetchImpl: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "gmail.googleapis.com") {
    gmail.push(Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString());
    return new Response(JSON.stringify({ id: `gm-${gmail.length}`, threadId: "t" }), { headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const deps: WorkerDeps & { sms: typeof sms } = { coord, queues, payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl, sms };

/** Run `tasks` with at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

const time = async (fn: () => Promise<unknown>) => {
  const t = performance.now();
  await fn();
  return (performance.now() - t) / 1000;
};

beforeAll(async () => {
  Object.assign(process.env, {
    SMS_MODE: "live",
    SMS_PARTS_PER_SECOND: "1000",
    SMS_ACCOUNT_MONTHLY_LIMIT_USD: "1000000",
    SMS_PRICE_TABLE: JSON.stringify({ AU: 0.05 }),
    EMAIL_GOOGLE_CLIENT_ID: "g-email",
    EMAIL_GOOGLE_CLIENT_SECRET: "g-secret",
    EMAIL_DEFAULT_DAILY_LIMIT: "100000",
    EMAIL_MAX_DAILY_LIMIT: "100000",
    EMAIL_WORKSPACE_PER_MINUTE: "100000",
  });
  resetEnvCache();
  await resetDb();
});
afterAll(async () => disconnectDb());

async function shop(i: number): Promise<Store> {
  const user = await systemDb.user.create({ data: { email: `owner${i}@load.test`, emailVerified: true } });
  const ws = await systemDb.workspace.create({ data: { name: `Load ${i}`, memberships: { create: { userId: user.id, role: "owner" } } } });
  const store = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `load${i}.myshopify.com`, name: `Load ${i}`, currency: "AUD", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-load-${i}` } });
  // SMS: a verified sender, sending on, and an approved order confirmation running.
  const id = `LOAD${i}`;
  sms.identities.set(id, { kind: "sender_id", arn: `arn:aws:sms-voice:ap-southeast-2:1:sender-id/${id}/AU`, id, label: id, country: "AU", status: "REGISTERED", twoWay: false, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": ws.id } });
  await saveSender(store, { senderType: "sender_id", originationIdentity: id, countries: ["AU"], monthlyBudgetUsd: 100_000, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 10, maxMarketingPerWeek: 5, dltEntityId: null }, actor);
  await verifySender(store, deps, actor);
  await systemDb.smsSenderConfiguration.update({ where: { storeId: store.id }, data: { sendingEnabled: true } });
  const { template } = await createTemplate(store, { name: "Thanks", category: "transactional", body: "Thanks {{customer_name}}, we got order {{order_number}}." }, actor);
  await templateAction(store, template.id, "submit", actor);
  await templateAction(store, template.id, "approve", actor);
  const rule = await createRule(store, { name: "Thanks", trigger: "order_created", templateId: template.id, delayMinutes: 0, conditions: [], quietStart: 0, quietEnd: 0, maxPerCustomer: 10, capDays: 1, dryRun: false }, actor);
  await ruleAction(store, rule.id, "submit", actor);
  await ruleAction(store, rule.id, "approve", actor);
  // Email: a Google Workspace mailbox and an order confirmation running.
  const { account } = await connectOAuthAccount({
    workspaceId: ws.id,
    userId: user.id,
    method: "oauth_google",
    identity: { provider: "google_workspace", providerAccountId: `g-${i}`, providerTenantId: "load.test", email: `sales${i}@load.test`, displayName: "Sales" },
    tokens: { accessToken: "G_ACCESS", refreshToken: "G_REFRESH", expiresAt: new Date(Date.now() + 3600_000), scopes: ["https://www.googleapis.com/auth/gmail.send"], idToken: null },
  });
  const sender = await systemDb.emailSenderIdentity.findFirstOrThrow({ where: { emailAccountId: account.id } });
  const t = await createEmailTemplate(ws.id, user.id, { name: "Thanks", category: "transactional", eventType: "order.created", subject: "Order {{order.id}}", html: "<p>Thanks {{customer.first_name}}</p>", text: "", status: "active" });
  const { rule: er } = await createEmailRule(ws.id, user.id, { name: "Thanks", description: null, eventType: "order.created", storeId: null, conditions: null, senderIdentityId: sender.id, templateId: t.id, recipient: { type: "customer" }, delayMinutes: 0, frequency: { type: "once_per_event" }, maxAttempts: 5, priority: 100 });
  await setRuleEnabled(ws.id, er.id, user.id, true);
  return store;
}

const order = (store: number, n: number) => ({
  id: store * 1_000_000 + n,
  name: `#${1000 + n}`,
  email: `c${store}-${n}@example.com`,
  currency: "AUD",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  cancelled_at: null,
  financial_status: "paid",
  total_price: "40.00",
  tags: "",
  checkout_token: null,
  customer: { id: store * 1_000_000 + n, first_name: "Sam", email: `c${store}-${n}@example.com` },
  shipping_address: { first_name: "Sam", country_code: "AU", phone: `0412${String(store * 1000 + n).padStart(6, "0").slice(-6)}` },
  line_items: [{ id: 1, product_id: 10, title: "Tee", quantity: 1, price: "40.00" }],
  fulfillments: [],
});

it(`${STORES} stores × ${ORDERS} orders, every webhook twice, every job by two workers`, { timeout: 60 * 60_000 }, async () => {
  const stores: Store[] = [];
  for (let i = 0; i < STORES; i++) stores.push(await shop(i));

  // 1. Webhooks: each order arrives twice at once (Shopify's at-least-once delivery), all stores interleaved.
  const deliveries = stores.flatMap((s, i) => Array.from({ length: ORDERS }, (_, n) => ({ s, p: order(i, n) })));
  const ingest = await time(() =>
    pool(deliveries, CONCURRENCY, ({ s, p }) =>
      Promise.all([smsOnShopifyEvent(s, "orders/create", p, deps), smsOnShopifyEvent(s, "orders/create", p, deps), emailOnShopifyEvent(s, "orders/create", p, deps), emailOnShopifyEvent(s, "orders/create", p, deps)]),
    ),
  );

  // 2. Email rules run for each event, by two workers at once.
  const events = await systemDb.emailBusinessEvent.findMany({ select: { id: true } });
  const evaluate = await time(() => pool(events, CONCURRENCY, (e) => Promise.all([processBusinessEvent(e.id, deps), processBusinessEvent(e.id, deps)])));

  // 3. Sends: every text and every email claimed by two workers racing.
  const texts = await systemDb.smsMessageJob.findMany({ where: { status: "scheduled" }, select: { id: true } });
  await systemDb.smsMessageJob.updateMany({ where: { status: "scheduled" }, data: { sendAfter: new Date(Date.now() - 1000) } });
  const smsSend = await time(() => pool(texts, CONCURRENCY, (j) => Promise.all([sendSmsJob(j.id, deps), sendSmsJob(j.id, deps)])));
  const mails = await systemDb.emailMessage.findMany({ where: { status: "queued" }, select: { id: true } });
  await systemDb.emailMessage.updateMany({ where: { status: "queued" }, data: { scheduledAt: new Date(Date.now() - 1000) } });
  const emailSend = await time(() => pool(mails, CONCURRENCY, (m) => Promise.all([sendEmailMessage(m.id, deps), sendEmailMessage(m.id, deps)])));

  const expected = STORES * ORDERS;
  const smsByStatus = Object.fromEntries((await systemDb.smsMessageJob.groupBy({ by: ["status"], _count: { _all: true } })).map((g) => [g.status, g._count._all]));
  const emailByStatus = Object.fromEntries((await systemDb.emailMessage.groupBy({ by: ["status"], _count: { _all: true } })).map((g) => [g.status, g._count._all]));
  const textedNumbers = sms.sent.map((x) => x.destination);
  const emailedTo = gmail.map((raw) => /^To: (.+)$/m.exec(raw)?.[1] ?? "");

  const rate = (n: number, s: number) => `${Math.round(n / s)}/s`;
  console.log(
    [
      `Load run: ${STORES} stores × ${ORDERS} orders = ${expected} orders, concurrency ${CONCURRENCY}, each webhook delivered twice`,
      `  webhook deliveries in (each into both engines): ${ingest.toFixed(1)} s  ${rate(expected * 2, ingest)}`,
      `  email rules evaluated (×2 workers):     ${evaluate.toFixed(1)} s  ${rate(events.length, evaluate)} events`,
      `  texts sent (×2 workers):                ${smsSend.toFixed(1)} s  ${rate(texts.length, smsSend)}`,
      `  emails sent (×2 workers):               ${emailSend.toFixed(1)} s  ${rate(mails.length, emailSend)}`,
      `  SMS rows by status:   ${JSON.stringify(smsByStatus)}`,
      `  email rows by status: ${JSON.stringify(emailByStatus)}`,
      `  provider calls: AWS ${sms.sent.length}, Gmail ${gmail.length}`,
    ].join("\n"),
  );

  // Exactly once: one row per order and channel, one provider call per row, nobody twice.
  expect(await systemDb.smsMessageJob.count()).toBe(expected);
  expect(await systemDb.emailMessage.count()).toBe(expected);
  expect(new Set(textedNumbers).size).toBe(textedNumbers.length);
  expect(new Set(emailedTo).size).toBe(emailedTo.length);
  expect(sms.sent.length).toBe(smsByStatus.accepted ?? 0);
  // Every email either went, or is waiting on a provider's own per-minute limit (Google Workspace: 30 a minute per mailbox).
  expect(gmail.length + (emailByStatus.deferred ?? 0) + (emailByStatus.queued ?? 0)).toBe(expected);
  expect(sms.sent.length).toBe(expected);
});
