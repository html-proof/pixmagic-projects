import type { FetchLike } from "@app/core";

/**
 * A fake of the one Admin API call every orders webhook can make: reading the order's sales
 * records (ORDER_SALES_QUERY in packages/core/src/normalize.ts). Tests list an order's agreements
 * in `shopifySales` (by order id); an order not listed is unknown to the fake, so it keeps the
 * provisional sales its webhook payload gave it.
 */
export const shopifySales = new Map<string, { updatedAt: string; agreements: unknown[] }>();

export const saleMoney = (amount: string | number) => ({ shopMoney: { amount: String(amount) } });

let seq = 0;

/** One of Shopify's sales: a product sold for nothing unless `over` says otherwise. */
export const sale = (over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Sale/${++seq}`,
  actionType: "ORDER",
  lineType: "PRODUCT",
  quantity: 1,
  totalAmount: saleMoney(0),
  totalDiscountAmountBeforeTaxes: saleMoney(0),
  totalTaxAmount: saleMoney(0),
  ...over,
});

/** An agreement; `reason` is Shopify's OrderActionType (ORDER, ORDER_EDIT, REFUND, ...), left out unless given. */
export const agreement = <S>(happenedAt: string, sales: S[], reason?: string) => ({
  id: `gid://shopify/SalesAgreement/${++seq}`,
  happenedAt,
  ...(reason ? { reason } : {}),
  sales: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: sales },
});

/** The fake's answer to ORDER_SALES_QUERY, an agreement at a time; null for any other call. */
export function salesAnswer(url: Parameters<FetchLike>[0], init: Parameters<FetchLike>[1]): Response | null {
  if (!String(url).includes("/graphql.json")) return null;
  const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { id: string; cursor: string | null } };
  if (!query.includes("query OrderSales")) return null;
  const known = shopifySales.get(variables.id.split("/").pop()!);
  const at = Number(variables.cursor ?? 0);
  const order = known && {
    updatedAt: known.updatedAt,
    agreements: { pageInfo: { hasNextPage: at + 1 < known.agreements.length, endCursor: String(at + 1) }, nodes: known.agreements.slice(at, at + 1) },
  };
  return new Response(JSON.stringify({ data: { order: order ?? null } }), { status: 200, headers: { "content-type": "application/json" } });
}
