"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import {
  BadgePercent,
  Boxes,
  ChartColumn,
  Funnel,
  Gauge,
  LayoutDashboard,
  Mail,
  Megaphone,
  MessageCircle,
  MessageSquareText,
  Package,
  ReceiptText,
  Settings,
  Sheet,
  ShoppingBag,
  Store,
  Truck,
  Users,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useApp } from "@/components/AppContext";
import { openView, switchView, topicInfo, useCurrentView, type Topic } from "@/components/dashboard/topics";
import { canOpenPage, seesTopic, showsDashboardHome, TOPIC_PAGE } from "@/lib/access";
import { AUTOMATIONS_HUB } from "@/lib/features";
import { SETTINGS_PAGES } from "@/lib/settingsNav";
import { staffAccess } from "@app/shared/staff";

// ---------------------------------------------------------------------------
// The six areas of the app (docs/design-architecture, redesign phase 1): Home, Sales, Marketing,
// Stock, Staff and Settings. The sidebar lists the areas. Sales and Marketing gather several places
// each (Sales: the dashboard's detail panels, the Visitors page, Ads and the Profit sheet; Marketing: automations,
// WhatsApp, text messages and email), shown as one row of tabs at the top of each of their pages and
// inside the detail panel. Each member gets only the places they were given (Team & Access) of what
// the workspace offers; the API refuses the rest whatever these show.
// ---------------------------------------------------------------------------

export type AreaId = "home" | "sales" | "marketing" | "stock" | "staff" | "settings";

export interface Place {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** A dashboard panel (?view=…): opened in place while the dashboard is the page shown. */
  topic?: Topic;
  /** Other words someone might type for it in the search (Ctrl/⌘ K). */
  keywords?: string;
}

export interface Area {
  id: AreaId;
  label: string;
  icon: LucideIcon;
  /** Where the sidebar goes: the area's first place. */
  href: string;
  topic?: Topic;
  places: Place[];
}

export const TOPIC_ICON: Record<Topic, LucideIcon> = {
  overview: Gauge,
  sales: ShoppingBag,
  ads: Megaphone,
  adsense: Megaphone,
  products: Package,
  shoppers: Funnel,
  timing: ChartColumn,
  channels: Store,
  shipping: Truck,
  stock: Boxes,
  discounts: BadgePercent,
  customers: UsersRound,
  orders: ReceiptText,
};

/** The Sales tabs, in order: the dashboard's panels, then the pages of their own, the whole-business report last (the Profit sheet follows it). */
const SALES_TOPICS: Topic[] = ["sales", "products", "customers", "orders", "shipping", "channels", "discounts", "timing", "shoppers", "ads", "overview"];

/** The Marketing channels' pages, by path prefix. */
const MARKETING_PATHS = ["/automations", "/dashboard/whatsapp-automation", "/whatsapp", "/messaging", "/settings/email"];

