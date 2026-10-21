"use client";
/** Rejecting a shift, and adding or correcting one's times and breaks. */
import { useId, useMemo, useState, type FormEvent } from "react";
import { BREAK_KIND_LABEL, BREAK_KINDS, type BreakKind } from "@app/shared/staff";
import { Field, Modal } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { actionError, api } from "@/lib/api";
import { fromLocalInput, toLocalInput, type EmployeeRow, type SessionRow } from "@/lib/staff";
import { fmtRange } from "@/components/staff/timesheets/format";

export function RejectModal({ session, tz, base, onClose, onDone }: { session: SessionRow; tz: string; base: string; onClose: () => void; onDone: (msg: string) => void }) {
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

export function TimesModal({
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
