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
  Gauge,
  Headset,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  MessageCircle,
  MessageCircleMore,
  Package,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Store,
  Truck,
  UserRound,
  Users,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useApp } from "@/components/AppContext";
import { BrandLogo } from "@/components/Brand";
import { CommandPalette, type PaletteItem } from "@/components/CommandPalette";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { openView, topicInfo, TOPICS, useCurrentView, type Topic } from "@/components/dashboard/topics";
import { leaveTo, signOut } from "@/lib/auth";
import { CONTACT } from "@/lib/contact";
import { SETTINGS_PAGES } from "@/lib/settingsNav";
import { staffAccess } from "@app/shared/staff";

// ---------------------------------------------------------------------------
// The signed-in frame: a top bar (store, search, notifications, account) over a sidebar that
// lists the dashboard's topics and the other areas. On a phone the sidebar slides in from the
// menu button. Topics open the dashboard's detail panels (?view=…), the same ones its cards open.
// ---------------------------------------------------------------------------

const DASHBOARD = "/dashboard";
const isDashboard = (path: string) => path.replace(/\/$/, "") === DASHBOARD;

/** Go to a dashboard topic: open its panel in place on the dashboard, or load the dashboard with it open. */
function goToTopic(topic: Topic, path: string, push: (href: string) => void) {
  if (isDashboard(path)) openView(topic);
  else push(`${DASHBOARD}?view=${topic}`);
}

interface NavItem {
  label: string;
  icon: LucideIcon;
  href: string;
  topic?: Topic;
  active: boolean;
}

function SideLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const path = usePathname();
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={item.active ? "page" : undefined}
      onClick={(e) => {
        // On the dashboard a topic opens without reloading the page's numbers.
        if (item.topic && isDashboard(path) && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          openView(item.topic);
        }
        onNavigate?.();
      }}
      className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
        item.active ? "bg-accent/10 text-text" : "text-text/75 hover:bg-text/[0.04] hover:text-text"
      }`}
    >
      <Icon aria-hidden className={`h-[18px] w-[18px] shrink-0 ${item.active ? "text-accent" : "text-muted group-hover:text-text"}`} strokeWidth={1.8} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function NavGroup({ title, items, onNavigate }: { title?: string; items: NavItem[]; onNavigate?: () => void }) {
  if (!items.length) return null;
  return (
    <div className={title ? "border-t border-border pt-4" : undefined}>
      {title && <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</p>}
      <ul className="space-y-0.5">
        {items.map((i) => (
          <li key={i.href}>
            <SideLink item={i} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname().replace(/\/$/, "");
  const view = useCurrentView();
  const { me, workspace } = useApp();
  const onDash = isDashboard(path);
  const topic = (t: Topic, label: string, icon: LucideIcon): NavItem => ({ label, icon, href: `${DASHBOARD}?view=${t}`, topic: t, active: onDash && view === t });
  const area = (href: string, label: string, icon: LucideIcon): NavItem => ({ label, icon, href, active: path === href || path.startsWith(`${href}/`) });

  const main: NavItem[] = [
    { label: "Dashboard", icon: LayoutDashboard, href: DASHBOARD, active: onDash && view === null },
    topic("overview", "Business Overview", Gauge),
    topic("sales", "Sales & Orders", ShoppingBag),
    topic("products", "Products", Package),
    topic("customers", "Customers", UsersRound),
    topic("ads", "Marketing", Megaphone),
    topic("discounts", "Discounts", BadgePercent),
    topic("shoppers", "Analytics", ChartColumn),
  ];
  const store: NavItem[] = [topic("stock", "Stock", Boxes), topic("shipping", "Shipping", Truck), topic("channels", "Sales channels", Store)];
  const apps: NavItem[] = [
    area("/whatsapp", "WhatsApp", MessageCircle),
    ...(staffAccess(workspace.role, workspace.staffRole).permissions.length > 0 ? [area("/staff", "Staff", Users)] : []),
    ...(me.employments?.length ? [area("/portal", "My work", Briefcase)] : []),
    { ...area("/settings", "Settings", Settings), href: "/settings/profile" },
  ];

  return (
    <nav aria-label="App" className="flex h-full flex-col gap-4 px-3 py-5">
      <NavGroup items={main} onNavigate={onNavigate} />
      <NavGroup title="Store" items={store} onNavigate={onNavigate} />
      <NavGroup title="Apps & integrations" items={apps} onNavigate={onNavigate} />
      <div className="mt-auto rounded-2xl border border-border bg-gradient-to-br from-accent/[0.07] to-transparent p-4">
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/12 text-accent">
          <LifeBuoy className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </span>
        <p className="mt-3 text-sm font-semibold">Need help?</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">Get support or read answers to common questions.</p>
        <Link href="/support" onClick={onNavigate} className="btn-primary mt-3 w-full text-xs">
          View help centre
          <span aria-hidden>→</span>
        </Link>
      </div>
    </nav>
  );
}

/** The store picker: a card showing the store, with the native select laid over it (keyboard and screen readers get a real select). */
function StoreSwitcher() {
  const { stores, store, setStoreId } = useApp();
  if (!stores.length) return null;
  const title = store?.name ?? store?.shopDomain ?? "Choose a store";
  return (
    <div className="relative flex h-11 min-w-0 max-w-[17rem] flex-1 items-center gap-2.5 rounded-xl border border-border bg-surface pl-2 pr-8 shadow-[var(--shadow)] transition-colors focus-within:ring-2 focus-within:ring-accent hover:border-accent/40 sm:flex-none">
      <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#95bf47]/15 text-[#5e8e3e] dark:text-[#95bf47]">
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
        onChange={(e) => setStoreId(e.target.value)}
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>{s.name ?? s.shopDomain}</option>
        ))}
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

function AccountMenu() {
  const { me } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);

  async function logout() {
    // Lands on /login?signedOut=1 (or, after Google, the user pool's logout page first), which
    // won't send a session that survived an unreachable logout call straight back in.
    leaveTo(await signOut(), router);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-1 rounded-full p-0.5 pr-1 transition-colors hover:bg-text/[0.05]"
      >
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-ink">
          {initialsOf(me.user.displayName, me.user.email)}
        </span>
        <ChevronDown aria-hidden className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="animate-rise absolute right-0 top-full z-40 mt-2 w-64 rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-lift)]">
          <div className="px-3 py-2">
            {me.user.displayName && <p className="truncate text-sm font-semibold">{me.user.displayName}</p>}
            <p className="truncate text-xs text-muted">{me.user.email}</p>
          </div>
          <div className="my-1 border-t border-border" />
          <Link href="/settings/profile" className={menuItem}>
            <UserRound aria-hidden className="h-4 w-4 text-muted" />
            Your profile
          </Link>
          <Link href="/settings/security" className={menuItem}>
            <ShieldCheck aria-hidden className="h-4 w-4 text-muted" />
            Sign-in &amp; security
          </Link>
          <div className="my-1 border-t border-border" />
          <button type="button" onClick={logout} className={menuItem}>
            <LogOut aria-hidden className="h-4 w-4 text-muted" />
            Sign out
          </button>
        </div>
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
          <Link href="/support" className="btn-secondary mt-2 w-full">
            <LifeBuoy aria-hidden className="h-4 w-4" />
            Help centre &amp; FAQ
          </Link>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Close help" : "Help and support"}
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
  shoppers: ChartColumn,
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
  const { me, workspace, setWorkspaceId } = useApp();
  const mac = useMac();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-md print:hidden">
      <div className="flex h-16 items-center gap-3 pr-3 sm:pr-5">
        <div className="flex shrink-0 items-center gap-1 pl-2 sm:pl-3 lg:w-60 lg:pl-5">
          <button type="button" onClick={onMenu} aria-label="Open navigation" className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-text/[0.05] hover:text-text lg:hidden">
            <Menu aria-hidden className="h-5 w-5" />
          </button>
          <Link href={DASHBOARD} className="hidden items-center sm:flex" aria-label="bizinsights home">
            <BrandLogo size={26} className="text-lg" />
          </Link>
        </div>
        <StoreSwitcher />
        {me.workspaces.length > 1 && (
          <select aria-label="Workspace" className="input hidden h-11 w-auto max-w-[12rem] rounded-xl md:block" value={workspace.id} onChange={(e) => setWorkspaceId(e.target.value)}>
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-11 min-w-0 max-w-md flex-1 items-center gap-2.5 rounded-xl border border-border bg-bg/70 px-3.5 text-sm text-muted transition-colors hover:border-accent/40 md:flex"
        >
          <Search aria-hidden className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Search insights, pages and settings…</span>
          <kbd aria-hidden className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 font-sans text-[11px]">{mac ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <button type="button" onClick={onSearch} aria-label="Search" className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-text/[0.05] hover:text-text md:hidden">
            <Search aria-hidden className="h-5 w-5" />
          </button>
          <Link href="/settings/notifications" aria-label="Notification settings" className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-text/[0.05] hover:text-text">
            <Bell aria-hidden className="h-5 w-5" strokeWidth={1.8} />
          </Link>
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, workspace, setWorkspaceId } = useApp();
  const router = useRouter();
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => setDrawer(false), [path]);

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
    const staff = staffAccess(workspace.role, workspace.staffRole).permissions.length > 0;
    return [
      { id: "dashboard", label: "Dashboard", group: "Insights", icon: LayoutDashboard, keywords: "home", go: go(DASHBOARD) },
      ...TOPICS.map((t): PaletteItem => ({ id: `topic-${t}`, label: topicInfo(t).title, group: "Insights", icon: TOPIC_ICON[t], keywords: TOPIC_WORDS[t], go: () => goToTopic(t, window.location.pathname, (href) => router.push(href)) })),
      { id: "whatsapp", label: "WhatsApp", group: "Apps", icon: MessageCircle, keywords: "messages campaigns", go: go("/whatsapp") },
      ...(staff ? [{ id: "staff", label: "Staff", group: "Apps", icon: Users, keywords: "employees payroll timesheets roster", go: go("/staff") }] : []),
      ...(me.employments?.length ? [{ id: "portal", label: "My work", group: "Apps", icon: Briefcase, go: go("/portal") }] : []),
      ...SETTINGS_PAGES.map((s): PaletteItem => ({ id: `settings-${s.slug}`, label: s.label, group: "Settings", icon: s.icon, keywords: s.keywords, go: go(`/settings/${s.slug}`) })),
      { id: "help", label: "Help centre", group: "Help", icon: Headset, keywords: "support contact faq", go: go("/support") },
    ];
  }, [router, workspace.role, workspace.staffRole, me.employments]);

  return (
    <div className="min-h-dvh">
      <TopBar onMenu={() => setDrawer(true)} onSearch={() => setPalette(true)} />
      <div className="flex">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 overflow-y-auto border-r border-border bg-surface/55 lg:block print:hidden">
          <Sidebar />
        </aside>
        {drawer && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="animate-fade absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} aria-hidden />
            <div className="animate-drawer relative flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto bg-surface shadow-2xl">
              <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
                <BrandLogo size={26} className="text-lg" />
                <button type="button" onClick={() => setDrawer(false)} aria-label="Close navigation" className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-text/[0.05] hover:text-text">
                  <X aria-hidden className="h-5 w-5" />
                </button>
              </div>
              {/* The top bar has no room for the workspace picker on a phone. */}
              {me.workspaces.length > 1 && (
                <div className="px-6 pt-4 md:hidden">
                  <label htmlFor="drawer-workspace" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">Workspace</label>
                  <select id="drawer-workspace" className="input" value={workspace.id} onChange={(e) => setWorkspaceId(e.target.value)}>
                    {me.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <Sidebar onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        )}
        <main className="min-w-0 flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[90rem]">{children}</div>
        </main>
      </div>
      <HelpBubble />
      {palette && <CommandPalette items={items} onClose={() => setPalette(false)} />}
    </div>
  );
}
