"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { can } from "@app/shared/roles";
import { COUNTRY_RULES, SMS_STATUS_LABEL, TRIGGER_INFO, type SmsStatus, type SmsTrigger } from "@app/shared/sms";
import { useApp } from "@/components/AppContext";
import { overlay, useToast } from "@/components/AppUi";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { actionError, api, ApiError, isTransient } from "@/lib/api";
import type { SmsMode, SmsTemplate } from "./types";

// ---------------------------------------------------------------------------
// Shared pieces of Customer Messaging (SMS): who and where we are, status pills, money in US
// dollars, the template and country pickers, a side drawer and paged lists. App-wide pieces
// (toasts, confirm dialog, page header) are in AppUi; the rules themselves are in @app/shared/sms.
// ---------------------------------------------------------------------------

/** The current store's Customer Messaging API base, and what this member may do there. */
export function useSms() {
  const { workspace, store, allowed, me } = useApp();
  return {
    ws: workspace.id,
    store,
    base: store ? `/workspaces/${workspace.id}/stores/${store.id}/sms` : null,
    /** Change what customers receive (sender, templates, rules, campaigns, approvals, sends): owners and admins. */
    manage: can(workspace.role, "stores:manage"),
    /** See customers' masked numbers, their consent and the texts sent to them. */
    contact: allowed("customers.contact"),
    meId: me.user.id,
  };
}

// ---------------------------------------------------------------------------
// Failed actions
// ---------------------------------------------------------------------------

/** Refusals whose message the API wrote for the merchant (SmsError: a rule broken, a step to take first). */
const SAID_BY_API = new Set([400, 403, 404, 409]);

/**
 * A failed Customer Messaging action in words. The API refuses with a sentence written for the
 * merchant ("Verify the sender with AWS first", "The audience is now 212 customers…"), which
 * actionError's generic wording would hide; outages, sessions and malformed requests keep the
 * app's usual wording.
 */
export function smsError(e: unknown, what: string): string {
  if (e instanceof ApiError && !isTransient(e) && SAID_BY_API.has(e.status) && e.code !== "validation" && e.code !== "csrf" && e.message.trim()) return e.message;
  return actionError(e, what);
}

/** useAction (AppUi) with the API's own words when it refuses. Resolves true on success. */
export function useSmsAction() {
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
        toast("error", smsError(e, what));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A US-dollar amount (AWS prices texts in US dollars). Texts cost cents, so amounts under a dollar
 * keep four decimals; `—` when there is no figure.
 */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  return `US$${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n)}`;
}

/** A moment in the store's time zone: "22 Oct, 3:04 pm". */
export function fmtWhen(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** "9 pm" for an hour of the day (quiet hours). */
export const fmtHour = (h: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, h)));

