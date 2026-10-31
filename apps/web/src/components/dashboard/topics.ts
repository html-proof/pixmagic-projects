import { useSyncExternalStore } from "react";
import type { IconName } from "./Icons";

/** Everything a dashboard card can open, each as its own detail panel (?view=<topic>). */
export const TOPICS = ["overview", "sales", "ads", "adsense", "products", "shoppers", "timing", "channels", "shipping", "stock", "discounts", "customers", "orders"] as const;
export type Topic = (typeof TOPICS)[number];

const INFO: Record<Topic, { title: string; icon: IconName }> = {
  overview: { title: "Business overview", icon: "sparkle" },
  sales: { title: "Sales", icon: "chart" },
  ads: { title: "Ads", icon: "megaphone" },
  adsense: { title: "Ad earnings", icon: "coins" },
  products: { title: "Best sellers", icon: "trophy" },
  shoppers: { title: "Shopping funnel", icon: "eye" },
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