const under = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}/`);

/** Which area a page belongs to (a dashboard panel belongs to Sales, or to Stock), if any. */
export function areaOf(path: string, view: Topic | null): AreaId | null {
  const p = path.replace(/\/$/, "") || "/";
  if (p === "/dashboard") return view === null ? "home" : view === "stock" ? "stock" : "sales";
  if (MARKETING_PATHS.some((m) => under(p, m))) return "marketing";
  if (under(p, "/funnel") || under(p, "/advertising") || under(p, "/ads") || under(p, "/sheet")) return "sales";
  if (under(p, "/inventory")) return "stock";
  if (under(p, "/staff")) return "staff";
  if (under(p, "/settings") || under(p, "/team")) return "settings";
  return null;
}

/** The words each place is also found by (the old names among them). */
const WORDS: Record<string, string> = {
  home: "dashboard start overview",
  "topic-overview": "health report summary print business",
  "topic-sales": "orders revenue net gross refunds",
  "topic-products": "best sellers catalog",
  "topic-customers": "returning contacts follow up",
  "topic-orders": "recent latest",
  "topic-discounts": "discounts coupons",
  "topic-timing": "busiest hours days",
  "topic-shoppers": "shopping funnel analytics visits sessions conversion",
  "topic-ads": "advertising marketing meta google campaigns spend",
  "topic-stock": "inventory low sold out",
  sheet: "spreadsheet daily weekly monthly p&l profit loss business events calendar mer",
  automations: "workflow trigger sms email whatsapp message history delivery",
  whatsapp: "messages campaigns templates",
  sms: "sms customer messaging campaigns automations templates opt-out",
  email: "email integrations gmail outlook smtp templates",
  inventory: "inventory stock levels warehouse locations sku",
  staff: "employees payroll timesheets roster",
};

export const topicPlace = (t: Topic): Place => {
  const page = TOPIC_PAGE[t];
  return { id: `topic-${t}`, label: topicInfo(t).title, href: page ?? `/dashboard?view=${t}`, icon: TOPIC_ICON[t], ...(page ? {} : { topic: t }) };
};

const area = (id: AreaId, label: string, icon: LucideIcon, list: Place[]): Area[] => {
  const places = list.map((p) => ({ ...p, keywords: p.keywords ?? WORDS[p.id] }));
  return places.length ? [{ id, label, icon, href: places[0]!.href, topic: places[0]!.topic, places }] : [];
};

/** The areas this member has, in menu order, each with the places in it they may open. */
export function useAreas(): Area[] {
  const { me, workspace, access, allowed, offers } = useApp();
  return useMemo(() => {
    const page = (href: string) => canOpenPage(href, access, workspace.staffRole ?? null, !!me.shared, offers);
    const inventory = offers("inventory") && allowed("inventory.view");
    const campaigns = allowed("marketing.campaigns");
    const settings = SETTINGS_PAGES.filter((s) => s.inMenu !== false)
      .map((s): Place => ({ id: `settings-${s.slug}`, label: s.label, href: s.href ?? `/settings/${s.slug}`, icon: s.icon, keywords: s.keywords }))
      .filter((s) => page(s.href));
    // The sidebar's Settings opens Connections for whoever manages them, otherwise their own profile.
    const first = settings.find((s) => s.id === "settings-integrations") ?? settings.find((s) => s.id === "settings-profile");
    return [
      ...area("home", "Home", LayoutDashboard, showsDashboardHome(access) ? [{ id: "home", label: "Home", href: "/dashboard", icon: LayoutDashboard }] : []),
      ...area("sales", "Sales", ChartColumn, [
        ...SALES_TOPICS.filter((t) => seesTopic(access, t, offers)).map(topicPlace),
        // The Profit sheet: every figure a column per day, week or month, with the business events.
        ...(allowed("analytics.sales") ? [{ id: "sheet", label: "Profit sheet", href: "/sheet", icon: Sheet }] : []),
      ]),
      ...area("marketing", "Marketing", Megaphone, [
        // Automations: one setup and one message history over SMS and email.
        ...(AUTOMATIONS_HUB && ((offers("sms") && campaigns) || (offers("email") && allowed("integrations.status")))
          ? [{ id: "automations", label: "Automations", href: "/automations", icon: Workflow }]
          : []),
        ...(offers("whatsapp") && campaigns ? [{ id: "whatsapp", label: "WhatsApp", href: "/dashboard/whatsapp-automation", icon: MessageCircle }] : []),
        ...(offers("sms") && campaigns ? [{ id: "sms", label: "Text messages", href: "/messaging", icon: MessageSquareText }] : []),
        ...(page("/settings/email") ? [{ id: "email", label: "Email", href: "/settings/email", icon: Mail }] : []),
      ]),
      // Stock: the Inventory pages for whoever may open them, otherwise the dashboard's Stock panel.
      ...area("stock", "Stock", Boxes, inventory ? [{ id: "inventory", label: "Stock", href: "/inventory", icon: Boxes }] : seesTopic(access, "stock", offers) ? [topicPlace("stock")] : []),
      ...area("staff", "Staff", Users, offers("staff") && staffAccess(workspace.role, workspace.staffRole, workspace.permissions).permissions.length > 0 ? [{ id: "staff", label: "Staff", href: "/staff", icon: Users }] : []),
      ...area("settings", "Settings", Settings, first ? [first, ...settings.filter((s) => s !== first)] : settings),
    ];
  }, [me.shared, workspace.role, workspace.staffRole, workspace.permissions, access, allowed, offers]);
}

/** Whether a place is the page shown (a panel: the one open on the dashboard). */
export function isHere(place: Place, path: string, view: Topic | null): boolean {
  const p = path.replace(/\/$/, "") || "/";
  if (place.topic) return p === "/dashboard" && view === place.topic;
  const href = place.href.split("?")[0]!;
  // Ads covers every page of the Advertising area; Home is the dashboard with no panel open.
  if (href === "/dashboard") return p === href && view === null;
  return under(p, href);
}

/**
 * The tabs of an area with several places (Sales, Marketing), at the top of each of its pages and
 * inside the dashboard's detail panel. A panel opens in place on the dashboard; the other places are
 * pages of their own. Nothing when the member has only one place there.
 */
export function AreaTabs({ id, className = "" }: { id: AreaId; className?: string }) {
  const path = usePathname();
  const view = useCurrentView();
  const area = useAreas().find((a) => a.id === id);
  const nav = useRef<HTMLElement>(null);
  const here = area?.places.find((p) => isHere(p, path, view))?.id;
  // On a phone the row scrolls sideways: keep the open tab in sight.
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [here]);
  if (!area || area.places.length < 2) return null;
  const onDashboard = (path.replace(/\/$/, "") || "/") === "/dashboard";
  return (
    <nav ref={nav} aria-label={area.label} className={`flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border print:hidden ${className}`} data-testid={`area-tabs-${id}`}>
      {area.places.map((p) => (
        <Link
          key={p.id}
          href={p.href}
          aria-current={p.id === here ? "page" : undefined}
          onClick={(e) => {
            // On the dashboard a panel opens without reloading the page's numbers; one already open
            // moves to the tab picked (components/dashboard/topics.ts, switchView).
            if (p.topic && onDashboard && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
              e.preventDefault();
              if (view) switchView(p.topic);
              else openView(p.topic);
            }
          }}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition ${p.id === here ? "border-accent font-semibold text-text" : "border-transparent text-muted hover:text-text"}`}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
