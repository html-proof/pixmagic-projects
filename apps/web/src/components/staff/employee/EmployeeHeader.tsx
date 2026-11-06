"use client";
/** An employee's header: who they are, their status and the actions on them (edit, invite, archive...). */
import Link from "next/link";
import { useCallback, useId, useState } from "react";
import { ConfirmDialog, useAction, useToast } from "@/components/AppUi";
import { AccountBadge, EmployeeStatusBadge, Modal } from "@/components/staff/ui";
import { EmployeeForm, InvitationLinkPanel, inviteEmployee, type EmployeePayload, type SharedLink } from "@/components/staff/EmployeeForm";
import { api } from "@/lib/api";
import { fmtDateTime, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

const enc = encodeURIComponent;

export function EmployeeHeader({
  employee,
  config,
  onChanged,
  onRefresh,
  onConfigStale,
}: {
  employee: EmployeeRow;
  config: StaffConfig;
  onChanged: (e: EmployeeRow) => void;
  onRefresh: () => Promise<void>;
  onConfigStale: () => void;
}) {
  const { base, can } = useStaff();
  const toast = useToast();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | "deactivate" | "reactivate" | "revoke">(null);
  const [reason, setReason] = useState("");
  const [link, setLink] = useState<SharedLink | null>(null);
  const closeEdit = useCallback(() => setEditing(false), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const uid = useId();
  const tz = config.settings.timezone;
  const manage = can("staff:manage");
  const inactive = employee.status === "inactive";
  const canInvite = manage && !inactive && employee.account !== "active";
  const firstName = employee.fullName.split(/\s+/)[0] || employee.fullName;
  const url = `${base}/employees/${enc(employee.id)}`;

  const save = async (payload: EmployeePayload) => {
    const { employee: next } = await api<{ employee: EmployeeRow }>(url, { method: "PATCH", body: payload });
    onChanged(next);
    if (payload.departmentName) onConfigStale();
    setEditing(false);
    toast("success", "Changes saved.");
  };

  const invite = (delivery: "email" | "link") =>
    run(delivery, delivery === "email" ? "send the invitation" : "create the invitation link", async () => {
      const { result, link: shared } = await inviteEmployee(base, employee.id, delivery);
      setLink(shared);
      await onRefresh();
      if (delivery === "email") return result.emailed ? `Invitation sent to ${employee.email}. It expires ${fmtDateTime(result.expiresAt, tz)}.` : undefined;
      return shared?.why === "copied" ? "Invitation link copied." : undefined;
    });

  const act = (kind: "deactivate" | "reactivate" | "revoke") =>
    run(kind, kind === "deactivate" ? "deactivate this employee" : kind === "reactivate" ? "reactivate this employee" : "revoke the invitation", async () => {
      if (kind === "revoke") {
        await api(`${url}/invitations/revoke`, { method: "POST", body: {} });
        setLink(null);
        await onRefresh();
        setConfirm(null);
        return "Invitation revoked. The link no longer works.";
      }
      const { employee: next } = await api<{ employee: EmployeeRow }>(`${url}/${kind}`, { method: "POST", body: kind === "deactivate" ? { reason: reason.trim() || null } : {} });
      onChanged(next);
      setConfirm(null);
      setReason("");
      if (kind === "deactivate") setLink(null);
      return kind === "deactivate" ? `${employee.fullName} is deactivated.` : `${employee.fullName} is active again.`;
    });

  const inv = employee.invitation;
  return (
    <section className="card animate-rise">
      <Link href="/staff/employees" className="text-xs text-muted hover:text-text">
        ← All employees
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="card-title">{employee.fullName}</h1>
          <p className="mt-0.5 text-sm text-muted">
            <span className="font-medium text-text">{employee.employeeNumber}</span> · {employee.jobTitle}
            {employee.department ? ` · ${employee.department.name}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <EmployeeStatusBadge status={employee.status} />
            <AccountBadge account={employee.account} />
          </div>
          {inactive && (
            <p className="mt-2 text-xs text-muted">
              Deactivated {employee.deactivatedAt ? fmtDateTime(employee.deactivatedAt, tz) : ""}
              {employee.deactivationReason ? `: ${employee.deactivationReason}` : "."} Their records are kept.
            </p>
          )}
          {!inactive && employee.account !== "active" && inv && !inv.acceptedAt && !inv.revokedAt && (
            <p className="mt-2 text-xs text-muted">
              Invitation {inv.emailed ? "emailed" : "link made"} {fmtDateTime(inv.sentAt, tz)} ·{" "}
              {employee.account === "expired" ? `expired ${fmtDateTime(inv.expiresAt, tz)}` : `expires ${fmtDateTime(inv.expiresAt, tz)}`}
              {inv.emailFailed && <span className="text-warn"> · the email didn&apos;t go out</span>}
            </p>
          )}
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            {canInvite && (
              <>
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void invite("email")}>
                  {busy === "email" ? "Sending…" : employee.account === "not_invited" ? "Send invitation" : "Resend invitation"}
                </button>
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void invite("link")}>
                  {busy === "link" ? "Creating link…" : "Copy invitation link"}
                </button>
              </>
            )}
            {manage && !inactive && employee.account === "invited" && (
              <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => setConfirm("revoke")}>
                Revoke invitation
              </button>
            )}
            {inactive ? (
              <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => setConfirm("reactivate")}>
                Reactivate
              </button>
            ) : (
              <button type="button" className="btn-danger" disabled={busy !== null} onClick={() => setConfirm("deactivate")}>
                Deactivate
              </button>
            )}
          </div>
        )}
      </div>
      {link && (
        <div className="mt-4">
          <InvitationLinkPanel key={link.url} link={link} name={firstName} timeZone={tz} onDismiss={() => setLink(null)} />
        </div>
      )}

      <Modal open={editing} title={`Edit ${employee.fullName}`} onClose={closeEdit} wide>
        <EmployeeForm key={`${employee.id}-${editing}`} config={config} employee={employee} submitLabel="Save changes" onSubmit={save} onCancel={closeEdit} />
      </Modal>

      <ConfirmDialog
        open={confirm === "deactivate"}
        title={`Deactivate ${employee.fullName}?`}
        confirmLabel="Deactivate"
        danger
        busy={busy === "deactivate"}
        onConfirm={() => void act("deactivate")}
        onCancel={closeConfirm}
      >
        <p>They won&apos;t be able to clock in, and any invitation they haven&apos;t used stops working.</p>
        <p>If they&apos;re clocked in right now, that shift is closed at this moment and flagged for you to check.</p>
        <p>Their hours, payroll and payment records are kept, and you can reactivate them later.</p>
        <div className="pt-1">
          <label htmlFor={`${uid}-reason`} className="label text-text">
            Reason (optional)
          </label>
          <textarea id={`${uid}-reason`} className="input min-h-16" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Left the business" />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "reactivate"}
        title={`Reactivate ${employee.fullName}?`}
        confirmLabel="Reactivate"
        busy={busy === "reactivate"}
        onConfirm={() => void act("reactivate")}
        onCancel={closeConfirm}
      >
        <p>They&apos;ll be able to clock in again.</p>
        {employee.account !== "active" && <p>They don&apos;t have an account yet: send them a new invitation once they&apos;re active.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "revoke"}
        title="Revoke the invitation?"
        confirmLabel="Revoke invitation"
        danger
        busy={busy === "revoke"}
        onConfirm={() => void act("revoke")}
        onCancel={closeConfirm}
      >
        <p>The link {firstName} was sent stops working straight away. You can send a new invitation at any time.</p>
      </ConfirmDialog>
    </section>
  );
}
