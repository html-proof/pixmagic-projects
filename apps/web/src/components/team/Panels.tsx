"use client";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Copy, History, Link2, Mail, MessageCircle, X } from "lucide-react";
import { isAccessKey, isRestrictedRole } from "@app/shared/access";
import type { Role } from "@app/shared/roles";
import { overlay, useToast } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { actionError, api, ApiError, useApi } from "@/lib/api";
import { STATUS_LABEL, type Catalog, type HistoryEntry, type MemberDetail, type TeamRow } from "@/lib/team";
import { PermissionEditor, type AccessDraft } from "./PermissionEditor";

/** A panel that slides in from the right (from the bottom on phones), above the page. */
export function SidePanel({ title, sub, onClose, children, footer, testId }: { title: string; sub?: ReactNode; onClose(): void; children: ReactNode; footer?: ReactNode; testId?: string }) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, []);
  return overlay(
    <div className="fixed inset-0 z-40 flex items-end justify-end bg-black/35 sm:items-stretch" onClick={onClose}>
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        data-testid={testId}
        className="animate-sheet flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:h-full sm:max-h-none sm:max-w-2xl sm:rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={id} className="text-lg font-semibold">{title}</h2>
            {sub && <div className="mt-0.5 text-sm text-muted">{sub}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-text/[0.05] hover:text-text">
            <X aria-hidden className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </aside>
    </div>,
  );
}

/** Why the email didn't go out, for the inviter (the API's `emailProblem`). */
export function emailProblemText(problem: string | undefined): string {
  return problem === "not_allowed"
    ? "Our email service can't send to this address yet (its sending account is still waiting for approval to email every address)."
    : "Sending the email failed just now.";
}

/** A link to pass on yourself: copy it, or send it on WhatsApp or from your own email. */
function ShareLink({ email, url }: { email: string; url: string }) {
  const toast = useToast();
  return (
    <>
      <span className="mt-2 flex gap-2">
        <input aria-label={`Invitation link for ${email}`} className="input w-full font-mono text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} data-testid="invite-link" />
        <button
          type="button"
          className="btn-secondary shrink-0 px-3"
          aria-label="Copy the link"
          onClick={() =>
            navigator.clipboard?.writeText(url).then(
              () => toast("success", "Link copied."),
              () => toast("error", "Couldn't copy: select the link and copy it."),
            )
          }
        >
          <Copy aria-hidden className="h-4 w-4" />
        </button>
      </span>
      <span className="mt-2 flex flex-wrap gap-2">
        <a className="btn-secondary px-3 text-xs" href={`https://wa.me/?text=${encodeURIComponent(`Here's the dashboard I've shared with you: ${url}`)}`} target="_blank" rel="noopener noreferrer">
          <MessageCircle aria-hidden className="h-4 w-4" />
          Send on WhatsApp
        </a>
        <a
          className="btn-secondary px-3 text-xs"
          href={`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("A dashboard I've shared with you")}&body=${encodeURIComponent(`Open this link to see it, no sign-up needed:\n\n${url}`)}`}
        >
          <Mail aria-hidden className="h-4 w-4" />
          Send from my email
        </a>
      </span>
    </>
  );
}

/** The link to hand over when the invitation email couldn't be sent. */
function HandOverLink({ email, url, problem }: { email: string; url: string; problem?: string }) {
  return (
    <Alert kind="info">
      <span className="block" data-testid="email-problem">
        The invitation for {email} is saved, but it wasn&apos;t emailed. {emailProblemText(problem)}
      </span>
      <span className="mt-1 block">Send them this link yourself. Opening it shows them the shared dashboard straight away, view-only, with no sign-up or password:</span>
      <ShareLink email={email} url={url} />
    </Alert>
  );
}

/** How long a new invitation's link, and the access it gives, last (renewable at any time). */
const EXPIRY_CHOICES = [7, 14, 30, 60];

