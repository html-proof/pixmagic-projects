"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, actionError } from "@/lib/api";
import { OAUTH_ERRORS } from "@/lib/shopifyErrors";
import { Alert } from "@/components/ui";
import { ShopifyIcon } from "@/components/ShopifyIcon";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Connect a Shopify store from Settings, through Shopify's own OAuth screen. The API builds the
 * authorize URL and holds the single-use state (bound to this browser by an httpOnly cookie); the
 * access token is exchanged and stored encrypted on the server, and Shopify's answer brings the
 * merchant back to Settings (`from: "settings"`) with the store's card showing its status.
 *
 * "Continue with Shopify" lets Shopify ask which store, as onboarding does. "Enter store address
 * instead" opens a field that takes a store address, a store ID ("your-store", the name in
 * admin.shopify.com/store/your-store) or a Shopify login email.
 * Shopify can't look a store up by email for an app, so an email takes the same route as the
 * button: Shopify asks the merchant to log in with it and pick the store.
 */
export function ShopifyConnect({ workspaceId }: { workspaceId: string }) {
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState<null | "entry" | "picker">(null);
  const [error, setError] = useState<string | null>(null);
  /** Shopify's store picker only works while our app may be installed on any store. */
  const [pickerOk, setPickerOk] = useState(true);
  /** The field is the second way in, opened from a link under "Continue with Shopify". */
  const [manual, setManual] = useState(false);
  const email = EMAIL_RE.test(entry.trim()) ? entry.trim() : null;

  // Back from Shopify with the browser's Back button: the page is restored as it was, so re-enable it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  async function go(kind: "entry" | "picker", path: string, body: Record<string, string>) {
    setBusy(kind);
    setError(null);
    try {
      const { url } = await api<{ url: string }>(path, { method: "POST", body: { ...body, from: "settings" } });
      window.location.assign(url);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "shop_required") setPickerOk(false);
      setError(OAUTH_ERRORS[code] ?? actionError(e, "connect your store"));
      setBusy(null);
    }
  }

  const pick = (kind: "entry" | "picker") => void go(kind, `/workspaces/${workspaceId}/shopify/start`, {});

  function byEntry(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email) return void go("entry", `/workspaces/${workspaceId}/shopify/install`, { shop: entry });
    if (pickerOk) return pick("entry");
    setError("This store has to be connected by its address. Enter your store address or store ID instead of an email.");
  }

  return (
    <div className="card space-y-4" data-testid="shopify-connect">
      <div>
        <h2 className="flex items-center gap-2 font-medium">
          <ShopifyIcon /> Connect a Shopify store
        </h2>
        <p className="text-sm text-muted">
          You&apos;ll sign in to Shopify, pick your store and approve read-only access. We only ask for what the dashboard uses, and you can disconnect any time.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      {pickerOk && (
        <button type="button" className="btn-primary w-full sm:w-auto" disabled={busy !== null} onClick={() => pick("picker")}>
          <ShopifyIcon />
          {busy === "picker" ? "Opening Shopify…" : "Continue with Shopify"}
        </button>
      )}
      {pickerOk && !manual ? (
        <button type="button" className="block text-sm text-muted underline" onClick={() => setManual(true)}>
          Enter store address instead
        </button>
      ) : (
        <form onSubmit={byEntry} className={pickerOk ? "space-y-3 border-t border-border pt-4" : "space-y-3"}>
          <label className="label" htmlFor="connect-shop">
            {pickerOk ? "Store address, store ID or Shopify email" : "Store address or store ID"}
          </label>
          <input
            id="connect-shop"
            className="input"
            placeholder={pickerOk ? "your-store or you@example.com" : "your-store or your-store.myshopify.com"}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={pickerOk}
            required
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
          />
          <p className="text-sm text-muted">
            {email && pickerOk
              ? `Shopify will ask you to log in with ${email}, then pick the store to connect.`
              : "Your store ID is the name after /store/ in your Shopify admin's address, e.g. admin.shopify.com/store/your-store."}
          </p>
          <button className="btn-secondary" disabled={busy !== null}>{busy === "entry" ? "Opening Shopify…" : "Connect this store"}</button>
        </form>
      )}
    </div>
  );
}
