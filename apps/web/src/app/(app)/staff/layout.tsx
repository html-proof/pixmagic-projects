"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { StaffPermission } from "@app/shared/staff";
import { ToastProvider } from "@/components/AppUi";
import { useStaff } from "@/lib/staff";

/** The Staff Management section: Overview through Settings, each shown only to those who may use it. */
const ITEMS: ReadonlyArray<readonly [string, string, StaffPermission]> = [
  ["", "Overview", "staff:view"],
  ["employees", "All employees", "staff:view"],
  ["employees/new", "Add employee", "staff:manage"],
  ["invitations", "Invitations", "staff:view"],
  ["attendance", "Live attendance", "attendance:view"],
  ["timesheets", "Timesheets", "attendance:view"],
  ["schedules", "Shift schedules", "staff:view"],
  ["payroll", "Payroll", "pay:view"],
  ["payments", "Payment history", "pay:view"],
  ["reports", "Reports & analytics", "attendance:view"],
  ["settings", "Settings", "staff:view"],
];

export default function StaffLayout({ children }: { children: ReactNode }) {
  const path = usePathname().replace(/\/$/, "");
  const { can, access } = useStaff();
  if (!access.permissions.length) {
    return (
      <div className="card max-w-xl">
        <h1 className="text-lg font-semibold">Staff Management</h1>
        <p className="mt-1 text-sm text-muted">You don&apos;t have access to Staff Management in this workspace. An owner or admin can give you a staff role in Settings → Members &amp; roles.</p>
      </div>
    );
  }
  const items = ITEMS.filter(([, , perm]) => can(perm));
  const current = (href: string) => (href === "/staff" ? path === "/staff" : path === href || (href !== "/staff/employees" && path.startsWith(`${href}/`)) || (href === "/staff/employees" && (path === "/staff/employees" || path === "/staff/employee")));
  return (
    <ToastProvider>
      <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
        <nav aria-label="Staff Management" className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:pb-0">
          <p className="mb-2 hidden items-center gap-2 px-3 text-sm font-semibold md:flex">
            <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Staff Management
          </p>
          {items.map(([slug, label]) => {
            const href = slug ? `/staff/${slug}` : "/staff";
            const active = current(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm transition ${active ? "bg-surface font-semibold shadow-sm" : "text-muted hover:text-text"}`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 space-y-4">{children}</div>
      </div>
    </ToastProvider>
  );
}
