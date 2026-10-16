"use client";
import { useState } from "react";
import { canManage, useApp } from "@/components/AppContext";
import { LoadError } from "@/components/LoadError";
import { Skeleton } from "@/components/AppUi";
import { Alert, EmptyState } from "@/components/ui";
import { api, friendlyError, useApi } from "@/lib/api";

interface Item {
  id: string;
  store: { id: string; shopDomain: string; name: string | null } | null;
  customerId: string | null;
  ordersRequested: number;
  receivedAt: string;
  answerBy: string;
  downloadedAt: string | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Customer data requests Shopify passed on (customers/data_request): a customer asked a store
 * what it holds about them, and Shopify asks every app to give its part to the store owner. Each
 * download is the customer's data as bizinsights holds it right now, as a JSON file.
 */
export default function PrivacyRequestsPage() {
  const { workspace } = useApp();
  const allowed = canManage(workspace.role);
  const { data, error, loading, reload } = useApi<{ items: Item[] }>(allowed ? `/workspaces/${workspace.id}/privacy-requests` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function download(item: Item) {
    setBusy(item.id);
    setFailed(null);
    try {
      const exported = await api<unknown>(`/workspaces/${workspace.id}/privacy-requests/${item.id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `customer-data-${item.customerId ?? item.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      void reload();
    } catch (e) {
      setFailed(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  if (!allowed) return <Alert kind="info">Only owners and admins can see customer data requests.</Alert>;
  return (
    <section className="card space-y-3">
      <h1 className="text-lg font-semibold">Privacy requests</h1>
      <p className="text-sm text-muted">
        When a customer asks your store what data it holds about them, Shopify passes the request to every app you use. Download
        what bizinsights holds and send it to the customer. Shopify asks for an answer within 30 days.
      </p>
      {failed && <Alert>{failed}</Alert>}
      {!data && error && <LoadError what="your privacy requests" error={error} onRetry={() => void reload()} busy={loading} />}
      {!data && !error && <Skeleton lines={2} />}
      {data && data.items.length === 0 && (
        <EmptyState title="No requests" body="Customer data requests from Shopify appear here as they arrive. We also email owners and admins." />
      )}
      {data && data.items.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {data.items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  Customer {i.customerId ?? "(not named)"}
                  {i.store ? ` · ${i.store.name ?? i.store.shopDomain}` : ""}
                </p>
                <p className="text-muted">
                  Received {day(i.receivedAt)}
                  {i.ordersRequested ? ` · ${i.ordersRequested} order${i.ordersRequested === 1 ? "" : "s"} named` : ""}
                  {i.downloadedAt ? ` · downloaded ${day(i.downloadedAt)}` : ` · answer by ${day(i.answerBy)}`}
                </p>
              </div>
              <button type="button" className={i.downloadedAt ? "btn-secondary" : "btn-primary"} disabled={busy !== null} onClick={() => void download(i)}>
                {busy === i.id ? "Preparing…" : "Download data"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
