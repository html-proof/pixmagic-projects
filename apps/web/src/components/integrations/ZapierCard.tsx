"use client";
import { useState } from "react";
import { Check, ExternalLink, Workflow, X } from "lucide-react";
import { ZAPIER_EVENT_INFO, type ZapierEvent } from "@app/shared/zapier";
import { ConfirmDialog, useAction } from "@/components/AppUi";
import { fmtRelative } from "@/components/dashboard/format";
import type { StoreSummary } from "@/components/AppContext";
import { api, friendlyError, useApi } from "@/lib/api";
import type { StateTone } from "@/lib/adConnections";
import { IntegrationRow, RowPill } from "./IntegrationRow";

// ---------------------------------------------------------------------------
// Settings → Integrations' Zapier card (docs/zapier.md): the store connected to the merchant's own
// Zapier account through bizinsights' Zapier app. Where it stands comes only from the API's answer
// (GET .../zapier): not set up by the platform yet, not connected, or each connection with who made
// it, its triggers and its recent deliveries. Connect opens the Zapier app's invite link in Zapier;
// Disconnect stops the connection's tokens and deletes its triggers here; Retry (owners and admins)
// sends a failed delivery again.
// ---------------------------------------------------------------------------

type Delivery = {
  id: string;
  event: string;
  eventLabel: string;
  status: string;
  label: string;
  tone: StateTone;
  reason: string | null;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  retryable: boolean;
};
type Trigger = { id: string; event: string; label: string; inputs: Record<string, unknown>; createdAt: string; lastDeliveredAt: string | null; mixedCurrencies: string[] | null };
type Connection = { id: string; authorizedBy: { email: string; name: string | null } | null; createdAt: string; lastUsedAt: string | null; triggers: Trigger[] };
type Setup = { ZAPIER_CLIENT_ID: boolean; ZAPIER_CLIENT_SECRET: boolean; ZAPIER_REDIRECT_URI: boolean; ZAPIER_INVITE_URL: boolean };
export type ZapierOverview = { configured: boolean; inviteUrl: string | null; setup: Setup | null; connections: Connection[]; deliveries: Delivery[] };

const SETUP_STEPS: Array<[keyof Setup, string]> = [
  ["ZAPIER_CLIENT_ID", "Client ID (ZAPIER_CLIENT_ID in the app's settings)"],
  ["ZAPIER_CLIENT_SECRET", "Client secret (ZAPIER_CLIENT_SECRET in Secrets Manager)"],
  ["ZAPIER_REDIRECT_URI", "Redirect URI from the Zapier app (ZAPIER_REDIRECT_URI)"],
  ["ZAPIER_INVITE_URL", "Invite link to the Zapier app, for Connect (ZAPIER_INVITE_URL)"],
];

const PLATFORM: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", any: "Meta and Google Ads" };

/** A trigger's own fields, in words: "Meta Ads spend over 500 a month". */
function triggerDetail(t: Trigger): string | null {
  const i = t.inputs;
  if (t.event === "ad_spend_threshold") return `${PLATFORM[String(i.platform ?? "any")] ?? "Ad"} spend reaching ${i.amount} a ${i.period}`;
  if (t.event === "adsense_earnings_threshold") {
    return i.direction === "below" ? `Estimated earnings ending a ${i.period} below ${i.amount}` : `Estimated earnings reaching ${i.amount} a ${i.period}`;
  }
  return null;
}

const when = (iso: string | null) => (iso ? (fmtRelative(iso) ?? new Date(iso).toLocaleString()) : null);

