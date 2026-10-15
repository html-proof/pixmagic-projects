"use client";
import { useCallback, useState, type FormEvent } from "react";
import { BREAK_KIND_LABEL, localDayOf, shiftDay } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { usePortal, type MyShift, type MyTimesheet } from "@/components/staff/PortalContext";
import { ApprovalBadge, Field, Flags, Modal } from "@/components/staff/ui";
import { Badge, Empty } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { Skeleton, useToast } from "@/components/AppUi";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDateTime, fmtDay, fmtHours, fmtTime, fromLocalInput, toLocalInput } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// The employee's own shifts: times, breaks, hours, flags and where approval stands, with a way
// to ask for a change (or report a shift they forgot to clock). A manager decides each request.
// ---------------------------------------------------------------------------------------------

function browserToday() {
  try {
    return localDayOf(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const CORRECTION_TEXT: Record<MyShift["corrections"][number]["status"], string> = {
  pending: "Change requested · waiting for your manager",
  approved: "Change approved",
  rejected: "Change not approved",
  cancelled: "Change request cancelled",
};

/** What the change form is for: an existing shift, or one that was never clocked. */
type Editing = { shift: MyShift } | { shift: null };

export default function PortalTimesheets() {
  const { ws, employment } = usePortal();
  const [today] = useState(browserToday);
  const [from, setFrom] = useState(() => shiftDay(today, -30));
  const [to, setTo] = useState(today);
  const valid = !!from && !!to && from <= to;
  const q = useApi<MyTimesheet>(valid ? `/employee/${ws}/timesheets?from=${from}&to=${to}` : null);
  const [editing, setEditing] = useState<Editing | null>(null);
  // Stable: the dialog moves focus back into itself whenever onClose changes.
  const closeEditing = useCallback(() => setEditing(null), []);
  const d = q.data;
  const canAsk = !!d?.allowCorrections && employment.status !== "inactive";
  const totalWorked = d ? d.items.reduce((a, s) => a + s.workedSeconds, 0) : 0;

  return (
    <>
      <section className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Timesheets</h1>
            <p className="mt-1 text-sm text-muted">Every shift you&apos;ve clocked, with breaks and where approval stands.</p>
          </div>
          {canAsk && (
            <button type="button" className="btn-secondary min-h-11" onClick={() => setEditing({ shift: null })}>
              Report a missed shift
            </button>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-md">
          <label>
            <span className="label text-xs text-muted">From</span>
            <input type="date" className="input min-h-11" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className="label text-xs text-muted">To</span>
            <input type="date" className="input min-h-11" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {!valid && <p className="mt-2 text-xs text-danger">Choose a start date on or before the end date.</p>}
        {d && d.items.length > 0 && (
          <p className="mt-3 text-sm">
            <span className="font-semibold tabular-nums">{d.items.length}</span> {d.items.length === 1 ? "shift" : "shifts"} ·{" "}
            <span className="font-semibold tabular-nums">{fmtHours(totalWorked)}</span> worked
          </p>
        )}
        {d && !d.allowCorrections && <p className="mt-2 text-xs text-muted">Your organization doesn&apos;t take change requests here. If a shift is wrong, tell your manager.</p>}
      </section>

      {q.error && !d ? (
        <LoadError what="your shifts" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />
      ) : !d ? (
        valid ? <Skeleton lines={5} /> : null
      ) : d.items.length === 0 ? (
        <Empty>No shifts between {fmtDay(from, { weekday: false, year: true })} and {fmtDay(to, { weekday: false, year: true })}. Shifts appear here after you clock in.</Empty>
      ) : (
        <ul className="space-y-3" aria-label="Your shifts">
          {d.items.map((s) => (
            <ShiftCard key={s.id} s={s} tz={d.timezone} canAsk={canAsk} onAsk={() => setEditing({ shift: s })} />
          ))}
        </ul>
      )}

      {editing && d && (
        <ChangeRequest
          ws={ws}
          tz={d.timezone}
          shift={editing.shift}
          onClose={closeEditing}
          onSent={() => {
            setEditing(null);
            void q.reload();
          }}
        />
      )}
    </>
  );
}

function ShiftCard({ s, tz, canAsk, onAsk }: { s: MyShift; tz: string; canAsk: boolean; onAsk: () => void }) {
  const latest = s.corrections[0];
  const pendingChange = s.corrections.some((c) => c.status === "pending");
  const sameDay = s.clockOutAt && localDayOf(Date.parse(s.clockOutAt), tz) === s.day;
  return (
    <li className="card !p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{fmtDay(s.day)}</p>
          <p className="text-sm text-muted">
            {fmtTime(s.clockInAt, tz)} – {s.open ? "still clocked in" : sameDay ? fmtTime(s.clockOutAt, tz) : fmtDateTime(s.clockOutAt, tz)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s.open ? <Badge tone="good">In progress</Badge> : <ApprovalBadge status={s.approvalStatus} />}
          {s.locked && <Badge tone="neutral">In approved payroll</Badge>}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted">Worked</dt>
          <dd className="font-semibold tabular-nums">{fmtHours(s.workedSeconds)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Unpaid breaks</dt>
          <dd className="tabular-nums">{fmtHours(s.unpaidBreakSeconds)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Paid breaks</dt>
          <dd className="tabular-nums">{fmtHours(s.paidBreakSeconds)}</dd>
        </div>
      </dl>

      {s.breaks.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted" aria-label="Breaks">
          {s.breaks.map((b) => (
            <li key={b.id}>
              {BREAK_KIND_LABEL[b.kind]}: {fmtTime(b.startAt, tz)} – {b.endAt ? fmtTime(b.endAt, tz) : "now"} ({b.paid ? "paid" : "unpaid"})
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2">
        <Flags flags={s.flags} />
      </div>
      {s.approvalStatus === "rejected" && s.rejectedReason && <p className="mt-2 text-sm text-danger">Not approved: {s.rejectedReason}</p>}
      {latest && (
        <p className={`mt-2 text-sm ${latest.status === "rejected" ? "text-danger" : latest.status === "approved" ? "text-good" : "text-muted"}`}>
          {CORRECTION_TEXT[latest.status]}
          {latest.decisionNote ? `: ${latest.decisionNote}` : ""}
        </p>
      )}

      {canAsk && !s.locked && (
        <div className="mt-3">
          {pendingChange ? (
            <p className="text-xs text-muted">You&apos;ve asked for a change to this shift. Your manager will review it.</p>
          ) : (
            <button type="button" className="btn-secondary min-h-11" onClick={onAsk}>
              Request a change
            </button>
          )}
        </div>
      )}
      {s.locked && <p className="mt-2 text-xs text-muted">This shift has been paid in an approved payroll. Ask your manager if something needs adjusting.</p>}
    </li>
  );
}

function ChangeRequest({ ws, tz, shift, onClose, onSent }: { ws: string; tz: string; shift: MyShift | null; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [start, setStart] = useState(() => (shift ? toLocalInput(shift.clockInAt, tz) : ""));
  const [end, setEnd] = useState(() => (shift?.clockOutAt ? toLocalInput(shift.clockOutAt, tz) : ""));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const endOptional = !!shift?.open;

  const startAt = fromLocalInput(start, tz);
  const endAt = end ? fromLocalInput(end, tz) : null;
  const problems = {
    start: !startAt ? "Enter when the shift started." : null,
    end: !end && !endOptional ? "Enter when the shift ended." : end && !endAt ? "Enter a valid end time." : startAt && endAt && endAt <= startAt ? "The shift has to end after it starts." : null,
    reason: reason.trim().length < 3 ? "Say what needs changing and why." : null,
  };
  const ok = !problems.start && !problems.end && !problems.reason;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!ok || !startAt) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/employee/${ws}/corrections`, { method: "POST", body: { sessionId: shift?.id ?? null, clockInAt: startAt, clockOutAt: endAt, reason: reason.trim() } });
      toast("success", "Sent to your manager. You'll see their decision here.");
      onSent();
    } catch (err) {
      setError(actionError(err, "send your request"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={shift ? "Request a change" : "Report a missed shift"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-sm text-muted">
          {shift
            ? `Your shift on ${fmtDay(shift.day)}. Enter the times it should have, and why. Your manager approves or declines the change.`
            : "Forgot to clock in? Enter when you started and finished, and what happened. Your manager approves or declines it."}{" "}
          Times are in {tz}.
        </p>
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Started" htmlFor="cr-start" required error={touched ? problems.start : null}>
            <input id="cr-start" type="datetime-local" className="input min-h-11" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Finished" htmlFor="cr-end" required={!endOptional} hint={endOptional ? "Leave empty if you're still working." : undefined} error={touched ? problems.end : null}>
            <input id="cr-end" type="datetime-local" className="input min-h-11" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="What needs changing and why" htmlFor="cr-reason" required error={touched ? problems.reason : null} hint={`${reason.trim().length}/500`}>
          <textarea id="cr-reason" className="input min-h-24" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: I forgot to clock out when I left at 5 pm." />
        </Field>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary min-h-11" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary min-h-11" disabled={busy}>
            {busy ? "Sending…" : "Send request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
