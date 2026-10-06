"use client";
import { useState, type FormEvent } from "react";
import { canManage, useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";

interface Members {
  members: Array<{ id: string; userId: string; email: string; name: string | null; role: string }>;
  invitations: Array<{ id: string; email: string; role: string; expiresAt: string }>;
}

const ROLE_HELP: Record<string, string> = {
  owner: "Everything, including billing and deleting the workspace",
  admin: "Manage stores, members and API keys",
  analyst: "View all dashboards",
  viewer: "View all dashboards",
};

export default function MembersPage() {
  const { workspace, me } = useApp();
  const { data, reload, error } = useApi<Members>(`/workspaces/${workspace.id}/members`);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("analyst");
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const manage = canManage(workspace.role);

  const act = (p: Promise<unknown>) =>
    p.then(
      () => reload(),
      (e: Error) => setMsg({ kind: "error", text: e.message }),
    );

  async function invite(e: FormEvent) {
    e.preventDefault();
    await act(api(`/workspaces/${workspace.id}/invitations`, { method: "POST", body: { email, role } }));
    setMsg({ kind: "success", text: `Invitation sent to ${email}.` });
    setEmail("");
  }

  return (
    <section className="card space-y-4">
      <h1 className="text-lg font-semibold">Members & roles</h1>
      {error && <Alert>{error.message}</Alert>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <ul className="divide-y divide-border">
        {data?.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="flex-1">{m.name ?? m.email} <span className="text-muted">{m.name ? m.email : ""}{m.userId === me.user.id ? " (you)" : ""}</span></span>
            {manage ? (
              <select aria-label={`Role for ${m.email}`} className="input w-auto" value={m.role} onChange={(e) => act(api(`/workspaces/${workspace.id}/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }))}>
                {["owner", "admin", "analyst", "viewer"].map((r) => <option key={r}>{r}</option>)}
              </select>
            ) : (
              <span className="text-muted">{m.role}</span>
            )}
            {manage && m.userId !== me.user.id && (
              <button className="text-danger" onClick={() => confirm(`Remove ${m.email}?`) && act(api(`/workspaces/${workspace.id}/members/${m.id}`, { method: "DELETE" }))}>Remove</button>
            )}
          </li>
        ))}
        {data?.invitations.map((i) => (
          <li key={i.id} className="flex items-center gap-3 py-2 text-sm text-muted">
            <span className="flex-1">{i.email} · invited</span>
            <span>{i.role}</span>
          </li>
        ))}
      </ul>
      {manage && (
        <form onSubmit={invite} className="flex flex-wrap gap-2">
          <input aria-label="Email to invite" className="input flex-1" type="email" required placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select aria-label="Role" className="input w-auto" value={role} onChange={(e) => setRole(e.target.value)}>
            {["admin", "analyst", "viewer"].map((r) => <option key={r}>{r}</option>)}
          </select>
          <button className="btn-primary">Invite</button>
        </form>
      )}
      <dl className="grid gap-1 text-xs text-muted">
        {Object.entries(ROLE_HELP).map(([r, h]) => (
          <div key={r}><dt className="inline font-medium">{r}:</dt> <dd className="inline">{h}</dd></div>
        ))}
      </dl>
    </section>
  );
}
