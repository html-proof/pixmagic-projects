"use client";
import Link from "next/link";
import { useRetryCountdown } from "@/hooks/useRetryCountdown";
import { useId, type ReactNode } from "react";
import { ArrowLeft, CircleHelp, LayoutDashboard, LogIn, PlugZap, RotateCw } from "lucide-react";
import { StateIllustration, type IllustrationKind } from "@/components/StateIllustration";
import { ErrorPage } from "@/components/ErrorPage";
import { MARK } from "@/components/Brand";
import { setReturnTo } from "@/lib/returnTo";
import { safeCorrelationId } from "@/lib/apiClient";
/** `code` is the HTTP status, or a word for the failures that have none. */
const states = {
  request: { code: "400", title: "Request couldn't be completed", body: "Check your details and try again. If this keeps happening, contact support." },
  timeout: { code: "408", title: "Request timed out", body: "The request took too long. Check your connection and try again." },
  conflict: { code: "409", title: "This item has changed", body: "Someone may have updated this item. Reload the latest details before trying again." },
  gone: { code: "410", title: "This link is no longer available", body: "The link has expired or the item has been removed. Request a new link from the person who sent it." },
  tooLarge: { code: "413", title: "Request is too large", body: "Reduce the amount of data or choose a smaller file, then try again." },
  rateLimit: { code: "429", title: "Too many requests", body: "Please wait a moment before trying again." },
  gateway: { code: "502", title: "Upstream service unavailable", body: "A service bizinsights relies on couldn't respond. Please try again in a moment." },
  gatewayTimeout: { code: "504", title: "Service took too long to respond", body: "A connected service didn't respond in time. Please try again shortly." },
  missing: { code: "404", title: "Item not found", body: "This item may have been removed or moved. Return to the dashboard to find the latest information." },
  notFound: { code: "404", title: "Page not found", body: "The page you're looking for doesn't exist or may have been moved. Check the address, or head back to your dashboard." },
  forbidden: { code: "403", title: "Access denied", body: "You don't have permission to view this content. Ask your workspace owner for access." },
  server: { code: "500", title: "Something went wrong", body: "This page ran into a problem. Try again, or contact support if it keeps happening." },
  unavailable: { code: "503", title: "Service temporarily unavailable", body: "bizinsights is temporarily unavailable. Please try again in a few moments." },
  session: { code: "401", title: "Session expired", body: "Sign in again to continue to your workspace." },
  network: { code: "Offline", title: "Connection lost", body: "We can't reach bizinsights. Check your internet connection and try again." },
  sync: { code: "Sync issue", title: "Data sync failed", body: "Your latest data couldn't be synced. Reports may show data from the last successful update." },
  integration: { code: "Disconnected", title: "Integration disconnected", body: "Reconnect this integration to resume updates. Workspace owners and admins can manage connections." },
  empty: { code: "No results", title: "No data found", body: "There are no results for this view. Try a different date range or adjust your filters." },
  invite: { code: "Invitation", title: "Invitation link expired", body: "This invitation is invalid, expired, or already used. Ask your workspace owner to send a new invitation." },
  validation: { code: "Check details", title: "Validation failed", body: "Check the highlighted fields and correct any missing or invalid details before submitting again." },
  payment: { code: "Billing", title: "Payment failed", body: "We couldn't complete your billing request. Check your subscription in Shopify before trying again." },
} as const;
const icon = "size-4";
export function ErrorState({ kind, onRetry, busy = false, correlationId, fullPage = false, action, retryLabel = "Try again", retryAt }: {
  kind: keyof typeof states; onRetry?: () => void; busy?: boolean; correlationId?: string; fullPage?: boolean; action?: ReactNode; retryLabel?: string; retryAt?: number;
}) {
  const remaining = useRetryCountdown(retryAt);
  const state = states[kind];
  const dashboard = (primary: boolean, label = "Go to dashboard") => <Link className={`${primary ? "btn-primary" : "btn-secondary"} px-5 py-2.5`} href="/dashboard"><LayoutDashboard aria-hidden className={icon} />{label}</Link>;
  return <ErrorPanel kind={kind} code={state.code} title={state.title} body={state.body} reference={safeCorrelationId(correlationId)} busy={busy} fullPage={fullPage}>
    {action}
    {onRetry && <button type="button" className="btn-primary px-5 py-2.5" onClick={onRetry} disabled={busy || remaining > 0}><RotateCw aria-hidden className={icon} />{remaining > 0 ? `Try again in ${remaining}s` : busy ? "Checking…" : retryLabel}</button>}
    {kind === "session" ? <Link prefetch={false} className="btn-primary px-5 py-2.5" href="/login" onClick={() => setReturnTo(window.location.pathname + window.location.search)}><LogIn aria-hidden className={icon} />Sign in again</Link>
      : kind === "integration" ? <Link className="btn-primary px-5 py-2.5" href="/settings/integrations"><PlugZap aria-hidden className={icon} />Manage connections</Link>
      : kind === "notFound" ? <>{dashboard(true)}<button type="button" className="btn-secondary px-5 py-2.5" onClick={() => { if (window.history.length > 1) window.history.back(); else window.location.assign("/dashboard"); }}><ArrowLeft aria-hidden className={icon} />Go back</button></>
      : kind === "forbidden" ? dashboard(true, "Return to dashboard") : dashboard(false)}
    <Link prefetch={false} className="btn-secondary px-5 py-2.5" href="/support"><CircleHelp aria-hidden className={icon} />Contact support</Link>
  </ErrorPanel>;
}

