"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Lock } from "lucide-react";
import {
  afterSignIn,
  authConfig,
  authErrorMessage,
  confirmSignUp,
  errorCode,
  finishEmailCodeSignIn,
  finishMfaSignIn,
  recallEmail,
  rememberEmail,
  resendSignUpCode,
  signIn,
  startEmailCodeSignIn,
  useRedirectIfSignedIn,
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
  const [codeSignIn, setCodeSignIn] = useState<CodeSignIn>("off");
  // The password was right and the account has two-step verification: the app's code finishes it.
  const [appCode, setAppCode] = useState(false);
  const [error, setError] = useState<{ text: string; hint?: string; reset?: boolean } | null>(null);
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

  /** Signed in, or on to the authenticator app's code. */
  function afterFirstStep(r: Awaited<ReturnType<typeof signIn>>) {
    if ("next" in r) setAppCode(true);
    else router.replace(afterSignIn());
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

  if (confirming) {
    return (
      <AuthSplitShell title="Confirm your email" subtitle="One more step before you can sign in." action={CREATE_ACCOUNT}>
        <CodeStep
          email={email.trim()}
          submitLabel="Confirm and sign in"
          large
          onSubmit={async (code) => {
            // The code signs in with the password typed here, which becomes the account's: the
            // code proves the inbox, whatever password an earlier sign-up with it had set.
            const confirmed = await confirmSignUp(email.trim(), code, { password, keep });
            if (confirmed.user) {
              setConfirming(false);
              router.replace(afterSignIn());
              return;
            }
            // Confirmed already (another tab): sign in as usual.
            const r = await signIn(email.trim(), password, keep);
            setConfirming(false);
            afterFirstStep(r);
          }}
          onResend={() => resendSignUpCode(email.trim())}
        />
        <button type="button" className="text-sm text-muted underline" onClick={() => setConfirming(false)}>
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
          large
          onSubmit={async (code) => {
            try {
              await finishMfaSignIn(code);
              router.replace(afterSignIn());
            } catch (err) {
              // Too long since the password (or too many wrong codes): start again from it.
              if (errorCode(err) !== "mfa_expired") throw err;
              setAppCode(false);
              setPassword("");
              if (codeSignIn === "code") setCodeSignIn("available");
              setError({ text: authErrorMessage(err) });
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
        <button
          type="button"
          className="text-sm text-muted underline"
          onClick={() => {
            setAppCode(false);
            setPassword("");
            if (codeSignIn === "code") setCodeSignIn("available");
          }}
        >
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
    <AuthSplitShell title="Welcome Back" subtitle="Sign in to your account to continue to your dashboard." action={CREATE_ACCOUNT}>
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

      <SocialButtons row keep={keep} terms before={<Divider label="OR CONTINUE WITH" />} />

      <p className="pt-1 text-center text-[15px] text-muted">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-accent hover:underline">
          Create Account
        </Link>
      </p>
    </AuthSplitShell>
  );
}
