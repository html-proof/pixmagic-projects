"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Lock } from "lucide-react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN } from "@app/shared/auth";
import { forgotPassword, recallEmail, rememberEmail, resetPassword } from "@/lib/auth";
import { emailProblem, useFieldErrors } from "@/components/auth/AuthCard";
import { AuthSplitShell } from "@/components/auth/AuthSplitShell";
import { CodeStep } from "@/components/auth/CodeStep";
import { EmailField } from "@/components/auth/IconField";
import { PasswordField } from "@/components/auth/PasswordField";

const MISMATCH = "The two passwords don't match.";

const SIGN_IN = { href: "/login", label: "Sign In" };

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
      <AuthSplitShell title="Reset your password" subtitle="Which email address did we send the code to?" action={SIGN_IN}>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!emailFields.submit()) return;
            rememberEmail(email);
            setEmailConfirmed(true);
          }}
        >
          <EmailField id="email" value={email} onChange={setEmail} onBlur={emailFields.leave} error={emailFields.error("email")} />
          <button className="auth-cta">
            Continue <ArrowRight size={18} aria-hidden />
          </button>
        </form>
        <Link href="/forgot-password" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text">
          <ArrowLeft size={16} aria-hidden />I need a code
        </Link>
      </AuthSplitShell>
    );
  }

  return (
    <AuthSplitShell title="Choose a new password" subtitle="Enter the code from the email, then your new password." action={SIGN_IN}>
      <CodeStep
        email={email}
        intro={
          <>
            If an account exists for <strong>{email}</strong>, we&apos;ve emailed it a 6-digit code.
          </>
        }
        submitLabel="Reset password"
        busyLabel="Saving…"
        large
        extraValid={!weak && !mismatch && !!password && !!confirm}
        onSubmit={async (code) => {
          await resetPassword({ email, code, password, confirmPassword: confirm });
          router.replace("/login?reset=1");
        }}
        onResend={() => forgotPassword(email)}
      >
        <PasswordField
          id="new-password"
          label="New password"
          autoComplete="new-password"
          minLength={ACCOUNT_PASSWORD_MIN}
          value={password}
          onChange={setPassword}
          hint={`At least ${ACCOUNT_PASSWORD_MIN} characters.`}
          icon={<Lock size={18} aria-hidden />}
          inputClassName="auth-field"
          onBlur={passwordFields.leave}
          error={passwordFields.error("new-password")}
        />
        <PasswordField
          id="confirm-password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          icon={<Lock size={18} aria-hidden />}
          inputClassName="auth-field"
          onBlur={passwordFields.leave}
          error={confirmError}
        />
      </CodeStep>
      <button type="button" className="text-sm text-muted underline" onClick={() => setEmailConfirmed(false)}>
        Use a different email address
      </button>
    </AuthSplitShell>
  );
}
