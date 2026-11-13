"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BadgePercent,
  Bell,
  Boxes,
  Briefcase,
  ChartColumn,
  ChevronDown,
  CircleCheck,
  Compass,
  Funnel,
  Gauge,
  Headset,
  Info,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  MessageCircle,
  MessageCircleMore,
  Moon,
  OctagonAlert,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  ReceiptText,
  Search,
  Send,
  Settings,
  Scale,
  ShieldCheck,
  UserCog,
  ShoppingBag,
  Store,
  Sun,
  TriangleAlert,
  Truck,
  UserRound,
  Users,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { canManage, useApp } from "@/components/AppContext";
import { BrandLogo, BrandMark } from "@/components/Brand";
import { GoogleAdsIcon, MetaIcon } from "@/components/BrandIcons";
import { CommandPalette, type PaletteItem } from "@/components/CommandPalette";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { fmtRelative } from "@/components/dashboard/format";
import { openView, topicInfo, TOPICS, useCurrentView, type Topic } from "@/components/dashboard/topics";
import { setSharedTab, useApi } from "@/lib/api";
import { closeSharedDashboard } from "@/components/team/AccessStates";
import { leaveTo, signOut } from "@/lib/auth";
import { CONTACT } from "@/lib/contact";
import { SETTINGS_PAGES } from "@/lib/settingsNav";
import { SIMPLE_MENU } from "@/lib/features";
import { FOLD_FROM, folds, groupFolds, groupOpen, parseOpenGroups, toggleGroup, type MenuGroupId, type MenuLayout } from "@/lib/menu";
import { MENU_LAYOUT_KEY, MENU_OPEN_KEY, MENU_RAIL_KEY, notesSeenKey, readLocal, removeLocal, TOUR_SEEN_KEY, writeLocal } from "@/lib/storage";
import { startTour, TOUR_EVENT } from "@/lib/tour";
import { Tour } from "@/components/Tour";
import { ThemeToggle, useTheme } from "@/components/Theme";
import { otherTheme } from "@/lib/theme";
import { ALERT_PATH, type AlertSeverity, type AlertView } from "@app/shared/alerts";
import { hasFullAccess, ROLE_INFO } from "@app/shared/access";
import { staffAccess } from "@app/shared/staff";
import { Alert } from "@/components/ui";
import { canOpenPage, landingPath, seesTopic, showsDashboardHome, TOPIC_PAGE } from "@/lib/access";

// ---------------------------------------------------------------------------
// The signed-in frame, in the owner's design (2026-10-24): a dark sidebar down the whole left side
// (logo, the dashboard's topics and the other areas, help, and the account at its foot) beside a
// top bar over the page (store, search, notifications). On a phone the sidebar slides in from the
// menu button and the account sits in the top bar. Topics open the dashboard's topic pages
// (?view=…, the Sales tabs of components/dashboard/SalesFrame.tsx), the same ones its cards open;
// advertising (/advertising) and the shopping funnel (/funnel) have pages of their own.
//
// The short menu (2026-11-11, lib/features.ts SIMPLE_MENU, rules in lib/menu.ts): the sidebar lists
// the everyday pages and folds the rest into groups (More reports, Store, Marketing,
// Settings) that open with a click and stay open on that device. Every page keeps its name and its
// address; "Show every page" at the foot brings back the whole list. On a wide screen the sidebar
// can also be narrowed to its icons.
// ---------------------------------------------------------------------------

const DASHBOARD = "/dashboard";
const isDashboard = (path: string) => path.replace(/\/$/, "") === DASHBOARD;

/** Go to a dashboard topic: open its panel in place on the dashboard, or load the dashboard with it open; or its own page. */
function goToTopic(topic: Topic, path: string, push: (href: string) => void) {
  const page = TOPIC_PAGE[topic];
  if (page) push(page);
  else if (isDashboard(path)) openView(topic);
  else push(`${DASHBOARD}?view=${topic}`);
}

interface NavItem {
  label: string;
  icon: LucideIcon;
  /** A brand's own mark in place of the icon (Google Ads, Meta Ads). */
  glyph?: ReactNode;
  href: string;
  topic?: Topic;
  active: boolean;
}

/** `rail`: the sidebar narrowed to its icons, each named on hover and to screen readers. */
function SideLink({ item, onNavigate, rail = false }: { item: NavItem; onNavigate?: () => void; rail?: boolean }) {
  const path = usePathname();
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={rail ? item.label : undefined}
      aria-current={item.active ? "page" : undefined}
      onClick={(e) => {
        // On the dashboard a topic opens without reloading the page's numbers.
        if (item.topic && isDashboard(path) && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          openView(item.topic);
        }
        onNavigate?.();
      }}
      className={`group flex items-center gap-3 rounded-xl py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-300 ${rail ? "justify-center px-0" : "px-3"} ${
        item.active ? "bg-nav-active text-white shadow-sm" : "text-white/75 hover:bg-white/[0.07] hover:text-white"
      }`}
    >
      {item.glyph ? (
        <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">{item.glyph}</span>
      ) : (
        <Icon aria-hidden className={`h-[18px] w-[18px] shrink-0 ${item.active ? "text-white" : "text-white/60 group-hover:text-white"}`} strokeWidth={1.8} />
      )}
      <span className={rail ? "sr-only" : "truncate"}>{item.label}</span>
    </Link>
  );
}

