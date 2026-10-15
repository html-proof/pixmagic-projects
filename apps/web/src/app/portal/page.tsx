"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BREAK_KIND_LABEL, BREAK_KINDS, PAYMENT_METHOD_LABEL, type BreakKind } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { usePortal, useLiveRetry, type ClockResult, type ClockState, type EmployeeDashboard, type ShiftSummary } from "@/components/staff/PortalContext";
import { ApprovalBadge, EstimateNote, Figure, Flags, PaymentBadge } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { ConfirmDialog, Skeleton, useToast } from "@/components/AppUi";
import { actionError, api, ApiError, isSignedOut, isTransient } from "@/lib/api";
import { signInAndReturn } from "@/lib/returnTo";
import { fmtDateTime, fmtDay, fmtHours, fmtMoney, fmtSpan, fmtTime, newKey, postIdempotent } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// The employee's home: clock in and out, breaks, a live shift timer and their hours and pay so
// far. Every figure comes from the API; the timer only counts on from the server's last answer
// (workedSeconds as of serverTime), corrected for this device's clock, so a refresh, another
// device or a wrong phone clock never changes what is recorded or shown.
// ---------------------------------------------------------------------------------------------

type Action = "clock-in" | "clock-out" | "break/start" | "break/end";

const WHAT: Record<Action, string> = {
  "clock-in": "clock you in",
  "clock-out": "clock you out",
  "break/start": "start your break",
  "break/end": "end your break",
};
const DONE: Record<Action, string> = {
  "clock-in": "You're clocked in.",
  "clock-out": "You're clocked out.",
  "break/start": "Break started.",
  "break/end": "Break over. Back to work.",
};
const STATUS_TEXT: Record<ClockState["status"], string> = { clocked_out: "Not clocked in", working: "Working", on_break: "On break" };

/** One press of a clock button: its idempotency key stays the same through retries. */
interface Attempt {
  action: Action;
  key: string;
  kind?: BreakKind;
  /** Why the last try failed to reach bizinsights (then "Try again" is offered with the same key). */
  failed: string | null;
}

/** A state from the server, with this device's clock offset measured when it arrived. */
interface Clock {
  state: ClockState;
  offset: number;
}

