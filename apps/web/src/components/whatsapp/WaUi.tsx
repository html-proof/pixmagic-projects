"use client";
import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import type { WaAutomationFix, WaAutomationIssue } from "@app/shared/whatsapp";
import { useApp } from "@/components/AppContext";
import { useToast } from "@/components/AppUi";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { actionError, ApiError, isTransient } from "@/lib/api";
import type { WaMessage } from "./types";

// ---------------------------------------------------------------------------
// Shared pieces of WhatsApp Automation (/dashboard/whatsapp-automation): where we are, the API's own
// words when it refuses, status pills, the WhatsApp mark and a phone-style bubble. The rules are in
// @app/shared/whatsapp; paged lists, the drawer and the country picker come from the SMS area's
// MessagingUi, which does the same jobs.
// ---------------------------------------------------------------------------

export const WA_PAGE = "/dashboard/whatsapp-automation";

/** The current store's WhatsApp API base. */
export function useWa() {
  const { workspace, store } = useApp();
  return { ws: workspace.id, store, base: store ? `/workspaces/${workspace.id}/stores/${store.id}/whatsapp` : null };
}

/** A link to one of the page's tabs (with extra query values). */
export const waHref = (tab: string, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ ...(tab === "overview" ? {} : { tab }), ...extra }).toString();
  return `${WA_PAGE}${q ? `?${q}` : ""}`;
};

/** Refusals whose message the API wrote for the merchant (WhatsappError: a rule broken, a step to take first). */
const SAID_BY_API = new Set([400, 403, 404, 409, 422, 429, 502, 503]);

/** A failed WhatsApp action in words: the API's own sentence when it wrote one, else the app's usual wording. */
export function waError(e: unknown, what: string): string {
  if (e instanceof ApiError && SAID_BY_API.has(e.status) && e.code !== "validation" && e.code !== "csrf" && e.message.trim() && !(isTransient(e) && e.status !== 503)) return e.message;
  return actionError(e, what);
}

/** The problems list the API sends with a refusal (`detail.problems`), when it sent one. */
export function problemsOf(e: unknown): string[] {
  const detail = e instanceof ApiError ? (e.data.detail as { problems?: unknown } | undefined) : undefined;
  return Array.isArray(detail?.problems) ? detail.problems.filter((p): p is string => typeof p === "string") : [];
}

