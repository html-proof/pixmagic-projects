import { fetchShopifyReports, logger, REPORT_DATASETS, REPORT_SCOPE, type ShopifyReportsJob } from "@app/core";
import { systemDb } from "@app/db";
import { expandScopes } from "@app/shared";
import type { WorkerDeps } from "./handlers.js";

/**
 * Fetch the Shopify reports the dashboard asked for (packages/core/src/shopifyReports.ts) and keep
 * them. Shopify's answers, refusals included, are kept as they are, so this never throws for them:
 * the dashboard asks again once an answer is stale. A store that is gone is skipped, and so is each
 * report it hasn't granted the scope for (`REPORT_SCOPE`: its Shopify reports, or its orders for
 * the abandoned checkouts); with none left, the whole job.
 */
export async function runShopifyReports(job: ShopifyReportsJob, deps: WorkerDeps) {
  const store = await systemDb.store.findUnique({ where: { id: job.storeId } });
  if (!store || store.status === "uninstalled") return { skipped: true };
  const granted = expandScopes(store.grantedScopes);
  const requests = (job.requests ?? []).filter((r) => REPORT_DATASETS.includes(r.dataset) && granted.has(REPORT_SCOPE[r.dataset])).slice(0, 12);
  if (!requests.length) return { skipped: true };
  await fetchShopifyReports(store, requests, deps);
  logger.info({ storeId: store.id, reports: requests.length }, "shopify reports fetched");
  return { fetched: requests.length };
}
