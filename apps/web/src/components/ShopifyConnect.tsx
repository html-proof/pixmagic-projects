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
 */
export function ShopifyConnect({ workspaceId }: { workspaceId: string }) {
  const [shop, setShop] = useState("");
  const [busy, setBusy] = useState<null | "address" | "picker">(null);
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

  async function go(kind: "address" | "picker", path: string, body: Record<string, string>) {
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

  function byAddress(e: FormEvent) {
    e.preventDefault();
    void go("address", `/workspaces/${workspaceId}/shopify/install`, { shop });
  }

  return (
    <div className="card space-y-3" data-testid="shopify-connect">
      <div>
        <h2 className="flex items-center gap-2 font-medium">
          <ShopifyIcon /> Connect a Shopify store
        </h2>
        <p className="text-sm text-muted">
          You&apos;ll approve read-only access on Shopify, then come straight back here. Insights never sees your Shopify password.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      <form onSubmit={byAddress} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[14rem] flex-1">
          <label className="label" htmlFor="connect-shop">Store address</label>
          <input
            id="connect-shop"
            className="input"
            placeholder="your-store.myshopify.com"
            autoComplete="off"
            required
            value={shop}
            onChange={(e) => setShop(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={busy !== null}>{busy === "address" ? "Opening Shopify…" : "Connect with Shopify"}</button>
      </form>
      {pickerOk && (
        <button
          type="button"
          className="text-sm text-muted underline"
          disabled={busy !== null}
          onClick={() => void go("picker", `/workspaces/${workspaceId}/shopify/start`, {})}
        >
          {busy === "picker" ? "Opening Shopify…" : "Don't know the address? Pick your store on Shopify"}
        </button>
      )}
    </div>
  );
}
