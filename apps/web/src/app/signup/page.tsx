"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createUserWithEmailAndPassword, sendEmailVerification, updateProfile } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { authErrorMessage, establishSession } from "@/lib/session";
import { Alert, AuthShell, Divider } from "@/components/ui";
import { SocialButtons } from "@/components/SocialButtons";
import { ShopifyIcon } from "@/components/ShopifyIcon";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters.");
    setBusy(true);
    setError(null);
    try {
      const cred = await createUserWithEmailAndPassword(firebaseAuth(), email, password);
      if (name) await updateProfile(cred.user, { displayName: name });
      await sendEmailVerification(cred.user, { url: `${window.location.origin}/verify-email` });
      await establishSession(cred.user);
      router.replace("/verify-email");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Free to start. You'll connect your Shopify store next.">
      <div className="space-y-2">
        <Link href="/start" className="btn-primary w-full">
          <ShopifyIcon />
          Continue with Shopify
        </Link>
        <p className="text-center text-xs text-muted">Fastest: sign up and connect your store in one go.</p>
        <SocialButtons />
      </div>
      <Divider label="or with email" />
      {error && <Alert>{error}</Alert>}
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <input id="name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
        </div>
        <button className="btn-primary w-full" disabled={busy}>Create account</button>
      </form>
      <p className="text-sm text-muted">
        Already have an account? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </AuthShell>
  );
}
