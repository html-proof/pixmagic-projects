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
  OctagonAlert,
  Package,
  Plug,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  UserCog,
  ShoppingBag,
  Store,
  TriangleAlert,
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
import { fmtRelative } from "@/components/dashboard/format";
import { openView, topicInfo, TOPICS, useCurrentView, type Topic } from "@/components/dashboard/topics";
import { setSharedTab, useApi } from "@/lib/api";
import { closeSharedDashboard } from "@/components/team/AccessStates";
import { leaveTo, signOut } from "@/lib/auth";
import { CONTACT } from "@/lib/contact";
import { SETTINGS_PAGES } from "@/lib/settingsNav";
import { notesSeenKey, readLocal, writeLocal } from "@/lib/storage";
import { ALERT_PATH, type AlertSeverity, type AlertView } from "@app/shared/alerts";
import { hasFullAccess, ROLE_INFO } from "@app/shared/access";
import { staffAccess } from "@app/shared/staff";
import { Alert } from "@/components/ui";
import { canOpenPage, landingPath, seesTopic, showsDashboardHome, TOPIC_PAGE } from "@/lib/access";

// ---------------------------------------------------------------------------
// The signed-in frame: a top bar (store, search, notifications, account) over a sidebar that
// lists the dashboard's topics and the other areas. On a phone the sidebar slides in from the
// menu button. Topics open the dashboard's detail panels (?view=…), the same ones its cards open;
// advertising has an area of its own (/advertising).
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
  const { me, workspace, access, allowed, offers } = useApp();
  const onDash = isDashboard(path);
  const full = hasFullAccess(access.role);
  // Only what this member was granted (Team & Access), of what the workspace offers; the API refuses
  // the rest whatever the menu shows.
  const topic = (t: Topic, label: string, icon: LucideIcon): NavItem[] => (seesTopic(access, t, offers) ? [{ label, icon, href: `${DASHBOARD}?view=${t}`, topic: t, active: onDash && view === t }] : []);
  const area = (href: string, label: string, icon: LucideIcon): NavItem => ({ label, icon, href, active: path === href || path.startsWith(`${href}/`) });

  const main: NavItem[] = [
    ...(showsDashboardHome(access) ? [{ label: full ? "Dashboard" : "Overview", icon: LayoutDashboard, href: DASHBOARD, active: onDash && view === null }] : []),
    ...topic("overview", "Business Overview", Gauge),
    ...topic("sales", "Sales & Orders", ShoppingBag),
    ...topic("products", "Products", Package),
    // The Inventory section (stock per location, alerts, changes). It takes the place of the
    // dashboard's Stock panel in the menu for whoever can open it; the panel stays on the dashboard.
    ...(offers("inventory") && allowed("inventory.view") ? [area("/inventory", "Inventory", Boxes)] : []),
    ...topic("customers", "Customers", UsersRound),
    // Every ad platform: an area of its own, shown to whoever the dashboard's ads panel was (Team & Access, and what the workspace offers).
    ...(seesTopic(access, "ads", offers) ? [area("/advertising", "Advertising", Megaphone)] : []),
    ...topic("discounts", "Discounts", BadgePercent),
    ...topic("shoppers", "Analytics", ChartColumn),
  ];
  const inventory = offers("inventory") && allowed("inventory.view");
  const store: NavItem[] = [...topic("orders", "Orders", ReceiptText), ...(inventory ? [] : topic("stock", "Stock", Boxes)), ...topic("shipping", "Shipping", Truck), ...topic("channels", "Sales channels", Store)];
  const apps: NavItem[] = [
    ...(offers("whatsapp") && allowed("marketing.campaigns") ? [area("/whatsapp", "WhatsApp", MessageCircle)] : []),
    ...(offers("staff") && staffAccess(workspace.role, workspace.staffRole, workspace.permissions).permissions.length > 0 ? [area("/staff", "Staff", Users)] : []),
    ...(me.employments?.length ? [area("/portal", "My work", Briefcase)] : []),
    ...(!full && allowed("integrations.status") ? [area("/settings/integrations", "Integrations", Plug)] : []),
    ...(allowed("members:manage") ? [area("/team", "Team & Access", ShieldCheck)] : []),
    // Opened from a shared link: no account to manage, only their notifications for this workspace.
    me.shared
      ? area("/settings/notifications", "Notifications", Bell)
      : full
        ? { ...area("/settings", "Settings", Settings), href: "/settings/profile" }
        : { ...area("/settings/profile", "My Account", UserCog), active: path.startsWith("/settings/profile") || path.startsWith("/settings/security") || path.startsWith("/settings/notifications") },
  ];

  return (
    <nav aria-label="App" className="flex h-full flex-col gap-4 px-3 py-5">
      {!full && (
        // Whose dashboard this is, and as what: someone from outside the business sees it at a glance.
        <div className="rounded-xl border border-border bg-bg/60 px-3 py-2.5" data-testid="member-badge">
          <p className="truncate text-sm font-semibold">{workspace.name}</p>
          <p className="text-xs text-muted">Shared with you · {me.shared ? "View only" : ROLE_INFO[access.role].label}</p>
          {me.shared && (
            <p className="mt-1 text-xs text-muted" data-testid="shared-badge">
              Opened from your invitation link: no sign-in needed{me.shared.expiresAt ? `. Access until ${new Date(me.shared.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.` : "."}
            </p>
          )}
        </div>
      )}
      <NavGroup items={main} onNavigate={onNavigate} />
      <NavGroup title="Store" items={store} onNavigate={onNavigate} />
      <NavGroup title={full ? "Apps & integrations" : "More"} items={apps} onNavigate={onNavigate} />
      <div className="mt-auto rounded-2xl border border-border bg-gradient-to-br from-accent/[0.07] to-transparent p-4">
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/12 text-accent">
          <LifeBuoy className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </span>
        <p className="mt-3 text-sm font-semibold">Need help?</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">Get support or read answers to common questions.</p>
        {/* Not prefetched: /support is in Geist, and its prefetch preloads fonts this page never uses (docs/architecture.md). */}
        <Link prefetch={false} href="/support" onClick={onNavigate} className="btn-primary mt-3 w-full text-xs">
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
  const { workspaces, workspace, setWorkspaceId } = useApp();
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
          <Notifications />
          <AccountMenu />
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
    const staff = offers("staff") && staffAccess(workspace.role, workspace.staffRole, workspace.permissions).permissions.length > 0;
    const page = (href: string) => canOpenPage(href, access, workspace.staffRole ?? null, !!me.shared, offers);
    return [
      ...(showsDashboardHome(access) ? [{ id: "dashboard", label: "Dashboard", group: "Insights", icon: LayoutDashboard, keywords: "home", go: go(DASHBOARD) }] : []),
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
      ...(offers("whatsapp") && allowed("marketing.campaigns") ? [{ id: "whatsapp", label: "WhatsApp", group: "Apps", icon: MessageCircle, keywords: "messages campaigns", go: go("/whatsapp") }] : []),
      ...(staff ? [{ id: "staff", label: "Staff", group: "Apps", icon: Users, keywords: "employees payroll timesheets roster", go: go("/staff") }] : []),
      ...(me.employments?.length ? [{ id: "portal", label: "My work", group: "Apps", icon: Briefcase, go: go("/portal") }] : []),
      ...(allowed("members:manage") ? [{ id: "team", label: "Team & Access", group: "Settings", icon: ShieldCheck, keywords: "members invite users roles permissions share", go: go("/team") }] : []),
      ...SETTINGS_PAGES.filter((s) => !s.href && page(`/settings/${s.slug}`)).map((s): PaletteItem => ({ id: `settings-${s.slug}`, label: s.label, group: "Settings", icon: s.icon, keywords: s.keywords, go: go(`/settings/${s.slug}`) })),
      { id: "help", label: "Help centre", group: "Help", icon: Headset, keywords: "support contact faq", go: go("/support") },
    ];
  }, [router, workspace.role, workspace.staffRole, workspace.permissions, me.employments, me.shared, access, allowed, offers]);

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
              {workspaces.length > 1 && (
                <div className="px-6 pt-4 md:hidden">
                  <label htmlFor="drawer-workspace" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">Workspace</label>
                  <select id="drawer-workspace" className="input" value={workspace.id} onChange={(e) => setWorkspaceId(e.target.value)}>
                    {workspaces.map((w) => (
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
          <div className="mx-auto max-w-[90rem]">
            <AccessNotice />
            {allowedHere ? children : <p className="text-muted">Loading…</p>}
          </div>
        </main>
      </div>
      <HelpBubble />
      {palette && <CommandPalette items={items} onClose={() => setPalette(false)} />}
    </div>
  );
}
