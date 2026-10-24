"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me } from "@/components/AppContext";
import { Unreachable } from "@/components/LoadError";
import { PORTAL_WS_KEY, PortalProvider, portalSignOut, type PortalCtx } from "@/components/staff/PortalContext";
import { Alert } from "@/components/ui";
import { BrandLogo, BrandMark } from "@/components/Brand";
import { ToastProvider } from "@/components/AppUi";
import { getMe, isSignedOut, isTransient, keepRetrying, onSessionGone } from "@/lib/api";
import { setReturnTo, signInAndReturn } from "@/lib/returnTo";
import { readLocal, writeLocal } from "@/lib/storage";

/**
 * The employee portal's shell: who is signed in (GET /me), which organization they work for (a
 * switcher when there are several), and the portal's own navigation. Employees aren't workspace
 * members, so this stands apart from the (app) shell; managers who are also employees get a link
 * across.
 */
const NAV: ReadonlyArray<readonly [string, string]> = [
  ["/portal", "Dashboard"],
  ["/portal/timesheets", "Timesheets"],
  ["/portal/pay", "Pay"],
  ["/portal/schedule", "Schedule"],
  ["/portal/account", "Account"],
];

export default function PortalLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname().replace(/\/$/, "") || "/portal";
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<unknown>(null);
  const [wsId, setWsId] = useState<string | null>(null);

  /** One look at /me; resolves true once there is nothing left to retry. Only a 401 means signed out. */
  const loadMe = useCallback(async () => {
    let m: Me;
    try {
      m = await getMe<Me>();
    } catch (e) {
      if (isSignedOut(e)) {
        signInAndReturn(router);
        return true;
      }
      setMeError(e);
      return !isTransient(e);
    }
    setMeError(null);
    if (!m.user.emailVerified) {
      setReturnTo("/portal");
      router.replace("/verify-email");
      return true;
    }
    const list = m.employments ?? [];
    setMe(m);
    setWsId((cur) => {
      if (cur && list.some((e) => e.workspaceId === cur)) return cur;
      const saved = readLocal(PORTAL_WS_KEY);
      return list.some((e) => e.workspaceId === saved) ? saved : (list[0]?.workspaceId ?? null);
    });
    return true;
  }, [router]);

  useEffect(() => void loadMe(), [loadMe]);
  // Any call finding the session gone (account deleted, signed out elsewhere), not just /me.
  useEffect(() => onSessionGone(() => signInAndReturn(router)), [router]);
  const retrying = meError !== null && isTransient(meError);
  useEffect(() => (retrying ? keepRetrying(loadMe) : undefined), [retrying, loadMe]);

  const value = useMemo<PortalCtx | null>(() => {
    const employments = me?.employments ?? [];
    const employment = employments.find((e) => e.workspaceId === wsId);
    if (!me || !employment) return null;
    return {
      me,
      ws: employment.workspaceId,
      employment,
      employments,
      setWs: (id: string) => {
        writeLocal(PORTAL_WS_KEY, id);
        setWsId(id);
      },
    };
  }, [me, wsId]);

  if (!me) {
    if (meError) return <Unreachable error={meError} onRetry={() => void loadMe()} />;
    return <p className="p-8 text-muted">Loading…</p>;
  }

  if (!value) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
        <p className="mb-6">
          <BrandLogo size={24} className="text-[15px] text-text" />
        </p>
        <h1 className="text-2xl font-semibold">Your account isn&apos;t linked to an employer yet</h1>
        <p className="mt-2 text-sm text-muted">
          You&apos;re signed in as {me.user.email}. To see your hours and pay here, open the invitation link your employer emailed you. If it has expired, ask your manager to send a new
          one.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {me.workspaces.length > 0 && (
            <Link className="btn-primary" href="/dashboard">
              Go to your dashboard
            </Link>
          )}
          <button type="button" className="btn-secondary" onClick={() => void portalSignOut(router)}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  const { employment, employments } = value;
  const active = (href: string) => (href === "/portal" ? path === "/portal" : path === href || path.startsWith(`${href}/`));

  return (
    <PortalProvider value={value}>
      <ToastProvider>
        <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur-md">
          <div className="mx-auto max-w-4xl px-4 pt-3">
            <div className="flex items-center gap-3">
              <BrandMark size={36} tile className="shrink-0" />
              <div className="min-w-0 flex-1">
                {employments.length > 1 ? (
                  <select aria-label="Organization" className="input w-full max-w-[16rem] py-1 font-semibold" value={employment.workspaceId} onChange={(e) => value.setWs(e.target.value)}>
                    {employments.map((e) => (
                      <option key={e.workspaceId} value={e.workspaceId}>
                        {e.organization}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="truncate text-sm font-semibold">{employment.organization}</p>
                )}
                <p className="truncate text-xs text-muted">
                  {employment.fullName}
                  {employment.jobTitle ? ` · ${employment.jobTitle}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm">
                {me.workspaces.length > 0 && (
                  <Link href="/dashboard" className="hidden text-muted transition hover:text-text sm:inline">
                    Manager view
                  </Link>
                )}
                <button type="button" className="min-h-10 text-muted transition hover:text-text" onClick={() => void portalSignOut(router)}>
                  Sign out
                </button>
              </div>
            </div>
            <nav aria-label="Employee portal" className="-mx-4 mt-2 flex gap-1 overflow-x-auto px-4 pb-2">
              {NAV.map(([href, label]) => {
                const on = active(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={on ? "page" : undefined}
                    className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm transition ${on ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`}
                  >
                    {label}
                  </Link>
                );
              })}
              {me.workspaces.length > 0 && (
                <Link href="/dashboard" className="whitespace-nowrap rounded-full px-3.5 py-2 text-sm text-muted transition hover:text-text sm:hidden">
                  Manager view
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-4xl space-y-4 px-4 py-5">
          {employment.status === "inactive" && (
            <Alert kind="info">
              Your employee account at {employment.organization} has been deactivated. You can still see your hours and pay history here. Contact your manager if you think
              that&apos;s a mistake.
            </Alert>
          )}
          {/* Keyed by organization: switching starts each page afresh instead of showing the other one's data. */}
          <div key={employment.workspaceId} className="space-y-4">
            {children}
          </div>
        </main>
      </ToastProvider>
    </PortalProvider>
  );
}
