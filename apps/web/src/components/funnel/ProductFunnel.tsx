"use client";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Package, Search } from "lucide-react";
import { productSuggestion, type ProductSuggestion } from "@app/shared/funnel";
import { fmtDay } from "@/components/dashboard/format";
import { Empty } from "@/components/dashboard/Primitives";
import type { FunnelPageModule, FunnelProduct } from "@/components/dashboard/types";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { count, FunnelSection, InfoTip } from "./FunnelUi";
import { Drawer } from "./StageDetail";
import { FORMULAS } from "./stageGuide";

const SUGGESTION: Record<ProductSuggestion, { short: string; long: string }> = {
  review_page: { short: "Review the product page", long: "Visits that view it add it to cart less often than your other products. Check its price, photos, description, sizes and shipping information." },
  check_checkout: { short: "Check why carts don't become orders", long: "Shoppers add it to cart from its page, but no order holds it in these dates. Check its stock, variants, shipping options and price at checkout." },
  landing_exits: { short: "Improve it as a landing page", long: "Visits that start on this page leave the store from it more often than visits that start on your other product pages. Make sure it matches the ads or links that send shoppers there, and offers a clear next step." },
  sold_untracked: { short: "Sells without tracked views", long: "It was ordered, but no tracked visit viewed its page, added it to cart or took it to checkout: likely bought through links straight to checkout, other sales channels, or by shoppers who declined tracking." },
};

type SortKey = "viewed" | "added" | "addRate" | "checkouts" | "orders" | "units" | "netSales" | "title";
type Show = "all" | "viewed_not_added" | "sold_untracked" | "suggested";
const PAGE = 10;

const value = (p: FunnelProduct, k: SortKey): number | string | null => (k === "title" ? (p.title ?? p.handle).toLowerCase() : (p[k] ?? null));

function Thumb({ p }: { p: FunnelProduct }) {
  return p.imageUrl ? (
    <img src={p.imageUrl} alt="" width={40} height={40} loading="lazy" referrerPolicy="no-referrer" className="h-10 w-10 shrink-0 rounded-lg border border-border bg-white object-cover" />
  ) : (
    <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border bg-bg text-muted">
      <Package className="h-4 w-4" />
    </span>
  );
}

