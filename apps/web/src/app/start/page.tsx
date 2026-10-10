"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

/**
 * The public "Continue with Shopify" sign-up used to live here. Shopify now connects only from
 * inside the app, after signing in, so this address just forwards: with a store (an old link, or
 * Shopify opening our app for one) to the in-app connect page, which signs the visitor in or up
 * first and then picks the store up; otherwise to sign-up.
 */
function StartRedirect() {
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const shop = params.get("shop");
    router.replace(shop ? `/onboarding?shop=${encodeURIComponent(shop)}` : "/signup");
  }, [params, router]);
  return <p className="p-8 text-muted">Loading…</p>;
}

export default function StartPage() {
  return (
    <Suspense>
      <StartRedirect />
    </Suspense>
  );
}
