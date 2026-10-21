"use client";
/** The Attendance tab: a month calendar of worked hours, the shifts, and adding a missed shift. */
import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { BREAK_KIND_LABEL, BREAK_KINDS, daysInclusive, endOfMonth, localDayOf, shiftDay, startOfMonth, startOfWeek, WEEKDAY_SHORT, type BreakKind } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { useToast } from "@/components/AppUi";
import { ApprovalBadge, Field, Figure, Flags, Modal, Table, Td, Th } from "@/components/staff/ui";
import { weekOrder } from "@/components/staff/EmployeeForm";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDay, fmtHours, fmtHoursDec, fmtTime, fromLocalInput, toLocalInput, useStaff, type EmployeeRow, type SessionRow, type StaffConfig, type TimesheetList } from "@/lib/staff";

const enc = encodeURIComponent;

const monthLabel = (month: string) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${month}T00:00:00Z`));

export function AttendanceTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base, can } = useStaff();
  const tz = config.settings.timezone;
  const today = localDayOf(Date.now(), tz);
  const [month, setMonth] = useState(startOfMonth(today));
  const [adding, setAdding] = useState(false);
  const closeAdd = useCallback(() => setAdding(false), []);
  const from = month;
  const to = endOfMonth(month);
  const ts = useApi<TimesheetList>(`${base}/timesheets?from=${from}&to=${to}&employeeId=${enc(employee.id)}&pageSize=200`);

  const byDay = useMemo(() => {
    const m = new Map<string, { seconds: number; shifts: number; review: boolean }>();
    for (const s of ts.data?.items ?? []) {
      const day = s.day ?? localDayOf(new Date(s.clockInAt).getTime(), tz);
      const cur = m.get(day) ?? { seconds: 0, shifts: 0, review: false };
      cur.seconds += s.workedSeconds;
      cur.shifts += 1;
      cur.review = cur.review || s.needsReview;
      m.set(day, cur);
    }
    return m;
  }, [ts.data, tz]);

  const gridStart = startOfWeek(from, config.settings.weekStartsOn);
  const gridEnd = shiftDay(startOfWeek(to, config.settings.weekStartsOn), 6);
  const days = daysInclusive(gridStart, gridEnd);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const items = ts.data?.items ?? [];
  const total = items.reduce((a, s) => a + s.workedSeconds, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary px-3" onClick={() => setMonth(startOfMonth(shiftDay(month, -1)))} aria-label="Previous month">
            ‹
          </button>
          <h2 className="min-w-36 text-center font-semibold" aria-live="polite">
            {monthLabel(month)}
          </h2>
          <button type="button" className="btn-secondary px-3" onClick={() => setMonth(shiftDay(endOfMonth(month), 1))} aria-label="Next month" disabled={month >= startOfMonth(today)}>
            ›
          </button>
          {month !== startOfMonth(today) && (
            <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setMonth(startOfMonth(today))}>
              This month
            </button>
          )}
        </div>
        {can("attendance:manage") && employee.status !== "inactive" && (
          <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
            Add missing shift
          </button>
        )}
      </div>

      {ts.error ? (
        <LoadError what="attendance for this month" error={ts.error} onRetry={() => void ts.reload()} busy={ts.loading} />
      ) : !ts.data ? (
        <div className="skeleton h-64" aria-busy="true" aria-label="Loading" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Figure label="Hours worked" value={fmtHours(total)} />
            <Figure label="Shifts" value={new Intl.NumberFormat().format(items.length)} />
            <Figure label="Days worked" value={new Intl.NumberFormat().format(byDay.size)} />
          </div>
          <table className="w-full table-fixed border-collapse text-sm" aria-label={`Hours worked in ${monthLabel(month)}`}>
            <thead>
              <tr>
                {weekOrder(config.settings.weekStartsOn).map((d) => (
                  <th key={d} scope="col" className="pb-1 text-center text-xs font-medium text-muted">
                    {WEEKDAY_SHORT[d]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w[0]}>
                  {w.map((d) => {
                    const info = byDay.get(d);
                    const inMonth = d >= from && d <= to;
                    const label = `${fmtDay(d)}: ${info ? `${fmtHours(info.seconds)} worked over ${info.shifts} ${info.shifts === 1 ? "shift" : "shifts"}` : "no hours"}`;
                    return (
                      <td key={d} className="p-0.5 align-top">
                        <div
                          title={label}
                          aria-label={label}
                          className={`flex h-14 flex-col rounded-md border p-1 sm:h-16 sm:p-1.5 ${!inMonth ? "bg-bg opacity-50" : info ? "bg-accent/10" : "bg-surface"} ${d === today ? "border-accent" : "border-border"}`}
                        >
                          <span className={`text-[11px] ${d === today ? "font-semibold text-accent" : "text-muted"}`}>{Number(d.slice(8, 10))}</span>
                          {info && (
                            <span className="mt-auto text-xs font-medium tabular-nums sm:text-sm">
                              {fmtHoursDec(info.seconds)}
                              <span className="text-[10px] font-normal text-muted"> h</span>
                              {info.review && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" aria-hidden />}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted">
            Hours are counted on the day a shift started, in {tz}. <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" aria-hidden /> marks a day with a shift to check.
          </p>
          {ts.data.total > items.length && <Alert kind="info">Showing the first {items.length} of {ts.data.total} shifts this month. Open Timesheets to see them all.</Alert>}

          <div>
            <h3 className="mb-2 text-sm font-semibold">Shifts</h3>
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No shifts recorded in {monthLabel(month)}.</p>
            ) : (
              <ShiftTable items={items} tz={tz} />
            )}
          </div>
        </>
      )}

      <Modal open={adding} title="Add missing shift" onClose={closeAdd} wide>
        <AddShiftForm
          key={String(adding)}
          employee={employee}
          config={config}
          onSaved={(day) => {
            setAdding(false);
            const m = startOfMonth(day);
            if (m !== month) setMonth(m);
            else void ts.reload();
          }}
          onCancel={closeAdd}
        />
      </Modal>
    </div>
  );
}

function ShiftTable({ items, tz }: { items: SessionRow[]; tz: string }) {
  return (
    <Table label="Shifts">
      <thead>
        <tr>
          <Th>Day</Th>
          <Th>Clock in</Th>
          <Th>Clock out</Th>
          <Th>Breaks</Th>
          <Th right>Worked</Th>
          <Th>Status</Th>
          <Th>Notes</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((s) => (
          <tr key={s.id}>
            <Td className="whitespace-nowrap">{fmtDay(s.day ?? localDayOf(new Date(s.clockInAt).getTime(), tz), { weekday: true, year: false })}</Td>
            <Td className="whitespace-nowrap">{fmtTime(s.clockInAt, tz)}</Td>
            <Td className="whitespace-nowrap">{s.clockOutAt ? fmtTime(s.clockOutAt, tz) : <span className="text-warn">Still clocked in</span>}</Td>
            <Td>
              {s.breaks.length === 0 ? (
                <span className="text-muted">None</span>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {s.breaks.map((b) => (
                    <li key={b.id} className="whitespace-nowrap">
                      {BREAK_KIND_LABEL[b.kind]} {fmtTime(b.startAt, tz)}–{b.endAt ? fmtTime(b.endAt, tz) : "now"}
                      <span className="text-muted"> ({b.paid ? "paid" : "unpaid"})</span>
                    </li>
                  ))}
                </ul>
              )}
            </Td>
            <Td right>{fmtHours(s.workedSeconds)}</Td>
            <Td>{s.open ? <span className="text-xs text-muted">In progress</span> : <ApprovalBadge status={s.approvalStatus} />}</Td>
            <Td>
              <div className="flex flex-col gap-1">
                <Flags flags={s.flags} />
                {s.pendingCorrection && <span className="w-fit rounded-full bg-warn/12 px-2 py-0.5 text-[11px] text-warn">Correction requested</span>}
                {s.rejectedReason && <span className="text-xs text-danger">Rejected: {s.rejectedReason}</span>}
                {s.note && <span className="text-xs text-muted">{s.note}</span>}
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

interface BreakDraft {
  key: number;
  kind: BreakKind;
  start: string;
  end: string;
}

const SKEW_MS = 5 * 60_000;

function AddShiftForm({ employee, config, onSaved, onCancel }: { employee: EmployeeRow; config: StaffConfig; onSaved: (day: string) => void; onCancel: () => void }) {
  const { base } = useStaff();
  const toast = useToast();
  const uid = useId();
  const tz = config.settings.timezone;
  const [nowInput] = useState(() => toLocalInput(new Date(), tz));
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [breaks, setBreaks] = useState<BreakDraft[]>([]);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState(1);

  const addBreak = () => {
    setBreaks((b) => [...b, { key: seq, kind: "rest", start: "", end: "" }]);
    setSeq((n) => n + 1);
  };
  const setBreak = (key: number, patch: Partial<BreakDraft>) => setBreaks((b) => b.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const found: Record<string, string> = {};
    const startAt = fromLocalInput(start, tz);
    const endAt = fromLocalInput(end, tz);
    const now = Date.now();
    if (!startAt) found.start = "Enter when the shift started.";
    else if (Date.parse(startAt) > now + SKEW_MS) found.start = "The start can't be in the future.";
    if (!endAt) found.end = "Enter when the shift ended.";
    else if (Date.parse(endAt) > now + SKEW_MS) found.end = "The end can't be in the future.";
    if (startAt && endAt && !found.start && !found.end) {
      const len = Date.parse(endAt) - Date.parse(startAt);
      if (len <= 0) found.end = "The shift has to end after it starts.";
      else if (len > 24 * 3_600_000) found.end = "A shift can't be longer than 24 hours. Add it as two shifts.";
    }
    const outBreaks: Array<{ startAt: string; endAt: string; kind: BreakKind }> = [];
    for (const b of breaks) {
      const bs = fromLocalInput(b.start, tz);
      const be = fromLocalInput(b.end, tz);
      if (!bs || !be) {
        found[`b${b.key}`] = "Enter when this break started and ended, or remove it.";
        continue;
      }
      if (Date.parse(be) <= Date.parse(bs)) found[`b${b.key}`] = "The break has to end after it starts.";
      else if (startAt && endAt && (Date.parse(bs) < Date.parse(startAt) || Date.parse(be) > Date.parse(endAt))) found[`b${b.key}`] = "The break has to be inside the shift.";
      else outBreaks.push({ startAt: bs, endAt: be, kind: b.kind });
    }
    const sorted = [...outBreaks].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    if (sorted.some((b, i) => i > 0 && Date.parse(b.startAt) < Date.parse(sorted[i - 1]!.endAt))) found.breaks = "Breaks can't overlap each other.";
    if (note.trim().length < 3) found.note = "Say why this shift is being added, for example: Forgot to clock in.";
    setErrors(found);
    if (Object.keys(found).length || !startAt || !endAt) return;
    setBusy(true);
    try {
      await api(`${base}/employees/${enc(employee.id)}/shifts`, {
        method: "POST",
        body: { clockInAt: startAt, clockOutAt: endAt, ...(sorted.length ? { breaks: sorted } : {}), note: note.trim() },
      });
      toast("success", "Shift added.");
      onSaved(localDayOf(Date.parse(startAt), tz));
    } catch (err) {
      setProblem(actionError(err, "add the shift"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      <p className="text-sm text-muted">
        For a shift {employee.fullName} worked but didn&apos;t clock. Times are in {tz}. It&apos;s saved as approved and marked &ldquo;Added by a manager&rdquo;.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Started" htmlFor={`${uid}-start`} error={errors.start} required>
          <input id={`${uid}-start`} type="datetime-local" className="input" max={nowInput} value={start} onChange={(e) => setStart(e.target.value)} aria-invalid={!!errors.start} />
        </Field>
        <Field label="Ended" htmlFor={`${uid}-end`} error={errors.end} required>
          <input id={`${uid}-end`} type="datetime-local" className="input" max={nowInput} min={start || undefined} value={end} onChange={(e) => setEnd(e.target.value)} aria-invalid={!!errors.end} />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Breaks (optional)</legend>
        {breaks.length === 0 && <p className="text-xs text-muted">No breaks. Add any breaks taken during the shift so unpaid time is taken off.</p>}
        {breaks.map((b, i) => (
          <div key={b.key} className="rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr]">
              <div>
                <label className="label text-xs" htmlFor={`${uid}-bk${b.key}`}>
                  Break {i + 1} type
                </label>
                <select id={`${uid}-bk${b.key}`} className="input" value={b.kind} onChange={(e) => setBreak(b.key, { kind: e.target.value as BreakKind })}>
                  {BREAK_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {BREAK_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label text-xs" htmlFor={`${uid}-bs${b.key}`}>
                  Break {i + 1} started
                </label>
                <input id={`${uid}-bs${b.key}`} type="datetime-local" className="input" min={start || undefined} max={end || nowInput} value={b.start} onChange={(e) => setBreak(b.key, { start: e.target.value })} />
              </div>
              <div>
                <label className="label text-xs" htmlFor={`${uid}-be${b.key}`}>
                  Break {i + 1} ended
                </label>
                <input id={`${uid}-be${b.key}`} type="datetime-local" className="input" min={b.start || start || undefined} max={end || nowInput} value={b.end} onChange={(e) => setBreak(b.key, { end: e.target.value })} />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              {errors[`b${b.key}`] ? <p className="text-xs text-danger">{errors[`b${b.key}`]}</p> : <span />}
              <button type="button" className="text-xs text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setBreaks((x) => x.filter((y) => y.key !== b.key))}>
                Remove break {i + 1}
              </button>
            </div>
          </div>
        ))}
        {errors.breaks && <p className="text-xs text-danger">{errors.breaks}</p>}
        {breaks.length < 20 && (
          <button type="button" className="btn-secondary px-3 py-1.5" onClick={addBreak}>
            Add a break
          </button>
        )}
      </fieldset>

      <Field label="Reason" htmlFor={`${uid}-note`} error={errors.note} required hint="Kept with the shift's history.">
        <textarea id={`${uid}-note`} className="input min-h-16" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: Forgot to clock in; confirmed with the roster." aria-invalid={!!errors.note} />
      </Field>
      {problem && <Alert>{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add shift"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