/** Minutes as people say them: "right away", "45 minutes", "2 hours", "3 days". */
export function fmtDelay(minutes: number): string {
  if (!minutes) return "right away";
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

let regionNames: Intl.DisplayNames | null = null;
/** A country's name from its ISO code ("Unknown" without one). */
export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  const rule = COUNTRY_RULES[code];
  if (rule) return rule.label;
  try {
    regionNames ??= new Intl.DisplayNames(undefined, { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The countries offered in pickers: those with AWS sending rules on file first, then a few common ones. Any other code can be added. */
export const COUNTRY_CHOICES: string[] = [...Object.keys(COUNTRY_RULES), ...["IE", "SG", "HK", "MY", "PH", "AE", "ZA", "DE", "FR", "NL"].filter((c) => !(c in COUNTRY_RULES))];

/** Who did something: "You", else the member's name the API gives (`name`), else "A team member" ("bizinsights" for automatic steps). */
export const whoLabel = (userId: string | null | undefined, meId: string, name?: string | null) => (!userId ? "bizinsights" : userId === meId ? "You" : (name ?? "A team member"));

/** An audit action ("template_submitted") as a few words ("Submitted"). */
export function actionLabel(action: string): string {
  const words = action.replace(/^(template|rule|campaign|segment|sender|test_number|suppression)_/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why a message went out: an automated workflow's event, a campaign, a test, or a text sent from Send SMS. */
export function purposeLabel(purpose: string, trigger?: string | null): string {
  if (purpose === "automation") return trigger && trigger in TRIGGER_INFO ? TRIGGER_INFO[trigger as SmsTrigger].label : "Automation";
  return ({ campaign: "Campaign", test: "Test message", manual: "Sent from Send SMS" } as Record<string, string>)[purpose] ?? purpose;
}

// ---------------------------------------------------------------------------
// Status pills
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<SmsStatus, Tone> = {
  scheduled: "neutral",
  sending: "neutral",
  accepted: "neutral",
  pending: "neutral",
  delivered: "good",
  carrier_accepted: "good",
  failed: "danger",
  unknown: "warn",
  uncertain: "warn",
  opted_out: "neutral",
  skipped: "warn",
  cancelled: "neutral",
  dry_run: "neutral",
};

/** A text's status in words (with the reason as a tooltip when there is one). */
export function SmsStatusBadge({ status, why }: { status: string; why?: string | null }) {
  const label = SMS_STATUS_LABEL[status as SmsStatus] ?? status;
  return (
    <span title={why ?? undefined}>
      <Badge tone={STATUS_TONE[status as SmsStatus] ?? "neutral"}>{label}</Badge>
    </span>
  );
}

export const TEMPLATE_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  in_review: { tone: "warn", label: "In review" },
  approved: { tone: "good", label: "Approved" },
  rejected: { tone: "danger", label: "Sent back" },
  superseded: { tone: "neutral", label: "Replaced" },
  archived: { tone: "neutral", label: "Archived" },
};

export const RULE_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  pending_approval: { tone: "warn", label: "Pending approval" },
  active: { tone: "good", label: "Active" },
  paused: { tone: "warn", label: "Paused" },
  disabled: { tone: "neutral", label: "Disabled" },
};

export const CAMPAIGN_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  pending_approval: { tone: "warn", label: "Pending approval" },
  approved: { tone: "good", label: "Approved" },
  scheduled: { tone: "neutral", label: "Scheduled" },
  sending: { tone: "good", label: "Sending" },
  paused: { tone: "warn", label: "Paused" },
  completed: { tone: "good", label: "Finished" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function StatusPill({ map, status }: { map: Record<string, { tone: Tone; label: string }>; status: string }) {
  const s = map[status] ?? { tone: "neutral" as Tone, label: status.replace(/_/g, " ") };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

// ---------------------------------------------------------------------------
// The platform's mode
// ---------------------------------------------------------------------------

/** What the platform's switch means for this page: nothing sent yet, test mode, or live. */
export function ModeBanner({ mode, showLive = false }: { mode: SmsMode; showLive?: boolean }) {
  if (mode === "off") {
    return (
      <Alert kind="info">
        <strong>SMS isn&apos;t switched on for bizinsights yet.</strong> You can prepare templates, automations, segments and campaigns, but no text is sent to anyone.
      </Alert>
    );
  }
  if (mode === "sandbox") {
    return (
      <Alert kind="info">
        <strong>Your SMS account is still being verified.</strong> Test messages can be sent to approved numbers until verification is complete. Automations, campaigns and texts to customers are
        recorded in Message History instead of being sent.{" "}
        <Link className="underline" href="/messaging/settings">
          View setup requirements
        </Link>
      </Alert>
    );
  }
  return showLive ? (
    <Alert kind="success">
      <strong>Live.</strong> Automations that are on and scheduled campaigns text customers who may receive them. Every text is checked for consent and opt-outs right before it goes.
    </Alert>
  ) : null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Whether customers can be sent this template: it has an approved version and isn't archived. */
export const sendable = (t: Pick<SmsTemplate, "approvedVersion" | "status">) => t.approvedVersion !== null && t.status !== "archived";

/** A template's state in words, saying when an approved version keeps sending while an edit waits. */
export function templateState(t: SmsTemplate): string {
  if (t.status === "archived") return "Archived";
  if (t.approvedVersion !== null && t.latestVersion !== t.approvedVersion) return `Version ${t.approvedVersion} approved · edit ${TEMPLATE_STATUS[t.latestStatus ?? "draft"]?.label.toLowerCase() ?? "in draft"}`;
  return TEMPLATE_STATUS[t.status]?.label ?? t.status;
}

/** Choose one of the store's templates (filtered by the caller). */
export function TemplatePicker({
  label,
  templates,
  value,
  onChange,
  disabled = false,
  empty,
  help,
}: {
  label: string;
  templates: SmsTemplate[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Said when there is nothing to choose. */
  empty: ReactNode;
  help?: ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} disabled={disabled || !templates.length} onChange={(e) => onChange(e.target.value)}>
        <option value="">{templates.length ? "Choose a template…" : "No template to choose"}</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} · {t.category === "marketing" ? "Marketing" : "Transactional"} · {templateState(t)}
          </option>
        ))}
      </select>
      {!templates.length ? <p className="mt-1 text-xs text-muted">{empty}</p> : help ? <p className="mt-1 text-xs text-muted">{help}</p> : null}
    </div>
  );
}

/** A text as it would look on a phone. */
export function TextBubble({ children }: { children: ReactNode }) {
  return <div className="max-w-md whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-border bg-bg px-4 py-3 text-sm shadow-sm">{children}</div>;
}

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/** Pick countries: the common ones as checkable chips, any other by its two-letter code. */
export function CountryPicker({ label, value, onChange, disabled = false, help }: { label: string; value: string[]; onChange: (next: string[]) => void; disabled?: boolean; help?: ReactNode }) {
  const id = useId();
  const [other, setOther] = useState("");
  const all = [...COUNTRY_CHOICES, ...value.filter((c) => !COUNTRY_CHOICES.includes(c))];
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  const code = other.trim().toUpperCase();
  const valid = /^[A-Z]{2}$/.test(code);
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="label">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {all.map((c) => {
          const on = value.includes(c);
          return (
            <label key={c} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${on ? "border-accent bg-accent/10" : "border-border hover:bg-bg"}`}>
              <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={on} onChange={() => toggle(c)} />
              {countryName(c)} <span className="text-muted">{c}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex max-w-xs items-center gap-2">
        <label className="sr-only" htmlFor={`${id}-other`}>
          Another country&apos;s two-letter code
        </label>
        <input
          id={`${id}-other`}
          className="input h-8 w-24 py-1 text-xs uppercase"
          maxLength={2}
          placeholder="e.g. JP"
          value={other}
          onChange={(e) => setOther(e.target.value.replace(/[^a-z]/gi, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (valid && !value.includes(code)) onChange([...value, code]);
              setOther("");
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary h-8 px-3 text-xs"
          disabled={!valid || value.includes(code)}
          onClick={() => {
            onChange([...value, code]);
            setOther("");
          }}
        >
          Add country
        </button>
      </div>
      {help && <div className="mt-1 text-xs text-muted">{help}</div>}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// A panel over the page (a message's details, a customer's consent history)
// ---------------------------------------------------------------------------

/** A side panel: Escape or the backdrop closes it, focus returns where it was. */
export function Drawer({ title, sub, onClose, children }: { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, read when a key is pressed: focus moves only when the panel opens.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      // A confirm dialog opened from the panel closes first.
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]:not([data-sms-drawer])')) close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);
  return overlay(
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-labelledby={id} data-sms-drawer>
      <div className="animate-fade absolute inset-0 bg-black/45" onClick={onClose} aria-hidden />
      <div ref={ref} className="animate-sheet relative flex h-full w-full max-w-xl flex-col bg-bg shadow-2xl sm:border-l sm:border-border">
        <header className="flex items-start gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 id={id} className="truncate text-lg font-semibold">
              {title}
            </h2>
            {sub && <div className="text-xs text-muted">{sub}</div>}
          </div>
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">{children}</div>
      </div>
    </div>,
  );
}

// ---------------------------------------------------------------------------
// Paged lists ("Load more")
// ---------------------------------------------------------------------------

/**
 * A list the API pages with a cursor (`nextCursor`), loaded again whenever `path` changes (the
 * filters are in it). Only the latest request may fill the list: an older one answering late would
 * show rows for filters that are no longer selected (docs/architecture.md, "Data and state").
 */
export function usePagedList<T>(path: string | null, field: string, debounceMs = 0) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const load = useCallback(
    async (after: string | null) => {
      if (!path) return;
      const request = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const sep = path.includes("?") ? "&" : "?";
        const r = await api<Record<string, unknown>>(`${path}${after ? `${sep}cursor=${encodeURIComponent(after)}` : ""}`);
        if (request !== latest.current) return;
        const page = (r[field] as T[] | undefined) ?? [];
        setRows((prev) => (after && prev ? [...prev, ...page] : page));
        setCursor((r.nextCursor as string | null | undefined) ?? null);
      } catch (e) {
        if (request === latest.current) setError(e);
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [path, field],
  );
  useEffect(() => {
    const t = window.setTimeout(() => void load(null), debounceMs);
    return () => window.clearTimeout(t);
  }, [load, debounceMs]);
  return { rows, cursor, loading, error, loadMore: () => void load(cursor), reload: () => load(null) };
}

/** "1 customer" / "3 customers". */
export const plural = (n: number, one: string, many = `${one}s`) => `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;
