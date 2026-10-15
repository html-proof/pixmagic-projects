"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthShell, Alert } from "@/components/ui";

/** Why a sign-in couldn't start (the API sends the browser here instead of to Google or Apple). */
const REASONS: Record<string, (provider: string) => string> = {
  provider_unavailable: (p) => `Sign in with ${p} isn't available yet. Please use your email address, or another option.`,
  rate_limited: () => "Too many sign-in attempts from your network. Wait a few minutes, then try again.",
  unavailable: () => "We can't reach the sign-in service right now. Please try again in a moment.",
};

const PROVIDER_NAMES: Record<string, string> = { google: "Google", apple: "Apple" };

export default function AuthErrorPage() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const provider = PROVIDER_NAMES[q.get("provider") ?? ""] ?? "that provider";
    const reason = REASONS[q.get("reason") ?? ""];
    setText(reason ? reason(provider) : "Something went wrong while signing you in. Please try again.");
  }, []);

  return (
    <AuthShell title="We couldn't sign you in" subtitle="Nothing was changed.">
      {text && <Alert>{text}</Alert>}
      <Link href="/login" className="btn-primary w-full">
        Back to sign in
      </Link>
      <Link href="/support" className="block text-sm text-muted underline">
        Contact support
      </Link>
    </AuthShell>
  );
}
