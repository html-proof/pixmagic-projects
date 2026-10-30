"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Ban, CalendarX2, CircleCheck, Link2, ChevronLeft, ChevronRight, Clock, EllipsisVertical, MailX, Plus, RotateCcw, Search, Send, Shield, UsersRound } from "lucide-react";
import { ROLE_INFO } from "@app/shared/access";
import { ROLES, type Role } from "@app/shared/roles";
import { useApp } from "@/components/AppContext";
import { ConfirmDialog, ToastProvider, useAction } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { AccessPanel, emailProblemText, HistoryPanel, InvitePanel, LinkPanel } from "@/components/team/Panels";
import { api, useApi } from "@/lib/api";
import { offeredCatalog, type Catalog, type TeamPage, type TeamRow } from "@/lib/team";
import { AccessSummary, AccessUntil, type Act, Avatar, DeliveryLine, lastSeen, ROLE_LOOK, RolePill, RowActions, StatusPill } from "@/components/team/MemberRow";
import { Menu, type MenuItem, SummaryCard } from "@/components/team/TeamUi";

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

/** "sort:dir" pairs the API understands. */
const SORTS: Array<[value: string, label: string]> = [
  ["role:asc", "Role"],
  ["status:asc", "Status"],
  ["since:desc", "Recently added"],
  ["since:asc", "Oldest first"],
  ["name:asc", "Name"],
];

/** How long a renewal gives, counted from now (the most an invitation can last). */
const RENEW_DAYS = 60;

