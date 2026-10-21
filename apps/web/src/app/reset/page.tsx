"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { sendPasswordResetEmail } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { ValidatedInput } from "@/components/FieldError";
import { authErrorMessage } from "@/lib/session";
import { Alert, AuthShell } from "@/components/ui";

export default function ResetPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordResetEmail(firebaseAuth(), email, { url: `${window.location.origin}/login` });
      setDone(true);
    } catch (error) {
      // Account existence stays private, while delivery outages remain actionable.
      const code = (error as { code?: string })?.code;
      if (code === "auth/user-not-found") setDone(true);
      else setError(authErrorMessage(error));
    } finally { setBusy(false); }
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {error && <Alert>{error}</Alert>}
      {done ? (
        <Alert kind="success">If an account exists for {email}, a reset link is on its way. Check your inbox.</Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <ValidatedInput id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn-primary w-full" disabled={busy}>Send reset link</button>
        </form>
      )}
      <Link href="/login" className="block text-sm text-muted underline">Back to sign in</Link>
    </AuthShell>
  );
}
