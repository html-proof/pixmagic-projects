"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api, ApiError, friendlyError, isTransient, keepRetrying } from "@/lib/api";
import { leaveTo, signOut } from "@/lib/auth";
import { setReturnTo } from "@/lib/returnTo";
import { storeKey, WORKSPACE_KEY, writeLocal } from "@/lib/storage";
import { OAUTH_ERRORS } from "@/lib/shopifyErrors";
import { Alert } from "@/components/ui";
import { BrandLogo } from "@/components/Brand";
import { ShopifyIcon } from "@/components/ShopifyIcon";

/** The store this browser installed from Shopify (GET /api/shopify/claim). */
type Offer = { shop: string; name: string | null; status: string; claimable: boolean };
type Who = { user: { email: string; emailVerified: boolean } | null };
type Claimed = { workspace: { id: string; name: string; role: string }; storeId: string };

const HERE = "/claim";

/**
 * Where a merchant lands after installing bizinsights from Shopify. Shopify has already approved
 * the app and the first import is running (apps/api/src/routes/shopify.ts, finishInstall); the
 * store sits in a workspace of its own that nobody can see yet. This page adds it to the
 * merchant's bizinsights account: sign up or sign in (both come back here), then one click.
 */
function Claim() {
  const router = useRouter();
  const params = useSearchParams();
  const errorCode = params.get("error");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [who, setWho] = useState<Who | null>(null);
  /** No claim in this browser (expired, used, or opened from somewhere other than Shopify). */
  const [gone, setGone] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(errorCode ? (OAUTH_ERRORS[errorCode] ?? "Shopify didn't complete the connection.") : null);

  const load = useCallback(async () => {
    try {
      const [o, w] = await Promise.all([
        api<Offer>("/shopify/claim").catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }),
        api<Who>("/auth/whoami"),
      ]);
      setOffer(o);
      setGone(!o);
      setWho(w);
      setLoadError(null);
      return true;
    } catch (e) {
      setLoadError(e);
      return !isTransient(e);
    }
  }, []);

  useEffect(() => void load(), [load]);
  const failing = loadError !== null;
  useEffect(() => (failing ? keepRetrying(load) : undefined), [failing, load]);

  /** Sign up / sign in / confirm the email, then come back here to finish. */
  const via = (path: string) => () => {
    setReturnTo(HERE);
    router.push(path);
  };

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Claimed>("/shopify/claim", { method: "POST" });
      // Open the dashboard on this workspace and store, by way of the first-import progress page.
      writeLocal(WORKSPACE_KEY, r.workspace.id);
      writeLocal(storeKey(r.workspace.id), r.storeId);
      router.replace(`/onboarding?step=sync&store=${encodeURIComponent(r.storeId)}&ws=${encodeURIComponent(r.workspace.id)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : friendlyError(e));
      setBusy(false);
      if (e instanceof ApiError && (e.code === "already_claimed" || e.code === "claim_expired")) void load();
    }
  }

  async function switchAccount() {
    setReturnTo(HERE);
    leaveTo(await signOut(), router);
  }

  const storeLabel = offer?.name ?? offer?.shop ?? "";
  const user = who?.user ?? null;

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <p>
        <BrandLogo size={24} className="text-[15px] text-text" />
      </p>
      <div className="card mt-6 space-y-4">
        {error && <Alert>{error}</Alert>}
        {!offer && !gone && !failing && <p className="text-sm text-muted">Loading…</p>}
        {failing && !offer && (
          <>
            <Alert kind="info">{friendlyError(loadError)}</Alert>
            <button type="button" className="btn-secondary" onClick={() => void load()}>Try again</button>
          </>
        )}

        {gone && (
          <>
            <h1 className="text-xl font-semibold">Open bizinsights from Shopify</h1>
            <p className="text-sm text-muted">
              This page adds a store you installed bizinsights on to your account. Open bizinsights again from your Shopify admin
              (Apps, then bizinsights) and you&apos;ll come straight back here.
            </p>
            <p className="text-sm">
              Already set up? <Link className="underline" href="/login">Sign in</Link> to see your dashboard.
            </p>
          </>
        )}

        {offer && !offer.claimable && (
          <>
            <h1 className="text-xl font-semibold">{storeLabel} already has a bizinsights account</h1>
            <p className="text-sm text-muted">
              Sign in to the account it belongs to, or ask that account&apos;s owner to invite you from Settings, then Members.
            </p>
            {user ? (
              <div className="flex flex-wrap gap-2">
                <Link className="btn-primary" href="/dashboard">Open my dashboard</Link>
                <button type="button" className="btn-secondary" onClick={() => void switchAccount()}>Sign in with another account</button>
              </div>
            ) : (
              <button type="button" className="btn-primary" onClick={via("/login")}>Sign in</button>
            )}
          </>
        )}

        {offer?.claimable && (
          <>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ShopifyIcon /> {storeLabel} is connected
            </h1>
            <p className="text-sm text-muted">
              Shopify approved read-only access and we&apos;re importing your orders, products and inventory now.
              {user ? "" : " Create your bizinsights login to see your dashboard, or sign in if you already have one."}
            </p>
            {!user && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" onClick={via("/signup")}>Create account</button>
                <button type="button" className="btn-secondary" onClick={via("/login")}>Sign in</button>
              </div>
            )}
            {user && !user.emailVerified && (
              <>
                <p className="text-sm">Confirm your email address ({user.email}) first. It protects the store data you&apos;re adding.</p>
                <button type="button" className="btn-primary" onClick={via("/verify-email")}>Confirm email</button>
              </>
            )}
            {user?.emailVerified && (
              <>
                <p className="text-sm">
                  Add it to the account <strong>{user.email}</strong>?
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void claim()}>
                    {busy ? "Adding…" : "Add store and open dashboard"}
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => void switchAccount()}>
                    Use another account
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function ClaimPage() {
  return (
    <Suspense>
      <Claim />
    </Suspense>
  );
}
