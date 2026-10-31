"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** WhatsApp Automation moved to /dashboard/whatsapp-automation: old links and bookmarks land there, with their tab. */
export default function WhatsappMoved() {
  const router = useRouter();
  useEffect(() => router.replace(`/dashboard/whatsapp-automation${window.location.search}`), [router]);
  return <p className="text-muted">Opening WhatsApp Automation…</p>;
}
