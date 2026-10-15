"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** The old "Reset your password" address: it's two steps now, starting at /forgot-password. */
export default function ResetRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/forgot-password"), [router]);
  return null;
}
