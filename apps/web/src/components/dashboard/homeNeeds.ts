import { ALERT_PATH, type AlertArea, type AlertView } from "@app/shared/alerts";
import { gradeCover, gradeShipping, gradeStock, type Health } from "@app/shared/health";
import type { Costs } from "./profitFigures";
import type { Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// The simple Home's "Needs you": the few things to do now, each with one way to do it. Open
// problems from the bell (GET .../alerts), orders waiting to ship, stock running out and sales with
// no cost per item in Shopify. Only what bizinsights knows, and only buttons for what can be done:
// shipping and product costs are done in Shopify, so those open it. No React: test/homeNeeds.test.mjs
// runs it.
// ---------------------------------------------------------------------------

export type NeedTone = "danger" | "warn" | "info";
/** A page of the app, Shopify's admin (`external`), or the dashboard's details for a topic. */
export type NeedAction = { label: string; href: string; external?: boolean } | { label: string; topic: Topic };

export interface Need {
  id: string;
  tone: NeedTone;
  text: string;
  /** A second, quieter line (an alert's explanation). */
  detail?: string;
  action?: NeedAction;
}

/** What each area's alert button says: where ALERT_PATH takes it. */
const ALERT_ACTION: Record<AlertArea, string> = {
  shopify: "Check the store",
  ads: "Check ad accounts",
  integrations: "Open integrations",
  staff: "Open timesheets",
  whatsapp: "Open WhatsApp",
  privacy: "Open requests",
  inventory: "See stock",
  general: "Get help",
};

const TONE_OF: Record<Health, NeedTone> = { attention: "danger", watch: "warn", good: "info", info: "info" };
const RANK: Record<NeedTone, number> = { danger: 0, warn: 1, info: 2 };

const num = (n: number) => new Intl.NumberFormat().format(n);
const count = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** "Linen Tote Bag" or "Linen Tote Bag (Large)": Shopify's "Default Title" is no variant. */
const itemName = (i: { productTitle: string; variantTitle: string }) =>
  i.variantTitle && i.variantTitle !== "Default Title" ? `${i.productTitle} (${i.variantTitle})` : i.productTitle;

export function needsOf({
  ov,
  alerts,
  costs,
  money,
  stockHref,
}: {
  ov: Overview;
  /** The bell's alerts (null while they load or couldn't be read): only problems are things to do. */
  alerts: AlertView[] | null;
  /** The dates' costs (`costsOf`), for a member shown Shopify's product costs; null otherwise. */
  costs: Costs | null;
  money: (n: number) => string;
  /** The Inventory section's low-stock page where this member has it; otherwise the stock details. */
  stockHref: string | null;
}): Need[] {
  const m = ov.modules;
  const shop = ov.store.shopDomain;
  const out: Need[] = [];

  // Stock first worked out, so a stock alert from the bell doesn't say it a second time.
  const inv = m.inventory?.current;
  const short = inv && inv.trackedVariants > 0 ? inv.outOfStock + inv.lowStock : 0;
  let stock: Need | null = null;
  if (inv && short > 0) {
    const first = m.inventory!.lowStockItems[0];
    let health: Health = gradeStock(inv.outOfStock, inv.lowStock);
    let text: string;
    if (first) {
      if (health !== "attention") health = gradeCover(first.daysOfCover, first.quantity);
      const name = itemName(first);
      text =
        first.quantity <= 0
          ? `${name} is sold out`
          : first.daysOfCover !== null
            ? `${name} runs out in about ${count(Math.max(1, Math.round(first.daysOfCover)), "day")}`
            : `${name} is running low (${num(first.quantity)} left)`;
      if (short > 1) text += `, and ${num(short - 1)} more ${short - 1 === 1 ? "needs" : "need"} stock`;
    } else {
      text = `${num(inv.outOfStock)} sold out and ${num(inv.lowStock)} running low`;
    }
    stock = { id: "stock", tone: TONE_OF[health], text, action: stockHref ? { label: "See stock", href: stockHref } : { label: "See stock", topic: "stock" } };
  }

  for (const a of alerts ?? []) {
    if (a.severity === "info") continue;
    if (a.store && a.store.id !== ov.store.id) continue;
    if (stock && a.area === "inventory") continue;
    // A sync that stopped is explained above the numbers, with what to do.
    if (a.area === "shopify" && ov.store.status === "error" && a.store?.id === ov.store.id) continue;
    out.push({ id: `alert-${a.id}`, tone: a.severity === "critical" ? "danger" : "warn", text: a.title, detail: a.body, action: { label: ALERT_ACTION[a.area], href: ALERT_PATH[a.area] } });
  }

  const ful = m.fulfillment;
  if (ful && ful.openNow > 0) {
    const oldest = ful.oldestOpenDays !== null && ful.oldestOpenDays > 0 ? ` · the oldest for ${count(ful.oldestOpenDays, "day")}` : "";
    out.push({
      id: "shipping",
      tone: TONE_OF[gradeShipping(ful.openNow, ful.oldestOpenDays)],
      text: `${count(ful.openNow, "order")} waiting to ship${oldest}`,
      action: { label: "Open in Shopify", href: `https://${shop}/admin/orders`, external: true },
    });
  }

  if (stock) out.push(stock);

  // Product costs come only from each product's cost per item in Shopify.
  if (costs?.productState === "not_recorded") {
    out.push({ id: "costs", tone: "info", text: "No product sold in these dates has a cost per item in Shopify, so Left over takes no product costs off", action: { label: "Add in Shopify", href: `https://${shop}/admin/products`, external: true } });
  } else if (costs?.productState === "known" && costs.uncosted !== null && costs.uncosted > 0) {
    out.push({ id: "costs", tone: "info", text: `${money(costs.uncosted)} of sales had no cost per item in Shopify, so Left over leaves their cost out`, action: { label: "Add in Shopify", href: `https://${shop}/admin/products`, external: true } });
  }

  // Worst first; the order above within each.
  return out.map((n, i) => ({ n, i })).sort((a, b) => RANK[a.n.tone] - RANK[b.n.tone] || a.i - b.i).map(({ n }) => n);
}
