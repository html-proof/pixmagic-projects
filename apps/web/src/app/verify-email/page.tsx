"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, isTransient, keepRetrying } from "@/lib/api";
import { authErrorMessage, sendVerificationCode, verifyEmailCode } from "@/lib/auth";
import { takeReturnTo } from "@/lib/returnTo";
import { Alert } from "@/components/ui";
import { AuthCard, AuthSubmit } from "@/components/auth/AuthCard";
import { CodeStep } from "@/components/auth/CodeStep";

/**
 * A signed-in account whose address isn't verified yet (one moved over from Firebase unverified,
 * or an employee who joined from a copied link): the app shell sends it here. A code goes to the
 * address; entering it verifies it. New sign-ups confirm their code on the sign-up page instead.
 */
export default function VerifyEmailPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stopRetrying: (() => void) | undefined;
    const load = async () => {
      try {
        const me = await api<{ user: { email: string; emailVerified: boolean } | null }>("/auth/whoami");
        if (stopped) return true;
        if (!me.user) router.replace("/login");
        else if (me.user.emailVerified) router.replace(takeReturnTo() ?? "/dashboard");
        else setEmail(me.user.email);
        return true;
      } catch (e) {
        return !isTransient(e);
      }
    };
    void load().then((done) => {
      if (!done && !stopped) stopRetrying = keepRetrying(load);
    });
    return () => {
      stopped = true;
      stopRetrying?.();
    };
  }, [router]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await sendVerificationCode();
      if (r.alreadyVerified) return router.replace(takeReturnTo() ?? "/dashboard");
      setSent(true);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Verify your email" subtitle={email ? `Confirm that ${email} is yours. Verifying keeps your account safe.` : "Checking your account…"}>
      {error && <Alert>{error}</Alert>}
      {email && !sent && (
        <AuthSubmit type="button" onClick={() => void send()} busy={busy} busyLabel="Sending…">
          Email me a verification code
        </AuthSubmit>
      )}
      {email && sent && (
        <CodeStep
          card
          email={email}
          submitLabel="Verify email"
          busyLabel="Verifying…"
          onSubmit={async (code) => {
            await verifyEmailCode(code);
            // Through the app shell, which sends a new merchant to onboarding and an employee to their portal.
            router.replace(takeReturnTo() ?? "/dashboard");
          }}
          onResend={sendVerificationCode}
        />
      )}
      <p className="text-center">
        <Link prefetch={false} href="/login?signedOut=1" className="auth-link">
          Sign in with a different account
        </Link>
      </p>
    </AuthCard>
  );
}
