"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Briefcase, LayoutDashboard, LogOut, MessageCircle, Settings, UsersRound, type LucideIcon } from "lucide-react";
import { AppProvider, useApp } from "@/components/AppContext";
import { BrandMark } from "@/components/Brand";
import { leaveTo, signOut } from "@/lib/auth";
import { staffAccess } from "@app/shared/staff";

/** A top-bar link: its icon is decorative, the label says where it goes. */
function NavLink({ href, label, icon: Glyph, active }: { href: string; label: string; icon: LucideIcon; active?: boolean }) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 transition ${active ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`}
      href={href}
    >
      <Glyph size={16} strokeWidth={1.8} aria-hidden="true" />
      {label}
    </Link>
  );
}

function TopBar() {
  const { me, workspace, setWorkspaceId, stores, store, setStoreId } = useApp();
  const router = useRouter();
  const path = usePathname();

  async function logout() {
    // Lands on /login?signedOut=1 (or, after Google, the user pool's logout page first), which
    // won't send a session that survived an unreachable logout call straight back in.
    leaveTo(await signOut(), router);
  }

  return (
    <header className="border-b border-border bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/dashboard" className="group flex items-center gap-2 font-semibold">
          <BrandMark size={28} className="transition-transform group-hover:-translate-y-0.5" />
          <span className="text-text">bizinsights</span>
        </Link>
        {me.workspaces.length > 1 && (
          <select aria-label="Workspace" className="input w-auto" value={workspace.id} onChange={(e) => setWorkspaceId(e.target.value)}>
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        )}
        {stores.length > 0 && (
          <select aria-label="Store" data-testid="store-switcher" className="input w-auto max-w-[16rem]" value={store?.id ?? ""} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name ?? s.shopDomain}</option>
            ))}
          </select>
        )}
        <nav aria-label="Main" className="ml-auto flex flex-wrap items-center gap-2 text-sm">
          <NavLink href="/dashboard" label="Dashboard" icon={LayoutDashboard} active={path.startsWith("/dashboard")} />
          <NavLink href="/whatsapp" label="WhatsApp" icon={MessageCircle} active={path.startsWith("/whatsapp")} />
          {staffAccess(workspace.role, workspace.staffRole).permissions.length > 0 && (
            <NavLink href="/staff" label="Staff" icon={UsersRound} active={path.startsWith("/staff")} />
          )}
          {!!me.employments?.length && <NavLink href="/portal" label="My work" icon={Briefcase} />}
          <NavLink href="/settings/profile" label="Settings" icon={Settings} active={path.startsWith("/settings")} />
          <button className="inline-flex items-center gap-1.5 px-3 py-1 text-muted transition hover:text-text" onClick={logout}>
            <LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <TopBar />
      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </AppProvider>
  );
}
