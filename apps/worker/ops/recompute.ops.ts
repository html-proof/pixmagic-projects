import { afterAll, it } from "vitest";
import { recomputeDays } from "@app/core";
import { disconnectDb, systemDb } from "@app/db";

/**
 * Rebuild one store's daily aggregates from its orders and their sales (idempotent).
 *   OPS_SHOP=<shop>.myshopify.com pnpm --filter @app/worker ops:recompute
 */
afterAll(async () => disconnectDb());

it("recomputes the store's daily aggregates", async () => {
  const shop = process.env.OPS_SHOP;
  if (!shop) throw new Error("Set OPS_SHOP to the store's myshopify.com domain");
  const store = await systemDb.store.findUniqueOrThrow({ where: { shopDomain: shop } });
  const [orderDays, saleDays] = await Promise.all([
    systemDb.order.findMany({ where: { storeId: store.id }, select: { localDay: true }, distinct: ["localDay"] }),
    systemDb.orderSale.findMany({ where: { storeId: store.id }, select: { localDay: true }, distinct: ["localDay"] }),
  ]);
  const days = [...new Set([...orderDays, ...saleDays].map((d) => d.localDay))].sort();
  await recomputeDays(store, days);
  console.log(`recomputed ${days.length} days for ${shop}`);
});
