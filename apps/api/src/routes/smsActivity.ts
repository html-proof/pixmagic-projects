import { z } from "zod";
import { systemDb, withTenant, type Prisma } from "@app/db";
import { contactPhone, liftSuppression, senderOf, smsAnalytics, smsAudit, smsBilling, suppressNumber } from "@app/core/sms";
import { allows, can, localDay, normalizePhone } from "@app/shared";
import { ATTRIBUTION_RULE, billingMonth, CONSENT_LABEL, liftableSuppression, SMS_PERIODS, SMS_STATUSES, smsPeriodRange, SUPPRESSION_LABEL, type SuppressionReason } from "@app/shared/sms";
import { body, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { endOfLocalDay, startOfLocalDay } from "@app/shared/staff";
import { cursorPage } from "../pagination.js";
import { base, publicMessage, requireSmsContacts, SMS_MANAGE, SMS_READ, smsStore } from "./smsCommon.js";

/** Customer Messaging: message history, delivery analytics, billing, consent and the suppression list, the audit trail. */

const day = /^\d{4}-\d{2}-\d{2}$/;

export function smsActivityRoutes(app: App, deps: Deps) {
  // ---------------------------------------------------------------- message history

  app.get(`${base}/messages`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    const showText = allows(a.access, "customers.contact");
    const q = c.req.query();
    const paging = cursorPage(q, 50);
    const statuses = (q.status ?? "").split(",").filter((s) => (SMS_STATUSES as readonly string[]).includes(s));
    const from = q.from && day.test(q.from) ? q.from : null;
    const to = q.to && day.test(q.to) ? q.to : null;
    const where: Prisma.SmsMessageJobWhereInput = {
      workspaceId: ws,
      storeId,
      ...(statuses.length ? { status: { in: statuses } } : {}),
      ...(q.purpose && ["automation", "campaign", "test", "manual"].includes(q.purpose) ? { purpose: q.purpose } : {}),
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      ...(q.ruleId ? { ruleId: q.ruleId } : {}),
      ...(q.country && /^[A-Z]{2}$/.test(q.country) ? { destinationCountry: q.country } : {}),
      // The store's days, as the list shows times and analytics counts days.
      ...(from || to ? { createdAt: { ...(from ? { gte: new Date(startOfLocalDay(from, store.timezone)) } : {}), ...(to ? { lt: new Date(endOfLocalDay(to, store.timezone)) } : {}) } } : {}),
      ...(q.q ? { OR: [{ providerMessageId: q.q.slice(0, 200) }, { phoneMasked: { endsWith: q.q.replace(/\D/g, "").slice(-3) || "~" } }] } : {}),
    };
    const rows = await withTenant(ws, (tx) => tx.smsMessageJob.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...paging.args }));
    const { items, nextCursor } = paging.split(rows);
    // Masked numbers and texts only with contact rights; everyone with access sees statuses and costs.
    return c.json({ messages: items.map((m) => ({ ...publicMessage(m, showText), to: showText ? m.phoneMasked : null })), nextCursor, timezone: store.timezone });
  });

  app.get(`${base}/messages/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_READ);
    await smsStore(ws, storeId);
    const showText = allows(a.access, "customers.contact");
    const m = await withTenant(ws, (tx) => tx.smsMessageJob.findFirst({ where: { id, workspaceId: ws, storeId }, include: { events: { orderBy: { eventAt: "asc" } } } }));
    if (!m) throw new HttpError(404, "Not found", "not_found");
    return c.json({
      message: { ...publicMessage(m, showText), to: showText ? m.phoneMasked : null },
      events: m.events.map((e) => ({ type: e.eventType, status: e.messageStatus, final: e.isFinal, at: e.eventAt, country: e.isoCountry, parts: e.parts, priceUsd: e.priceUsd === null ? null : Number(e.priceUsd), carrierFeeUsd: e.carrierFeeUsd === null ? null : Number(e.carrierFeeUsd) })),
    });
  });

  // ---------------------------------------------------------------- analytics

  app.get(`${base}/analytics`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    const q = c.req.query();
    const period = (SMS_PERIODS as readonly string[]).includes(q.period ?? "") ? (q.period as (typeof SMS_PERIODS)[number]) : "30d";
    let range: { from: string; to: string };
    try {
      range = smsPeriodRange(period, localDay(new Date(), store.timezone), { from: q.from, to: q.to });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "Invalid dates", "invalid_range");
    }
    const result = await smsAnalytics(store, { ...range, country: q.country && /^[A-Z]{2}$/.test(q.country) ? q.country : null, campaignId: q.campaignId || null, ruleId: q.ruleId || null });
    return c.json({ period, ...result, attributionRule: ATTRIBUTION_RULE, timezone: store.timezone, currency: store.currency });
  });

  // ---------------------------------------------------------------- billing

  app.get(`${base}/billing`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, SMS_READ);
    const store = await smsStore(ws, storeId);
    const month = /^\d{4}-\d{2}$/.test(c.req.query("month") ?? "") ? c.req.query("month")! : billingMonth(new Date());
    return c.json(await smsBilling(store, await senderOf(store.id), month));
  });

  // ---------------------------------------------------------------- consent

  app.get(`${base}/contacts`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireSmsContacts(c, deps, ws);
    await smsStore(ws, storeId);
    const q = c.req.query();
    const paging = cursorPage(q, 50);
    const where: Prisma.SmsContactWhereInput = {
      workspaceId: ws,
      storeId,
      ...(q.consent && q.consent in CONSENT_LABEL ? { consentState: q.consent } : {}),
      ...(q.suppressed === "1" ? { OR: [{ suppressedAll: true }, { suppressedMarketing: true }] } : {}),
      ...(q.q ? { phoneMasked: { endsWith: q.q.replace(/\D/g, "").slice(-3) || "~" } } : {}),
    };
    const rows = await withTenant(ws, (tx) => tx.smsContact.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], ...paging.args }));
    const { items, nextCursor } = paging.split(rows);
    return c.json({
      contacts: items.map((r) => ({
        id: r.id,
        number: r.phoneMasked,
        country: r.country,
        consent: r.consentState,
        consentLabel: CONSENT_LABEL[r.consentState as keyof typeof CONSENT_LABEL] ?? r.consentState,
        consentSource: r.consentSource,
        consentCollectedFrom: r.consentCollectedFrom,
        consentUpdatedAt: r.consentUpdatedAt,
        suppressedAll: r.suppressedAll,
        suppressedMarketing: r.suppressedMarketing,
        orders: r.ordersCount,
        lastOrderAt: r.lastOrderAt,
        lastMessageAt: r.lastMessageAt,
      })),
      nextCursor,
    });
  });

  app.get(`${base}/contacts/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireSmsContacts(c, deps, ws);
    await smsStore(ws, storeId);
    const r = await withTenant(ws, (tx) => tx.smsContact.findFirst({ where: { id, workspaceId: ws, storeId }, include: { consentRecords: { orderBy: { recordedAt: "desc" }, take: 50 } } }));
    if (!r) throw new HttpError(404, "Not found", "not_found");
    return c.json({
      contact: { id: r.id, number: r.phoneMasked, country: r.country, consent: r.consentState, suppressedAll: r.suppressedAll, suppressedMarketing: r.suppressedMarketing },
      history: r.consentRecords.map((h) => ({ state: h.state, purpose: h.purpose, source: h.source, optInLevel: h.optInLevel, evidence: h.evidence, effectiveAt: h.effectiveAt, recordedAt: h.recordedAt })),
    });
  });

  /** Record an opt-out the customer gave another way (a phone call, an email): their texts stop at once. */
  app.post(`${base}/contacts/:id/opt-out`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    if (!allows(a.access, "customers.contact")) throw new HttpError(403, "You don't have permission to see customers' contact details", "forbidden");
    const store = await smsStore(ws, storeId);
    const input = z.object({ scope: z.enum(["all", "marketing"]).default("all"), note: z.string().trim().max(200).nullish() }).parse(await body(c));
    const r = await withTenant(ws, (tx) => tx.smsContact.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!r) throw new HttpError(404, "Not found", "not_found");
    await suppressNumber(store, contactPhone(r), input.scope, "merchant", { createdBy: a.user?.id ?? null, note: input.note ?? null, evidence: { by: a.user?.id ?? null } });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- suppression list

  app.get(`${base}/suppressions`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireSmsContacts(c, deps, ws);
    await smsStore(ws, storeId);
    const paging = cursorPage(c.req.query(), 50);
    const rows = await withTenant(ws, (tx) => tx.smsSuppression.findMany({ where: { workspaceId: ws, storeId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...paging.args }));
    const { items, nextCursor } = paging.split(rows);
    return c.json({
      suppressions: items.map((s) => ({ id: s.id, number: s.phoneMasked, scope: s.scope, reason: s.reason, reasonLabel: SUPPRESSION_LABEL[s.reason as SuppressionReason] ?? s.reason, note: s.note, liftable: liftableSuppression(s.reason), createdAt: s.createdAt })),
      nextCursor,
    });
  });

  app.post(`${base}/suppressions`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const input = z.object({ number: z.string().trim().min(6).max(30), country: z.string().regex(/^[A-Z]{2}$/).nullish(), scope: z.enum(["all", "marketing"]).default("all"), note: z.string().trim().max(200).nullish() }).parse(await body(c));
    const phone = normalizePhone(input.number, input.country ?? null);
    if (!phone) throw new HttpError(400, "Enter a mobile number with its country code, such as +61 412 345 678.", "invalid_number");
    const r = await suppressNumber(store, phone.e164, input.scope, "merchant", { createdBy: a.user?.id ?? null, note: input.note ?? null });
    return c.json({ ok: true, created: r.created }, r.created ? 201 : 200);
  });

  /** Lift a suppression the team added (or an invalid number). Never one the customer asked for. */
  app.delete(`${base}/suppressions/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_MANAGE);
    const store = await smsStore(ws, storeId);
    const row = await withTenant(ws, (tx) => tx.smsSuppression.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!row) throw new HttpError(404, "Not found", "not_found");
    if (!liftableSuppression(row.reason)) throw new HttpError(409, "The customer asked to stop: only they can opt in again (through Shopify).", "not_liftable");
    await liftSuppression(store, id);
    await smsAudit({ workspaceId: ws, storeId, actorUserId: a.user?.id ?? null, action: "suppression_lifted", targetType: "sms_suppression", targetId: id, metadata: { number: row.phoneMasked, reason: row.reason } });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- audit trail

  app.get(`${base}/audit`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, SMS_READ);
    if (!can(a.role, "audit:read")) throw new HttpError(403, "Only owners and admins see the audit trail", "forbidden");
    await smsStore(ws, storeId);
    const paging = cursorPage(c.req.query(), 50);
    const rows = await withTenant(ws, (tx) => tx.smsAuditLog.findMany({ where: { workspaceId: ws, storeId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...paging.args }));
    const { items, nextCursor } = paging.split(rows);
    const actorIds = [...new Set(items.map((i) => i.actorUserId).filter((x): x is string => !!x))];
    const actors = actorIds.length ? await systemDb.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, displayName: true } }) : [];
    const who = new Map(actors.map((u) => [u.id, u.displayName || u.email]));
    return c.json({ entries: items.map((e) => ({ id: e.id, action: e.action, targetType: e.targetType, targetId: e.targetId, version: e.version, actor: e.actorUserId ? (who.get(e.actorUserId) ?? "A former member") : "bizinsights", metadata: e.metadata, at: e.createdAt })), nextCursor });
  });
}
