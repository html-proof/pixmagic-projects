"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowRight, Lock, UserRound } from "lucide-react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN, DISPLAY_NAME_MAX, isEmailAddress } from "@app/shared/auth";
import { afterSignIn, authErrorMessage, confirmSignUp, errorCode, resendSignUpCode, signIn, signUp, useRedirectIfSignedIn } from "@/lib/auth";
import { Alert, Divider } from "@/components/ui";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { CodeStep } from "@/components/auth/CodeStep";
import { EmailField, IconField } from "@/components/auth/IconField";
import { PasswordField } from "@/components/auth/PasswordField";
import { Lock, Mail, UserRound } from "lucide-react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN, DISPLAY_NAME_MAX } from "@app/shared/auth";
import { afterSignIn, authErrorMessage, confirmSignUp, errorCode, resendSignUpCode, signIn, signUp, useRedirectIfSignedIn } from "@/lib/auth";
import { Alert, Divider } from "@/components/ui";
import { AuthCard, AuthField, AuthSubmit, emailProblem, useFieldErrors } from "@/components/auth/AuthCard";
import { CodeStep } from "@/components/auth/CodeStep";
import { SocialButtons } from "@/components/SocialButtons";

/** What's wrong with each field (by input id, in form order), in plain words, before anything is sent. */
function problems(f: { name: string; email: string; password: string; confirm: string; terms: boolean }) {
  return {
    name: !f.name.trim() ? "Enter your full name." : f.name.trim().length > DISPLAY_NAME_MAX ? `Keep your name under ${DISPLAY_NAME_MAX} characters.` : null,
    email: emailProblem(f.email),
    password: accountPasswordProblem(f.password),
    "confirm-password": !f.confirm ? "Enter your password again to confirm it." : f.password !== f.confirm ? "The two passwords don't match." : null,
    terms: f.terms ? null : "Accept the Terms of Service and Privacy Policy to create an account.",
  };
}

