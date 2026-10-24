import { z } from "zod";
import { withTenant } from "@app/db";
import {
  addDomain,
  checkDomain,
  createRule,
  createTemplate,
  deleteRule,
  deleteTemplate,
  dryRunRule,
  dryRunSavedRule,
  duplicateTemplate,
  emailOAuthConfigured,
  getDomain,
  getRule,
  getTemplate,
  listDomains,
  listRules,
  listTemplates,
  publicDomain,
  publicRule,
  publicTemplate,
  regenerateChallenge,
  removeDomain,
  restoreTemplateVersion,
  ruleExecutions,
  sendTemplateTest,
  setRuleEnabled,
  previewTemplate,
  templateVersions,
  updateDomain,
  updateRule,
  updateTemplate,
} from "@app/core";
import {
  COMPARISON_OPERATORS,
  CONDITION_LIMITS,
  CUSTOM_EVENT_EXAMPLES,
  domainCreateSchema,
  domainUpdateSchema,
  EVENT_CATALOG,
  GLOBAL_VARIABLES,
  OPERATOR_LABEL,
  OPERATORS_FOR,
  PROVIDER_LIMITS,
  ruleInputSchema,
  ruleUpdateSchema,
  SHOPIFY_EVENT_TYPES,
  templateInputSchema,
  templateUpdateSchema,
  UNSUBSCRIBE_VARIABLE,
  CUSTOMER_FIELDS,
} from "@app/shared/email";
import { body, HttpError, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { requireEmail } from "../emailAccess.js";
import { cursorPage } from "../pagination.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Settings → Email → Domains, Templates and Automations, and the catalog the builder is made of
 * (events with their fields, operators, variables). Reading needs email:read; templates and rules
 * need email:automate; domains (which can authorize senders) need email:manage.
 */
export function emailContentRoutes(app: App, deps: Deps) {
  const base = "/workspaces/:ws/email";

  /** What the builder offers: only events with a real source, and the fields each one carries. */
  app.get(`${base}/catalog`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    const stores = await withTenant(ws, (tx) => tx.store.findMany({ where: { workspaceId: ws, status: { not: "uninstalled" } }, select: { id: true, name: true, shopDomain: true } }));
    return c.json({
      events: SHOPIFY_EVENT_TYPES.map((t) => ({ ...EVENT_CATALOG[t], available: stores.length > 0 })),
      customEvents: { examples: CUSTOM_EVENT_EXAMPLES, fields: CUSTOMER_FIELDS, note: "Custom events come from your own systems through POST /api/v1/events. Their own fields are under data." },
      operators: COMPARISON_OPERATORS.map((op) => ({ op, label: OPERATOR_LABEL[op] })),
      operatorsFor: OPERATORS_FOR,
      limits: CONDITION_LIMITS,
      globalVariables: GLOBAL_VARIABLES,
      unsubscribeVariable: UNSUBSCRIBE_VARIABLE,
      stores: stores.map((s) => ({ id: s.id, name: s.name ?? s.shopDomain })),
      providersConfigured: emailOAuthConfigured(),
      providerLimits: PROVIDER_LIMITS,
    });
  });

  // ---------------- Domains ----------------

  app.get(`${base}/domains`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    return c.json({ domains: (await listDomains(ws)).map(publicDomain) });
  });

  app.post(`${base}/domains`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const input = domainCreateSchema.parse(await body(c));
    return c.json({ domain: publicDomain(await addDomain(ws, user.id, input)) });
  });

  const showDomain = async (c: Ctx) => {
    const { ws, id } = c.req.param() as { ws: string; id: string };
    await requireEmail(c, deps, ws, "email:read");
    return c.json({ domain: publicDomain(await getDomain(ws, id)) });
  };
  app.get(`${base}/domains/:id`, showDomain);
  app.get(`${base}/domains/:id/dns-status`, showDomain);

  /** Check DNS now (the sweep also checks pending domains every 15 minutes and verified ones daily). */
  app.post(`${base}/domains/:id/verify`, async (c) => {
    const { ws, id } = c.req.param();
    await requireEmail(c, deps, ws, "email:manage");
    await limit(deps.coord, `rl:email:dns:${id}`, LIMITS.emailDomainCheck, "Checked a moment ago. DNS changes take a few minutes to show; try again shortly.");
    const d = await getDomain(ws, id);
    if (d.verificationStatus === "expired") throw new HttpError(409, "This challenge has expired. Generate a new record and publish it.", "challenge_expired");
    return c.json({ domain: publicDomain(await checkDomain(d, deps)) });
  });

  app.patch(`${base}/domains/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const input = domainUpdateSchema.parse(await body(c));
    return c.json({ domain: publicDomain(await updateDomain(ws, id, user.id, input)) });
  });

  app.post(`${base}/domains/:id/regenerate`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    return c.json({ domain: publicDomain(await regenerateChallenge(ws, id, user.id)) });
  });

  app.delete(`${base}/domains/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    return c.json({ ok: true, ...(await removeDomain(ws, id, user.id)) });
  });

  // ---------------- Templates ----------------

  app.get(`${base}/templates`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    return c.json({ templates: (await listTemplates(ws)).map(publicTemplate) });
  });

  app.post(`${base}/templates`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    const input = templateInputSchema.parse(await body(c));
    return c.json({ template: publicTemplate(await createTemplate(ws, user.id, input)) });
  });

  app.get(`${base}/templates/:id`, async (c) => {
    const { ws, id } = c.req.param();
    await requireEmail(c, deps, ws, "email:read");
    const [t, versions] = await Promise.all([getTemplate(ws, id), templateVersions(ws, id)]);
    return c.json({ template: publicTemplate(t), versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt, subject: v.subjectTemplate })) });
  });

  app.patch(`${base}/templates/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    const patch = templateUpdateSchema.parse(await body(c));
    return c.json({ template: publicTemplate(await updateTemplate(ws, id, user.id, patch)) });
  });

  app.post(`${base}/templates/:id/duplicate`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    return c.json({ template: publicTemplate(await duplicateTemplate(ws, id, user.id)) });
  });

  app.post(`${base}/templates/:id/versions/:version/restore`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    const version = z.coerce.number().int().min(1).parse(c.req.param("version"));
    return c.json({ template: publicTemplate(await restoreTemplateVersion(ws, id, version, user.id)) });
  });

  /** Render a saved template with example data (optionally overridden). */
  app.post(`${base}/templates/:id/preview`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:read");
    await limit(deps.coord, `rl:email:preview:${user.id}`, LIMITS.emailPreview);
    const { data } = z.object({ data: z.record(z.string(), z.unknown()).optional() }).parse(await body(c));
    const t = await getTemplate(ws, id);
    return c.json({ preview: await previewTemplate(ws, { subject: t.subjectTemplate, html: t.htmlTemplate, text: t.textTemplate, category: t.category, eventType: t.eventType }, data) });
  });

  /**
   * Render a template that isn't saved yet (the editor's live preview). Only what the email is made
   * of is checked: a new template has no name yet, and the preview doesn't need one.
   */
  app.post(`${base}/templates/preview`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    await limit(deps.coord, `rl:email:preview:${user.id}`, LIMITS.emailPreview);
    const input = templateInputSchema
      .pick({ category: true, eventType: true, subject: true, html: true, text: true })
      .extend({ data: z.record(z.string(), z.unknown()).optional() })
      .parse(await body(c));
    return c.json({ preview: await previewTemplate(ws, { subject: input.subject, html: input.html, text: input.text, category: input.category, eventType: input.eventType }, input.data) });
  });

  /** Send the template, filled with example data, to the signed-in person's own address. */
  app.post(`${base}/templates/:id/test`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    if (!user.emailVerified) throw new HttpError(403, "Verify your own email address first: test emails go to it.", "email_unverified");
    const { senderId } = z.object({ senderId: z.string().max(64).optional() }).parse(await body(c));
    await limit(deps.coord, `rl:email:testsend:${ws}`, LIMITS.emailTestSend);
    const result = await sendTemplateTest(ws, id, { email: user.email, verified: true }, senderId, deps);
    return c.json({ result });
  });

  app.delete(`${base}/templates/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    await deleteTemplate(ws, id, user.id);
    return c.json({ ok: true });
  });

  // ---------------- Automations ----------------

  app.get(`${base}/automations`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    return c.json({ automations: (await listRules(ws)).map(publicRule) });
  });

  app.post(`${base}/automations`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    const input = ruleInputSchema.parse(await body(c));
    const { rule, blocking } = await createRule(ws, user.id, input);
    return c.json({ automation: publicRule(await getRule(ws, rule.id)), blocking });
  });

  /** Dry run of an unsaved rule (the builder's step 6). */
  app.post(`${base}/automations/dry-run`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    await limit(deps.coord, `rl:email:preview:${user.id}`, LIMITS.emailPreview);
    const input = ruleInputSchema.extend({ data: z.record(z.string(), z.unknown()).optional() }).parse(await body(c));
    const { data, ...rule } = input;
    return c.json(await dryRunRule(ws, rule, data));
  });

  app.get(`${base}/automations/:id`, async (c) => {
    const { ws, id } = c.req.param();
    await requireEmail(c, deps, ws, "email:read");
    return c.json({ automation: publicRule(await getRule(ws, id)) });
  });

  app.patch(`${base}/automations/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    const patch = ruleUpdateSchema.parse(await body(c));
    const { blocking } = await updateRule(ws, id, user.id, patch);
    return c.json({ automation: publicRule(await getRule(ws, id)), blocking });
  });

  app.post(`${base}/automations/:id/enable`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    await setRuleEnabled(ws, id, user.id, true);
    return c.json({ automation: publicRule(await getRule(ws, id)) });
  });

  app.post(`${base}/automations/:id/disable`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    const r = await setRuleEnabled(ws, id, user.id, false);
    return c.json({ automation: publicRule(await getRule(ws, id)), ...r });
  });

  app.post(`${base}/automations/:id/dry-run`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    await limit(deps.coord, `rl:email:preview:${user.id}`, LIMITS.emailPreview);
    const { data } = z.object({ data: z.record(z.string(), z.unknown()).optional() }).parse(await body(c));
    const rule = await getRule(ws, id);
    return c.json(await dryRunSavedRule(ws, rule, data));
  });

  app.get(`${base}/automations/:id/executions`, async (c) => {
    const { ws, id } = c.req.param();
    await requireEmail(c, deps, ws, "email:activity");
    const page = cursorPage(c.req.query(), 25);
    return c.json(await ruleExecutions(ws, id, { cursor: c.req.query("cursor"), limit: page.size }));
  });

  app.delete(`${base}/automations/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:automate");
    return c.json({ ok: true, ...(await deleteRule(ws, id, user.id)) });
  });
}
