"use client";
import { GoogleAuthProvider, OAuthProvider, signInWithPopup } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useState } from "react";
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

type Provider = { name: "Google" | "Apple"; make: () => GoogleAuthProvider | OAuthProvider };

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

/**
 * "Continue with Google / Apple" for both the log-in and sign-up pages: Firebase creates the
 * account the first time, so the same button does both. The session is our httpOnly cookie
 * (POST /auth/session), not anything kept in the page.
 */
export function SocialButtons() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(provider: Provider) {
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithPopup(firebaseAuth(), provider.make());
      await establishSession(cred.user);
      router.replace(afterSignIn());
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (NOT_CONFIGURED.has(code)) {
        // Nothing the person can fix: say which option is unavailable, and leave the setting to
        // fix where whoever deploys this will look (Firebase console → Authentication).
        console.error(`[auth] ${provider.name} sign-in is not set up for this Firebase project (${code}): Authentication → Sign-in method / Settings → Authorized domains, and NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN in the web build`);
        setError(`Sign in with ${provider.name} isn't available yet. Please use ${provider.name === "Google" ? "Apple" : "Google"} or your email address.`);
      } else {
        setError(authErrorMessage(e));
      }
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
