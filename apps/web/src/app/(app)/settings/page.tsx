"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** `/settings` on its own was a 404; the export is static, so redirect from the browser. */
export default function SettingsIndex() {
  const router = useRouter();
  useEffect(() => router.replace("/settings/profile"), [router]);
  return null;
}
