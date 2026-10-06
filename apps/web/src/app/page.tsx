"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, isSignedOut, keepRetrying } from "@/lib/api";
import { Unreachable } from "@/components/LoadError";

export default function Home() {
  const router = useRouter();
  /** Why /me failed, while it fails for a reason other than not being signed in. */
  const [error, setError] = useState<unknown>(null);
  const route = useCallback(async () => {
    try {
      const me = await api<{ user: { emailVerified: boolean }; workspaces: unknown[] }>("/me");
      router.replace(me.user.emailVerified && me.workspaces.length ? "/dashboard" : "/onboarding");
      return true;
    } catch (e) {
      // New visitors start with the Shopify-first sign-up (it links to sign-in for existing accounts).
      // Only a 401 says this is one: a returning merchant who arrives mid-outage waits here instead.
      if (!isSignedOut(e)) {
        setError(e);
        return false;
      }
      router.replace("/start");
      return true;
    }
  }, [router]);
  useEffect(() => void route(), [route]);
  const failing = error !== null;
  useEffect(() => (failing ? keepRetrying(route) : undefined), [failing, route]);
  if (failing) return <Unreachable error={error} onRetry={() => void route()} />;
  return <p className="p-8 text-muted">Loading…</p>;
}
