"use client";
// The Stitch design's typeface, as on the signed-in pages (globals.css `app-look`): bundled with the app, nothing preloaded.
import "@fontsource-variable/inter";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Banknote, CalendarDays, Clock, LayoutGrid, UserRound, type LucideIcon } from "lucide-react";
import type { Me } from "@/components/AppContext";
import { Unreachable } from "@/components/LoadError";
import { PORTAL_WS_KEY, PortalProvider, portalSignOut, type PortalCtx } from "@/components/staff/PortalContext";
import { Alert } from "@/components/ui";
import { BrandLogo } from "@/components/Brand";
import { ToastProvider } from "@/components/AppUi";
import { getMe, isSignedOut, isTransient, keepRetrying, onSessionGone } from "@/lib/api";
import { setReturnTo, signInAndReturn } from "@/lib/returnTo";
import { readLocal, writeLocal } from "@/lib/storage";

/**
 * The employee portal's shell: who is signed in (GET /me), which organization they work for (a
 * switcher when there are several), and the portal's own navigation. Employees aren't workspace
 * members, so this stands apart from the (app) shell; managers who are also employees get a link
 * across. Drawn as the Stitch design's screen 29 (the staff page on a phone): the organization and
 * who is signed in at the top, Sign out beside them, and the sections as a bar of icons along the
 * bottom of a phone (a row of tabs under the header on a wider screen).
 */
const NAV: ReadonlyArray<readonly [string, string, LucideIcon]> = [
  ["/portal", "Dashboard", LayoutGrid],
  ["/portal/timesheets", "Timesheets", Clock],
  ["/portal/pay", "Pay", Banknote],
  ["/portal/schedule", "Schedule", CalendarDays],
  ["/portal/account", "Account", UserRound],
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
      <div className="app-look min-h-dvh">
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
      </div>
    );
  }

  const { employment, employments } = value;
  const active = (href: string) => (href === "/portal" ? path === "/portal" : path === href || path.startsWith(`${href}/`));

  return (
    <PortalProvider value={value}>
      <ToastProvider>
        <div className="app-look min-h-dvh">
          <header className="sticky top-0 z-30 bg-surface shadow-[var(--shadow)]">
            <div className="mx-auto max-w-4xl px-4 pt-3 sm:pt-4">
              <div className="flex items-start gap-3 pb-3 sm:pb-2">
                <div className="min-w-0 flex-1">
                  {employments.length > 1 ? (
                    <select aria-label="Organization" className="input w-full max-w-[16rem] py-1 text-xs text-muted" value={employment.workspaceId} onChange={(e) => value.setWs(e.target.value)}>
                      {employments.map((e) => (
                        <option key={e.workspaceId} value={e.workspaceId}>
                          {e.organization}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="truncate text-xs text-muted">{employment.organization} · Staff</p>
                  )}
                  <p className="mt-0.5 truncate text-base font-semibold sm:text-lg">
                    {employment.fullName}
                    {employment.jobTitle ? `, ${employment.jobTitle}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1 text-sm">
                  {me.workspaces.length > 0 && (
                    <Link href="/dashboard" className="inline-flex min-h-10 items-center rounded px-2 text-muted transition hover:text-text">
                      Manager view
                    </Link>
                  )}
                  <button type="button" className="min-h-10 rounded px-2 text-muted transition hover:text-text" onClick={() => void portalSignOut(router)}>
                    Sign out
                  </button>
                </div>
              </div>
              {/* On a phone the same links sit in the bar along the bottom (below), as screen 29 has them. */}
              <nav aria-label="Employee portal" className="-mx-4 hidden overflow-x-auto px-4 sm:block">
                <ul className="flex min-w-max gap-6 text-sm">
                  {NAV.map(([href, label]) => {
                    const on = active(href);
                    return (
                      <li key={href}>
                        <Link
                          href={href}
                          aria-current={on ? "page" : undefined}
                          className={`-mb-px block border-b-2 pt-1 pb-2.5 font-medium whitespace-nowrap outline-none transition-colors focus-visible:text-accent ${on ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"}`}
                        >
                          {label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-4xl space-y-4 px-4 pt-5 pb-28 sm:pb-8">
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
          <nav aria-label="Employee portal" className="fixed inset-x-0 bottom-0 z-30 border-t border-home-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden">
            <ul className="grid grid-cols-5">
              {NAV.map(([href, label, Icon]) => {
                const on = active(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={on ? "page" : undefined}
                      className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium outline-none transition-colors focus-visible:bg-home-soft ${on ? "text-accent" : "text-muted hover:text-text"}`}
                    >
                      <Icon aria-hidden className="h-5 w-5" strokeWidth={on ? 2.25 : 1.75} />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </ToastProvider>
    </PortalProvider>
  );
}
