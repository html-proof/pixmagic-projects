"use client";
import { useState, type FormEvent } from "react";
import { can, ROLES } from "@app/shared/roles";
import { STAFF_ROLE_HELP, STAFF_ROLE_LABEL, STAFF_ROLES, type StaffRole } from "@app/shared/staff";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api, useApi } from "@/lib/api";
import { API_KEYS_ENABLED } from "@/lib/features";

interface Members {
  members: Array<{ id: string; userId: string; email: string; name: string | null; role: string; staffRole: StaffRole | null }>;
  invitations: Array<{ id: string; email: string; role: string; staffRole: StaffRole | null; expiresAt: string }>;
}

const ROLE_HELP: Record<string, string> = {
  owner: "Everything, including billing, ownership and Staff Management",
  admin: `Manage stores, members${API_KEYS_ENABLED ? ", API keys" : ""} and Staff Management`,
  analyst: "View all dashboards",
  viewer: "View all dashboards",
};

export default function MembersPage() {
  const { workspace, me } = useApp();
  const { data, reload, error } = useApi<Members>(`/workspaces/${workspace.id}/members`);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("analyst");
  const [staffRole, setStaffRole] = useState<StaffRole | "">("");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  // The invitation link, when we couldn't email it: the inviter has to pass it on themselves.
  const [inviteLink, setInviteLink] = useState<{ email: string; url: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  const manage = can(workspace.role, "members:manage");

  const act = (p: Promise<unknown>, what: string) =>
    p.then(
      () => reload(),
      (e: unknown) => setMsg({ kind: "error", text: actionError(e, what) }),
    );

  async function invite(e: FormEvent) {
    e.preventDefault();
    const to = email;
    setInviting(true);
    setMsg(null);
    setInviteLink(null);
    try {
      const r = await api<{ ok: true; emailed: boolean; url?: string }>(`/workspaces/${workspace.id}/invitations`, { method: "POST", body: { email: to, role, staffRole: staffRole || null } });
      // Success only says "sent" when it was: the API saves the invitation even when the email
      // fails, and returns the link for exactly that case. It used to say "sent" regardless (also
      // after an error, which it overwrote) and drop the link, leaving no way to get them in.
      if (r.emailed) setMsg({ kind: "success", text: `Invitation sent to ${to}.` });
      else if (r.url) setInviteLink({ email: to, url: r.url });
      setEmail("");
      void reload();
    } catch (err) {
      setMsg({ kind: "error", text: actionError(err, "send the invitation") });
    } finally {
      setInviting(false);
    }
  }

  return (
    <section className="card space-y-4">
      <h1 className="text-lg font-semibold">Members & roles</h1>
      {error && <Alert>{error.message}</Alert>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {inviteLink && (
        <Alert kind="info">
          <span className="block">
            We saved the invitation for {inviteLink.email} but couldn&apos;t email it. Send them this link yourself; it works for 7 days:
          </span>
          <input aria-label={`Invitation link for ${inviteLink.email}`} className="input mt-2 w-full font-mono text-xs" readOnly value={inviteLink.url} onFocus={(e) => e.currentTarget.select()} data-testid="invite-link" />
        </Alert>
      )}
      <ul className="divide-y divide-border">
        {data?.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="flex-1">{m.name ?? m.email} <span className="text-muted">{m.name ? m.email : ""}{m.userId === me.user.id ? " (you)" : ""}</span></span>
            {manage ? (
              <select aria-label={`Role for ${m.email}`} className="input w-auto" value={m.role} onChange={(e) => act(api(`/workspaces/${workspace.id}/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }), "change the role")}>
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
            ) : (
              <span className="text-muted">{m.role}</span>
            )}
            {/* Staff Management access on top of the workspace role (owners and admins have it all already). */}
            {manage && m.role !== "owner" && m.role !== "admin" ? (
              <select
                aria-label={`Staff role for ${m.email}`}
                className="input w-auto"
                value={m.staffRole ?? ""}
                onChange={(e) => act(api(`/workspaces/${workspace.id}/members/${m.id}`, { method: "PATCH", body: { staffRole: e.target.value || null } }), "change the staff role")}
              >
                <option value="">No staff access</option>
                {STAFF_ROLES.map((r) => <option key={r} value={r}>{STAFF_ROLE_LABEL[r]}</option>)}
              </select>
            ) : m.staffRole ? (
              <span className="text-muted">{STAFF_ROLE_LABEL[m.staffRole]}</span>
            ) : null}
            {manage && m.userId !== me.user.id && (
              <button className="text-danger" aria-label={`Remove ${m.email}`} onClick={() => confirm(`Remove ${m.email}?`) && act(api(`/workspaces/${workspace.id}/members/${m.id}`, { method: "DELETE" }), "remove the member")}>Remove</button>
            )}
          </li>
        ))}
        {data?.invitations.map((i) => (
          <li key={i.id} className="flex items-center gap-3 py-2 text-sm text-muted">
            <span className="flex-1">{i.email} · invited</span>
            <span>{i.role}{i.staffRole ? ` · ${STAFF_ROLE_LABEL[i.staffRole]}` : ""}</span>
          </li>
        ))}
      </ul>
      {manage && (
        <form onSubmit={invite} className="flex flex-wrap gap-2">
          <input aria-label="Email to invite" className="input flex-1" type="email" required placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select aria-label="Role" className="input w-auto" value={role} onChange={(e) => setRole(e.target.value)}>
            {["admin", "analyst", "viewer"].map((r) => <option key={r}>{r}</option>)}
          </select>
          {role !== "admin" && (
            <select aria-label="Staff role" className="input w-auto" value={staffRole} onChange={(e) => setStaffRole(e.target.value as StaffRole | "")}>
              <option value="">No staff access</option>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{STAFF_ROLE_LABEL[r]}</option>)}
            </select>
          )}
          <button className="btn-primary" disabled={inviting}>{inviting ? "Inviting…" : "Invite"}</button>
        </form>
      )}
      <dl className="grid gap-1 text-xs text-muted">
        {Object.entries(ROLE_HELP).map(([r, h]) => (
          <div key={r}><dt className="inline font-medium">{r}:</dt> <dd className="inline">{h}</dd></div>
        ))}
        <div className="mt-1 font-medium">Staff roles (Staff Management; owners and admins have full access):</div>
        {STAFF_ROLES.map((r) => (
          <div key={r}><dt className="inline font-medium">{STAFF_ROLE_LABEL[r]}:</dt> <dd className="inline">{STAFF_ROLE_HELP[r]}</dd></div>
        ))}
      </dl>
    </section>
  );
}