const SIGN_IN = { href: "/login", label: "Sign In" };

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [terms, setTerms] = useState(false);
  /** The server's refusal (taken email, too many tries, offline). */
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Created: the address the confirmation code went to. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const fields = useFieldErrors(problems({ name, email, password, confirm, terms }));

  // Already signed in (and verified): there is nothing to sign up for, go into the app.
  useRedirectIfSignedIn(router, !sentTo);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTaken(false);
    setError(null);
    if (!fields.submit()) return;
    setBusy(true);
    try {
      // A second press while the first is on its way is disabled; a retry after a failure that
      // did create the account just sends a new code (the API answers "confirm" again).
      const r = await signUp({ name: name.trim(), email: email.trim(), password, confirmPassword: confirm, acceptTerms: terms });
      setSentTo(r.email);
    } catch (err) {
      setTaken(errorCode(err) === "account_exists");
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthSplitShell title="Verify your email" subtitle="Enter the code we sent you to finish creating your account." action={SIGN_IN}>
      <AuthCard title="Verify your email" subtitle="Enter the code we sent you to finish creating your account.">
        <CodeStep
          large
          email={sentTo}
          submitLabel="Verify and continue"
          busyLabel="Verifying…"
          large
          onSubmit={async (code) => {
            await confirmSignUp(sentTo, code);
            await signIn(sentTo, password);
            // Through the app shell, which sends a new merchant to onboarding.
            router.replace(afterSignIn());
          }}
          onResend={() => resendSignUpCode(sentTo)}
        />
        <button type="button" className="text-sm text-muted underline" onClick={() => setSentTo(null)}>
          Use a different email address
        </button>
      </AuthSplitShell>
        <p className="text-center">
          <button type="button" className="auth-link" onClick={() => setSentTo(null)}>
            Use a different email address
          </button>
        </p>
      </AuthCard>
    );
  }

  const termsError = fields.error("terms");
  return (
    <AuthSplitShell title="Create your account" subtitle="Free to start. You'll connect your Shopify store from your dashboard." action={SIGN_IN}>
      <SocialButtons row />
      <Divider label="OR SIGN UP WITH YOUR EMAIL" />
      {error && (
        <Alert onDismiss={() => setError(null)}>
    <AuthCard title="Create your account" subtitle="Free to start. Connect your store and turn data into actionable insights.">
      {error ? (
        <Alert>
          {error}
          {taken && (
            <>
              {" "}
              <Link href="/login" className="underline">
                Sign in
              </Link>
              {" · "}
              <Link href="/forgot-password" className="underline">
                Reset password
              </Link>
            </>
          )}
        </Alert>
      ) : (
        fields.invalid && <Alert>Please review the highlighted fields before continuing.</Alert>
      )}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <IconField
          id="name"
          label="Full name"
          icon={<UserRound size={18} aria-hidden />}
      <SocialButtons large />
      <Divider label="OR SIGN UP WITH YOUR EMAIL" />
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <AuthField
          id="name"
          label="Full name"
          icon={UserRound}
          placeholder="Enter your full name"
          autoComplete="name"
          required
          maxLength={DISPLAY_NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <EmailField id="email" value={email} onChange={setEmail} />
        {/* Side by side where both fit, stacked otherwise. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] items-start gap-4">
          <PasswordField
            id="password"
            label="Password"
            autoComplete="new-password"
            minLength={ACCOUNT_PASSWORD_MIN}
            value={password}
            onChange={setPassword}
            hint={`At least ${ACCOUNT_PASSWORD_MIN} characters.`}
            icon={<Lock size={18} aria-hidden />}
            inputClassName="auth-field"
          />
          <PasswordField
            id="confirm-password"
            label="Confirm password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            icon={<Lock size={18} aria-hidden />}
            inputClassName="auth-field"
          />
        </div>
        <div className="flex items-start gap-2.5 text-sm text-muted">
          <input
            id="terms"
            type="checkbox"
            className="mt-0.5 size-[18px] shrink-0 cursor-pointer rounded accent-[var(--accent)]"
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            required
          />
          <label htmlFor="terms" className="cursor-pointer">
            I agree to the Terms of Service and the{" "}
            <Link href="/privacy" className="font-medium text-accent underline underline-offset-2" target="_blank">
              Privacy Policy
            </Link>
            .
          </label>
        </div>
        <button className="auth-cta" disabled={busy}>
          {busy ? (
            "Creating your account…"
          ) : (
            <>
              Create Account <ArrowRight size={18} aria-hidden />
            </>
          )}
        </button>
      </form>
      <p className="pt-1 text-center text-[15px] text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-accent hover:underline">
          Sign In
        </Link>
      </p>
    </AuthSplitShell>
          onBlur={fields.leave}
          error={fields.error("name")}
        />
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
        <AuthField
          id="password"
          label="Password"
          icon={Lock}
          reveal
          placeholder="Enter your password"
          autoComplete="new-password"
          required
          minLength={ACCOUNT_PASSWORD_MIN}
          maxLength={256}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={fields.leave}
          error={fields.error("password")}
          hint={`Use at least ${ACCOUNT_PASSWORD_MIN} characters.`}
        />
        <AuthField
          id="confirm-password"
          label="Confirm password"
          icon={Lock}
          reveal
          placeholder="Confirm your password"
          autoComplete="new-password"
          required
          maxLength={256}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={fields.leave}
          error={fields.error("confirm-password")}
        />
        <div>
          <div className="flex items-start gap-3">
            <input
              id="terms"
              type="checkbox"
              className={`mt-0.5 size-[18px] shrink-0 cursor-pointer accent-accent ${termsError ? "rounded outline-2 outline-offset-2 outline-danger" : ""}`}
              checked={terms}
              onChange={(e) => {
                setTerms(e.target.checked);
                fields.touch("terms");
              }}
              required
              aria-invalid={termsError ? true : undefined}
              aria-describedby={termsError ? "terms-error" : undefined}
            />
            <label htmlFor="terms" className="text-[15px] leading-snug text-text">
              I agree to the <span className="font-medium">Terms of Service</span> and the{" "}
              <Link href="/privacy" className="font-medium text-accent underline underline-offset-2 hover:opacity-80" target="_blank">
                Privacy Policy
              </Link>
              .
            </label>
          </div>
          {termsError && (
            <p id="terms-error" className="mt-2 pl-[30px] text-sm text-danger">
              {termsError}
            </p>
          )}
        </div>
        <AuthSubmit className="mt-2" busy={busy} busyLabel="Creating your account…">
          Create Account
        </AuthSubmit>
      </form>
      <p className="text-center text-[15px] text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-accent underline underline-offset-2 hover:opacity-80">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