/** "1:05:09" for a running timer. */
function fmtTimer(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Worked time now: the server's figure plus the time since it answered, unless an unpaid break stopped the clock. */
function workedNow(c: Clock, nowMs: number) {
  const s = c.state.session;
  if (!s) return 0;
  const since = Math.max(0, (nowMs + c.offset - Date.parse(c.state.serverTime)) / 1000);
  const ticking = c.state.status === "working" || (c.state.status === "on_break" && !!s.currentBreak?.paid);
  return s.workedSeconds + (ticking ? since : 0);
}

function breakNow(c: Clock, nowMs: number) {
  const b = c.state.session?.currentBreak;
  return b ? Math.max(0, (nowMs + c.offset - Date.parse(b.startAt)) / 1000) : 0;
}

export default function PortalHome() {
  const { ws } = usePortal();
  const router = useRouter();
  const toast = useToast();
  const dash = useLiveRetry<EmployeeDashboard>(`/employee/${ws}/dashboard`, 30_000);
  const d = dash.data;

  const [clock, setClock] = useState<Clock | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [choosingBreak, setChoosingBreak] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  // Stable: the dialog re-focuses whenever its onCancel changes, and this page re-renders every second.
  const cancelOut = useCallback(() => setConfirmOut(false), []);

  /** Take a state from the server unless a newer one is already on screen (answers can cross). */
  const adopt = useCallback((state: ClockState) => {
    const offset = Date.parse(state.serverTime) - Date.now();
    setClock((cur) => (cur && Date.parse(cur.state.serverTime) > Date.parse(state.serverTime) ? cur : { state, offset }));
  }, []);

  useEffect(() => {
    if (d) adopt(d.state);
  }, [d, adopt]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const refreshState = useCallback(async () => {
    await api<ClockState>(`/employee/${ws}/attendance/me`)
      .then(adopt)
      .catch(() => {});
  }, [ws, adopt]);

  async function run(next: Attempt) {
    setAttempt({ ...next, failed: null });
    setBusy(true);
    setNotice(null);
    setChoosingBreak(false);
    try {
      const r = await postIdempotent<ClockResult>(
        `/employee/${ws}/attendance/${next.action}`,
        { clientTime: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(next.kind ? { kind: next.kind } : {}) },
        next.key,
      );
      adopt(r.state);
      if (next.action === "clock-out") setSummary(r.summary ?? null);
      else if (next.action === "clock-in") setSummary(null);
      setAttempt(null);
      toast("success", DONE[next.action]);
      // The hours tiles count this action too.
      dash.retry();
    } catch (e) {
      if (isSignedOut(e)) {
        signInAndReturn(router);
        return;
      }
      if (e instanceof ApiError && e.status === 409) {
        // Already done (another device, an earlier tap): show where things really stand.
        setAttempt(null);
        setNotice({ kind: "info", text: e.message });
        await refreshState();
        dash.retry();
      } else if (isTransient(e)) {
        // Nothing (or no answer) came back: the same key makes a retry safe, it can only act once.
        setAttempt({ ...next, failed: e instanceof ApiError && e.status === 429 ? e.message : actionError(e, WHAT[next.action]) });
      } else {
        setAttempt(null);
        setNotice({ kind: "error", text: actionError(e, WHAT[next.action]) });
      }
    } finally {
      setBusy(false);
    }
  }

  const press = (action: Action, kind?: BreakKind) => void run({ action, kind, key: newKey(), failed: null });

  if (dash.error && !d) return <LoadError what="your dashboard" error={dash.error} onRetry={dash.retry} busy={dash.loading} />;
  if (!d || !clock) return <Skeleton lines={6} />;

  const tz = d.timezone;
  const st = clock.state;
  const serverNow = new Date(now + clock.offset);
  const first = d.employee.fullName.trim().split(/\s+/)[0] ?? d.employee.fullName;
  const inactive = d.employee.status === "inactive";
  const worked = workedNow(clock, now);
  const pendingTotal = d.pending.shifts + d.pending.corrections;

  return (
    <>
      <section className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Welcome, {first}</h1>
            <p className="mt-0.5 text-sm text-muted">
              {d.employee.jobTitle ? `${d.employee.jobTitle} · ` : ""}
              {d.organization}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums" aria-live="off">
              {new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(serverNow)}
            </p>
            <p className="text-xs text-muted">{new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(serverNow)}</p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-border bg-bg/60 p-4 text-center sm:p-6">
          <p className="inline-flex items-center gap-2 text-sm font-medium">
            <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${st.status === "working" ? "bg-good" : st.status === "on_break" ? "bg-warn" : "bg-muted"}`} />
            <span data-testid="shift-status">{STATUS_TEXT[st.status]}</span>
          </p>
          <p className="mt-2 text-5xl font-semibold tabular-nums tracking-tight sm:text-6xl" data-testid="shift-timer" role="timer" aria-label="Time worked this shift">
            {fmtTimer(worked)}
          </p>
          {st.session ? (
            <p className="mt-1 text-sm text-muted">
              Clocked in at {fmtTime(st.session.clockInAt, tz)}
              {st.session.unpaidBreakSeconds > 0 && ` · unpaid breaks ${fmtHours(st.session.unpaidBreakSeconds)}`}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">Time worked this shift</p>
          )}
          {st.status === "on_break" && st.session?.currentBreak && (
            <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-warn/12 px-3 py-1 text-sm text-warn" data-testid="break-timer">
              {BREAK_KIND_LABEL[st.session.currentBreak.kind]} · {fmtTimer(breakNow(clock, now))}
              {st.session.currentBreak.paid ? " (paid)" : " (unpaid)"}
            </p>
          )}
          {st.session && (
            <div className="mt-2 flex justify-center">
              <Flags flags={st.session.flags} />
            </div>
          )}
        </div>

        {inactive ? (
          <div className="mt-4">
            <Alert kind="info">Your employee account has been deactivated, so you can&apos;t clock in. Contact your manager if you think that&apos;s a mistake.</Alert>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {d.employee.status === "on_leave" && st.status === "clocked_out" && <Alert kind="info">You&apos;re marked as on leave. Ask your manager if you need to work today.</Alert>}
            {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
            {attempt?.failed && (
              <Alert kind="error">
                {attempt.failed}{" "}
                <button type="button" className="font-medium underline" onClick={() => void run(attempt)} disabled={busy}>
                  Try again
                </button>{" "}
                <span className="text-muted">(safe to retry: it only counts once)</span>
              </Alert>
            )}

            {st.status === "clocked_out" && (
              <button type="button" className="btn-primary min-h-16 w-full text-lg" onClick={() => press("clock-in")} disabled={busy}>
                {busy && attempt?.action === "clock-in" ? "Clocking in…" : "Clock in"}
              </button>
            )}

            {st.status === "working" &&
              (choosingBreak ? (
                <div className="rounded-xl border border-border p-3" role="group" aria-label="Choose a break">
                  <p className="mb-2 text-sm font-medium">What kind of break?</p>
                  <div className="grid grid-cols-2 gap-2">
                    {BREAK_KINDS.map((k) => (
                      <button key={k} type="button" className="btn-secondary min-h-14 text-base" onClick={() => press("break/start", k)} disabled={busy}>
                        {BREAK_KIND_LABEL[k]}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="mt-2 w-full py-2 text-sm text-muted underline" onClick={() => setChoosingBreak(false)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <button type="button" className="btn-secondary min-h-16 text-lg" onClick={() => setChoosingBreak(true)} disabled={busy}>
                    {busy && attempt?.action === "break/start" ? "Starting break…" : "Start break"}
                  </button>
                  <button type="button" className="btn-primary min-h-16 text-lg" onClick={() => setConfirmOut(true)} disabled={busy}>
                    {busy && attempt?.action === "clock-out" ? "Clocking out…" : "Clock out"}
                  </button>
                </div>
              ))}

            {st.status === "on_break" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <button type="button" className="btn-primary min-h-16 text-lg" onClick={() => press("break/end")} disabled={busy}>
                  {busy && attempt?.action === "break/end" ? "Ending break…" : "End break"}
                </button>
                <button type="button" className="btn-secondary min-h-16 text-lg" onClick={() => setConfirmOut(true)} disabled={busy}>
                  {busy && attempt?.action === "clock-out" ? "Clocking out…" : "Clock out"}
                </button>
              </div>
            )}
            <p className="text-center text-xs text-muted">Times are recorded by bizinsights when you press a button, not by this device&apos;s clock.</p>
          </div>
        )}
        {dash.failing && <p className="mt-3 text-center text-xs text-muted">Can&apos;t reach bizinsights right now. Showing your last update; we&apos;ll keep trying.</p>}
      </section>

      {summary && <SummaryCard s={summary} tz={tz} onClose={() => setSummary(null)} />}

      <section aria-label="Your hours and pay" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Figure label="Today" value={fmtHours(d.today.workedSeconds)} sub="worked" />
        <Figure label="This week" value={fmtHours(d.week.workedSeconds)} sub={d.week.overtimeSeconds > 0 ? `incl. ${fmtHours(d.week.overtimeSeconds)} overtime` : `since ${fmtDay(d.week.from, { weekday: true, year: false })}`} />
        <Figure label="This month" value={fmtHours(d.month.workedSeconds)} sub="worked" />
        <Figure label="Current pay period" value={fmtHours(d.payPeriod.workedSeconds)} sub={fmtSpan(d.payPeriod.from, d.payPeriod.to)} />
        <Figure
          label="Estimated gross earnings"
          value={fmtMoney(d.payPeriod.estimatedGross, d.currency)}
          sub={d.payPeriod.rateMissing ? "Pay rate not set yet — ask your manager" : "estimated, this pay period"}
        />
        <Figure label="Overtime this pay period" value={fmtHours(d.payPeriod.overtimeSeconds)} sub={d.payPeriod.overtimeSeconds > 0 ? "paid at your overtime rate" : "none so far"} />
      </section>
      <EstimateNote>{d.estimateNotice}</EstimateNote>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card" aria-labelledby="last-shift">
          <h2 id="last-shift" className="font-semibold">
            Last completed shift
          </h2>
          {d.lastShift ? (
            <div className="mt-3 space-y-2 text-sm">
              <p>
                {fmtDateTime(d.lastShift.clockInAt, tz)} – {fmtTime(d.lastShift.clockOutAt, tz)}
              </p>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold tabular-nums">{fmtHours(d.lastShift.workedSeconds)}</span> worked <ApprovalBadge status={d.lastShift.approvalStatus} />
              </p>
              <Flags flags={d.lastShift.flags} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">No completed shifts yet. Your first one shows up here after you clock out.</p>
          )}
          <Link href="/portal/timesheets" className="mt-3 inline-block text-sm text-accent hover:underline">
            See all your shifts
          </Link>
        </section>

        <section className="card" aria-labelledby="pending">
          <h2 id="pending" className="font-semibold">
            Waiting for approval
          </h2>
          {pendingTotal === 0 ? (
            <p className="mt-2 text-sm text-muted">Nothing waiting. Your manager has reviewed everything you&apos;ve sent.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {d.pending.shifts > 0 && (
                <li>
                  <span className="font-semibold tabular-nums">{d.pending.shifts}</span> {d.pending.shifts === 1 ? "shift" : "shifts"} waiting for your manager to approve
                </li>
              )}
              {d.pending.corrections > 0 && (
                <li>
                  <span className="font-semibold tabular-nums">{d.pending.corrections}</span> change {d.pending.corrections === 1 ? "request" : "requests"} waiting for a decision
                </li>
              )}
            </ul>
          )}
          <Link href="/portal/timesheets" className="mt-3 inline-block text-sm text-accent hover:underline">
            Open timesheets
          </Link>
        </section>

        <section className="card" aria-labelledby="upcoming">
          <h2 id="upcoming" className="font-semibold">
            Upcoming shifts
          </h2>
          {d.upcomingShifts.length ? (
            <ul className="mt-3 divide-y divide-border text-sm">
              {d.upcomingShifts.map((s) => (
                <li key={s.id} className="py-2">
                  <p className="font-medium">
                    {fmtDateTime(s.startsAt, tz)} – {fmtTime(s.endsAt, tz)}
                  </p>
                  <p className="text-xs text-muted">
                    {[s.breakMinutes ? `${s.breakMinutes} min break` : null, s.location, s.note].filter(Boolean).join(" · ") || "No notes"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No shifts scheduled. Your manager adds them in bizinsights; they&apos;ll show up here.</p>
          )}
          <Link href="/portal/schedule" className="mt-3 inline-block text-sm text-accent hover:underline">
            Full schedule
          </Link>
        </section>

        <section className="card" aria-labelledby="payments">
          <h2 id="payments" className="font-semibold">
            Recent payments
          </h2>
          {d.recentPayments.length ? (
            <ul className="mt-3 divide-y divide-border text-sm">
              {d.recentPayments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-semibold tabular-nums">{fmtMoney(p.amount, p.currency)}</p>
                    <p className="text-xs text-muted">
                      {fmtDay(p.paidOn)} · {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
                      {p.periods.length > 0 && ` · for ${p.periods.map((x) => fmtSpan(x.from, x.to)).join(", ")}`}
                    </p>
                  </div>
                  <PaymentBadge status={p.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No payments recorded yet. They show up here once your employer records them.</p>
          )}
          <Link href="/portal/pay" className="mt-3 inline-block text-sm text-accent hover:underline">
            Pay and payslips
          </Link>
        </section>
      </div>

      <ConfirmDialog
        open={confirmOut}
        title="Clock out now?"
        confirmLabel="Yes, clock out"
        busy={busy}
        onCancel={cancelOut}
        onConfirm={() => {
          setConfirmOut(false);
          press("clock-out");
        }}
      >
        <p>
          You&apos;ve worked <span className="font-medium text-text tabular-nums">{fmtHours(Math.floor(worked))}</span> this shift.
          {st.status === "on_break" && " Clocking out also ends your break."}
        </p>
        <p>If you clock out by mistake, ask your manager or request a change on Timesheets.</p>
      </ConfirmDialog>
    </>
  );
}

function SummaryCard({ s, tz, onClose }: { s: ShiftSummary; tz: string; onClose: () => void }) {
  return (
    <section className="card animate-rise border-good" aria-labelledby="shift-done" data-testid="shift-summary">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="shift-done" className="font-semibold">
            Shift complete
          </h2>
          <p className="text-sm text-muted">
            {fmtDateTime(s.clockInAt, tz)} – {fmtTime(s.clockOutAt, tz)}
          </p>
        </div>
        <button type="button" className="min-h-10 px-2 text-muted hover:text-text" aria-label="Close summary" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Worked" value={fmtHours(s.workedSeconds)} />
        <Figure label="Unpaid breaks" value={fmtHours(s.unpaidBreakSeconds)} sub={s.paidBreakSeconds > 0 ? `plus ${fmtHours(s.paidBreakSeconds)} paid` : undefined} />
        <Figure label="Overtime" value={s.overtimeSeconds > 0 ? fmtHours(s.overtimeSeconds) : "None"} />
        <Figure
          label="Estimated earnings"
          value={s.rateMissing || !s.estimatedEarnings ? "—" : fmtMoney(s.estimatedEarnings, s.currency)}
          sub={s.rateMissing ? "Pay rate not set yet — ask your manager" : "estimated gross"}
        />
      </div>
      <div className="mt-2">
        <Flags flags={s.flags} />
      </div>
    </section>
  );
}
