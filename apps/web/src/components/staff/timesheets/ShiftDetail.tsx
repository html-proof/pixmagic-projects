"use client";
/** One shift in full: its times, breaks, changes, approvals and correction requests. */
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { BREAK_KIND_LABEL, type BreakKind } from "@app/shared/staff";
import { ApprovalBadge, Flags, Pill as Badge } from "@/components/staff/ui";
import { fmtDateTime, fmtHours, fmtTime, type SessionRow } from "@/lib/staff";
import { fmtRange, LOCKED_HELP, plural, REQUEST_STATUS } from "@/components/staff/timesheets/format";

interface Snapshot {
  clockInAt: string;
  clockOutAt: string | null;
  breaks: Array<{ startAt: string; endAt: string | null; kind: string }>;
}

export type SessionDetail = Omit<SessionRow, "employee"> & {
  employee: { id: string; fullName: string; jobTitle: string; employeeNumber: string; timezone: string };
  schedule: { id: string; startsAt: string; endsAt: string } | null;
  events: Array<{ id: string; type: string; at: string; clientTime: string | null; source: string; actor: string; before: Snapshot | null; after: Snapshot | null; note: string | null }>;
  corrections: Array<{
    id: string;
    status: string;
    byEmployee: boolean;
    requestedBy: string;
    proposedClockInAt: string | null;
    proposedClockOutAt: string | null;
    reason: string;
    decidedBy: string | null;
    decidedAt: string | null;
    decisionNote: string | null;
    createdAt: string;
  }>;
  approvals: Array<{ id: string; action: string; by: string; note: string | null; at: string }>;
};

const EVENT_LABEL: Record<string, string> = {
  clock_in: "Clocked in",
  clock_out: "Clocked out",
  break_start: "Break started",
  break_end: "Break ended",
  correction: "Times corrected",
  manual_entry: "Shift added by a manager",
  approval: "Hours approved",
  rejection: "Hours rejected",
  reopen: "Sent back for review",
  auto_flag: "Flagged automatically",
  deactivation_close: "Closed when the employee was deactivated",
};
const SOURCE_LABEL: Record<string, string> = { web: "Web", mobile: "Phone", admin: "Manager", system: "bizinsights", employee: "Employee" };

const APPROVAL_ACTION: Record<string, string> = { approved: "Approved", rejected: "Rejected", reopened: "Reopened for review" };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function snapshotText(s: Snapshot | null, tz: string) {
  if (!s) return "—";
  return `${fmtRange(s.clockInAt, s.clockOutAt, tz)}${s.breaks.length ? ` · ${plural(s.breaks.length, "break", "breaks")}` : ""}`;
}

