"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  afterSignIn,
  authConfig,
  authErrorMessage,
  confirmSignUp,
  errorCode,
  finishEmailCodeSignIn,
  recallEmail,
  rememberEmail,
  resendSignUpCode,
  signIn,
  startEmailCodeSignIn,
  useRedirectIfSignedIn,
} from "@/lib/auth";
import { Alert, AuthShell, Divider } from "@/components/ui";
import { CodeStep } from "@/components/auth/CodeStep";
import { PasswordField } from "@/components/auth/PasswordField";
import { SocialButtons } from "@/components/SocialButtons";

/** What a redirect to this page came to say. */
const NOTICES: Record<string, { kind: "info" | "success"; text: string }> = {
  signedOut: { kind: "info", text: "You've been signed out." },
  reset: { kind: "success", text: "Your password has been changed. Sign in with the new one." },
  confirmed: { kind: "success", text: "Your email address is confirmed. Sign in to continue." },
  deleted: { kind: "info", text: "Your account has been deleted." },
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // The account exists but its sign-up code was never entered: confirm, then finish signing in.
  const [confirming, setConfirming] = useState(false);
  // Passwordless: a code Cognito emails (only where the deployment switched it on).
  const [codeSignIn, setCodeSignIn] = useState<"off" | "available" | "email" | "code">("off");
  const [error, setError] = useState<{ text: string; reset?: boolean } | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useRedirectIfSignedIn(router);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const key = Object.keys(NOTICES).find((k) => q.has(k));
    if (key) setNotice(NOTICES[key]!);
    setEmail(recallEmail());
    authConfig()
      .then((c) => c.emailOtp && setCodeSignIn("available"))
      .catch(() => {});
  }, []);

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await signIn(email.trim(), password);
      router.replace(afterSignIn());
    } catch (err) {
      const code = errorCode(err);
      if (code === "unconfirmed") {
        // Cognito won't sign in an unconfirmed account: send a fresh code and ask for it here.
        await resendSignUpCode(email.trim()).catch(() => {});
        setConfirming(true);
      } else {
        rememberEmail(email);
        setError({ text: authErrorMessage(err), reset: code === "reset_required" });
      }
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <AuthShell title="Confirm your email" subtitle="One more step before you can sign in.">
        <CodeStep
          email={email.trim()}
          submitLabel="Confirm and sign in"
          onSubmit={async (code) => {
            await confirmSignUp(email.trim(), code);
            await signIn(email.trim(), password);
            router.replace(afterSignIn());
          }}
          onResend={() => resendSignUpCode(email.trim())}
        />
        <button type="button" className="text-sm text-muted underline" onClick={() => setConfirming(false)}>
          Back to sign in
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Welcome Back" subtitle="Sign in to access your dashboard.">
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {error && (
        <Alert>
          {error.text}{" "}
          {error.reset && (
            <Link href="/reset-password" className="underline">
              Enter the code
            </Link>
          )}
        </Alert>
      )}

      {codeSignIn === "email" || codeSignIn === "code" ? (
        codeSignIn === "email" ? (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await startEmailCodeSignIn(email.trim());
                setCodeSignIn("code");
              } catch (err) {
                setError({ text: authErrorMessage(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            <div>
              <label className="label" htmlFor="otp-email">
                Email Address
              </label>
              <input id="otp-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in code"}
            </button>
            <button type="button" className="text-sm text-muted underline" onClick={() => setCodeSignIn("available")}>
              Sign in with a password instead
            </button>
          </form>
        ) : (
          <CodeStep
            email={email.trim()}
            submitLabel="Sign In"
            onSubmit={async (code) => {
              await finishEmailCodeSignIn(email.trim(), code);
              router.replace(afterSignIn());
            }}
            onResend={() => startEmailCodeSignIn(email.trim())}
          />
        )
      ) : (
        <form onSubmit={onPassword} className="space-y-3">
          <div>
            <label className="label" htmlFor="email">
              Email Address
            </label>
            <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <PasswordField id="password" label="Password" autoComplete="current-password" value={password} onChange={setPassword} />
          <div className="flex justify-end">
            <Link href="/forgot-password" className="text-sm text-muted underline" onClick={() => rememberEmail(email)}>
              Forgot Password?
            </Link>
          </div>
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign In"}
          </button>
          {codeSignIn === "available" && (
            <button type="button" className="text-sm text-muted underline" onClick={() => setCodeSignIn("email")}>
              Email me a sign-in code instead
            </button>
          )}
        </form>
      )}

      <Divider label="OR CONTINUE WITH" />
      <SocialButtons />

      <p className="text-sm text-muted">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-text underline">
          Create Account
        </Link>
      </p>
    </AuthShell>
  );
}
