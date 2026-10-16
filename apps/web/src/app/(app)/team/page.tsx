"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, MailWarning, MoreHorizontal, Plus, Search, UserCheck, UsersRound } from "lucide-react";
import { ACCESS_MODULE_INFO, ROLE_INFO, type AccessModule } from "@app/shared/access";
import { ROLES, type Role } from "@app/shared/roles";
import { useApp } from "@/components/AppContext";
import { ConfirmDialog, ToastProvider, useAction } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { AccessPanel, InvitePanel } from "@/components/team/Panels";
import { api, useApi } from "@/lib/api";
import { STATUS_LABEL, type Catalog, type TeamPage, type TeamRow, type TeamRowStatus } from "@/lib/team";

const STATUS_TONE: Record<TeamRowStatus, Tone> = { active: "good", pending: "warn", expired: "neutral", cancelled: "neutral", revoked: "danger" };

const STATUS_FILTERS: Array<[value: string, label: string]> = [
  ["", "All statuses"],
  ["members", "Members"],
  ["active", "Active"],
  ["revoked", "Revoked"],
  ["invitations", "Invitations"],
  ["pending", "Pending"],
  ["expired", "Expired"],
  ["cancelled", "Cancelled"],
];

const SORTS: Array<[value: string, label: string]> = [
  ["status", "Status"],
  ["name", "Name"],
  ["role", "Role"],
  ["since", "Date added"],
];

function SummaryCard({ icon: Icon, label, value, note, testId }: { icon: typeof UsersRound; label: string; value: number | undefined; note: string; testId: string }) {
  return (
    <div className="card flex items-start gap-3" data-testid={testId}>
      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Icon className="h-5 w-5" strokeWidth={1.8} />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value ?? "—"}</p>
        <p className="text-xs text-muted">{note}</p>
      </div>
    </div>
  );
}

function ModuleChips({ row }: { row: TeamRow }) {
  if (row.role === "owner" || row.role === "admin") return <span className="text-sm">Everything</span>;
  if (!row.modules.length) return <span className="text-sm text-muted">Nothing yet</span>;
  const shown = row.modules.slice(0, 3);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((m: AccessModule) => (
        <span key={m} className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs">{ACCESS_MODULE_INFO[m].label}</span>
      ))}
      {row.modules.length > shown.length && <span className="rounded-full px-1.5 py-0.5 text-xs text-muted">+{row.modules.length - shown.length} more</span>}
    </span>
  );
}

type Act = "view" | "edit" | "role" | "resend" | "cancel" | "revoke" | "restore" | "remove";