function TeamAccess() {
  const { workspace, me, offers } = useApp();
  const ws = workspace.id;
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  // Who can see one section of the dashboard (Customer details, Finance…).
  const [section, setSection] = useState("");
  const [sortBy, setSortBy] = useState("role:asc");
  const [sort = "role", dir = "asc"] = sortBy.split(":");
  const [page, setPage] = useState(1);
  // Typing settles for a moment before the list is asked again.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const qs = new URLSearchParams({ sort, dir, page: String(page), pageSize: "20", ...(search ? { q: search } : {}), ...(status ? { status } : {}), ...(role ? { role } : {}), ...(section ? { module: section } : {}) });
  const team = useApi<TeamPage>(`/workspaces/${ws}/team?${qs}`);
  const catalogAnswer = useApi<Catalog>(`/workspaces/${ws}/team/catalog`).data;
  // Only the permissions of what this workspace offers (an App Store workspace leaves some parts out).
  const catalog = useMemo(() => (catalogAnswer ? offeredCatalog(catalogAnswer, offers) : null), [catalogAnswer, offers]);
  const [inviting, setInviting] = useState(false);
  const [panel, setPanel] = useState<{ row: TeamRow; editing: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ act: "revoke" | "remove" | "cancel" | "replace"; row: TeamRow } | null>(null);
  const [linkShown, setLinkShown] = useState<{ email: string; url: string; expiresAt: string; replaced?: boolean } | null>(null);
  const [historyOf, setHistoryOf] = useState<TeamRow | null>(null);
  const { busy, run } = useAction();
  const isOwner = workspace.role === "owner";
  const s = team.data?.summary;

  const reload = () => void team.reload();

  function actionsFor(row: TeamRow): Array<[Act, string]> {
    const self = row.kind === "member" && row.userId === me.user.id;
    const ownerRow = row.role === "owner";
    const mayEdit = !self && (!ownerRow || isOwner);
    const A = (...a: Array<[Act, string] | false>) => a.filter((x): x is [Act, string] => !!x);
    if (row.kind === "member") {
      const linked = !!row.link && mayEdit;
      if (row.status === "revoked") return A(["view", "View permissions"], mayEdit && ["restore", "Restore access"], !!row.link && ["history", "View access history"], mayEdit && ["remove", "Remove member"]);
      if (row.status === "expired") return A(["view", "View permissions"], mayEdit && ["renew", "Renew access (60 days)"], ["history", "View access history"], mayEdit && ["remove", "Remove member"]);
      return A(
        ["view", "View permissions"],
        mayEdit && ["edit", "Edit permissions"],
        mayEdit && ["role", "Change role"],
        linked && !!row.link?.copyable && ["copy", "Copy link"],
        linked && ["resend", "Resend email"],
        mayEdit && (!!row.accessExpiresAt || !!row.link) && ["renew", "Renew access (60 days)"],
        ["history", "View access history"],
        linked && ["replace", "Replace link"],
        mayEdit && !ownerRow && ["revoke", "Revoke access"],
        mayEdit && ["remove", "Remove member"],
      );
    }
    if (row.status === "pending")
      return A(
        ["view", "View permissions"],
        ["edit", "Edit permissions"],
        !!row.link?.copyable && ["copy", "Copy link"],
        ["resend", "Resend email"],
        ["renew", "Renew (60 days)"],
        ["history", "View access history"],
        ["replace", "Replace link"],
        ["cancel", "Cancel invitation"],
      );
    if (row.status === "expired") return A(["view", "View permissions"], ["renew", "Renew (60 days)"], ["resend", "Renew and resend email"], ["history", "View access history"], ["cancel", "Cancel invitation"]);
    return A(["view", "View permissions"], ["history", "View access history"]);
  }

  /** The invitation behind a row: its own, or the one a member joined from. */
  const invitationOf = (row: TeamRow) => (row.kind === "invitation" ? row.id : row.link?.invitationId);

  async function act(row: TeamRow, a: Act) {
    if (a === "view") return setPanel({ row, editing: false });
    if (a === "edit" || a === "role") return setPanel({ row, editing: true });
    if (a === "history") return setHistoryOf(row);
    if (a === "revoke" || a === "remove" || a === "cancel" || a === "replace") return setConfirm({ act: a, row });
    const inv = invitationOf(row);
    if (a === "copy" && inv)
      return run(`copy:${row.id}`, "get the link", async () => {
        const r = await api<{ url: string; expiresAt: string }>(`/workspaces/${ws}/team/invitations/${inv}/link`, { method: "POST" });
        const copied = await navigator.clipboard?.writeText(r.url).then(
          () => true,
          () => false,
        );
        setLinkShown({ email: row.email, url: r.url, expiresAt: r.expiresAt });
        return copied ? `Link for ${row.email} copied.` : `Here is the link for ${row.email}.`;
      });
    if (a === "renew")
      return run(`renew:${row.id}`, "renew the access", async () => {
        const path = row.kind === "member" ? `/workspaces/${ws}/team/members/${row.id}/renew` : `/workspaces/${ws}/team/invitations/${row.id}/renew`;
        const r = await api<{ expiresAt: string }>(path, { method: "POST", body: { days: RENEW_DAYS } });
        reload();
        return `Access for ${row.email} renewed until ${new Date(r.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}. Their link works again until then.`;
      });
    if (a === "restore")
      return run(`restore:${row.id}`, "restore their access", async () => {
        await api(`/workspaces/${ws}/team/members/${row.id}/restore`, { method: "POST" });
        reload();
        return `${row.email} has their access back.`;
      });
    if (a === "resend" && inv)
      return run(`resend:${row.id}`, "resend the invitation", async () => {
        const r = await api<{ emailed: boolean; delivery?: string; url?: string; emailProblem?: string; expiresAt: string }>(`/workspaces/${ws}/team/invitations/${inv}/resend`, {
          method: "POST",
          headers: { "idempotency-key": `resend-${inv}-${Date.now()}` },
        });
        reload();
        if (!r.emailed && r.url) {
          setLinkShown({ email: row.email, url: r.url, expiresAt: r.expiresAt });
          return `${row.email} wasn't emailed. ${emailProblemText(r.emailProblem)} Send them the link yourself.`;
        }
        if (r.delivery === "queued") return `The email service is busy: the email to ${row.email} goes out automatically in a minute or two.`;
        return `Invitation emailed to ${row.email} again, with the same link.`;
      });
  }

  async function confirmed() {
    if (!confirm) return;
    const { act: a, row } = confirm;
    const what = a === "cancel" ? "cancel the invitation" : a === "revoke" ? "revoke their access" : a === "replace" ? "replace the link" : "remove the member";
    const ok = await run(`${a}:${row.id}`, what, async () => {
      if (a === "replace") {
        const r = await api<{ url: string; expiresAt: string }>(`/workspaces/${ws}/team/invitations/${invitationOf(row)}/replace-link`, { method: "POST" });
        setLinkShown({ email: row.email, url: r.url, expiresAt: r.expiresAt, replaced: true });
        reload();
        return `The old link for ${row.email} no longer works.`;
      }
      if (a === "cancel") await api(`/workspaces/${ws}/team/invitations/${row.id}/revoke`, { method: "POST" });
      else if (a === "revoke") await api(`/workspaces/${ws}/team/members/${row.id}/revoke`, { method: "POST" });
      else await api(`/workspaces/${ws}/team/members/${row.id}`, { method: "DELETE" });
      reload();
      return a === "cancel" ? `The invitation for ${row.email} was cancelled.` : a === "revoke" ? `${row.email} can no longer open this workspace.` : `${row.email} was removed from the workspace.`;
    });
    if (ok) setConfirm(null);
  }

  const rows = team.data?.rows ?? [];
  const filtered = !!(search || status || role || section);
  const you = (r: TeamRow) => r.kind === "member" && r.userId === me.user.id;
  const person = (r: TeamRow) => (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar row={r} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">{r.name ?? r.email}</span>
          {you(r) && <span className="shrink-0 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">You</span>}
        </span>
        {r.name && <span className="block truncate text-xs text-muted">{r.email}</span>}
        <span className="block text-xs text-muted">{lastSeen(r)}</span>
      </span>
    </span>
  );
  const pageMenu: Array<MenuItem<"invitations" | "revoked" | "clear">> = [
    { id: "invitations", label: "Show invitations only", icon: Send },
    { id: "revoked", label: "Show revoked members", icon: Ban },
    ...(filtered ? [{ id: "clear" as const, label: "Clear filters", icon: RotateCcw }] : []),
  ];
  const pickPageMenu = (id: "invitations" | "revoked" | "clear") => {
    if (id === "clear") {
      setQ("");
      setRole("");
      setSection("");
    }
    setStatus(id === "clear" ? "" : id);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
          <Link href="/settings" className="inline-flex items-center gap-1 text-muted hover:text-text">
            <ChevronLeft aria-hidden className="h-4 w-4" />
            Settings
          </Link>
          <ChevronRight aria-hidden className="h-3.5 w-3.5 text-muted" />
          <span aria-current="page" className="font-medium">People &amp; access</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight">People &amp; access</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">Manage who can access your business dashboard and control exactly what information they can see.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary h-11 px-5" onClick={() => setInviting(true)} disabled={!catalog}>
              <Plus aria-hidden className="h-4 w-4" />
              Invite Member
            </button>
            <Menu
              label="More team options"
              items={pageMenu}
              onPick={pickPageMenu}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface text-muted shadow-[var(--shadow)] transition-colors hover:text-text"
              trigger={<EllipsisVertical aria-hidden className="h-4 w-4" />}
            />
          </div>
        </div>
      </header>

      <section aria-label="Summary" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <SummaryCard testId="summary-total" icon={UsersRound} tone="green" label="Total Invitations" value={s?.invitations?.total} trend={undefined} note={s ? `${s.totalMembers} ${s.totalMembers === 1 ? "member" : "members"} in the team` : "Every invitation on record"} />
        <SummaryCard testId="summary-active" icon={CircleCheck} tone="blue" label="Active Shared Access" value={s?.invitations?.active} trend={undefined} note="Opened and still working" />
        <SummaryCard testId="summary-pending" icon={Clock} tone="violet" label="Pending Invitations" value={s?.invitations?.pending} trend={s?.trend?.pendingInvitations} note="Sent, not opened yet" />
        <SummaryCard testId="summary-expired" icon={CalendarX2} tone="slate" label="Expired" value={s?.invitations?.expired} trend={undefined} note="Ended: renew to reopen" />
        <SummaryCard testId="summary-ended" icon={MailX} tone="red" label="Revoked" value={s?.invitations?.revoked} trend={undefined} note="Cancelled or access revoked" />
      </section>

      <section className="card space-y-5" aria-labelledby="members-h">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[15rem] flex-1">
            <h2 id="members-h" className="flex items-center gap-2.5 text-lg font-semibold">
              Team Members
              {team.data && (
                <span className="rounded-full bg-text/[0.06] px-2.5 py-0.5 text-xs font-medium text-muted">
                  {team.data.total} {team.data.total === 1 ? (filtered ? "match" : "member") : filtered ? "matches" : "members"}
                </span>
              )}
            </h2>
            <p className="mt-1 text-sm text-muted">Invite team members and set granular permissions for each person.</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:flex-nowrap">
            <div className="relative min-w-[12rem] flex-1 lg:w-56 lg:flex-none">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input type="search" aria-label="Search members" placeholder="Search by name or email…" className="input pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
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
            <select aria-label="Section filter" className="input w-auto" value={section} onChange={(e) => (setSection(e.target.value), setPage(1))}>
              <option value="">All sections</option>
              {catalog?.modules.map((m) => (
                <option key={m.id} value={m.id}>Can see {m.label}</option>
              ))}
            </select>
            <select aria-label="Sort by" className="input w-auto" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORTS.map(([v, l]) => (
                <option key={v} value={v}>Sort: {l}</option>
              ))}
            </select>
          </div>
        </div>

        {team.error && !team.data ? (
          <LoadError what="your team" error={team.error} onRetry={reload} />
        ) : !team.data ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-14" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <p className="font-medium">{filtered ? "Nobody matches these filters" : "It's just you so far"}</p>
            <p className="mt-1 text-sm text-muted">{filtered ? "Try another search or filter." : "Invite a teammate, an agency or a client, and choose exactly what they can see."}</p>
          </div>
        ) : (
          <>
            {/* Phones and tablets: one card per person. */}
            <ul className="divide-y divide-border lg:hidden" data-testid="team-cards">
              {rows.map((r) => (
                <li key={`${r.kind}:${r.id}`} className="flex items-start gap-3 py-4" data-testid="team-row">
                  <div className="min-w-0 flex-1 space-y-2.5">
                    {person(r)}
                    <div className="flex flex-wrap items-center gap-2">
                      <RolePill role={r.role} />
                      <StatusPill row={r} />
                    </div>
                    <AccessSummary row={r} />
                    <DeliveryLine row={r} />
                    <p className="text-xs">
                      <span className="text-muted">Access: </span>
                      <AccessUntil row={r} />
                    </p>
                  </div>
                  <RowActions row={r} actions={actionsFor(r)} onAct={(a) => void act(r, a)} />
                </li>
              ))}
            </ul>
            {/* Desktops: a table. */}
            <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
              <table className="w-full text-sm" data-testid="team-table">
                <thead className="bg-text/[0.025] text-left text-[13px] text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Recipient</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Permissions</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Expiration</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}:${r.id}`} className="border-t border-border transition-colors hover:bg-text/[0.015]" data-testid="team-row">
                      <td className="max-w-[20rem] px-4 py-3">{person(r)}</td>
                      <td className="px-4 py-3"><RolePill role={r.role} /></td>
                      <td className="max-w-[18rem] px-4 py-3"><AccessSummary row={r} /></td>
                      <td className="px-4 py-3">
                        <StatusPill row={r} />
                        <DeliveryLine row={r} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3"><AccessUntil row={r} /></td>
                      <td className="px-4 py-3 text-right"><RowActions row={r} actions={actionsFor(r)} onAct={(a) => void act(r, a)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {team.data.pages > 1 && (
              <nav aria-label="Pages" className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">
                  Page {team.data.page} of {team.data.pages}
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
            )}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="roles-h">
        <div className="flex items-start gap-3">
          <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-text/[0.05] text-text/80">
            <Shield className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h2 id="roles-h" className="text-lg font-semibold">How access works</h2>
            <p className="mt-0.5 text-sm text-muted">Choose the right role, or tick custom permissions, to control what each team member can see and do.</p>
          </div>
        </div>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {(["owner", "admin", "manager", "analyst", "viewer", "custom"] satisfies Role[]).map((r) => {
            const { icon: Icon, card, tile } = ROLE_LOOK[r];
            return (
              <li key={r} className={`flex gap-3 rounded-xl border p-4 ${card}`}>
                <span aria-hidden className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tile}`}>
                  <Icon className="h-5 w-5" strokeWidth={1.8} />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">{ROLE_INFO[r].label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">{ROLE_INFO[r].description}</span>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Changes apply to the person&apos;s very next request: taking a permission away removes that section from their dashboard straight away. Personal customer details, finance,
          payroll, managing integrations or staff, and downloads always have to be ticked one by one.
        </p>
        <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Link2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            An invitation link opens the dashboard without a sign-in, view-only, for up to 60 days (renewable). Anyone holding it can open it, so it goes only to the address you invite;
            replace it if it went somewhere it shouldn&apos;t. Managing anything needs the person&apos;s own sign-in.
          </span>
        </p>
      </section>

      {inviting && catalog && <InvitePanel ws={ws} catalog={catalog} onClose={() => setInviting(false)} onSent={reload} />}
      {linkShown && <LinkPanel {...linkShown} onClose={() => setLinkShown(null)} />}
      {historyOf && <HistoryPanel ws={ws} row={historyOf} onClose={() => setHistoryOf(null)} />}
      {panel && catalog && (
        <AccessPanel
          ws={ws}
          catalog={catalog}
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
        title={confirm?.act === "cancel" ? "Cancel this invitation?" : confirm?.act === "revoke" ? "Revoke access?" : confirm?.act === "replace" ? "Replace the link?" : "Remove this member?"}
        confirmLabel={confirm?.act === "cancel" ? "Cancel invitation" : confirm?.act === "revoke" ? "Revoke access" : confirm?.act === "replace" ? "Replace link" : "Remove member"}
        danger
        busy={!!busy}
        onConfirm={() => void confirmed()}
        onCancel={() => setConfirm(null)}
      >
        {confirm?.act === "cancel" && <p>The link sent to {confirm.row.email} stops working straight away. You can invite them again later.</p>}
        {confirm?.act === "revoke" && <p>{confirm.row.email} won&apos;t be able to open anything in this workspace from their next request, on any device, and their link stops working. Their permissions are kept, so you can restore access later.</p>}
        {confirm?.act === "replace" && <p>The link {confirm.row.email} has now stops opening the dashboard straight away, and you get a new one to send them. Dashboards already open from the old link keep working until you revoke access.</p>}
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
