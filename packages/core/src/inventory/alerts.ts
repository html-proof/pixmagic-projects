/**
 * Stock alerts. Each variant has at most one alert per kind (inventory_alerts): opened when it
 * crosses into low or out of stock, resolved when it leaves. People are told about an alert once,
 * in one message per store that lists everything new since the last one (email to the team, a
 * WhatsApp message to the numbers the merchant chose, the bell), so a variant that stays low, or
 * a webhook delivered twice, never repeats it; one that flaps is told again at most once a day.
 */
import { Prisma, systemDb, type Store } from "@app/db";
import { addDays, allows, dailyRate, isFastMovement, localDay, templateShape, type TemplateComponent } from "@app/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { Mailer } from "../notify.js";
import type { Queues } from "../queues.js";
import { escapeHtml } from "@app/shared/email";
import { scheduleMessage } from "../whatsapp/messages.js";
import { inventorySettings } from "./settings.js";
import { salesDays, soldCte, STATUS, stockScope, variantStockCte } from "./stock.js";

export type StockAlertKind = "out_of_stock" | "low_stock" | "fast_movement";

/** An alert told already is told again only if it was resolved and opened again at least this long after. */
export const RENOTIFY_AFTER_MS = 24 * 3600_000;
/** The bell's alert (alerts table) for a store's open stock alerts. */
export const STOCK_ALERT_CODE = "inventory_stock";

type StoreRef = Pick<Store, "id" | "workspaceId" | "grantedScopes">;

/**
 * Bring the store's out- and low-stock alerts in line with its stock, for `variants` (after a
 * webhook or a change made here) or every variant (after a full pass). Returns what changed.
 */
export async function evaluateStockAlerts(store: StoreRef, opts: { variants?: readonly string[]; now?: Date } = {}): Promise<{ opened: number; resolved: number }> {
  const now = opts.now ?? new Date();
  if (opts.variants && !opts.variants.length) return { opened: 0, resolved: 0 };
  const scope = await stockScope(store);
  const only = opts.variants ? Prisma.sql`AND variant_id = ANY(${[...opts.variants]}::text[])` : Prisma.empty;
  const rows = await systemDb.$queryRaw<Array<{ variant_id: string; available: number; threshold: number; status: string }>>`
    WITH ${variantStockCte(scope)}
    SELECT variant_id, available, threshold, ${STATUS} AS status FROM vs WHERE tracked ${only}`;
  const want = new Map<string, { kind: StockAlertKind; available: number; threshold: number }>();
  for (const r of rows) {
    if (r.status === "out") want.set(r.variant_id, { kind: "out_of_stock", available: r.available, threshold: r.threshold });
    if (r.status === "low") want.set(r.variant_id, { kind: "low_stock", available: r.available, threshold: r.threshold });
  }
  const existing = await systemDb.inventoryAlert.findMany({
    where: { storeId: store.id, kind: { in: ["out_of_stock", "low_stock"] }, ...(opts.variants ? { variantShopifyId: { in: [...opts.variants] } } : {}) },
  });
  let opened = 0;
  let resolved = 0;
  // Open (or keep open, with today's numbers) what should be.
  for (const [variant, w] of want) {
    const row = existing.find((e) => e.variantShopifyId === variant && e.kind === w.kind);
    if (row && !row.resolvedAt) {
      if (row.available !== w.available || row.threshold !== w.threshold) {
        await systemDb.inventoryAlert.update({ where: { id: row.id }, data: { available: w.available, threshold: w.threshold } });
      }
      continue;
    }
    if (row) {
      await systemDb.inventoryAlert.update({ where: { id: row.id }, data: { available: w.available, threshold: w.threshold, openedAt: now, resolvedAt: null } });
    } else {
      await systemDb.inventoryAlert.createMany({
        data: [{ workspaceId: store.workspaceId, storeId: store.id, variantShopifyId: variant, kind: w.kind, available: w.available, threshold: w.threshold, openedAt: now }],
        skipDuplicates: true,
      });
    }
    opened++;
  }
  // Resolve what no longer applies (restocked, or moved from low to out and back).
  const stale = existing.filter((e) => !e.resolvedAt && want.get(e.variantShopifyId)?.kind !== e.kind);
  if (stale.length) {
    const r = await systemDb.inventoryAlert.updateMany({ where: { id: { in: stale.map((e) => e.id) }, resolvedAt: null }, data: { resolvedAt: now } });
    resolved = r.count;
  }
  return { opened, resolved };
}

