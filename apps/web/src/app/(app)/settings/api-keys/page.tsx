"use client";
import { useState, type FormEvent } from "react";
import { canManage, useApp } from "@/components/AppContext";
import { Alert, EmptyState } from "@/components/ui";
import { actionError, api, ApiError, useApi } from "@/lib/api";

interface Key { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }

export default function ApiKeysPage() {
  const { workspace } = useApp();
  const allowed = canManage(workspace.role);
  const { data, reload, error } = useApi<{ keys: Key[] }>(allowed ? `/workspaces/${workspace.id}/api-keys` : null);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  if (!allowed) return <Alert kind="info">Only owners and admins can manage API keys.</Alert>;

  async function create(e: FormEvent) {
    e.preventDefault();
    setActionMsg(null);
    try {
      const r = await api<{ secret: string }>(`/workspaces/${workspace.id}/api-keys`, { method: "POST", body: { name } });
      setSecret(r.secret);
      setName("");
    } catch (err) {
      return setActionMsg(actionError(err, "create the key"));
    }
    await reload();
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Tools using it will stop working.")) return;
    setActionMsg(null);
    try {
      await api(`/workspaces/${workspace.id}/api-keys/${id}`, { method: "DELETE" });
    } catch (err) {
      // A 404 is a revoke that already happened (a retry after an answer lost in an outage): the
      // reload below shows the key as revoked, which is what the merchant wanted.
      if (!(err instanceof ApiError && err.status === 404)) return setActionMsg(actionError(err, "revoke the key"));
    }
    await reload();
  }

  return (
    <section className="card space-y-4">
      <h1 className="text-lg font-semibold">API keys</h1>
      <p className="text-sm text-muted">
        Read-only keys for pulling your metrics into other tools. Send as <code>Authorization: Bearer sk_live_…</code> to
        <code> /api/workspaces/{workspace.id}/…</code>.
      </p>
      {error && <Alert>{error.message}</Alert>}
      {actionMsg && <Alert>{actionMsg}</Alert>}
      {secret && (
        <Alert kind="success">
          Copy this key now. You won&apos;t be able to see it again: <code className="break-all font-mono">{secret}</code>
        </Alert>
      )}
      <form onSubmit={create} className="flex gap-2">
        <input aria-label="Key name" className="input" placeholder="e.g. Looker Studio" required value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary">Create key</button>
      </form>
      {data?.keys.length === 0 && <EmptyState title="No keys yet" body="Create one when you need to connect another tool." />}
      <ul className="divide-y divide-border text-sm">
        {data?.keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="flex-1">{k.name} <code className="text-muted">{k.prefix}…</code></span>
            <span className="text-xs text-muted">{k.revokedAt ? "Revoked" : k.lastUsedAt ? `Used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "Never used"}</span>
            {!k.revokedAt && (
              <button className="text-danger" aria-label={`Revoke key ${k.name}`} onClick={() => revoke(k.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
