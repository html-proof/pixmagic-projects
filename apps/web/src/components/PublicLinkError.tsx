"use client";
import { useRetryCountdown } from "@/hooks/useRetryCountdown";
import { ApiError, safeCorrelationId } from "@/lib/apiClient";
import { errorKind } from "@/lib/errorKind";
import { StateIllustration } from "@/components/StateIllustration";
/** Customer links recover in place and never send customers into merchant administration. */
export function PublicLinkError({ error, onRetry, busy = false }: { error: unknown; onRetry: () => void; busy?: boolean }) {
  const remaining = useRetryCountdown(error instanceof ApiError ? error.retryAt : undefined);
  const status = error instanceof ApiError ? error.status : 0;
  const expired = status === 404 || status === 410;
  const reference = error instanceof ApiError ? safeCorrelationId(error.correlationId) : undefined;
  return <section className="card flex flex-col items-center gap-4 px-5 py-8 text-center" aria-labelledby="public-error-title" aria-busy={busy}>
    <StateIllustration kind={expired ? "gone" : errorKind(status)} />
    <h1 id="public-error-title" className="text-xl font-semibold">{expired ? "This link is no longer available" : status === 429 ? "Too many requests" : "We couldn't load this page"}</h1>
    <p className="text-sm leading-relaxed text-muted">{expired ? "Open the latest link from your message, or contact the store for a new link." : status === 429 ? "Please wait a moment and try again." : "Check your connection and try again. If the problem continues, contact the store that sent you this link."}</p>
    {!expired && <button type="button" className="btn-primary" disabled={busy || remaining > 0} onClick={onRetry}>{remaining > 0 ? `Try again in ${remaining}s` : busy ? "Trying…" : "Try again"}</button>}
    {reference && <p className="break-all text-xs text-muted">Support reference: {reference}</p>}
  </section>;
}
