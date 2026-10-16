"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Ban,
  ChartColumnBig,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crown,
  EllipsisVertical,
  Eye,
  MailX,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Shield,
  ShieldOff,
  SlidersHorizontal,
  SquareUserRound,
  Trash2,
  UserCog,
  UserMinus,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { ACCESS_MODULE_INFO, ACCESS_PERMISSIONS, ROLE_INFO } from "@app/shared/access";
import { ROLES, type Role } from "@app/shared/roles";
import { useApp } from "@/components/AppContext";
import { ConfirmDialog, ToastProvider, useAction } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Sparkline } from "@/components/dashboard/Motion";
import { fmtRelative } from "@/components/dashboard/format";
import { AccessPanel, emailProblemText, InvitePanel } from "@/components/team/Panels";
import { api, useApi } from "@/lib/api";
import { STATUS_LABEL, type Catalog, type TeamPage, type TeamRow, type TeamRowStatus } from "@/lib/team";

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

/** Each role's colour and icon, used by the role pills and the "How access works" cards. */
const ROLE_LOOK: Record<Role, { icon: LucideIcon; pill: string; card: string; tile: string }> = {
  owner: {
    icon: Crown,
    pill: "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300",
    card: "border-amber-200/70 bg-amber-50/60 dark:border-amber-400/20 dark:bg-amber-400/5",
    tile: "bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
  },
  admin: {
    icon: UserRound,
    pill: "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300",
    card: "border-sky-200/70 bg-sky-50/60 dark:border-sky-400/20 dark:bg-sky-400/5",
    tile: "bg-sky-100 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300",
  },
  manager: {
    icon: SquareUserRound,
    pill: "bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300",
    card: "border-violet-200/70 bg-violet-50/60 dark:border-violet-400/20 dark:bg-violet-400/5",
    tile: "bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300",
  },
  analyst: {
    icon: ChartColumnBig,
    pill: "bg-blue-50 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300",
    card: "border-blue-200/70 bg-blue-50/60 dark:border-blue-400/20 dark:bg-blue-400/5",
    tile: "bg-blue-100 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300",
  },
  viewer: {
    icon: Eye,
    pill: "bg-text/[0.06] text-text/80",
    card: "border-border bg-text/[0.025]",
    tile: "bg-text/[0.07] text-text/70",
  },
  custom: {
    icon: SlidersHorizontal,
    pill: "bg-teal-50 text-teal-700 dark:bg-teal-400/10 dark:text-teal-300",
    card: "border-teal-200/70 bg-teal-50/60 dark:border-teal-400/20 dark:bg-teal-400/5",
    tile: "bg-teal-100 text-teal-600 dark:bg-teal-400/15 dark:text-teal-300",
  },
};

