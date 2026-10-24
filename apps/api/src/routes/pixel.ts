import { z } from "zod";
import { systemDb } from "@app/db";
import { env } from "@app/core";
import { arrivalSource, CLICK_IDS, EVENT_STEP, foldVisit, funnelDevice, localDay, productStepsOf, sha256Hex, type PixelEventIn, type PixelEventName, type TrafficSource } from "@app/shared";
import { clientIp, type Deps } from "../context.js";
import { deviceOf, locationOf } from "../devices.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/** Shopify standard customer events we turn into funnel steps (see EVENT_STEP). */
const EVENT_NAMES = Object.keys(EVENT_STEP) as [PixelEventName, ...PixelEventName[]];

const eventSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.enum(EVENT_NAMES),
  clientId: z.string().min(1).max(200),
  timestamp: z.string().datetime({ offset: true }),
  // The page it happened on (location.pathname). Optional: pixels deployed before it existed send none.
  // Up to the 2048 characters the pixel sends (shopify-app/extensions/insights-pixel): one longer
  // path used to fail the whole batch, and the pixel drops a refused batch, so those visits were
  // lost. What is stored is cut down by cleanPath (MAX_PATH).
  path: z.string().max(2048).optional(),
  // How the shopper arrived, with the page view of a page reached from outside the store (PixelArrival):
  // a host and tag values only, as cut by the pixel. Optional, like everything after `path`: older pixels send none.
  arrival: z
    .object({
      ref: z.string().max(253).optional(),
      utmSource: z.string().max(100).optional(),
      utmMedium: z.string().max(100).optional(),
      click: z.array(z.enum(CLICK_IDS)).max(CLICK_IDS.length).optional(),
    })
    .optional(),
  // The products an add to cart or a checkout holds, by handle (productStepsOf). The pixel sends at most 50 of 200 characters.
  products: z.array(z.string().max(200)).max(50).optional(),
});
const bodySchema = z.object({ events: z.array(eventSchema).min(1).max(50) });
/** Clock skew tolerated on a shopper's device. */
const PIXEL_MAX_FUTURE_MS = 3600_000;
/**
 * How old an event may be. A real pixel reports within seconds (a beacon held by an offline
 * device, within hours), so anything older is a replay or someone writing history into a store's
 * funnel with its public key. Production only: the local demo backfills weeks of visits.
 */
export const PIXEL_MAX_AGE_MS = 48 * 3600_000;

/** Whether an event's timestamp is one a real pixel could send now (see the two limits above). */
export function pixelEventInWindow(timestamp: string, now: number, production: boolean): boolean {
  const t = Date.parse(timestamp);
  return t <= now + PIXEL_MAX_FUTURE_MS && (!production || t >= now - PIXEL_MAX_AGE_MS);
}

