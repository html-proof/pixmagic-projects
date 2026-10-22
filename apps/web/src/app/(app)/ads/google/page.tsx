"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** The Google Ads analytics page moved into the Advertising area: old links and bookmarks land there, with their dates and account. */
export default function GoogleAdsAnalyticsMoved() {
  const router = useRouter();
  useEffect(() => router.replace(`/advertising/google/analytics${window.location.search}`), [router]);
  return <p className="text-muted">Opening Google Ads analytics…</p>;
}