function NavGroup({ title, items, onNavigate, rail = false }: { title?: string; items: NavItem[]; onNavigate?: () => void; rail?: boolean }) {
  if (!items.length) return null;
  return (
    <div className={title ? `border-t border-white/10 ${rail ? "pt-3" : "pt-4"}` : undefined}>
      {title && <p className={rail ? "sr-only" : "mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-white/45"}>{title}</p>}
      <ul className="space-y-0.5">
        {items.map((i) => (
          <li key={i.href}>
            <SideLink item={i} onNavigate={onNavigate} rail={rail} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the sidebar remembers on a device: which menu, which groups are open, and whether it is narrowed to icons. */
interface MenuPrefs {
  layout: MenuLayout;
  setLayout: (l: MenuLayout) => void;
  open: readonly MenuGroupId[];
  toggle: (id: MenuGroupId) => void;
  rail: boolean;
  setRail: (on: boolean) => void;
}

function useMenuPrefs(): MenuPrefs {
  const [full, setFull] = useState(false);
  const [open, setOpen] = useState<MenuGroupId[]>([]);
  const [rail, setRailOn] = useState(false);
  // After mounting, as every per-device preference is read (lib/storage.ts).
  useEffect(() => {
    setFull(readLocal(MENU_LAYOUT_KEY) === "full");
    setOpen(parseOpenGroups(readLocal(MENU_OPEN_KEY)));
    setRailOn(readLocal(MENU_RAIL_KEY) === "1");
  }, []);
  return {
    layout: !SIMPLE_MENU || full ? "full" : "short",
    setLayout: (l) => {
      if (l === "full") writeLocal(MENU_LAYOUT_KEY, "full");
      else removeLocal(MENU_LAYOUT_KEY);
      setFull(l === "full");
    },
    open,
    toggle: (id) => {
      const next = toggleGroup(open, id);
      writeLocal(MENU_OPEN_KEY, next.join(","));
      setOpen(next);
    },
    rail,
    setRail: (on) => {
      if (on) writeLocal(MENU_RAIL_KEY, "1");
      else removeLocal(MENU_RAIL_KEY);
      setRailOn(on);
    },
  };
}

/**
 * A group of the short menu: its name as a button that shows or hides its pages. A group of one
 * page is that page, with the group's name over it as in the whole list. In the narrowed sidebar
 * it is one icon, which widens the sidebar with the group open.
 */
function FoldGroup({
  id,
  title,
  icon: Icon,
  items,
  shown,
  onToggle,
  onNavigate,
  rail = false,
  onWiden,
}: {
  id: MenuGroupId;
  title: string;
  icon: LucideIcon;
  items: NavItem[];
  shown: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  rail?: boolean;
  onWiden?: () => void;
}) {
  if (!items.length) return null;
  if (!groupFolds(items.length)) return <NavGroup title={title} items={items} onNavigate={onNavigate} rail={rail} />;
  const current = items.some((i) => i.active);
  const tone = current && (rail || !shown) ? "bg-white/[0.1] text-white" : "text-white/75 hover:bg-white/[0.07] hover:text-white";
  const face = `group flex w-full items-center gap-3 rounded-xl py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-300 ${tone}`;
  if (rail) {
    return (
      <div className="border-t border-white/10 pt-3">
        <button type="button" onClick={onWiden} title={title} aria-label={`${title}: show its pages`} className={`${face} justify-center px-0`} data-testid={`menu-group-${id}`}>
          <Icon aria-hidden className="h-[18px] w-[18px] shrink-0 text-white/60 group-hover:text-white" strokeWidth={1.8} />
        </button>
      </div>
    );
  }
  return (
    <div className="border-t border-white/10 pt-2">
      <button type="button" onClick={onToggle} aria-expanded={shown} aria-controls={`menu-${id}`} className={`${face} px-3`} data-testid={`menu-group-${id}`}>
        <Icon aria-hidden className="h-[18px] w-[18px] shrink-0 text-white/60 group-hover:text-white" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 text-white/45 transition-transform ${shown ? "rotate-180" : ""}`} />
      </button>
      {shown && (
        <ul id={`menu-${id}`} className="mt-0.5 space-y-0.5">
          {items.map((i) => (
            <li key={i.href}>
              <SideLink item={i} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Sidebar({ onNavigate, prefs, rail = false }: { onNavigate?: () => void; prefs: MenuPrefs; rail?: boolean }) {
  const path = usePathname().replace(/\/$/, "");
  const view = useCurrentView();
  const { me, workspace, access, allowed, offers } = useApp();
  const onDash = isDashboard(path);
  const full = hasFullAccess(access.role);
  // Only what this member was granted (Team & Access), of what the workspace offers; the API refuses
  // the rest whatever the menu shows.
  const topic = (t: Topic, label: string, icon: LucideIcon): NavItem[] => (seesTopic(access, t, offers) ? [{ label, icon, href: `${DASHBOARD}?view=${t}`, topic: t, active: onDash && view === t }] : []);
  const area = (href: string, label: string, icon: LucideIcon): NavItem => ({ label, icon, href, active: path === href || path.startsWith(`${href}/`) });
  const within = (href: string) => path === href || path.startsWith(`${href}/`);
  // Each platform's own pages light up its own entry, not Advertising's as well.
  const adsPlatform = within("/advertising/google") || within("/advertising/meta");
  const ads = seesTopic(access, "ads", offers);

  const inventory = offers("inventory") && allowed("inventory.view");
  // Every entry once, by name; the two layouts below arrange the same entries.
  const home: NavItem[] = showsDashboardHome(access) ? [{ label: full ? "Dashboard" : "Overview", icon: LayoutDashboard, href: DASHBOARD, active: onDash && view === null }] : [];
  const overview = topic("overview", "Business Overview", Gauge);
  // Profit & Loss (/profit): the statement for any dates, the store's own expenses, managed there, and
  // the day-by-day sheet with the business events (the Profit sheet's own page until 13 Nov 2026). A
  // member without the sales breakdown gets the sheet alone there, so the entry follows the sales.
  const profit = allowed("analytics.sales") ? [area("/profit", "Profit & Loss", Scale)] : [];
  const sales = topic("sales", "Sales & Orders", ShoppingBag);
  const products = topic("products", "Products", Package);
  // The Inventory section (stock per location, alerts, changes). It takes the place of the
  // dashboard's Stock panel in the menu for whoever can open it; the panel stays on the dashboard.
  const stock = inventory ? [area("/inventory", "Inventory", Boxes)] : [];
  const stockPanel = inventory ? [] : topic("stock", "Stock", Boxes);
  const customers = topic("customers", "Customers", UsersRound);
  // Every ad platform: an area of its own, shown to whoever the dashboard's ads panel was (Team & Access, and what the workspace offers).
  const advertising = ads ? [{ ...area("/advertising", "Advertising", Megaphone), active: within("/advertising") && !adsPlatform }] : [];
  const discounts = topic("discounts", "Discounts", BadgePercent);
  // The Shopping Funnel: a page of its own (/funnel), shown to whoever the dashboard's shoppers panel was.
  const funnel = seesTopic(access, "shoppers", offers) ? [area("/funnel", "Shopping Funnel", Funnel)] : [];
  const orders = topic("orders", "Orders", ReceiptText);
  const shipping = topic("shipping", "Shipping", Truck);
  const channels = topic("channels", "Sales channels", Store);
  const people: NavItem[] = [
    ...(offers("staff") && staffAccess(workspace.role, workspace.staffRole, workspace.permissions).permissions.length > 0 ? [area("/staff", "Staff", Users)] : []),
    ...(me.employments?.length ? [area("/portal", "My work", Briefcase)] : []),
  ];
  // The ad platforms by name (each its own pages in the Advertising area), then WhatsApp.
  const marketing: NavItem[] = [
    ...(ads ? [{ ...area("/advertising/google", "Google Ads", Megaphone), glyph: <GoogleAdsIcon size={17} /> }, { ...area("/advertising/meta", "Meta Ads", Megaphone), glyph: <MetaIcon size={17} /> }] : []),
    ...(offers("whatsapp") && allowed("marketing.campaigns") ? [area("/dashboard/whatsapp-automation", "WhatsApp", MessageCircle)] : []),
  ];
  const settings: NavItem[] = [
    ...(allowed("integrations.status") ? [area("/settings/integrations", "Integrations", Plug)] : []),
    ...(allowed("members:manage") ? [area("/team", "Team & Access", ShieldCheck)] : []),
    // Opened from a shared link: no account to manage, only their notifications for this workspace.
    me.shared
      ? area("/settings/notifications", "Notifications", Bell)
      : full
        ? { ...area("/settings", "Business Settings", Settings), href: "/settings/profile", active: within("/settings") && !within("/settings/integrations") }
        : { ...area("/settings/profile", "My Account", UserCog), active: path.startsWith("/settings/profile") || path.startsWith("/settings/security") || path.startsWith("/settings/notifications") },
  ];

  // The whole list, as the menu always was.
  const main: NavItem[] = [...home, ...overview, ...profit, ...sales, ...products, ...stock, ...customers, ...advertising, ...discounts, ...funnel];
  const store: NavItem[] = [...orders, ...stockPanel, ...shipping, ...channels, ...people];
  const entries = main.length + store.length + marketing.length + settings.length;
  const fold = folds(prefs.layout, entries);
  // The short menu: the pages a store owner opens most days, then the rest by group.
  const everyday: NavItem[] = [...home, ...sales, ...products, ...customers, ...stock, ...stockPanel, ...advertising, ...profit];
  const reports: NavItem[] = [...overview, ...discounts, ...funnel];
  const storeMore: NavItem[] = [...orders, ...shipping, ...channels, ...people];

  // A group holding the current page is open by itself until it is closed by hand, on that page.
  const here = `${path}?${view ?? ""}`;
  const [closed, setClosed] = useState<{ at: string; ids: MenuGroupId[] }>({ at: here, ids: [] });
  const closedHere = closed.at === here ? closed.ids : [];
  const group = (id: MenuGroupId, title: string, icon: LucideIcon, items: NavItem[]) => {
    const current = items.some((i) => i.active);
    const shown = groupOpen(id, prefs.open, current, closedHere);
    const toggle = () => {
      if (current) setClosed({ at: here, ids: shown ? [...closedHere, id] : closedHere.filter((g) => g !== id) });
      // What the device remembers follows what was just asked for.
      if (prefs.open.includes(id) === shown) prefs.toggle(id);
    };
    const widen = () => {
      prefs.setRail(false);
      if (!shown) toggle();
    };
    return <FoldGroup id={id} title={title} icon={icon} items={items} shown={shown} onToggle={toggle} onNavigate={onNavigate} rail={rail} onWiden={widen} />;
  };

  return (
    <nav aria-label="App" className={`flex flex-1 flex-col pb-4 pt-2 ${rail ? "gap-3 px-2" : "gap-4 px-3"}`} data-menu={fold ? "short" : "full"}>
      {!full && !rail && (
        // Whose dashboard this is, and as what: someone from outside the business sees it at a glance.
        <div className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5" data-testid="member-badge">
          <p className="truncate text-sm font-semibold text-white">{workspace.name}</p>
          <p className="text-xs text-white/60">Shared with you · {me.shared ? "View only" : ROLE_INFO[access.role].label}</p>
          {me.shared && (
            <p className="mt-1 text-xs text-white/60" data-testid="shared-badge">
              Opened from your invitation link: no sign-in needed{me.shared.expiresAt ? `. Access until ${new Date(me.shared.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.` : "."}
            </p>
          )}
        </div>
      )}
      {fold ? (
        <>
          <NavGroup items={everyday} onNavigate={onNavigate} rail={rail} />
          {group("reports", "More reports", ChartColumn, reports)}
          {group("store", "Store", Store, storeMore)}
          {group("marketing", "Marketing", Send, marketing)}
          {group("settings", "Settings", Settings, settings)}
        </>
      ) : (
        <>
          <NavGroup items={main} onNavigate={onNavigate} rail={rail} />
          <NavGroup title="Store" items={store} onNavigate={onNavigate} rail={rail} />
          <NavGroup title="Marketing & integrations" items={marketing} onNavigate={onNavigate} rail={rail} />
          <NavGroup title="Settings" items={settings} onNavigate={onNavigate} rail={rail} />
        </>
      )}
      {/* The whole list or the short one: kept on this device. Not offered to a menu too short to fold. */}
      {SIMPLE_MENU && entries >= FOLD_FROM && !rail && (
        <button
          type="button"
          onClick={() => prefs.setLayout(prefs.layout === "short" ? "full" : "short")}
          className="self-start rounded px-3 text-xs font-medium text-emerald-300 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-emerald-300"
          data-testid="menu-layout-switch"
        >
          {prefs.layout === "short" ? "Show every page" : "Show fewer pages"}
        </button>
      )}
      {rail ? (
        <Link prefetch={false} href="/support" title="Contact support" className="mt-auto flex items-center justify-center rounded-xl py-2 text-emerald-300 outline-none transition-colors hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-emerald-300">
          <Headset aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.8} />
          <span className="sr-only">Contact support</span>
        </Link>
      ) : (
      <div className="mt-auto rounded-2xl border border-white/10 bg-white/[0.05] p-4">
        <div className="flex items-start gap-3">
          <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
            <Headset className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">Need help?</p>
            <p className="mt-0.5 text-xs leading-relaxed text-white/60">Get support or reach out to our team.</p>
          </div>
        </div>
        {/* Not prefetched: /support is in Geist, and its prefetch preloads fonts this page never uses (docs/architecture.md). */}
        <Link
          prefetch={false}
          href="/support"
          onClick={onNavigate}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-300"
        >
          Contact support
        </Link>
      </div>
      )}
    </nav>
  );
}

/** The switcher's last entry for those who manage stores: Settings → Stores, where another store is connected. */
const CONNECT_STORE = "connect";

/** The store picker: a card showing the store, with the native select laid over it (keyboard and screen readers get a real select). */
function StoreSwitcher() {
  const { stores, store, setStoreId, workspace } = useApp();
  const router = useRouter();
  if (!stores.length) return null;
  const title = store?.name ?? store?.shopDomain ?? "Choose a store";
  return (
    <div className="relative flex h-11 min-w-0 max-w-[17rem] flex-1 items-center gap-2.5 rounded-xl border border-border bg-surface pl-2 pr-8 shadow-[var(--shadow)] transition-colors focus-within:ring-2 focus-within:ring-accent hover:border-accent/40 sm:flex-none">
      <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-white">
        <ShopifyIcon size={16} />
      </span>
      <span aria-hidden className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold">{title}</span>
        {store?.name && <span className="block truncate text-[11px] text-muted">{store.shopDomain}</span>}
      </span>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 h-4 w-4 text-muted" />
      <select
        aria-label="Store"
        data-testid="store-switcher"
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        value={store?.id ?? ""}
        onChange={(e) => (e.target.value === CONNECT_STORE ? router.push("/settings/stores") : setStoreId(e.target.value))}
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>{s.name ?? s.shopDomain}</option>
        ))}
        {canManage(workspace.role) && <option value={CONNECT_STORE}>+ Connect another store</option>}
      </select>
    </div>
  );
}

function initialsOf(name: string | null, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

/**
 * The account menu's button face: the Google profile picture when the account has one (sent
 * without a Referer, so Google isn't told which page shows it), else the initials, which also
 * stand in if the picture doesn't load.
 */
function AccountAvatar({ user }: { user: { displayName: string | null; email: string; avatarUrl?: string | null } }) {
  const [broken, setBroken] = useState(false);
  if (user.avatarUrl && !broken) {
    return <img src={user.avatarUrl} alt="" aria-hidden width={36} height={36} referrerPolicy="no-referrer" className="h-9 w-9 rounded-full object-cover" onError={() => setBroken(true)} />;
  }
  return (
    <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-ink">
      {initialsOf(user.displayName, user.email)}
    </span>
  );
}

/** Closes a popover on a click outside it or on Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

const menuItem = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-text/85 transition-colors hover:bg-text/[0.05] hover:text-text";

/**
 * The account: the avatar in the top bar on a phone ("bar"), or the card at the foot of the
 * sidebar with the name and address ("sidebar"), whose menu opens upwards.
 */
function AccountMenu({ variant = "bar" }: { variant?: "bar" | "sidebar" | "rail" }) {
  const { me } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);

  async function logout() {
    // A shared dashboard closes only its own shared-link session: an account signed in on this
    // browser stays signed in.
    if (me.shared) return closeSharedDashboard(router);
    // Lands on /login?signedOut=1 (or, after Google, the user pool's logout page first), which
    // won't send a session that survived an unreachable logout call straight back in.
    leaveTo(await signOut(), router);
  }

  /** From a shared dashboard to the person's own account: this tab leaves the shared session (which stays open for its link). */
  function ownAccount() {
    setSharedTab(false);
    router.replace("/login");
  }

  const card = variant === "sidebar";
  const up = card || variant === "rail";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Account menu"
        className={
          card
            ? "flex w-full items-center gap-3 rounded-xl p-2 text-left outline-none transition-colors hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-emerald-300"
            : variant === "rail"
              ? "mx-auto flex items-center rounded-full p-0.5 outline-none transition-colors hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-emerald-300"
              : "flex items-center gap-1 rounded-full p-0.5 pr-1 transition-colors hover:bg-text/[0.05]"
        }
      >
        <AccountAvatar user={me.user} />
        {card && (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-semibold text-white">{me.user.displayName ?? me.user.email}</span>
            {me.user.displayName && <span className="block truncate text-xs text-white/55">{me.user.email}</span>}
          </span>
        )}
        {variant !== "rail" && <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 transition-transform ${card ? "text-white/60" : "text-muted"} ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && (
        <div
          className={`animate-rise absolute z-40 w-64 rounded-xl border border-border bg-surface p-1.5 text-text shadow-[var(--shadow-lift)] ${up ? "bottom-full left-0 mb-2" : "right-0 top-full mt-2"}`}
        >
          <div className="px-3 py-2">
            {me.user.displayName && <p className="truncate text-sm font-semibold">{me.user.displayName}</p>}
            <p className="truncate text-xs text-muted">{me.user.email}</p>
          </div>
          <div className="my-1 border-t border-border" />
          {me.shared ? (
            <>
              <p className="px-3 py-1.5 text-xs text-muted">You opened this shared dashboard from an invitation link. It&apos;s view-only, and your own account isn&apos;t used here.</p>
              <button type="button" onClick={ownAccount} className={menuItem}>
                <UserRound aria-hidden className="h-4 w-4 text-muted" />
                Sign in to your account
              </button>
            </>
          ) : (
            <>
              <Link href="/settings/profile" className={menuItem}>
                <UserRound aria-hidden className="h-4 w-4 text-muted" />
                Your profile
              </Link>
              <Link href="/settings/security" className={menuItem}>
                <ShieldCheck aria-hidden className="h-4 w-4 text-muted" />
                Sign-in &amp; security
              </Link>
            </>
          )}
          <div className="my-1 border-t border-border" />
          <button type="button" onClick={logout} className={menuItem}>
            <LogOut aria-hidden className="h-4 w-4 text-muted" />
            {me.shared ? "Close the shared dashboard" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

const SEVERITY: Record<AlertSeverity, { icon: LucideIcon; tone: string; label: string }> = {
  critical: { icon: OctagonAlert, tone: "bg-danger/10 text-danger", label: "Urgent" },
  warning: { icon: TriangleAlert, tone: "bg-warn/10 text-warn", label: "Needs attention" },
  info: { icon: Info, tone: "bg-accent/10 text-accent", label: "Note" },
};

/**
 * The bell: the workspace's open problems (until whatever fixes them resolves them) and the last
 * week's notes. Its dot shows while a problem is open, or a note has come in since the bell was last
 * opened on this device.
 */
function Notifications() {
  const { workspace } = useApp();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  useEffect(() => setOpen(false), [path]);
  const { data, error, reload } = useApi<{ alerts: AlertView[] }>(`/workspaces/${workspace.id}/alerts`);
  const alerts = data?.alerts ?? [];

  // Something may have been fixed (or broken) while the merchant was in another tab.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const seenKey = notesSeenKey(workspace.id);
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => setSeen(readLocal(seenKey)), [seenKey]);
  const newestNote = alerts.find((a) => a.severity === "info")?.createdAt ?? null;
  useEffect(() => {
    if (!open || !newestNote) return;
    writeLocal(seenKey, newestNote);
    setSeen(newestNote);
  }, [open, newestNote, seenKey]);

  const problems = alerts.filter((a) => a.severity !== "info").length;
  const newNote = newestNote !== null && (seen === null || newestNote > seen);
  const label = problems ? `Notifications: ${problems} to fix` : newNote ? "Notifications: new" : "Notifications";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!open) void reload();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-controls="notifications"
        aria-label={label}
        data-testid="notifications-bell"
        data-tour="bell"
        className="relative flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-text/[0.05] hover:text-text"
      >
        <Bell aria-hidden className="h-5 w-5" strokeWidth={1.8} />
        {(problems > 0 || newNote) && <span aria-hidden className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-fill-danger ring-2 ring-surface" />}
      </button>
      {open && (
        // Fixed under the top bar on a phone (anchored to the bell it would run off the left edge).
        <section
          id="notifications"
          aria-labelledby="notifications-title"
          className="animate-rise fixed inset-x-3 top-16 z-40 mt-2 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-lift)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:w-96"
        >
          <div className="flex items-baseline justify-between gap-3 px-4 py-3">
            <h2 id="notifications-title" className="text-sm font-semibold">Notifications</h2>
            {problems > 0 && <span className="text-xs text-muted">{problems} to fix</span>}
          </div>
          {!data ? (
            <p className="border-t border-border px-4 py-6 text-center text-sm text-muted">{error ? "We couldn't load your notifications. We'll keep trying." : "Loading…"}</p>
          ) : alerts.length === 0 ? (
            <div className="border-t border-border px-4 py-8 text-center">
              <CircleCheck aria-hidden className="mx-auto h-8 w-8 text-accent" strokeWidth={1.8} />
              <p className="mt-2 text-sm font-semibold">You&apos;re all caught up</p>
              <p className="mt-0.5 text-xs text-muted">Sync problems and anything else that needs you will show up here.</p>
            </div>
          ) : (
            <ul className="max-h-[min(28rem,calc(100dvh-10rem))] overflow-y-auto border-t border-border">
              {alerts.map((a) => {
                const s = SEVERITY[a.severity];
                const when = fmtRelative(a.createdAt);
                return (
                  <li key={a.id} className="border-b border-border last:border-b-0">
                    <Link href={ALERT_PATH[a.area]} onClick={() => setOpen(false)} className="flex gap-3 px-4 py-3 transition-colors hover:bg-text/[0.04]">
                      <span aria-hidden className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${s.tone}`}>
                        <s.icon className="h-4 w-4" strokeWidth={2} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="sr-only">{s.label}: </span>
                        <span className="block text-sm font-semibold leading-snug">{a.title}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{a.body}</span>
                        <span className="mt-1 block truncate text-[11px] text-muted">
                          {a.store && `${a.store.name} · `}
                          <time dateTime={a.createdAt}>{when}</time>
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-border p-1.5">
            <Link href="/settings/notifications" onClick={() => setOpen(false)} className={menuItem}>
              <Settings aria-hidden className="h-4 w-4 text-muted" />
              Notification settings
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

/** The round button at the bottom right: the two ways to reach a person. */
function HelpBubble() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const mail = `mailto:${CONTACT.supportEmail}?subject=${encodeURIComponent("bizinsights support")}`;
  return (
    <div ref={ref} className="fixed bottom-5 right-5 z-30 print:hidden">
      {open && (
        <div className="animate-rise absolute bottom-full right-0 mb-3 w-72 rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-lift)]">
          <p className="font-semibold">Need a hand?</p>
          <p className="mt-1 text-sm text-muted">We reply within one business day.</p>
          <a href={mail} className="btn-primary mt-3 w-full">
            <Mail aria-hidden className="h-4 w-4" />
            Email support
          </a>
          <Link prefetch={false} href="/support" className="btn-secondary mt-2 w-full">
            <LifeBuoy aria-hidden className="h-4 w-4" />
            Help centre &amp; FAQ
          </Link>
          {/* The look around (components/Tour.tsx), for whoever skipped it or wants it again. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              startTour();
            }}
            className="btn-secondary mt-2 w-full"
            data-testid="tour-start"
          >
            <Compass aria-hidden className="h-4 w-4" />
            Show me around
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Close help" : "Help and support"}
        data-tour="help"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[var(--shadow-lift)] transition-transform hover:-translate-y-0.5"
      >
        {open ? <X aria-hidden className="h-6 w-6" /> : <MessageCircleMore aria-hidden className="h-6 w-6" />}
      </button>
    </div>
  );
}

const TOPIC_ICON: Record<Topic, LucideIcon> = {
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

const TOPIC_WORDS: Partial<Record<Topic, string>> = {
  overview: "health report summary print",
  sales: "orders revenue net gross refunds",
  products: "best sellers catalog",
  shoppers: "analytics visits conversion funnel",
  timing: "busiest hours days",
  ads: "marketing meta google campaigns spend",
  adsense: "earnings adsense",
  customers: "returning contacts",
  orders: "recent latest",
  stock: "inventory low sold out",
};

function useMac() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);
  return mac;
}

function TopBar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { workspaces, workspace, setWorkspaceId } = useApp();
  const mac = useMac();
  return (
    <header className="sticky top-0 z-30 bg-surface/95 shadow-[0_1px_8px_rgb(0_0_0/0.04)] backdrop-blur-md print:hidden">
      <div className="flex h-16 items-center gap-3 pl-2 pr-3 sm:pl-3 sm:pr-5 lg:px-8">
        {/* On a wide screen the logo heads the sidebar instead. */}
        <div className="flex shrink-0 items-center gap-1 lg:hidden">
          <button type="button" onClick={onMenu} aria-label="Open navigation" data-tour="menu-button" className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-text/[0.05] hover:text-text">
            <Menu aria-hidden className="h-5 w-5" />
          </button>
          <Link href={DASHBOARD} className="hidden items-center sm:flex" aria-label="bizinsights home">
            <BrandLogo size={26} className="text-lg" />
          </Link>
        </div>
        <StoreSwitcher />
        {workspaces.length > 1 && (
          <select aria-label="Workspace" className="input hidden h-11 w-auto max-w-[12rem] rounded-xl md:block" value={workspace.id} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={onSearch}
          data-tour="search"
          className="hidden h-10 min-w-0 max-w-md flex-1 items-center gap-2.5 rounded-lg border border-transparent bg-bg px-3.5 text-sm text-muted transition-colors hover:border-accent/30 md:flex"
        >
          <Search aria-hidden className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Search insights, pages and settings…</span>
          <kbd aria-hidden className="shrink-0 rounded bg-home-soft-hover px-1.5 py-0.5 font-sans text-[11px]">{mac ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <button type="button" onClick={onSearch} aria-label="Search" data-tour="search-button" className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-text/[0.05] hover:text-text md:hidden">
            <Search aria-hidden className="h-5 w-5" />
          </button>
          <ThemeToggle />
          <Notifications />
          {/* On a wide screen the account is the card at the foot of the sidebar. */}
          <div className="lg:hidden">
            <AccountMenu />
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * Route guard: a page or dashboard panel this member may not open (typed in, bookmarked, or just
 * taken away by an owner) sends them to where they can go, and says why. The API refuses its data
 * either way; this keeps them off a page that could only show refusals.
 */
function useAccessGuard(): boolean {
  const { me, access, workspace, setAccessNotice, offers } = useApp();
  const router = useRouter();
  const path = usePathname();
  const view = useCurrentView();
  const pageOk = canOpenPage(path, access, workspace.staffRole ?? null, !!me.shared, offers);
  const topicOk = !(isDashboard(path) && view && !seesTopic(access, view, offers));
  const ok = pageOk && topicOk;
  useEffect(() => {
    if (ok) return;
    setAccessNotice(pageOk ? "That part of the dashboard isn't shared with you." : "You don't have access to that page.");
    router.replace(landingPath(access, workspace.staffRole ?? null, offers));
  }, [ok, pageOk, access, workspace.staffRole, router, setAccessNotice, offers]);
  return ok;
}

function AccessNotice() {
  const { accessNotice, setAccessNotice } = useApp();
  if (!accessNotice) return null;
  return (
    <div className="mb-4" data-testid="access-notice">
      <Alert kind="info" onDismiss={() => setAccessNotice(null)}>
        {accessNotice}
      </Alert>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, workspace, workspaces, setWorkspaceId, access, allowed, offers } = useApp();
  const router = useRouter();
  const path = usePathname();
  const allowedHere = useAccessGuard();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [tour, setTour] = useState(false);
  const prefs = useMenuPrefs();
  const { theme, setChoice: setTheme } = useTheme();
  useEffect(() => setDrawer(false), [path]);

  // The look around, asked for from the Home's offer or the help button (lib/tour.ts).
  useEffect(() => {
    const open = () => {
      setDrawer(false);
      setPalette(false);
      setTour(true);
    };
    window.addEventListener(TOUR_EVENT, open);
    return () => window.removeEventListener(TOUR_EVENT, open);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  const items = useMemo<PaletteItem[]>(() => {
    const go = (href: string) => () => router.push(href);
    const staff = offers("staff") && staffAccess(workspace.role, workspace.staffRole, workspace.permissions).permissions.length > 0;
    const page = (href: string) => canOpenPage(href, access, workspace.staffRole ?? null, !!me.shared, offers);
    return [
      ...(showsDashboardHome(access) ? [{ id: "dashboard", label: "Dashboard", group: "Insights", icon: LayoutDashboard, keywords: "home", go: go(DASHBOARD) }] : []),
      ...(allowed("analytics.sales")
        ? [{ id: "profit", label: "Profit & Loss", group: "Insights", icon: Scale, keywords: "p&l profit loss sheet spreadsheet daily weekly monthly expenses costs recurring categories business events calendar mer roas vcr fcr statement", go: go("/profit") }]
        : []),
      ...TOPICS.filter((t) => seesTopic(access, t, offers)).map(
        (t): PaletteItem => ({ id: `topic-${t}`, label: topicInfo(t).title, group: "Insights", icon: TOPIC_ICON[t], keywords: TOPIC_WORDS[t], go: () => goToTopic(t, window.location.pathname, (href) => router.push(href)) }),
      ),
      ...(offers("inventory") && allowed("inventory.view")
        ? [
            { id: "inventory", label: "Inventory", group: "Inventory", icon: Boxes, keywords: "stock levels warehouse locations sku", go: go("/inventory") },
            { id: "inventory-stock", label: "All stock", group: "Inventory", icon: Boxes, keywords: "inventory products variants sku barcode", go: go("/inventory/stock") },
            { id: "inventory-low", label: "Low stock", group: "Inventory", icon: TriangleAlert, keywords: "inventory running low restock reorder", go: go("/inventory/low-stock") },
            { id: "inventory-out", label: "Out of stock", group: "Inventory", icon: OctagonAlert, keywords: "inventory sold out", go: go("/inventory/out-of-stock") },
            ...(allowed("inventory.history") ? [{ id: "inventory-movements", label: "Inventory movements", group: "Inventory", icon: Boxes, keywords: "stock history adjustments audit", go: go("/inventory/movements") }] : []),
            { id: "inventory-locations", label: "Locations", group: "Inventory", icon: Store, keywords: "inventory warehouses shops", go: go("/inventory/locations") },
            { id: "inventory-reports", label: "Inventory reports", group: "Inventory", icon: ChartColumn, keywords: "stock trends turnover sell-through", go: go("/inventory/reports") },
            { id: "inventory-settings", label: "Stock settings", group: "Inventory", icon: Settings, keywords: "thresholds alerts low stock", go: go("/inventory/settings") },
          ]
        : []),
      ...(seesTopic(access, "ads", offers)
        ? [
            { id: "advertising-meta", label: "Meta Ads", group: "Advertising", icon: Megaphone, keywords: "facebook instagram ads spend purchases roas", go: go("/advertising/meta") },
            { id: "advertising-google", label: "Google Ads", group: "Advertising", icon: Megaphone, keywords: "google ads spend conversions roas", go: go("/advertising/google") },
            { id: "google-ads", label: "Google Ads analytics", group: "Advertising", icon: Megaphone, keywords: "google ads demo campaigns devices audience recommendations", go: go("/advertising/google/analytics") },
            ...(allowed("marketing.campaigns") ? [{ id: "advertising-campaigns", label: "Campaign comparison", group: "Advertising", icon: Megaphone, keywords: "campaigns meta google side by side", go: go("/advertising/campaigns") }] : []),
            { id: "advertising-reports", label: "Advertising reports", group: "Advertising", icon: Megaphone, keywords: "csv export download ads", go: go("/advertising/reports") },
          ]
        : []),
      ...(offers("whatsapp") && allowed("marketing.campaigns") ? [{ id: "whatsapp", label: "WhatsApp", group: "Apps", icon: MessageCircle, keywords: "messages campaigns", go: go("/dashboard/whatsapp-automation") }] : []),
      ...(staff ? [{ id: "staff", label: "Staff", group: "Apps", icon: Users, keywords: "employees payroll timesheets roster", go: go("/staff") }] : []),
      ...(me.employments?.length ? [{ id: "portal", label: "My work", group: "Apps", icon: Briefcase, go: go("/portal") }] : []),
      ...(allowed("members:manage") ? [{ id: "team", label: "Team & Access", group: "Settings", icon: ShieldCheck, keywords: "members invite users roles permissions share", go: go("/team") }] : []),
      ...SETTINGS_PAGES.filter((s) => !s.href && page(`/settings/${s.slug}`)).map((s): PaletteItem => ({ id: `settings-${s.slug}`, label: s.label, group: "Settings", icon: s.icon, keywords: s.keywords, go: go(`/settings/${s.slug}`) })),
      // Light or dark, as the top bar's button: to the other one from the one showing.
      { id: "theme", label: `Switch to ${otherTheme(theme)} mode`, group: "Settings", icon: theme === "dark" ? Sun : Moon, keywords: "appearance theme dark light night colours colors", go: () => setTheme(otherTheme(theme)) },
      { id: "help", label: "Help centre", group: "Help", icon: Headset, keywords: "support contact faq", go: go("/support") },
    ];
  }, [router, workspace.role, workspace.staffRole, workspace.permissions, me.employments, me.shared, access, allowed, offers, theme, setTheme]);

  return (
    <div className="app-look min-h-dvh lg:flex">
      <aside className={`sticky top-0 hidden h-dvh shrink-0 flex-col bg-nav lg:flex print:hidden ${prefs.rail ? "w-[4.5rem]" : "w-60"}`} data-tour="menu" data-rail={prefs.rail ? "on" : "off"}>
        <div className={`flex shrink-0 items-center ${prefs.rail ? "flex-col gap-1 px-2 pb-1 pt-4" : "h-16 justify-between gap-2 pl-5 pr-3"}`}>
          <Link href={DASHBOARD} className="flex items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-300" aria-label="bizinsights home">
            {prefs.rail ? <BrandMark size={28} /> : <BrandLogo size={26} className="text-lg text-white" />}
          </Link>
          {/* Narrow the sidebar to its icons, or widen it again: kept on this device. */}
          <button
            type="button"
            onClick={() => prefs.setRail(!prefs.rail)}
            aria-pressed={prefs.rail}
            aria-label={prefs.rail ? "Widen the menu" : "Narrow the menu to icons"}
            title={prefs.rail ? "Widen the menu" : "Narrow the menu to icons"}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/55 outline-none transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:ring-2 focus-visible:ring-emerald-300"
            data-testid="menu-rail-switch"
          >
            {prefs.rail ? <PanelLeftOpen aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.8} /> : <PanelLeftClose aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.8} />}
          </button>
        </div>
        {/* The menu scrolls on a short screen; the account stays at the foot. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Sidebar prefs={prefs} rail={prefs.rail} />
        </div>
        <div className={`shrink-0 border-t border-white/10 ${prefs.rail ? "p-2" : "p-3"}`}>
          <AccountMenu variant={prefs.rail ? "rail" : "sidebar"} />
        </div>
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="animate-fade absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} aria-hidden />
          <div className="animate-drawer relative flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto bg-nav shadow-2xl">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-4">
              <BrandLogo size={26} className="text-lg text-white" />
              <button type="button" onClick={() => setDrawer(false)} aria-label="Close navigation" className="flex h-10 w-10 items-center justify-center rounded-full text-white/70 hover:bg-white/[0.08] hover:text-white">
                <X aria-hidden className="h-5 w-5" />
              </button>
            </div>
            {/* The top bar has no room for the workspace picker on a phone. */}
            {workspaces.length > 1 && (
              <div className="px-6 pt-4 md:hidden">
                <label htmlFor="drawer-workspace" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-white/45">Workspace</label>
                <select id="drawer-workspace" className="input" value={workspace.id} onChange={(e) => setWorkspaceId(e.target.value)}>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-1 flex-col pt-3">
              <Sidebar onNavigate={() => setDrawer(false)} prefs={prefs} />
            </div>
          </div>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <TopBar onMenu={() => setDrawer(true)} onSearch={() => setPalette(true)} />
        <main className="px-4 pb-24 pt-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[90rem]">
            <AccessNotice />
            {allowedHere ? children : <p className="text-muted">Loading…</p>}
          </div>
        </main>
      </div>
      <HelpBubble />
      {palette && <CommandPalette items={items} onClose={() => setPalette(false)} />}
      {tour && (
        <Tour
          onClose={() => {
            writeLocal(TOUR_SEEN_KEY, "1");
            setTour(false);
          }}
        />
      )}
    </div>
  );
}
