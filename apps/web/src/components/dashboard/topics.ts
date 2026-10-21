import { useSyncExternalStore } from "react";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { shownFigures, upToWords } from "./adFigures";
import { hourRange, plural } from "./format";
import type { IconName } from "./Icons";
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

/** The topics this store has data for, in the order the main page's list uses for equal statuses. */
export function availableTopics(ov: Overview, contactsOn: boolean): Topic[] {
  const m = ov.modules;
  const has: Record<Topic, boolean> = {
    // The overview has its own first row in the list; ads and AdSense have their own Advertising
    // section on the main page (Advertising.tsx), which opens their detail panels.
    overview: false,
    ads: false,
    adsense: false,
    sales: !!m.sales_overview,
    products: !!(m.top_products || m.catalog),
    shoppers: !!(m.funnel || m.shopify_sessions),
    timing: !!m.order_timing,
    channels: !!m.channels,
    shipping: !!m.fulfillment,
    stock: !!m.inventory,
    discounts: !!m.discount_codes,
    customers: !!m.customers || contactsOn,
    orders: !!m.recent_orders,
  };
  return TOPICS.filter((t) => has[t]);
}

// ---------------------------------------------------------------------------
// Which topic is open lives in the address bar (?view=sales), so the phone's back button closes
// the panel instead of leaving the dashboard, and a link can open straight onto one. The sidebar
// (components/AppShell.tsx) opens topics too, so the open one is read from the address itself,
// shared by everything that asks, rather than kept in one component's state.
// ---------------------------------------------------------------------------

const VIEW_EVENT = "insights:view";
/** Whether the open panel's history entry was pushed in this tab, so closing it can go back to the one before. */
let pushedView = false;

function readView(): Topic | null {
  const v = new URLSearchParams(window.location.search).get("view");
  return isTopic(v) ? v : null;
}

function subscribeView(onChange: () => void) {
  const onPop = () => {
    pushedView = false;
    onChange();
  };
  window.addEventListener("popstate", onPop);
  window.addEventListener(VIEW_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onPop);
    window.removeEventListener(VIEW_EVENT, onChange);
  };
}

/** The topic open in the address bar (null while prerendering, and with none open). */
export function useCurrentView(): Topic | null {
  return useSyncExternalStore(subscribeView, readView, () => null);
}

/** Open a topic's panel on the dashboard (only call it while the dashboard is the page shown). */
export function openView(t: Topic) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", t);
  window.history.pushState(window.history.state, "", url.href);
  pushedView = true;
  window.dispatchEvent(new Event(VIEW_EVENT));
}

export function closeView() {
  if (pushedView) {
    // Back to the entry before the panel opened; its popstate clears the view.
    window.history.back();
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  window.history.replaceState(window.history.state, "", url.href);
  window.dispatchEvent(new Event(VIEW_EVENT));
}

export function useDetailView() {
  return { view: useCurrentView(), open: openView, close: closeView };
}

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
      // Some account lacks days of the range: never a short total, except the days so far, dated.
      const { totals: c, through } = shownFigures(a);
      if (!c) return "Ad figures unavailable for some of these days";
      return `${fmtMoney(c.spend, a.currency)} spent${through ? ` ${upToWords(through)}` : ""}${c.linkClicks === null ? "" : ` · ${plural(c.linkClicks, "link click")}`}`;
    }
    case "adsense": {
      const a = m.adsense;
      if (!a) return "Connect Google AdSense";
      const { totals: c, through } = shownFigures(a);
      if (!c) return "AdSense figures unavailable for some of these days";
      return `${fmtMoney(c.earnings, a.currency)} estimated${through ? ` ${upToWords(through)}` : ""} · ${plural(c.pageViews, "page view")}`;
    }
    case "products": {
      const top = m.top_products?.items[0];
      if (top) return `${top.title} leads with ${plural(top.units, "net unit")}`;
      if (m.top_products?.complete === false) return "Awaiting complete sales history";
      return m.catalog ? `${plural(m.catalog.products.total, "product")} in your catalog` : "No product sales yet";
    }
    case "shoppers": {
      // Shopify's own sessions when it shares them; the pixel's tracked visits otherwise.
      const s = m.shopify_sessions?.current;
      if (s && s.sessions !== null) return `${plural(s.sessions, "session")} · ${fmtPct(s.conversionRate)} converted`;
      return m.funnel && m.funnel.visits > 0 ? `${plural(m.funnel.visits, "tracked visit")} · ${fmtPct(m.funnel.conversionRate)} bought` : "No visits recorded yet";
    }
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
      return r !== undefined && r !== null ? `${fmtPct(r)} of customers had bought before` : "Who's buying, and who to follow up";
    }
    case "orders": {
      const o = m.recent_orders?.items[0];
      return o ? `Latest: ${o.name}, ${money(o.total)}` : "No orders yet";
    }
  }
}
