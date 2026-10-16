"use client";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Copy, Mail, MessageCircle, X } from "lucide-react";
import { isAccessKey, isRestrictedRole } from "@app/shared/access";
import type { Role } from "@app/shared/roles";
import { overlay, useToast } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { actionError, api, ApiError } from "@/lib/api";
import { STATUS_LABEL, type Catalog, type MemberDetail, type TeamRow } from "@/lib/team";
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
    ? "Our email service can't send to this address yet: until Amazon enables bizinsights' sending for every address, email reaches only addresses verified with it."
    : "Sending the email failed just now.";
}

/** The link to hand over when the invitation email couldn't be sent. */
function HandOverLink({ email, url, problem }: { email: string; url: string; problem?: string }) {
  const toast = useToast();
  return (
    <Alert kind="info">
      <span className="block" data-testid="email-problem">
        The invitation for {email} is saved, but it wasn&apos;t emailed. {emailProblemText(problem)}
      </span>
      <span className="mt-1 block">Send them this link yourself. Opening it shows them the shared dashboard straight away, with no sign-up or password:</span>
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
    </Alert>
  );
}

const EXPIRY_CHOICES = [1, 3, 7, 14, 30];

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
      const r = await api<{ emailed: boolean; url?: string; emailProblem?: string; replaced: number }>(`/workspaces/${ws}/team/invitations`, {
        method: "POST",
        headers: { "idempotency-key": idem },
        body: { email: email.trim(), role: draft.role, permissions: [...draft.permissions], staffRole: draft.staffRole, message: message.trim() || null, expiresInDays: days },
      });
      onSent();
      if (r.emailed) {
        toast("success", `Invitation sent to ${email.trim()}.${r.replaced ? " The earlier invitation's link no longer works." : ""}`);
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
      sub="They'll get an email with a secure link. They sign in or create an account with this address to accept."
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
            <label htmlFor={`${formId}-expiry`} className="label">Invitation expires after</label>
            <select id={`${formId}-expiry`} className="input sm:w-56" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_CHOICES.filter((d) => d <= catalog.limits.expiryDaysMax).map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1 day" : `${d} days`}
                </option>
              ))}
            </select>
          </div>
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
