"use client";
import Link from "next/link";
import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { daysInclusive, isCalendarDay, localDayOf, localTimeOf, shiftDay, startOfWeek, WEEKDAY_SHORT } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { PageHeader, Skeleton, useToast } from "@/components/whatsapp/common";
import { Field, Modal } from "@/components/staff/ui";
import { WeekdayPicker } from "@/components/staff/EmployeeForm";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDay, fmtHours, fmtSpan, fmtTime, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Shift schedules: one week at a time, a row per employee. Times are the organization's local
// times; a shift that ends at or before its start time ends the next day.
// ---------------------------------------------------------------------------------------------

interface ScheduleItem {
  id: string;
  employeeId: string;
  employee?: { fullName: string; jobTitle: string };
  day: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  plannedSeconds: number;
  location: string | null;
  note: string | null;
}
interface EmployeeList {
  items: EmployeeRow[];
  total: number;
}

type Editor = { mode: "add"; employeeId: string; day: string } | { mode: "edit"; shift: ScheduleItem };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export default function SchedulesPage() {
  const { base } = useStaff();
  const config = useApi<StaffConfig>(`${base}/config`);
  if (config.error) return <LoadError what="your staff settings" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />;
  if (!config.data) return <Skeleton lines={6} />;
  return <WeekView key={base} config={config.data} />;
}

