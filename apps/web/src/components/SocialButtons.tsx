"use client";
import { useEffect, useState } from "react";
import { authConfig, continueWith, type AuthConfig, type SocialProvider } from "@/lib/auth";
import { peekReturnTo } from "@/lib/returnTo";

function GoogleMark() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const PROVIDERS: Array<{ id: SocialProvider; name: string; Mark: () => React.JSX.Element }> = [
  { id: "google", name: "Google", Mark: GoogleMark },
];

/**
 * "Continue with Google" for both the sign-in and create-account pages: the user pool
 * creates the account the first time, so the same button does both. A full-page redirect through
 * Cognito to the provider and back to /auth/callback; the session is our httpOnly cookie.
 * `row`: the split auth pages' larger size (side by side if another provider is added later).
 * `large` draws them stacked at AuthCard's size.
 */
export function SocialButtons({ row = false, large = false }: { row?: boolean; large?: boolean }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [leaving, setLeaving] = useState<SocialProvider | null>(null);

  useEffect(() => {
    authConfig()
      .then(setConfig)
      // Unknown: leave the buttons on; the server says on its own page if one isn't set up.
      .catch(() => setConfig(null));
    // Back from the provider with the browser's Back button (a page restored from cache): usable again.
    const reset = () => setLeaving(null);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const unavailable = PROVIDERS.filter((p) => config && !config.providers[p.id]);

  return (
    <div className={row ? "grid grid-cols-[repeat(auto-fit,minmax(14.5rem,1fr))] gap-3" : large ? "space-y-3" : "space-y-2"}>
      {PROVIDERS.map(({ id, name, Mark }) => {
        const off = !!config && !config.providers[id];
        return (
          <button
            key={id}
            type="button"
            className={
              row
                ? "btn-secondary h-12 w-full rounded-xl text-[15px] whitespace-nowrap shadow-[var(--shadow)]"
                : large
                  ? "btn-secondary h-12 w-full gap-3 rounded-xl text-[15px] font-semibold"
                  : "btn-secondary w-full"
            }
            disabled={off || leaving !== null}
            aria-describedby={off ? "social-unavailable" : undefined}
            onClick={() => {
              setLeaving(id);
              continueWith(id, peekReturnTo());
            }}
          >
            <Mark />
            {leaving === id ? `Opening ${name}…` : `Continue with ${name}`}
          </button>
        );
      })}
      {unavailable.length > 0 && (
        <p id="social-unavailable" className={row ? "col-span-full text-center text-xs text-muted" : large ? "text-sm leading-relaxed text-muted" : "text-xs text-muted"}>
          Sign in with {unavailable.map((p) => p.name).join(" and ")} isn&apos;t available yet. Please use your email address.
        </p>
      )}
    </div>
  );
}
