"use client";
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  ACCOUNT_STATUS_LABEL,
  DOMAIN_STATUS_LABEL,
  MESSAGE_STATUS_HELP,
  MESSAGE_STATUS_LABEL,
  PROVIDER_LABEL,
  type AccountStatus,
  type CheckStatus,
  type DomainStatus,
  type EmailProvider,
  type MessageStatus,
} from "@app/shared/email";
import { Badge, type Tone } from "@/components/dashboard/Primitives";

// ---------------------------------------------------------------------------------------------
// Pieces shared by the Email integrations pages. Built on the app's primitives; no rules here.
// Their look is the Stitch design's (Marketing, screens 17–19): the soft tinted boxes of
// components/automations/MarketingKit.tsx rather than outlined ones.
// ---------------------------------------------------------------------------------------------

const ACCOUNT_TONE: Record<AccountStatus, Tone> = {
  pending: "neutral",
  connected: "good",
  testing: "neutral",
  degraded: "warn",
  reauthorization_required: "danger",
  disabled: "neutral",
  revoked: "neutral",
  failed: "danger",
};
export const AccountStatusBadge = ({ status }: { status: string }) => (
  <Badge tone={ACCOUNT_TONE[status as AccountStatus] ?? "neutral"}>{ACCOUNT_STATUS_LABEL[status as AccountStatus] ?? status}</Badge>
);

const MESSAGE_TONE: Record<MessageStatus, Tone> = {
  queued: "neutral",
  processing: "neutral",
  accepted_by_provider: "good",
  delivered: "good",
  bounced: "danger",
  deferred: "warn",
  failed: "danger",
  suppressed: "neutral",
  cancelled: "neutral",
  unknown: "warn",
};
export const MessageStatusBadge = ({ status }: { status: string }) => (
  <span title={MESSAGE_STATUS_HELP[status as MessageStatus]}>
    <Badge tone={MESSAGE_TONE[status as MessageStatus] ?? "neutral"}>{MESSAGE_STATUS_LABEL[status as MessageStatus] ?? status}</Badge>
  </span>
);

const DOMAIN_TONE: Record<DomainStatus, Tone> = { unverified: "neutral", pending: "warn", verified: "good", failed: "danger", expired: "danger", recheck_required: "warn" };
export const DomainStatusBadge = ({ status }: { status: string }) => (
  <Badge tone={DOMAIN_TONE[status as DomainStatus] ?? "neutral"}>{DOMAIN_STATUS_LABEL[status as DomainStatus] ?? status}</Badge>
);

const CHECK: Record<CheckStatus, { tone: Tone; label: string }> = {
  pass: { tone: "good", label: "Passing" },
  warn: { tone: "warn", label: "Needs attention" },
  fail: { tone: "danger", label: "Failing" },
  missing: { tone: "danger", label: "Missing" },
  unknown: { tone: "neutral", label: "Can't tell" },
};
export const CheckBadge = ({ status }: { status: string | null | undefined }) =>
  status ? <Badge tone={CHECK[status as CheckStatus]?.tone ?? "neutral"}>{CHECK[status as CheckStatus]?.label ?? status}</Badge> : <Badge tone="neutral">Not checked</Badge>;

export const providerLabel = (p: string) => PROVIDER_LABEL[p as EmailProvider] ?? p;

/** The provider's mark: a coloured letter, so no third-party logo is needed. */
export function ProviderMark({ provider }: { provider: string }) {
  const google = provider === "gmail" || provider === "google_workspace";
  const microsoft = provider === "outlook" || provider === "microsoft_365";
  const [letter, cls] = google ? ["G", "bg-[#EA4335]/12 text-[#EA4335]"] : microsoft ? ["M", "bg-[#0078D4]/12 text-[#0078D4]"] : ["S", "bg-accent/12 text-accent"];
  return (
    <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded text-sm font-bold ${cls}`}>
      {letter}
    </span>
  );
}

/** A value with a copy button (DNS records, keys). */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-home-soft px-2 py-1 font-mono text-xs">{value}</code>
      <button
        type="button"
        className="shrink-0 rounded bg-home-soft p-1.5 text-muted transition outline-none hover:bg-home-soft-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked: the value is selectable */
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </span>
  );
}

/**
 * An email's HTML, shown in a sandboxed frame: no scripts, no same-origin access, no forms, no
 * navigation. Templates are sanitized on the server too; this keeps a sanitizer bug from ever
 * running code inside bizinsights.
 */
export function EmailPreviewFrame({ html, title = "Email preview", height = 420 }: { html: string; title?: string; height?: number }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'"><base target="_blank"><style>body{font-family:Arial,Helvetica,sans-serif;margin:16px;color:#111;background:#fff}</style></head><body>${html}</body></html>`;
  return <iframe title={title} sandbox="" srcDoc={doc} className="w-full rounded border border-home-line bg-white" style={{ height }} />;
}

/** A small explanation box: a soft tinted row, as the design writes its honest lines. */
export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return <div className={`rounded px-3 py-2 text-xs ${tone === "warn" ? "bg-warn/10 text-text" : "bg-home-soft text-muted"}`}>{children}</div>;
}

/** A box's small-capitals label, as the design heads a group of rows ("Sender addresses"). */
export const BOX_LABEL = "text-[11px] font-semibold tracking-wider text-muted uppercase";

/** A choice drawn as one of the design's soft rows (a radio option, a provider), the chosen one outlined in green. */
export const choiceClass = (chosen: boolean) =>
  `flex cursor-pointer gap-3 rounded-lg p-3 transition-colors ${chosen ? "bg-accent/10 ring-1 ring-accent" : "bg-home-soft hover:bg-home-soft-hover"}`;

export const relative = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};