function WeekView({ config }: { config: StaffConfig }) {
  const { base, can } = useStaff();
  const tz = config.settings.timezone;
  const today = localDayOf(Date.now(), tz);
  const thisWeek = startOfWeek(today, config.settings.weekStartsOn);
  const [week, setWeek] = useState(thisWeek);
  const [departmentId, setDepartmentId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const closeEditor = useCallback(() => setEditor(null), []);
  const uid = useId();
  const manage = can("staff:manage");
  const to = shiftDay(week, 6);
  const dq = departmentId ? `&departmentId=${encodeURIComponent(departmentId)}` : "";
  const emps = useApi<EmployeeList>(`${base}/employees?pageSize=200&status=active&sort=name${dq}`);
  const sched = useApi<{ timezone: string; items: ScheduleItem[] }>(`${base}/schedules?from=${week}&to=${to}${dq}`);
  const days = daysInclusive(week, to);

  // A row per active employee, plus anyone with a shift this week who isn't (on leave, say).
  const rows = useMemo(() => {
    const out: Array<{ id: string; name: string; jobTitle: string; active: boolean }> = (emps.data?.items ?? []).map((e) => ({ id: e.id, name: e.fullName, jobTitle: e.jobTitle, active: true }));
    const seen = new Set(out.map((r) => r.id));
    for (const s of sched.data?.items ?? []) {
      if (seen.has(s.employeeId)) continue;
      seen.add(s.employeeId);
      out.push({ id: s.employeeId, name: s.employee?.fullName ?? "Employee", jobTitle: s.employee?.jobTitle ?? "", active: false });
    }
    return out;
  }, [emps.data, sched.data]);

  const cell = useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const s of sched.data?.items ?? []) {
      const k = `${s.employeeId}|${s.day}`;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [sched.data]);
  const plannedBy = (pred: (s: ScheduleItem) => boolean) => (sched.data?.items ?? []).filter(pred).reduce((a, s) => a + s.plannedSeconds, 0);
  const weekTotal = plannedBy(() => true);
  const activeEmployees = emps.data?.items ?? [];

  const saved = (day: string) => {
    setEditor(null);
    const w = startOfWeek(day, config.settings.weekStartsOn);
    if (w !== week) setWeek(w);
    else void sched.reload();
  };

  const loading = !emps.data || !sched.data;
  return (
    <>
      <PageHeader
        title="Shift schedules"
        sub={`Plan who works when. Times are in ${tz}. Scheduled shifts are compared with clock-ins to spot late starts and early finishes.`}
        actions={
          manage && (
            <button type="button" className="btn-primary" onClick={() => setEditor({ mode: "add", employeeId: "", day: week <= today && today <= to ? today : week })} disabled={!activeEmployees.length}>
              Add shift
            </button>
          )
        }
      />

      <section className="card space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary px-3" onClick={() => setWeek(shiftDay(week, -7))} aria-label="Previous week">
              ‹
            </button>
            <h2 className="min-w-44 text-center font-semibold" aria-live="polite">
              {fmtSpan(week, to)}
            </h2>
            <button type="button" className="btn-secondary px-3" onClick={() => setWeek(shiftDay(week, 7))} aria-label="Next week">
              ›
            </button>
            <button type="button" className="btn-secondary" onClick={() => setWeek(thisWeek)} disabled={week === thisWeek}>
              This week
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48">
              <label className="label text-xs text-muted" htmlFor={`${uid}-dept`}>
                Department
              </label>
              <select id={`${uid}-dept`} className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">All departments</option>
                {config.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            {sched.data && <p className="pb-2 text-sm text-muted">{fmtHours(weekTotal)} planned this week</p>}
          </div>
        </div>

        {emps.error ? (
          <LoadError what="your employees" error={emps.error} onRetry={() => void emps.reload()} busy={emps.loading} />
        ) : sched.error ? (
          <LoadError what="the schedule" error={sched.error} onRetry={() => void sched.reload()} busy={sched.loading} />
        ) : loading ? (
          <div className="skeleton h-64" aria-busy="true" aria-label="Loading" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={departmentId ? "No one in this department" : "No active employees yet"}
            body={departmentId ? "Choose another department, or show all departments." : "Add employees first, then plan their shifts here."}
            action={
              !departmentId && manage ? (
                <Link href="/staff/employees/new" className="btn-secondary">
                  Add employee
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[56rem] table-fixed border-collapse text-sm" aria-label={`Shifts for the week ${fmtSpan(week, to)}`}>
              <thead>
                <tr>
                  <th scope="col" className="w-48 border-b border-border px-2 py-2 text-left text-xs font-medium text-muted">
                    Employee
                  </th>
                  {days.map((d) => (
                    <th key={d} scope="col" className={`border-b border-border px-1 py-2 text-left text-xs font-medium ${d === today ? "text-accent" : "text-muted"}`}>
                      {WEEKDAY_SHORT[new Date(`${d}T00:00:00Z`).getUTCDay()]} {Number(d.slice(8, 10))}
                      {d === today && <span className="sr-only"> (today)</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <th scope="row" className="border-b border-border/70 px-2 py-2 text-left font-normal">
                      <Link href={`/staff/employee?id=${encodeURIComponent(r.id)}&tab=schedule`} className="font-medium hover:text-accent hover:underline">
                        {r.name}
                      </Link>
                      <p className="truncate text-xs text-muted">{r.jobTitle}</p>
                      <p className="text-xs text-muted">
                        {fmtHours(plannedBy((s) => s.employeeId === r.id))} planned
                        {!r.active && " · not active"}
                      </p>
                    </th>
                    {days.map((d) => {
                      const shifts = cell.get(`${r.id}|${d}`) ?? [];
                      return (
                        <td key={d} className={`border-b border-border/70 p-1 ${d === today ? "bg-accent/5" : ""}`}>
                          <div className="flex min-h-14 flex-col gap-1">
                            {shifts.map((s) => {
                              const overnight = localDayOf(Date.parse(s.endsAt) - 1, tz) !== s.day;
                              const body = (
                                <>
                                  <span className="block font-medium tabular-nums">
                                    {fmtTime(s.startsAt, tz)}–{fmtTime(s.endsAt, tz)}
                                    {overnight && <span className="font-normal text-muted"> (+1 day)</span>}
                                  </span>
                                  <span className="block text-muted">
                                    {fmtHours(s.plannedSeconds)}
                                    {s.breakMinutes ? ` · ${s.breakMinutes}m break` : ""}
                                  </span>
                                  {s.location && <span className="block truncate text-muted">{s.location}</span>}
                                </>
                              );
                              const cls = "w-full rounded-md border border-accent/30 bg-accent/10 px-1.5 py-1 text-left text-[11px] leading-snug";
                              return manage ? (
                                <button
                                  key={s.id}
                                  type="button"
                                  className={`${cls} transition hover:border-accent`}
                                  onClick={() => setEditor({ mode: "edit", shift: s })}
                                  aria-label={`Edit ${r.name}'s shift on ${fmtDay(d)}, ${fmtTime(s.startsAt, tz)} to ${fmtTime(s.endsAt, tz)}`}
                                  title={s.note ?? undefined}
                                >
                                  {body}
                                </button>
                              ) : (
                                <div key={s.id} className={cls} title={s.note ?? undefined}>
                                  {body}
                                </div>
                              );
                            })}
                            {manage && r.active && (
                              <button
                                type="button"
                                className="mt-auto rounded-md border border-dashed border-border px-1 py-0.5 text-[11px] text-muted opacity-60 transition hover:border-accent hover:text-accent hover:opacity-100 focus:opacity-100"
                                onClick={() => setEditor({ mode: "add", employeeId: r.id, day: d })}
                                aria-label={`Add a shift for ${r.name} on ${fmtDay(d)}`}
                              >
                                + Add
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className="px-2 py-2 text-left text-xs font-medium text-muted">
                    Planned per day
                  </th>
                  {days.map((d) => (
                    <td key={d} className="px-1 py-2 text-xs font-medium tabular-nums text-muted">
                      {fmtHours(plannedBy((s) => s.day === d))}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {emps.data && emps.data.total > emps.data.items.length && (
          <p className="text-xs text-muted">Showing the first {emps.data.items.length} active employees. Choose a department to see the rest.</p>
        )}
      </section>

      <Modal open={editor !== null} title={editor?.mode === "edit" ? "Edit shift" : "Add shift"} onClose={closeEditor} wide>
        {editor && (
          <ShiftForm
            key={editor.mode === "edit" ? editor.shift.id : `${editor.employeeId}|${editor.day}`}
            editor={editor}
            config={config}
            employees={activeEmployees}
            employeeName={editor.mode === "edit" ? (rows.find((r) => r.id === editor.shift.employeeId)?.name ?? editor.shift.employee?.fullName ?? "") : ""}
            onSaved={saved}
            onDeleted={() => {
              setEditor(null);
              void sched.reload();
            }}
            onCancel={closeEditor}
          />
        )}
      </Modal>
    </>
  );
}

function ShiftForm({
  editor,
  config,
  employees,
  employeeName,
  onSaved,
  onDeleted,
  onCancel,
}: {
  editor: Editor;
  config: StaffConfig;
  employees: EmployeeRow[];
  employeeName: string;
  onSaved: (day: string) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const { base } = useStaff();
  const toast = useToast();
  const uid = useId();
  const tz = config.settings.timezone;
  const shift = editor.mode === "edit" ? editor.shift : null;
  const [employeeId, setEmployeeId] = useState(editor.mode === "add" ? editor.employeeId : editor.shift.employeeId);
  const [day, setDay] = useState(shift ? shift.day : editor.mode === "add" ? editor.day : "");
  const [startTime, setStartTime] = useState(shift ? localTimeOf(Date.parse(shift.startsAt), tz) : "09:00");
  const [endTime, setEndTime] = useState(shift ? localTimeOf(Date.parse(shift.endsAt), tz) : "17:00");
  const [breakMinutes, setBreakMinutes] = useState(shift ? String(shift.breakMinutes) : "0");
  const [location, setLocation] = useState(shift?.location ?? "");
  const [note, setNote] = useState(shift?.note ?? "");
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [repeatUntil, setRepeatUntil] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Length shown while typing (the API works out the exact planned time, daylight saving included).
  const a = TIME_RE.exec(startTime);
  const b = TIME_RE.exec(endTime);
  const lengthMin = a && b ? (Number(b[1]) * 60 + Number(b[2]) - (Number(a[1]) * 60 + Number(a[2])) + 1440) % 1440 || 1440 : null;
  const overnight = !!(a && b && endTime <= startTime);
  const brk = Number(breakMinutes);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found: Record<string, string> = {};
    if (editor.mode === "add" && !employeeId) found.employee = "Choose who works this shift.";
    if (!isCalendarDay(day)) found.day = "Choose the day of the shift.";
    if (!a) found.start = "Enter a start time, like 09:00.";
    if (!b) found.end = "Enter an end time, like 17:00.";
    if (breakMinutes.trim() === "" || !Number.isInteger(brk) || brk < 0 || brk > 600) found.break = "Enter the unpaid break in whole minutes, from 0 to 600.";
    else if (lengthMin !== null && brk >= lengthMin) found.break = "The break has to be shorter than the shift.";
    if (location.trim().length > 120) found.location = "Keep the location under 120 characters.";
    if (note.trim().length > 500) found.note = "Keep the note under 500 characters.";
    if (editor.mode === "add" && repeatDays.length) {
      if (!isCalendarDay(repeatUntil)) found.repeatUntil = "Choose the last day to repeat this shift.";
      else if (isCalendarDay(day) && repeatUntil < day) found.repeatUntil = "The repeat has to end on or after the shift's day.";
      else if (isCalendarDay(day) && repeatUntil > shiftDay(day, 365)) found.repeatUntil = "Repeat for a year at most.";
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    const fields = { day, startTime, endTime, breakMinutes: brk, location: location.trim() || null, note: note.trim() || null };
    setBusy("save");
    try {
      if (shift) {
        await api(`${base}/schedules/${encodeURIComponent(shift.id)}`, { method: "PUT", body: fields });
        toast("success", "Shift updated.");
      } else {
        const res = await api<{ items: ScheduleItem[] }>(`${base}/schedules`, {
          method: "POST",
          body: { employeeId, ...fields, ...(repeatDays.length ? { repeatDays, repeatUntil } : {}) },
        });
        const n = res.items.length;
        toast("success", n === 1 ? "Shift added." : `${n} shifts added.`);
      }
      onSaved(day);
    } catch (err) {
      setProblem(actionError(err, "save the shift"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!shift) return;
    setProblem(null);
    setBusy("delete");
    try {
      await api(`${base}/schedules/${encodeURIComponent(shift.id)}`, { method: "DELETE" });
      toast("success", "Shift deleted.");
      onDeleted();
    } catch (err) {
      setProblem(actionError(err, "delete the shift"));
      setBusy(null);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {shift ? (
          <div>
            <p className="label">Employee</p>
            <p className="text-sm">{employeeName}</p>
          </div>
        ) : (
          <Field label="Employee" htmlFor={`${uid}-emp`} error={errors.employee} required>
            <select id={`${uid}-emp`} className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-invalid={!!errors.employee}>
              <option value="">Choose an employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName} · {e.jobTitle}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Day" htmlFor={`${uid}-day`} error={errors.day} required>
          <input id={`${uid}-day`} type="date" className="input" value={day} onChange={(e) => setDay(e.target.value)} aria-invalid={!!errors.day} />
        </Field>
        <Field label="Start time" htmlFor={`${uid}-start`} error={errors.start} required>
          <input id={`${uid}-start`} type="time" className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} aria-invalid={!!errors.start} />
        </Field>
        <Field label="End time" htmlFor={`${uid}-end`} error={errors.end} required hint="At or before the start time means the shift ends the next day.">
          <input id={`${uid}-end`} type="time" className="input" value={endTime} onChange={(e) => setEndTime(e.target.value)} aria-invalid={!!errors.end} />
        </Field>
        <Field label="Unpaid break (minutes)" htmlFor={`${uid}-break`} error={errors.break}>
          <input id={`${uid}-break`} type="number" className="input" min={0} max={600} step={5} inputMode="numeric" value={breakMinutes} onChange={(e) => setBreakMinutes(e.target.value)} aria-invalid={!!errors.break} />
        </Field>
        <Field label="Location (optional)" htmlFor={`${uid}-loc`} error={errors.location}>
          <input id={`${uid}-loc`} className="input" maxLength={120} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Front counter" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Note (optional)" htmlFor={`${uid}-note`} error={errors.note}>
            <input id={`${uid}-note`} className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>

      {lengthMin !== null && (
        <p className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted">
          {overnight ? "Overnight: ends the next day. " : ""}
          About {fmtHours(lengthMin * 60)} long
          {Number.isInteger(brk) && brk > 0 && brk < lengthMin ? `, ${fmtHours((lengthMin - brk) * 60)} after the unpaid break` : ""}. Times are in {tz}.
        </p>
      )}

      {editor.mode === "add" && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <WeekdayPicker legend="Repeat on (optional)" value={repeatDays} weekStartsOn={config.settings.weekStartsOn} onChange={setRepeatDays} hint="Adds the same shift on these weekdays after the day above, up to the date below (120 shifts at most)." />
          {repeatDays.length > 0 && (
            <Field label="Repeat until" htmlFor={`${uid}-until`} error={errors.repeatUntil} required>
              <input id={`${uid}-until`} type="date" className="input" min={day || undefined} value={repeatUntil} onChange={(e) => setRepeatUntil(e.target.value)} aria-invalid={!!errors.repeatUntil} />
            </Field>
          )}
        </div>
      )}

      {problem && <Alert>{problem}</Alert>}

      {confirmDelete ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/50 px-3 py-2" role="alert">
          <p className="mr-auto text-sm">Delete this shift? Hours already clocked aren&apos;t affected.</p>
          <button type="button" className="btn-danger" onClick={() => void remove()} disabled={busy !== null}>
            {busy === "delete" ? "Deleting…" : "Delete shift"}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(false)} disabled={busy !== null}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary" disabled={busy !== null}>
            {busy === "save" ? "Saving…" : shift ? "Save shift" : "Add shift"}
          </button>
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </button>
          {shift && (
            <button type="button" className="ml-auto text-sm text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>
              Delete shift
            </button>
          )}
        </div>
      )}
    </form>
  );
}