/** The roles an owner or admin may pick for someone (never owner by invitation). */
const pickable = (catalog: Catalog) => catalog.roles;

export function InvitePanel({ ws, catalog, onClose, onSent }: { ws: string; catalog: Catalog; onClose(): void; onSent(): void }) {
  const toast = useToast();
  const viewer = catalog.roles.find((r) => r.id === "viewer");
  const [email, setEmail] = useState("");
  const [draft, setDraft] = useState<AccessDraft>({ role: "viewer", permissions: new Set((viewer?.template ?? []).filter(isAccessKey)), staffRole: null });
  const [message, setMessage] = useState("");
  const [days, setDays] = useState(catalog.limits.expiryDaysDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handOver, setHandOver] = useState<{ email: string; url: string; problem?: string } | null>(null);
  // One key per panel: a double click or a retried request sends one email.
  const idem = useMemo(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`), []);
  const formId = useId();

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ emailed: boolean; delivery?: string; url?: string; emailProblem?: string; replaced: number }>(`/workspaces/${ws}/team/invitations`, {
        method: "POST",
        headers: { "idempotency-key": idem },
        body: { email: email.trim(), role: draft.role, permissions: [...draft.permissions], staffRole: draft.staffRole, message: message.trim() || null, expiresInDays: days },
      });
      onSent();
      if (r.emailed) {
        toast("success", `Invitation sent to ${email.trim()}.${r.replaced ? " The earlier invitation's link no longer works." : ""}`);
        onClose();
      } else if (r.delivery === "queued") {
        toast("success", `Invitation saved. The email service is busy, so the email to ${email.trim()} goes out automatically in a minute or two.`);
        onClose();
      } else if (r.url) {
        setHandOver({ email: email.trim(), url: r.url, problem: r.emailProblem });
      }
    } catch (err) {
      setError(actionError(err, "send the invitation"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      title="Invite member"
      sub="They'll get an email with a secure link that opens a view-only dashboard of what you choose. No account or password needed."
      onClose={onClose}
      testId="invite-panel"
      footer={
        handOver ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" form={formId} className="btn-primary" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send Invitation"}
            </button>
          </>
        )
      }
    >
      {handOver ? (
        <HandOverLink {...handOver} />
      ) : (
        <form id={formId} onSubmit={send} className="space-y-5" noValidate>
          {error && <Alert>{error}</Alert>}
          <div>
            <label htmlFor={`${formId}-email`} className="label">Email address</label>
            <input id={`${formId}-email`} type="email" required autoComplete="off" placeholder="client@example.com" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <PermissionEditor catalog={catalog} draft={draft} onChange={setDraft} roles={pickable(catalog)} />
          <div>
            <label htmlFor={`${formId}-message`} className="label">Message (optional)</label>
            <textarea
              id={`${formId}-message`}
              rows={3}
              maxLength={catalog.limits.messageMax}
              className="input"
              placeholder="A note for them, shown in the email. No links: the email has its own button."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="mt-1 text-right text-xs text-muted">{message.length}/{catalog.limits.messageMax}</p>
          </div>
          <div>
            <label htmlFor={`${formId}-expiry`} className="label">Access duration</label>
            <select id={`${formId}-expiry`} className="input sm:w-56" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_CHOICES.filter((d) => d <= catalog.limits.expiryDaysMax).map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">The link and the access it gives end after this. You can renew it, change what they see, or revoke it at any time.</p>
          </div>
          <p className="rounded-lg bg-text/[0.03] px-3 py-2 text-xs text-muted">
            Anyone holding the link can open this view-only dashboard until it ends, so send it only to the person it&apos;s for. They can&apos;t change anything, and never see your
            account, billing, integrations&apos; settings or the team.
          </p>
        </form>
      )}
    </SidePanel>
  );
}

const draftOf = (role: Role, permissions: string[], staffRole: AccessDraft["staffRole"]): AccessDraft => ({
  role,
  permissions: new Set(isRestrictedRole(role) ? permissions.filter(isAccessKey) : []),
  staffRole,
});

/**
 * One member's or pending invitation's access: shown read-only, or edited and saved in one change
 * (role and permissions together). A member's save names the access it started from, so a change
 * someone else made meanwhile is never silently undone.
 */
export function AccessPanel({
  ws,
  catalog,
  row,
  editing: startEditing,
  canEdit,
  ownerRoles,
  onClose,
  onSaved,
}: {
  ws: string;
  catalog: Catalog;
  row: TeamRow;
  editing: boolean;
  canEdit: boolean;
  /** The current user is an owner: they may also make a member an owner. */
  ownerRoles: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(startEditing && canEdit);
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [draft, setDraft] = useState<AccessDraft>(() => draftOf(row.role, row.permissions, row.staffRole));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMember = row.kind === "member";

  // A member's latest access (and its fingerprint), so an edit starts from what is really there.
  useEffect(() => {
    if (!isMember) return;
    let live = true;
    api<{ member: MemberDetail }>(`/workspaces/${ws}/team/members/${row.id}`).then(
      ({ member }) => {
        if (!live) return;
        setMember(member);
        setDraft(draftOf(member.role, member.permissions, member.staffRole));
      },
      (e: unknown) => live && setError(actionError(e, "load this member's access")),
    );
    return () => {
      live = false;
    };
  }, [isMember, ws, row.id]);

  const roles = useMemo(
    () => [...(ownerRoles && isMember ? [{ id: "owner" as Role, label: "Owner", description: "Everything, including billing and ownership.", template: [], restricted: false, canManage: true }] : []), ...catalog.roles],
    [catalog.roles, ownerRoles, isMember],
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { role: draft.role, permissions: [...draft.permissions], staffRole: draft.staffRole };
      if (isMember) await api(`/workspaces/${ws}/team/members/${row.id}`, { method: "PATCH", body: { ...body, basedOn: member?.fingerprint } });
      else await api(`/workspaces/${ws}/team/invitations/${row.id}`, { method: "PATCH", body });
      toast("success", isMember ? `Access for ${row.email} updated. It applies to their next request.` : `Invitation for ${row.email} updated.`);
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "access_changed") {
        setError(e.message);
        // Show what is there now, to review and save again.
        const { member: fresh } = await api<{ member: MemberDetail }>(`/workspaces/${ws}/team/members/${row.id}`).catch(() => ({ member: null }));
        if (fresh) {
          setMember(fresh);
          setDraft(draftOf(fresh.role, fresh.permissions, fresh.staffRole));
        }
      } else setError(actionError(e, "save the changes"));
    } finally {
      setBusy(false);
    }
  }

  const status = STATUS_LABEL[member?.status ?? row.status];
  return (
    <SidePanel
      title={editing ? `Edit access: ${row.name ?? row.email}` : `Access: ${row.name ?? row.email}`}
      sub={
        <>
          {row.name ? `${row.email} · ` : ""}
          {isMember ? "Member" : "Invitation"} · {status}
          {member?.accessChangedAt ? ` · changed ${new Date(member.accessChangedAt).toLocaleDateString()}` : ""}
        </>
      }
      onClose={onClose}
      testId="access-panel"
      footer={
        editing ? (
          <>
            <button type="button" className="btn-secondary" onClick={() => (startEditing ? onClose() : setEditing(false))}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={busy || (isMember && !member)}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </>
        ) : canEdit ? (
          <button type="button" className="btn-primary" onClick={() => setEditing(true)}>
            Edit permissions
          </button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {isMember && !member && !error ? <p className="text-sm text-muted">Loading…</p> : <PermissionEditor catalog={catalog} draft={draft} onChange={setDraft} roles={roles} readOnly={!editing} />}
      </div>
    </SidePanel>
  );
}

/** An invitation's link (copied again, or just replaced), with ways to pass it on. */
export function LinkPanel({ email, url, expiresAt, replaced, onClose }: { email: string; url: string; expiresAt: string; replaced?: boolean; onClose(): void }) {
  return (
    <SidePanel title={replaced ? "New invitation link" : "Invitation link"} sub={email} onClose={onClose} testId="link-panel" footer={<button type="button" className="btn-primary" onClick={onClose}>Done</button>}>
      <div className="space-y-4 text-sm">
        <p className="flex items-start gap-2">
          <Link2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>
            {replaced ? "The old link no longer opens the dashboard. " : ""}This link opens the view-only dashboard for {email} until{" "}
            <strong>{new Date(expiresAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}</strong>, with no sign-up or password.
          </span>
        </p>
        <ShareLink email={email} url={url} />
        <p className="text-xs text-muted">Anyone holding the link can open the dashboard, so send it only to them. If it went somewhere it shouldn&apos;t, use &quot;Replace link&quot;.</p>
      </div>
    </SidePanel>
  );
}

/** What each audit action means, in the team page's words. */
const HISTORY_LABEL: Record<string, string> = {
  "member.invited": "Invited",
  "member.invitation_resent": "Invitation email sent again",
  "member.invitation_updated": "Invitation's permissions changed",
  "member.invitation_revoked": "Invitation cancelled",
  "member.invitation_renewed": "Invitation renewed",
  "member.invitation_link_copied": "Link copied by an admin",
  "member.invitation_link_replaced": "Link replaced (old link stopped working)",
  "member.link_opened": "Opened the shared dashboard from the link",
  "member.joined": "Opened the invitation for the first time",
  "member.access_changed": "Permissions changed",
  "member.access_revoked": "Access revoked",
  "member.access_restored": "Access restored",
  "member.access_renewed": "Access renewed",
  "member.removed": "Removed from the workspace",
};

function historyNote(e: HistoryEntry): string | null {
  const d = e.detail;
  const added = Array.isArray(d.added) ? d.added.length : 0;
  const removed = Array.isArray(d.removed) ? d.removed.length : 0;
  if (added || removed) return [added && `${added} permission${added === 1 ? "" : "s"} added`, removed && `${removed} removed`].filter(Boolean).join(", ");
  if (typeof d.expiresAt === "string" && e.action !== "member.joined") return `Until ${new Date(d.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
  if (d.newLink === true) return "With a new link";
  return null;
}

/** One person's access history: invitations, link openings (with the address they came from), changes. */
export function HistoryPanel({ ws, row, onClose }: { ws: string; row: TeamRow; onClose(): void }) {
  const q = row.kind === "member" ? `memberId=${encodeURIComponent(row.id)}` : `invitationId=${encodeURIComponent(row.id)}`;
  const history = useApi<{ entries: HistoryEntry[] }>(`/workspaces/${ws}/team/history?${q}`);
  return (
    <SidePanel title="Access history" sub={row.email} onClose={onClose} testId="history-panel">
      {history.error && !history.data ? (
        <Alert>{history.error.message}</Alert>
      ) : !history.data ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : history.data.entries.length === 0 ? (
        <p className="text-sm text-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="space-y-3" data-testid="history-entries">
          {history.data.entries.map((e) => {
            const note = historyNote(e);
            return (
              <li key={e.id} className="flex gap-3 rounded-xl border border-border px-3 py-2.5">
                <History aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <span className="min-w-0 text-sm">
                  <span className="block font-medium">{HISTORY_LABEL[e.action] ?? e.action}</span>
                  <span className="block text-xs text-muted">
                    {new Date(e.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    {e.actor ? ` · ${e.actor}` : ""}
                    {e.ip && e.action === "member.link_opened" ? ` · from ${e.ip}` : ""}
                  </span>
                  {note && <span className="block text-xs text-muted">{note}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </SidePanel>
  );
}
