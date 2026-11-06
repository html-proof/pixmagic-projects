"use client";
/** How one member or invitation shows in the Team & Access list: avatar, role, status, delivery, access and its actions. */
import { CalendarPlus, ChartColumnBig, Copy, History, Crown, EllipsisVertical, Eye, Pencil, RefreshCw, RotateCcw, Send, ShieldOff, SlidersHorizontal, SquareUserRound, Trash2, UserCog, UserMinus, UserRound, type LucideIcon } from "lucide-react";
import { ACCESS_MODULE_INFO, ACCESS_PERMISSIONS, ROLE_INFO } from "@app/shared/access";
import type { Role } from "@app/shared/roles";
import { fmtRelative } from "@/components/dashboard/format";
import { DELIVERY_HELP, DELIVERY_LABEL, STATUS_LABEL, type DeliveryStatus, type TeamRow, type TeamRowStatus } from "@/lib/team";
import { Menu } from "@/components/team/TeamUi";

// The look of the Stitch design's People and access screen (prototype v2, screen 32): a role is
// its name with a quiet icon, a status is coloured words with a dot (green active, amber waiting,
// red revoked, grey ended), on the page's own tokens rather than a colour per role.

/** Each role's icon, used by the role labels and the "How access works" list. */
export const ROLE_LOOK: Record<Role, { icon: LucideIcon }> = {
  owner: { icon: Crown },
  admin: { icon: UserRound },
  manager: { icon: SquareUserRound },
  analyst: { icon: ChartColumnBig },
  viewer: { icon: Eye },
  custom: { icon: SlidersHorizontal },
};

const STATUS_LOOK: Record<TeamRowStatus, { pill: string; dot: string }> = {
  active: { pill: "text-good", dot: "bg-good" },
  pending: { pill: "text-warn", dot: "bg-warn" },
  expired: { pill: "text-muted", dot: "bg-muted" },
  cancelled: { pill: "text-muted", dot: "bg-muted" },
  revoked: { pill: "text-danger", dot: "bg-danger" },
};

const KIND = new Map<string, string>(ACCESS_PERMISSIONS.map((p) => [p.key, p.kind]));

function initials(r: TeamRow): string {
  const words = (r.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words.at(-1)![0]!).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return r.email.slice(0, 2).toUpperCase();
}

