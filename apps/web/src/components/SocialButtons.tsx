"use client";
import { getRedirectResult, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithRedirect, type UserCredential } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { firebaseAuth } from "@/lib/firebase";
import { afterSignIn, authErrorMessage, establishSession } from "@/lib/session";
import { Alert } from "./ui";

/** Firebase's answers when a provider isn't switched on, or isn't set up, for this project. */
const NOT_CONFIGURED = new Set([
  "auth/operation-not-allowed",
  "auth/configuration-not-found",
  "auth/invalid-oauth-client-id",
  "auth/unauthorized-domain",
  // The build has no NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: popups have nowhere to sign in.
  "auth/auth-domain-config-required",
]);

type ProviderName = "Google" | "Apple";
type Provider = { name: ProviderName; make: () => GoogleAuthProvider | OAuthProvider };

const PROVIDERS: Provider[] = [
  { name: "Google", make: () => new GoogleAuthProvider() },
  {
    name: "Apple",
    make: () => {
      const p = new OAuthProvider("apple.com");
      p.addScope("email");
      p.addScope("name");
      return p;
    },
  },
];

/** Which provider a redirect sign-in left for, so its failure can be named on the way back. */
const PENDING_KEY = "insights:socialSignIn";

/**
 * Whether Firebase's sign-in helper (/__/auth/*) is on this site: the Worker proxies it from
 * <project>.firebaseapp.com, and the build names this host as NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN.
 * Then sign-in is a full-page redirect. Otherwise (local dev, or a build still on firebaseapp.com)
 * it is a popup, since a redirect through another site's helper fails wherever third-party storage
 * is blocked. The popup works, but Firebase polls `popup.closed` while Google's page is open in it,
 * and Google's Cross-Origin-Opener-Policy makes Chrome log "Cross-Origin-Opener-Policy policy would
 * block the window.closed call" for each poll. With no popup there is nothing to poll.
 */
const redirects = () => process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN === window.location.host;

/**
 * "Continue with Google / Apple" for both the log-in and sign-up pages: Firebase creates the
 * account the first time, so the same button does both. The session is our httpOnly cookie
 * (POST /auth/session), not anything kept in the page.
 */
export function SocialButtons() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const collected = useRef(false);

  function failed(e: unknown, provider: ProviderName | null) {
    const code = (e as { code?: string }).code ?? "";
    if (NOT_CONFIGURED.has(code)) {
      // Nothing the person can fix: say which option is unavailable, and leave the setting to
      // fix where whoever deploys this will look (Firebase console → Authentication).
      console.error(`[auth] ${provider ?? "Social"} sign-in is not set up for this Firebase project (${code}): Authentication → Sign-in method / Settings → Authorized domains, and NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN in the web build`);
      setError(
        provider
          ? `Sign in with ${provider} isn't available yet. Please use ${provider === "Google" ? "Apple" : "Google"} or your email address.`
          : "That sign-in option isn't available yet. Please use your email address.",
      );
    } else {
      setError(authErrorMessage(e));
    }
  }

  async function finish(cred: UserCredential) {
    await establishSession(cred.user);
    router.replace(afterSignIn());
  }

  // Back from a redirect sign-in: finish it here (this page is where it started).
  useEffect(() => {
    if (collected.current || !redirects()) return;
    collected.current = true;
    let provider: ProviderName | null = null;
    try {
      provider = sessionStorage.getItem(PENDING_KEY) as ProviderName | null;
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* storage blocked: errors just don't name the provider */
    }
    if (provider) setBusy(true);
    getRedirectResult(firebaseAuth())
      .then((cred) => (cred ? finish(cred) : undefined))
      .catch((e: unknown) => failed(e, provider))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function go(provider: Provider) {
    setBusy(true);
    setError(null);
    try {
      if (redirects()) {
        try {
          sessionStorage.setItem(PENDING_KEY, provider.name);
        } catch {
          /* see above */
        }
        // Leaves the page (it never resolves); the effect above finishes the sign-in on the way back.
        await signInWithRedirect(firebaseAuth(), provider.make());
      } else {
        await finish(await signInWithPopup(firebaseAuth(), provider.make()));
      }
    } catch (e) {
      failed(e, provider.name);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      {PROVIDERS.map((p) => (
        <button key={p.name} type="button" className="btn-secondary w-full" disabled={busy} onClick={() => go(p)}>
          Continue with {p.name}
        </button>
      ))}
    </div>
  );
}
