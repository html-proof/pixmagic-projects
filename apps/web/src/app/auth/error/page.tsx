"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Alert } from "@/components/ui";
import { AuthCard } from "@/components/auth/AuthCard";

/** Why a sign-in couldn't start (the API sends the browser here instead of to Google). */
const REASONS: Record<string, (provider: string) => string> = {
  provider_unavailable: (p) => `Sign in with ${p} isn't available yet. Please use your email address, or another option.`,
  rate_limited: () => "Too many sign-in attempts from your network. Wait a few minutes, then try again.",
  unavailable: () => "We can't reach the sign-in service right now. Please try again in a moment.",
};

const PROVIDER_NAMES: Record<string, string> = { google: "Google" };

export default function AuthErrorPage() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const provider = PROVIDER_NAMES[q.get("provider") ?? ""] ?? "that provider";
    const reason = REASONS[q.get("reason") ?? ""];
    setText(reason ? reason(provider) : "Something went wrong while signing you in. Please try again.");
  }, []);

  return (
    <AuthCard title="We couldn't sign you in" subtitle="Nothing was changed.">
      {text && <Alert>{text}</Alert>}
      <Link href="/login" className="btn-cta group">
        Back to sign in
        <ArrowRight aria-hidden className="size-5 transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
      </Link>
      <p className="text-center">
        <Link href="/support" className="auth-link">
          Contact support
        </Link>
      </p>
    </AuthCard>
  );
}