export function Avatar({ row }: { row: TeamRow }) {
  return (
    <span aria-hidden className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-home-soft text-xs font-semibold ${row.kind === "invitation" ? "text-muted" : "text-text"}`}>
      {initials(row)}
      {row.status === "active" && <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-good" />}
    </span>
  );
}

export function RolePill({ role }: { role: Role }) {
  const { icon: Icon } = ROLE_LOOK[role];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <Icon aria-hidden className="h-3.5 w-3.5 text-muted" strokeWidth={2} />
      {ROLE_INFO[role].label}
    </span>
  );
}

/** A row's status as the list shows it: the access itself (active, pending, expired, revoked, cancelled). How its email went is a line of its own (DeliveryLine). */
function statusOf(r: TeamRow): { label: string; look: { pill: string; dot: string } } {
  return { label: STATUS_LABEL[r.status], look: STATUS_LOOK[r.status] };
}

export function StatusPill({ row }: { row: TeamRow }) {
  const { label, look } = statusOf(row);
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap ${look.pill}`}>
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${look.dot}`} />
      {label}
    </span>
  );
}

const DELIVERY_TONE: Record<DeliveryStatus, string> = {
  queued: "text-muted",
  sent: "text-muted",
  delivered: "text-good",
  delayed: "text-warn",
  bounced: "text-danger",
  complained: "text-danger",
  failed: "text-danger",
  not_allowed: "text-warn",
};

/**
 * "2 minutes ago" for something that has happened. The server's clock can be a few seconds ahead
 * of the browser's, which would otherwise read "in 1 second".
 */
const ago = (iso: string) => fmtRelative(new Date(Math.min(Date.parse(iso), Date.now())).toISOString()) ?? "";

/**
 * How the invitation's email went, as the mail provider reported it ("Email delivered" only when
 * the provider said the recipient's server took it), and whether the link has been opened.
 */
export function DeliveryLine({ row }: { row: TeamRow }) {
  const d = row.delivery;
  const opened = row.link?.lastOpenedAt;
  if (!d && !opened) return null;
  return (
    <span className="mt-1 block space-y-0.5 text-xs" data-testid="delivery-line">
      {d && (
        <span className={`block ${DELIVERY_TONE[d.status]}`} title={`${DELIVERY_HELP[d.status]}${d.error ? ` (${d.error})` : ""}`} data-delivery={d.status}>
          {DELIVERY_LABEL[d.status]}
          {d.status !== "queued" ? ` · ${ago(d.at)}` : ""}
        </span>
      )}
      {opened && (
        <span className="block text-muted">
          Link opened {row.link!.openCount > 1 ? `${row.link!.openCount} times, last ` : ""}
          {ago(opened)}
        </span>
      )}
    </span>
  );
}

/** Days from now until `iso`, to the nearest day (a 60-day invitation made a minute ago has 60 left); negative once passed. */
const daysUntil = (iso: string) => (Date.parse(iso) - Date.now()) / 86_400_000;

/** When the shared access (or, before it's opened, the invitation) ends. */
export function AccessUntil({ row }: { row: TeamRow }) {
  const until = row.kind === "member" ? row.accessExpiresAt : row.status === "cancelled" ? null : row.expiresAt;
  if (!until) return <span className="text-muted">{row.kind === "member" ? "No end date" : "—"}</span>;
  const left = daysUntil(until);
  const date = new Date(until).toLocaleDateString(undefined, { dateStyle: "medium" });
  if (left <= 0) return <span className="text-muted">Ended {date}</span>;
  const days = Math.round(left);
  return (
    <span className={left <= 7 ? "text-warn" : ""} title={new Date(until).toLocaleString()}>
      {days < 1 ? "Ends today" : days === 1 ? "1 day left" : `${days} days left`}
      <span className="block text-xs text-muted">{date}</span>
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

export function AccessSummary({ row }: { row: TeamRow }) {
  const { title, note, full } = accessLines(row);
  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-medium" title={full}>{title}</span>
      <span className="block truncate text-xs text-muted">{note}</span>
    </span>
  );
}

/** When a member last signed in to their own account, or how an invitation stands. */
export function lastSeen(r: TeamRow): string {
  if (r.kind === "member") return r.lastSignInAt ? `Signed in ${fmtRelative(r.lastSignInAt) ?? ""}`.trim() : r.link ? "Uses the shared link" : "Not signed in yet";
  if (r.status === "pending") return `Invited ${fmtRelative(r.since) ?? ""}`.trim();
  if (r.status === "expired") return `Expired ${fmtRelative(r.expiresAt) ?? ""}`.trim();
  return "Invitation cancelled";
}

export type Act = "view" | "edit" | "role" | "copy" | "resend" | "renew" | "history" | "replace" | "cancel" | "revoke" | "restore" | "remove";

const ACT_LOOK: Record<Act, { icon: LucideIcon; danger?: boolean }> = {
  view: { icon: Eye },
  edit: { icon: Pencil },
  role: { icon: UserCog },
  copy: { icon: Copy },
  resend: { icon: Send },
  renew: { icon: CalendarPlus },
  history: { icon: History },
  replace: { icon: RefreshCw, danger: true },
  cancel: { icon: Trash2, danger: true },
  revoke: { icon: ShieldOff, danger: true },
  restore: { icon: RotateCcw },
  remove: { icon: UserMinus, danger: true },
};

export function RowActions({ row, actions, onAct }: { row: TeamRow; actions: Array<[Act, string]>; onAct(a: Act): void }) {
  return (
    <Menu
      label={`Actions for ${row.email}`}
      items={actions.map(([id, label]) => ({ id, label, ...ACT_LOOK[id] }))}
      onPick={onAct}
      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted transition-colors outline-none hover:bg-home-soft hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
      trigger={<EllipsisVertical aria-hidden className="h-4 w-4" />}
    />
  );
}