/**
 * Today's unusual sell-offs: variants selling at least FAST_MOVEMENT_FACTOR times their usual
 * daily rate (the 30 days before today, which the imported orders must cover). Alerts from an
 * earlier day are resolved: each one is about the day it was raised.
 */
export async function evaluateFastMovement(store: StoreRef & Pick<Store, "timezone" | "ordersHistoryFrom">, now = new Date()): Promise<number> {
  const today = localDay(now, store.timezone);
  const yesterday = addDays(today, -1);
  const history = await salesDays(store, yesterday);
  const s = { ws: store.workspaceId, storeId: store.id };
  const rows = await systemDb.$queryRaw<Array<{ variant_id: string; today: number; before: number; available: number | null }>>`
    WITH ${soldCte(s, today, today, "sold_today")}, ${soldCte(s, history.from, yesterday, "sold_before")}
    SELECT t.variant_id, t.units AS today, COALESCE(b.units, 0) AS before, v.inventory_quantity AS available
    FROM sold_today t
    LEFT JOIN sold_before b ON b.variant_id = t.variant_id
    JOIN product_variants v ON v.store_id = ${store.id} AND v.workspace_id = ${store.workspaceId} AND v.shopify_id = t.variant_id`;
  const fast = rows.filter((r) => isFastMovement(r.today, dailyRate(r.before, history.days)));
  const startOfToday = new Date(now.getTime() - 24 * 3600_000);
  await systemDb.inventoryAlert.updateMany({
    where: { storeId: store.id, kind: "fast_movement", resolvedAt: null, openedAt: { lt: startOfToday }, variantShopifyId: { notIn: fast.map((f) => f.variant_id) } },
    data: { resolvedAt: now },
  });
  let opened = 0;
  for (const f of fast) {
    const row = await systemDb.inventoryAlert.findUnique({ where: { storeId_variantShopifyId_kind: { storeId: store.id, variantShopifyId: f.variant_id, kind: "fast_movement" } } });
    if (row && !row.resolvedAt) continue;
    await systemDb.inventoryAlert.upsert({
      where: { storeId_variantShopifyId_kind: { storeId: store.id, variantShopifyId: f.variant_id, kind: "fast_movement" } },
      create: { workspaceId: store.workspaceId, storeId: store.id, variantShopifyId: f.variant_id, kind: "fast_movement", available: f.available ?? 0, threshold: null, openedAt: now },
      update: { available: f.available ?? 0, openedAt: now, resolvedAt: null },
    });
    opened++;
  }
  return opened;
}

interface AlertLine {
  kind: StockAlertKind;
  product: string;
  variant: string;
  sku: string | null;
  available: number;
}

