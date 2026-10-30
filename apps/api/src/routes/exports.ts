import { z } from "zod";
import { withTenant } from "@app/db";
import { audit, logger, toCsv } from "@app/core";
import { checkReportTable, EXPORT_SECTION_IDS, EXPORT_SECTIONS, exportTable, SHOPIFY_CHECK_BUDGET_MS, shopifyCheckReport, storeLimits, storeOverview, type ExportSection } from "@app/core/reports";
import { allows, redactOverview, seesModule, type MemberAccess } from "@app/shared";
import { clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { adsViewQuery, datesQuery, funnelQuery, funnelViewOf, resolveQueryDates } from "./dashboard.js";

const querySchema = z.object({
  section: z.enum(EXPORT_SECTION_IDS as [string, ...string[]]),
  ...datesQuery,
  // The Advertising area's reports: the platform and account its page shows.
  ...adsViewQuery,
  // The Shopping Funnel page's filter.
  ...funnelQuery,
});
type Query = z.infer<typeof querySchema>;

/** The section asked for; refused when the member may not see it (`then`: what they can't do with it). */
function sectionOf(access: MemberAccess, q: Query, then = ""): ExportSection {
  const section = q.section as ExportSection;
  const def = EXPORT_SECTIONS[section];
  if (!allows(access, def.need)) throw new HttpError(403, `You don't have permission to see ${def.label.toLowerCase()}${then}.`, "forbidden");
  return section;
}

/**
 * One section as the member sees it on screen, for the dates (and, for the Advertising area's
 * reports, the platform and account) asked: the same report, through the same redaction.
 */
async function sectionTable(ws: string, storeId: string, access: MemberAccess, section: ExportSection, q: Query) {
  const def = EXPORT_SECTIONS[section];
  return withTenant(ws, async (tx) => {
    const store = await tx.store.findFirst({ where: { id: storeId, workspaceId: ws } });
    if (!store) throw new HttpError(404, "Not found", "not_found");
    const dates = resolveQueryDates(q, new Date(), store.timezone, await storeLimits(tx, { ws, storeId }, store));
    const wanted = new Set<string>(def.modules);
    const adsView = section === "ads" ? {} : { platform: q.platform, account: q.account, allCampaigns: section === "ads_campaigns" };
    const funnelView = section === "funnel" ? funnelViewOf(q, access) : undefined;
    const report = redactOverview(await storeOverview(tx, store, dates, new Date(), (m) => wanted.has(m) && seesModule(access, m), adsView, funnelView), access);
    return { table: exportTable(section, report.modules, dates), range: dates.range, previous: dates.previous, shop: store.shopDomain.replace(/\.myshopify\.com$/, "") };
  });
}

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
    const section = sectionOf(a.access, q, ", so you can't download it");
    await limit(deps.coord, `rl:dashboard-export:${a.user?.id ?? ws}`, LIMITS.dashboardExports, "Too many downloads. Wait a few minutes and try again.");

    const { table: t, range, shop } = await sectionTable(ws, storeId, a.access, section, q);
    const csv = toCsv(t.header, t.rows);

    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "report.exported", targetType: "store", targetId: storeId, metadata: { section, from: range.from, to: range.to, ...(q.platform ? { platform: q.platform } : {}), ...(q.account ? { account: q.account } : {}), ...(section === "funnel" ? { filter: funnelViewOf(q, a.access).filter } : {}) }, ip: clientIp(c) }).catch(
      (err: unknown) => logger.warn({ err }, "audit failed"),
    );
    const filename = `bizinsights-${shop}-${section}-${range.from}-to-${range.to}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    // Headers set on the context (the access fingerprint) go with it, as with any other answer.
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    c.header("content-length", String(csv.length));
    return c.body(csv as unknown as ArrayBuffer, 200);
  });

  /**
   * A download's table on screen, before it is downloaded (the Advertising area's Reports page): the
   * same rows the CSV holds, for a member who may see that section. Not a download, so it needs no
   * export permission and isn't in the audit log; downloading it still needs both.
   */
  app.get("/workspaces/:ws/stores/:storeId/export/table", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "dashboard:read");
    const q = querySchema.parse(c.req.query());
    const section = sectionOf(a.access, q);
    const { table, range, previous } = await sectionTable(ws, storeId, a.access, section, q);
    return c.json({ section, label: EXPORT_SECTIONS[section].label, range, previous: { ...previous, compare: q.compare }, header: table.header, rows: table.rows });
  });

  /**
   * The check against Shopify's own reports for the standard periods (core reports/shopifyCheck.ts):
   * every figure, ours next to Shopify's, classified. A financial report holding every line of the
   * sales breakdown and Shopify's gross profit, so it needs both "View financial reports" and the
   * breakdown's own permission (the dashboard's breakdown, profit and check need that one alone);
   * a few a store per 10 minutes (each asks Shopify up to 21 times), in the audit log.
   * `format=csv` downloads it.
   */
  app.get("/workspaces/:ws/stores/:storeId/shopify-check", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "finance.reports");
    if (!allows(a.access, "finance.breakdown")) throw new HttpError(403, "You don't have permission to see the sales breakdown.", "forbidden");
    const csvWanted = c.req.query("format") === "csv";
    // Keyed by workspace too: the store isn't checked to be this workspace's yet, and another
    // workspace naming it must not use up the store's own allowance.
    await limit(deps.coord, `rl:shopify-check:${ws}:${storeId}`, LIMITS.shopifyCheck, "Checked against Shopify a moment ago. Wait a few minutes and try again.");
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
    if (!store) throw new HttpError(404, "Not found", "not_found");
    // Our figures in short transactions with Shopify's calls between them, never inside one, and
    // all of those within one deadline, so the answer comes within the API's time limit.
    const report = await shopifyCheckReport((read) => withTenant(ws, read), store, { coord: deps.coord, fetchImpl: deps.fetchImpl }, { deadline: Date.now() + SHOPIFY_CHECK_BUDGET_MS });
    await audit({ workspaceId: ws, actorUserId: a.user?.id ?? null, action: "report.exported", targetType: "store", targetId: storeId, metadata: { section: "shopify_check" }, ip: clientIp(c) }).catch(
      (err: unknown) => logger.warn({ err }, "audit failed"),
    );
    if (!csvWanted) return c.json(report);
    const t = checkReportTable(report);
    const csv = toCsv(t.header, t.rows);
    const filename = `bizinsights-${report.shop.replace(/\.myshopify\.com$/, "")}-shopify-check-${report.generatedAt.slice(0, 10)}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    c.header("content-length", String(csv.length));
    return c.body(csv as unknown as ArrayBuffer, 200);
  });
}
