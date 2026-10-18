import { fetchShopifyReports, logger, REPORT_DATASETS, type ShopifyReportsJob } from "@app/core";
import { systemDb } from "@app/db";
import type { WorkerDeps } from "./handlers.js";

/**
 * Fetch the Shopify reports the dashboard asked for (packages/core/src/shopifyReports.ts) and keep
 * them. Shopify's answers, refusals included, are kept as they are, so this never throws for them:
 * the dashboard asks again once an answer is stale. A store that is gone or has no reports access
 * is skipped.
 */
export async function runShopifyReports(job: ShopifyReportsJob, deps: WorkerDeps) {
  const store = await systemDb.store.findUnique({ where: { id: job.storeId } });
  if (!store || store.status === "uninstalled" || !store.grantedScopes.includes("read_reports")) return { skipped: true };
  const requests = (job.requests ?? []).filter((r) => REPORT_DATASETS.includes(r.dataset)).slice(0, 12);
  await fetchShopifyReports(store, requests, deps);
  logger.info({ storeId: store.id, reports: requests.length }, "shopify reports fetched");
  return { fetched: requests.length };
}
