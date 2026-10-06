"use client";
import { useState } from "react";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { LoadError } from "@/components/LoadError";
import { actionError, api, useApi } from "@/lib/api";

interface Billing {
  subscription: { plan: string; status: string };
  plans: Array<{ id: string; name: string; priceUsd: number; features: string[] }>;
}

export default function BillingPage() {
  const { workspace, store, storesStatus } = useApp();
  const { data, error: loadError, loading, reload } = useApi<Billing>(`/workspaces/${workspace.id}/billing`);
  const [error, setError] = useState<string | null>(null);
  const isOwner = workspace.role === "owner";

  async function choose(plan: string) {
    // No store yet is only true once the list has loaded; before that we just don't know which one.
    if (!store && storesStatus !== "ready") return setError("Your stores haven't loaded yet. Please try again in a moment.");
    if (!store) return setError("Connect a store first. Plans are billed through your Shopify invoice.");
    try {
      const { confirmationUrl } = await api<{ confirmationUrl: string }>(`/workspaces/${workspace.id}/billing/subscribe`, { method: "POST", body: { plan, storeId: store.id } });
      window.location.assign(confirmationUrl);
    } catch (e) {
      setError(actionError(e, "start the plan change"));
    }
  }

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold">Billing</h1>
      {!data && loadError ? (
        <LoadError what="your plan" error={loadError} onRetry={() => void reload()} busy={loading} />
      ) : (
        <p className="text-sm text-muted">
          Current plan: <strong className="text-text">{data?.subscription.plan ?? "…"}</strong> ({data?.subscription.status}). Charges appear on the Shopify bill of the selected store.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-3">
        {data?.plans.map((p) => (
          <div key={p.id} className={`card space-y-2 ${data.subscription.plan === p.id ? "border-accent" : ""}`}>
            <p className="font-semibold">{p.name}</p>
            <p className="text-2xl font-semibold">${p.priceUsd}<span className="text-sm font-normal text-muted">/month</span></p>
            <ul className="space-y-1 text-sm text-muted">{p.features.map((f) => <li key={f}>• {f}</li>)}</ul>
            {p.id !== "free" && data.subscription.plan !== p.id && isOwner && (
              <button className="btn-primary w-full" onClick={() => choose(p.id)}>Choose {p.name}</button>
            )}
          </div>
        ))}
      </div>
      {!isOwner && <p className="text-xs text-muted">Only workspace owners can change the plan.</p>}
    </section>
  );
}
