"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { signInWithCustomToken, type User } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";
import { api, ApiError, friendlyError, isTransient, keepRetrying } from "@/lib/api";
import { authErrorMessage, establishSession } from "@/lib/session";
import { Alert, AuthShell } from "@/components/ui";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { emailLinkCode, forgetLinkEmail, linkEmail, rememberLinkEmail } from "@/lib/emailLink";
import { isSafePath } from "@/lib/returnTo";

/**
 * Shopify-first sign-up: email → Continue with Shopify → (Shopify approval) → finish → dashboard.
 * The API keeps the real state in an httpOnly signup cookie; the browser only remembers the email
 * (sessionStorage) so the form is still filled in after the round trip to Shopify.
 */

type Panel = "email" | "connect" | "finishing" | "verify" | "failed";
/** The email still to be proven by code; `reissue_expired`: Shopify's proof can no longer sign in on its own. */
type VerifyTarget = { email: string; shopifyEmail: string | null; reason?: "reissue_expired" };
type FinishResult = { status: "signed_in"; customToken: string; email: string } | ({ status: "verify_email" } & VerifyTarget);
type ClaimResult = { next: string; workspaceId: string; storeId: string };
type Failure = { code: string; message: string; retry?: () => void };

const EMAIL_KEY = "insights:start-email";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Errors the API puts in `/start?error=` when Shopify's redirect can't be completed. */
const SHOPIFY_ERRORS: Record<string, string> = {
  invalid_hmac: "Shopify's response couldn't be verified. Please try again.",
  state_mismatch: "The connection was started in a different browser or tab. Please start again here.",
  state_expired: "That connection link expired. Please try again.",
  stale_request: "That request was too old. Please try again.",
  shop_mismatch: "Shopify returned a different store than the one you picked. Please try again.",
  app_mismatch: "Shopify answered for a different version of our app than the one this connection started with. Please start again.",
  missing_required_scopes: "We need permission to read orders to show any numbers. Please approve access on Shopify.",
  exchange_failed: "Shopify didn't complete the connection. Please try again.",
  signup_expired: "That took a little too long. Please start again.",
  missing_params: "Shopify didn't send everything we need. Please try again.",
  invalid_shop: "That doesn't look like a Shopify store address. Please try again.",
  shop_required: "Enter your store's myshopify.com address so we can open the right install page.",
  app_unavailable: "This store can't install our app yet. Please contact support so we can set it up for your store.",
  launch_unverified: "That link didn't come through from Shopify intact. Open Insights again from your Shopify admin, or enter your store address below.",
  temporarily_unavailable: "We couldn't reach our servers. Please try again in a minute.",
};
const SHOPIFY_FALLBACK = "Shopify didn't complete the connection. Please try again.";
const INVALID_SHOP =
  "Enter your store's myshopify.com address, e.g. your-store.myshopify.com. You'll find it in Shopify admin under Settings → Domains.";

/** These end the attempt: the only way forward is to start again (or go elsewhere). */
const FATAL = new Set(["signup_expired", "store_taken", "email_mismatch"]);

const PHASES = ["Confirming your Shopify account", "Signing you in", "Setting up your dashboard"];
const STEPS = ["Your email", "Connect Shopify", "Your dashboard"];

const TRUST_POINTS = [
  "Read-only access. We never change anything in your store.",
  "We import your orders, products, inventory, refunds and discounts.",
  "Customer names, emails and addresses are never stored.",
  "Disconnect any time from Settings or your Shopify admin.",
];

function readEmail(): string {
  try {
    return sessionStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveEmail(email: string | null) {
  try {
    if (email) sessionStorage.setItem(EMAIL_KEY, email);
    else sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    /* private mode: the user just retypes it */
  }
}

/** Open the dashboard on the store just connected (same localStorage keys the app shell reads). */
function selectStore(workspaceId: string | undefined, storeId: string | undefined) {
  if (!workspaceId) return;
  try {
    localStorage.setItem("ws", workspaceId);
    if (storeId) localStorage.setItem(`store:${workspaceId}`, storeId);
  } catch {
    /* storage blocked: the dashboard falls back to the first workspace/store */
  }
}

/** Only follow same-site paths from the API (never an absolute or protocol-relative URL). */
const safeNext = (next: string | undefined) => (isSafePath(next) ? next : "/");

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "signup_expired") return SHOPIFY_ERRORS.signup_expired!;
    if (err.code === "email_mismatch") {
      return "You're signed in with a different email than the one you started with. Please start again.";
    }
    if (err.code === "invalid_shop") return INVALID_SHOP;
    if (err.code === "shop_required" || err.code === "app_unavailable") return SHOPIFY_ERRORS[err.code]!;
    if (err.code === "validation") return "Please check your details and try again.";
    if (err.code === "csrf") return "Please open this page from the app's usual address and try again.";
    return err.message;
  }
  return authErrorMessage(err);
}

