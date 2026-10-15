"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Lock } from "lucide-react";
import { Lock, Mail } from "lucide-react";
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
import { Alert, Divider } from "@/components/ui";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { CodeStep } from "@/components/auth/CodeStep";
import { EmailField } from "@/components/auth/IconField";
import { PasswordField } from "@/components/auth/PasswordField";
import { AuthCard, AuthField, AuthSubmit, emailProblem, useFieldErrors } from "@/components/auth/AuthCard";
import { CodeStep } from "@/components/auth/CodeStep";
import { SocialButtons } from "@/components/SocialButtons";

/** What a redirect to this page came to say. */
const NOTICES: Record<string, { kind: "info" | "success"; text: string }> = {
  signedOut: { kind: "info", text: "You've been signed out." },
  reset: { kind: "success", text: "Your password has been changed. Sign in with the new one." },
  confirmed: { kind: "success", text: "Your email address is confirmed. Sign in to continue." },
  deleted: { kind: "info", text: "Your account has been deleted." },
};

const CREATE_ACCOUNT = { href: "/signup", label: "Create Account" };
type CodeSignIn = "off" | "available" | "email" | "code";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Unticked: the session ends when the browser closes (the API sets cookies without a lifetime).
  const [keep, setKeep] = useState(true);
  // The account exists but its sign-up code was never entered: confirm, then finish signing in.
  const [confirming, setConfirming] = useState(false);
  // Passwordless: a code Cognito emails (only where the deployment switched it on).
  const [codeSignIn, setCodeSignIn] = useState<"off" | "available" | "email" | "code">("off");
  const [error, setError] = useState<{ text: string; hint?: string; reset?: boolean } | null>(null);
  const [codeSignIn, setCodeSignIn] = useState<CodeSignIn>("off");
  const [error, setError] = useState<{ text: string; reset?: boolean } | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = useFieldErrors(
    codeSignIn === "email"
      ? { "otp-email": emailProblem(email) }
      : codeSignIn === "code"
        ? {}
        : { email: emailProblem(email), password: password ? null : "Enter your password." },
  );

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

  /** Swap between the password form and the emailed-code one, starting the new one clean. */
  function switchTo(mode: CodeSignIn) {
    fields.reset();
    setError(null);
    setCodeSignIn(mode);
  }

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    if (!fields.submit()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await signIn(email.trim(), password, keep);
      router.replace(afterSignIn());
    } catch (err) {
      const code = errorCode(err);
      if (code === "unconfirmed") {
        // Cognito won't sign in an unconfirmed account: send a fresh code and ask for it here.
        await resendSignUpCode(email.trim()).catch(() => {});
        setConfirming(true);
      } else {
        rememberEmail(email);
        setError({
          text: authErrorMessage(err),
          hint: code === "invalid_credentials" ? "Please check your credentials and try again." : undefined,
          reset: code === "reset_required",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function onCodeEmail(e: FormEvent) {
    e.preventDefault();
    if (!fields.submit()) return;
    setBusy(true);
    setError(null);
    try {
      await startEmailCodeSignIn(email.trim());
      switchTo("code");
    } catch (err) {
      setError({ text: authErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <AuthSplitShell title="Confirm your email" subtitle="One more step before you can sign in." action={CREATE_ACCOUNT}>
      <AuthCard title="Confirm your email" subtitle="One more step before you can sign in.">
        <CodeStep
          large
          email={email.trim()}
          submitLabel="Confirm and sign in"
          large
          onSubmit={async (code) => {
            await confirmSignUp(email.trim(), code);
            await signIn(email.trim(), password, keep);
            router.replace(afterSignIn());
          }}
          onResend={() => resendSignUpCode(email.trim())}
        />
        <button type="button" className="text-sm text-muted underline" onClick={() => setConfirming(false)}>
          Back to sign in
        </button>
      </AuthSplitShell>
        <p className="text-center">
          <button type="button" className="auth-link" onClick={() => setConfirming(false)}>
            Back to sign in
          </button>
        </p>
      </AuthCard>
    );
  }

  const keepSignedIn = (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted select-none">
      <input type="checkbox" className="size-[18px] cursor-pointer rounded accent-[var(--accent)]" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
      Keep me signed in
    </label>
  );

  return (
    <AuthSplitShell title="Welcome Back" subtitle="Sign in to your account to continue to your dashboard." action={CREATE_ACCOUNT}>
    <AuthCard title="Welcome Back" subtitle="Sign in to access your dashboard.">
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {error && (
        <Alert onDismiss={() => setError(null)}>
          <p className="font-medium">{error.text}</p>
          {error.hint && <p className="mt-0.5 text-[13px]">{error.hint}</p>}
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
            className="space-y-4"
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
            <EmailField id="otp-email" value={email} onChange={setEmail} />
            {keepSignedIn}
            <button className="auth-cta" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in code"}
            </button>
            <button type="button" className="text-sm text-muted underline" onClick={() => setCodeSignIn("available")}>
              Sign in with a password instead
            </button>
          </form>
        ) : (
      {codeSignIn === "code" ? (
        <>
          <CodeStep
            large
            email={email.trim()}
            submitLabel="Sign In"
            large
            onSubmit={async (code) => {
              await finishEmailCodeSignIn(email.trim(), code, keep);
              router.replace(afterSignIn());
            }}
            onResend={() => startEmailCodeSignIn(email.trim())}
          />
        )
      ) : (
        <form onSubmit={onPassword} className="space-y-4">
          <EmailField id="email" value={email} onChange={setEmail} />
          <PasswordField
            id="password"
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            icon={<Lock size={18} aria-hidden />}
            inputClassName="auth-field"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            {keepSignedIn}
            <Link href="/forgot-password" className="text-sm font-medium text-accent underline underline-offset-2" onClick={() => rememberEmail(email)}>
              Forgot Password?
            </Link>
          </div>
          <button className="auth-cta" disabled={busy}>
            {busy ? (
              "Signing in…"
            ) : (
              <>
                Sign In <ArrowRight size={18} aria-hidden />
              </>
            )}
          </button>
          {codeSignIn === "available" && (
            <button type="button" className="text-sm text-muted underline" onClick={() => setCodeSignIn("email")}>
              Email me a sign-in code instead
          <p className="text-center">
            <button type="button" className="auth-link" onClick={() => switchTo("email")}>
              Use a different email address
            </button>
          </p>
        </>
      ) : (
        <>
          <SocialButtons large />
          <Divider label="OR SIGN IN WITH YOUR EMAIL" />
          {codeSignIn === "email" ? (
            <form className="flex flex-col gap-4" onSubmit={onCodeEmail} noValidate>
              <AuthField
                id="otp-email"
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
                error={fields.error("otp-email")}
              />
              <AuthSubmit className="mt-2" busy={busy} busyLabel="Sending…">
                Email me a sign-in code
              </AuthSubmit>
              <p className="text-center">
                <button type="button" className="auth-link" onClick={() => switchTo("available")}>
                  Sign in with a password instead
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={onPassword} className="flex flex-col gap-4" noValidate>
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
              <div>
                <AuthField
                  id="password"
                  label="Password"
                  icon={Lock}
                  reveal
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={fields.leave}
                  error={fields.error("password")}
                />
                <div className="mt-2 flex justify-end">
                  <Link href="/forgot-password" className="auth-link" onClick={() => rememberEmail(email)}>
                    Forgot Password?
                  </Link>
                </div>
              </div>
              <AuthSubmit busy={busy} busyLabel="Signing in…">
                Sign In
              </AuthSubmit>
              {codeSignIn === "available" && (
                <p className="text-center">
                  <button type="button" className="auth-link" onClick={() => switchTo("email")}>
                    Email me a sign-in code instead
                  </button>
                </p>
              )}
            </form>
          )}
        </>
      )}

      <Divider label="OR CONTINUE WITH" />
      <SocialButtons row />

      <p className="pt-1 text-center text-[15px] text-muted">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-accent hover:underline">
          Create Account
        </Link>
      </p>
    </AuthSplitShell>
      <p className="text-center text-[15px] text-muted">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-accent underline underline-offset-2 hover:opacity-80">
          Create Account
        </Link>
      </p>
    </AuthCard>
  );
}
