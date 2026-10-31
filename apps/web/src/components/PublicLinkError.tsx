"use client";
import { RotateCw } from "lucide-react";
import { useRetryCountdown } from "@/hooks/useRetryCountdown";
import { ApiError, safeCorrelationId } from "@/lib/apiClient";
import { errorKind } from "@/lib/errorKind";
import { ErrorPanel } from "@/components/ErrorState";
/** Customer links recover in place and never send customers into merchant administration. */
export function PublicLinkError({ error, onRetry, busy = false }: { error: unknown; onRetry: () => void; busy?: boolean }) {
  const remaining = useRetryCountdown(error instanceof ApiError ? error.retryAt : undefined);
  const status = error instanceof ApiError ? error.status : 0;
  const expired = status === 404 || status === 410;
  const reference = error instanceof ApiError ? safeCorrelationId(error.correlationId) : undefined;
  return <ErrorPanel kind={expired ? "gone" : errorKind(status)} code={status ? String(status) : "Offline"} busy={busy} reference={reference}
    title={expired ? "This link is no longer available" : status === 429 ? "Too many requests" : "We couldn't load this page"}
    body={expired ? "Open the latest link from your message, or contact the store for a new link." : status === 429 ? "Please wait a moment and try again." : "Check your connection and try again. If the problem continues, contact the store that sent you this link."}>
    {!expired && <button type="button" className="btn-primary px-5 py-2.5" disabled={busy || remaining > 0} onClick={onRetry}><RotateCw aria-hidden className="size-4" />{remaining > 0 ? `Try again in ${remaining}s` : busy ? "Trying…" : "Try again"}</button>}
  </ErrorPanel>;
}
