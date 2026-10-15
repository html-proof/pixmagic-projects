"use client";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, Loader2, type LucideIcon } from "lucide-react";
import { useState, type ButtonHTMLAttributes, type FocusEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { isEmailAddress } from "@app/shared/auth";

/** Three rising bars, the mark drawn beside the wordmark at the top of the card. */
function BarsMark() {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false" className="text-accent">
      <rect x="2" y="15" width="7" height="11" rx="2" fill="currentColor" opacity="0.7" />
      <rect x="10.5" y="9" width="7" height="17" rx="2" fill="currentColor" opacity="0.85" />
      <rect x="19" y="2" width="7" height="24" rx="2" fill="currentColor" />
    </svg>
  );
}

/**
 * The account pages' card: brand, heading and the form on a raised white card over soft curves of
 * the brand colours. The same Support and Privacy links as AuthShell sit at its foot.
 */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="relative isolate flex min-h-screen items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div aria-hidden className="auth-backdrop" />
      <div className="auth-card w-full max-w-[32rem] px-6 py-8 sm:px-12 sm:py-10">
        <Link href="/" className="inline-flex items-center gap-2.5 rounded-md text-xl font-semibold text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
          <BarsMark />
          Insights
        </Link>
        <h1 className="mt-7 text-[1.75rem] leading-tight font-bold tracking-tight text-text sm:text-[2rem]">{title}</h1>
        {subtitle && <p className="mt-2 text-base leading-relaxed text-muted">{subtitle}</p>}
        <div className="mt-6 space-y-6">{children}</div>
        <p className="mt-8 border-t border-border pt-6 text-center text-sm text-muted">
          <Link className="hover:text-text hover:underline" href="/support">
            Support
          </Link>
          <span aria-hidden className="mx-2">
            ·
          </span>
          <Link className="hover:text-text hover:underline" href="/privacy">
            Privacy
          </Link>
        </p>
      </div>
    </main>
  );
}

/** What's wrong with an email address as typed, in plain words; null when it looks right. */
export function emailProblem(email: string): string | null {
  if (!email.trim()) return "Enter your email address.";
  return isEmailAddress(email) ? null : "Enter a valid email address.";
}

/** The card's main button: an arrow that nudges over on hover; a spinner and `busyLabel` while it works. */
export function AuthSubmit({
  busy = false,
  busyLabel,
  children,
  className = "",
  disabled,
  ...button
}: { busy?: boolean; busyLabel?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn-cta group ${className}`} disabled={busy || disabled} {...button}>
      {busy ? (
        <>
          <Loader2 aria-hidden className="size-5 animate-spin" />
          {busyLabel ?? children}
        </>
      ) : (
        <>
          {children}
          <ArrowRight aria-hidden className="size-5 transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
        </>
      )}
    </button>
  );
}

/**
 * When a form's problems show: a field's once the user leaves it with something in it, and every
 * field's once they try to submit; from then on each follows what they type. `errors` is keyed by
 * input id, in form order, so a refused submit can put focus on the first problem.
 */
export function useFieldErrors(errors: Record<string, string | null | undefined>) {
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const first = Object.keys(errors).find((id) => errors[id]);
  const touch = (id: string) => setLeft((l) => (l.has(id) ? l : new Set(l).add(id)));
  return {
    /** This field's problem, if it should show now. */
    error: (id: string) => (submitted || left.has(id) ? (errors[id] ?? undefined) : undefined),
    /** For onBlur: start showing the field's problem if something was typed into it. */
    leave: (e: FocusEvent<HTMLInputElement>) => {
      if (e.target.value) touch(e.target.id);
    },
    /** Start showing a field's problem now (a checkbox, as soon as it's changed). */
    touch,
    /** A submit was refused and something is still wrong: worth a word at the top of the card. */
    invalid: submitted && !!first,
    /** On submit: true when the form is good to send; otherwise every problem shows and focus goes to the first. */
    submit: () => {
      setSubmitted(true);
      if (first) document.getElementById(first)?.focus();
      return !first;
    },
    /** Forget it all (the form was swapped for another). */
    reset: () => {
      setLeft(new Set());
      setSubmitted(false);
    },
  };
}

/**
 * A labelled input with an icon inside its left edge. `error` (when set) outlines it in red and
 * replaces the hint underneath; `reveal` makes it a password input with a show/hide button.
 */
export function AuthField({
  id,
  label,
  icon: Icon,
  error,
  hint,
  reveal,
  className = "",
  type = "text",
  ...input
}: {
  id: string;
  label: string;
  icon: LucideIcon;
  error?: string | null;
  hint?: string;
  reveal?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id">) {
  const [shown, setShown] = useState(false);
  const note = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label className="mb-2 block text-[15px] font-semibold text-text" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Icon aria-hidden size={18} strokeWidth={1.9} className={`pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 ${error ? "text-danger" : "text-muted"}`} />
        <input
          id={id}
          type={reveal ? (shown ? "text" : "password") : type}
          className={`auth-input ${reveal ? "pr-12" : "pr-4"} ${className}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={note}
          {...input}
        />
        {reveal && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-muted transition hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            aria-pressed={shown}
            aria-controls={id}
            onClick={() => setShown((s) => !s)}
          >
            {shown ? <EyeOff size={19} aria-hidden /> : <Eye size={19} aria-hidden />}
          </button>
        )}
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-2 text-sm text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