/** The row's actions menu: a button that opens a short list (keyboard: Enter/Space to open, Escape to close). */
function RowActions({ row, actions, onAct }: { row: TeamRow; actions: Array<[Act, string]>; onAct(a: Act): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!actions.length) return null;
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button type="button" className="btn-secondary h-8 px-2" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${row.email}`} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal aria-hidden className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="animate-rise absolute right-0 z-30 mt-1 w-52 rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-lift)]">
          {actions.map(([a, label]) => (
            <button
              key={a}
              type="button"
              role="menuitem"
              className={`flex w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-text/[0.05] focus:bg-text/[0.05] focus:outline-none ${a === "revoke" || a === "remove" || a === "cancel" ? "text-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                onAct(a);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamAccess() {
  const { workspace, me } = useApp();
  const ws = workspace.id;
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [sort, setSort] = useState("status");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  // Typing settles for a moment before the list is asked again.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const qs = new URLSearchParams({ sort, dir, page: String(page), pageSize: "20", ...(search ? { q: search } : {}), ...(status ? { status } : {}), ...(role ? { role } : {}) });
  const team = useApi<TeamPage>(`/workspaces/${ws}/team?${qs}`);
  const catalog = useApi<Catalog>(`/workspaces/${ws}/team/catalog`);
  const [inviting, setInviting] = useState(false);
  const [panel, setPanel] = useState<{ row: TeamRow; editing: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ act: "revoke" | "remove" | "cancel"; row: TeamRow } | null>(null);
  const { busy, run } = useAction();
  const isOwner = workspace.role === "owner";
  const s = team.data?.summary;

  const reload = () => void team.reload();

  function actionsFor(row: TeamRow): Array<[Act, string]> {
    const self = row.kind === "member" && row.userId === me.user.id;
    const ownerRow = row.role === "owner";
    const mayEdit = !self && (!ownerRow || isOwner);
    if (row.kind === "member") {
      if (row.status === "revoked") return [["view", "View permissions"], ...(mayEdit ? ([["restore", "Restore access"], ["remove", "Remove member"]] as Array<[Act, string]>) : [])];
      return [
        ["view", "View permissions"],
        ...(mayEdit ? ([["edit", "Edit permissions"], ["role", "Change role"]] as Array<[Act, string]>) : []),
        ...(mayEdit && !ownerRow ? ([["revoke", "Revoke access"]] as Array<[Act, string]>) : []),
        ...(mayEdit ? ([["remove", "Remove member"]] as Array<[Act, string]>) : []),
      ];
    }
    if (row.status === "pending") return [["view", "View permissions"], ["edit", "Edit permissions"], ["resend", "Resend invitation"], ["cancel", "Cancel invitation"]];
    if (row.status === "expired") return [["view", "View permissions"], ["resend", "Resend invitation"], ["cancel", "Cancel invitation"]];
    return [["view", "View permissions"]];
  }

  async function act(row: TeamRow, a: Act) {
    if (a === "view") return setPanel({ row, editing: false });
    if (a === "edit" || a === "role") return setPanel({ row, editing: true });
    if (a === "revoke" || a === "remove" || a === "cancel") return setConfirm({ act: a, row });
    if (a === "restore")
      return run(`restore:${row.id}`, "restore their access", async () => {
        await api(`/workspaces/${ws}/team/members/${row.id}/restore`, { method: "POST" });
        reload();
        return `${row.email} has their access back.`;
      });
    if (a === "resend")
      return run(`resend:${row.id}`, "resend the invitation", async () => {
        const r = await api<{ emailed: boolean; url?: string }>(`/workspaces/${ws}/team/invitations/${row.id}/resend`, { method: "POST", headers: { "idempotency-key": `resend-${row.id}-${Date.now()}` } });
        reload();
        if (!r.emailed && r.url) {
          await navigator.clipboard?.writeText(r.url).catch(() => {});
          return `We couldn't email ${row.email}, so the new link is on your clipboard: send it to them yourself.`;
        }
        return `Invitation sent to ${row.email} again. The earlier link no longer works.`;
      });
  }

  async function confirmed() {
    if (!confirm) return;
    const { act: a, row } = confirm;
    const ok = await run(`${a}:${row.id}`, a === "cancel" ? "cancel the invitation" : a === "revoke" ? "revoke their access" : "remove the member", async () => {
      if (a === "cancel") await api(`/workspaces/${ws}/team/invitations/${row.id}/revoke`, { method: "POST" });
      else if (a === "revoke") await api(`/workspaces/${ws}/team/members/${row.id}/revoke`, { method: "POST" });
      else await api(`/workspaces/${ws}/team/members/${row.id}`, { method: "DELETE" });
      reload();
      return a === "cancel" ? `The invitation for ${row.email} was cancelled.` : a === "revoke" ? `${row.email} can no longer open this workspace.` : `${row.email} was removed from the workspace.`;
    });
    if (ok) setConfirm(null);
  }

  const rows = team.data?.rows ?? [];
  const name = (r: TeamRow) => (
    <span className="min-w-0">
      <span className="block truncate font-medium">
        {r.name ?? r.email}
        {r.kind === "member" && r.userId === me.user.id && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
      </span>
      {r.name && <span className="block truncate text-xs text-muted">{r.email}</span>}
      {r.kind === "invitation" && r.status === "pending" && r.expiresAt && <span className="block text-xs text-muted">Expires {new Date(r.expiresAt).toLocaleDateString()}</span>}
      {r.kind === "invitation" && r.sendFailedAt && (!r.sentAt || r.sendFailedAt > r.sentAt) && <span className="block text-xs text-warn">Email not delivered: resend or share the link</span>}
    </span>
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Team &amp; Access</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">Manage who can access your business dashboard and control exactly what information they can see.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setInviting(true)} disabled={!catalog.data}>
          <Plus aria-hidden className="h-4 w-4" />
          Invite Member
        </button>
      </header>

      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard testId="summary-total" icon={UsersRound} label="Total members" value={s?.totalMembers} note="Everyone with a membership" />
        <SummaryCard testId="summary-active" icon={UserCheck} label="Active members" value={s?.activeMembers} note="Can open the dashboard now" />
        <SummaryCard testId="summary-pending" icon={Clock} label="Pending invitations" value={s?.pendingInvitations} note="Sent, not accepted yet" />
        <SummaryCard testId="summary-ended" icon={MailWarning} label="Expired or revoked" value={s?.endedInvitations} note="Invitations that no longer work" />
      </section>

      <section className="card space-y-4" aria-label="Members and invitations">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input type="search" aria-label="Search members" placeholder="Search by name or email" className="input pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select aria-label="Status" className="input w-auto" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            {STATUS_FILTERS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <select aria-label="Role filter" className="input w-auto" value={role} onChange={(e) => (setRole(e.target.value), setPage(1))}>
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_INFO[r].label}</option>
            ))}
          </select>
          <select aria-label="Sort by" className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>Sort: {l}</option>
            ))}
          </select>
          <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))} aria-label={`Sort ${dir === "asc" ? "descending" : "ascending"}`}>
            {dir === "asc" ? "↑ Asc" : "↓ Desc"}
          </button>
        </div>

        {team.error && !team.data ? (
          <LoadError what="your team" error={team.error} onRetry={reload} />
        ) : !team.data ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <p className="font-medium">{search || status || role ? "Nobody matches these filters" : "It's just you so far"}</p>
            <p className="mt-1 text-sm text-muted">{search || status || role ? "Try another search or filter." : "Invite a teammate, an agency or a client, and choose exactly what they can see."}</p>
          </div>
        ) : (
          <>
            {/* Phones and tablets: one card per person. */}
            <ul className="divide-y divide-border lg:hidden" data-testid="team-cards">
              {rows.map((r) => (
                <li key={`${r.kind}:${r.id}`} className="flex items-start gap-3 py-3" data-testid="team-row">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {name(r)}
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{ROLE_INFO[r.role].label}</span>
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </div>
                    <ModuleChips row={r} />
                  </div>
                  <RowActions row={r} actions={actionsFor(r)} onAct={(a) => void act(r, a)} />
                </li>
              ))}
            </ul>
            {/* Desktops: a table. */}
            <div className="-mx-1 hidden overflow-x-auto lg:block">
              <table className="w-full text-sm" data-testid="team-table">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-2 pb-2 font-normal">Name / Email</th>
                    <th className="px-2 pb-2 font-normal">Role</th>
                    <th className="px-2 pb-2 font-normal">Access</th>
                    <th className="px-2 pb-2 font-normal">Status</th>
                    <th className="px-2 pb-2 font-normal">Added</th>
                    <th className="px-2 pb-2 text-right font-normal">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}:${r.id}`} className="border-t border-border align-top" data-testid="team-row">
                      <td className="max-w-[18rem] px-2 py-3">{name(r)}</td>
                      <td className="whitespace-nowrap px-2 py-3">{ROLE_INFO[r.role].label}</td>
                      <td className="px-2 py-3"><ModuleChips row={r} /></td>
                      <td className="px-2 py-3"><Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge></td>
                      <td className="whitespace-nowrap px-2 py-3 text-muted">{fmtRelative(r.since)}</td>
                      <td className="px-2 py-3 text-right"><RowActions row={r} actions={actionsFor(r)} onAct={(a) => void act(r, a)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav aria-label="Pages" className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted">
                {team.data.total} {team.data.total === 1 ? "person" : "people"} · page {team.data.page} of {team.data.pages}
              </span>
              <span className="flex gap-2">
                <button type="button" className="btn-secondary h-9 px-3" disabled={team.data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
                  <ChevronLeft aria-hidden className="h-4 w-4" />
                </button>
                <button type="button" className="btn-secondary h-9 px-3" disabled={team.data.page >= team.data.pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                  <ChevronRight aria-hidden className="h-4 w-4" />
                </button>
              </span>
            </nav>
          </>
        )}
      </section>

      <section className="card text-sm text-muted" aria-labelledby="roles-h">
        <h2 id="roles-h" className="mb-2 text-sm font-semibold text-text">How access works</h2>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {(["owner", "admin", "manager", "analyst", "viewer", "custom"] satisfies Role[]).map((r) => (
            <li key={r}>
              <span className="font-medium text-text">{ROLE_INFO[r].label}:</span> {ROLE_INFO[r].description}
            </li>
          ))}
        </ul>
        <p className="mt-3">
          Changes apply to the person&apos;s very next request: taking a permission away removes that section from their dashboard straight away. Personal customer details, finance,
          payroll, managing integrations or staff, and downloads always have to be ticked one by one.
        </p>
      </section>

      {inviting && catalog.data && <InvitePanel ws={ws} catalog={catalog.data} onClose={() => setInviting(false)} onSent={reload} />}
      {panel && catalog.data && (
        <AccessPanel
          ws={ws}
          catalog={catalog.data}
          row={panel.row}
          editing={panel.editing}
          canEdit={actionsFor(panel.row).some(([a]) => a === "edit")}
          ownerRoles={isOwner}
          onClose={() => setPanel(null)}
          onSaved={reload}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.act === "cancel" ? "Cancel this invitation?" : confirm?.act === "revoke" ? "Revoke access?" : "Remove this member?"}
        confirmLabel={confirm?.act === "cancel" ? "Cancel invitation" : confirm?.act === "revoke" ? "Revoke access" : "Remove member"}
        danger
        busy={!!busy}
        onConfirm={() => void confirmed()}
        onCancel={() => setConfirm(null)}
      >
        {confirm?.act === "cancel" && <p>The link sent to {confirm.row.email} stops working straight away. You can invite them again later.</p>}
        {confirm?.act === "revoke" && <p>{confirm.row.email} won&apos;t be able to open anything in this workspace from their next request. Their permissions are kept, so you can restore access later.</p>}
        {confirm?.act === "remove" && <p>{confirm?.row.email} leaves the workspace and loses all access. To bring them back you&apos;ll need to invite them again. API keys they made stop working.</p>}
      </ConfirmDialog>
    </div>
  );
}

export default function TeamAccessPage() {
  return (
    <ToastProvider>
      <TeamAccess />
    </ToastProvider>
  );
}
