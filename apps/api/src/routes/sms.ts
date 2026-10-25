import { z } from "zod";
import { withTenant } from "@app/db";
import { env, logger, storeGraphql } from "@app/core";
import {
  addTestNumber,
  createTemplate,
  ensureSmsWebhooks,
  messagingReadiness,
  readiness,
  removeTestNumber,
  saveSender,
  sendManualSms,
  sendTestSms,
  setSending,
  smsOverview,
  templateAction,
  templateOf,
  updateTemplate,
  verifySender,
  verifyTestNumber,
  partPrice,
  smsDecrypt,
} from "@app/core/sms";
import { can } from "@app/shared";
import {
  checkTemplate,
  COUNTRY_RULES,
  estimateCostUsd,
  previewSms,
  SMS_CATEGORIES,
  SMS_VARIABLE_INFO,
  smsSegments,
  smsSenderSchema,
  TRIGGER_INFO,
  worstCaseSegments,
} from "@app/shared/sms";
import { body, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { actorNames, actorOf, base, publicMessage, publicSender, publicTemplate, publicVersion, requireSmsContacts, SMS_MANAGE, SMS_READ, smsDeps, smsStore } from "./smsCommon.js";
import { smsActivityRoutes } from "./smsActivity.js";
import { smsOpsRoutes } from "./smsOps.js";
import { smsAutomationRoutes } from "./smsAutomations.js";
import { smsSetupRoutes } from "./smsSetup.js";

/**
 * Customer Messaging: the overview, the sender, test numbers, templates and one-off sends
 * (docs/sms.md). Rules, segments and campaigns are in smsOps.ts; history, figures, billing and
 * consent in smsActivity.ts; Set up SMS in smsSetup.ts; the automation builder in
 * smsAutomations.ts; the customers' opt-out page in smsPublic.ts.
 *
 * Seeing it needs Marketing → campaigns; numbers and consent also "View contact information";
 * changing what customers receive (and approving it) is for owners and admins.
 */

const templateInput = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.enum(SMS_CATEGORIES),
  body: z.string().max(2000),
  dltTemplateId: z.string().trim().max(30).nullish(),
  dltText: z.string().max(2000).nullish(),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(30).default([]),
});

