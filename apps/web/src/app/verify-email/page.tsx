"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { onAuthStateChanged, sendEmailVerification, type User } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { api } from "@/lib/api";
import { Alert, AuthShell } from "@/components/ui";

export default function VerifyEmailPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "info" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => onAuthStateChanged(firebaseAuth(), setUser), []);

  async function check() {
    if (!user) return router.replace("/login");
    setBusy(true);
    try {
      await user.reload();
      if (!user.emailVerified) {
        setMsg({ kind: "info", text: "We haven't seen the click yet. Open the link in the email, then try again." });
        return;
      }
      await api("/auth/sync-profile", { method: "POST", body: { idToken: await user.getIdToken(true) } });
      router.replace("/onboarding");
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!user) return router.replace("/login");
    await sendEmailVerification(user, { url: `${window.location.origin}/verify-email` })
      .then(() => setMsg({ kind: "success", text: "Sent. Check your inbox (and spam folder)." }))
      .catch(() => setMsg({ kind: "error", text: "Please wait a minute before asking for another email." }));
  }

  return (
    <AuthShell title="Check your email" subtitle={`We sent a verification link to ${user?.email ?? "your inbox"}. Verifying keeps your store data safe.`}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <button className="btn-primary w-full" onClick={check} disabled={busy}>I&apos;ve verified my email</button>
      <button className="btn-secondary w-full" onClick={resend}>Resend the email</button>
    </AuthShell>
  );
}