/** One sentence for the counts: "3 products are out of stock and 5 are running low." */
export function stockSummary(counts: Record<StockAlertKind, number>): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (counts.out_of_stock) parts.push(`${n(counts.out_of_stock, "item is", "items are")} out of stock`);
  if (counts.low_stock) parts.push(`${n(counts.low_stock, "item is", "items are")} running low`);
  if (counts.fast_movement) parts.push(`${n(counts.fast_movement, "item is", "items are")} selling unusually fast`);
  if (!parts.length) return "No stock needs attention.";
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.`;
}

export interface NotifyDeps {
  mailer: Mailer;
  queues: Queues;
}

/**
 * Tell people about the store's newly opened alerts, once, and keep the bell's alert in step with
 * what is open. Returns how many alerts were announced.
 */
export async function notifyStockAlerts(deps: NotifyDeps, store: Pick<Store, "id" | "workspaceId" | "name" | "shopDomain">, now = new Date()): Promise<number> {
  const settings = await inventorySettings(store.id);
  const open = await systemDb.inventoryAlert.findMany({ where: { storeId: store.id, resolvedAt: null } });
  await syncBellAlert(store, open, settings.dashboardAlerts);
  const due = open.filter((a) => !a.notifiedAt || (a.notifiedAt < a.openedAt && now.getTime() - a.notifiedAt.getTime() >= RENOTIFY_AFTER_MS));
  if (!due.length) return 0;

  const variants = await systemDb.$queryRaw<Array<{ shopify_id: string; title: string; sku: string | null; product_title: string | null }>>`
    SELECT v.shopify_id, v.title, v.sku, p.title AS product_title
    FROM product_variants v LEFT JOIN products p ON p.store_id = v.store_id AND p.shopify_id = v.product_shopify_id
    WHERE v.store_id = ${store.id} AND v.shopify_id = ANY(${due.map((d) => d.variantShopifyId)}::text[])`;
  const names = new Map(variants.map((v) => [v.shopify_id, v]));
  const lines: AlertLine[] = due.map((d) => {
    const v = names.get(d.variantShopifyId);
    return { kind: d.kind as StockAlertKind, product: v?.product_title ?? "A deleted product", variant: v?.title ?? "", sku: v?.sku ?? null, available: d.available };
  });
  const counts = { out_of_stock: 0, low_stock: 0, fast_movement: 0 } as Record<StockAlertKind, number>;
  for (const l of lines) counts[l.kind]++;
  const storeName = store.name ?? store.shopDomain;

  if (settings.emailAlerts) await emailTeam(deps.mailer, store, storeName, counts, lines);
  if (settings.whatsappAlerts && settings.whatsappTemplate && settings.whatsappTo.length) {
    await whatsappTeam(deps, store, storeName, settings.whatsappTemplate, settings.whatsappTo, stockSummary(counts), now).catch((err: unknown) =>
      logger.error({ err, storeId: store.id }, "stock alert WhatsApp message could not be scheduled"),
    );
  }
  await systemDb.inventoryAlert.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { notifiedAt: now } });
  logger.info({ storeId: store.id, ...counts }, "stock alerts announced");
  return due.length;
}

/** The bell: one open alert per store while any out- or low-stock alert is open (when turned on). */
async function syncBellAlert(store: Pick<Store, "id" | "workspaceId" | "name" | "shopDomain">, open: ReadonlyArray<{ kind: string }>, on: boolean) {
  const out = open.filter((a) => a.kind === "out_of_stock").length;
  const low = open.filter((a) => a.kind === "low_stock").length;
  const current = await systemDb.alert.findFirst({ where: { storeId: store.id, code: STOCK_ALERT_CODE, resolvedAt: null } });
  if (!on || (!out && !low)) {
    if (current) await systemDb.alert.update({ where: { id: current.id }, data: { resolvedAt: new Date() } });
    return;
  }
  // Built from the app's wording and the store's own counts only (describeAlert passes it on).
  const message = `${stockSummary({ out_of_stock: out, low_stock: low, fast_movement: 0 })} Open Inventory to see which ones and restock them.`;
  if (current) {
    if (current.message !== message) await systemDb.alert.update({ where: { id: current.id }, data: { message, severity: out ? "warning" : "info" } });
    return;
  }
  await systemDb.alert.create({ data: { workspaceId: store.workspaceId, storeId: store.id, code: STOCK_ALERT_CODE, severity: out ? "warning" : "info", message } });
}

/** Who gets the email: members who may see the stock, signed up for stock alerts, not revoked or expired. */
async function recipients(workspaceId: string, now: Date): Promise<string[]> {
  const members = await systemDb.membership.findMany({
    where: { workspaceId, revokedAt: null, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }] },
    include: { user: { select: { email: true } } },
  });
  const optedOut = new Set((await systemDb.notificationPreference.findMany({ where: { workspaceId, stockAlerts: false }, select: { userId: true } })).map((p) => p.userId));
  return members.filter((m) => !optedOut.has(m.userId) && allows({ role: m.role, permissions: m.permissions }, "inventory.view")).map((m) => m.user.email);
}

const KIND_LABEL: Record<StockAlertKind, string> = { out_of_stock: "Out of stock", low_stock: "Low stock", fast_movement: "Selling unusually fast" };

async function emailTeam(mailer: Mailer, store: Pick<Store, "id" | "workspaceId">, storeName: string, counts: Record<StockAlertKind, number>, lines: AlertLine[]) {
  const to = await recipients(store.workspaceId, new Date());
  if (!to.length) return;
  const url = `${env().APP_URL}/inventory/low-stock`;
  const prefs = `${env().APP_URL}/settings/notifications`;
  const subject = `Stock alert: ${storeName}`;
  const shown = lines.slice(0, 20);
  const more = lines.length - shown.length;
  const label = (l: AlertLine) => `${l.product}${l.variant && l.variant !== "Default Title" ? ` (${l.variant})` : ""}${l.sku ? `, SKU ${l.sku}` : ""}`;
  const text = [
    subject,
    "",
    stockSummary(counts),
    "",
    ...shown.map((l) => `- ${KIND_LABEL[l.kind]}: ${label(l)}, ${l.available} available`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    "",
    `See them all and restock: ${url}`,
    "",
    `To stop these emails, turn off "Stock alerts" in Settings → Notifications: ${prefs}`,
  ].join("\n");
  const e = escapeHtml;
  const rows = shown
    .map((l) => `<tr><td style="padding:6px 8px;border-top:1px solid #e4e4e0">${e(KIND_LABEL[l.kind])}</td><td style="padding:6px 8px;border-top:1px solid #e4e4e0">${e(label(l))}</td><td style="padding:6px 8px;border-top:1px solid #e4e4e0;text-align:right">${l.available}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1b18">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e0;border-radius:12px;padding:28px">
