"use client";
import { CalendarClock, CircleX, CreditCard, Crown, Mail, MessageCircle, MessageCircleReply, MessageSquareText, Moon, PackageCheck, ShoppingBag, ShoppingCart, Truck, Undo2, UserPlus, Users, Webhook, type LucideIcon } from "lucide-react";
import { HUB_AUTOMATION_STATUS_INFO, HUB_STATUS_INFO, type HubAutomationStatus, type HubChannel, type HubStatus, type HubTone, type HubTriggerIcon } from "@app/shared/automations";
import { useApp } from "@/components/AppContext";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { actionError, ApiError, isTransient } from "@/lib/api";
import type { ConnectionState } from "./types";

// ---------------------------------------------------------------------------
// Pieces every page of the Automations hub uses: where its API is, channel and trigger icons,
// status badges on the hub's one scale, and failed actions in the API's own words.
// ---------------------------------------------------------------------------

/** The hub's API for the open workspace, with the page's store (SMS belongs to a store; email to the workspace). */
export function useHub() {
  const { workspace, store, allowed, me } = useApp();
  const base = `/workspaces/${workspace.id}/automations`;
  const q = store ? `storeId=${encodeURIComponent(store.id)}` : "";
  return {
    ws: workspace.id,
    store,
    base,
    /** A hub path with the store attached (`path("/triggers")`, `path("/messages?status=failed")`). */
    path: (p: string) => `${base}${p}${q ? `${p.includes("?") ? "&" : "?"}${q}` : ""}`,
    meId: me.user.id,
    meEmail: me.user.email,
    auditAllowed: allowed("audit:read"),
  };
}

/** Refusals whose message the API wrote for the merchant (a rule broken, a step to take first). */
const SAID_BY_API = new Set([400, 403, 404, 409]);

export function hubError(e: unknown, what: string): string {
  if (e instanceof ApiError && !isTransient(e) && SAID_BY_API.has(e.status) && e.code !== "validation" && e.code !== "csrf" && e.message.trim()) return e.message;
  return actionError(e, what);
}

export const CHANNEL_ICON: Record<HubChannel, LucideIcon> = { sms: MessageSquareText, email: Mail, whatsapp: MessageCircle };
export const CHANNEL_NAME: Record<HubChannel, string> = { sms: "SMS", email: "Email", whatsapp: "WhatsApp" };

export function ChannelIcon({ channel, className = "h-5 w-5" }: { channel: HubChannel; className?: string }) {
  const Icon = CHANNEL_ICON[channel];
  return <Icon aria-hidden className={className} strokeWidth={1.8} />;
}

const TRIGGER_ICON: Record<HubTriggerIcon, LucideIcon> = {
  "shopping-bag": ShoppingBag,
  "credit-card": CreditCard,
  truck: Truck,
  "package-check": PackageCheck,
  "shopping-cart": ShoppingCart,
  "user-plus": UserPlus,
  "circle-x": CircleX,
  undo: Undo2,
  moon: Moon,
  crown: Crown,
  "calendar-clock": CalendarClock,
  "message-circle-reply": MessageCircleReply,
  webhook: Webhook,
  users: Users,
};

export function HubTriggerIconView({ icon, className = "h-5 w-5" }: { icon: HubTriggerIcon; className?: string }) {
  const Icon = TRIGGER_ICON[icon] ?? Webhook;
  return <Icon aria-hidden className={className} strokeWidth={1.8} />;
}

export const toneOf = (t: HubTone): Tone => (t === "bad" ? "danger" : t);

/** A message's status on the hub's scale, with what it means on hover and for screen readers. */
export function HubStatusBadge({ status }: { status: HubStatus }) {
  const info = HUB_STATUS_INFO[status];
  return (
    <span title={info.help}>
      <Badge tone={toneOf(info.tone)}>{info.label}</Badge>
    </span>
  );
}

export function AutomationStatusBadge({ status }: { status: HubAutomationStatus }) {
  const info = HUB_AUTOMATION_STATUS_INFO[status];
  return <Badge tone={toneOf(info.tone)}>{info.label}</Badge>;
}

export const CONNECTION_LABEL: Record<ConnectionState, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "good" },
  needs_attention: { label: "Needs attention", tone: "warn" },
  not_connected: { label: "Not connected", tone: "neutral" },
  unavailable: { label: "Not available", tone: "neutral" },
  elsewhere: { label: "On its own page", tone: "neutral" },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const s = CONNECTION_LABEL[state];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** A date and time in the viewer's words ("25 Oct, 14:05"), in the store's zone when given. */
export function fmtWhen(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export const fmtRate = (r: number | null) => (r === null ? null : `${Math.round(r * 1000) / 10}%`);

/** How long an automation waits, in words. */
export function delayWords(minutes: number): string {
  if (!minutes) return "Sends right away";
  if (minutes < 60) return `Waits ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 1440) return `Waits ${Math.round(minutes / 6) / 10} hour${minutes === 60 ? "" : "s"}`;
  return `Waits ${Math.round(minutes / 144) / 10} day${minutes === 1440 ? "" : "s"}`;
}
