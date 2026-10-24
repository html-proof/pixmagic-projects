/**
 * The dashboard's read side: everything `GET /workspaces/:ws/stores/:storeId/overview` and the
 * store list return, as functions of a tenant transaction (`withTenant`). Routes parse, authorize
 * and call these; they hold no SQL of their own.
 */
export { recentSyncJobs, storeOverview, syncProblem, workspaceStores, type AdsView } from "./overview.js";
export { productPerformance, PRODUCT_SORTS } from "./products.js";
export type { FunnelView } from "./funnel.js";
export { storeLimits } from "./catalog.js";
export { productCheck } from "./productCheck.js";
export { quantizeUntil, reconcileSales, reportStale, reportWindows, shopifyModules, type CheckRow, type ReportStatus } from "./shopify.js";
export { CHECK_PERIODS, checkReportTable, shopifyCheckReport, type CheckReportPeriod, type CheckReportRow, type CheckStatus } from "./shopifyCheck.js";
export { EXPORT_SECTION_IDS, EXPORT_SECTIONS, exportTable, type ExportSection } from "./export.js";
export { googleAdsAnalytics, type AdsDeltas, type GoogleAdsAnalytics, type GoogleAdsAnalyticsOptions } from "./googleAdsAnalytics.js";
