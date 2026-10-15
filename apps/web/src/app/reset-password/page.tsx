"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Lock, Mail } from "lucide-react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN } from "@app/shared/auth";
import { forgotPassword, recallEmail, rememberEmail, resetPassword } from "@/lib/auth";
import { AuthCard, AuthField, AuthSubmit, emailProblem, useFieldErrors } from "@/components/auth/AuthCard";
import { CodeStep } from "@/components/auth/CodeStep";

const MISMATCH = "The two passwords don't match.";

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
  const emailFields = useFieldErrors({ email: emailProblem(email) });
  const passwordFields = useFieldErrors({ "new-password": weak, "confirm-password": mismatch ? MISMATCH : null });
  // The reset button stays off until both are right, so say why without waiting for the field to
  // be left: a confirmation as long as the password that still differs is a real mismatch.
  const confirmError = passwordFields.error("confirm-password") ?? (mismatch && confirm.length >= password.length ? MISMATCH : undefined);

  if (!emailConfirmed) {
    return (
      <AuthCard title="Reset your password" subtitle="Which email address did we send the code to?">
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!emailFields.submit()) return;
            rememberEmail(email);
            setEmailConfirmed(true);
          }}
        >
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
            onBlur={emailFields.leave}
            error={emailFields.error("email")}
          />
          <AuthSubmit className="mt-2">Continue</AuthSubmit>
        </form>
        <p className="text-center">
          <Link href="/forgot-password" className="auth-link">
            I need a code
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" subtitle="Enter the code from the email, then your new password.">
      <CodeStep
        large
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
        <AuthField
          id="new-password"
          label="New password"
          icon={Lock}
          reveal
          placeholder="Enter a new password"
          autoComplete="new-password"
          required
          minLength={ACCOUNT_PASSWORD_MIN}
          maxLength={256}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={passwordFields.leave}
          error={passwordFields.error("new-password")}
          hint={`Use at least ${ACCOUNT_PASSWORD_MIN} characters.`}
        />
        <AuthField
          id="confirm-password"
          label="Confirm new password"
          icon={Lock}
          reveal
          placeholder="Confirm your new password"
          autoComplete="new-password"
          required
          maxLength={256}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={passwordFields.leave}
          error={confirmError}
        />
      </CodeStep>
      <p className="text-center">
        <button type="button" className="auth-link" onClick={() => setEmailConfirmed(false)}>
          Use a different email address
        </button>
      </p>
    </AuthCard>
  );
}
