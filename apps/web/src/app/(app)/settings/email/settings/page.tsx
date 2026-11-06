"use client";
import { useEffect, useState, type FormEvent } from "react";
import { SUPPRESSION_REASON_LABEL, type SuppressionReason } from "@app/shared/email";
import { Badge } from "@/components/dashboard/Primitives";
import { CopyValue, Note, relative } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Card } from "@/components/PageKit";
import { Field } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { PageHeader, Skeleton, useAction } from "@/components/AppUi";
import { api, useApi } from "@/lib/api";
import { fmtDateTime, useEmail } from "@/lib/email";

interface Settings {
  businessName: string | null;
  businessAddress: string | null;
  dailyLimit: number | null;
  effectiveDailyLimit: number;
  maxDailyLimit: number;
  perMinuteLimit: number;
  sendingPaused: boolean;
  suspended: { at: string; reason: string | null } | null;
}

/**
 * Settings → Email → Settings: business details, limits, pause, suppression list, event API keys,
 * audit. Each part is a white card with its heading, as the Stitch design's pages are made.
 */
export default function EmailSettingsPage() {
  const { manage, activity, audit } = useEmail();
  return (
    <div className="space-y-4">
      <PageHeader title="Email settings" sub="What applies to every email this workspace sends." />
      <SendingSettings />
      {activity && <Suppressions />}
      {manage && <EventKeys />}
      {audit && <EmailAudit />}
    </div>
  );
}

function SendingSettings() {
  const { base, manage } = useEmail();
  const { data, error, loading, reload, setData } = useApi<{ settings: Settings }>(`${base}/settings`);
  const [form, setForm] = useState({ businessName: "", businessAddress: "", dailyLimit: "" });
  const { busy, run } = useAction();
  const s = data?.settings;
  useEffect(() => {
    if (s) setForm({ businessName: s.businessName ?? "", businessAddress: s.businessAddress ?? "", dailyLimit: s.dailyLimit ? String(s.dailyLimit) : "" });
  }, [s]);
  if (error && !data) return <LoadError what="email settings" error={error} onRetry={reload} busy={loading} />;
  if (!s) return <Skeleton lines={4} />;
  const save = (body: Record<string, unknown>, msg: string) =>
    run("save", "save the settings", async () => {
      setData(await api<{ settings: Settings }>(`${base}/settings`, { method: "PATCH", body }));
      return msg;
    });
  return (
    <Card id="email-sending" title="Sending and limits">
      <div className="space-y-4">
        {s.suspended && <Alert>Sending is suspended by bizinsights{s.suspended.reason ? `: ${s.suspended.reason}` : ""}. Contact support.</Alert>}
        <div className="flex flex-wrap items-center gap-3 rounded bg-home-soft px-4 py-3">
          <Badge tone={s.sendingPaused ? "warn" : "good"}>{s.sendingPaused ? "Paused" : "Sending"}</Badge>
          <span className="min-w-0 flex-1 text-sm text-muted">{s.sendingPaused ? "Automations still queue emails; nothing goes out until you resume (queued emails wait up to 3 days)." : "Automations send as events happen."}</span>
          {manage && (
            <button className="home-btn border border-home-line bg-surface" disabled={!!busy} onClick={() => save({ sendingPaused: !s.sendingPaused }, s.sendingPaused ? "Sending resumed." : "Sending paused.")}>
              {s.sendingPaused ? "Resume sending" : "Pause all sending"}
            </button>
          )}
        </div>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void save({ businessName: form.businessName || null, businessAddress: form.businessAddress || null, dailyLimit: form.dailyLimit ? Number(form.dailyLimit) : null }, "Saved.");
          }}
        >
          <Field label="Business name" htmlFor="es-name" hint="{{business.name}} in templates. The workspace name when empty.">
            <input id="es-name" className="input" maxLength={120} disabled={!manage} value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
          </Field>
          <Field label="Postal address" htmlFor="es-addr" hint="Printed at the bottom of marketing emails, as anti-spam laws require.">
            <input id="es-addr" className="input" maxLength={300} disabled={!manage} value={form.businessAddress} onChange={(e) => setForm({ ...form, businessAddress: e.target.value })} />
          </Field>
          <Field label="Daily limit for the workspace" htmlFor="es-limit" hint={`Now ${s.effectiveDailyLimit.toLocaleString()} a day (at most ${s.maxDailyLimit.toLocaleString()}); also at most ${s.perMinuteLimit} a minute. Each account has its own limit too.`}>
            <input id="es-limit" className="input" type="number" min={1} max={s.maxDailyLimit} disabled={!manage} value={form.dailyLimit} placeholder={String(s.effectiveDailyLimit)} onChange={(e) => setForm({ ...form, dailyLimit: e.target.value })} />
          </Field>
          {manage && (
            <div className="flex items-end">
              <button className="btn-primary" disabled={!!busy}>
                Save
              </button>
            </div>
          )}
        </form>
      </div>
    </Card>
  );
}