const STATUS_LOOK: Record<TeamRowStatus, { pill: string; dot: string }> = {
  active: { pill: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300", dot: "bg-emerald-500" },
  pending: { pill: "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300", dot: "bg-amber-500" },
  expired: { pill: "bg-text/[0.06] text-muted", dot: "bg-muted" },
  cancelled: { pill: "bg-text/[0.06] text-muted", dot: "bg-muted" },
  revoked: { pill: "bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300", dot: "bg-red-500" },
};

const AVATAR_TINTS = [
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200",
  "bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-400/15 dark:text-violet-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-400/15 dark:text-rose-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-400/15 dark:text-teal-200",
];

const KIND = new Map<string, string>(ACCESS_PERMISSIONS.map((p) => [p.key, p.kind]));

function initials(r: TeamRow): string {
  const words = (r.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words.at(-1)![0]!).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return r.email.slice(0, 2).toUpperCase();
}

function Avatar({ row }: { row: TeamRow }) {
  let h = 0;
  for (const ch of row.email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const tint = row.kind === "invitation" ? "bg-text/[0.07] text-muted" : AVATAR_TINTS[h % AVATAR_TINTS.length];
  return (
    <span aria-hidden className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${tint}`}>
      {initials(row)}
      {row.status === "active" && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-emerald-500" />}
    </span>
  );
}

function RolePill({ role }: { role: Role }) {
  const { icon: Icon, pill } = ROLE_LOOK[role];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium ${pill}`}>
      <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
      {ROLE_INFO[role].label}
    </span>
  );
}

/**
 * A row's status as the list shows it. An invitation not accepted yet says how its email went:
 * "Sent" once it went out (the latest attempt succeeded), "Not delivered" when the latest failed;
 * "Pending" only while neither is known.
 */
function statusOf(r: TeamRow): { label: string; look: { pill: string; dot: string } } {
  if (r.kind === "invitation" && r.status === "pending") {
    const sent = r.sentAt ? Date.parse(r.sentAt) : 0;
    const failed = r.sendFailedAt ? Date.parse(r.sendFailedAt) : 0;
    if (sent && sent >= failed) return { label: "Sent", look: STATUS_LOOK.active };
    if (failed) return { label: "Not delivered", look: STATUS_LOOK.revoked };
  }
  return { label: STATUS_LABEL[r.status], look: STATUS_LOOK[r.status] };
}

function StatusPill({ row }: { row: TeamRow }) {
  const { label, look } = statusOf(row);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${look.pill}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${look.dot}`} />
      {label}
    </span>
  );
}

/** What the person can see, in two lines: the sections, then how far their access goes. */
function accessLines(r: TeamRow): { title: string; note: string; full?: string } {
  if (r.role === "owner") return { title: "Everything", note: "Full access to all features" };
  if (r.role === "admin") return { title: "Management", note: "Everything except billing & ownership" };
  if (!r.modules.length) return { title: "Nothing yet", note: "No sections chosen" };
  const names = r.modules.map((m) => ACCESS_MODULE_INFO[m].label);
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
  const kinds = new Set(r.permissions.map((k) => KIND.get(k)));
  const note = kinds.has("manage") ? "Can view and make changes" : "Read-only access";
  return { title: shown, note: kinds.has("export") ? `${note}, with downloads` : note, full: names.join(", ") };
}

function AccessSummary({ row }: { row: TeamRow }) {
  const { title, note, full } = accessLines(row);
  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-medium" title={full}>{title}</span>
      <span className="block truncate text-xs text-muted">{note}</span>
    </span>
  );
}

/** The last column: when a member last signed in, or how an invitation stands. */
function lastSeen(r: TeamRow): string {
  if (r.kind === "member") return r.lastSignInAt ? (fmtRelative(r.lastSignInAt) ?? "—") : "Not signed in yet";
  if (r.status === "pending") return `Invitation sent ${fmtRelative(r.sentAt ?? r.since) ?? ""}`.trim();
  if (r.status === "expired") return `Expired ${fmtRelative(r.expiresAt) ?? ""}`.trim();
  return "Invitation cancelled";
}

type CardTone = "green" | "blue" | "violet" | "red";

const CARD_TONE: Record<CardTone, { tile: string; line: string }> = {
  green: { tile: "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300", line: "#10b981" },
  blue: { tile: "bg-sky-50 text-sky-600 dark:bg-sky-400/10 dark:text-sky-300", line: "#3b82f6" },
  violet: { tile: "bg-violet-50 text-violet-600 dark:bg-violet-400/10 dark:text-violet-300", line: "#8b5cf6" },
  red: { tile: "bg-rose-50 text-rose-600 dark:bg-rose-400/10 dark:text-rose-300", line: "#f43f5e" },
};

function SummaryCard({
  icon: Icon,
  tone,
  label,
  value,
  note,
  trend,
  testId,
}: {
  icon: LucideIcon;
  tone: CardTone;
  label: string;
  value: number | undefined;
  note: string;
  trend: number[] | undefined;
  testId: string;
}) {
  const look = CARD_TONE[tone];
  return (
    <div className="card flex min-w-0 items-start gap-4" data-testid={testId}>
      <span aria-hidden className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${look.tile}`}>
        <Icon className="h-6 w-6" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <div className="mt-1 flex items-end gap-3">
          <p className="text-3xl font-bold tabular-nums tracking-tight">{value ?? "—"}</p>
          {trend && trend.length > 1 && (
            <span className="ml-auto h-10 w-full max-w-28 min-w-0" title="Last 30 days">
              <Sparkline values={trend} color={look.line} className="h-full w-full" />
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">{note}</p>
      </div>
    </div>
  );
}

type MenuItem<T extends string> = { id: T; label: string; icon: LucideIcon; danger?: boolean };

/** A button that opens a short list of actions (keyboard: Enter/Space to open, Escape to close). */
function Menu<T extends string>({ label, items, onPick, trigger, className }: { label: string; items: Array<MenuItem<T>>; onPick(id: T): void; trigger: ReactNode; className: string }) {
  // Fixed to the viewport, so a scrolling table never clips it; it follows its button when the page
  // scrolls, and opens upwards near the bottom of the window.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const open = at !== null;
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return setAt(null);
    const height = items.length * 36 + 10;
    setAt({ top: r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - 4 - height) : r.bottom + 4, right: window.innerWidth - r.right });
  };
  const placeRef = useRef(place);
  placeRef.current = place;
  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const follow = () => placeRef.current();
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button ref={button} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => (open ? setAt(null) : place())}>
        {trigger}
      </button>
      {open && (
        <div role="menu" style={at} className="animate-rise fixed z-50 w-56 rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-lift)]">
          {items.map(({ id, label: text, icon: Icon, danger }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-text/[0.05] focus:bg-text/[0.05] focus:outline-none ${danger ? "text-danger" : ""}`}
              onClick={() => {
                setAt(null);
                onPick(id);
              }}
            >
              <Icon aria-hidden className={`h-4 w-4 shrink-0 ${danger ? "" : "text-muted"}`} />
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Act = "view" | "edit" | "role" | "resend" | "cancel" | "revoke" | "restore" | "remove";

const ACT_LOOK: Record<Act, { icon: LucideIcon; danger?: boolean }> = {
  view: { icon: Eye },
  edit: { icon: Pencil },
  role: { icon: UserCog },
  resend: { icon: Send },
  cancel: { icon: Trash2, danger: true },
  revoke: { icon: ShieldOff, danger: true },
  restore: { icon: RotateCcw },
  remove: { icon: UserMinus, danger: true },
};

function RowActions({ row, actions, onAct }: { row: TeamRow; actions: Array<[Act, string]>; onAct(a: Act): void }) {
  return (
    <Menu
      label={`Actions for ${row.email}`}
      items={actions.map(([id, label]) => ({ id, label, ...ACT_LOOK[id] }))}
      onPick={onAct}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-text/[0.04] hover:text-text"
      trigger={<MoreHorizontal aria-hidden className="h-4 w-4" />}
    />
  );
}

function TeamAccess() {
  const { workspace, me } = useApp();
  const ws = workspace.id;
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
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
        const r = await api<{ emailed: boolean; url?: string; emailProblem?: string }>(`/workspaces/${ws}/team/invitations/${row.id}/resend`, { method: "POST", headers: { "idempotency-key": `resend-${row.id}-${Date.now()}` } });
        reload();
        if (!r.emailed && r.url) {
          await navigator.clipboard?.writeText(r.url).catch(() => {});
          return `${row.email} wasn't emailed. ${emailProblemText(r.emailProblem)} The new link is on your clipboard: send it to them yourself.`;
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
  const filtered = !!(search || status || role);
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
        {r.kind === "invitation" && r.status === "pending" && r.expiresAt && <span className="block text-xs text-muted">Expires {new Date(r.expiresAt).toLocaleDateString()}</span>}
        {r.kind === "invitation" && r.status === "pending" && statusOf(r).label === "Not delivered" && <span className="block text-xs text-warn">Resend it, or share the link another way</span>}
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
          <span aria-current="page" className="font-medium">Team &amp; Access</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight">Team &amp; Access</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">Manage who can access your business dashboard and control exactly what information they can see.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary h-11 px-5" onClick={() => setInviting(true)} disabled={!catalog.data}>
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

      <section aria-label="Summary" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard testId="summary-total" icon={UsersRound} tone="green" label="Total Members" value={s?.totalMembers} trend={s?.trend?.totalMembers} note="All team members with access" />
        <SummaryCard testId="summary-active" icon={UserRound} tone="blue" label="Active Members" value={s?.activeMembers} trend={s?.trend?.activeMembers} note="Currently have access" />
        <SummaryCard testId="summary-pending" icon={Clock} tone="violet" label="Open Invitations" value={s?.pendingInvitations} trend={s?.trend?.pendingInvitations} note="Not accepted yet" />
        <SummaryCard testId="summary-ended" icon={MailX} tone="red" label="Expired or Revoked" value={s?.endedInvitations} trend={s?.trend?.endedInvitations} note="Invitations that no longer work" />
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
                    <p className="text-xs text-muted">{lastSeen(r)}</p>
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
                    <th className="px-4 py-3 font-medium">Member</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Permissions</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Last sign-in</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.kind}:${r.id}`} className="border-t border-border transition-colors hover:bg-text/[0.015]" data-testid="team-row">
                      <td className="max-w-[20rem] px-4 py-3">{person(r)}</td>
                      <td className="px-4 py-3"><RolePill role={r.role} /></td>
                      <td className="max-w-[18rem] px-4 py-3"><AccessSummary row={r} /></td>
                      <td className="px-4 py-3"><StatusPill row={r} /></td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">{lastSeen(r)}</td>
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
