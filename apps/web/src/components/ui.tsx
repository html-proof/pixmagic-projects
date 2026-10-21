import type { ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { BrandLogo } from "@/components/Brand";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <p className="mb-6">
        <BrandLogo size={24} className="text-[15px] text-text" />
      </p>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-6 space-y-4">{children}</div>
      {/*
        Several failures on these pages tell the merchant to "contact support", and the Shopify
        listing has to link a privacy policy, so both live on every auth and install screen.
      */}
      <p className="mt-10 text-xs text-muted">
        <Link prefetch={false} className="underline" href="/support">Support</Link>
        {" · "}
        <Link prefetch={false} className="underline" href="/privacy">Privacy</Link>
      </p>
    </main>
  );
}

type AlertKind = "error" | "info" | "success";

const alertTone: Record<AlertKind, string> = { error: "alert-error", info: "alert-info", success: "alert-success" };

/** The glyph drawn on the alert's status disc, in the surface colour. */
const alertGlyph: Record<AlertKind, ReactNode> = {
  error: (
    <>
      <path d="M10 5.75v5" />
      <path d="M10 14.25h.01" />
    </>
  ),
  info: (
    <>
      <path d="M10 9.25v5" />
      <path d="M10 5.75h.01" />
    </>
  ),
  success: <path d="M6.5 10.25l2.4 2.4 4.6-4.9" />,
};

/** `onDismiss` adds a close button (for messages the person can act on and then clear). */
export function Alert({ kind = "error", children, onDismiss }: { kind?: AlertKind; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`alert ${alertTone[kind]}`}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false" className="mt-px shrink-0" style={{ color: "var(--tone)" }}>
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <g fill="none" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {alertGlyph[kind]}
        </g>
      </svg>
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-1 -mr-1.5 grid size-7 shrink-0 place-items-center rounded-md opacity-80 transition hover:bg-[color-mix(in_oklab,var(--tone)_12%,transparent)] hover:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--tone)] focus-visible:outline-none"
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-start gap-2 border-dashed">
      <h3 className="font-medium">{title}</h3>
      <p className="text-sm text-muted">{body}</p>
      {action}
    </div>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