function Progress({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-xs" aria-label="Progress">
      {STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === step ? "step" : undefined}
          className={`rounded-full border px-3 py-1 ${i < step ? "border-good text-good" : i === step ? "border-accent font-semibold" : "border-border text-muted"}`}
        >
          {i < step ? "✓ " : `${i + 1}. `}
          {label}
        </li>
      ))}
    </ol>
  );
}

function Spinner() {
  return <span aria-hidden="true" className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
}

function Start() {
  const router = useRouter();
  const params = useSearchParams();
  const finishing = params.get("step") === "finish";
  // Back from an emailed sign-in link (when a code couldn't be emailed): /start?step=link&mode=signIn&oobCode=…
  const linkCode = params.get("step") === "link" ? emailLinkCode(`?${params.toString()}`) : null;
  const errorCode = params.get("error");
  const shopParam = params.get("shop");

  // null until we've read sessionStorage, so the right panel shows first time (no flicker).
  const [panel, setPanel] = useState<Panel | null>(finishing || linkCode ? "finishing" : null);
  const [email, setEmail] = useState("");
  const [showShop, setShowShop] = useState(!!shopParam);
  const [shop, setShop] = useState((shopParam ?? "").replace(/\.myshopify\.com$/i, ""));
  const [error, setError] = useState<string | null>(errorCode ? (SHOPIFY_ERRORS[errorCode] ?? SHOPIFY_FALLBACK) : null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [verify, setVerify] = useState<VerifyTarget | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Why the signed-in check last failed, while it fails for outage-shaped reasons. */
  const [checkError, setCheckError] = useState<unknown>(null);
  const started = useRef(false);

  /**
   * Already signed in with a verified email (and no error to show) → the app. Unverified sessions
   * may use this flow to prove their email. Only an answer counts as "not signed in": while the
   * check itself fails (API or database unreachable) a signed-in merchant would otherwise be left on
   * this sign-up form, and could start a second account, so the form waits until it gets one.
   * Resolves true once there is nothing left to retry.
   */
  const checkSignedIn = useCallback(async () => {
    try {
      // /auth/whoami: a visitor is `user: null`, not a 401 the browser would log as an error.
      const me = await api<{ user: { emailVerified: boolean } | null }>("/auth/whoami");
      if (me.user?.emailVerified && !errorCode) router.replace("/");
    } catch (err) {
      if (isTransient(err)) {
        setCheckError(err);
        return false;
      }
      /* not signed in: stay here */
    }
    setCheckError(null);
    return true;
  }, [router, errorCode]);

  // First load: restore the email, and (unless mid-sign-up) check whether they're already signed in.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const saved = readEmail();
    setEmail(saved);
    if (finishing) {
      void finish({});
      return;
    }
    if (linkCode) {
      void finishFromLink(linkCode);
      return;
    }
    setPanel(saved ? "connect" : "email");
    void checkSignedIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkFailing = checkError !== null;
  useEffect(() => (checkFailing ? keepRetrying(checkSignedIn) : undefined), [checkFailing, checkSignedIn]);

  // Coming back with the browser's Back button from Shopify restores the page as it was: re-enable it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  function fail(err: unknown, retry?: () => void) {
    const errCode = err instanceof ApiError ? err.code : "";
    setFailure({ code: errCode, message: errorMessage(err), retry: FATAL.has(errCode) ? undefined : retry });
    setBusy(false);
    setPanel("failed");
  }

  // ---------------- Email → connect ----------------

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) return setError("Enter a valid email address.");
    setEmail(value);
    saveEmail(value);
    setError(null);
    setPanel("connect");
  }

  function changeEmail() {
    setError(null);
    setPanel("email");
  }

  /** Ask the API for the Shopify URL (it sets the signup cookie that binds the flow to this browser). */
  async function continueWithShopify(e: FormEvent) {
    e.preventDefault();
    const body: { email: string; shop?: string } = { email };
    if (showShop && shop.trim()) body.shop = shop.trim();
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/auth/shopify/start", { method: "POST", body });
      window.location.assign(url);
    } catch (err) {
      // shop_required: Shopify's store picker can't reach this merchant's app, so the address
      // field is the way through. Open it rather than leaving a dead end.
      if (err instanceof ApiError && err.code === "shop_required") setShowShop(true);
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  // ---------------- Back from Shopify ----------------

  /** Custom token (from Shopify, an email code or link) → Firebase sign-in. startSession comes next. */
  async function firebaseSignIn(customToken: string): Promise<User> {
    setPanel("finishing");
    setPhase(1);
    return (await signInWithCustomToken(firebaseAuth(), customToken)).user;
  }

  /** Prove the email by code (or choose Shopify's): a fresh step, so no earlier code carries over. */
  function showVerify({ email, shopifyEmail, reason }: VerifyTarget) {
    setVerify({ email, shopifyEmail, reason });
    setCodeSent(false);
    setLinkSent(false);
    setCode("");
    setInfo(null);
    setBusy(false);
    setPanel("verify");
  }

  /** Signed in: attach the store to the account, then open wherever the API says (sync page or dashboard). */
  function claim(retrying = false) {
    setPanel("finishing");
    setPhase(2);
    api<ClaimResult>("/auth/shopify/claim", { method: "POST", body: {} })
      .then(({ next, workspaceId, storeId }) => {
        saveEmail(null);
        selectStore(workspaceId, storeId);
        router.replace(safeNext(next));
      })
      .catch(async (err) => {
        // A retry that finds the signup already used means the first attempt went through but its
        // answer was lost: if the account has a workspace now, just open the app.
        if (retrying && err instanceof ApiError && err.code === "signup_expired") {
          const me = await api<{ workspaces: unknown[] }>("/me").catch(() => null);
          if (me?.workspaces.length) {
            saveEmail(null);
            return router.replace("/");
          }
        }
        // Already signed in, so a transient failure only needs this step retried.
        fail(err, () => claim(true));
      });
  }

  async function finish(input: { useShopifyEmail?: boolean }) {
    setPanel("finishing");
    setPhase(0);
    setError(null);
    let user: User;
    try {
      const r = await api<FinishResult>("/auth/shopify/finish", { method: "POST", body: input });
      if (r.status === "verify_email") return showVerify(r);
      user = await firebaseSignIn(r.customToken);
    } catch (err) {
      // The signup is still intact after a failed finish or sign-in, so retrying is safe.
      return fail(err, () => void finish(input));
    }
    startSession(user, input);
  }

  /**
   * Signed in to Firebase: mint our session cookie, then claim. When only this step failed (our
   * API or database unreachable), "Try again" repeats just this step: what got us signed in is
   * spent (an email code or link is single use; finish only re-issues its token for a couple of
   * minutes). `input` is the finish to fall back on once the sign-in is too old for a session.
   */
  function startSession(user: User, input: { useShopifyEmail?: boolean }) {
    setPanel("finishing");
    setPhase(1);
    establishSession(user).then(
      () => claim(),
      (err) =>
        // Sessions are only minted from a recent sign-in. Past that, finish signs in afresh (or,
        // once its window has passed too, asks for an email code), and the signup carries on.
        err instanceof ApiError && err.code === "stale_sign_in" ? void finish(input) : fail(err, () => startSession(user, input)),
    );
  }

  /** A failure on the verify panel keeps the user there unless it ends the attempt. */
  function verifyFailed(err: unknown) {
    if (err instanceof ApiError && FATAL.has(err.code)) return fail(err);
    setPanel("verify");
    setBusy(false);
    setError(errorMessage(err));
  }

  async function continueAsShopifyEmail() {
    setBusy(true);
    setError(null);
    const input = { useShopifyEmail: true };
    let user: User;
    try {
      const r = await api<FinishResult>("/auth/shopify/finish", { method: "POST", body: input });
      // Shopify's proof has lapsed (an earlier attempt signed in but its session failed): that
      // address now gets a code, so the store still ends up on the account they chose.
      if (r.status === "verify_email") return showVerify(r);
      user = await firebaseSignIn(r.customToken);
    } catch (err) {
      return verifyFailed(err);
    }
    startSession(user, input);
  }

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    if (!verify) return;
    setBusy(true);
    setError(null);
    try {
      const { method } = await api<{ method?: "code" | "link" }>("/auth/otp/request", { method: "POST", body: { email: verify.email, continuePath: "/start" } });
      if (method === "link") {
        // Codes can't be emailed right now: Firebase sent a one-click link that comes back here.
        rememberLinkEmail(verify.email);
        setLinkSent(true);
        setInfo(`We emailed a sign-in link to ${verify.email}. Open it in this browser to finish connecting your store.`);
        return;
      }
      setCodeSent(true);
      setCode("");
      setInfo(`We emailed a 6-digit code to ${verify.email}. It expires in 10 minutes.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    if (!verify) return;
    setBusy(true);
    setError(null);
    let codeUsed = false;
    let user: User;
    try {
      const { customToken } = await api<{ customToken: string }>("/auth/otp/verify", { method: "POST", body: { email: verify.email, code } });
      codeUsed = true;
      user = await firebaseSignIn(customToken);
    } catch (err) {
      // Codes are single use: if sign-in failed after the code was accepted, offer a fresh one.
      if (codeUsed) {
        setCodeSent(false);
        setInfo(null);
      }
      return verifyFailed(err);
    }
    startSession(user, {});
  }

  /** Opened from the emailed sign-in link: prove the email with it, then connect the store. */
  async function finishFromLink(oobCode: string) {
    setPanel("finishing");
    setPhase(1);
    const address = linkEmail() || readEmail();
    if (!address) {
      return fail(new ApiError(400, "link_other_browser", "Open the sign-in link in the browser where you started, or start again."));
    }
    let user: User;
    try {
      const { customToken } = await api<{ customToken: string }>("/auth/email-link/verify", { method: "POST", body: { email: address, oobCode } });
      user = await firebaseSignIn(customToken);
    } catch (err) {
      return fail(err);
    }
    // The link is spent now (reopening it can't sign in again), so only the session step is retried.
    forgetLinkEmail();
    startSession(user, {});
  }

  function startAgain() {
    // Drop the server-side signup too, so nothing approved so far lingers in this browser.
    void api("/auth/shopify/cancel", { method: "POST", body: {} }).catch(() => {});
    setFailure(null);
    setError(null);
    setInfo(null);
    setVerify(null);
    setCodeSent(false);
    setCode("");
    setBusy(false);
    setPanel("email");
    router.replace("/start");
  }

  // ---------------- Panels ----------------

  if (panel === null) return <main className="min-h-screen" />;

  // No answer yet on whether they're signed in (an outage): hold the form back until there is one.
  if (checkFailing && (panel === "email" || panel === "connect")) {
    return (
      <AuthShell title="Just a moment…" subtitle="Checking whether you're already signed in.">
        <Alert kind="info">{friendlyError(checkError)}</Alert>
        <button type="button" className="btn-secondary w-full" onClick={() => void checkSignedIn()}>Try again</button>
      </AuthShell>
    );
  }

  if (panel === "email") {
    return (
      <AuthShell
        title="See your Shopify store's numbers in minutes"
        subtitle="Sales, orders, products and stock in plain language, straight from your Shopify store. Free to start."
      >
        <Progress step={0} />
        {error && <Alert>{error}</Alert>}
        {shopParam && !error && <Alert kind="info">You&apos;re connecting {shopParam}.</Alert>}
        <form onSubmit={submitEmail} className="space-y-3" noValidate>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@yourstore.com"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">We&apos;ll use it for your account. No password needed.</p>
          </div>
          <button className="btn-primary w-full py-2.5">Continue</button>
        </form>
        <p className="text-sm text-muted">
          Already have an account? <Link href="/login" className="underline">Sign in</Link>
        </p>
      </AuthShell>
    );
  }

  if (panel === "connect") {
    return (
      <AuthShell title="Connect your Shopify store" subtitle="Shopify will ask you to sign in and approve access, then bring you straight back here.">
        <Progress step={1} />
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          <span className="min-w-0 truncate">
            <span className="text-muted">Continuing as </span>
            <span className="font-medium" data-testid="start-email">{email}</span>
          </span>
          <button type="button" className="shrink-0 text-accent underline" onClick={changeEmail} disabled={busy}>
            Change
          </button>
        </div>
        {error && <Alert>{error}</Alert>}

        <form onSubmit={continueWithShopify} className="space-y-3">
          {showShop && (
            <div id="shop-field">
              <label className="label" htmlFor="shop">Store address</label>
              <div className="flex items-center gap-2">
                <input
                  id="shop"
                  className="input"
                  placeholder="your-store"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={shop}
                  onChange={(e) => setShop(e.target.value)}
                />
                <span className="shrink-0 text-sm text-muted">.myshopify.com</span>
              </div>
              <p className="mt-1 text-xs text-muted">Optional. Takes you straight to that store&apos;s approval screen.</p>
            </div>
          )}
          <button className="btn-primary w-full py-3 text-base" disabled={busy}>
            <ShopifyIcon size={20} />
            {busy ? "Opening Shopify…" : "Continue with Shopify"}
          </button>
          <button
            type="button"
            className="block text-sm text-muted underline"
            aria-expanded={showShop}
            aria-controls="shop-field"
            onClick={() => setShowShop((v) => !v)}
          >
            {showShop ? "I don't know my store address" : "Know your store address?"}
          </button>
        </form>

        <ul className="space-y-2 rounded-xl border border-border bg-surface p-4 text-sm" aria-label="What you're agreeing to">
          {TRUST_POINTS.map((t) => (
            <li key={t} className="flex gap-2">
              <span aria-hidden="true" className="text-good">✓</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">
          Already have an account? <Link href="/login" className="underline">Sign in</Link>
        </p>
      </AuthShell>
    );
  }

  if (panel === "finishing") {
    return (
      <AuthShell title="Finishing up…" subtitle="Hang tight, this only takes a few seconds.">
        <Progress step={2} />
        <ul className="card space-y-3 text-sm" aria-live="polite">
          {PHASES.map((label, i) => (
            <li key={label} className={`flex items-center gap-3 ${i < phase ? "text-good" : i === phase ? "font-medium" : "text-muted"}`}>
              {i < phase ? <span aria-hidden="true" className="w-4 text-center">✓</span> : i === phase ? <Spinner /> : <span aria-hidden="true" className="w-4 text-center">·</span>}
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </AuthShell>
    );
  }

  if (panel === "verify" && verify) {
    const { shopifyEmail } = verify;
    return (
      <AuthShell title="Confirm your email" subtitle="One quick check to keep your store data safe.">
        <Progress step={2} />
        <p className="text-sm">
          {shopifyEmail ? (
            <>
              Your Shopify account uses <strong>{shopifyEmail}</strong>, which is different from <strong>{verify.email}</strong>. Choose the
              email you&apos;ll sign in with.
            </>
          ) : verify.reason === "reissue_expired" ? (
            <>
              To finish signing in, we&apos;ll email a 6-digit code to <strong>{verify.email}</strong>.
            </>
          ) : (
            <>
              Shopify couldn&apos;t confirm the email on your Shopify account, so we&apos;ll email a 6-digit code to <strong>{verify.email}</strong>{" "}
              instead.
            </>
          )}
        </p>
        {error && <Alert>{error}</Alert>}
        {info && <Alert kind="info">{info}</Alert>}

        {!codeSent ? (
          <div className="space-y-2">
            {shopifyEmail && (
              <button type="button" className="btn-primary w-full" disabled={busy} onClick={continueAsShopifyEmail}>
                Continue as {shopifyEmail}
              </button>
            )}
            <button type="button" className={`${shopifyEmail ? "btn-secondary" : "btn-primary"} w-full`} disabled={busy} onClick={() => sendCode()}>
              {linkSent ? `Send another link to ${verify.email}` : `Email a code to ${verify.email}`}
            </button>
          </div>
        ) : (
          <form onSubmit={verifyCode} className="space-y-3">
            <div>
              <label className="label" htmlFor="otp">6-digit code</label>
              <input
                id="otp"
                className="input tracking-[0.5em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <button className="btn-primary w-full" disabled={busy || code.length !== 6}>Verify and continue</button>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <button type="button" className="underline" onClick={() => sendCode()} disabled={busy}>Send a new code</button>
              {shopifyEmail && (
                <button type="button" className="underline" onClick={continueAsShopifyEmail} disabled={busy}>
                  Use {shopifyEmail} instead
                </button>
              )}
            </div>
          </form>
        )}
        <button type="button" className="text-sm text-muted underline" onClick={startAgain} disabled={busy}>Start again</button>
      </AuthShell>
    );
  }

  // "failed" (or a verify panel without data, which can't normally happen).
  const f = failure ?? { code: "", message: SHOPIFY_FALLBACK };
  return (
    <AuthShell title="We couldn't finish setting up" subtitle="Nothing was changed in your Shopify store.">
      <Alert>{f.message}</Alert>
      <div className="space-y-2">
        {f.retry && (
          <button type="button" className="btn-primary w-full" onClick={f.retry}>Try again</button>
        )}
        <button type="button" className={`${f.retry ? "btn-secondary" : "btn-primary"} w-full`} onClick={startAgain}>Start again</button>
        {f.code === "store_taken" && (
          <Link href="/dashboard" className="btn-secondary w-full">Go to your dashboard</Link>
        )}
      </div>
    </AuthShell>
  );
}

export default function StartPage() {
  return (
    <Suspense>
      <Start />
    </Suspense>
  );
}
