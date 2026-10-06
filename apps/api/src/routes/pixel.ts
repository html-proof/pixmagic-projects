import { z } from "zod";
import { systemDb } from "@app/db";
import { EVENT_STEP, foldVisit, localDay, sha256Hex, type PixelEventIn, type PixelEventName } from "@app/shared";
import { clientIp, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit } from "../rateLimit.js";

/** Shopify standard customer events we turn into funnel steps (see EVENT_STEP). */
const EVENT_NAMES = Object.keys(EVENT_STEP) as [PixelEventName, ...PixelEventName[]];

const eventSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.enum(EVENT_NAMES),
  clientId: z.string().min(1).max(200),
  timestamp: z.string().datetime({ offset: true }),
  // The page it happened on (location.pathname). Optional: pixels deployed before it existed send none.
  path: z.string().max(2048).optional(),
});
const bodySchema = z.object({ events: z.array(eventSchema).min(1).max(50) });
/** Clock skew tolerated on a shopper's device. */
const PIXEL_MAX_FUTURE_MS = 3600_000;

/**
 * Web pixel ingest. The ingest key identifies the store; it is embedded in the
 * storefront so it is NOT a secret: treat these counts as behavioural signals,
 * never as financial data (revenue KPIs come from orders only). Events are
 * deduped by id, then folded into one `funnel_visits` row per shopper per
 * store-local day (hashed clientId). Paths are cleaned of query strings and
 * shopper tokens before storage (`cleanPath`). No PII is accepted or stored.
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
    await limit(deps.coord, `rl:pixel:${clientIp(c)}`, 600, 60);
    // navigator.sendBeacon posts text/plain, so parse the raw text whatever the content type.
    const raw = await c.req.text();
    if (raw.length > 64 * 1024) return c.json({ error: "invalid_body" }, 413);
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
    const latest = Date.now() + PIXEL_MAX_FUTURE_MS;
    const events = parsed.data.events.filter((e) => Date.parse(e.timestamp) <= latest);
    if (!events.length) return c.json({ ok: true, accepted: 0 });

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

      const visits = new Map<string, { day: string; visitor: string; events: PixelEventIn[] }>();
      for (const ev of events) {
        // Delete as we go: a batch that repeats an id counts it once.
        if (!freshIds.delete(`e:${ev.id}`)) continue;
        const at = new Date(ev.timestamp);
        const day = localDay(at, store.timezone);
        const visitor = sha256Hex(ev.clientId);
        const k = `${day}|${visitor}`;
        const v = visits.get(k) ?? { day, visitor, events: [] };
        v.events.push({ name: ev.name, timestamp: at, path: ev.path });
        visits.set(k, v);
      }

      let n = 0;
      for (const { day, visitor, events } of visits.values()) {
        const d = foldVisit(events);
        // Merge into the day's row: the earliest located event is the entry, the latest the exit,
        // whichever batch they arrive in. Every SET expression reads the row as it was before, and
        // a batch with no located event (NULL entered_at/exited_at) leaves entry and exit alone.
        await tx.$executeRaw`
          INSERT INTO funnel_visits AS v (workspace_id, store_id, day, visitor, entered_at, entry_section, entry_path,
                                          exited_at, exit_section, exit_path, furthest_step, sections, page_views)
          VALUES (${store.workspaceId}, ${store.id}, ${day}, ${visitor}, ${d.enteredAt}, ${d.entrySection}, ${d.entryPath},
                  ${d.exitedAt}, ${d.exitSection}, ${d.exitPath}, ${d.furthestStep}, ${d.sections}, ${d.pageViews})
          ON CONFLICT (store_id, day, visitor) DO UPDATE SET
            entered_at    = CASE WHEN EXCLUDED.entered_at < v.entered_at OR v.entered_at IS NULL THEN EXCLUDED.entered_at ELSE v.entered_at END,
            entry_section = CASE WHEN EXCLUDED.entered_at < v.entered_at OR v.entered_at IS NULL THEN EXCLUDED.entry_section ELSE v.entry_section END,
            entry_path    = CASE WHEN EXCLUDED.entered_at < v.entered_at OR v.entered_at IS NULL THEN EXCLUDED.entry_path ELSE v.entry_path END,
            exited_at     = CASE WHEN EXCLUDED.exited_at >= v.exited_at OR v.exited_at IS NULL THEN EXCLUDED.exited_at ELSE v.exited_at END,
            exit_section  = CASE WHEN EXCLUDED.exited_at >= v.exited_at OR v.exited_at IS NULL THEN EXCLUDED.exit_section ELSE v.exit_section END,
            exit_path     = CASE WHEN EXCLUDED.exited_at >= v.exited_at OR v.exited_at IS NULL THEN EXCLUDED.exit_path ELSE v.exit_path END,
            furthest_step = GREATEST(v.furthest_step, EXCLUDED.furthest_step),
            sections      = v.sections | EXCLUDED.sections,
            page_views    = v.page_views + EXCLUDED.page_views`;
        n += events.length;
      }
      return n;
    });

    if (accepted && !store.pixelInstalled) {
      await systemDb.store.update({ where: { id: store.id }, data: { pixelInstalled: true } });
    }
    return c.json({ ok: true, accepted });
  });
}