export function smsRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- overview and what Customer Messaging offers

  app.get(base, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    const [overview, ready] = await Promise.all([smsOverview(store), messagingReadiness(store, smsDeps(deps))]);
    return c.json({ store: { id: store.id, name: store.name ?? store.shopDomain, timezone: store.timezone, currency: store.currency }, ...overview, readiness: ready });
  });

  /** Variables, triggers and country rules: what the editors build on (no store data). */
  app.get(`${base}/catalog`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    return c.json({ variables: SMS_VARIABLE_INFO, triggers: TRIGGER_INFO, countries: COUNTRY_RULES });
  });

  // ---------------------------------------------------------------- sender

  app.get(`${base}/sender`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    const r = await readiness(store, smsDeps(deps));
    const manage = can(a.role, SMS_MANAGE) && !a.link && !!a.user;
    return c.json({
      mode: r.mode,
      marketingSwitch: r.marketingSwitch,
      account: r.account ? { sandbox: r.account.sandbox, tier: r.account.tier, ...(manage ? { spendLimitUsd: r.account.spendLimitUsd, spendLimitMaxUsd: r.account.spendLimitMaxUsd } : {}) } : null,
      accountError: r.accountError,
      configurationSet: r.configurationSet,
      sender: r.sender ? publicSender(r.sender, manage) : null,
      sharedSender: !!env().SMS_SHARED_SENDER.trim(),
    });
  });

  app.put(`${base}/sender`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = smsSenderSchema.parse(await body(c));
    const saved = await saveSender(store, input, actorOf(c, a));
    // Shopify's consent changes for this store, when it granted read_customers (best effort: consent also comes with orders).
    await ensureSmsWebhooks(store, storeGraphql(store, deps.coord, deps.fetchImpl), deps.coord).catch((err: unknown) => logger.warn({ err, storeId }, "sms consent webhook subscription failed"));
    return c.json({ sender: publicSender(saved, true) });
  });

  app.post(`${base}/sender/verify`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-verify:${storeId}`, LIMITS.smsVerify);
    const s = await verifySender(store, smsDeps(deps), actorOf(c, a));
    return c.json({ sender: publicSender(s, true) });
  });

  app.post(`${base}/sender/sending`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = z.object({ sending: z.boolean().optional(), marketing: z.boolean().optional() }).parse(await body(c));
    const s = await setSending(store, input, actorOf(c, a));
    return c.json({ sender: publicSender(s, true) });
  });

  // ---------------------------------------------------------------- test numbers (AWS's sandbox reaches only these)

  app.get(`${base}/test-numbers`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_MANAGE);
    await smsStore(ws, storeId);
    const rows = await withTenant(ws, (tx) => tx.smsTestNumber.findMany({ where: { workspaceId: ws, storeId }, orderBy: { createdAt: "asc" } }));
    return c.json({ testNumbers: rows.map((t) => ({ id: t.id, number: t.phoneMasked, country: t.country, status: t.status, verifiedAt: t.verifiedAt, createdAt: t.createdAt })) });
  });

  app.post(`${base}/test-numbers`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-code:${storeId}`, LIMITS.smsVerificationCode);
    const input = z.object({ number: z.string().trim().min(6).max(30), country: z.string().regex(/^[A-Z]{2}$/).nullish() }).parse(await body(c));
    const t = await addTestNumber(store, input.number, input.country ?? null, smsDeps(deps), actorOf(c, a));
    return c.json({ testNumber: { id: t.id, number: t.phoneMasked, country: t.country, status: t.status } }, 201);
  });

  app.post(`${base}/test-numbers/:id/verify`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-code-check:${id}`, LIMITS.smsVerificationCheck);
    const input = z.object({ code: z.string().trim().regex(/^\d{4,10}$/, "the code is digits only") }).parse(await body(c));
    const t = await verifyTestNumber(store, id, input.code, smsDeps(deps), actorOf(c, a));
    return c.json({ testNumber: { id: t.id, number: t.phoneMasked, country: t.country, status: t.status } });
  });

  app.post(`${base}/test-numbers/:id/resend`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-code:${storeId}`, LIMITS.smsVerificationCode);
    const row = await withTenant(ws, (tx) => tx.smsTestNumber.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!row) return c.json({ error: "not_found", message: "Test number not found." }, 404);
    const t = await addTestNumber(store, smsDecrypt(store.id, "test_phone", row.phoneEnc), row.country, smsDeps(deps), actorOf(c, a));
    return c.json({ testNumber: { id: t.id, number: t.phoneMasked, country: t.country, status: t.status } });
  });

  app.delete(`${base}/test-numbers/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await removeTestNumber(store, id, smsDeps(deps), actorOf(c, a));
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- templates

  app.get(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const archived = c.req.query("archived") === "1";
    const rows = await withTenant(ws, (tx) =>
      tx.smsTemplate.findMany({ where: { workspaceId: ws, storeId, ...(archived ? {} : { status: { not: "archived" } }) }, orderBy: { updatedAt: "desc" }, include: { versions: { orderBy: { version: "desc" } } } }),
    );
    return c.json({ templates: rows.map(publicTemplate) });
  });

  app.get(`${base}/templates/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const t = await templateOf(storeId, id);
    const history = await withTenant(ws, (tx) => tx.smsAuditLog.findMany({ where: { workspaceId: ws, storeId, targetId: id }, orderBy: { createdAt: "desc" }, take: 100 }));
    const who = await actorNames([...history.map((h) => h.actorUserId), ...t.versions.flatMap((v) => [v.createdBy, v.submittedBy, v.approvedBy])]);
    return c.json({
      template: publicTemplate(t),
      versions: t.versions.map((v) => ({ ...publicVersion(v), createdByName: v.createdBy ? who(v.createdBy) : null, approvedByName: v.approvedBy ? who(v.approvedBy) : null })),
      issues: checkTemplate({ category: t.versions[0]!.category as never, body: t.versions[0]!.body, dltTemplateId: t.versions[0]!.dltTemplateId, dltText: t.versions[0]!.dltText, forIndia: t.countries.includes("IN") }),
      history: history.map((h) => ({ action: h.action, version: h.version, actorUserId: h.actorUserId, actor: who(h.actorUserId), at: h.createdAt, metadata: h.metadata })),
    });
  });

  app.post(`${base}/templates`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = templateInput.parse(await body(c));
    const { template, issues } = await createTemplate(store, input, actorOf(c, a));
    return c.json({ template: publicTemplate(await templateOf(storeId, template.id)), issues }, 201);
  });

  app.put(`${base}/templates/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = templateInput.parse(await body(c));
    const { template, issues } = await updateTemplate(store, id, input, actorOf(c, a));
    return c.json({ template: publicTemplate(template), versions: template.versions.map(publicVersion), issues });
  });

  app.post(`${base}/templates/:id/:action{submit|approve|reject|archive|restore}`, async (c) => {
    const { ws, storeId, id, action } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = z.object({ note: z.string().trim().max(500).nullish() }).parse(await body(c));
    const t = await templateAction(store, id, action as "submit" | "approve" | "reject" | "archive" | "restore", actorOf(c, a), input.note);
    return c.json({ template: publicTemplate(t), versions: t.versions.map(publicVersion) });
  });

  /**
   * The live preview: the text with sample (or given) values, how it encodes, its parts now and at
   * worst, problems, and what it is expected to cost per destination country.
   */
  app.post(`${base}/templates/preview`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-preview:${storeId}`, LIMITS.smsPreview);
    const input = z
      .object({
        category: z.enum(SMS_CATEGORIES),
        body: z.string().max(2000),
        dltTemplateId: z.string().trim().max(30).nullish(),
        dltText: z.string().max(2000).nullish(),
        countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(30).default([]),
      })
      .parse(await body(c));
    const text = previewSms(input.body);
    const now = smsSegments(text);
    const worst = worstCaseSegments(input.body);
    const prices = await Promise.all(
      input.countries.map(async (country) => {
        const p = await partPrice(country);
        return { country, perPartUsd: p?.usd ?? null, source: p?.source ?? null, estimateUsd: estimateCostUsd(now.segments, p?.usd), worstUsd: estimateCostUsd(worst.segments, p?.usd) };
      }),
    );
    return c.json({ text, segments: now, worst, issues: checkTemplate({ ...input, forIndia: input.countries.includes("IN") }), prices });
  });

  /** A test text to one of the team's verified numbers (the latest version, approved or not). */
  app.post(`${base}/templates/:id/test`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-test:${storeId}`, LIMITS.smsTest);
    // requestId: one per press of the button, so a retried request returns the text already sent.
    const input = z
      .object({
        testNumberId: z.string().min(1).max(40),
        requestId: z
          .string()
          .regex(/^[A-Za-z0-9-]{8,64}$/)
          .nullish(),
      })
      .parse(await body(c));
    const job = await sendTestSms(store, id, input.testNumberId, smsDeps(deps), actorOf(c, a), input.requestId);
    return c.json({ message: publicMessage(job, true) });
  });

  // ---------------------------------------------------------------- one-off sends (Send SMS)

  /** Customers who may be texted (masked numbers): the Send SMS page's picker. */
  app.get(`${base}/recipients`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireSmsContacts(c, deps, ws);
    await smsStore(ws, storeId);
    const q = (c.req.query("q") ?? "").replace(/\D/g, "").slice(-4);
    const rows = await withTenant(ws, (tx) =>
      tx.smsContact.findMany({ where: { workspaceId: ws, storeId, suppressedAll: false, ...(q ? { phoneMasked: { endsWith: q.slice(-3) } } : {}) }, orderBy: { updatedAt: "desc" }, take: 25 }),
    );
    return c.json({ recipients: rows.map((r) => ({ id: r.id, number: r.phoneMasked, country: r.country, consent: r.consentState, suppressedMarketing: r.suppressedMarketing, orders: r.ordersCount })) });
  });

  app.post(`${base}/send`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    await limit(deps.coord, `rl:sms-manual:${storeId}`, LIMITS.smsManual);
    const input = z
      .object({
        templateId: z.string().min(1).max(40),
        contactId: z.string().min(1).max(40),
        values: z
          .object({ order_number: z.string().max(20).nullish(), order_total: z.string().max(16).nullish(), currency: z.string().max(3).nullish(), product_name: z.string().max(100).nullish(), tracking_url: z.string().max(300).nullish(), discount_code: z.string().max(30).nullish() })
          .default({}),
      })
      .parse(await body(c));
    const job = await sendManualSms(store, input.templateId, input.contactId, input.values, smsDeps(deps), actorOf(c, a));
    return c.json({ message: publicMessage(job, true) });
  });

  // Customers' consent and the suppression list are read in smsActivity.ts; contacts need contact rights.
  app.get(`${base}/contacts/count`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const groups = await withTenant(ws, (tx) => tx.smsContact.groupBy({ by: ["consentState"], where: { workspaceId: ws, storeId }, _count: true }));
    return c.json({ byConsent: Object.fromEntries(groups.map((g) => [g.consentState, g._count])) });
  });

  smsOpsRoutes(app, deps);
  smsActivityRoutes(app, deps);
  smsSetupRoutes(app, deps);
  smsAutomationRoutes(app, deps);
}
