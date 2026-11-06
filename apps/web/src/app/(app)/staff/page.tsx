"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { shiftDay, type LiveStatus, type PayrollStatus } from "@app/shared/staff";
import { Icon, type IconName } from "@/components/dashboard/Icons";
import { Badge, Stat, type Tone } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { EstimateNote, KpiCard, type KpiData } from "@/components/staff/ui";
import { EmptyState } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { useApi, useLiveApi } from "@/lib/api";
import { fmtSpan, fmtMoney, useStaff } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Staff overview for the owner: this month's figures, who is in right now, what is waiting for
// a decision, and the usual next steps. Everything shown comes from the API.
// ---------------------------------------------------------------------------------------------

interface Analytics {
  asOf: string;
  timezone: string;
  currency: string | null;
  range: { from: string; to: string };
  previous: { from: string; to: string };
  inProgress: boolean;
  kpis: KpiData[];
  notes: string[];
}

interface LiveBoard {
  serverTime: string;
  timezone: string;
  day: string;
  holiday: { name: string } | null;
  kpis: { totalEmployees: number; working: number; onBreak: number; clockedOut: number; scheduledToday: number; absent: number; pendingReview: number; pendingCorrections: number; workedSecondsToday: number };
  rows: Array<{ employee: { id: string; fullName: string; jobTitle: string; department: string | null }; status: LiveStatus; pendingCorrections: number }>;
}

interface Correction {
  id: string;
  employee: { id: string; fullName: string; jobTitle: string };
  session: { id: string; clockInAt: string; clockOutAt: string | null } | null;
  reason: string;
  status: string;
  createdAt: string;
}

interface PeriodSummary {
  id: string;
  startDate: string;
  endDate: string;
  status: PayrollStatus;
  employees: number;
  submittedAt: string | null;
  totals: Record<string, { gross: string; net: string; outstanding: string }>;
}

interface Invitation {
  id: string;
  employee: { id: string; fullName: string; jobTitle: string; email: string };
  sentAt: string;
  expiresAt: string;
  emailFailed: boolean;
  status: "pending" | "expired" | "accepted" | "revoked";
}

/** useLiveApi plus "Try again" (asking a fresh question makes it check now). */
function useLive<T>(path: string | null, ms: number) {
  const [n, setN] = useState(0);
  const live = useLiveApi<T>(path && n ? `${path}${path.includes("?") ? "&" : "?"}_r=${n}` : path, ms);
  return { ...live, retry: () => setN((x) => x + 1) };
}

