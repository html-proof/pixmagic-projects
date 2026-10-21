"use client";
import { useEffect, useRef, useState } from "react";
import { canManage, useApp } from "@/components/AppContext";
import { ErrorState } from "@/components/ErrorState";
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
  "gdpr.customer_data_request": "received a customer data request (no personal data is stored)",
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

  if (!allowed) return <ErrorState kind="forbidden" />;
  return (
    <section className="card space-y-3">
      <h1 className="text-lg font-semibold">Audit log</h1>
      {error && <Alert>{error}</Alert>}
      <ul className="divide-y divide-border text-sm">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap gap-2 py-2">
            <span className="w-44 text-muted">{new Date(i.createdAt).toLocaleString()}</span>
            <span className="flex-1">
              <strong>{i.actor ?? "System"}</strong> {DESCRIBE[i.action] ?? i.action}
            </span>
          </li>
        ))}
        {items.length === 0 && !loading && !error && <li className="py-2 text-muted">Nothing recorded yet.</li>}
        {loading && <li className="py-2 text-muted">Loading…</li>}
      </ul>
      {cursor && !loading && <button className="btn-secondary" onClick={() => load(cursor)}>Load more</button>}
    </section>
  );
}
