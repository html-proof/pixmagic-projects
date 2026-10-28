"use client";
import Link from "next/link";
import { providerLabel, WA_AUTOMATION_STATE_LABEL, WA_SETUP_STEPS, WA_SETUP_STEP_INFO } from "@app/shared/whatsapp";
import { Badge, Empty, Panel, Stat, type Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import type { WaOverview, WaStats } from "./types";
import { CONNECTION_TONE, fmtAgo, fmtShare, MessageStatus, SOURCE_LABEL, waHref, useWaAction } from "./WaUi";

// The page's first tab: the connection as the provider last reported it, the setup, automation as a
// whole, the counts (from the message records), what is waiting or held, recent failures and the
// latest messages.

const STATE_TONE: Record<string, Tone> = { not_connected: "neutral", paused: "warn", setup: "warn", needs_attention: "danger", idle: "neutral", active: "good" };

export function Overview({ base, overview: o, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const conn = o.connection && o.connection.status !== "disconnected" ? o.connection : null;
  const { busy, run } = useWaAction();
  const check = () =>
    run("check", "check the connection", async () => {
      await api(`${base}/connection/check`, { method: "POST", body: {} });
      reload();
      return "Checked with WhatsApp.";
    });

  return (
    <div className="space-y-4">
      {o.connection?.reasonCode === "qr_linking_retired" && (
        <Alert kind="info">
          <span className="font-medium">QR-code linking was retired.</span> {o.connection.reason}{" "}
          <Link href={waHref("setup")} className="underline">
            Connect WhatsApp Business
          </Link>
        </Alert>
      )}
      {o.retired && (
        <Alert kind="info">
          This store&apos;s earlier WhatsApp Business connection{o.retired.displayPhoneNumber ? ` (${o.retired.displayPhoneNumber})` : ""} was retired when WhatsApp Automation moved to its new service. Connect again below; nothing from the earlier one sends.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Connection"
          tone={conn ? (CONNECTION_TONE[conn.status] ?? "neutral") : "neutral"}
          value={conn ? conn.statusLabel : "Not connected"}
          note={conn ? `${conn.phone ?? "Number not reported yet"} · WhatsApp Business Platform` : "Connect on the Setup tab."}
        />
        <Stat label="Automation" tone={STATE_TONE[o.automation.state] ?? "neutral"} value={WA_AUTOMATION_STATE_LABEL[o.automation.state]} note={`${o.automation.active} on${o.automation.testMode ? `, ${o.automation.testMode} in test mode` : ""} of ${o.automation.total}`} />
        <Stat label="Sent today" value={`${o.limits.sentToday} / ${o.limits.dailyLimit}`} note="Business-started messages against the daily limit." />
        <Stat label="Waiting to send" value={o.queue.waiting} note={o.queue.held.length ? `Held: ${o.queue.held.map((h) => `${h.label ?? h.reason} (${h.count})`).join(", ")}` : "Nothing held."} />
      </div>

      {o.setup.current && (
        <Panel id="wa-setup" title="Finish setting up" help="Four short steps. Nothing is sent to customers until they're done and you switch an automation on.">
          <ol className="grid gap-2 sm:grid-cols-4">
            {WA_SETUP_STEPS.map((s, i) => (
              <li key={s} className={`rounded-lg border p-3 text-sm ${o.setup.done[s] ? "border-good/40" : s === o.setup.current ? "border-accent" : "border-border"}`}>
                <span className="font-medium">
                  {i + 1}. {WA_SETUP_STEP_INFO[s].label}
                </span>
                <span className="block text-xs text-muted">{o.setup.done[s] ? "Done" : WA_SETUP_STEP_INFO[s].help}</span>
              </li>
            ))}
          </ol>
          <Link href={waHref("setup")} className="btn-primary mt-3 inline-flex">
            Continue setup
          </Link>
        </Panel>
      )}

      {conn && (
        <Panel
          id="wa-health"
          title="Connection health"
          help="As Meta last reported it."
          aside={
            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void check()} disabled={busy === "check"}>
              {busy === "check" ? "Checking…" : "Check again"}
            </button>
          }
        >
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row k="How it connects" v={providerLabel(conn.provider)} />
            <Row k="Status" v={<Badge tone={CONNECTION_TONE[conn.status] ?? "neutral"}>{conn.statusLabel}</Badge>} />
            <Row k="Number" v={conn.phone ?? "–"} />
            <Row k="WhatsApp profile name" v={conn.profileName ?? "–"} />
            <Row k="Connected" v={conn.connectedAt ? fmtAgo(conn.connectedAt) : "–"} />
            <Row k="Last update from WhatsApp" v={fmtAgo(o.health.lastEventAt ?? o.health.lastWebhookAt)} />
            <Row k="Last checked" v={fmtAgo(o.health.lastCheckedAt)} />
            {conn.downSince && <Row k="Down since" v={fmtAgo(conn.downSince)} />}
          </dl>
          {conn.reason && <p className="mt-3 text-sm text-warn">{conn.reason}</p>}
          {(conn.status === "logged_out" || conn.status === "failed") && (
            <Link href={waHref("setup")} className="btn-primary mt-3 inline-flex">
              Connect WhatsApp Business again
            </Link>
          )}
        </Panel>
      )}

      {o.automation.blocked.length > 0 && (
        <Alert kind="error">
          <p className="font-medium">Switched-on automations that can&apos;t send:</p>
          <ul className="mt-1 list-disc pl-5">
            {o.automation.blocked.map((b) => (
              <li key={b.id}>
                {b.name}: {b.problems.join(" ")}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <StatsPanel id="wa-week" title="Last 7 days" s={o.stats.week} />
        <StatsPanel id="wa-month" title="Last 30 days" s={o.stats.month} />
      </div>

      {o.queue.failures.length > 0 && (
        <Panel id="wa-failures" title="Failures in the last 7 days" help="Why messages didn't go, most common first.">
          <ul className="space-y-1 text-sm">
            {o.queue.failures.map((f) => (
              <li key={`${f.reason}-${f.errorCode}`} className="flex justify-between gap-3">
                <span>{f.label ?? f.reason ?? "Failed"}</span>
                <span className="text-muted">{f.count}</span>
              </li>
            ))}
          </ul>
          <Link href={waHref("messages", { status: "failed" })} className="mt-2 inline-block text-sm text-accent underline">
            See failed messages
          </Link>
        </Panel>
      )}

      <Panel id="wa-recent" title="Recent messages" aside={<Link href={waHref("messages")} className="text-accent underline">All messages</Link>}>
        {o.recent.length === 0 ? (
          <Empty>No messages yet.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {o.recent.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{m.direction === "in" ? `From ${m.phone ?? "a customer"}` : `To ${m.phone ?? "–"}`}</span>
                  <span className="ml-2 text-xs text-muted">{SOURCE_LABEL[m.source] ?? m.source}</span>
                  {m.preview && <span className="block truncate text-xs text-muted">{m.preview}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <MessageStatus m={m} />
                  <span className="text-xs text-muted">{fmtAgo(m.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

/** Counts from the message records: what WhatsApp took, delivered, read; what failed or didn't go. */
function StatsPanel({ id, title, s }: { id: string; title: string; s: WaStats }) {
  const total = s.sent + s.delivered + s.read + s.failed + s.notSent + s.waiting;
  return (
    <Panel id={id} title={title} help="Counted from each message's own record. Delivered and read come only from WhatsApp's reports.">
      {total + s.received === 0 ? (
        <Empty>No messages in this period.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Sent (no report yet)" value={s.sent} />
          <Stat label="Delivered" value={s.delivered} />
          <Stat label="Read" value={s.read} />
          <Stat label="Failed" value={s.failed} tone={s.failed ? "danger" : undefined} />
          <Stat label="Not sent" value={s.notSent} note="Skipped or cancelled, each with its reason." />
          <Stat label="From customers" value={s.received} />
          <Stat label="Delivery rate" value={fmtShare(s.deliveryRate)} note="Delivered or read, of what reached WhatsApp." />
          <Stat label="Read rate" value={fmtShare(s.readRate)} />
          <Stat label="Waiting" value={s.waiting} />
        </div>
      )}
    </Panel>
  );
}