/** "Asha, Ben and 3 others". */
function names(list: string[]) {
  const unique = [...new Set(list)];
  if (unique.length <= 2) return unique.join(" and ");
  const rest = unique.length - 2;
  return `${unique.slice(0, 2).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Attention {
  key: string;
  tone: Tone;
  title: string;
  detail: string;
  href: string;
  cta: string;
}

export default function StaffOverview() {
  const { base, can } = useStaff();
  const pay = can("pay:view");
  const kpis = useLive<Analytics>(`${base}/analytics?preset=this_month`, 30_000);
  const live = useLive<LiveBoard>(`${base}/attendance/live`, 30_000);
  const people = useApi<{ total: number }>(`${base}/employees?status=all&pageSize=1`);
  const corrections = useApi<{ items: Correction[] }>(`${base}/corrections?status=pending`);
  const payroll = useApi<{ items: PeriodSummary[]; total: number }>(pay ? `${base}/payroll/periods?status=pending_approval` : null);
  const invitations = useApi<{ items: Invitation[] }>(`${base}/invitations?status=open`);
  // Shifts still waiting for approval over the last two months (any day, not only today's).
  const today = live.data?.day ?? null;
  const reviewFrom = today ? shiftDay(today, -62) : null;
  const pendingShifts = useApi<PendingShifts>(today && can("attendance:view") ? `${base}/timesheets?status=pending&from=${reviewFrom}&to=${today}&pageSize=50` : null);

  const k = kpis.data;
  const noStaff = people.data?.total === 0;

  const header = (
    <PageHeader
      title="Staff overview"
      sub={
        k ? (
          <>
            This month so far ({fmtSpan(k.range.from, k.range.to)}) · updated {new Date(k.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            {kpis.failing && " · can't reach bizinsights, showing the last update"}
          </>
        ) : (
          "Your team's hours, attendance and pay at a glance."
        )
      }
    />
  );

  if (noStaff) {
    return (
      <>
        {header}
        {can("staff:manage") ? (
          <EmptyState
            title="Add your first employee"
            body="Add the people who work for you, then invite them to clock in and out from their phone. Their hours, overtime and pay estimates will show up here."
            action={
              <Link href="/staff/employees/new" className="btn-primary mt-1">
                Add your first employee
              </Link>
            }
          />
        ) : (
          <EmptyState title="No employees yet" body="Nobody has been added to Staff Management yet, or none are assigned to you. An owner, admin or HR manager can add them." />
        )}
        {can("staff:manage") && <GettingStarted pay={pay} />}
      </>
    );
  }

  return (
    <>
      {header}

      <LiveStrip live={live} />

      <Attention
        corrections={corrections}
        live={live}
        pendingShifts={pendingShifts}
        reviewRange={today && reviewFrom ? { from: reviewFrom, to: today } : null}
        payroll={pay ? payroll : null}
        invitations={invitations}
        canApprove={can("payroll:approve")}
        canManageStaff={can("staff:manage")}
      />

      <QuickActions can={can} />

      <section aria-labelledby="kpis-h" className="space-y-3">
        <h2 id="kpis-h" className="text-sm font-semibold text-muted">
          This month
        </h2>
        {kpis.error && !k ? (
          <LoadError what="this month's figures" error={kpis.error} onRetry={kpis.retry} busy={kpis.loading} />
        ) : !k ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {k.kpis.map((kpi) => (
                <KpiCard key={kpi.key} kpi={kpi} currency={k.currency} />
              ))}
            </div>
            {k.kpis.some((x) => x.unit === "money" || x.unit === "rate") && <EstimateNote />}
            {k.notes.length > 0 && (
              <ul className="space-y-1 text-xs text-muted">
                {k.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">
              More periods, charts and downloads in{" "}
              <Link href="/staff/reports" className="text-accent hover:underline">
                Reports &amp; analytics
              </Link>
              .
            </p>
          </>
        )}
      </section>
    </>
  );
}

function LiveStrip({ live }: { live: ReturnType<typeof useLive<LiveBoard>> }) {
  const l = live.data;
  return (
    <section className="card animate-rise" aria-labelledby="live-h">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="live-h" className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="relative flex h-2.5 w-2.5">
              <span className="animate-ping-soft absolute inline-flex h-full w-full rounded-full bg-good opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-good" />
            </span>
            Right now
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {l ? (
              <>
                Today, {new Intl.DateTimeFormat(undefined, { timeZone: l.timezone, weekday: "long", day: "numeric", month: "long" }).format(new Date(l.serverTime))}
                {l.holiday && ` · ${l.holiday.name} (public holiday)`} · {plural(l.kpis.scheduledToday, "person", "people")} scheduled
              </>
            ) : (
              "Who's in today. Updates every 30 seconds."
            )}
          </p>
        </div>
        <Link href="/staff/attendance" className="text-sm text-accent hover:underline">
          Open live attendance
        </Link>
      </div>
      <div className="mt-4">
        {live.error && !l ? (
          <LoadError what="live attendance" error={live.error} onRetry={live.retry} busy={live.loading} />
        ) : !l ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true" aria-label="Loading">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-20 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="live-snapshot">
            <Stat label="Working" value={l.kpis.working} tone={l.kpis.working ? "good" : "neutral"} note="clocked in now" />
            <Stat label="On break" value={l.kpis.onBreak} tone={l.kpis.onBreak ? "warn" : "neutral"} note="out on a break" />
            <Stat label="Absent" value={l.kpis.absent} tone={l.kpis.absent ? "danger" : "neutral"} note="scheduled, didn't clock in" />
            <Stat label="Pending review" value={l.kpis.pendingReview} tone={l.kpis.pendingReview ? "warn" : "neutral"} note="shifts that need a look" />
          </div>
        )}
      </div>
    </section>
  );
}

interface PendingShifts {
  total: number;
  items: Array<{ employee?: { fullName: string } }>;
}

function Attention({
  corrections,
  live,
  pendingShifts,
  reviewRange,
  payroll,
  invitations,
  canApprove,
  canManageStaff,
}: {
  corrections: ReturnType<typeof useApi<{ items: Correction[] }>>;
  live: ReturnType<typeof useLive<LiveBoard>>;
  pendingShifts: ReturnType<typeof useApi<PendingShifts>>;
  reviewRange: { from: string; to: string } | null;
  payroll: ReturnType<typeof useApi<{ items: PeriodSummary[]; total: number }>> | null;
  invitations: ReturnType<typeof useApi<{ items: Invitation[] }>>;
  canApprove: boolean;
  canManageStaff: boolean;
}) {
  const items: Attention[] = [];
  const now = Date.now();

  const pendingChanges = corrections.data?.items ?? [];
  if (pendingChanges.length) {
    items.push({
      key: "corrections",
      tone: "warn",
      title: `${plural(pendingChanges.length, "change request", "change requests")} to review`,
      detail: `From ${names(pendingChanges.map((c) => c.employee.fullName))}. Employees asked for their recorded times to be corrected.`,
      href: "/staff/timesheets?tab=requests",
      cta: "Review",
    });
  }

  const waitingShifts = pendingShifts.data?.total ?? 0;
  if (waitingShifts && reviewRange) {
    items.push({
      key: "pending-shifts",
      tone: "warn",
      title: `${plural(waitingShifts, "shift is", "shifts are")} waiting for approval`,
      detail: `From ${names((pendingShifts.data?.items ?? []).map((s) => s.employee?.fullName ?? "an employee"))}. Only approved hours go into payroll.`,
      href: `/staff/timesheets?status=pending&from=${reviewRange.from}&to=${reviewRange.to}`,
      cta: "Review hours",
    });
  }

  const review = (live.data?.rows ?? []).filter((r) => r.status === "pending_review");
  if (review.length) {
    items.push({
      key: "review",
      tone: "warn",
      title: `${plural(review.length, "person's shift needs", "people's shifts need")} a look today`,
      detail: `${names(review.map((r) => r.employee.fullName))}: a forgotten clock-out, a long break or a change request.`,
      href: "/staff/attendance",
      cta: "Open live attendance",
    });
  }

  for (const p of payroll?.data?.items ?? []) {
    const totals = Object.entries(p.totals);
    const money = totals.length ? totals.map(([cur, t]) => fmtMoney(t.net, cur)).join(" + ") : null;
    items.push({
      key: `payroll-${p.id}`,
      tone: "warn",
      title: `Payroll for ${fmtSpan(p.startDate, p.endDate)} is waiting for approval`,
      detail: `${plural(p.employees, "employee", "employees")}${money ? ` · ${money} net (estimated)` : ""}`,
      href: "/staff/payroll",
      cta: canApprove ? "Review and approve" : "Open payroll",
    });
  }

  const open = invitations.data?.items ?? [];
  const expired = open.filter((i) => i.status === "expired" || Date.parse(i.expiresAt) < now);
  const failed = open.filter((i) => i.emailFailed && !expired.includes(i));
  const waiting = open.filter((i) => !expired.includes(i) && !failed.includes(i));
  if (expired.length) {
    items.push({
      key: "inv-expired",
      tone: "danger",
      title: `${plural(expired.length, "invitation has", "invitations have")} expired`,
      detail: `${names(expired.map((i) => i.employee.fullName))} can't set up their account until you send a new invitation.`,
      href: "/staff/invitations",
      cta: canManageStaff ? "Resend" : "View",
    });
  }
  if (failed.length) {
    items.push({
      key: "inv-failed",
      tone: "danger",
      title: `${plural(failed.length, "invitation email", "invitation emails")} couldn't be delivered`,
      detail: `Check the email address for ${names(failed.map((i) => i.employee.fullName))}, or share the invitation link another way.`,
      href: "/staff/invitations",
      cta: "Fix",
    });
  }
  if (waiting.length) {
    items.push({
      key: "inv-waiting",
      tone: "neutral",
      title: `${plural(waiting.length, "invitation is", "invitations are")} waiting to be accepted`,
      detail: `${names(waiting.map((i) => i.employee.fullName))} ${waiting.length === 1 ? "hasn't" : "haven't"} set up their account yet.`,
      href: "/staff/invitations",
      cta: "View",
    });
  }

  const failures: Array<[string, unknown, () => void, boolean]> = [];
  if (corrections.error && !corrections.data) failures.push(["change requests", corrections.error, () => void corrections.reload(), corrections.loading]);
  if (payroll?.error && !payroll.data) failures.push(["payroll waiting for approval", payroll.error, () => void payroll.reload(), payroll.loading]);
  if (invitations.error && !invitations.data) failures.push(["invitations", invitations.error, () => void invitations.reload(), invitations.loading]);
  const loading = (!corrections.data && !corrections.error) || (!!payroll && !payroll.data && !payroll.error) || (!invitations.data && !invitations.error) || (!live.data && !live.error);

  return (
    <section className="card animate-rise" aria-labelledby="attention-h" data-testid="attention">
      <h2 id="attention-h" className="font-semibold">
        Needs your attention
      </h2>
      <div className="mt-3 space-y-3">
        {failures.map(([what, error, retry, busy]) => (
          <LoadError key={what} what={what} error={error} onRetry={retry} busy={busy} />
        ))}
        {items.length > 0 ? (
          <ul className="divide-y divide-border">
            {items.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Badge tone={i.tone}>{i.tone === "danger" ? "Action needed" : i.tone === "warn" ? "To review" : "Waiting"}</Badge>
                    <span className="min-w-0">{i.title}</span>
                  </p>
                  <p className="mt-1 text-xs text-muted">{i.detail}</p>
                </div>
                <Link href={i.href} className="btn-secondary shrink-0 px-3 py-1.5">
                  {i.cta}
                </Link>
              </li>
            ))}
          </ul>
        ) : loading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading">
            <div className="skeleton h-5 w-3/4" />
            <div className="skeleton h-5 w-1/2" />
          </div>
        ) : failures.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Icon name="check" className="text-good" /> Nothing needs your attention right now.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function QuickActions({ can }: { can: ReturnType<typeof useStaff>["can"] }) {
  const actions: Array<{ href: string; label: string; help: string; icon: IconName; show: boolean }> = [
    { href: "/staff/employees/new", label: "Add staff", help: "Create an employee record with their pay and schedule.", icon: "users", show: can("staff:manage") },
    { href: "/staff/employees/new", label: "Invite employee", help: "Add them and email an invitation to set up their account.", icon: "mail", show: can("staff:manage") },
    { href: "/staff/timesheets?status=pending", label: "Review hours", help: "Approve or correct shifts waiting for review.", icon: "clock", show: can("attendance:view") },
    { href: "/staff/payroll", label: "Run payroll", help: "Calculate a pay period and send it for approval.", icon: "receipt", show: can("payroll:manage") },
    { href: "/staff/payments", label: "Record payment", help: "Note what you paid and how.", icon: "coins", show: can("payments:manage") },
  ];
  const shown = actions.filter((a) => a.show);
  if (!shown.length) return null;
  return (
    <nav aria-label="Quick actions" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {shown.map((a) => (
        <Link key={a.label} href={a.href} className="lift group flex min-w-0 items-start gap-3 rounded-lg border border-transparent bg-surface shadow-[var(--shadow)] p-3 transition hover:border-accent">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
            <Icon name={a.icon} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold group-hover:text-accent">{a.label}</span>
            <span className="block text-xs text-muted">{a.help}</span>
          </span>
        </Link>
      ))}
    </nav>
  );
}

function GettingStarted({ pay }: { pay: boolean }) {
  const steps: Array<[string, ReactNode]> = [
    ["Add your employees", "Name, email, position and (if you pay hourly) their pay rate."],
    ["Invite them", "They get an email to set a password, then clock in and out from their phone."],
    ["Plan shifts", <>Optional: add shifts in <Link className="text-accent hover:underline" href="/staff/schedules">Shift schedules</Link> to spot late starts and absences.</>],
    ...(pay ? ([["Run payroll", "Review the hours, approve the pay period, and record what you paid."]] as Array<[string, ReactNode]>) : []),
  ];
  return (
    <section className="card" aria-labelledby="start-h">
      <h2 id="start-h" className="font-semibold">
        How it works
      </h2>
      <ol className="mt-3 grid gap-3 sm:grid-cols-2">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/12 text-sm font-semibold text-accent">{i + 1}</span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{title}</span>
              <span className="block text-xs text-muted">{body}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted">
        Settings for your time zone, pay cycle, overtime and breaks are in{" "}
        <Link className="text-accent hover:underline" href="/staff/settings">
          Settings
        </Link>
        .
      </p>
    </section>
  );
}
