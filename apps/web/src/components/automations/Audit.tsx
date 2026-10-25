"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { api } from "@/lib/api";
import { CHANNEL_NAME, ChannelIcon, fmtWhen, useHub } from "./HubUi";
import type { AuditEntry } from "./types";

// ---------------------------------------------------------------------------
// Audit log: every change to the hub's channels (connections, automations, messages, approvals),
// who made it and when, newest first. Owners and admins only; never a customer's details.
// ---------------------------------------------------------------------------

export function AutomationAudit() {
  const { path, auditAllowed } = useHub();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const url = path("/audit");

  const load = useCallback(
    async (after: string | null) => {
      const request = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const r = await api<{ entries: AuditEntry[]; nextBefore: string | null }>(after ? `${url}${url.includes("?") ? "&" : "?"}before=${encodeURIComponent(after)}` : url);
        if (request !== latest.current) return;
        setEntries((prev) => (after && prev ? [...prev, ...r.entries] : r.entries));
        setBefore(r.nextBefore);
      } catch (e) {
        if (request === latest.current) setError(e);
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [url],
  );
  useEffect(() => {
    if (auditAllowed) void load(null);
  }, [load, auditAllowed]);

  if (!auditAllowed) return <EmptyState title="Owners and admins only" body="The audit log shows who changed what in Automations. Ask an owner or admin if you need it." />;
  if (error && !entries) return <LoadError what="the audit log" error={error} onRetry={() => void load(null)} busy={loading} />;
  if (!entries) return <Skeleton lines={6} />;
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" sub="Every change to your channels and automations: connections, messages, switching on and off, approvals and deletions." />
      {entries.length === 0 ? (
        <EmptyState title="Nothing yet" body="Changes to your automations and channels will be listed here." />
      ) : (
        <ul className="card divide-y divide-border p-0" aria-label="Changes">
          {entries.map((e) => (
            <li key={`${e.channel}:${e.id}`} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
              <ChannelIcon channel={e.channel} className="mt-0.5 h-4 w-4 text-muted" />
              <div className="min-w-0 flex-1">
                <p>
                  <span className="font-medium">{e.actor}</span> · {e.label} <span className="text-muted">({CHANNEL_NAME[e.channel]})</span>
                </p>
                {e.detail && (
                  <p className="text-xs text-muted">
                    {Object.entries(e.detail)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(" · ")}
                  </p>
                )}
              </div>
              <time className="text-xs text-muted" dateTime={e.at}>
                {fmtWhen(e.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {before && (
        <div className="text-center">
          <button type="button" className="btn-secondary" disabled={loading} onClick={() => void load(before)}>
            {loading ? "Loading…" : "Load older changes"}
          </button>
        </div>
      )}
    </div>
  );
}