/** The details drawer: times, breaks, the schedule, and every recorded event. */
export function ShiftDetail({ s, tz, actions }: { s: SessionDetail; tz: string; actions: ReactNode }) {
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{s.employee.fullName}</p>
          <p className="text-xs text-muted">
            {s.employee.employeeNumber}
            {s.employee.jobTitle ? ` · ${s.employee.jobTitle}` : ""}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          {s.open ? <Badge tone="warn">Still clocked in</Badge> : <ApprovalBadge status={s.approvalStatus} />}
          {s.locked && (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Lock aria-hidden size={12} /> In approved payroll
            </span>
          )}
        </span>
      </div>
      {s.locked && <p className="mt-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{LOCKED_HELP}</p>}

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Clock in</dt>
          <dd className="font-medium">{fmtDateTime(s.clockInAt, tz)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Clock out</dt>
          <dd className="font-medium">{s.clockOutAt ? fmtDateTime(s.clockOutAt, tz) : "Still clocked in"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Worked</dt>
          <dd className="font-medium tabular-nums">{fmtHours(s.workedSeconds)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Breaks</dt>
          <dd className="font-medium tabular-nums">
            {fmtHours(s.unpaidBreakSeconds)} unpaid
            {s.paidBreakSeconds > 0 && <span className="block text-xs font-normal text-muted">{fmtHours(s.paidBreakSeconds)} paid</span>}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-muted">
        {s.schedule ? `Scheduled: ${fmtRange(s.schedule.startsAt, s.schedule.endsAt, tz)}` : "This shift wasn't on the schedule."}
        {s.revision > 0 ? ` · Changed ${plural(s.revision, "time", "times")}` : ""}
      </p>
      {s.flags.length > 0 && (
        <div className="mt-2">
          <Flags flags={s.flags} />
        </div>
      )}
      {s.note && <p className="mt-2 text-xs">Note: {s.note}</p>}
      {s.approvalStatus === "rejected" && s.rejectedReason && <p className="mt-2 text-xs text-danger">Rejected: {s.rejectedReason}</p>}

      {actions && <div className="mt-4 border-t border-border pt-3">{actions}</div>}

      <Section title="Breaks">
        {s.breaks.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {s.breaks.map((b) => (
              <li key={b.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                <span>{BREAK_KIND_LABEL[b.kind as BreakKind] ?? b.kind}</span>
                <span className="text-muted">
                  {fmtRange(b.startAt, b.endAt, tz, "still on break")} · {b.paid ? "Paid" : "Unpaid"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No breaks recorded.</p>
        )}
      </Section>

      <Section title="History">
        {s.events.length ? (
          <ol className="space-y-3 border-l border-border pl-4">
            {s.events.map((e) => {
              const deviceDiffers = e.clientTime && Math.abs(Date.parse(e.clientTime) - Date.parse(e.at)) > 60_000;
              return (
                <li key={e.id} className="relative">
                  <span aria-hidden className="absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full bg-border" />
                  <p>
                    <span className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</span> <span className="text-muted">· {fmtDateTime(e.at, tz)}</span>
                  </p>
                  <p className="text-xs text-muted">
                    By {e.actor} · {SOURCE_LABEL[e.source] ?? e.source}
                    {e.clientTime && <> · device said {deviceDiffers ? <span className="text-warn">{fmtDateTime(e.clientTime, tz)}</span> : fmtTime(e.clientTime, tz)}</>}
                  </p>
                  {(e.before || e.after) && (
                    <div className="mt-1 grid gap-1 rounded-lg bg-bg px-3 py-2 text-xs">
                      {e.before && (
                        <p>
                          <span className="text-muted">Before: </span>
                          {snapshotText(e.before, tz)}
                        </p>
                      )}
                      {e.after && (
                        <p>
                          <span className="text-muted">{e.before ? "After: " : "Times: "}</span>
                          {snapshotText(e.after, tz)}
                        </p>
                      )}
                    </div>
                  )}
                  {e.note && <p className="mt-1 text-xs">“{e.note}”</p>}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-xs text-muted">Nothing recorded yet.</p>
        )}
      </Section>

      {s.corrections.length > 0 && (
        <Section title="Corrections and change requests">
          <ul className="space-y-2">
            {s.corrections.map((c) => (
              <li key={c.id} className="rounded-lg border border-border px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{c.byEmployee ? `Requested by ${c.requestedBy}` : `Corrected by ${c.requestedBy}`}</span>
                  <Badge tone={REQUEST_STATUS[c.status]?.tone ?? "neutral"}>{REQUEST_STATUS[c.status]?.label ?? c.status}</Badge>
                </div>
                <p className="mt-1 text-xs">New times: {fmtRange(c.proposedClockInAt, c.proposedClockOutAt, tz, "no end time")}</p>
                <p className="text-xs text-muted">Reason: {c.reason}</p>
                {c.decidedBy && (
                  <p className="text-xs text-muted">
                    {c.status === "rejected" ? "Rejected" : "Decided"} by {c.decidedBy}
                    {c.decidedAt ? ` · ${fmtDateTime(c.decidedAt, tz)}` : ""}
                    {c.decisionNote ? ` · “${c.decisionNote}”` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {s.approvals.length > 0 && (
        <Section title="Approvals">
          <ul className="space-y-1 text-xs">
            {s.approvals.map((a) => (
              <li key={a.id}>
                <span className="font-medium">{APPROVAL_ACTION[a.action] ?? a.action}</span> by {a.by} <span className="text-muted">· {fmtDateTime(a.at, tz)}</span>
                {a.note ? <span className="text-muted"> · “{a.note}”</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
