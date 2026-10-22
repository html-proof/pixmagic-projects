"use client";
import Link from "next/link";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useSecurityStatus } from "@/lib/accountSecurity";

/**
 * The settings menu's "Account security" card: what Settings → Security last found (the share of its
 * checks that pass, and the one thing to do first), or an invitation to look before it has.
 */
export function SecuritySummary() {
  const status = useSecurityStatus();
  const warn = status?.tone === "warn";
  const Glyph = warn ? ShieldAlert : ShieldCheck;
  const passed = status ? Math.round(status.score * 3) : 0;
  return (
    <Link
      href="/settings/security"
      className="tone-card block rounded-xl border p-4 shadow-[var(--shadow)] transition hover:brightness-[1.03]"
      style={{ ["--tone" as string]: warn ? "var(--warn)" : "var(--good)" }}
    >
      <span className="flex items-start gap-3">
        <span className="tone-icon size-10" aria-hidden>
          <Glyph size={20} strokeWidth={1.9} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Account security</span>
          <span className="mt-0.5 block text-xs leading-snug text-muted">{status?.summary ?? "See how your account is protected and where you're signed in."}</span>
        </span>
      </span>
      {status && (
        <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--tone)_14%,transparent)]" role="img" aria-label={`${passed} of 3 security checks pass`}>
          <span className="block h-full rounded-full bg-[var(--tone)] transition-[width] duration-500" style={{ width: `${Math.max(8, status.score * 100)}%` }} />
        </span>
      )}
    </Link>
  );
}
