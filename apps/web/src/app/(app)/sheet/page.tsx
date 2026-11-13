"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The Profit sheet moved into Profit & Loss (its Detailed Table, 13 Nov 2026): old links and
 * bookmarks land there, with their dates, the days and events they showed, and their columns
 * (`?by=` is the page's `?grain=` now).
 */
export default function ProfitSheetMoved() {
  const router = useRouter();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const by = q.get("by");
    q.delete("by");
    if (by && !q.has("grain")) q.set("grain", by);
    q.set("tab", "table");
    router.replace(`/profit?${q.toString()}`);
  }, [router]);
  return <p className="text-muted">Opening Profit &amp; Loss…</p>;
}
