"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { sendPasswordResetEmail } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { Alert, AuthShell } from "@/components/ui";

export default function ResetPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    // Same message whatever happens, so this page can't be used to discover accounts.
    await sendPasswordResetEmail(firebaseAuth(), email, { url: `${window.location.origin}/login` }).catch(() => {});
    setDone(true);
    setBusy(false);
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {done ? (
        <Alert kind="success">If an account exists for {email}, a reset link is on its way. Check your inbox.</Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn-primary w-full" disabled={busy}>Send reset link</button>
        </form>
      )}
      <Link href="/login" className="block text-sm text-muted underline">Back to sign in</Link>
    </AuthShell>
  );
}
