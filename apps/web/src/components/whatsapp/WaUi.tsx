"use client";
import { useCallback, useId, useState, type ReactNode } from "react";
import { renderTemplate, skipLabel, type SendValues, type TemplateComponent, type TemplateMapping } from "@app/shared/whatsapp";
import { useApp } from "@/components/AppContext";
import { useToast } from "@/components/AppUi";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { actionError, ApiError, isTransient } from "@/lib/api";
import type { WaMessage } from "./types";

// ---------------------------------------------------------------------------
// Shared pieces of WhatsApp Automation: where we are, the API's own words when it refuses,
// status pills, the WhatsApp mark and a phone-style message preview. The rules themselves are in
// @app/shared/whatsapp; paged lists, the drawer and country pickers come from the SMS area's
// MessagingUi, which does the same jobs.
// ---------------------------------------------------------------------------

/** The current store's WhatsApp API base and its tab links. */
export function useWa() {
  const { workspace, store } = useApp();
  return {
    ws: workspace.id,
    store,
    base: store ? `/workspaces/${workspace.id}/stores/${store.id}/whatsapp` : null,
  };
}

/** A link to one of the page's tabs (with extra query values). */
export const waHref = (tab: string, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ ...(tab === "overview" ? {} : { tab }), ...extra }).toString();
  return `/whatsapp${q ? `?${q}` : ""}`;
};

/** Refusals whose message the API wrote for the merchant (WhatsappError: a rule broken, a step to take first). */
const SAID_BY_API = new Set([400, 403, 404, 409, 502, 503]);

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
        toast("error", waError(e, what));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

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
};

/** A message's status in words, with the reason as a tooltip. */
export function MessageStatus({ m }: { m: Pick<WaMessage, "status" | "statusLabel" | "reasonLabel" | "errorTitle" | "direction"> }) {
  if (m.direction === "in") return <Badge tone="neutral">Received</Badge>;
  return (
    <span title={m.errorTitle ?? m.reasonLabel ?? undefined}>
      <Badge tone={MESSAGE_TONE[m.status] ?? "neutral"}>{m.statusLabel}</Badge>
    </span>
  );
}

const TEMPLATE_TONE: Record<string, Tone> = { APPROVED: "good", PENDING: "warn", IN_APPEAL: "warn", REJECTED: "danger", PAUSED: "danger", DISABLED: "danger" };
export const templateTone = (status: string): Tone => TEMPLATE_TONE[status] ?? "neutral";

export const CONNECTION_TONE: Record<string, Tone> = { active: "good", action_required: "warn", reconnect: "danger", error: "danger", disconnected: "neutral" };

export const WORKFLOW_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  active: { tone: "good", label: "On" },
  paused: { tone: "warn", label: "Paused" },
};

export const CAMPAIGN_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  scheduled: { tone: "neutral", label: "Scheduled" },
  sending: { tone: "good", label: "Sending" },
  completed: { tone: "good", label: "Finished" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function Pill({ map, status }: { map: Record<string, { tone: Tone; label: string }>; status: string }) {
  const s = map[status] ?? { tone: "neutral" as Tone, label: status.replace(/_/g, " ") };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Where a message came from, in words. */
export function sourceLabel(source: string): string {
  return ({ workflow: "Workflow", campaign: "Campaign", manual: "Sent by your team", test: "Test", team_alert: "Team alert", inbound: "From the customer" } as Record<string, string>)[source] ?? source;
}

/** Why a message wasn't sent or is waiting, in words. */
export const reasonText = (reason: string | null | undefined): string | null => {
  if (!reason) return null;
  const known: Record<string, string> = {
    waiting_for_connection: "Waiting for WhatsApp to be reconnected or finished setting up",
    sending_hours: "Waiting for sending hours",
    daily_limit: "Waiting: the daily limit was reached",
    meta_throttled: "Waiting: WhatsApp asked to slow down for a moment",
    automation_paused: "Held: automation is paused",
    uncertain: "WhatsApp didn't answer: it may or may not have been sent",
    refused: "WhatsApp refused it",
    undeliverable: "WhatsApp couldn't deliver it",
    account: "A problem with the WhatsApp account",
    nothing_to_send: "Nothing left to send",
    unreadable: "Its details couldn't be read",
  };
  return known[reason] ?? skipLabel(reason);
};

// ---------------------------------------------------------------------------
// A message as the customer sees it
// ---------------------------------------------------------------------------

/** A template filled with values (samples when `values` is null), as a WhatsApp chat bubble. */
export function TemplatePreview({ components, mapping, values, headerMedia }: { components: TemplateComponent[]; mapping: TemplateMapping | null; values?: SendValues | null; headerMedia?: string | null }) {
  const r = renderTemplate(components, mapping, values ?? null);
  const format = components.find((c) => c.type.toUpperCase() === "HEADER")?.format?.toUpperCase();
  return (
    <ChatBubble
      header={
        format && format !== "TEXT" ? (
          <div className="mb-2 flex h-20 items-center justify-center rounded-lg bg-black/5 text-xs text-muted">{headerMedia ? `${format.toLowerCase()}: ${headerMedia}` : `[${format.toLowerCase()}]`}</div>
        ) : r.header ? (
          <p className="mb-1 font-semibold">{r.header}</p>
        ) : null
      }
      body={r.body}
      footer={r.footer}
      buttons={r.buttons}
    />
  );
}

/** One WhatsApp bubble: a header, the text, the footer and the buttons under it. */
export function ChatBubble({ header, body, footer, buttons = [] }: { header?: ReactNode; body: string; footer?: string | null; buttons?: string[] }) {
  return (
    <div className="max-w-sm rounded-2xl bg-[#e7f6e9] p-3 text-sm text-[#111b21] shadow-sm dark:bg-[#1f3b2c] dark:text-[#e9edef]" data-testid="wa-preview">
      <div className="rounded-xl bg-white px-3 py-2 dark:bg-[#202c33]">
        {header}
        <p className="whitespace-pre-wrap break-words">{body || <span className="text-muted">Your message appears here.</span>}</p>
        {footer && <p className="mt-1 text-xs text-[#667781] dark:text-[#8696a0]">{footer}</p>}
      </div>
      {buttons.length > 0 && (
        <div className="mt-1 grid gap-1">
          {buttons.map((b, i) => (
            <span key={`${b}-${i}`} className="rounded-xl bg-white px-3 py-1.5 text-center text-sm font-medium text-[#027eb5] dark:bg-[#202c33] dark:text-[#53bdeb]">
              {b}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small "?" that explains a field, readable by keyboard and screen reader. */
export function Hint({ children }: { children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block align-middle">
      <button
        type="button"
        className="ml-1 grid size-5 place-items-center rounded-full border border-border text-[11px] text-muted hover:text-text"
        aria-describedby={open ? id : undefined}
        aria-label="More about this"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open && (
        <span id={id} role="tooltip" className="absolute left-0 top-6 z-30 w-64 rounded-lg border border-border bg-surface p-2 text-xs font-normal text-text shadow-lg">
          {children}
        </span>
      )}
    </span>
  );
}

/** A labelled field with an optional help line. */
export function Field({ label, htmlFor, help, children }: { label: ReactNode; htmlFor?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help && <p className="mt-1 text-xs text-muted">{help}</p>}
    </div>
  );
}
