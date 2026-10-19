"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { afterSignIn, authErrorMessage, errorCode, finishOAuth, isSafeDestination, takeLinkReturn, withQuery } from "@/lib/auth";
import { takeReturnTo } from "@/lib/returnTo";
import { Alert } from "@/components/ui";
import { AuthCard } from "@/components/auth/AuthCard";
import { SocialButtons } from "@/components/SocialButtons";

/**
 * Where the user pool sends the browser back after Google (the app client's callback
 * URL). The code in the address is useless on its own: the API exchanges it with the client
 * secret and the PKCE verifier only it holds, and only for the browser that started the sign-in.
 *
 * A Google account linked from Settings comes back here too: the API answers where to go back
 * to (the page that asked, with ?linked=google or ?link_error=<code>), and this page goes there.
 */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<{ text: string; code: string | null } | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const q = new URLSearchParams(window.location.search);
    // Out of the address bar and history: the code is single-use, but nobody needs to see it.
    window.history.replaceState(null, "", "/auth/callback");
    const params = {
      state: q.get("state") ?? "",
      ...(q.get("code") ? { code: q.get("code")! } : {}),
      ...(q.get("error") ? { error: q.get("error")! } : {}),
      ...(q.get("error_description") ? { error_description: q.get("error_description")! } : {}),
    };
    // Set when this tab started linking Google from Settings: where to go back to if the API can't say.
    const linkingFrom = takeLinkReturn();
    finishOAuth(params)
      .then((r) => {
        // Only ever a page of this site, as the browser will read it (the API checks too).
        if ("linked" in r) return router.replace(isSafeDestination(r.redirect) ? r.redirect : withQuery(linkingFrom ?? "/settings/security", "linked", "google"));
        // The server's copy of where they were headed wins; the browser's is then spent too.
        const local = takeReturnTo();
        router.replace((isSafeDestination(r.redirect) ? r.redirect : null) ?? local ?? afterSignIn());
      })
      .catch((e: unknown) => {
        const back = e instanceof ApiError ? e.data.redirect : null;
        if (isSafeDestination(back)) return router.replace(back);
        if (linkingFrom) return router.replace(withQuery(linkingFrom, "link_error", errorCode(e) ?? "failed"));
        setError({ text: authErrorMessage(e), code: errorCode(e) });
      });
  }, [router]);

  if (!error) {
    return (
      <AuthCard title="Signing you in…" subtitle="Just a moment while we finish signing you in.">
        <div role="status" aria-live="polite" className="flex items-center gap-3 text-[15px] text-muted">
          <span aria-hidden className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
          Checking your sign-in…
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={error.code === "cancelled" ? "Sign-in cancelled" : "We couldn't sign you in"} subtitle="Nothing was changed. You can try again below.">
      <Alert>
        {error.text}
        {(error.code === "email_in_use" || error.code === "google_removed") && (
          <>
            {" "}
            <Link prefetch={false} href="/login" className="underline">
              Sign in with your password
            </Link>
          </>
        )}
        {error.code === "email_unverified_provider" && (
          <>
            {" "}
            <Link prefetch={false} href="/signup" className="underline">
              Create an account with your email
            </Link>
          </>
        )}
      </Alert>
      <SocialButtons large />
      <p className="text-center">
        <Link prefetch={false} href="/login" className="auth-link">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