<tr><td>
<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#2f6f4f">${e(storeName)}</p>
<h1 style="margin:0 0 12px;font-size:20px">Stock alert</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${e(stockSummary(counts))}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 16px"><tr><th align="left" style="padding:6px 8px">Alert</th><th align="left" style="padding:6px 8px">Item</th><th align="right" style="padding:6px 8px">Available</th></tr>${rows}</table>
${more > 0 ? `<p style="margin:0 0 16px;font-size:14px;color:#6b6b63">And ${more} more.</p>` : ""}
<p style="margin:0 0 8px"><a href="${e(url)}" style="display:inline-block;background:#2f6f4f;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">Open Inventory</a></p>
</td></tr></table>
<p style="font-size:12px;color:#6b6b63">To stop these emails, turn off "Stock alerts" in <a href="${e(prefs)}" style="color:#6b6b63">Settings → Notifications</a>.</p>
</td></tr></table></body></html>`;
  for (const address of to) {
    await mailer.send(address, subject, text, html).catch((err: unknown) => logger.error({ err, storeId: store.id }, "stock alert email failed"));
  }
}

/**
 * One WhatsApp message per number, through the store's own WhatsApp connection and an approved
 * template with two body variables ({{1}} the store's name, {{2}} the summary; the library's
 * "insights_stock_alert"). Sent as the merchant's own messages to their own team (WhatsApp's
 * test path: no customer, no consent record), deduplicated per number and day.
 */
async function whatsappTeam(deps: NotifyDeps, store: Pick<Store, "id" | "workspaceId">, storeName: string, templateName: string, numbers: string[], summary: string, now: Date) {
  const template = await systemDb.whatsappTemplate.findFirst({ where: { storeId: store.id, name: templateName, status: "APPROVED" } });
  if (!template) {
    logger.warn({ storeId: store.id, templateName }, "stock alert WhatsApp template isn't approved or is gone; not sent");
    return;
  }
  const shape = templateShape(template.components as unknown as TemplateComponent[]);
  if (shape.bodyVars !== 2 || shape.headerFormat !== "NONE" || shape.dynamicUrlButtons.length) {
    logger.warn({ storeId: store.id, templateName }, "stock alert WhatsApp template doesn't have the shape the alert fills in; not sent");
    return;
  }
  for (const to of numbers) {
    await scheduleMessage(
      {
        store,
        kind: "inventory_alert",
        dedupeKey: `inventory_alert:${to}:${now.toISOString().slice(0, 13)}`,
        contact: null,
        template: { name: template.name, language: template.language },
        mapping: { body: ["store_name", "custom_text"], buttons: [], fixed: { "body.2": summary.slice(0, 200) } },
        values: { store_name: storeName },
        scheduledFor: now,
        test: { to },
      },
      { queues: deps.queues },
    );
  }
}