/**
 * Web pixel ingest. The ingest key identifies the store; it is embedded in the
 * storefront so it is NOT a secret: treat these counts as behavioural signals,
 * never as financial data (revenue KPIs come from orders only). Events are
 * deduped by id, then folded into one `funnel_visits` row per shopper per
 * store-local day (hashed clientId). Paths are cleaned of query strings and
 * shopper tokens before storage (`cleanPath`). No PII is accepted or stored.
 *
 * The request itself says two things more about the visit, kept as one word each: the kind of
 * device (`funnelDevice`, from the browser's User-Agent; the pixel runs in the shopper's browser)
 * and the country the edge placed the request in (`locationOf`). Neither the User-Agent nor the
 * address is stored. Where the visit came from is one word too (`source`, `arrivalSource`), from the
 * first arrival the pixel reports: a referring host and a link's utm_source/utm_medium and click id
 * names, which are classified and dropped. Product views, adds to cart (on a product's page, or
 * quick adds elsewhere), checkouts and purchases are kept per visit and product
 * (`funnel_product_visits`, `productStepsOf`) for the Shopping Funnel's product table.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
};

export function pixelRoutes(app: App, deps: Deps) {
  app.options("/pixel/:key", (c) => c.body(null, 204, CORS));

  app.post("/pixel/:key", async (c) => {
    c.header("access-control-allow-origin", "*");
    const { key } = c.req.param();
    await limit(deps.coord, `rl:pixel:${clientIp(c)}`, LIMITS.pixelIp);
    // navigator.sendBeacon posts text/plain, so parse the raw text whatever the content type.
    const raw = await c.req.text();
    // 50 events (the pixel's largest batch) with 2048-character paths fit, and checkouts naming 50 products.
    if (raw.length > 256 * 1024) return c.json({ error: "invalid_body" }, 413);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const store = await systemDb.store.findUnique({ where: { pixelIngestKey: key } });
    if (!store || store.status === "uninstalled") return c.json({ error: "not_found" }, 404);
    // The ingest key is public, so the timestamp is whatever the caller says. A real pixel reports
    // after the fact; an event dated in the future (beyond clock skew) would sit in days that have
    // not happened yet and inflate them when they arrive, so it is dropped rather than counted.
    const now = Date.now();
    const production = env().NODE_ENV === "production";
    const events = parsed.data.events.filter((e) => pixelEventInWindow(e.timestamp, now, production));
    if (!events.length) return c.json({ ok: true, accepted: 0 });
    const device = funnelDevice(deviceOf(c), c.req.header("sec-ch-ua-mobile"));
    const country = locationOf(c)?.country ?? null;

    // One transaction, so an event is never marked seen without being counted. The pixel sends a
    // batch per page or so, nearly always from one shopper: that is one dedupe insert and one upsert.
    const accepted = await systemDb.$transaction(async (tx) => {
      const ids = [...new Set(events.map((e) => `e:${e.id}`))];
      const fresh = await tx.$queryRaw<Array<{ event_id: string }>>`
        INSERT INTO pixel_events_seen (store_id, event_id)
        SELECT ${store.id}, unnest(${ids}::text[])
        ON CONFLICT DO NOTHING
        RETURNING event_id`;
      const freshIds = new Set(fresh.map((r) => r.event_id));

      const visits = new Map<string, { day: string; visitor: string; events: PixelEventIn[]; source: TrafficSource | null; sourceAt: Date | null }>();
      const products = new Map<string, { day: string; visitor: string; handle: string; steps: number }>();
      for (const ev of events) {
        // Delete as we go: a batch that repeats an id counts it once.
        if (!freshIds.delete(`e:${ev.id}`)) continue;
        const at = new Date(ev.timestamp);
        const day = localDay(at, store.timezone);
        const visitor = sha256Hex(ev.clientId);
        const k = `${day}|${visitor}`;
        const v = visits.get(k) ?? { day, visitor, events: [], source: null, sourceAt: null };
        v.events.push({ name: ev.name, timestamp: at, path: ev.path });
        // The batch's earliest arrival says where the visit came from.
        const source = ev.arrival ? arrivalSource(ev.arrival, ev.path) : null;
        if (source && (!v.sourceAt || at < v.sourceAt)) {
          v.source = source;
          v.sourceAt = at;
        }
        visits.set(k, v);
        for (const product of productStepsOf(ev.name, ev.path, ev.products)) {
          const pk = `${k}|${product.handle}`;
          const p = products.get(pk) ?? { day, visitor, handle: product.handle, steps: 0 };
          p.steps |= product.steps;
          products.set(pk, p);
        }
      }

      let n = 0;
      for (const { day, visitor, events, source } of visits.values()) {
        const d = foldVisit(events);
        // Merge into the day's row: the earliest located event is the entry, the latest the exit,
        // whichever batch they arrive in. Every SET expression reads the row as it was before, and
        // a batch with no located event (NULL entered_at/exited_at) leaves entry and exit alone.
        await tx.$executeRaw`
          INSERT INTO funnel_visits AS v (workspace_id, store_id, day, visitor, entered_at, entry_section, entry_path,
                                          exited_at, exit_section, exit_path, furthest_step, sections, page_views, device, country, source)
          VALUES (${store.workspaceId}, ${store.id}, ${day}, ${visitor}, ${d.enteredAt}, ${d.entrySection}, ${d.entryPath},
                  ${d.exitedAt}, ${d.exitSection}, ${d.exitPath}, ${d.furthestStep}, ${d.sections}, ${d.pageViews}, ${device}, ${country}, ${source})
          ON CONFLICT (store_id, day, visitor) DO UPDATE SET
            entered_at    = CASE WHEN EXCLUDED.entered_at < v.entered_at OR v.entered_at IS NULL THEN EXCLUDED.entered_at ELSE v.entered_at END,
            entry_section = CASE WHEN EXCLUDED.entered_at < v.entered_at OR v.entered_at IS NULL THEN EXCLUDED.entry_section ELSE v.entry_section END,
            entry_path    = CASE WHEN EXCLUDED.entered_at < v.entered_at OR v.entered_at IS NULL THEN EXCLUDED.entry_path ELSE v.entry_path END,
            exited_at     = CASE WHEN EXCLUDED.exited_at >= v.exited_at OR v.exited_at IS NULL THEN EXCLUDED.exited_at ELSE v.exited_at END,
            exit_section  = CASE WHEN EXCLUDED.exited_at >= v.exited_at OR v.exited_at IS NULL THEN EXCLUDED.exit_section ELSE v.exit_section END,
            exit_path     = CASE WHEN EXCLUDED.exited_at >= v.exited_at OR v.exited_at IS NULL THEN EXCLUDED.exit_path ELSE v.exit_path END,
            furthest_step = GREATEST(v.furthest_step, EXCLUDED.furthest_step),
            sections      = v.sections | EXCLUDED.sections,
            page_views    = v.page_views + EXCLUDED.page_views,
            device        = COALESCE(v.device, EXCLUDED.device),
            country       = COALESCE(v.country, EXCLUDED.country),
            source        = COALESCE(v.source, EXCLUDED.source)`;
        n += events.length;
      }
      // Which products each visit saw, added to cart, took to checkout and bought: one statement for the batch.
      if (products.size) {
        const rows = [...products.values()];
        await tx.$executeRaw`
          INSERT INTO funnel_product_visits AS p (workspace_id, store_id, day, visitor, handle, steps)
          SELECT ${store.workspaceId}, ${store.id}, r.day, r.visitor, r.handle, r.steps
          FROM unnest(${rows.map((r) => r.day)}::text[], ${rows.map((r) => r.visitor)}::text[], ${rows.map((r) => r.handle)}::text[], ${rows.map((r) => r.steps)}::smallint[]) AS r(day, visitor, handle, steps)
          ON CONFLICT (store_id, day, visitor, handle) DO UPDATE SET steps = p.steps | EXCLUDED.steps`;
      }
      return n;
    });

    if (accepted && !store.pixelInstalled) {
      await systemDb.store.update({ where: { id: store.id }, data: { pixelInstalled: true } });
    }
    // A pixel in place before bizinsights recorded one (made before the record existed, or kept
    // through a reinstall): its visits count from now, for the dashboard's "No earlier data".
    if (accepted && !store.pixelInstalledAt) {
      await systemDb.store.updateMany({ where: { id: store.id, pixelInstalledAt: null }, data: { pixelInstalledAt: new Date() } });
    }
    return c.json({ ok: true, accepted });
  });
}
