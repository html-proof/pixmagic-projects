"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN, isEmailAddress } from "@app/shared/auth";
import { forgotPassword, recallEmail, rememberEmail, resetPassword } from "@/lib/auth";
import { Alert, AuthShell } from "@/components/ui";
import { CodeStep } from "@/components/auth/CodeStep";
import { PasswordField } from "@/components/auth/PasswordField";

/** Step 2 of a password reset: the emailed code and the new password, then back to sign in. */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [emailConfirmed, setEmailConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    const known = recallEmail();
    setEmail(known);
    setEmailConfirmed(!!known);
  }, []);

  const weak = password ? accountPasswordProblem(password) : null;
  const mismatch = !!confirm && password !== confirm;

  if (!emailConfirmed) {
    return (
      <AuthShell title="Reset your password" subtitle="Which email address did we send the code to?">
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!isEmailAddress(email)) return;
            rememberEmail(email);
            setEmailConfirmed(true);
          }}
        >
          <div>
            <label className="label" htmlFor="email">
              Email Address
            </label>
            <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn-primary w-full">Continue</button>
        </form>
        <Link href="/forgot-password" className="block text-sm text-muted underline">
          I need a code
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Enter the code from the email, then your new password.">
      <CodeStep
        email={email}
        intro={
          <>
            If an account exists for <strong>{email}</strong>, we&apos;ve emailed it a 6-digit code.
          </>
        }
        submitLabel="Reset password"
        busyLabel="Saving…"
        extraValid={!weak && !mismatch && !!password && !!confirm}
        onSubmit={async (code) => {
          await resetPassword({ email, code, password, confirmPassword: confirm });
          router.replace("/login?reset=1");
        }}
        onResend={() => forgotPassword(email)}
      >
        <PasswordField id="new-password" label="New password" autoComplete="new-password" minLength={ACCOUNT_PASSWORD_MIN} value={password} onChange={setPassword} hint={`At least ${ACCOUNT_PASSWORD_MIN} characters.`} />
        <PasswordField id="confirm-password" label="Confirm new password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
        {weak && <Alert kind="info">{weak}</Alert>}
        {mismatch && <Alert kind="info">The two passwords don&apos;t match yet.</Alert>}
      </CodeStep>
      <button type="button" className="text-sm text-muted underline" onClick={() => setEmailConfirmed(false)}>
        Use a different email address
      </button>
    </AuthShell>
  );
}