/**
 * The card every error state is drawn in (here, and the customer links' PublicLinkError): the
 * status code as its picture, or an illustration for a failure without one, a label, what happened,
 * what to do, and a support reference. `fullPage` sets it in the site's frame (ErrorPage).
 */
export function ErrorPanel({ kind, code, title, body, children, reference, busy = false, fullPage = false }: {
  kind: IllustrationKind; code: string; title: string; body: ReactNode; children?: ReactNode; reference?: string; busy?: boolean; fullPage?: boolean;
}) {
  const titleId = useId();
  const numeric = /^\d{3}$/.test(code);
  const panel = <section aria-labelledby={titleId} aria-busy={busy} className={`relative flex w-full flex-col items-center gap-5 overflow-hidden rounded-2xl border border-border bg-surface px-5 py-10 text-center shadow-[var(--shadow)] sm:px-10 sm:py-12 ${fullPage ? "max-w-xl" : ""}`}>
    <span aria-hidden className="absolute inset-x-12 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
    {numeric ? <ErrorCode code={code} /> : <StateIllustration kind={kind} />}
    <div className="flex flex-col items-center gap-3">
      <p className="inline-flex items-center gap-2 rounded-full border border-[color-mix(in_oklab,var(--accent)_30%,var(--border))] bg-[color-mix(in_oklab,var(--accent)_8%,var(--surface))] px-3 py-1 text-[11px] font-semibold tracking-[0.14em] text-accent uppercase">
        <span aria-hidden className="size-1.5 rounded-full bg-current" />{numeric ? `Error ${code}` : code}
      </p>
      <h1 id={titleId} className="text-2xl font-bold tracking-tight text-balance sm:text-[32px] sm:leading-tight">{title}</h1>
    </div>
    <p className="max-w-md text-[15px] leading-relaxed text-pretty text-muted">{body}</p>
    {children && <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center">{children}</div>}
    {reference && <p className="break-all text-xs text-muted">Support reference: <code className="rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono">{reference}</code></p>}
  </section>;
  return fullPage ? <ErrorPage>{panel}</ErrorPage> : panel;
}

/** The status code as the picture: the logo's green, standing on a chart's axis over its faint grid. */
function ErrorCode({ code }: { code: string }) {
  const id = useId().replace(/[^\w-]/g, "");
  return <svg viewBox="0 0 360 150" aria-hidden="true" focusable="false" className="h-auto w-64 max-w-full sm:w-80">
    <defs>
      <linearGradient id={`${id}-ink`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={MARK.stops[0]} /><stop offset="1" stopColor={MARK.stops[1]} /></linearGradient>
      <radialGradient id={`${id}-glow`}><stop offset="0" stopColor="var(--accent)" stopOpacity=".22" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></radialGradient>
    </defs>
    <ellipse cx="180" cy="78" rx="176" ry="74" fill={`url(#${id}-glow)`} />
    <path d="M20 22h320M20 57h320M20 92h320" stroke="var(--border)" strokeDasharray="3 6" />
    <path d="M20 128h320" stroke="var(--border)" strokeWidth="1.5" />
    <text x="180" y="127" textAnchor="middle" fontSize="128" fontWeight="800" letterSpacing="-6" fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" fill={`url(#${id}-ink)`}>{code}</text>
  </svg>;
}
