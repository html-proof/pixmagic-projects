"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN, DISPLAY_NAME_MAX, isEmailAddress } from "@app/shared/auth";
import { afterSignIn, authErrorMessage, confirmSignUp, errorCode, resendSignUpCode, signIn, signUp, useRedirectIfSignedIn } from "@/lib/auth";
import { Alert, AuthShell, Divider } from "@/components/ui";
import { CodeStep } from "@/components/auth/CodeStep";
import { PasswordField } from "@/components/auth/PasswordField";
import { SocialButtons } from "@/components/SocialButtons";

/** What's wrong with the form, in plain words, before anything is sent. */
function problem(f: { name: string; email: string; password: string; confirm: string; terms: boolean }): string | null {
  if (!f.name.trim()) return "Enter your full name.";
  if (f.name.trim().length > DISPLAY_NAME_MAX) return `Keep your name under ${DISPLAY_NAME_MAX} characters.`;
  if (!isEmailAddress(f.email)) return "Enter a valid email address.";
  const weak = accountPasswordProblem(f.password);
  if (weak) return weak;
  if (f.password !== f.confirm) return "The two passwords don't match.";
  if (!f.terms) return "Accept the Terms of Service and Privacy Policy to create an account.";
  return null;
}

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Created: the address the confirmation code went to. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Already signed in (and verified): there is nothing to sign up for, go into the app.
  useRedirectIfSignedIn(router, !sentTo);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTaken(false);
    const invalid = problem({ name, email, password, confirm, terms });
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
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
      <AuthShell title="Verify your email" subtitle="Enter the code we sent you to finish creating your account.">
        <CodeStep
          email={sentTo}
          submitLabel="Verify and continue"
          busyLabel="Verifying…"
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
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="Free to start. You'll connect your Shopify store from your dashboard.">
      <SocialButtons />
      <Divider label="OR SIGN UP WITH YOUR EMAIL" />
      {error && (
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
      )}
      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <div>
          <label className="label" htmlFor="name">
            Full name
          </label>
          <input id="name" className="input" autoComplete="name" required maxLength={DISPLAY_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email Address
          </label>
          <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <PasswordField id="password" label="Password" autoComplete="new-password" minLength={ACCOUNT_PASSWORD_MIN} value={password} onChange={setPassword} hint={`At least ${ACCOUNT_PASSWORD_MIN} characters.`} />
        <PasswordField id="confirm-password" label="Confirm password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
        <div className="flex items-start gap-2 text-sm">
          <input id="terms" type="checkbox" className="mt-1" checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
          <label htmlFor="terms">
            I agree to the Terms of Service and the{" "}
            <Link href="/privacy" className="underline" target="_blank">
              Privacy Policy
            </Link>
            .
          </label>
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Creating your account…" : "Create Account"}
        </button>
      </form>
      <p className="text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-text underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
