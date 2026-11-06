"use client";
/** The Shifts tab: filters, the list of shifts, approving, and the dialogs it opens. */
import { Lock, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { localDayOf, shiftDay, startOfWeek } from "@app/shared/staff";
import { Empty } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { ApprovalBadge, Flags, Modal, Pagination, Pill as Badge, Table, Td, Th } from "@/components/staff/ui";
import { EmptyState } from "@/components/ui";
import { Skeleton, useAction, useToast } from "@/components/AppUi";
import { api, useApi } from "@/lib/api";
import { fmtDay, fmtHours, fmtTime, type EmployeeRow, type SessionRow, type StaffConfig, type TimesheetList } from "@/lib/staff";
import { LOCKED_HELP, plural } from "@/components/staff/timesheets/format";
import { type SessionDetail, ShiftDetail } from "@/components/staff/timesheets/ShiftDetail";
import { RejectModal, TimesModal } from "@/components/staff/timesheets/ShiftModals";

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

type Dialog = { kind: "reject"; session: SessionRow } | { kind: "correct"; session: SessionRow } | { kind: "add" } | null;

export function Shifts({
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
      <section className="home-card animate-rise p-5 sm:p-6" aria-labelledby={`${id}-h`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 id={`${id}-h`} className="home-h2">
              Shifts
            </h2>
            <p className="mt-0.5 text-xs text-muted">The hours to check and approve, with the dates and people below. Only approved hours go into payroll.</p>
          </div>
          {manage && (
            <button type="button" className="btn-secondary" onClick={() => setDialog({ kind: "add" })}>
              <Plus aria-hidden className="h-4 w-4" />
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
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded bg-home-soft px-3 py-2" role="region" aria-label="Selected shifts">
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
                      <tr key={s.id} className="cursor-pointer transition-colors hover:bg-home-soft/60" onClick={() => setDetailId(s.id)}>
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
  // As the Stitch design's screen 27 draws a shift's choices: Change, Reject (in red) and Approve (green).
  const quiet = "home-btn disabled:opacity-50";
  return (
    <span className="flex flex-wrap gap-1.5">
      <button type="button" className={quiet} disabled={busy !== null} onClick={onCorrect}>
        Correct
      </button>
      {!s.open && s.approvalStatus === "pending" && (
        <button type="button" className={`${quiet} text-danger`} disabled={busy !== null} onClick={onReject}>
          Reject
        </button>
      )}
      {!s.open && s.approvalStatus !== "approved" && (
        <button
          type="button"
          className="inline-flex h-9 shrink-0 items-center rounded bg-accent px-3 text-[13px] font-medium whitespace-nowrap text-accent-ink transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 disabled:opacity-50"
          disabled={busy !== null}
          onClick={onApprove}
        >
          {busy === `approve:${s.id}` ? "Approving…" : "Approve"}
        </button>
      )}
      {!s.open && s.approvalStatus !== "pending" && (
        <button type="button" className={quiet} disabled={busy !== null} onClick={onReopen}>
          {busy === `reopen:${s.id}` ? "Reopening…" : "Reopen"}
        </button>
      )}
    </span>
  );
}
