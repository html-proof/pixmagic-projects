"use client";
import { ApiError, friendlyError, isTransient } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ErrorState } from "@/components/ErrorState";
import { safeCorrelationId } from "@/lib/apiClient";
import { Alert } from "@/components/ui";

/**
 * A load that failed, why, and a way to ask again. An outage is told calmly (the loads behind these
 * pages retry it on their own); the button is for the merchant who doesn't want to wait.
 */
export function LoadError({ what, error, onRetry, busy = false }: { what: string; error: unknown; onRetry: () => void; busy?: boolean }) {
  if (error instanceof ApiError && [401, 403, 500, 502, 503, 504].includes(error.status)) {
    return <ErrorState kind={error.status === 401 ? "session" : error.status === 403 ? "forbidden" : error.status === 503 ? "unavailable" : "server"} onRetry={error.status >= 500 ? onRetry : undefined} busy={busy} correlationId={error.correlationId} />;
  }
  if (error instanceof ApiError && error.status === 0) return <ErrorNotice kind="network" title="Connection lost" action={<button type="button" className="btn-secondary" disabled={busy} onClick={onRetry}>{busy ? "Trying…" : "Try again"}</button>}>We couldn't load {what}. Check your internet connection and try again.</ErrorNotice>;
  const reference = error instanceof ApiError ? safeCorrelationId(error.correlationId) : undefined;
  return (
    <Alert kind={isTransient(error) ? "info" : "error"}>
      {error instanceof ApiError && error.status === 0 && <strong>Connection lost. </strong>}
      We couldn&apos;t load {what}. {friendlyError(error)}{" "}
      <button type="button" className="underline disabled:opacity-50" onClick={onRetry} disabled={busy}>
        {busy ? "Trying…" : "Try again"}
      </button>
      {reference && <span className="mt-1 block break-all text-xs">Support reference: {reference}</span>}
    </Alert>
  );
}

/**
 * The whole page while Insights can't be reached and nothing has loaded yet. The session is not
 * gone (only a 401 says that) and the caller keeps retrying, so this waits it out with the merchant.
 */
export function Unreachable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const kind = error instanceof ApiError
    ? error.status === 401 ? "session"
      : error.status === 403 ? "forbidden"
      : error.status === 503 ? "unavailable"
      : error.status === 0 ? "network" : "server"
    : "network";
  return <ErrorState kind={kind} onRetry={kind === "forbidden" || kind === "session" ? undefined : onRetry} correlationId={error instanceof ApiError ? error.correlationId : undefined} fullPage />;
}