/** useAction (AppUi) with the API's own words when it refuses. Resolves true on success. */
export function useWaAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, what: string, fn: () => Promise<string | void>) => {
      setBusy(key);
      try {
        const msg = await fn();
        if (msg) toast("success", msg);
        return true;
      } catch (e) {
        const problems = problemsOf(e);
        toast("error", problems.length ? `${waError(e, what)} ${problems.join(" ")}` : waError(e, what));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

/** A fresh key for one press of a Send button: a retried request with the same key sends once. */
export const newIdempotencyKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** WhatsApp's mark (brand colours, as Meta asks it to be shown). */
export function WhatsappIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className={className}>
      <path fill="#25D366" d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 7L3 29l6.4-2c2 1.1 4.3 1.7 6.6 1.7 7.2 0 13-5.7 13-12.8S23.2 3 16 3z" />
      <path
        fill="#fff"
        d="M22.4 18.9c-.3-.2-2-1-2.3-1.1-.3-.1-.5-.2-.8.2-.2.3-.9 1.1-1.1 1.3-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.7-1.7-1-.9-1.7-2-1.9-2.3-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.4.3-.6.1-.2 0-.5 0-.6l-1-2.5c-.3-.7-.6-.6-.8-.6h-.7c-.2 0-.6.1-.9.4-.3.3-1.2 1.2-1.2 2.9s1.2 3.3 1.4 3.6c.2.2 2.4 3.7 5.8 5.1 2.8 1.1 3.4.9 4 .8.6-.1 2-.8 2.3-1.6.3-.8.3-1.5.2-1.6-.1-.1-.3-.2-.6-.4z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Status pills
// ---------------------------------------------------------------------------

const MESSAGE_TONE: Record<string, Tone> = {
  queued: "neutral",
  sending: "neutral",
  accepted: "neutral",
  sent: "good",
  delivered: "good",
  read: "good",
  failed: "danger",
  cancelled: "neutral",
  skipped: "warn",
  received: "neutral",
};

/** A message's status in words, with its reason as a tooltip. */
export function MessageStatus({ m }: { m: Pick<WaMessage, "status" | "statusLabel" | "reasonLabel" | "errorDetail" | "direction"> }) {
  if (m.direction === "in") return <Badge tone="neutral">Received</Badge>;
  return (
    <span title={m.errorDetail ?? m.reasonLabel ?? undefined}>
      <Badge tone={MESSAGE_TONE[m.status] ?? "neutral"}>{m.status === "accepted" ? "Accepted" : m.statusLabel}</Badge>
    </span>
  );
}

export const CONNECTION_TONE: Record<string, Tone> = { pairing: "warn", connected: "good", reconnecting: "warn", logged_out: "danger", failed: "danger", disconnected: "neutral" };

export const AUTOMATION_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  active: { tone: "good", label: "On" },
  paused: { tone: "warn", label: "Paused" },
};

export const CAMPAIGN_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  scheduled: { tone: "warn", label: "Scheduled" },
  sending: { tone: "good", label: "Sending" },
  completed: { tone: "good", label: "Completed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export const SOURCE_LABEL: Record<string, string> = {
  automation: "Automation",
  campaign: "Campaign",
  manual: "Sent from the dashboard",
  test: "Test",
  verification: "Verification code",
  team_alert: "Team alert",
  reply: "Reply",
  inbound: "From the customer",
};

// ---------------------------------------------------------------------------
// Why an automation can't be switched on, with where to fix it
// ---------------------------------------------------------------------------

const FIX_LINK: Record<NonNullable<WaAutomationFix>, string> = { setup: "Go to Setup", settings: "Open Settings", templates: "Open Templates" };

/** The issues the API sends with a refusal (`detail.issues`); else its problems, with nowhere to fix them named. */
export function issuesOf(e: unknown): WaAutomationIssue[] {
  const detail = e instanceof ApiError ? (e.data.detail as { issues?: unknown } | undefined) : undefined;
  if (Array.isArray(detail?.issues)) {
    return detail.issues.filter((i): i is WaAutomationIssue => !!i && typeof (i as WaAutomationIssue).message === "string").map((i) => ({ message: i.message, fix: i.fix ?? null }));
  }
  return problemsOf(e).map((message) => ({ message, fix: null }));
}

/** Each reason on its own line, with a link to the tab that fixes it. */
export function IssueList({ issues, className = "" }: { issues: WaAutomationIssue[]; className?: string }) {
  if (!issues.length) return null;
  return (
    <ul className={`list-disc space-y-1 pl-5 text-xs text-warn ${className}`}>
      {issues.map((i) => (
        <li key={i.message}>
          <span className="text-text">{i.message}</span>
          {i.fix && (
            <>
              {" "}
              <Link className="font-medium text-accent underline" href={waHref(i.fix)}>
                {FIX_LINK[i.fix]}
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** An on/off switch with its words beside it (a checkbox announced as a switch). */
export function WaSwitch({ checked, onChange, label, disabled, testId }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <label className={`inline-flex shrink-0 items-center gap-2 text-xs font-medium ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <span className={checked ? "text-good" : "text-muted"}>{checked ? "On" : "Off"}</span>
      <input type="checkbox" role="switch" className="h-5 w-5 accent-[var(--accent)]" aria-label={label} checked={checked} disabled={disabled} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** A WhatsApp message as it looks on a phone (the store's side). */
export function WaBubble({ children, mine = true }: { children: ReactNode; mine?: boolean }) {
  return (
    <div className={`max-w-md whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm shadow-sm ${mine ? "rounded-br-sm bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]" : "rounded-bl-sm border border-border bg-surface"}`}>
      {children}
    </div>
  );
}

/** "3 minutes ago" style when recent, else a short date and time in the browser's zone. */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** A share as a percentage, or "–" with nothing to divide. */
export const fmtShare = (n: number | null | undefined) => (n == null ? "–" : `${Math.round(n * 100)}%`);
