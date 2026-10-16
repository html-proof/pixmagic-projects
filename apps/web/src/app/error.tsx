"use client";
import Link from "next/link";
import { useEffect } from "react";
import { AuthShell } from "@/components/ui";

/**
 * A public page (sign-in, onboarding, the customer pages) that crashed while rendering. That is a
 * bug, not a failed load: loads show LoadError in place and keep retrying. Signed-in pages have
 * their own boundary inside the app shell, (app)/error.tsx.
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <AuthShell title="Something went wrong" subtitle="This page ran into a problem. Trying again usually fixes it.">
      <div className="flex items-center gap-4 text-sm">
        <button type="button" className="btn-primary" onClick={() => retry()}>Try again</button>
        <Link prefetch={false} className="text-muted underline" href="/">Go to the home page</Link>
      </div>
    </AuthShell>
  );
}
