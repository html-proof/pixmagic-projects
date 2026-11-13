"use client";
import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { ChevronRight, Download, Printer } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { PageTabs } from "@/components/PageKit";
import { seesTopic } from "@/lib/access";
import { closeView, openView, type Topic } from "./topics";

// ---------------------------------------------------------------------------
// The Sales area's frame, as the owner's approved Stitch design draws it (prototype v2, screens
// 05–12): the page's title, how current the numbers are, the dates, Download and Print on one line,
// then one row of tabs over every part of Sales. The menu stays as it is (the owner kept it,
// 2026-11-05): each of its entries opens its own tab, and the tabs move between them.
//
// Overview, Products, Customers and Orders & shipping are the dashboard's topics (?view=…), drawn
// as pages of their own; Visitors, Ads and Profit & Loss are the pages they always were (Profit &
// Loss took the Profit sheet in, 13 Nov 2026, and draws its own sections' tabs instead of this row).
// A tab is shown to whoever the menu shows its page to, and moving between tabs keeps the dates (the
// same URL parameters on every one of these pages).
// ---------------------------------------------------------------------------

export type SalesTab = "overview" | "products" | "customers" | "orders" | "visitors" | "ads" | "profit";

/** Which tab each dashboard topic sits under (stock isn't part of Sales: it has no tab). */
const TAB_OF_TOPIC: Partial<Record<Topic, SalesTab>> = {
  sales: "overview",
  overview: "overview",
  channels: "overview",
  discounts: "overview",
  timing: "overview",
  products: "products",
  customers: "customers",
  orders: "orders",
  shipping: "orders",
};
export const salesTabOf = (t: Topic): SalesTab | null => TAB_OF_TOPIC[t] ?? null;

/** The dates' parameters of the page shown (preset, from, to, compare…), without the open topic. */
function datesQuery(): string {
  const q = new URLSearchParams(window.location.search);
  q.delete("view");
  return q.toString();
}

type Tab = { id: SalesTab; label: string } & ({ topic: Topic } | { href: string });

/** The tabs this member may open, in the design's order. */
export function useSalesTabs(): Tab[] {
  const { access, allowed, offers } = useApp();
  const sees = (t: Topic) => seesTopic(access, t, offers);
  const sales = allowed("analytics.sales");
  return [
    ...(sees("sales") ? [{ id: "overview" as const, label: "Overview", topic: "sales" as const }] : []),
    ...(sees("products") ? [{ id: "products" as const, label: "Products", topic: "products" as const }] : []),
    ...(sees("customers") ? [{ id: "customers" as const, label: "Customers", topic: "customers" as const }] : []),
    ...(sees("orders") ? [{ id: "orders" as const, label: "Orders & shipping", topic: "orders" as const }] : sees("shipping") ? [{ id: "orders" as const, label: "Orders & shipping", topic: "shipping" as const }] : []),
    ...(sees("shoppers") ? [{ id: "visitors" as const, label: "Visitors", href: "/funnel" }] : []),
    ...(sees("ads") ? [{ id: "ads" as const, label: "Ads", href: "/advertising" }] : []),
    ...(sales ? [{ id: "profit" as const, label: "Profit & Loss", href: "/profit" }] : []),
  ];
}

/**
 * The row of tabs (components/PageKit.tsx). On the dashboard a topic's tab opens it in place (the
 * browser's Back returns to the one before); anywhere else every tab is a link, carrying the dates.
 */
export function SalesTabs({ active, onDashboard = false }: { active: SalesTab; onDashboard?: boolean }) {
  const tabs = useSalesTabs();
  const router = useRouter();
  const go = (t: Tab) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const q = datesQuery();
    if ("topic" in t) {
      if (onDashboard) openView(t.topic);
      else router.push(`/dashboard?${q ? `${q}&` : ""}view=${t.topic}`);
    } else {
      router.push(`${t.href}${q ? `?${q}` : ""}`);
    }
    window.scrollTo({ top: 0 });
  };
  return (
    <PageTabs
      label="Sales"
      active={active}
      testId="sales-tabs"
      tabs={tabs.map((t) => ({ id: t.id, label: t.label, href: "topic" in t ? `/dashboard?view=${t.topic}` : t.href, onClick: go(t) }))}
    />
  );
}

/** "Home › Sales": the way back to Home from a topic page (Back in the browser does the same). */
export function SalesCrumbs({ here }: { here: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1 text-xs text-muted" data-print-hide>
      <ol className="flex items-center gap-1">
        <li>
          <button type="button" onClick={closeView} className="rounded-sm hover:text-text hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none" data-testid="crumb-home">
            Home
          </button>
        </li>
        <li aria-hidden>
          <ChevronRight className="h-3 w-3" />
        </li>
        <li aria-current="page" className="font-medium text-text">{here}</li>
      </ol>
    </nav>
  );
}

/** "Matches Shopify · Updated 3 min ago" as the design's pill: StatusWords' own words and tooltips. */
export function StatusPill({ children }: { children: ReactNode }) {
  return <p className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-text">{children}</p>;
}

/** Download (this tab as CSV, for a member allowed to export) and Print, as the design's two quiet buttons. */
export function SalesActions({ exportHref, canPrint }: { exportHref: string | null; canPrint: boolean }) {
  return (
    <>
      {exportHref && (
        <a href={exportHref} download className="home-btn h-10 border border-home-line bg-surface" data-testid="export-csv">
          <Download aria-hidden className="h-4 w-4" />
          Download
        </a>
      )}
      {canPrint && (
        <button type="button" onClick={() => window.print()} className="home-btn h-10 border border-home-line bg-surface" data-testid="print-page">
          <Printer aria-hidden className="h-4 w-4" />
          Print
        </button>
      )}
    </>
  );
}

/**
 * The header of a Sales page: title and its line, then (on the right) how current the numbers
 * are, the dates and the actions; the tabs under it.
 */
export function SalesHeader({
  title,
  sub,
  crumbs,
  status,
  dates,
  actions,
  tabs,
}: {
  title: string;
  sub?: ReactNode;
  crumbs?: ReactNode;
  status?: ReactNode;
  dates?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}) {
  return (
    <header className="space-y-4" data-testid="sales-header">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {crumbs}
          <h1 className="page-title">{title}</h1>
          {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-print-hide>
          {status}
          {dates}
          {actions}
        </div>
      </div>
      {tabs}
    </header>
  );
}

/** A section's own name under the tabs, for the topics that share a tab (Sales channels, Discount codes…). */
export function SectionName({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-xl leading-7 font-semibold tracking-[-0.01em]">{title}</h2>
      {onBack && (
        <button type="button" onClick={onBack} className="text-sm font-medium text-accent hover:underline" data-print-hide>
          Back to the Sales overview
        </button>
      )}
    </div>
  );
}
