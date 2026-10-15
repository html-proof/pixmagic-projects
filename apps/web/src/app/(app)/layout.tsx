"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { AppProvider, useApp } from "@/components/AppContext";
import { leaveTo, signOut } from "@/lib/auth";
import { staffAccess } from "@app/shared/staff";

function TopBar() {
  const { me, workspace, setWorkspaceId, stores, store, setStoreId } = useApp();
  const router = useRouter();
  const path = usePathname();

  async function logout() {
    // Lands on /login?signedOut=1 (or, after Google/Apple, the user pool's logout page first), which
    // won't send a session that survived an unreachable logout call straight back in.
    leaveTo(await signOut(), router);
  }

  return (
    <header className="border-b border-border bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/dashboard" className="group flex items-center gap-2 font-semibold">
          <span aria-hidden className="brand-gradient animate-pan flex h-7 w-7 items-center justify-center rounded-lg text-white shadow-sm transition-transform group-hover:rotate-6">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l5-5 4 3 7-8" /></svg>
          </span>
          <span className="text-text">Insights</span>
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
        <nav className="ml-auto flex items-center gap-4 text-sm">
          <Link aria-current={path.startsWith("/dashboard") ? "page" : undefined} className={`rounded-full px-3 py-1 transition ${path.startsWith("/dashboard") ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`} href="/dashboard">Dashboard</Link>
          <Link aria-current={path.startsWith("/whatsapp") ? "page" : undefined} className={`rounded-full px-3 py-1 transition ${path.startsWith("/whatsapp") ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`} href="/whatsapp">WhatsApp</Link>
          {staffAccess(workspace.role, workspace.staffRole).permissions.length > 0 && (
            <Link aria-current={path.startsWith("/staff") ? "page" : undefined} className={`rounded-full px-3 py-1 transition ${path.startsWith("/staff") ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`} href="/staff">Staff</Link>
          )}
          {!!me.employments?.length && (
            <Link className="rounded-full px-3 py-1 text-muted transition hover:text-text" href="/portal">My work</Link>
          )}
          <Link aria-current={path.startsWith("/settings") ? "page" : undefined} className={`rounded-full px-3 py-1 transition ${path.startsWith("/settings") ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`} href="/settings/profile">Settings</Link>
          <button className="text-muted transition hover:text-text" onClick={logout}>Sign out</button>
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
