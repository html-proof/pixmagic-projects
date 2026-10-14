"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Badge, type Tone } from "@/components/dashboard/primitives";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction } from "@/components/whatsapp/common";
import { Table, Td, Th } from "@/components/staff/ui";
import { InvitationLinkPanel, inviteEmployee, type SharedLink } from "@/components/staff/EmployeeForm";
import { api, useApi } from "@/lib/api";
import { fmtDateTime, useStaff, type StaffConfig } from "@/lib/staff";

interface InvitationRow {
  id: string;
  employee: { id: string; fullName: string; jobTitle: string; email: string };
  sentAt: string;
  expiresAt: string;
  emailed: boolean;
  emailFailed: boolean;
  status: "pending" | "expired" | "accepted" | "revoked";
  acceptedAt: string | null;
  revokedAt: string | null;
}

const STATUS: Record<InvitationRow["status"], { tone: Tone; label: string }> = {
  pending: { tone: "warn", label: "Waiting to be accepted" },
  expired: { tone: "danger", label: "Expired" },
  accepted: { tone: "good", label: "Accepted" },
  revoked: { tone: "neutral", label: "Revoked or replaced" },
};

const enc = encodeURIComponent;

export default function InvitationsPage() {
  const { base, can } = useStaff();
  const [status, setStatus] = useState<"open" | "all">("open");
  const list = useApi<{ items: InvitationRow[] }>(`${base}/invitations?status=${status}`);
  const config = useApi<StaffConfig>(`${base}/config`);
  const { busy, run } = useAction();
  const [shared, setShared] = useState<{ base: string; link: SharedLink; name: string } | null>(null);
  const [revoking, setRevoking] = useState<InvitationRow | null>(null);
  const closeRevoke = useCallback(() => setRevoking(null), []);
  const manage = can("staff:manage");
  const tz = config.data?.settings.timezone ?? "UTC";
  const hours = config.data?.settings.invitationExpiryHours;

  const send = (row: InvitationRow, delivery: "email" | "link") =>
    run(`${row.id}:${delivery}`, delivery === "email" ? "send the invitation" : "create the invitation link", async () => {
      const { result, link } = await inviteEmployee(base, row.employee.id, delivery);
      const first = row.employee.fullName.split(/\s+/)[0] || row.employee.fullName;
      setShared(link ? { base, link, name: first } : null);
      await list.reload();
      if (delivery === "email") return result.emailed ? `Invitation sent to ${row.employee.email}.` : undefined;
      return link?.why === "copied" ? "New invitation link copied. The earlier one no longer works." : undefined;
    });

  const revoke = () =>
    run("revoke", "revoke the invitation", async () => {
      if (!revoking) return;
      await api(`${base}/employees/${enc(revoking.employee.id)}/invitations/revoke`, { method: "POST", body: {} });
      setRevoking(null);
      setShared(null);
      await list.reload();
      return "Invitation revoked. The link no longer works.";
    });

  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Invitations"
        sub={
          <>
            Employees join with an invitation: by email, or a link you send them yourself. Each link works once
            {hours ? ` and expires ${hours} ${hours === 1 ? "hour" : "hours"} after it's sent` : ""}. Sending a new invitation or link replaces the earlier one.
            {can("staff:settings") && (
              <>
                {" "}
                <Link href="/staff/settings" className="text-accent underline-offset-2 hover:underline">
                  Change how long invitations last
                </Link>
                .
              </>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which invitations">
        {(
          [
            ["open", "Open"],
            ["all", "All invitations"],
          ] as const
        ).map(([v, l]) => (
          <button
            key={v}
            type="button"
            aria-pressed={status === v}
            onClick={() => setStatus(v)}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${status === v ? "border-accent bg-accent text-accent-ink" : "border-border bg-surface text-muted hover:text-text"}`}
          >
            {l}
          </button>
        ))}
        <p className="text-xs text-muted">{status === "open" ? "Waiting to be accepted, or expired without being used." : "Every invitation, including accepted and replaced ones."}</p>
      </div>

      {shared && shared.base === base && <InvitationLinkPanel key={shared.link.url} link={shared.link} name={shared.name} timeZone={tz} onDismiss={() => setShared(null)} />}

      {list.error ? (
        <LoadError what="invitations" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <Skeleton lines={4} />
      ) : items.length === 0 ? (
        <EmptyState
          title={status === "open" ? "No open invitations" : "No invitations yet"}
          body={
            status === "open"
              ? "Everyone you've invited has joined, or no one has been invited yet. Invite people from their page in All employees, or right after adding them."
              : "Invite people from their page in All employees, or right after adding them."
          }
          action={
            <Link href="/staff/employees" className="btn-secondary">
              All employees
            </Link>
          }
        />
      ) : (
        <section className={`card transition-opacity ${list.loading ? "opacity-70" : ""}`} aria-busy={list.loading}>
          <Table label="Invitations">
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Sent</Th>
                <Th>Expires</Th>
                <Th>Status</Th>
                <Th>Delivery</Th>
                {manage && <Th>Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const open = row.status === "pending" || row.status === "expired";
                const st = STATUS[row.status];
                return (
                  <tr key={row.id}>
                    <Td>
                      <Link href={`/staff/employee?id=${enc(row.employee.id)}`} className="font-medium hover:text-accent hover:underline">
                        {row.employee.fullName}
                      </Link>
                      <p className="text-xs text-muted">
                        {row.employee.jobTitle} · <span className="break-all">{row.employee.email}</span>
                      </p>
                    </Td>
                    <Td className="whitespace-nowrap">{fmtDateTime(row.sentAt, tz)}</Td>
                    <Td className="whitespace-nowrap">{row.status === "accepted" || row.status === "revoked" ? <span className="text-muted">—</span> : fmtDateTime(row.expiresAt, tz)}</Td>
                    <Td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {row.acceptedAt && <p className="mt-1 text-xs text-muted">{fmtDateTime(row.acceptedAt, tz)}</p>}
                      {row.revokedAt && <p className="mt-1 text-xs text-muted">{fmtDateTime(row.revokedAt, tz)}</p>}
                    </Td>
                    <Td>
                      {row.emailFailed ? (
                        <span className="text-warn">Email failed (link shown instead)</span>
                      ) : row.emailed ? (
                        "Emailed"
                      ) : (
                        <span className="text-muted">Link shared by you</span>
                      )}
                    </Td>
                    {manage && (
                      <Td>
                        {open ? (
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className="btn-secondary px-3 py-1" disabled={busy !== null} onClick={() => void send(row, "email")} aria-label={`Resend the invitation to ${row.employee.fullName} by email`}>
                              {busy === `${row.id}:email` ? "Sending…" : "Resend"}
                            </button>
                            <button type="button" className="btn-secondary px-3 py-1" disabled={busy !== null} onClick={() => void send(row, "link")} aria-label={`Copy a new invitation link for ${row.employee.fullName}`}>
                              {busy === `${row.id}:link` ? "Creating…" : "Copy new link"}
                            </button>
                            <button type="button" className="btn-danger px-3 py-1" disabled={busy !== null} onClick={() => setRevoking(row)} aria-label={`Revoke the invitation for ${row.employee.fullName}`}>
                              Revoke
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {items.length >= 200 && <p className="mt-3 text-xs text-muted">Showing the latest 200 invitations.</p>}
        </section>
      )}

      <ConfirmDialog open={!!revoking} title="Revoke this invitation?" confirmLabel="Revoke invitation" danger busy={busy === "revoke"} onConfirm={() => void revoke()} onCancel={closeRevoke}>
        <p>The link sent to {revoking?.employee.fullName} stops working straight away. You can send a new invitation at any time.</p>
      </ConfirmDialog>
    </>
  );
}
