"use client";
import Link from "next/link";
import { useEffect } from "react";

/**
 * A signed-in page that crashed while rendering. It sits inside the app shell, so the top bar
 * (workspace, store, navigation, sign out) stays usable and the merchant can go elsewhere.
 */
export default function AppPageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="card space-y-3" role="alert">
      <h1 className="text-lg font-semibold">This page ran into a problem</h1>
      <p className="text-sm text-muted">
        Trying again usually fixes it. If it keeps happening, <Link prefetch={false} className="underline" href="/support">contact support</Link>.
      </p>
      <div className="flex items-center gap-4 text-sm">
        <button type="button" className="btn-primary" onClick={() => retry()}>Try again</button>
        <Link className="text-muted underline" href="/dashboard">Go to the dashboard</Link>
      </div>
    </div>
  );
}
