"use client";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { StateIllustration } from "@/components/StateIllustration";
import { setReturnTo } from "@/lib/returnTo";
import { safeCorrelationId } from "@/lib/apiClient";
const states = {
  forbidden: { code: "403", title: "Access denied", body: "You don't have permission to view this content. Ask your workspace owner for access." },
  server: { code: "500", title: "Something went wrong", body: "This page ran into a problem. Try again, or contact support if it keeps happening." },
  unavailable: { code: "503", title: "Service temporarily unavailable", body: "BizInsights is temporarily unavailable. Please try again in a few moments." },
  session: { code: "401", title: "Session expired", body: "Sign in again to continue to your workspace." },
  network: { code: "NET", title: "Connection lost", body: "We can't reach BizInsights. Check your internet connection and try again." },
  sync: { code: "SYNC", title: "Data sync failed", body: "Your latest data couldn't be synced. Reports may show data from the last successful update." },
  integration: { code: "LINK", title: "Integration disconnected", body: "Reconnect this integration to resume updates. Workspace owners and admins can manage connections." },
  empty: { code: "EMPTY", title: "No data found", body: "There are no results for this view. Try a different date range or adjust your filters." },
  invite: { code: "INVITE", title: "Invitation link expired", body: "This invitation is invalid, expired, or already used. Ask your workspace owner to send a new invitation." },
  validation: { code: "FORM", title: "Validation failed", body: "Check the highlighted fields and correct any missing or invalid details before submitting again." },
  payment: { code: "PAY", title: "Payment failed", body: "We couldn't complete your billing request. Check your subscription in Shopify before trying again." },
} as const;
export function ErrorState({ kind, onRetry, busy = false, correlationId, fullPage = false, action, retryLabel = "Try again" }: {
  kind: keyof typeof states; onRetry?: () => void; busy?: boolean; correlationId?: string; fullPage?: boolean; action?: ReactNode; retryLabel?: string;
}) {
  const state = states[kind]; const titleId = useId(); const reference = safeCorrelationId(correlationId);
  return <section aria-labelledby={titleId} aria-busy={busy} className={`card flex flex-col items-center gap-5 overflow-hidden px-5 py-12 text-center sm:px-10 ${fullPage ? "mx-auto my-12 w-full max-w-2xl" : "w-full"}`}>
    <StateIllustration kind={kind} />
    <div><p className="mb-2 text-xs font-semibold tracking-widest text-muted">BIZINSIGHTS · {state.code}</p><h1 id={titleId} className="text-2xl font-semibold tracking-tight sm:text-3xl">{state.title}</h1></div>
    <p className="max-w-md text-sm leading-relaxed text-muted">{state.body}</p>
    <div className="flex flex-wrap justify-center gap-3">
      {action}
      {onRetry && <button type="button" className="btn-primary" onClick={onRetry} disabled={busy}>{busy ? "Checking…" : retryLabel}</button>}
      {kind === "session" ? <Link className="btn-primary" href="/login" onClick={() => setReturnTo(window.location.pathname + window.location.search)}>Sign in again</Link> : kind === "integration" ? <Link className="btn-primary" href="/settings/integrations">Manage connections</Link> : <Link className={kind === "forbidden" ? "btn-primary" : "btn-secondary"} href="/dashboard">{kind === "forbidden" ? "Return to dashboard" : "Go to dashboard"}</Link>}
      <Link className="btn-secondary" href="/support">Contact support</Link>
    </div>
    {reference && <p className="break-all text-xs text-muted">Support reference: {reference}</p>}
  </section>;
}
