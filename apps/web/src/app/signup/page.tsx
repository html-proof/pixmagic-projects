"use client";
import Link from "next/link";
import { ValidatedInput } from "@/components/FieldError";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createUserWithEmailAndPassword, sendEmailVerification, updateProfile, type User } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { api, isTransient, keepRetrying } from "@/lib/api";
import { afterSignIn, authErrorMessage, establishSession } from "@/lib/session";
import { Alert, AuthShell, Divider } from "@/components/ui";
import { SocialButtons } from "@/components/SocialButtons";

/** PATCH /me's limit on a display name. */
const NAME_MAX = 80;
const PASSWORD_MIN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What's wrong with the form, in plain words, before anything is sent. */
function problem(name: string, email: string, password: string): string | null {
  if (!name.trim()) return "Enter your name.";
  if (name.trim().length > NAME_MAX) return `Keep your name under ${NAME_MAX} characters.`;
  if (!EMAIL_RE.test(email.trim())) return "Enter a valid email address.";
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for your password.`;
  return null;
}

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The account an earlier attempt created, when signing it in then failed (an outage). */
  const created = useRef<User | null>(null);

  // Already signed in (and verified): there is nothing to sign up for, go into the app.
  useEffect(() => {
    let stopped = false;
    let stopRetrying: (() => void) | undefined;
    const check = async () => {
      try {
        // /auth/whoami: a visitor is `user: null`, not a 401 the browser would log as an error.
        const me = await api<{ user: { emailVerified: boolean } | null }>("/auth/whoami");
        if (me.user?.emailVerified) router.replace(afterSignIn());
        return true;
      } catch (e) {
        return !isTransient(e);
      }
    };
    void check().then((done) => {
      if (!done && !stopped) stopRetrying = keepRetrying(check);
    });
    return () => {
      stopped = true;
      stopRetrying?.();
    };
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const invalid = problem(name, email, password);
    setTaken(false);
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      const address = email.trim();
      // A retry after the session step failed: the Firebase account already exists, so creating
      // it again would only answer "email already in use".
      let user = created.current?.email === address.toLowerCase() ? created.current : null;
      if (!user) {
        user = (await createUserWithEmailAndPassword(firebaseAuth(), address, password)).user;
        created.current = user;
        // Before the session: the ID token sent to the API then carries the name.
        await updateProfile(user, { displayName: name.trim() }).catch(() => {});
      }
      await establishSession(user);
      // Not fatal: /verify-email can send it again, and a throttled send must not strand an
      // account that already exists with no way back into it.
      await sendEmailVerification(user, { url: `${window.location.origin}/verify-email` }).catch(() => {});
      router.replace("/verify-email");
    } catch (err) {
      setTaken((err as { code?: string }).code === "auth/email-already-in-use");
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Free to start. You'll connect your Shopify store from your dashboard.">
      <SocialButtons />
      <Divider label="or sign up with your email" />
      {error && (
        <Alert>
          {error}
          {taken && (
            <>
              {" "}
              <Link href="/login" className="underline">Log in</Link>
            </>
          )}
        </Alert>
      )}
      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <ValidatedInput id="name" className="input" autoComplete="name" required maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <ValidatedInput id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <ValidatedInput id="password" className="input" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="mt-1 text-xs text-muted">At least {PASSWORD_MIN} characters.</p>
        </div>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Creating your account…" : "Create account"}</button>
      </form>
      <p className="text-sm text-muted">
        Already have an account? <Link href="/login" className="font-medium text-text underline">Log in</Link>
      </p>
    </AuthShell>
  );
}
