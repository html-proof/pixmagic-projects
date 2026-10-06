"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { signInWithCustomToken, signInWithEmailAndPassword } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { api, isTransient, keepRetrying } from "@/lib/api";
import { authErrorMessage, establishSession } from "@/lib/session";
import { emailLinkCode, linkEmail, rememberLinkEmail, signInWithEmailLinkCode } from "@/lib/emailLink";
import { Alert, AuthShell, Divider } from "@/components/ui";
import { SocialButtons } from "@/components/SocialButtons";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { takeReturnTo } from "@/lib/returnTo";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  // How the last email went out: a 6-digit code, or (when codes can't be emailed) a sign-in link.
  const [delivery, setDelivery] = useState<"code" | "link">("code");
  // Opened from an emailed sign-in link: its code, until it has been redeemed.
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const linkStarted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const cred = await signInWithEmailAndPassword(firebaseAuth(), email, password);
      await establishSession(cred.user);
      router.replace(takeReturnTo() ?? "/");
    });
  };

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    void run(async () => {
      const { method } = await api<{ method?: "code" | "link" }>("/auth/otp/request", { method: "POST", body: { email, continuePath: "/login" } });
      setCodeSent(true);
      if (method === "link") {
        rememberLinkEmail(email.trim().toLowerCase());
        setDelivery("link");
        setInfo(`If ${email} can receive email, a sign-in link is on its way. Open it on this device to finish signing in.`);
      } else {
        setDelivery("code");
        setInfo(`If ${email} can receive email, a 6-digit code is on its way. It expires in 10 minutes.`);
      }
    });
  };

  /** Finish a sign-in started from an emailed link. */
  const redeemLink = (address: string, oobCode: string) =>
    run(async () => {
      try {
        await signInWithEmailLinkCode(address.trim().toLowerCase(), oobCode);
      } catch (err) {
        // A used or expired link can't be retried: start over from the email form.
        setLinkCode(null);
        throw err;
      }
      router.replace(takeReturnTo() ?? "/");
    });

  // Opened from a sign-in link (?mode=signIn&oobCode=…): finish right away when we know the email.
  useEffect(() => {
    if (linkStarted.current) return;
    linkStarted.current = true;
    const oob = emailLinkCode(window.location.search);
    if (!oob) return;
    setMode("code");
    setLinkCode(oob);
    const remembered = linkEmail();
    if (remembered) {
      setEmail(remembered);
      void redeemLink(remembered, oob);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Already signed in (say, sent here during an outage by an older build, which took any failure
  // for a sign-out): go back into the app instead of asking for credentials again. While the API
  // is unreachable we can't tell, so keep asking until it answers. Not when finishing an emailed
  // sign-in link (redeeming it is why we're here), and not right after signing out.
  useEffect(() => {
    const search = window.location.search;
    if (emailLinkCode(search) || new URLSearchParams(search).has("signedOut")) return;
    let stopped = false;
    let stopRetrying: (() => void) | undefined;
    const check = async () => {
      try {
        const me = await api<{ user: { emailVerified: boolean } }>("/me");
        // Verified only, like /start: /verify-email sends an unverified session here, and sending
        // it back into the app would bounce it straight back.
        if (me.user.emailVerified) router.replace(takeReturnTo() ?? "/");
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

  const confirmLinkEmail = (e: FormEvent) => {
    e.preventDefault();
    if (linkCode) void redeemLink(email, linkCode);
  };

  const verifyCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { customToken } = await api<{ customToken: string }>("/auth/otp/verify", { method: "POST", body: { email, code } });
      const cred = await signInWithCustomToken(firebaseAuth(), customToken);
      await establishSession(cred.user);
      router.replace(takeReturnTo() ?? "/");
    });
  };

  return (
    <AuthShell title="Sign in" subtitle="Welcome back. Pick whichever way is easiest.">
      <div className="space-y-2">
        <Link href="/start" className="btn-primary w-full">
          <ShopifyIcon />
          Continue with Shopify
        </Link>
        <SocialButtons />
      </div>
      <Divider label="or with email" />
      <div className="flex gap-2 text-sm" role="tablist">
        <button role="tab" aria-selected={mode === "password"} className={mode === "password" ? "font-semibold underline" : "text-muted"} onClick={() => setMode("password")}>
          Password
        </button>
        <button role="tab" aria-selected={mode === "code"} className={mode === "code" ? "font-semibold underline" : "text-muted"} onClick={() => setMode("code")}>
          Email me a code
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {info && <Alert kind="info">{info}</Alert>}

      {linkCode ? (
        <form onSubmit={confirmLinkEmail} className="space-y-3">
          <p className="text-sm">{busy ? "Signing you in…" : "Confirm the email address the sign-in link was sent to."}</p>
          <div>
            <label className="label" htmlFor="link-email">Email</label>
            <input id="link-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn-primary w-full" disabled={busy}>Sign in</button>
        </form>
      ) : mode === "password" ? (
        <form onSubmit={onPassword} className="space-y-3">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="btn-primary w-full" disabled={busy}>Sign in</button>
          <Link href="/reset" className="block text-sm text-muted underline">Forgot your password?</Link>
        </form>
      ) : !codeSent ? (
        <form onSubmit={sendCode} className="space-y-3">
          <div>
            <label className="label" htmlFor="otp-email">Email</label>
            <input id="otp-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn-primary w-full" disabled={busy}>Send me a code</button>
        </form>
      ) : delivery === "link" ? (
        <div className="space-y-2 text-sm">
          <p className="text-muted">Didn&apos;t get it? Check your spam folder, or send another.</p>
          <button type="button" className="btn-secondary w-full" onClick={() => sendCode()} disabled={busy}>Send a new link</button>
          <button type="button" className="text-muted underline" onClick={() => { setCodeSent(false); setInfo(null); }} disabled={busy}>Use a different email</button>
        </div>
      ) : (
        <form onSubmit={verifyCode} className="space-y-3">
          <div>
            <label className="label" htmlFor="otp">6-digit code</label>
            <input id="otp" className="input tracking-[0.5em]" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </div>
          <button className="btn-primary w-full" disabled={busy || code.length !== 6}>Verify and sign in</button>
          <button type="button" className="text-sm text-muted underline" onClick={() => sendCode()} disabled={busy}>Send a new code</button>
        </form>
      )}

      <p className="text-sm text-muted">
        New here? <Link href="/signup" className="underline">Create an account</Link>
      </p>
    </AuthShell>
  );
}
