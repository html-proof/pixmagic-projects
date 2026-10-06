"use client";
import Link from "next/link";
import { friendlyError, isTransient } from "@/lib/api";
import { Alert } from "@/components/ui";

/**
 * A load that failed, why, and a way to ask again. An outage is told calmly (the loads behind these
 * pages retry it on their own); the button is for the merchant who doesn't want to wait.
 */
export function LoadError({ what, error, onRetry, busy = false }: { what: string; error: unknown; onRetry: () => void; busy?: boolean }) {
  return (
    <Alert kind={isTransient(error) ? "info" : "error"}>
      We couldn&apos;t load {what}. {friendlyError(error)}{" "}
      <button type="button" className="underline disabled:opacity-50" onClick={onRetry} disabled={busy}>
        {busy ? "Trying…" : "Try again"}
      </button>
    </Alert>
  );
}

/**
 * The whole page while Insights can't be reached and nothing has loaded yet. The session is not
 * gone (only a 401 says that) and the caller keeps retrying, so this waits it out with the merchant
 * instead of sending them to sign in; "Sign in again" is only an escape hatch.
 */
export function Unreachable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <main className="mx-auto max-w-md space-y-3 px-4 py-12">
      <p className="text-sm font-semibold tracking-wide text-accent">Insights</p>
      <Alert kind={isTransient(error) ? "info" : "error"}>{friendlyError(error)}</Alert>
      <div className="flex items-center gap-4 text-sm">
        <button type="button" className="btn-secondary" onClick={onRetry}>Try again</button>
        <Link className="text-muted underline" href="/login">Sign in again</Link>
      </div>
    </main>
  );
}
