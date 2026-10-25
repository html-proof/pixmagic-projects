"use client";
import Link from "next/link";
import { useState } from "react";
import { PROVIDER_INFO } from "@app/shared/whatsapp";
import { ConfirmDialog } from "@/components/AppUi";
import { Badge, Panel } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { SettingsForm } from "./SettingsForm";
import type { WaOverview } from "./types";
import { CONNECTION_TONE, fmtAgo, useWaAction, waHref } from "./WaUi";

// Settings: the connection (check, reconnect, disconnect), pausing all automation, the store's
// WhatsApp settings, and Evolution API's notice (its licence asks for one).

export function Settings({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const conn = overview.connection && overview.connection.status !== "disconnected" ? overview.connection : null;
  const { busy, run } = useWaAction();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const paused = !!overview.settings.automationPausedAt;

  const act = (key: string, what: string, path: string, method: string, done: string, body: unknown = {}) =>
    run(key, what, async () => {
      await api(`${base}${path}`, { method, body });
      reload();
      return done;
    });

  return (
    <div className="space-y-4">
      <Panel id="wa-connection" title="Connection">
        {!conn ? (
          <div className="space-y-2 text-sm">
            <p className="text-muted">{overview.connection?.status === "disconnected" ? `Disconnected ${fmtAgo(overview.connection.disconnectedAt)}. The message history stays.` : "WhatsApp isn't connected."}</p>
            <Link href={waHref("setup")} className="btn-primary inline-flex">
              Connect WhatsApp
            </Link>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={CONNECTION_TONE[conn.status] ?? "neutral"}>{conn.statusLabel}</Badge>
              <span>{PROVIDER_INFO[conn.provider].label}</span>
            </p>
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <div>
                <dt className="text-muted">Number</dt>
                <dd>{conn.phone ?? "–"}</dd>
              </div>
              <div>
                <dt className="text-muted">WhatsApp profile name</dt>
                <dd>{conn.profileName ?? "–"}</dd>
              </div>
              {conn.wabaId && (
                <div>
                  <dt className="text-muted">WhatsApp Business account</dt>
                  <dd className="font-mono text-xs">{conn.wabaId}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted">Connected</dt>
                <dd>{conn.connectedAt ? new Date(conn.connectedAt).toLocaleString() : "–"}</dd>
              </div>
            </dl>
            {conn.reason && <Alert kind="info">{conn.reason}</Alert>}
            {overview.can.connect ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void act("check", "check the connection", "/connection/check", "POST", "Checked with WhatsApp.")}>
                  {busy === "check" ? "Checking…" : "Check again"}
                </button>
                {conn.provider === "qr" && (conn.status === "connected" || conn.status === "reconnecting") && (
                  <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void act("reconnect", "reconnect", "/connection/reconnect", "POST", "Reconnecting with the saved session.")}>
                    {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
                  </button>
                )}
                {(conn.status === "logged_out" || conn.status === "failed") && (
                  <Link href={waHref("setup")} className="btn-primary">
                    Link again
                  </Link>
                )}
                <button type="button" className="btn-danger" disabled={!!busy} onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </button>
              </div>
            ) : (
              <p className="text-muted">Only people who may manage integrations can reconnect or disconnect.</p>
            )}
          </div>
        )}
      </Panel>

      <Panel id="wa-pause" title="Pause all automation" help="Automations start nothing while paused, and messages waiting from automations and campaigns are held (cancelled after 48 hours). Messages you send yourself still go.">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={paused ? "warn" : "good"}>{paused ? `Paused ${fmtAgo(overview.settings.automationPausedAt)}` : "Running"}</Badge>
          {overview.can.manage &&
            (paused ? (
              <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void act("resume", "resume automation", "/settings/pause", "POST", "Automation resumed.", { paused: false })}>
                {busy === "resume" ? "Resuming…" : "Resume"}
              </button>
            ) : (
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => setConfirmPause(true)}>
                Pause all automation
              </button>
            ))}
        </div>
      </Panel>

      <Panel id="wa-settings" title="Messaging settings">
        <SettingsForm base={base} overview={overview} onSaved={reload} />
      </Panel>

      <Panel id="wa-about" title="About this service">
        <p className="text-sm text-muted">{overview.notice}</p>
        <p className="mt-2 text-sm text-muted">
          Instance keys and session data stay on bizinsights&apos; servers, encrypted; this page never receives them. Message texts are kept for {overview.settings.retentionDays} days.
        </p>
      </Panel>

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect WhatsApp?"
        confirmLabel="Disconnect"
        danger
        busy={busy === "disconnect"}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          void act("disconnect", "disconnect WhatsApp", "/connection", "DELETE", "WhatsApp disconnected.").then(() => setConfirmDisconnect(false))
        }
      >
        <p>{conn?.provider === "qr" ? "Your phone's link to bizinsights is removed (it disappears from Linked devices)." : "bizinsights stops sending through your Cloud API number."} Messages waiting to send are cancelled, automations are paused and running campaigns stop.</p>
        <p>The message history stays. You can connect again at any time.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmPause}
        title="Pause all automation?"
        confirmLabel="Pause"
        busy={busy === "pause"}
        onCancel={() => setConfirmPause(false)}
        onConfirm={() => void act("pause", "pause automation", "/settings/pause", "POST", "All automation paused.", { paused: true }).then(() => setConfirmPause(false))}
      >
        <p>No automation starts a message, and messages waiting from automations and campaigns are held until you resume (or cancelled after 48 hours).</p>
      </ConfirmDialog>
    </div>
  );
}
