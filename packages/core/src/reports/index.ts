/**
 * The dashboard's read side: everything `GET /workspaces/:ws/stores/:storeId/overview` and the
 * store list return, as functions of a tenant transaction (`withTenant`). Routes parse, authorize
 * and call these; they hold no SQL of their own.
 */
export { recentSyncJobs, storeOverview, syncProblem, workspaceStores, type AdsView } from "./overview.js";
export { productPerformance, PRODUCT_SORTS } from "./products.js";
export { orderList } from "./orders.js";
export { PROFIT_TREND_MONTHS, profitReport, profitStatement, type ProfitReport, type ProfitSees, type ProfitStatement } from "./profit.js";
export { COLLECTION_LIMIT, collectionSales, type CollectionFigures, type CollectionSalesRow } from "./collections.js";
export { customerAnalytics, type CustomerAnalyticsView, type CustomerCohorts, type CustomerDates } from "./customers.js";
export type { FunnelView } from "./funnel.js";
export { storeLimits } from "./catalog.js";
export { productCheck } from "./productCheck.js";
export { quantizeUntil, reconcileSales, reportStale, reportWindow, shopifyModules, type CheckRow, type ReportStatus } from "./shopify.js";
export { CHECK_PERIODS, checkReportTable, SHOPIFY_CHECK_BUDGET_MS, shopifyCheckReport, type CheckReads, type CheckReportPeriod, type CheckReportRow, type CheckStatus } from "./shopifyCheck.js";
export { EXPORT_SECTION_IDS, EXPORT_SECTIONS, exportTable, type ExportSection } from "./export.js";
export { googleAdsAnalytics, type GoogleAdsAnalytics, type GoogleAdsAnalyticsOptions } from "./googleAdsAnalytics.js";
export { GOOGLE_ANALYTICS_PART_IDS, GOOGLE_ANALYTICS_PARTS, googleAnalyticsTable, googleReportTable, metaReportTable, type CsvTable, type GoogleAnalyticsPart, type LiveReportCsvOptions } from "./adsExport.js";
export { abandonedCheckoutsModule, type AbandonedCheckoutsModule, type CheckoutFigures, type CheckoutsStatus } from "./abandonedCheckouts.js";
