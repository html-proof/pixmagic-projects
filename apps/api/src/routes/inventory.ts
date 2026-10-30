import { z } from "zod";
import { withTenant, type Store, type Tx } from "@app/db";
import {
  adjustmentList,
  adjustmentView,
  adjustStock,
  audit,
  declaredScopes,
  evaluateStockAlerts,
  inventoryOverview,
  inventoryReports,
  inventorySettings,
  inventoryStatus,
  livePassWhere,
  locationsReport,
  logger,
  maskNumber,
  movementList,
  optionalScopesFor,
  PRODUCT_MEDIA_QUERY,
  productDetail,
  productGid,
  salesDays,
  saveInventorySettings,
  startInventoryPass,
  stockFacets,
  stockList,
  stockScope,
  stockTable,
  storeGraphql,
  toCsv,
} from "@app/core";
import { adjustmentSchema, allows, inventorySettingsSchema, localDay, resolveCapabilities, stockQuerySchema, thresholdSchema } from "@app/shared";
import { body, clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { datesQuery, resolveQueryDates } from "./dashboard.js";

/**
 * The Inventory pages (docs/inventory.md). Every route is one store's, and asks for the Team &
 * Access permission its data needs: `inventory.view` for stock, `inventory.products` for product
 * information, `inventory.costs` for costs and stock value (left out, not computed, without it),
 * `inventory.history` for the stock history, `inventory.export`, `inventory.adjust`,
 * `inventory.alerts` and `inventory.settings` for the rest. Reads go through `withTenant` (RLS);
 * stock changes go to Shopify and are shown only once it confirms them (core/inventory/adjust.ts).
 */

const datesSchema = z.object(datesQuery);
const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(10).max(200).default(50) });
const movementQuerySchema = pageSchema.extend({
  source: z.enum(["observed", "bizinsights"]).optional(),
  location: z.string().regex(/^\d{1,20}$/).optional(),
  product: z.string().regex(/^\d{1,20}$/).optional(),
  variant: z.string().regex(/^\d{1,20}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(100).optional(),
});
const productParam = z.string().regex(/^\d{1,20}$/);
const syncSettingsSchema = inventorySettingsSchema.pick({ reconcileHours: true, leadTimeDays: true, coverDays: true });
const alertSettingsSchema = inventorySettingsSchema.pick({ lowStockThreshold: true, emailAlerts: true, dashboardAlerts: true, whatsappAlerts: true, whatsappTemplate: true, whatsappTo: true });

async function loadStore(tx: Tx, ws: string, storeId: string): Promise<Store> {
  const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
  if (!store) throw new HttpError(404, "Not found", "not_found");
  return store;
}

/** The settings as the API shows them: WhatsApp numbers masked. */
function publicSettings(s: Awaited<ReturnType<typeof inventorySettings>>) {
  const { whatsappTo, storeId: _s, ...rest } = s;
  return { ...rest, whatsappTo: whatsappTo.map(maskNumber) };
}

export function inventoryRoutes(app: App, deps: Deps) {
  const base = "/workspaces/:ws/stores/:storeId/inventory";

  /** Where the stock comes from, whether it's current, what Shopify access the module has and can ask for. */
  app.get(`${base}/status`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.view");
    return c.json(
      await withTenant(ws, async (tx) => {
        const store = await loadStore(tx, ws, storeId);
        const [scope, settings] = await Promise.all([stockScope(store), inventorySettings(store.id)]);
        const caps = resolveCapabilities(store.grantedScopes, { optionalScopes: optionalScopesFor(store), declaredScopes: declaredScopes() }).filter((x) => x.area === "inventory");
        return {
          store: { id: store.id, name: store.name ?? store.shopDomain, currency: store.currency, timezone: store.timezone, status: store.status, shopDomain: store.shopDomain },
          status: await inventoryStatus(tx, store, scope, settings),
          capabilities: caps,
          // What this member may do here (the API enforces it; the pages use it to show what fits).
          can: {
            products: allows(a.access, "inventory.products"),
            costs: allows(a.access, "inventory.costs"),
            history: allows(a.access, "inventory.history"),
            export: allows(a.access, "inventory.export"),
            adjust: allows(a.access, "inventory.adjust"),
            alerts: allows(a.access, "inventory.alerts"),
            settings: allows(a.access, "inventory.settings"),
            connect: allows(a.access, "stores:manage"),
          },
        };
      }),
    );
  });

  /** The overview's figures for the dates asked about (`preset=30d`, `compare=…`). */
  app.get(`${base}/overview`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.view");
    const q = datesSchema.parse(c.req.query());
    return c.json(
      await withTenant(ws, async (tx) => {
        const store = await loadStore(tx, ws, storeId);
        const now = new Date();
        const dates = resolveQueryDates(q, now, store.timezone);
        const today = localDay(now, store.timezone);
        const [scope, sales, settings] = await Promise.all([stockScope(store), salesDays(store, today), inventorySettings(store.id)]);
        const see = { costs: allows(a.access, "inventory.costs") };
        const overview = await inventoryOverview(tx, store, scope, dates, sales, now, see);
        // The items needing attention first, for the overview's lists.
        const list = (status: "low" | "out") =>
          stockList(tx, scope, stockQuerySchema.parse({ status, sort: "available", dir: "asc", pageSize: 10 }), sales, today, settings, see).then((r) => ({ rows: r.rows, total: r.total }));
        const [low, out] = await Promise.all([list("low"), list("out")]);
        return { range: dates.range, previous: dates.previous, status: await inventoryStatus(tx, store, scope, settings, now), ...overview, lowStock: low, outOfStock: out, source: scope.source };
      }),
    );
  });

  /** A page of the stock list (filters, search, sorting: stockQuerySchema). */
  app.get(`${base}/stock`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.view");
    const q = stockQuerySchema.parse(c.req.query());
    return c.json(
      await withTenant(ws, async (tx) => {
        const store = await loadStore(tx, ws, storeId);
        const today = localDay(new Date(), store.timezone);
        const [scope, sales, settings] = await Promise.all([stockScope(store, q.location), salesDays(store, today), inventorySettings(store.id)]);
        const page = await stockList(tx, scope, q, sales, today, settings, { costs: allows(a.access, "inventory.costs") });
        return { ...page, source: scope.source, salesDays: sales.days, location: scope.location ?? null };
      }),
    );
  });

  app.get(`${base}/stock/facets`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "inventory.view");
    return c.json(await withTenant(ws, async (tx) => stockFacets(tx, await stockScope(await loadStore(tx, ws, storeId)))));
  });

  /** The stock list as CSV, every row the filters match; costs only for a member who may see them. */
  app.get(`${base}/stock/export`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.export");
    const q = stockQuerySchema.parse(c.req.query());
    await limit(deps.coord, `rl:inventory-export:${a.user?.id ?? ws}`, LIMITS.dashboardExports, "Too many downloads. Wait a few minutes and try again.");
    const see = { costs: allows(a.access, "inventory.costs") };
    const { csv, shop, count } = await withTenant(ws, async (tx) => {
      const store = await loadStore(tx, ws, storeId);
      const today = localDay(new Date(), store.timezone);
      const [scope, sales, settings] = await Promise.all([stockScope(store, q.location), salesDays(store, today), inventorySettings(store.id)]);
      const { rows } = await stockList(tx, scope, q, sales, today, settings, see, { all: true });
      const location = scope.location ? ((await tx.inventoryLocation.findFirst({ where: { workspaceId: ws, storeId, shopifyId: scope.location }, select: { name: true } }))?.name ?? null) : null;
      const t = stockTable(rows, see, location);
      return { csv: toCsv(t.header, t.rows), shop: store.shopDomain.replace(/\.myshopify\.com$/, ""), count: rows.length };
    });
    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "inventory.exported", targetType: "store", targetId: storeId, metadata: { rows: count, costs: see.costs, filters: q }, ip: clientIp(c) });
    const filename = `bizinsights-${shop}-stock-${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    c.header("content-length", String(csv.length));
    return c.body(csv as unknown as ArrayBuffer, 200);
  });

  /** One product: its information, variants, stock per location, sales and (with inventory.history) its stock history. */
  app.get(`${base}/products/:productId`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.view");
    const productId = productParam.parse(c.req.param("productId"));
    const detail = await withTenant(ws, async (tx) => {
      const store = await loadStore(tx, ws, storeId);
      const today = localDay(new Date(), store.timezone);
      const [scope, sales, settings] = await Promise.all([stockScope(store), salesDays(store, today), inventorySettings(store.id)]);
      return productDetail(tx, store, scope, productId, sales, today, settings, {
        costs: allows(a.access, "inventory.costs"),
        info: allows(a.access, "inventory.products"),
        history: allows(a.access, "inventory.history"),
      });
    });
    if (!detail) throw new HttpError(404, "That product wasn't found. It may have been deleted in Shopify.", "not_found");
    return c.json(detail);
  });

  /** A product's images and options, read live from Shopify (bizinsights keeps only the featured image). */
  app.get(`${base}/products/:productId/media`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.products");
    const productId = productParam.parse(c.req.param("productId"));
    await limit(deps.coord, `rl:inventory-media:${a.user?.id ?? ws}`, LIMITS.inventoryMedia);
    const store = await withTenant(ws, (tx) => loadStore(tx, ws, storeId));
    if (store.status === "uninstalled") throw new HttpError(409, "The store isn't connected.", "store_disconnected");
    try {
      const d = await storeGraphql(store, deps.coord, deps.fetchImpl)<{ product: { media: { nodes: Array<{ preview?: { image?: { url?: string; altText?: string | null } | null } | null }> }; options: Array<{ name: string; optionValues: Array<{ name: string }> }> } | null }>(
        PRODUCT_MEDIA_QUERY,
        { id: productGid(productId) },
      );
      if (!d.product) throw new HttpError(404, "That product wasn't found in Shopify.", "not_found");
      return c.json({
        images: d.product.media.nodes.flatMap((m) => (m.preview?.image?.url ? [{ url: m.preview.image.url, alt: m.preview.image.altText ?? null }] : [])),
        options: d.product.options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      logger.warn({ err, storeId }, "product media couldn't be read from Shopify");
      throw new HttpError(502, "Shopify didn't answer just now. The product's other details are still shown.", "shopify_unavailable");
    }
  });

  app.get(`${base}/locations`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.view");
    return c.json(await withTenant(ws, async (tx) => locationsReport(tx, await stockScope(await loadStore(tx, ws, storeId)), { costs: allows(a.access, "inventory.costs") })));
  });

  /** The stock history: changes seen in Shopify and changes made here. */
  app.get(`${base}/movements`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "inventory.history");
    const q = movementQuerySchema.parse(c.req.query());
    return c.json(await withTenant(ws, async (tx) => movementList(tx, await loadStore(tx, ws, storeId), q)));
  });

  /** The stock changes asked for in bizinsights, with Shopify's answer to each. */
  app.get(`${base}/adjustments`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "inventory.history");
    const q = pageSchema.parse(c.req.query());
    return c.json(await withTenant(ws, async (tx) => adjustmentList(tx, await loadStore(tx, ws, storeId), q.page, q.pageSize)));
  });

  /**
   * Change stock in Shopify. The client sends one idempotency key per confirmation, so sending it
   * again (a retry after an unconfirmed answer) changes stock once. 200 once Shopify confirmed;
   * a refusal or an unconfirmed change is an error with what to do (core/inventory/adjust.ts).
   */
  app.post(`${base}/adjustments`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.adjust");
    const input = adjustmentSchema.parse(await body(c));
    await limit(deps.coord, `rl:inventory-adjust:${a.user?.id ?? ws}`, LIMITS.inventoryAdjust, "Too many stock changes in a short time. Wait a few minutes and try again.");
    const store = await withTenant(ws, (tx) => loadStore(tx, ws, storeId));
    if (store.status === "uninstalled") throw new HttpError(409, "The store isn't connected, so its stock can't change.", "store_disconnected");
    const result = await adjustStock({ coord: deps.coord, gql: storeGraphql(store, deps.coord, deps.fetchImpl) }, store, { userId: a.user?.id ?? null, ip: clientIp(c) }, input);
    return c.json({ adjustment: result });
  });

  /** One adjustment (the client asks after an unconfirmed answer, before trying again). */
  app.get(`${base}/adjustments/:id`, async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, "inventory.adjust");
    const row = await withTenant(ws, (tx) => tx.inventoryAdjustment.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!row) throw new HttpError(404, "Not found", "not_found");
    return c.json({ adjustment: adjustmentView(row) });
  });

  /** Charts and tables over the dates asked about. */
  app.get(`${base}/reports`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.view");
    const q = datesSchema.parse(c.req.query());
    return c.json(
      await withTenant(ws, async (tx) => {
        const store = await loadStore(tx, ws, storeId);
        const now = new Date();
        const dates = resolveQueryDates(q, now, store.timezone);
        const today = localDay(now, store.timezone);
        const [scope, sales] = await Promise.all([stockScope(store), salesDays(store, today)]);
        return { ...(await inventoryReports(tx, store, scope, dates.range, sales, today, { costs: allows(a.access, "inventory.costs") })), source: scope.source };
      }),
    );
  });

  /** "Refresh stock": a full pass over every location's levels now. */
  app.post(`${base}/sync`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.view");
    const store = await withTenant(ws, (tx) => loadStore(tx, ws, storeId));
    await limit(deps.coord, `rl:inventory-refresh:${store.id}`, LIMITS.inventoryRefresh, "Stock was refreshed a moment ago. Wait a few minutes before refreshing again.");
    const started = await startInventoryPass(deps, store, "manual");
    if (!started) {
      const busy = await withTenant(ws, (tx) => tx.syncJob.findFirst({ where: { workspaceId: ws, storeId, ...livePassWhere() } }));
      if (busy) return c.json({ started: false, running: true }, 202);
      throw new HttpError(409, "Stock levels need bizinsights to have access to them in Shopify first.", "scope_missing");
    }
    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "inventory.refreshed", targetType: "store", targetId: storeId, ip: clientIp(c) });
    return c.json({ started: true, running: true }, 202);
  });

  // ---- Settings

  app.get(`${base}/settings`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "inventory.view");
    const store = await withTenant(ws, (tx) => loadStore(tx, ws, storeId));
    return c.json({ settings: publicSettings(await inventorySettings(store.id)) });
  });

  /** How often stock is checked against Shopify, and the restock planning (inventory.settings). */
  app.put(`${base}/settings`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.settings");
    const input = syncSettingsSchema.parse(await body(c));
    const store = await withTenant(ws, (tx) => loadStore(tx, ws, storeId));
    const current = await inventorySettings(store.id);
    const { whatsappTo: _t, storeId: _s, updatedAt: _u, ...keep } = current;
    const saved = await saveInventorySettings(store, { ...keep, ...input });
    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "inventory.settings_changed", targetType: "store", targetId: storeId, metadata: input, ip: clientIp(c) });
    return c.json({ settings: publicSettings(saved) });
  });

  /** The store's low-stock threshold and how people are told (inventory.alerts). */
  app.put(`${base}/settings/alerts`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.alerts");
    const input = alertSettingsSchema.parse(await body(c));
    const store = await withTenant(ws, (tx) => loadStore(tx, ws, storeId));
    const current = await inventorySettings(store.id);
    const { whatsappTo: _t, storeId: _s, updatedAt: _u, ...keep } = current;
    const saved = await saveInventorySettings(store, { ...keep, ...input });
    // A new threshold moves variants between low and in stock straight away.
    if (input.lowStockThreshold !== current.lowStockThreshold) await evaluateStockAlerts(store).catch((err: unknown) => logger.warn({ err, storeId }, "stock alerts not re-evaluated"));
    const { whatsappTo, ...shown } = input;
    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "inventory.alerts_changed", targetType: "store", targetId: storeId, metadata: { ...shown, whatsappNumbers: whatsappTo?.length }, ip: clientIp(c) });
    return c.json({ settings: publicSettings(saved) });
  });

  /** A variant's or a product's own low-stock threshold (null: back to the one above). */
  app.put(`${base}/thresholds`, async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "inventory.alerts");
    const input = thresholdSchema.parse(await body(c));
    const store = await withTenant(ws, (tx) => loadStore(tx, ws, storeId));
    const { count, variants } = await withTenant(ws, async (tx) => {
      if (input.target === "variant") {
        const r = await tx.productVariant.updateMany({ where: { workspaceId: ws, storeId, shopifyId: input.id }, data: { lowStockThreshold: input.threshold } });
        return { count: r.count, variants: [input.id] };
      }
      const r = await tx.product.updateMany({ where: { workspaceId: ws, storeId, shopifyId: input.id }, data: { lowStockThreshold: input.threshold } });
      const vs = await tx.productVariant.findMany({ where: { workspaceId: ws, storeId, productShopifyId: input.id }, select: { shopifyId: true } });
      return { count: r.count, variants: vs.map((v) => v.shopifyId) };
    });
    if (!count) throw new HttpError(404, "Not found", "not_found");
    await evaluateStockAlerts(store, { variants }).catch((err: unknown) => logger.warn({ err, storeId }, "stock alerts not re-evaluated"));
    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "inventory.threshold_changed", targetType: input.target, targetId: input.id, metadata: { threshold: input.threshold, storeId }, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** The store's open stock alerts, newest first. */
  app.get(`${base}/alerts`, async (c) => {
    const { ws, storeId } = c.req.param();
    await requireWorkspace(c, deps, ws, "inventory.view");
    return c.json(
      await withTenant(ws, async (tx) => {
        await loadStore(tx, ws, storeId);
        const rows = await tx.$queryRaw<Array<{ id: string; kind: string; variant_id: string; available: number; threshold: number | null; opened_at: Date; product_id: string | null; product_title: string | null; variant_title: string | null; sku: string | null }>>`
          SELECT a.id, a.kind, a.variant_shopify_id AS variant_id, a.available, a.threshold, a.opened_at,
                 v.product_shopify_id AS product_id, p.title AS product_title, v.title AS variant_title, v.sku
          FROM inventory_alerts a
          LEFT JOIN product_variants v ON v.store_id = a.store_id AND v.shopify_id = a.variant_shopify_id
          LEFT JOIN products p ON p.store_id = a.store_id AND p.shopify_id = v.product_shopify_id
          WHERE a.workspace_id = ${ws} AND a.store_id = ${storeId} AND a.resolved_at IS NULL
          ORDER BY a.opened_at DESC LIMIT 200`;
        return {
          alerts: rows.map((r) => ({ id: r.id, kind: r.kind, variantId: r.variant_id, productId: r.product_id, productTitle: r.product_title, variantTitle: r.variant_title, sku: r.sku, available: r.available, threshold: r.threshold, openedAt: r.opened_at })),
        };
      }),
    );
  });
}