function Suppressions() {
  const { base, manage } = useEmail();
  const { data, error, loading, reload } = useApi<{ suppressions: Array<{ id: string; email: string; reason: string; scope: string; source: string; createdAt: string }>; nextCursor: string | null }>(`${base}/suppressions?limit=50`);
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<"all" | "marketing">("all");
  const { busy, run } = useAction();
  if (error && !data) return <LoadError what="the suppression list" error={error} onRetry={reload} busy={loading} />;
  return (
    <Card id="email-suppressions" title="Suppression list">
      <div className="space-y-3">
        <p className="text-sm text-muted">Addresses bizinsights won&apos;t email. Unsubscribes stop marketing email; bounces and entries you add stop everything. Only a masked form of each address is kept.</p>
        {manage && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("add", "add the address", async () => {
                const r = await api<{ created: boolean }>(`${base}/suppressions`, { method: "POST", body: { email, scope, reason: "manual" } });
                setEmail("");
                await reload();
                return r.created ? "Added." : "Already on the list.";
              });
            }}
          >
            <input aria-label="Address to suppress" className="input flex-1" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" />
            <select aria-label="Scope" className="input w-auto" value={scope} onChange={(e) => setScope(e.target.value as "all" | "marketing")}>
              <option value="all">No emails at all</option>
              <option value="marketing">No marketing emails</option>
            </select>
            <button className="btn-secondary" disabled={!!busy}>
              Add
            </button>
          </form>
        )}
        {!data ? (
          <Skeleton lines={2} />
        ) : data.suppressions.length === 0 ? (
          <p className="text-sm text-muted">Nobody is suppressed.</p>
        ) : (
          <ul className="divide-y divide-home-line text-sm">
            {data.suppressions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="min-w-0 flex-1">{s.email}</span>
                <Badge tone="neutral">{SUPPRESSION_REASON_LABEL[s.reason as SuppressionReason] ?? s.reason}</Badge>
                <span className="text-xs text-muted">{s.scope === "marketing" ? "Marketing only" : "All email"} · {relative(s.createdAt)}</span>
                {manage && (
                  <button
                    className="text-xs text-danger"
                    disabled={!!busy}
                    onClick={() =>
                      run(`rm-${s.id}`, "remove the address", async () => {
                        await api(`${base}/suppressions/${s.id}`, { method: "DELETE" });
                        await reload();
                        return "Removed. Only do this with the person's agreement.";
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function EventKeys() {
  const { base } = useEmail();
  const { data, error, loading, reload } = useApi<{ keys: Array<{ id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> }>(`${base}/ingest-keys`);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, run } = useAction();
  if (error && !data) return <LoadError what="event API keys" error={error} onRetry={reload} busy={loading} />;
  const endpoint = typeof window === "undefined" ? "/api/v1/events" : `${window.location.origin}/api/v1/events`;
  return (
    <Card id="email-event-keys" title="Event API (custom events)">
      <div className="space-y-3">
        <p className="text-sm text-muted">Let your own systems (booking, invoicing, support…) send events that automations can react to. A key can only post events to this workspace; it can&apos;t read anything.</p>
        {secret && (
          <Alert kind="success">
            Copy this key now. It won&apos;t be shown again:
            <span className="mt-1 block">
              <CopyValue value={secret} label="event API key" />
            </span>
          </Alert>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run("create", "create the key", async () => {
              const r = await api<{ secret: string }>(`${base}/ingest-keys`, { method: "POST", body: { name } });
              setSecret(r.secret);
              setName("");
              await reload();
            });
          }}
        >
          <input aria-label="Key name" className="input flex-1" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Booking system" />
          <button className="btn-secondary" disabled={!!busy}>
            Create key
          </button>
        </form>
        <ul className="divide-y divide-home-line text-sm">
          {data?.keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="flex-1">
                {k.name} <code className="text-muted">{k.prefix}…</code>
              </span>
              <span className="text-xs text-muted">{k.revokedAt ? "Revoked" : k.lastUsedAt ? `Used ${relative(k.lastUsedAt)}` : "Never used"}</span>
              {!k.revokedAt && (
                <button
                  className="text-xs text-danger"
                  disabled={!!busy}
                  onClick={() =>
                    run(`rv-${k.id}`, "revoke the key", async () => {
                      await api(`${base}/ingest-keys/${k.id}`, { method: "DELETE" });
                      await reload();
                      return "Key revoked.";
                    })
                  }
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">How to send an event</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-home-soft p-2">{`curl -X POST ${endpoint} \\
    -H "Authorization: Bearer ek_live_…" \\
    -H "Content-Type: application/json" \\
    -d '{"id":"booking-1042","type":"appointment.booked",
         "customer":{"email":"pat@example.com","first_name":"Pat"},
         "data":{"starts_at":"2026-11-03 10:00","service":"Haircut"}}'`}</pre>
          <Note>
            The id makes retries safe: the same id is accepted once. Types are two to four lowercase dotted parts; order.* and checkout.* are reserved for Shopify. Fields under data are available as {"{{data.field}}"} in templates and conditions.
          </Note>
        </details>
      </div>
    </Card>
  );
}

function EmailAudit() {
  const { base } = useEmail();
  const { data, error, loading, reload } = useApi<{ items: Array<{ id: string; action: string; actor: string | null; createdAt: string; metadata: Record<string, unknown> | null }> }>(`${base}/audit-logs`);
  if (error && !data) return <LoadError what="the email audit log" error={error} onRetry={reload} busy={loading} />;
  return (
    <Card id="email-audit" title="Recent changes">
      {!data ? (
        <Skeleton lines={3} />
      ) : data.items.length === 0 ? (
        <p className="text-sm text-muted">No email changes recorded yet.</p>
      ) : (
        <ul className="divide-y divide-home-line text-sm">
          {data.items.slice(0, 20).map((a) => (
            <li key={a.id} className="flex flex-wrap gap-2 py-2">
              <span className="w-40 shrink-0 text-xs text-muted">{fmtDateTime(a.createdAt)}</span>
              <span className="flex-1">{a.action.replace(/^email\./, "").replace(/[._]/g, " ")}</span>
              <span className="text-xs text-muted">{a.actor ?? "bizinsights"}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
