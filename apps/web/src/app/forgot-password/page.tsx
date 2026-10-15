"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { isEmailAddress } from "@app/shared/auth";
import { authErrorMessage, forgotPassword, recallEmail, rememberEmail } from "@/lib/auth";
import { Alert, AuthShell } from "@/components/ui";

/** Step 1 of a password reset: the address. Cognito emails a code; /reset-password takes it. */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setEmail(recallEmail()), []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isEmailAddress(email)) return setError("Enter a valid email address.");
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
    <AuthShell title="Forgot your password?" subtitle="Enter your email address and we'll send you a code to choose a new one.">
      {error && <Alert>{error}</Alert>}
      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <div>
          <label className="label" htmlFor="email">
            Email Address
          </label>
          <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Sending…" : "Send reset code"}
        </button>
      </form>
      <Link href="/login" className="block text-sm text-muted underline">
        Back to sign in
      </Link>
    </AuthShell>
  );
}
