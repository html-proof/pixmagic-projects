import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { normalizeGraphqlOrder, normalizeRestOrder, upsertOrder, writeOrderBatch } from "@app/core";

/**
 * Where each order's customer came from, as stored: Shopify's journey (import) and a webhook's
 * landing link (live) agree on one value per order, and nothing that knows less overwrites more.
 */

afterAll(async () => disconnectDb());
beforeEach(async () => resetDb());

async function store() {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  return systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: "t.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-t" } });
}

const UPDATED = "2026-10-05T10:00:00Z";
const rest = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  name: "#9001",
  currency: "INR",
  created_at: "2026-10-05T09:00:00Z",
  updated_at: UPDATED,
  subtotal_price: "1500.00",
  total_price: "1500.00",
  source_name: "web",
  line_items: [],
  ...over,
});
const node = (journey: unknown, updatedAt = UPDATED) => ({
  id: "gid://shopify/Order/9001",
  name: "#9001",
  currencyCode: "INR",
  createdAt: "2026-10-05T09:00:00Z",
  updatedAt,
  sourceName: "web",
  discountCodes: [],
  customerJourneySummary: journey,
  lineItems: { nodes: [] },
  refunds: [],
});
const stored = async () =>
  systemDb.order.findFirstOrThrow({ where: { shopifyId: "9001" }, select: { trafficSource: true, trafficMedium: true, trafficCampaign: true, referrerHost: true } });

describe("where an order's customer came from, as stored", () => {
  it("a webhook's ad link is recorded; Shopify's journey replaces it; a webhook without one keeps it", async () => {
    const s = await store();
    await upsertOrder(s, normalizeRestOrder(rest({ landing_site: "/?utm_source=facebook&utm_medium=cpc&utm_campaign=Diwali", referring_site: "https://m.facebook.com/" })));
    expect(await stored()).toEqual({ trafficSource: "facebook", trafficMedium: "paid", trafficCampaign: "Diwali", referrerHost: "m.facebook.com" });

    // The import reads Shopify's processed journey: it says Instagram.
    await upsertOrder(s, normalizeGraphqlOrder(node({ ready: true, lastVisit: { source: "instagram", sourceType: "AD", utmParameters: { source: "ig", medium: "paid", campaign: "Diwali" } } })));
    expect(await stored()).toMatchObject({ trafficSource: "instagram", trafficMedium: "paid" });

    // orders/updated without landing data, or with a different landing link: the journey stands.
    await upsertOrder(s, normalizeRestOrder(rest({ financial_status: "paid" })));
    await upsertOrder(s, normalizeRestOrder(rest({ landing_site: "/?gclid=x" })));
    // A journey Shopify hasn't processed yet says nothing either.
    await upsertOrder(s, normalizeGraphqlOrder(node({ ready: false, lastVisit: null })));
    expect(await stored()).toMatchObject({ trafficSource: "instagram", trafficMedium: "paid", trafficCampaign: "Diwali" });
  });

  it("an order stored before sources were recorded gets one from a later copy, even an older one", async () => {
    const s = await store();
    await upsertOrder(s, normalizeRestOrder(rest()));
    expect((await stored()).trafficSource).toBeNull();
    // A re-import copy older than what's stored still brings the journey (and nothing else).
    await upsertOrder(s, normalizeGraphqlOrder(node({ ready: true, lastVisit: { source: "google", referrerUrl: "https://www.google.com/" } }, "2026-10-04T00:00:00Z")));
    expect(await stored()).toMatchObject({ trafficSource: "google", trafficMedium: "unpaid", referrerHost: "google.com" });
    expect((await systemDb.order.findFirstOrThrow({ where: { shopifyId: "9001" } })).shopifyUpdatedAt.toISOString()).toBe(new Date(UPDATED).toISOString());
  });

  it("the bulk import fills sources in, and keeps them while Shopify's journey isn't ready", async () => {
    const s = await store();
    await upsertOrder(s, normalizeRestOrder(rest()));
    await writeOrderBatch(s, [normalizeGraphqlOrder(node({ ready: true, lastVisit: { source: "direct", sourceType: "DIRECT", landingPage: "/" } }))]);
    expect(await stored()).toMatchObject({ trafficSource: "direct", trafficMedium: "direct" });
    await writeOrderBatch(s, [normalizeGraphqlOrder(node({ ready: false, lastVisit: null }))]);
    expect(await stored()).toMatchObject({ trafficSource: "direct" });
    // A sale with no visit at all (POS): "not recorded", which is an answer, not a gap.
    await writeOrderBatch(s, [{ ...normalizeGraphqlOrder(node(null)), sourceName: "pos", traffic: { source: "unknown", medium: "unknown", campaign: null, referrerHost: null }, trafficFrom: "journey" }]);
    expect(await stored()).toMatchObject({ trafficSource: "unknown" });
  });
});
