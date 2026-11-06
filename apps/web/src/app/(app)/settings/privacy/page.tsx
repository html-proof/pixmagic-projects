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
  const th = "px-3 py-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6";
  const button = (i: Item) => (
    <button type="button" className={`${i.downloadedAt ? "btn-secondary" : "btn-primary"} h-9 text-[13px]`} disabled={busy !== null} onClick={() => void download(i)}>
      {busy === i.id ? "Preparing…" : "Download data"}
      <span className="sr-only"> for customer {i.customerId ?? "(not named)"}</span>
    </button>
  );
  // Done once downloaded for the customer; until then, the day Shopify asks for an answer by.
  const status = (i: Item) =>
    i.downloadedAt ? (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-good">
        <span aria-hidden className="size-1.5 rounded-full bg-good" />
        Downloaded {day(i.downloadedAt)}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-warn">
        <span aria-hidden className="size-1.5 rounded-full bg-warn" />
        Answer by {day(i.answerBy)}
      </span>
    );
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Privacy requests</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted sm:text-base">
          When a customer asks your store what data it holds about them, Shopify passes the request to every app you use. Download
          what bizinsights holds and send it to the customer. Shopify asks for an answer within 30 days.
        </p>
      </header>
      {failed && <Alert>{failed}</Alert>}
      {!data && error && <LoadError what="your privacy requests" error={error} onRetry={() => void reload()} busy={loading} />}

      {/* The design's "Requests from Shopify" table (Stitch screen 35): its header row on the soft tint, a row a request. */}
      <section aria-labelledby="requests-h" className="home-card animate-rise min-w-0 overflow-hidden">
        <h2 id="requests-h" className="home-h2 px-5 pt-5 pb-4 sm:px-6">
          Requests from Shopify
        </h2>
        {!data && !error && (
          <div className="px-5 pb-5 sm:px-6">
            <Skeleton lines={2} />
          </div>
        )}
        {data && data.items.length === 0 && (
          <div className="px-5 pb-5 sm:px-6">
            <EmptyState title="No requests" body="Customer data requests from Shopify appear here as they arrive. We also email owners and admins." />
          </div>
        )}
        {data && data.items.length > 0 && (
          <>
            {/* Up to where the table fits beside the settings menu: one row a request. */}
            <ul className="divide-y divide-home-line border-t border-home-line text-sm xl:hidden">
              {data.items.map((i) => (
                <li key={i.id} className="space-y-1.5 px-5 py-3 sm:px-6">
                  <p className="font-medium">
                    Customer {i.customerId ?? "(not named)"}
                    {i.store ? ` · ${i.store.name ?? i.store.shopDomain}` : ""}
                  </p>
                  <p className="text-xs text-muted">
                    Customer data request · received {day(i.receivedAt)}
                    {i.ordersRequested ? ` · ${i.ordersRequested} order${i.ordersRequested === 1 ? "" : "s"} named` : ""}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {status(i)}
                    {button(i)}
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto xl:block">
              <table className="w-full text-sm">
                <thead className="bg-home-soft text-left">
                  <tr>
                    <th scope="col" className={th}>Received</th>
                    <th scope="col" className={th}>Type</th>
                    <th scope="col" className={th}>Customer</th>
                    <th scope="col" className={th}>Status</th>
                    <th scope="col" className={`${th} text-right`}>
                      <span className="sr-only">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.id} className="border-b border-home-line last:border-0">
                      <td className="py-3 pr-3 pl-5 whitespace-nowrap sm:pl-6">{day(i.receivedAt)}</td>
                      <td className="px-3 py-3">
                        Customer data request
                        {i.ordersRequested ? <span className="block text-xs text-muted">{`${i.ordersRequested} order${i.ordersRequested === 1 ? "" : "s"} named`}</span> : null}
                      </td>
                      <td className="px-3 py-3">
                        <span className="font-medium">{i.customerId ?? "(not named)"}</span>
                        {i.store && <span className="block text-xs text-muted">{i.store.name ?? i.store.shopDomain}</span>}
                      </td>
                      <td className="px-3 py-3">{status(i)}</td>
                      <td className="py-3 pr-5 pl-3 text-right sm:pr-6">{button(i)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <p className="text-xs text-muted">
        Requests to erase a customer, or all of a store&apos;s data, are carried out by bizinsights itself when Shopify sends them; the Audit log records each one.
      </p>
    </div>
  );
}
