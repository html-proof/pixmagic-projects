"use client";
import { Lock } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BREAK_KIND_LABEL, BREAK_KINDS, localDayOf, shiftDay, startOfWeek, type BreakKind } from "@app/shared/staff";
import { Badge, Empty } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { ApprovalBadge, Field, Flags, Modal, Pagination, Table, Tabs, Td, Th } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { PageHeader, Skeleton, useAction, useToast } from "@/components/AppUi";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDateTime, fmtDay, fmtHours, fmtTime, fromLocalInput, toLocalInput, useStaff, type EmployeeRow, type SessionRow, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Timesheets: every shift in a date range, approving, rejecting and correcting hours, setting a
// forgotten clock-out, adding a missed shift, and employees' change requests. Times are shown and
// entered in the organization's time zone.
// ---------------------------------------------------------------------------------------------

type Tab = "shifts" | "requests";
type StatusFilter = "" | "pending" | "approved" | "rejected" | "open" | "needs_review";

const STATUS_FILTERS: ReadonlyArray<readonly [StatusFilter, string]> = [
  ["", "Any status"],
  ["pending", "Waiting for review"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["open", "Still clocked in"],
  ["needs_review", "Needs attention"],
];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZE = 50;
const LOCKED_HELP = "These hours are in approved payroll, so they can't be changed. Add an adjustment to the next payroll instead.";

interface TimesheetList {
  timezone: string;
  total: number;
  page: number;
  pageSize: number;
  pendingCorrections: number;
  items: SessionRow[];
}

interface Snapshot {
  clockInAt: string;
  clockOutAt: string | null;
  breaks: Array<{ startAt: string; endAt: string | null; kind: string }>;
}

type SessionDetail = Omit<SessionRow, "employee"> & {
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

interface ChangeRequest {
  id: string;
  employee: { id: string; fullName: string; jobTitle: string };
  session: { id: string; clockInAt: string; clockOutAt: string | null } | null;
  byEmployee: boolean;
  proposedClockInAt: string | null;
  proposedClockOutAt: string | null;
  reason: string;
  status: string;
  decisionNote: string | null;
  createdAt: string;
}

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
const SOURCE_LABEL: Record<string, string> = { web: "Web", mobile: "Phone", admin: "Manager", system: "Insights", employee: "Employee" };
const REQUEST_STATUS: Record<string, { tone: "warn" | "good" | "danger" | "neutral"; label: string }> = {
  pending: { tone: "warn", label: "Waiting for review" },
  approved: { tone: "good", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};
const APPROVAL_ACTION: Record<string, string> = { approved: "Approved", rejected: "Rejected", reopened: "Reopened for review" };

/** "Tue 14 Oct, 9:00 AM – 5:30 PM" (the end gets its own date when it falls on another day). */
function fmtRange(start: string | null, end: string | null, tz: string, openText = "still clocked in") {
  if (!start) return "—";
  if (!end) return `${fmtDateTime(start, tz)} – ${openText}`;
  const sameDay = localDayOf(Date.parse(start), tz) === localDayOf(Date.parse(end), tz);
  return `${fmtDateTime(start, tz)} – ${sameDay ? fmtTime(end, tz) : fmtDateTime(end, tz)}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export default function TimesheetsPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Timesheets />
    </Suspense>
  );
}

function Timesheets() {
  const sp = useSearchParams();
  const { base, can } = useStaff();
  const config = useApi<StaffConfig>(`${base}/config`);
  const [tab, setTab] = useState<Tab>(sp.get("tab") === "requests" ? "requests" : "shifts");
  const [pending, setPending] = useState<number | null>(null);
  // Bumped when a change request is decided, so the shift list shows the new times.
  const [bump, setBump] = useState(0);

  const header = (
    <PageHeader
      title="Timesheets"
      sub="Check, correct and approve the hours your team worked. Approved hours go into payroll."
    />
  );
  if (config.error && !config.data) {
    return (
      <>
        {header}
        <LoadError what="your staff settings" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />
      </>
    );
  }
  if (!config.data) {
    return (
      <>
        {header}
        <Skeleton lines={6} />
      </>
    );
  }
  const tz = config.data.settings.timezone;
  return (
    <>
      {header}
      <Tabs<Tab>
        label="Timesheets"
        value={tab}
        onChange={setTab}
        tabs={[
          ["shifts", "Shifts"],
          ["requests", pending ? `Change requests (${pending})` : "Change requests"],
        ]}
      />
      <div hidden={tab !== "shifts"}>
        <Shifts
          base={base}
          tz={tz}
          config={config.data}
          manage={can("attendance:manage")}
          initial={{ employeeId: sp.get("employeeId"), status: sp.get("status"), from: sp.get("from"), to: sp.get("to") }}
          onPending={setPending}
          bump={bump}
        />
      </div>
      <div hidden={tab !== "requests"}>
        <Requests base={base} tz={tz} manage={can("attendance:manage")} onPending={setPending} onChanged={() => setBump((b) => b + 1)} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------------------------

type Dialog = { kind: "reject"; session: SessionRow } | { kind: "correct"; session: SessionRow } | { kind: "add" } | null;

function Shifts({
  base,
  tz: orgTz,
  config,
  manage,
  initial,
  onPending,
  bump,
}: {
  base: string;
  tz: string;
  config: StaffConfig;
  manage: boolean;
  initial: { employeeId: string | null; status: string | null; from: string | null; to: string | null };
  onPending: (n: number) => void;
  bump: number;
}) {
  const id = useId();
  const toast = useToast();
  const { busy, run } = useAction();
  const employees = useApi<{ items: EmployeeRow[] }>(`${base}/employees?pageSize=200&status=all&sort=name`);

  const [filters, setFilters] = useState(() => {
    const today = localDayOf(Date.now(), orgTz);
    const weekFrom = startOfWeek(today, config.settings.weekStartsOn);
    const from = initial.from && DAY_RE.test(initial.from) ? initial.from : weekFrom;
    const to = initial.to && DAY_RE.test(initial.to) ? initial.to : shiftDay(weekFrom, 6);
    const status = STATUS_FILTERS.some(([v]) => v && v === initial.status) ? (initial.status as StatusFilter) : "";
    return { from, to: to < from ? from : to, employeeId: initial.employeeId ?? "", departmentId: "", status };
  });
  const [page, setPage] = useState(1);
  const set = (patch: Partial<typeof filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const rangeBad = !filters.from || !filters.to || filters.from > filters.to;
  const qs = new URLSearchParams({ from: filters.from, to: filters.to, page: String(page), pageSize: String(PAGE_SIZE) });
  if (filters.employeeId) qs.set("employeeId", filters.employeeId);
  if (filters.departmentId) qs.set("departmentId", filters.departmentId);
  if (filters.status) qs.set("status", filters.status);
  const path = rangeBad ? null : `${base}/timesheets?${qs.toString()}`;
  const list = useApi<TimesheetList>(path);

  // Keep the last list on screen while the next page or filter loads, instead of flashing empty.
  const [shown, setShown] = useState<TimesheetList | null>(null);
  useEffect(() => {
    if (list.data) setShown(list.data);
  }, [list.data]);
  useEffect(() => {
    if (list.data) onPending(list.data.pendingCorrections);
  }, [list.data, onPending]);
  const { reload: reloadList } = list;
  const lastBump = useRef(bump);
  useEffect(() => {
    if (bump === lastBump.current) return;
    lastBump.current = bump;
    void reloadList();
  }, [bump, reloadList]);

  const tz = shown?.timezone ?? orgTz;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [path]);

  const [dialog, setDialog] = useState<Dialog>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const [detailId, setDetailId] = useState<string | null>(null);
  const closeDetail = useCallback(() => setDetailId(null), []);
  const detail = useApi<{ session: SessionDetail }>(detailId ? `${base}/timesheets/${encodeURIComponent(detailId)}` : null);

  // Reload what is on screen when an action finishes, not what was on screen when it started: the
  // filters may have changed meanwhile, and the new view was then fetched before the change landed.
  const latest = useRef({ list, detail, detailId });
  latest.current = { list, detail, detailId };
  const refresh = useCallback(() => {
    const { list: l, detail: d, detailId: open } = latest.current;
    void l.reload();
    if (open) void d.reload();
  }, []);

  const selectable = (s: SessionRow) => manage && !s.open && !s.locked && s.approvalStatus !== "approved";
  const rows = shown?.items ?? [];
  const pageSelectable = rows.filter(selectable);
  const allChecked = pageSelectable.length > 0 && pageSelectable.every((s) => selected.has(s.id));
  // Only what can still be approved counts (a shift approved one by one since it was ticked doesn't).
  const selectedIds = pageSelectable.filter((s) => selected.has(s.id)).map((s) => s.id);
  const toggle = (sid: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(pageSelectable.map((s) => s.id)));

  const approveSelected = () =>
    run("bulk", "approve the hours", async () => {
      const ids = selectedIds;
      const r = await api<{ approved: number }>(`${base}/timesheets/approve`, { method: "POST", body: { sessionIds: ids } });
      setSelected(new Set());
      refresh();
      return r.approved ? `${plural(r.approved, "shift", "shifts")} approved.` : "Those shifts were already approved.";
    });
  const approveOne = (s: SessionRow) =>
    run(`approve:${s.id}`, "approve the hours", async () => {
      await api(`${base}/timesheets/${encodeURIComponent(s.id)}/approve`, { method: "POST" });
      refresh();
      return `Approved ${s.employee ? `${s.employee.fullName}'s` : "the"} shift${s.day ? ` on ${fmtDay(s.day, { weekday: true, year: false })}` : ""}.`;
    });
  const reopen = (s: SessionRow) =>
    run(`reopen:${s.id}`, "reopen the shift", async () => {
      await api(`${base}/timesheets/${encodeURIComponent(s.id)}/reopen`, { method: "POST" });
      refresh();
      return "The shift is back to waiting for review.";
    });

  const actions = (s: SessionRow) => (
    <ShiftActions
      s={s}
      manage={manage}
      busy={busy}
      onApprove={() => void approveOne(s)}
      onReject={() => setDialog({ kind: "reject", session: s })}
      onCorrect={() => setDialog({ kind: "correct", session: s })}
      onReopen={() => void reopen(s)}
    />
  );

  const empList = employees.data?.items ?? [];
  const filtered = !!(filters.employeeId || filters.departmentId || filters.status);

  return (
    <div className="mt-4 space-y-4">
      <section className="card animate-rise" aria-labelledby={`${id}-h`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id={`${id}-h`} className="font-semibold">
            Shifts
          </h2>
          {manage && (
            <button type="button" className="btn-secondary" onClick={() => setDialog({ kind: "add" })}>
              Add missing shift
            </button>
          )}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Filter shifts">
          <label className="min-w-0">
            <span className="label text-xs text-muted">From</span>
            <input type="date" className="input" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">To</span>
            <input type="date" className="input" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">Employee</span>
            <select className="input" value={filters.employeeId} onChange={(e) => set({ employeeId: e.target.value })}>
              <option value="">Everyone</option>
              {filters.employeeId && !empList.some((e) => e.id === filters.employeeId) && <option value={filters.employeeId}>{employees.loading ? "Loading…" : "Selected employee"}</option>}
              {empList.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                  {e.status === "inactive" ? " (deactivated)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">Department</span>
            <select className="input" value={filters.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
              <option value="">All departments</option>
              {config.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="label text-xs text-muted">Status</span>
            <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
              {STATUS_FILTERS.map(([v, l]) => (
                <option key={v || "any"} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        {rangeBad && <p className="mt-2 text-xs text-danger">Choose a start date on or before the end date.</p>}
        {employees.error && !employees.data && <p className="mt-2 text-xs text-muted">The employee list couldn&apos;t be loaded, so you can&apos;t filter by employee right now.</p>}

        {manage && selectedIds.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2" role="region" aria-label="Selected shifts">
            <span className="text-sm">{plural(selectedIds.length, "shift selected", "shifts selected")}</span>
            <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void approveSelected()}>
              {busy === "bulk" ? "Approving…" : "Approve selected"}
            </button>
            <button type="button" className="text-sm text-muted underline-offset-2 hover:underline" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        )}

        <div className="mt-4">
          {list.error && !list.data ? (
            <LoadError what="the timesheets" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
          ) : rangeBad ? null : !shown ? (
            <Skeleton lines={5} />
          ) : !rows.length ? (
            filtered ? (
              <Empty>No shifts match these filters in this date range.</Empty>
            ) : (
              <EmptyState title="No shifts in these dates" body="When employees clock in and out, their shifts appear here for you to check and approve. Try a different date range." />
            )
          ) : (
            <div className={list.loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={list.loading}>
              <Table label="Shifts">
                <thead>
                  <tr>
                    <Th className="w-8">
                      {manage && pageSelectable.length > 0 && (
                        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={allChecked} onChange={toggleAll} aria-label="Select all shifts on this page that can be approved" />
                      )}
                    </Th>
                    <Th>Employee</Th>
                    <Th>Day</Th>
                    <Th>Clock in</Th>
                    <Th>Clock out</Th>
                    <Th right>Breaks (unpaid)</Th>
                    <Th right>Worked</Th>
                    <Th>Flags</Th>
                    <Th>Status</Th>
                    {manage && <Th>Actions</Th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const nextDay = s.clockOutAt && localDayOf(Date.parse(s.clockOutAt), tz) !== localDayOf(Date.parse(s.clockInAt), tz);
                    return (
                      <tr key={s.id} className="cursor-pointer hover:bg-bg/60" onClick={() => setDetailId(s.id)}>
                        <Td>
                          {selectable(s) && (
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--accent)]"
                              checked={selected.has(s.id)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggle(s.id)}
                              aria-label={`Select ${s.employee?.fullName ?? "this"} shift on ${fmtDay(s.day ?? null)}`}
                            />
                          )}
                        </Td>
                        <Td>
                          <button
                            type="button"
                            className="text-left font-medium hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetailId(s.id);
                            }}
                          >
                            {s.employee?.fullName ?? "Employee"}
                            <span className="sr-only">: view shift details</span>
                          </button>
                          {s.employee?.jobTitle && <p className="text-xs text-muted">{s.employee.jobTitle}</p>}
                        </Td>
                        <Td className="whitespace-nowrap">{fmtDay(s.day ?? localDayOf(Date.parse(s.clockInAt), tz), { weekday: true, year: false })}</Td>
                        <Td className="whitespace-nowrap">{fmtTime(s.clockInAt, tz)}</Td>
                        <Td className="whitespace-nowrap">
                          {s.open ? <span className="text-warn">Still clocked in</span> : fmtTime(s.clockOutAt, tz)}
                          {nextDay && <p className="text-[11px] text-muted">next day</p>}
                        </Td>
                        <Td right className="whitespace-nowrap">
                          {s.unpaidBreakSeconds > 0 ? fmtHours(s.unpaidBreakSeconds) : "—"}
                          {s.breaks.length > 0 && <p className="text-[11px] text-muted">{plural(s.breaks.length, "break", "breaks")}</p>}
                        </Td>
                        <Td right className="whitespace-nowrap">
                          {fmtHours(s.workedSeconds)}
                        </Td>
                        <Td>
                          <span className="flex flex-col items-start gap-1">
                            <Flags flags={s.flags} />
                            {s.pendingCorrection && <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11px] text-warn">Change requested</span>}
                          </span>
                        </Td>
                        <Td>
                          <span className="flex flex-col items-start gap-1">
                            {s.open ? <Badge tone="warn">Still clocked in</Badge> : <ApprovalBadge status={s.approvalStatus} />}
                            {s.locked && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-muted" title={LOCKED_HELP}>
                                <Lock aria-hidden size={12} /> In approved payroll
                              </span>
                            )}
                            {s.approvalStatus === "rejected" && s.rejectedReason && <span className="max-w-[14rem] text-[11px] text-muted">“{s.rejectedReason}”</span>}
                          </span>
                        </Td>
                        {manage && (
                          <Td>
                            <span onClick={(e) => e.stopPropagation()} className="block">
                              {actions(s)}
                            </span>
                          </Td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <Pagination page={shown.page} pageSize={shown.pageSize} total={shown.total} onPage={setPage} />
            </div>
          )}
        </div>
      </section>

      {/* Hidden (not closed) while one of its actions has a dialog open: one dialog at a time. */}
      {detailId && !dialog && (
        <Modal open title="Shift details" onClose={closeDetail} wide>
          {detail.error && !detail.data ? (
            <LoadError what="this shift" error={detail.error} onRetry={() => void detail.reload()} busy={detail.loading} />
          ) : !detail.data ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading">
              <div className="skeleton h-6 w-1/2" />
              <div className="skeleton h-16" />
              <div className="skeleton h-24" />
            </div>
          ) : (
            <ShiftDetail s={detail.data.session} tz={tz} actions={manage ? actions(detail.data.session as unknown as SessionRow) : null} />
          )}
        </Modal>
      )}

      {dialog?.kind === "reject" && (
        <RejectModal
          session={dialog.session}
          tz={tz}
          base={base}
          onClose={closeDialog}
          onDone={(msg) => {
            toast("success", msg);
            setDialog(null);
            refresh();
          }}
        />
      )}
      {(dialog?.kind === "correct" || dialog?.kind === "add") && (
        <TimesModal
          mode={dialog.kind === "correct" ? { kind: "correct", session: dialog.session } : { kind: "add" }}
          tz={tz}
          base={base}
          employees={empList}
          defaultEmployeeId={filters.employeeId}
          onClose={closeDialog}
          onDone={(msg) => {
            toast("success", msg);
            setDialog(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** What a manager can do with one shift right now. */
function ShiftActions({
  s,
  manage,
  busy,
  onApprove,
  onReject,
  onCorrect,
  onReopen,
}: {
  s: Pick<SessionRow, "id" | "open" | "locked" | "approvalStatus">;
  manage: boolean;
  busy: string | null;
  onApprove: () => void;
  onReject: () => void;
  onCorrect: () => void;
  onReopen: () => void;
}) {
  if (!manage) return null;
  if (s.locked) {
    return (
      <span className="inline-flex max-w-[12rem] items-start gap-1 text-xs text-muted">
        <Lock aria-hidden size={12} className="mt-0.5 shrink-0" />
        Locked: {LOCKED_HELP}
      </span>
    );
  }
  const link = "text-sm text-accent underline-offset-2 hover:underline disabled:opacity-50";
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {!s.open && s.approvalStatus !== "approved" && (
        <button type="button" className={link} disabled={busy !== null} onClick={onApprove}>
          {busy === `approve:${s.id}` ? "Approving…" : "Approve"}
        </button>
      )}
      {!s.open && s.approvalStatus === "pending" && (
        <button type="button" className={link} disabled={busy !== null} onClick={onReject}>
          Reject
        </button>
      )}
      <button type="button" className={link} disabled={busy !== null} onClick={onCorrect}>
        Correct
      </button>
      {!s.open && s.approvalStatus !== "pending" && (
        <button type="button" className={link} disabled={busy !== null} onClick={onReopen}>
          {busy === `reopen:${s.id}` ? "Reopening…" : "Reopen"}
        </button>
      )}
    </span>
  );
}

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
function ShiftDetail({ s, tz, actions }: { s: SessionDetail; tz: string; actions: ReactNode }) {
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

// ---------------------------------------------------------------------------------------------
// Reject, correct, add
// ---------------------------------------------------------------------------------------------

function RejectModal({ session, tz, base, onClose, onDone }: { session: SessionRow; tz: string; base: string; onClose: () => void; onDone: (msg: string) => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const r = reason.trim();
    if (r.length < 3) return setError("Say why the hours are rejected, so the employee knows what to fix.");
    setError(null);
    setBusy(true);
    setProblem(null);
    try {
      await api(`${base}/timesheets/${encodeURIComponent(session.id)}/reject`, { method: "POST", body: { reason: r } });
      onDone("Hours rejected.");
    } catch (err) {
      setProblem(actionError(err, "reject the hours"));
      setBusy(false);
    }
  };
  return (
    <Modal open title="Reject hours" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        <p className="text-sm text-muted">
          {session.employee?.fullName ?? "This employee"}, {fmtRange(session.clockInAt, session.clockOutAt, tz)}. Rejected hours aren&apos;t paid.
        </p>
        <Field label="Reason" htmlFor={`${id}-r`} error={error} required hint="The employee can see this.">
          <textarea id={`${id}-r`} className="input min-h-[5rem]" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {problem && <Alert>{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-danger" disabled={busy}>
            {busy ? "Rejecting…" : "Reject hours"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface BreakDraft {
  key: number;
  kind: BreakKind;
  start: string;
  end: string;
}

let breakSeq = 0;

function TimesModal({
  mode,
  tz,
  base,
  employees,
  defaultEmployeeId,
  onClose,
  onDone,
}: {
  mode: { kind: "correct"; session: SessionRow } | { kind: "add" };
  tz: string;
  base: string;
  employees: EmployeeRow[];
  defaultEmployeeId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const id = useId();
  const session = mode.kind === "correct" ? mode.session : null;
  const wasOpen = !!session?.open;
  const [employeeId, setEmployeeId] = useState(() => (session ? session.employeeId : employees.some((e) => e.id === defaultEmployeeId && e.status !== "inactive") ? defaultEmployeeId : ""));
  const [clockIn, setClockIn] = useState(() => (session ? toLocalInput(session.clockInAt, tz) : ""));
  const [clockOut, setClockOut] = useState(() => (session ? toLocalInput(session.clockOutAt, tz) : ""));
  const [breaks, setBreaks] = useState<BreakDraft[]>(() =>
    (session?.breaks ?? []).map((b) => ({ key: ++breakSeq, kind: (BREAK_KINDS as readonly string[]).includes(b.kind) ? b.kind : "rest", start: toLocalInput(b.startAt, tz), end: toLocalInput(b.endAt, tz) })),
  );
  const [breaksTouched, setBreaksTouched] = useState(false);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editBreak = (key: number, patch: Partial<BreakDraft>) => {
    setBreaksTouched(true);
    setBreaks((bs) => bs.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  };
  const addBreak = () => {
    setBreaksTouched(true);
    setBreaks((bs) => [...bs, { key: ++breakSeq, kind: "rest", start: "", end: "" }]);
  };
  const removeBreak = (key: number) => {
    setBreaksTouched(true);
    setBreaks((bs) => bs.filter((b) => b.key !== key));
  };

  const activeEmployees = useMemo(() => employees.filter((e) => e.status !== "inactive"), [employees]);

  function validate() {
    const e: Record<string, string> = {};
    const now = Date.now() + 5 * 60_000;
    if (!session && !employeeId) e.employee = "Choose who worked this shift.";
    const inIso = clockIn ? fromLocalInput(clockIn, tz) : null;
    const outIso = clockOut ? fromLocalInput(clockOut, tz) : null;
    if (!inIso) e.clockIn = "Enter when the shift started.";
    else if (Date.parse(inIso) > now) e.clockIn = "The start time can't be in the future.";
    if (!clockOut) {
      if (!wasOpen) e.clockOut = "Enter when the shift ended.";
    } else if (!outIso) e.clockOut = "Enter when the shift ended.";
    else if (Date.parse(outIso) > now) e.clockOut = "The end time can't be in the future.";
    else if (inIso && Date.parse(outIso) <= Date.parse(inIso)) e.clockOut = "The shift has to end after it starts.";
    else if (inIso && Date.parse(outIso) - Date.parse(inIso) > 24 * 3_600_000) e.clockOut = "A shift can't be longer than 24 hours. Split it into two shifts.";
    const sendBreaks = session ? breaksTouched : breaks.length > 0;
    const out: Array<{ startAt: string; endAt: string; kind: BreakKind }> = [];
    if (sendBreaks) {
      const shiftEnd = outIso ? Date.parse(outIso) : Date.now();
      for (const b of breaks) {
        const s = b.start ? fromLocalInput(b.start, tz) : null;
        const en = b.end ? fromLocalInput(b.end, tz) : null;
        if (!s || !en) {
          e[`break-${b.key}`] = "Enter when this break started and ended.";
          continue;
        }
        if (Date.parse(en) <= Date.parse(s)) e[`break-${b.key}`] = "The break has to end after it starts.";
        else if ((inIso && Date.parse(s) < Date.parse(inIso)) || Date.parse(en) > shiftEnd) e[`break-${b.key}`] = "The break has to fall inside the shift.";
        out.push({ startAt: s, endAt: en, kind: b.kind });
      }
      out.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
      for (let i = 1; i < out.length; i++) {
        if (Date.parse(out[i]!.startAt) < Date.parse(out[i - 1]!.endAt)) e.breaks = "Breaks can't overlap each other.";
      }
    }
    const n = note.trim();
    if (n.length < 3) e.note = "Say why the times are being changed (at least a few words).";
    else if (n.length > 500) e.note = "Keep the note under 500 characters.";
    return { errors: e, body: { clockInAt: inIso, clockOutAt: outIso, ...(sendBreaks ? { breaks: out } : {}), note: n } };
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const { errors: e, body } = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setProblem(null);
    try {
      if (session) {
        await api(`${base}/timesheets/${encodeURIComponent(session.id)}/corrections`, { method: "POST", body });
        onDone(body.clockOutAt ? (wasOpen ? "Clock-out set. The shift is approved." : "Times corrected. The shift is approved.") : "Times corrected. The shift is still running.");
      } else {
        await api(`${base}/employees/${encodeURIComponent(employeeId)}/shifts`, { method: "POST", body });
        onDone("Shift added and approved.");
      }
    } catch (err) {
      setProblem(actionError(err, "save the times"));
      setBusy(false);
    }
  };

  const title = session ? (wasOpen ? "Correct shift or set clock-out" : "Correct shift") : "Add missing shift";
  return (
    <Modal open title={title} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={submit} noValidate>
        {session ? (
          <p className="text-sm text-muted">
            {session.employee?.fullName ?? "Employee"} · recorded {fmtRange(session.clockInAt, session.clockOutAt, tz)}.{" "}
            {wasOpen ? "This shift was never clocked out: enter when it really ended." : "Saving applies the new times and approves the shift."} The old times stay in the shift&apos;s history.
          </p>
        ) : (
          <p className="text-sm text-muted">For a shift someone worked but never clocked. It&apos;s added as approved, with your note in its history.</p>
        )}
        <p className="text-xs text-muted">Times are in {tz.replace(/_/g, " ")}.</p>

        {!session && (
          <Field label="Employee" htmlFor={`${id}-emp`} error={errors.employee} required>
            <select id={`${id}-emp`} className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Choose an employee…</option>
              {activeEmployees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName} ({e.employeeNumber})
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Clock in" htmlFor={`${id}-in`} error={errors.clockIn} required>
            <input id={`${id}-in`} type="datetime-local" className="input" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
          </Field>
          <Field label="Clock out" htmlFor={`${id}-out`} error={errors.clockOut} required={!wasOpen} hint={wasOpen ? "Leave empty to keep the shift running." : undefined}>
            <input id={`${id}-out`} type="datetime-local" className="input" value={clockOut} min={clockIn || undefined} onChange={(e) => setClockOut(e.target.value)} />
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="label">Breaks</legend>
          {session && !breaksTouched && <p className="text-xs text-muted">Leave the breaks as they are, or change them below. A break still running ends with the shift.</p>}
          {!breaks.length && <p className="text-xs text-muted">No breaks.</p>}
          {breaks.map((b, i) => (
            <div key={b.key} className="rounded-lg border border-border p-2">
              <div className="grid gap-2 sm:grid-cols-[9rem_1fr_1fr_auto] sm:items-end">
                <label className="min-w-0">
                  <span className="text-xs text-muted">Break {i + 1}</span>
                  <select className="input" value={b.kind} onChange={(e) => editBreak(b.key, { kind: e.target.value as BreakKind })}>
                    {BREAK_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {BREAK_KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="text-xs text-muted">Started</span>
                  <input type="datetime-local" className="input" value={b.start} onChange={(e) => editBreak(b.key, { start: e.target.value })} />
                </label>
                <label className="min-w-0">
                  <span className="text-xs text-muted">Ended</span>
                  <input type="datetime-local" className="input" value={b.end} min={b.start || undefined} onChange={(e) => editBreak(b.key, { end: e.target.value })} />
                </label>
                <button type="button" className="btn-secondary px-3" onClick={() => removeBreak(b.key)}>
                  Remove<span className="sr-only"> break {i + 1}</span>
                </button>
              </div>
              {errors[`break-${b.key}`] && <p className="mt-1 text-xs text-danger">{errors[`break-${b.key}`]}</p>}
            </div>
          ))}
          {errors.breaks && <p className="text-xs text-danger">{errors.breaks}</p>}
          <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={addBreak}>
            Add a break
          </button>
        </fieldset>

        <Field label="Note" htmlFor={`${id}-note`} error={errors.note} required hint="Why the times are changing. Kept in the shift's history.">
          <textarea id={`${id}-note`} className="input min-h-[4.5rem]" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {problem && <Alert>{problem}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : session ? "Save times" : "Add shift"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Change requests from employees
// ---------------------------------------------------------------------------------------------

function Requests({ base, tz, manage, onPending, onChanged }: { base: string; tz: string; manage: boolean; onPending: (n: number) => void; onChanged: () => void }) {
  const id = useId();
  const toast = useToast();
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const list = useApi<{ items: ChangeRequest[] }>(`${base}/corrections?status=${status}`);
  const [decide, setDecide] = useState<{ req: ChangeRequest; approve: boolean } | null>(null);
  const close = useCallback(() => setDecide(null), []);
  useEffect(() => {
    if (list.data && status === "pending") onPending(list.data.items.length);
  }, [list.data, status, onPending]);

  const items = list.data?.items ?? [];
  return (
    <section className="card animate-rise mt-4" aria-labelledby={`${id}-h`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-h`} className="font-semibold">
            Change requests
          </h2>
          <p className="mt-0.5 text-xs text-muted">Employees ask here when they forgot to clock in or out, or a time is wrong. Approving applies the new times.</p>
        </div>
        <label className="min-w-[10rem]">
          <span className="sr-only">Show</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as "pending" | "all")}>
            <option value="pending">Waiting for review</option>
            <option value="all">All requests</option>
          </select>
        </label>
      </div>
      <div className="mt-4">
        {list.error && !list.data ? (
          <LoadError what="the change requests" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
        ) : !list.data ? (
          <Skeleton lines={3} />
        ) : !items.length ? (
          <Empty>{status === "pending" ? "No change requests are waiting. You're all caught up." : "No change requests yet."}</Empty>
        ) : (
          <ul className="space-y-3">
            {items.map((r) => (
              <li key={r.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{r.employee.fullName}</p>
                    <p className="text-xs text-muted">
                      {r.employee.jobTitle ? `${r.employee.jobTitle} · ` : ""}
                      {r.byEmployee ? "Asked" : "Changed by a manager"} {fmtDateTime(r.createdAt, tz)}
                    </p>
                  </div>
                  <Badge tone={REQUEST_STATUS[r.status]?.tone ?? "neutral"}>{REQUEST_STATUS[r.status]?.label ?? r.status}</Badge>
                </div>
                <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-lg bg-bg px-3 py-2">
                    <dt className="text-xs text-muted">Recorded</dt>
                    <dd>{r.session ? fmtRange(r.session.clockInAt, r.session.clockOutAt, tz) : "No shift recorded (asking to add one)"}</dd>
                  </div>
                  <div className="rounded-lg bg-bg px-3 py-2">
                    <dt className="text-xs text-muted">Asking for</dt>
                    <dd className="font-medium">{fmtRange(r.proposedClockInAt, r.proposedClockOutAt, tz, "no end time")}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-sm">
                  <span className="text-muted">Reason: </span>
                  {r.reason}
                </p>
                {r.decisionNote && <p className="mt-1 text-xs text-muted">Reply: “{r.decisionNote}”</p>}
                {manage && r.status === "pending" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className="btn-primary" onClick={() => setDecide({ req: r, approve: true })}>
                      Approve
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setDecide({ req: r, approve: false })}>
                      Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {decide && (
        <DecideModal
          base={base}
          req={decide.req}
          approve={decide.approve}
          tz={tz}
          onClose={close}
          onDone={(msg) => {
            toast("success", msg);
            setDecide(null);
            void list.reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function DecideModal({ base, req, approve, tz, onClose, onDone }: { base: string; req: ChangeRequest; approve: boolean; tz: string; onClose: () => void; onDone: (msg: string) => void }) {
  const id = useId();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = note.trim();
    if (!approve && n.length < 3) return setError("Say why the request is rejected, so the employee knows.");
    if (n.length > 300) return setError("Keep the note under 300 characters.");
    setError(null);
    setBusy(true);
    setProblem(null);
    try {
      await api(`${base}/corrections/${encodeURIComponent(req.id)}/${approve ? "approve" : "reject"}`, { method: "POST", body: { note: n || null } });
      onDone(approve ? `${req.employee.fullName}'s new times are applied.` : "Request rejected.");
    } catch (err) {
      setProblem(actionError(err, approve ? "approve the request" : "reject the request"));
      setBusy(false);
    }
  };
  return (
    <Modal open title={approve ? "Approve change request" : "Reject change request"} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        <p className="text-sm text-muted">
          {req.employee.fullName} asks for {fmtRange(req.proposedClockInAt, req.proposedClockOutAt, tz, "no end time")}.
          {approve ? (req.session ? " The shift's times will be replaced, and it's approved when it has an end time." : " A new approved shift will be added.") : ""}
        </p>
        <Field label={approve ? "Note (optional)" : "Reason"} htmlFor={`${id}-n`} error={error} required={!approve} hint="The employee can see this.">
          <textarea id={`${id}-n`} className="input min-h-[4.5rem]" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {problem && <Alert>{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={approve ? "btn-primary" : "btn-danger"} disabled={busy}>
            {busy ? "Saving…" : approve ? "Approve and apply" : "Reject request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
