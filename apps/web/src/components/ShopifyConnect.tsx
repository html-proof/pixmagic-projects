"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { OAUTH_ERRORS } from "@/lib/shopifyErrors";
import { Alert } from "@/components/ui";
import { ShopifyIcon } from "@/components/ShopifyIcon";

/**
 * Connect a Shopify store from Settings, through Shopify's own OAuth screen. The API builds the
 * authorize URL and holds the single-use state (bound to this browser by an httpOnly cookie); the
 * access token is exchanged and stored encrypted on the server, and Shopify's answer brings the
 * merchant back to Settings (`from: "settings"`) with the store's card showing its status.
 *
 * "Continue with Shopify" lets Shopify ask which store, as onboarding does. Merchants are never
 * asked to type their store's address (App Store requirement 2.3.1): the field below appears only
 * when the API answers `shop_required`, i.e. Shopify's store picker can't reach the app that
 * serves this merchant. It takes a store address or a store ID ("your-store", the name in
 * admin.shopify.com/store/your-store).
 */
export function ShopifyConnect({ workspaceId }: { workspaceId: string }) {
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState<null | "entry" | "picker">(null);
  const [error, setError] = useState<string | null>(null);
  /** Shopify's store picker only works while our app may be installed on any store. */
  const [pickerOk, setPickerOk] = useState(true);

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
      setError(OAUTH_ERRORS[code] ?? (e as Error).message);
      setBusy(null);
    }
  }

  function byEntry(e: FormEvent) {
    e.preventDefault();
    void go("entry", `/workspaces/${workspaceId}/shopify/install`, { shop: entry });
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
      {pickerOk ? (
        <button
          type="button"
          className="btn-primary w-full sm:w-auto"
          disabled={busy !== null}
          onClick={() => void go("picker", `/workspaces/${workspaceId}/shopify/start`, {})}
        >
          <ShopifyIcon />
          {busy === "picker" ? "Opening Shopify…" : "Continue with Shopify"}
        </button>
      ) : (
        <form onSubmit={byEntry} className="space-y-3">
          <label className="label" htmlFor="connect-shop">Store address or store ID</label>
          <input
            id="connect-shop"
            className="input"
            placeholder="your-store or your-store.myshopify.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
          />
          <p className="text-sm text-muted">
            Your store ID is the name after /store/ in your Shopify admin&apos;s address, e.g. admin.shopify.com/store/your-store.
          </p>
          <button className="btn-secondary" disabled={busy !== null}>{busy === "entry" ? "Opening Shopify…" : "Connect this store"}</button>
        </form>
      )}
    </div>
  );
}
