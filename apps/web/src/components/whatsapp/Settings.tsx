"use client";
import Link from "next/link";
import { useState } from "react";
import { Building2, Clock, Gauge, Info, Phone, PlugZap, UserRound } from "lucide-react";
import { PROVIDER_INFO, WA_CAMPAIGN_MAX } from "@app/shared/whatsapp";
import { ConfirmDialog } from "@/components/AppUi";
import { ChannelPanel, Fact, FactList } from "./MarketingKit";
import { Badge } from "@/components/dashboard/Primitives";
import { Card } from "@/components/PageKit";
import { Alert } from "@/components/ui";
import { api, fmtNum } from "@/lib/api";
import { SettingsForm } from "./SettingsForm";
import type { WaOverview } from "./types";
import { CONNECTION_TONE, fmtAgo, useWaAction, waHref, WhatsappIcon } from "./WaUi";

// Settings: the connection (check, reconnect, disconnect), pausing all automation, the store's
// WhatsApp settings, and Evolution API's notice (its licence asks for one). The connection is the
// Stitch design's WhatsApp card on its Channels screen (18): one status word, the one main button,
// its facts, and the quieter buttons at its foot.

export function Settings({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const conn = overview.connection && overview.connection.status !== "disconnected" ? overview.connection : null;
  const { busy, run } = useWaAction();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const paused = !!overview.settings.automationPausedAt;
  const down = !!conn && (conn.status === "logged_out" || conn.status === "failed");

  const act = (key: string, what: string, path: string, method: string, done: string, body: unknown = {}) =>
    run(key, what, async () => {
      await api(`${base}${path}`, { method, body });
      reload();
      return done;
    });

  const checkButton = conn && (
    <button type="button" className={down ? "home-btn" : "btn-primary h-9"} disabled={!!busy} onClick={() => void act("check", "check the connection", "/connection/check", "POST", "Checked with WhatsApp.")}>
      {busy === "check" ? "Checking…" : "Check again"}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ChannelPanel
          id="wa-connection"
          title="Connection"
          icon={<WhatsappIcon size={20} />}
          status={conn ? <Badge tone={CONNECTION_TONE[conn.status] ?? "neutral"}>{conn.statusLabel}</Badge> : <Badge tone="neutral">Not connected</Badge>}
          action={
            !conn ? (
              <Link href={waHref("setup")} className="btn-primary h-9">
                Connect WhatsApp
              </Link>
            ) : overview.can.connect && down ? (
              <Link href={waHref("setup")} className="btn-primary h-9">
                Link again
              </Link>
            ) : overview.can.connect ? (
              checkButton
            ) : undefined
          }
          footer={
            conn && overview.can.connect ? (
              <>
                {down && checkButton}
                {conn.provider === "qr" && (conn.status === "connected" || conn.status === "reconnecting") && (
                  <button type="button" className="home-btn" disabled={!!busy} onClick={() => void act("reconnect", "reconnect", "/connection/reconnect", "POST", "Reconnecting with the saved session.")}>
                    {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
                  </button>
                )}
                <button type="button" className="btn-danger ml-auto h-9 px-3 text-[13px]" disabled={!!busy} onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </button>
              </>
            ) : undefined
          }
        >
          {!conn ? (
            <p className="text-muted">{overview.connection?.status === "disconnected" ? `Disconnected ${fmtAgo(overview.connection.disconnectedAt)}. The message history stays.` : "WhatsApp isn't connected."}</p>
          ) : (
            <>
              {conn.reason && <Alert kind="info">{conn.reason}</Alert>}
              <FactList label="The connection">
                <Fact icon={<PlugZap />}>{PROVIDER_INFO[conn.provider].label}</Fact>
                <Fact icon={<Phone />}>
                  <span className="text-muted">Number: </span>
                  {conn.phone ?? "–"}
                </Fact>
                <Fact icon={<UserRound />}>
                  <span className="text-muted">WhatsApp profile name: </span>
                  {conn.profileName ?? "–"}
                </Fact>
                {conn.wabaId && (
                  <Fact icon={<Building2 />}>
                    <span className="text-muted">WhatsApp Business account: </span>
                    <span className="font-mono text-xs">{conn.wabaId}</span>
                  </Fact>
                )}
                <Fact icon={<Clock />}>
                  <span className="text-muted">Connected: </span>
                  {conn.connectedAt ? new Date(conn.connectedAt).toLocaleString() : "–"}
                </Fact>
              </FactList>
              {/* How it works and its limits, as the design's WhatsApp card adds them: the connection's own description and the limits this store's settings and connection set. */}
              <div className="space-y-2 border-t border-home-line pt-3">
                <div>
                  <p className="text-xs font-medium text-muted">How it works</p>
                  <p>{PROVIDER_INFO[conn.provider].short}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted">Limits</p>
                  <p className="flex items-start gap-2">
                    <Gauge aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                    <span>
                      {fmtNum(overview.limits.dailyLimit)} messages a day, {fmtNum(WA_CAMPAIGN_MAX[conn.provider])} per campaign
                    </span>
                  </p>
                </div>
              </div>
              {!overview.can.connect && <p className="text-muted">Only people who may manage integrations can reconnect or disconnect.</p>}
            </>
          )}
        </ChannelPanel>

        <Card id="wa-pause" title="Pause all automation" aside={<Badge tone={paused ? "warn" : "good"}>{paused ? `Paused ${fmtAgo(overview.settings.automationPausedAt)}` : "Running"}</Badge>}>
          <p className="text-sm text-muted">Automations start nothing while paused, and messages waiting from automations and campaigns are held (cancelled after 48 hours). Messages you send yourself still go.</p>
          {overview.can.manage && (
            <div className="mt-4">
              {paused ? (
                <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void act("resume", "resume automation", "/settings/pause", "POST", "Automation resumed.", { paused: false })}>
                  {busy === "resume" ? "Resuming…" : "Resume"}
                </button>
              ) : (
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => setConfirmPause(true)}>
                  Pause all automation
                </button>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card id="wa-settings" title="Messaging settings">
        <SettingsForm base={base} overview={overview} onSaved={reload} />
      </Card>

      <Card id="wa-about" title="About this service">
        <p className="flex gap-2 text-sm text-muted">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">{overview.notice}</span>
        </p>
        <p className="mt-2 text-sm text-muted">
          Instance keys and session data stay on bizinsights&apos; servers, encrypted; this page never receives them. Message texts are kept for {overview.settings.retentionDays} days.
        </p>
      </Card>

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