function SetupChecklist({ setup }: { setup: Setup }) {
  return (
    <div className="rounded-xl border border-border bg-bg/60 p-3" data-testid="zapier-setup">
      <p className="font-medium">Platform setup (owners and admins see this)</p>
      <ul className="mt-2 space-y-1">
        {SETUP_STEPS.map(([key, label]) => (
          <li key={key} className="flex items-start gap-2">
            {setup[key] ? <Check size={16} className="mt-0.5 shrink-0 text-good" aria-hidden /> : <X size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />}
            <span>
              {label}
              <span className="sr-only">{setup[key] ? ": set" : ": not set"}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Each step is in docs/zapier.md, under Owner setup. Nothing here shows a value, only whether it is set.</p>
    </div>
  );
}

export function ZapierCard({ workspaceId, store, manage, full }: { workspaceId: string; store: StoreSummary | null; manage: boolean; full: boolean }) {
  const base = store ? `/workspaces/${workspaceId}/stores/${store.id}/zapier` : null;
  const z = useApi<ZapierOverview>(base);
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const o = z.data;

  const state: { key: string; label: string; tone: StateTone; busy?: boolean } = !store
    ? { key: "not_connected", label: "Not connected", tone: "neutral" }
    : !o
      ? z.error
        ? { key: "unknown", label: "Status unavailable", tone: "neutral" }
        : { key: "checking", label: "Checking…", tone: "neutral", busy: true }
      : !o.configured
        ? { key: "unavailable", label: "Not set up yet", tone: "neutral" }
        : o.connections.length
          ? o.deliveries.some((d) => d.status === "failed")
            ? { key: "action_required", label: "Some events failed", tone: "warn" }
            : { key: "connected", label: "Connected", tone: "good" }
          : { key: "not_connected", label: "Not connected", tone: "neutral" };

  const connect =
    manage && o?.configured && o.inviteUrl ? (
      <a className="btn-primary h-11 px-5 font-semibold" href={o.inviteUrl} target="_blank" rel="noopener noreferrer" data-testid="int-zapier-connect" aria-label="Connect Zapier (opens Zapier)">
        <ExternalLink size={17} strokeWidth={2.2} aria-hidden />
        {o.connections.length ? "Add a Zap" : "Connect"}
      </a>
    ) : null;

  async function disconnect(c: Connection) {
    if (!base) return;
    const ok = await run(`disconnect-${c.id}`, "disconnect Zapier", async () => {
      await api(`${base}/connections/${c.id}`, { method: "DELETE" });
      return "Zapier disconnected. Its Zaps no longer receive this store's events.";
    });
    setConfirm(null);
    if (ok) await z.reload();
  }

  async function retry(d: Delivery) {
    if (!base) return;
    const ok = await run(`retry-${d.id}`, "send the event again", async () => {
      await api(`${base}/deliveries/${d.id}/retry`, { method: "POST" });
      return `${d.eventLabel}: sending it to Zapier again.`;
    });
    if (ok) await z.reload();
  }

  return (
    <IntegrationRow
      testid="int-zapier"
      state={state.key}
      logo={<Workflow size={38} strokeWidth={2} className="text-[#ff4f00]" />}
      name="Zapier"
      sub="Send this store's alerts and advertising results to the apps you use, with Zaps in your own Zapier account."
      pill={<RowPill label={state.label} tone={state.tone} busy={state.busy} state={state.key} />}
      action={connect}
      brings={Object.values(ZAPIER_EVENT_INFO).map((e) => e.label)}
    >
      {!store ? (
        <p className="text-muted">Connect your Shopify store first: Zapier gets this store&apos;s events.</p>
      ) : !o ? (
        z.error ? <p className="text-muted">We couldn&apos;t check Zapier just now. {friendlyError(z.error)}</p> : null
      ) : !o.configured ? (
        <>
          <p className="text-muted">{manage ? "Zapier isn't set up for bizinsights yet. Once it is, you'll connect it from here." : "Zapier isn't available yet."}</p>
          {full && o.setup && <SetupChecklist setup={o.setup} />}
        </>
      ) : (
        <>
          {!o.connections.length && (
            <p className="text-muted">
              {manage
                ? o.inviteUrl
                  ? "Connect opens bizinsights' app in Zapier. Sign in to Zapier, choose bizinsights in a Zap and allow it on bizinsights' page: there are no keys or addresses to copy."
                  : "Zapier's invite link isn't set yet, so there is nothing to open. An owner or admin can finish it."
                : "Nothing is connected. Connecting Zapier needs the Manage integrations permission."}
            </p>
          )}
          {o.connections.map((c) => (
            <div key={c.id} className="rounded-xl border border-border p-3" data-testid="zapier-connection">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p>
                  <span className="text-muted">Connected by</span> {c.authorizedBy?.name || c.authorizedBy?.email || "a former member"}
                  <span className="text-muted">
                    {" · "}
                    {when(c.createdAt)}
                    {" · last used "}
                    {when(c.lastUsedAt) ?? "not yet"}
                  </span>
                </p>
                {manage && (
                  <button type="button" className="btn-secondary h-9 px-3 text-sm" onClick={() => setConfirm(c)} disabled={busy !== null}>
                    Disconnect
                  </button>
                )}
              </div>
              {c.triggers.length ? (
                <ul className="mt-2 space-y-1" aria-label="Active triggers">
                  {c.triggers.map((t) => (
                    <li key={t.id}>
                      <span className="font-medium">{ZAPIER_EVENT_INFO[t.event as ZapierEvent]?.label ?? t.label}</span>
                      {triggerDetail(t) && <span className="text-muted"> · {triggerDetail(t)}</span>}
                      <span className="text-muted"> · {t.lastDeliveredAt ? `last sent ${when(t.lastDeliveredAt)}` : "nothing sent yet"}</span>
                      {t.mixedCurrencies && (
                        <span className="block text-warn">
                          Not checked: this store&apos;s ad accounts report in {t.mixedCurrencies.join(" and ")}, and bizinsights never adds up two currencies.
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted">No Zap is using it yet.</p>
              )}
            </div>
          ))}
          {o.deliveries.length > 0 && (
            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer font-medium">Recent events sent to Zapier</summary>
              <ul className="mt-2 space-y-1.5" data-testid="zapier-deliveries">
                {o.deliveries.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium">{d.eventLabel}</span>
                    <span className="text-muted">{when(d.createdAt)}</span>
                    <span className={d.tone === "good" ? "text-good" : d.tone === "danger" ? "text-danger" : d.tone === "warn" ? "text-warn" : "text-muted"}>
                      {d.label}
                      {d.reason ? `: ${d.reason}` : ""}
                      {d.status === "retrying" && d.nextAttemptAt ? ` (next try ${new Date(d.nextAttemptAt).toLocaleTimeString()})` : ""}
                    </span>
                    {full && d.retryable && (
                      <button
                        type="button"
                        className="btn-secondary h-8 px-3 text-sm"
                        onClick={() => void retry(d)}
                        disabled={busy !== null}
                        aria-label={`Retry: send ${d.eventLabel} to Zapier again`}
                        data-testid="zapier-retry"
                      >
                        {busy === `retry-${d.id}` ? "Sending…" : "Retry"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {full && o.setup && !o.setup.ZAPIER_INVITE_URL && <SetupChecklist setup={o.setup} />}
        </>
      )}
      <ConfirmDialog
        open={!!confirm}
        title="Disconnect Zapier?"
        confirmLabel="Disconnect"
        danger
        busy={!!confirm && busy === `disconnect-${confirm.id}`}
        onConfirm={() => confirm && void disconnect(confirm)}
        onCancel={() => setConfirm(null)}
      >
        <p>Zaps using this connection stop receiving this store&apos;s events, and Zapier will ask for the connection again the next time it reaches bizinsights.</p>
        <p>Nothing is deleted in Zapier itself: turn the Zaps off there if you no longer need them.</p>
      </ConfirmDialog>
    </IntegrationRow>
  );
}
