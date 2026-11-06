"use client";
import { useEffect, useRef, useState } from "react";
import { canManage, useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { friendlyError, api } from "@/lib/api";

interface Item { id: string; action: string; actor: string | null; targetType: string | null; targetId: string | null; createdAt: string }

const DESCRIBE: Record<string, string> = {
  "workspace.created": "created the workspace",
  "workspace.renamed": "renamed the workspace",
  "store.connected": "connected a store",
  "customers.contacts_viewed": "viewed customer contact details",
  "store.disconnected": "disconnected a store",
  "store.uninstalled": "Shopify reported the app was uninstalled",
  "store.scopes_updated": "Shopify permissions changed",
  "store.scopes_requested": "asked the merchant for extra Shopify permissions",
  "store.scopes_revoked": "gave optional Shopify permissions back",
  "store.resync": "started a re-sync",
  "member.invited": "invited a member",
  "member.joined": "joined the workspace",
  "member.role_changed": "changed a member's role",
  "member.removed": "removed a member",
  "apikey.created": "created an API key",
  "apikey.revoked": "revoked an API key",
  "billing.subscribe_started": "started a plan change",
  "billing.plan_changed": "Shopify approved a plan change",
  "billing.plan_change_ended": "a plan change was not approved in Shopify",
  "billing.subscription_ended": "the Shopify subscription ended; the workspace is on the free plan",
  "billing.cancelled": "switched to the Free plan (the Shopify subscription was cancelled)",
  "gdpr.customer_data_request": "received a customer data request from Shopify (Settings, Privacy requests)",
  "gdpr.data_request_downloaded": "downloaded a customer's data for a privacy request",
  "gdpr.shop_redact_skipped": "kept a store's data: it was installed again before Shopify's deletion request arrived",
  "workspace.claimed": "added a store installed from Shopify to their account",
  "gdpr.customer_redacted": "processed a customer deletion request",
  "gdpr.shop_redacted": "deleted all data for a store at Shopify's request",
};

export default function AuditPage() {
  const { workspace } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const allowed = canManage(workspace.role);
  /** Bumped on every workspace switch: a response for the previous workspace is dropped. */
  const generation = useRef(0);

  async function load(c: string | null) {
    const gen = generation.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ items: Item[]; nextCursor: string | null }>(`/workspaces/${workspace.id}/audit-logs${c ? `?cursor=${encodeURIComponent(c)}` : ""}`);
      if (gen !== generation.current) return;
      setItems((prev) => (c ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch (e) {
      if (gen === generation.current) setError(friendlyError(e));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    generation.current++;
    setItems([]);
    setCursor(null);
    if (allowed) void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, allowed]);

  if (!allowed) return <Alert kind="info">Only owners and admins can view the audit log.</Alert>;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Audit log</h1>
        <p className="mt-1 text-sm text-muted sm:text-base">Who changed what and when, newest first.</p>
      </header>
      {error && <Alert>{error}</Alert>}
      {/* The design's audit log (Stitch screen 35): a dot, who did what, and when on the right. */}
      <section aria-label="Changes" className="home-card animate-rise min-w-0 px-5 py-2 sm:px-6">
        <ul className="divide-y divide-home-line text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-3 py-3">
              <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-home-tag" />
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span className="min-w-0 break-words">
                  <strong className="font-medium">{i.actor ?? "System"}</strong> {DESCRIBE[i.action] ?? i.action}
                </span>
                <span className="text-xs whitespace-nowrap text-muted tabular-nums">{new Date(i.createdAt).toLocaleString()}</span>
              </span>
            </li>
          ))}
          {items.length === 0 && !loading && !error && <li className="py-3 text-muted">Nothing recorded yet.</li>}
          {loading && <li className="py-3 text-muted">Loading…</li>}
        </ul>
      </section>
      {cursor && !loading && <button className="btn-secondary" onClick={() => load(cursor)}>Load more</button>}
    </div>
  );
}
