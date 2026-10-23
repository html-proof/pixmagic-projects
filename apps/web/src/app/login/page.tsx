"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Lock } from "lucide-react";
import {
  afterSignIn,
  authConfig,
  authErrorMessage,
  cancelGoogleLink,
  cancelSignInCode,
  challengeFromError,
  confirmSignUp,
  errorCode,
  finishEmailCodeSignIn,
  finishEmailedSignIn,
  finishMfaSignIn,
  pendingGoogleLink,
  pendingSignInCode,
  recallEmail,
  rememberEmail,
  resendSignInCode,
  resendSignUpCode,
  signIn,
  startEmailCodeSignIn,
  useRedirectIfSignedIn,
  type CodeChallenge,
  type SignInStart,
} from "@/lib/auth";
import { Alert, Divider } from "@/components/ui";
import { emailProblem, useFieldErrors } from "@/components/auth/AuthCard";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { CodeStep } from "@/components/auth/CodeStep";
import { EmailField } from "@/components/auth/IconField";
import { PasswordField } from "@/components/auth/PasswordField";
import { SocialButtons } from "@/components/SocialButtons";

/** What a redirect to this page came to say. */
const NOTICES: Record<string, { kind: "info" | "success"; text: string }> = {
  signedOut: { kind: "info", text: "You've been signed out." },
  // A new password ends every session, but not the account's other ways in.
  resetGoogle: {
    kind: "success",
    text: "Your password has been changed. Sign in with the new one. Your account can also be signed in to with Google: if you don't recognise that, remove it in Settings → Security.",
  },
  reset: { kind: "success", text: "Your password has been changed. Sign in with the new one." },
  confirmedElsewhere: { kind: "info", text: "Your email address is already confirmed, with a different password. Sign in with that one, or use \"Forgot Password?\" to choose a new one." },
  confirmed: { kind: "success", text: "Your email address is confirmed. Sign in to continue." },
  deleted: { kind: "info", text: "Your account has been deleted." },
  googleCancelled: { kind: "info", text: "Google sign-in was cancelled. Nothing was changed and no account was created. You can try again below." },
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
  const [confirming, setConfirming] = useState<{ challenge: CodeChallenge | null } | null>(null);
  // Passwordless: a code Cognito emails (only where the deployment switched it on).
  const [codeSignIn, setCodeSignIn] = useState<CodeSignIn>("off");
  // The password was right and the account has two-step verification: the app's code finishes it.
  const [appCode, setAppCode] = useState(false);
  // The password was right: the 6-digit code emailed to the address finishes signing in. Kept by the
  // API for this browser, so a reload comes back here with the same countdowns.
  const [emailCode, setEmailCode] = useState<{ email: string; challenge: CodeChallenge } | null>(null);
  const [error, setError] = useState<{ text: string; hint?: string; reset?: boolean } | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "success"; text: string } | null>(null);
  // Continue with Google met this address's existing account: the API holds the Google account
  // for this browser until it signs in to that account here, which links it.
  const [linking, setLinking] = useState<{ email: string } | null>(null);
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
    else if (q.get("reason") === "session_expired") setNotice({ kind: "info", text: "Session expired. Sign in again to continue to your workspace." });
    setEmail(recallEmail());
    authConfig()
      .then((c) => c.emailOtp && setCodeSignIn("available"))
      .catch(() => {});
    // A Google account held for an existing account (from /auth/callback, or still standing after a
    // password reset): ask for that account's sign-in, with its address filled in.
    pendingGoogleLink()
      .then((p) => {
        if (p.pending) {
          setEmail(p.email);
          setLinking({ email: p.email });
        } else if (q.has("link")) {
          setNotice({ kind: "info", text: "That Google sign-in has timed out. Sign in below, or continue with Google again." });
        }
      })
      .catch(() => {});
    // A sign-in waiting for its emailed code in this browser (the page was reloaded): carry on with it.
    pendingSignInCode()
      .then((p) => {
        if (p.pending) {
          setEmail(p.email);
          setEmailCode({ email: p.email, challenge: p.challenge });
        }
      })
      .catch(() => {});
  }, []);

  /** Swap between the password form and the emailed-code one, starting the new one clean. */
  function switchTo(mode: CodeSignIn) {
    fields.reset();
    setError(null);
    setCodeSignIn(mode);
  }

  /** Signed in, or on to the second step: the emailed code, or the authenticator app's. */
  function afterFirstStep(r: SignInStart) {
    if (!("next" in r)) router.replace(afterSignIn());
    else if (r.next === "mfa") setAppCode(true);
    else setEmailCode({ email: r.email, challenge: r.challenge });
  }

  /** Back to the password form from a code step (the pending sign-in, if any, is given up). */
  function backToPassword(message?: string) {
    setAppCode(false);
    setEmailCode(null);
    setConfirming(null);
    setPassword("");
    if (codeSignIn === "code") setCodeSignIn("available");
    setError(message ? { text: message } : null);
  }

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    if (!fields.submit()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      afterFirstStep(await signIn(email.trim(), password, keep));
    } catch (err) {
      const code = errorCode(err);
      if (code === "unconfirmed") {
        // Cognito won't sign in an unconfirmed account: a fresh code (or the one still standing,
        // with its time left) and ask for it here.
        const challenge = await resendSignUpCode(email.trim())
          .then((r) => r.challenge)
          .catch((e: unknown) => challengeFromError(e));
        setConfirming({ challenge });
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

  if (confirming) {
    return (
      <AuthSplitShell title="Confirm your email" subtitle="One more step before you can sign in." action={CREATE_ACCOUNT}>
        <CodeStep
          email={email.trim()}
          challenge={confirming.challenge}
          submitLabel="Confirm and sign in"
          large
          onSubmit={async (code) => {
            // The code signs in with the password typed here, which becomes the account's: the
            // code proves the inbox, whatever password an earlier sign-up with it had set.
            const confirmed = await confirmSignUp(email.trim(), code, { password, keep });
            if (confirmed.user) {
              setConfirming(null);
              router.replace(afterSignIn());
              return;
            }
            // Confirmed already (another tab): sign in as usual.
            const r = await signIn(email.trim(), password, keep);
            setConfirming(null);
            afterFirstStep(r);
          }}
          onResend={() => resendSignUpCode(email.trim())}
          onChangeEmail={() => backToPassword()}
        />
        <button type="button" className="text-sm text-muted underline" onClick={() => backToPassword()}>
          Back to sign in
        </button>
      </AuthSplitShell>
    );
  }

  if (emailCode) {
    return (
      <AuthSplitShell title="Check your email" subtitle="We sent a 6-digit verification code to your email address." action={CREATE_ACCOUNT}>
        <CodeStep
          email={emailCode.email}
          challenge={emailCode.challenge}
          intro={
            <>
              Enter the 6-digit code we emailed to <strong>{emailCode.email}</strong> to finish signing in.
            </>
          }
          submitLabel="Verify and sign in"
          successLabel="Email verified successfully. Taking you to your dashboard…"
          large
          onSubmit={async (code) => {
            try {
              await finishEmailedSignIn(code);
              router.replace(afterSignIn());
            } catch (err) {
              // Too long since the password, or too many wrong codes: start again from it.
              if (errorCode(err) !== "login_expired" && errorCode(err) !== "too_many_attempts") throw err;
              backToPassword(authErrorMessage(err));
            }
          }}
          onResend={resendSignInCode}
          onChangeEmail={async () => {
            await cancelSignInCode().catch(() => undefined);
            backToPassword();
          }}
        />
        <button
          type="button"
          className="text-sm text-muted underline"
          onClick={() => {
            void cancelSignInCode().catch(() => undefined);
            backToPassword();
          }}
        >
          Back to sign in
        </button>
      </AuthSplitShell>
    );
  }

  if (appCode) {
    return (
      <AuthSplitShell title="Two-step verification" subtitle="One more step to keep your account safe." action={CREATE_ACCOUNT}>
        <CodeStep
          email={email.trim()}
          intro={<>Open your authenticator app and enter the 6-digit code it shows for bizinsights.</>}
          submitLabel="Sign In"
          successLabel="Signed in. Taking you to your dashboard…"
          large
          onSubmit={async (code) => {
            try {
              await finishMfaSignIn(code);
              router.replace(afterSignIn());
            } catch (err) {
              // Too long since the password (or too many wrong codes): start again from it.
              if (errorCode(err) !== "mfa_expired") throw err;
              backToPassword(authErrorMessage(err));
            }
          }}
        />
        <p className="text-sm text-muted">
          Lost your phone?{" "}
          <Link prefetch={false} href="/support" className="underline">
            Contact support
          </Link>{" "}
          and we&apos;ll help you back in.
        </p>
        <button type="button" className="text-sm text-muted underline" onClick={() => backToPassword()}>
          Back to sign in
        </button>
      </AuthSplitShell>
    );
  }

  const keepSignedIn = (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted select-none">
      <input type="checkbox" className="size-[18px] cursor-pointer rounded accent-[var(--accent)]" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
      Keep me signed in
    </label>
  );

  return (
    <AuthSplitShell
      title={linking ? "Link your Google account" : "Welcome Back"}
      subtitle={linking ? "Sign in to your existing account once to finish." : "Sign in to your account to continue to your dashboard."}
      action={CREATE_ACCOUNT}
    >
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {linking && (
        <Alert kind="info">
          <p className="font-medium">
            You already have a bizinsights account with <strong>{linking.email}</strong>.
          </p>
          <p className="mt-0.5 text-[13px]">
            To keep it safe, sign in to it below the way you usually do. Your Google account is then linked to it, and from then on Continue with Google signs you straight in.
          </p>
          <button
            type="button"
            className="mt-1 text-[13px] underline"
            onClick={() => {
              void cancelGoogleLink().catch(() => undefined);
              setLinking(null);
            }}
          >
            Don&apos;t link Google
          </button>
        </Alert>
      )}
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
            noValidate
            onSubmit={async (e) => {
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
            }}
          >
            <EmailField id="otp-email" value={email} onChange={setEmail} onBlur={fields.leave} error={fields.error("otp-email")} />
            {keepSignedIn}
            <button className="auth-cta" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in code"}
            </button>
            <button type="button" className="text-sm text-muted underline" onClick={() => switchTo("available")}>
              Sign in with a password instead
            </button>
          </form>
        ) : (
          <CodeStep
            email={email.trim()}
            submitLabel="Sign In"
            large
            onSubmit={async (code) => afterFirstStep(await finishEmailCodeSignIn(email.trim(), code, keep))}
            onResend={() => startEmailCodeSignIn(email.trim())}
            onChangeEmail={() => switchTo("email")}
          />
        )
      ) : (
        <form onSubmit={onPassword} className="space-y-4" noValidate>
          <EmailField id="email" value={email} onChange={setEmail} onBlur={fields.leave} error={fields.error("email")} />
          <PasswordField
            id="password"
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            icon={<Lock size={18} aria-hidden />}
            inputClassName="auth-field"
            onBlur={fields.leave}
            error={fields.error("password")}
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
            <button type="button" className="text-sm text-muted underline" onClick={() => switchTo("email")}>
              Email me a sign-in code instead
            </button>
          )}
        </form>
      )}

      {/* Linking: Google would only bring the same Google account back here. */}
      {!linking && <SocialButtons row keep={keep} terms before={<Divider label="OR CONTINUE WITH" />} />}

      <p className="pt-1 text-center text-[15px] text-muted">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-accent hover:underline">
          Create Account
        </Link>
      </p>
    </AuthSplitShell>
  );
}
