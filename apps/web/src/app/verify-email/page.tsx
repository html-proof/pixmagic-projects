"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { onAuthStateChanged, sendEmailVerification, type User } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { api } from "@/lib/api";
import { authErrorMessage } from "@/lib/session";
import { Alert, AuthShell } from "@/components/ui";
import { takeReturnTo } from "@/lib/returnTo";

export default function VerifyEmailPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  // Firebase restores the signed-in user asynchronously. Until it has answered, "no user" means
  // "not known yet", and a click must not bounce a signed-in person to /login.
  const [authReady, setAuthReady] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "info" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onAuthStateChanged(firebaseAuth(), (u) => {
        setUser(u);
        setAuthReady(true);
      }),
    [],
  );

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
      // Through the app shell, which sends a new merchant to onboarding and an employee to their portal.
      router.replace(takeReturnTo() ?? "/dashboard");
    } catch (e) {
      setMsg({ kind: "error", text: authErrorMessage(e) });
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
    <AuthShell title="Check your email" subtitle={`We sent a verification link to ${user?.email ?? "your inbox"}. Verifying keeps your account safe.`}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <button className="btn-primary w-full" onClick={check} disabled={busy || !authReady}>I&apos;ve verified my email</button>
      <button className="btn-secondary w-full" onClick={resend} disabled={!authReady}>Resend the email</button>
    </AuthShell>
  );
}