/** One product's journey: its funnel on the visits that saw it, where visits landed and left, and its orders. */
function ProductDetail({ p, f, suggestion, shop, currency, onClose }: { p: FunnelProduct; f: FunnelPageModule; suggestion: ProductSuggestion | null; shop: string; currency: string; onClose: () => void }) {
  const name = p.title ?? p.handle;
  const rows: Array<[string, string, string?]> = [
    ["Visits that viewed its page", p.viewed === null ? "Not recorded" : fmtNum(p.viewed)],
    ["Added it to cart from its page", p.added === null ? "Not recorded" : fmtNum(p.added), p.addRate !== null ? `${fmtPct(p.addRate)} of viewing visits` : undefined],
    ["Added it to cart from elsewhere (quick adds)", p.quickAdded === null ? "Not recorded" : fmtNum(p.quickAdded), p.quickAdded !== null ? "From a collection, search, cart drawer or another product's page" : undefined],
    ["Started a checkout with it", p.checkouts === null ? "Not recorded" : fmtNum(p.checkouts)],
    ["Bought it", p.purchased === null ? "Not recorded" : fmtNum(p.purchased), p.checkoutCompletion !== null ? `${fmtPct(p.checkoutCompletion)} of the visits that started a checkout with it` : undefined],
    ["Visits that started on its page", fmtNum(p.landed), p.landed ? `${fmtNum(p.landedLeft)} of them left the store from it without buying` : undefined],
    ["Visits that left the store from its page without buying", fmtNum(p.exits)],
    ...(f.productSales && p.orders !== undefined
      ? ([
          ["Orders that included it (all your orders)", fmtNum(p.orders)],
          ["Units sold, net of returns", fmtNum(p.units ?? 0)],
          ["Net sales", fmtMoney(p.netSales ?? 0, currency)],
        ] as Array<[string, string]>)
      : []),
  ];
  return (
    <Drawer title={name} sub="This product's journey in these dates" onClose={onClose} testId="funnel-product-journey">
      <div className="flex items-center gap-3">
        <Thumb p={p} />
        <div className="flex flex-wrap gap-3 text-sm">
          {p.url && (
            <a className="inline-flex items-center gap-1 text-accent underline underline-offset-2" href={p.url} target="_blank" rel="noreferrer">
              View in your store <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            </a>
          )}
          {p.productId && (
            <a className="inline-flex items-center gap-1 text-accent underline underline-offset-2" href={`https://${shop}/admin/products/${p.productId}`} target="_blank" rel="noreferrer">
              Open in Shopify admin <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
      <dl className="divide-y divide-border rounded-lg border border-border bg-surface text-sm">
        {rows.map(([k, v, sub]) => (
          <div key={k} className="flex items-start justify-between gap-3 px-3 py-2">
            <dt>{k}</dt>
            <dd className="text-right tabular-nums">
              {v}
              {sub && <span className="block text-xs text-muted">{sub}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="rounded-lg border border-border bg-surface p-3 text-sm">
        <p className="font-medium">{suggestion ? SUGGESTION[suggestion].short : "Nothing stands out"}</p>
        <p className="mt-1 text-muted">{suggestion ? SUGGESTION[suggestion].long : "Its numbers are in line with your other products, or there are too few visits to compare."}</p>
      </div>
      <p className="text-xs text-muted">
        Every figure above the orders is tracked visits (one shopper on one day). Views and adds on its page are counted from its product page; quick adds, checkouts and purchases from the products the cart and checkout held{f.sourcesFrom ? `, recorded from ${fmtDay(f.sourcesFrom, { year: true })}` : ", which the updated pixel records"}. Orders count every order, tracked or not, so they are shown beside the visits, never divided by them. View to cart rate = {FORMULAS.viewToCart}.
      </p>
    </Drawer>
  );
}

/**
 * The product-level funnel: each product page's viewing visits and adds to cart (tracked visits),
 * the add-to-cart rate on those, and the store's orders, units and net sales of it (every order)
 * beside them, with what the numbers suggest. Searchable, sortable, paged; a row opens its journey.
 */
export function ProductFunnel({ f, shop, currency }: { f: FunnelPageModule; shop: string; currency: string }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "viewed", desc: true });
  const [show, setShow] = useState<Show>("all");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<FunnelProduct | null>(null);

  const totals = useMemo(
    () => f.products.reduce((a, p) => ({ viewed: a.viewed + (p.viewed ?? 0), added: a.added + (p.added ?? 0), landed: a.landed + p.landed, landedLeft: a.landedLeft + p.landedLeft }), { viewed: 0, added: 0, landed: 0, landedLeft: 0 }),
    [f.products],
  );
  // Checkouts and purchases per product were recorded in these dates: their column is shown.
  const carts = f.products.some((p) => p.checkouts !== null);
  // Each product against the store's other product pages.
  const suggestionOf = (p: FunnelProduct) =>
    productSuggestion(p, { viewed: totals.viewed - (p.viewed ?? 0), added: totals.added - (p.added ?? 0), landed: totals.landed - p.landed, landedLeft: totals.landedLeft - p.landedLeft });
  const q = search.trim().toLowerCase();
  const list = f.products
    .filter((p) => !q || (p.title ?? "").toLowerCase().includes(q) || p.handle.includes(q))
    .filter((p) => (show === "viewed_not_added" ? (p.viewed ?? 0) > 0 && p.added === 0 && !p.quickAdded : show === "sold_untracked" ? p.viewed === 0 && (p.orders ?? 0) > 0 : show === "suggested" ? suggestionOf(p) !== null : true))
    .sort((a, b) => {
      const av = value(a, sort.key);
      const bv = value(b, sort.key);
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      const c = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av ?? 0) - Number(bv ?? 0);
      return (sort.desc ? -c : c) || a.handle.localeCompare(b.handle);
    });
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = list.slice(at * PAGE, at * PAGE + PAGE);
  const viewsFrom = f.detailsFrom;

  const header = (key: SortKey, label: string, right = true) => {
    const active = sort.key === key;
    return (
      <th className={`px-2 pb-2 font-normal ${right ? "text-right" : ""}`} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
        <button type="button" className={`inline-flex items-center gap-1 hover:text-text ${active ? "text-text" : ""}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "title" }))}>
          {label}
          {active && (sort.desc ? <ArrowDown aria-hidden className="h-3 w-3" /> : <ArrowUp aria-hidden className="h-3 w-3" />)}
        </button>
      </th>
    );
  };

  // Product interest against purchases: the most-viewed products' viewing visits and orders, each on its own scale.
  const chart = [...f.products].filter((p) => (p.viewed ?? 0) > 0).sort((a, b) => (b.viewed ?? 0) - (a.viewed ?? 0)).slice(0, 8);
  const maxViews = Math.max(1, ...chart.map((p) => p.viewed ?? 0));
  const maxOrders = Math.max(1, ...chart.map((p) => p.orders ?? 0));

  return (
    <FunnelSection
      id="products"
      title="Product-level shopping funnel"
      sub="Which products get attention, which get added to cart, and which sell. Select a product to see its journey."
      aside={
        <InfoTip label="How product figures are counted">
          <p>Viewed and Added count tracked visits (one shopper on one day) on the product&apos;s own page. Quick adds (from a collection, search or cart drawer) are counted under Added once the updated pixel names the product added; before that they aren&apos;t put down to any product.</p>
          <p className="mt-1">View to cart = {FORMULAS.viewToCart}.</p>
          <p className="mt-1">Checkout counts tracked visits that started a checkout holding the product, and under it those that completed one; shown for dates the pixel recorded them.</p>
          <p className="mt-1 text-muted">Orders, units and net sales come from all your Shopify orders in these dates and aren&apos;t narrowed by the filter.</p>
        </InfoTip>
      }
    >
      {!viewsFrom && <p className="mb-3 rounded-lg border border-border bg-bg p-3 text-sm text-muted">Product page views are recorded from now on. As shoppers browse, this table fills in; sales are shown meanwhile.</p>}
      {viewsFrom && f.daily[0] && f.daily[0].day < viewsFrom && (
        <p className="mb-3 rounded-lg border border-border bg-bg p-3 text-sm text-muted">Product page views were first recorded on {fmtDay(viewsFrom, { year: true })}: days before that have sales but no views.</p>
      )}
      <div className="flex flex-wrap items-center gap-2" data-print-hide>
        <label className="relative flex min-w-0 flex-1 items-center sm:max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 h-4 w-4 text-muted" />
          <input
            type="search"
            className="input h-9 w-full pl-8 text-sm"
            placeholder="Search products"
            aria-label="Search products"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select
          className="input h-9 w-auto py-0 text-sm"
          aria-label="Show products"
          value={show}
          onChange={(e) => {
            setShow(e.target.value as Show);
            setPage(0);
          }}
        >
          <option value="all">All products</option>
          <option value="suggested">With a suggestion</option>
          <option value="viewed_not_added">Viewed, never added to cart</option>
          {f.productSales && <option value="sold_untracked">Sold without tracked views</option>}
        </select>
      </div>

      {list.length === 0 ? (
        <div className="mt-3">
          <Empty>{f.products.length ? "No product matches." : "No product was viewed or sold in these dates."}</Empty>
        </div>
      ) : (
        <>
          <div className="-mx-1 mt-3 overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm" data-testid="funnel-products-table">
              <thead className="text-left text-xs text-muted">
                <tr>
                  {header("title", "Product", false)}
                  {header("viewed", "Viewed (visits)")}
                  {header("added", "Added to cart")}
                  {header("addRate", "View to cart")}
                  {carts && header("checkouts", "Checkout (visits)")}
                  {f.productSales && header("orders", "Orders")}
                  {f.productSales && header("units", "Units sold")}
                  {f.productSales && header("netSales", "Net sales")}
                  <th className="px-2 pb-2 font-normal">Suggested action</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const sug = suggestionOf(p);
                  return (
                    <tr key={p.handle} className="border-t border-border">
                      <td className="px-2 py-2">
                        <button type="button" className="flex items-center gap-3 text-left" onClick={() => setOpen(p)} data-testid={`funnel-product-${p.handle}`}>
                          <Thumb p={p} />
                          <span className="min-w-0">
                            <span className="block max-w-[16rem] truncate font-medium underline decoration-border underline-offset-2 hover:decoration-text">{p.title ?? p.handle}</span>
                            {!p.title && <span className="block text-xs text-muted">Not in your catalog any more</span>}
                          </span>
                        </button>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.viewed === null ? "—" : fmtNum(p.viewed)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {p.added === null ? "—" : fmtNum(p.added)}
                        {!!p.quickAdded && <span className="block text-[11px] text-muted">+{count(p.quickAdded, "quick add")}</span>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtPct(p.addRate)}</td>
                      {carts && (
                        <td className="px-2 py-2 text-right tabular-nums">
                          {p.checkouts === null ? "—" : fmtNum(p.checkouts)}
                          {p.purchased !== null && <span className="block text-[11px] text-muted">{fmtNum(p.purchased)} bought</span>}
                        </td>
                      )}
                      {f.productSales && <td className="px-2 py-2 text-right tabular-nums">{fmtNum(p.orders ?? 0)}</td>}
                      {f.productSales && <td className="px-2 py-2 text-right tabular-nums">{fmtNum(p.units ?? 0)}</td>}
                      {f.productSales && <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(p.netSales ?? 0, currency)}</td>}
                      <td className="px-2 py-2 text-xs">{sug ? <span className="font-medium">{SUGGESTION[sug].short}</span> : <span className="text-muted">Nothing stands out</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted" data-print-hide>
            <span>
              {list.length === 1 ? "1 product" : `${fmtNum(list.length)} products`} · page {at + 1} of {pages}
            </span>
            <span className="flex gap-2">
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={at === 0} onClick={() => setPage(at - 1)}>
                Previous
              </button>
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
                Next
              </button>
            </span>
          </div>
        </>
      )}

      {chart.length > 0 && (
        <figure className="mt-6 border-t border-border pt-4" aria-labelledby="interest-h">
          <figcaption id="interest-h" className="text-sm font-medium">
            Product interest and purchases
          </figcaption>
          <p className="text-xs text-muted">
            The most-viewed products: tracked visits that viewed each{f.productSales ? ", beside the orders that included it (all your orders). They are different measures, each on its own scale, so read them side by side rather than as a rate" : ""}.
          </p>
          <ul className="mt-3 space-y-2">
            {chart.map((p) => (
              <li key={p.handle} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-3 text-xs sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <span className="truncate" title={p.title ?? p.handle}>
                  {p.title ?? p.handle}
                </span>
                <span className="space-y-1">
                  <span className="flex items-center gap-2" title={`${fmtNum(p.viewed)} visits viewed it`}>
                    <span className="h-2.5 rounded-full" style={{ width: `${((p.viewed ?? 0) / maxViews) * 70}%`, minWidth: 2, background: "var(--viz-cat-1)" }} />
                    <span className="tabular-nums text-muted">{count(p.viewed ?? 0, "view")}</span>
                  </span>
                  {f.productSales && (
                    <span className="flex items-center gap-2" title={`${fmtNum(p.orders ?? 0)} orders included it`}>
                      <span className="h-2.5 rounded-full" style={{ width: `${((p.orders ?? 0) / maxOrders) * 70}%`, minWidth: p.orders ? 2 : 0, background: "var(--viz-cat-2)" }} />
                      <span className="tabular-nums text-muted">{count(p.orders ?? 0, "order")}</span>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </figure>
      )}

      {open && <ProductDetail p={open} f={f} suggestion={suggestionOf(open)} shop={shop} currency={currency} onClose={() => setOpen(null)} />}
    </FunnelSection>
  );
}
