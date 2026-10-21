"use client";
import { ApiError } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ErrorState } from "@/components/ErrorState";
import { errorKind, canRetryLoad } from "@/lib/errorKind";

/**
 * A load that failed, why, and a way to ask again. An outage is told calmly (the loads behind these
 * pages retry it on their own); the button is for the merchant who doesn't want to wait.
 */
export function LoadError({ what, error, onRetry, busy = false }: { what: string; error: unknown; onRetry: () => void; busy?: boolean }) {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 0) return <ErrorNotice kind="network" title="Connection lost" action={<button type="button" className="btn-secondary" disabled={busy} onClick={onRetry}>{busy ? "Trying…" : "Try again"}</button>}>We couldn't load {what}. Check your internet connection and try again.</ErrorNotice>;
  return <ErrorState kind={errorKind(status)} onRetry={canRetryLoad(status) ? onRetry : undefined} busy={busy} retryAt={error instanceof ApiError ? error.retryAt : undefined} correlationId={error instanceof ApiError ? error.correlationId : undefined} retryLabel={status === 409 ? "Reload latest details" : "Try again"} />;
}

/**
 * The whole page while Insights can't be reached and nothing has loaded yet. The session is not
 * gone (only a 401 says that) and the caller keeps retrying, so this waits it out with the merchant.
 */
export function Unreachable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  return <ErrorState kind={errorKind(status)} onRetry={canRetryLoad(status) ? onRetry : undefined} correlationId={error instanceof ApiError ? error.correlationId : undefined} retryAt={error instanceof ApiError ? error.retryAt : undefined} fullPage />;
}
