import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { hourRange, plural } from "./format";
import type { IconName } from "./icons";
import type { Overview } from "./types";

/** Everything a dashboard card can open, each as its own detail panel (?view=<topic>). */
export const TOPICS = ["overview", "sales", "ads", "adsense", "products", "shoppers", "timing", "channels", "shipping", "stock", "discounts", "customers", "orders"] as const;
export type Topic = (typeof TOPICS)[number];

const INFO: Record<Topic, { title: string; icon: IconName }> = {
  overview: { title: "Business overview", icon: "sparkle" },
  sales: { title: "Sales", icon: "chart" },
  ads: { title: "Ads", icon: "megaphone" },
  adsense: { title: "Ad earnings", icon: "coins" },
  products: { title: "Best sellers", icon: "trophy" },
  shoppers: { title: "Shoppers", icon: "eye" },
  timing: { title: "Busiest times", icon: "clock" },
  channels: { title: "Sales channels", icon: "store" },
  shipping: { title: "Shipping", icon: "truck" },
  stock: { title: "Stock", icon: "box" },
  discounts: { title: "Discount codes", icon: "tag" },
  customers: { title: "Customers", icon: "users" },
  orders: { title: "Recent orders", icon: "receipt" },
};

export const topicInfo = (t: Topic) => INFO[t];
export const isTopic = (s: string | null): s is Topic => s !== null && (TOPICS as readonly string[]).includes(s);

/** One line about a topic: the number that matters most (used when the health check has nothing to say). */
export function topicSummary(t: Topic, ov: Overview, currency: string): string {
  const m = ov.modules;
  const money = (n: number) => fmtMoney(n, currency);
  switch (t) {
    case "overview":
      return "Your whole store in one place";
    case "sales": {
      const c = m.sales_overview?.current;
      return c ? `${money(c.netSales)} from ${plural(c.orders, "order")}` : "";
    }
    case "ads": {
      const a = m.ads;
      if (!a) return "Connect Meta or Google Ads";
      return `${fmtMoney(a.current.spend, a.currency)} spent · ${plural(a.current.clicks, "click")}`;
    }
    case "adsense": {
      const a = m.adsense;
      if (!a) return "Connect Google AdSense";
      return `${fmtMoney(a.current.earnings, a.currency)} earned · ${plural(a.current.pageViews, "page view")}`;
    }
    case "products": {
      const top = m.top_products?.items[0];
      if (top) return `${top.title} leads with ${money(top.revenue)}`;
      return m.catalog ? `${plural(m.catalog.products.total, "product")} in your catalog` : "No product sales yet";
    }
    case "shoppers":
      return m.funnel && m.funnel.visits > 0 ? `${plural(m.funnel.visits, "visit")} · ${fmtPct(m.funnel.conversionRate)} bought` : "No visits recorded yet";
    case "timing": {
      const o = m.order_timing;
      return o?.busiestDay && o.busiestHour !== null ? `${o.busiestDay}s, around ${hourRange(o.busiestHour)}` : "Not enough orders to spot a pattern";
    }
    case "channels": {
      const c = m.channels?.items[0];
      return c ? `${c.label}: ${fmtPct(c.share)} of sales` : "No sales in these dates";
    }
    case "shipping": {
      const f = m.fulfillment;
      return f && f.openNow > 0 ? `${plural(f.openNow, "order")} waiting to ship` : "All caught up";
    }
    case "stock": {
      const c = m.inventory?.current;
      if (!c || c.trackedVariants === 0) return "No stock levels yet";
      return c.lowStock + c.outOfStock > 0 ? `${fmtNum(c.lowStock)} running low · ${fmtNum(c.outOfStock)} sold out` : "Nothing running low";
    }
    case "discounts": {
      const d = m.discount_codes?.items ?? [];
      return d.length ? `${d[0]!.code} used most (${plural(d[0]!.orders, "order")})` : "No codes used in these dates";
    }
    case "customers": {
      const r = m.customers?.current.returningCustomerRate;
      return r !== undefined && r !== null ? `${fmtPct(r)} of orders from returning customers` : "Who's buying, and who to follow up";
    }
    case "orders": {
      const o = m.recent_orders?.items[0];
      return o ? `Latest: ${o.name}, ${money(o.total)}` : "No orders yet";
    }
  }
}
