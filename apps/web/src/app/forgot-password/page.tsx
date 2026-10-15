"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { isEmailAddress } from "@app/shared/auth";
import { authErrorMessage, forgotPassword, recallEmail, rememberEmail } from "@/lib/auth";
import { Alert } from "@/components/ui";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { EmailField } from "@/components/auth/IconField";
import { ArrowLeft, Mail } from "lucide-react";
import { authErrorMessage, forgotPassword, recallEmail, rememberEmail } from "@/lib/auth";
import { Alert } from "@/components/ui";
import { AuthCard, AuthField, AuthSubmit, emailProblem, useFieldErrors } from "@/components/auth/AuthCard";

/** Step 1 of a password reset: the address. Cognito emails a code; /reset-password takes it. */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useFieldErrors({ email: emailProblem(email) });

  useEffect(() => setEmail(recallEmail()), []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!fields.submit()) return;
    setBusy(true);
    setError(null);
    try {
      // The same answer whether or not an account exists, so this page can't be used to find accounts.
      await forgotPassword(email.trim());
      rememberEmail(email);
      router.push("/reset-password");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthSplitShell
      title="Forgot your password?"
      subtitle="Enter your email address and we'll send you a code to choose a new one."
      action={{ href: "/login", label: "Sign In" }}
    >
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <EmailField id="email" value={email} onChange={setEmail} />
        <button className="auth-cta" disabled={busy}>
          {busy ? (
            "Sending…"
          ) : (
            <>
              Send reset code <ArrowRight size={18} aria-hidden />
            </>
          )}
        </button>
      </form>
      <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text">
        <ArrowLeft size={16} aria-hidden />
        Back to sign in
      </Link>
    </AuthSplitShell>
    <AuthCard title="Forgot your password?" subtitle="Enter your email address and we'll send you a code to choose a new one.">
      {error && <Alert>{error}</Alert>}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <AuthField
          id="email"
          label="Email Address"
          icon={Mail}
          type="email"
          placeholder="Enter your email address"
          autoComplete="email"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={fields.leave}
          error={fields.error("email")}
        />
        <AuthSubmit className="mt-2" busy={busy} busyLabel="Sending…">
          Send reset code
        </AuthSubmit>
      </form>
      <p className="text-center">
        <Link href="/login" className="auth-link inline-flex items-center gap-1.5">
          <ArrowLeft aria-hidden size={16} />
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
