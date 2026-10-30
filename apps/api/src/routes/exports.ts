import { z } from "zod";
import { withTenant } from "@app/db";
import { audit, logger, toCsv } from "@app/core";
import { checkReportTable, EXPORT_SECTION_IDS, EXPORT_SECTIONS, exportTable, shopifyCheckReport, storeOverview } from "@app/core/reports";
import { allows, redactOverview, seesModule } from "@app/shared";
import { clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { datesQuery, resolveQueryDates } from "./dashboard.js";

const querySchema = z.object({
  section: z.enum(EXPORT_SECTION_IDS as [string, ...string[]]),
  ...datesQuery,
});

/**
 * Dashboard downloads ("Export approved reports"): one section of the dashboard as CSV, for the
 * dates on screen. Needs the export permission and permission to see that section, and holds only
 * what the member sees on screen: the same report, through the same redaction. Each download is
 * in the audit log.
 */
export function exportRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/export", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "reports.export");
    const q = querySchema.parse(c.req.query());
    const section = q.section as keyof typeof EXPORT_SECTIONS;
    const def = EXPORT_SECTIONS[section];
    if (!allows(a.access, def.need)) throw new HttpError(403, `You don't have permission to see ${def.label.toLowerCase()}, so you can't download it.`, "forbidden");
    await limit(deps.coord, `rl:dashboard-export:${a.user?.id ?? ws}`, LIMITS.dashboardExports, "Too many downloads. Wait a few minutes and try again.");

    const { csv, range, shop } = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      const dates = resolveQueryDates(q, new Date(), store.timezone);
      const wanted = new Set<string>(def.modules);
      const report = redactOverview(await storeOverview(tx, store, dates, new Date(), (m) => wanted.has(m) && seesModule(a.access, m)), a.access);
      const t = exportTable(section, report.modules);
      return { csv: toCsv(t.header, t.rows), range: dates.range, shop: store.shopDomain.replace(/\.myshopify\.com$/, "") };
    });

    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "report.exported", targetType: "store", targetId: storeId, metadata: { section, from: range.from, to: range.to }, ip: clientIp(c) }).catch(
      (err: unknown) => logger.warn({ err }, "audit failed"),
    );
    const filename = `bizinsights-${shop}-${section}-${range.from}-to-${range.to}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    // Headers set on the context (the access fingerprint) go with it, as with any other answer.
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    c.header("content-length", String(Buffer.byteLength(csv, "utf8")));
    return c.body(csv as unknown as ArrayBuffer, 200);
  });

  /**
   * The check against Shopify's own reports for the standard periods (core reports/shopifyCheck.ts):
   * every figure, ours next to Shopify's, classified. Owners and admins (it reads every sales figure
   * and Shopify's profit), a few a store per 10 minutes (each asks Shopify up to 21 times), in the
   * audit log. `format=csv` downloads it.
   */
  app.get("/workspaces/:ws/stores/:storeId/shopify-check", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.reports");
    const csvWanted = c.req.query("format") === "csv";
    await limit(deps.coord, `rl:shopify-check:${storeId}`, LIMITS.shopifyCheck, "Checked against Shopify a moment ago. Wait a few minutes and try again.");
    const report = await withTenant(ws, async (tx) => {
      const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
      if (!store) throw new HttpError(404, "Not found", "not_found");
      return shopifyCheckReport(tx, store, { coord: deps.coord, fetchImpl: deps.fetchImpl });
    });
    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "report.exported", targetType: "store", targetId: storeId, metadata: { section: "shopify_check" }, ip: clientIp(c) }).catch(
      (err: unknown) => logger.warn({ err }, "audit failed"),
    );
    if (!csvWanted) return c.json(report);
    const t = checkReportTable(report);
    const csv = toCsv(t.header, t.rows);
    const filename = `bizinsights-${report.shop.replace(/\.myshopify\.com$/, "")}-shopify-check-${report.generatedAt.slice(0, 10)}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    c.header("content-length", String(Buffer.byteLength(csv, "utf8")));
    return c.body(csv as unknown as ArrayBuffer, 200);
  });
}
