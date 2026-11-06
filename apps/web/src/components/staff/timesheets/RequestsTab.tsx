"use client";
/** The Requests tab: employees' correction requests, approved or rejected by a manager. */
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Empty } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { Field, Modal, Pill as Badge } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { Skeleton, useToast } from "@/components/AppUi";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDateTime } from "@/lib/staff";
import { fmtRange, REQUEST_STATUS } from "@/components/staff/timesheets/format";

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

export function Requests({ base, tz, manage, onPending, onChanged }: { base: string; tz: string; manage: boolean; onPending: (n: number) => void; onChanged: () => void }) {
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
    <section className="home-card animate-rise mt-4 p-5 sm:p-6" aria-labelledby={`${id}-h`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-h`} className="home-h2">
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
              <li key={r.id} className="rounded bg-home-soft p-3 sm:p-4">
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
                  <div className="rounded bg-surface px-3 py-2">
                    <dt className="text-xs text-muted">Recorded</dt>
                    <dd>{r.session ? fmtRange(r.session.clockInAt, r.session.clockOutAt, tz) : "No shift recorded (asking to add one)"}</dd>
                  </div>
                  <div className="rounded bg-surface px-3 py-2">
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
                  // As screen 27's change requests have them: Reject in red, then Approve.
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button type="button" className="btn bg-surface text-danger hover:opacity-90" onClick={() => setDecide({ req: r, approve: false })}>
                      Reject
                    </button>
                    <button type="button" className="btn-primary" onClick={() => setDecide({ req: r, approve: true })}>
                      Approve
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
