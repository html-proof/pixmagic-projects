"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { PROVIDER_INFO, WA_AUTOMATION_STATE_LABEL, WA_SETUP_STEPS, WA_SETUP_STEP_INFO } from "@app/shared/whatsapp";
import { StepNumber, TableCard } from "./MarketingKit";
import { Badge, Dot, Empty, type Tone } from "@/components/dashboard/Primitives";
import { Card, FigureTile } from "@/components/PageKit";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import type { WaOverview, WaStats } from "./types";
import { CONNECTION_TONE, fmtAgo, fmtShare, MessageStatus, SOURCE_LABEL, waHref, useWaAction } from "./WaUi";

// The page's first tab: the connection as the provider last reported it, the setup, automation as a
// whole, the counts (from the message records), what is waiting or held, recent failures and the
// latest messages. Laid out as the Stitch design's Marketing screens draw a channel (14 and 17): a
// red row for what stops messages, the few numbers as tiles, then the panels on white cards.

const STATE_TONE: Record<string, Tone> = { not_connected: "neutral", paused: "warn", setup: "warn", needs_attention: "danger", idle: "neutral", active: "good" };

export function Overview({ base, overview: o, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const conn = o.connection && o.connection.status !== "disconnected" ? o.connection : null;
  const down = !!conn && (conn.status === "logged_out" || conn.status === "failed");
  const { busy, run } = useWaAction();
  const check = () =>
    run("check", "check the connection", async () => {
      await api(`${base}/connection/check`, { method: "POST", body: {} });
      reload();
      return "Checked with WhatsApp.";
    });

  return (
    <div className="space-y-4">
      {/* What stops messages first, with its one fix, as the design's screen 14 opens. */}
      {down && (
        <div role="alert" className="alert alert-error flex-wrap items-center justify-between" data-testid="wa-down">
          <p className="min-w-0 flex-1 font-medium">{conn.reason ?? conn.statusLabel}</p>
          <Link href={waHref("setup")} className="btn-primary h-9 shrink-0">
            Link the phone again
          </Link>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FigureTile
          testId="wa-figure-connection"
          title="Connection"
          icon={<Dot tone={conn ? (CONNECTION_TONE[conn.status] ?? "neutral") : "neutral"} />}
          value={conn ? conn.statusLabel : "Not connected"}
          sub={conn ? `${conn.phone ?? "Number not reported yet"} · ${conn.provider === "qr" ? "linked phone" : "Cloud API"}` : "Connect on the Setup tab."}
        />
        <FigureTile
          testId="wa-figure-automation"
          title="Automation"
          icon={<Dot tone={STATE_TONE[o.automation.state] ?? "neutral"} />}
          value={WA_AUTOMATION_STATE_LABEL[o.automation.state]}
          sub={`${o.automation.active} on${o.automation.testMode ? `, ${o.automation.testMode} in test mode` : ""} of ${o.automation.total}`}
        />
        <FigureTile testId="wa-figure-today" title="Sent today" value={`${o.limits.sentToday} / ${o.limits.dailyLimit}`} sub="Business-started messages against the daily limit." />
        <FigureTile
          testId="wa-figure-waiting"
          title="Waiting to send"
          value={o.queue.waiting}
          sub={o.queue.held.length ? `Held: ${o.queue.held.map((h) => `${h.label ?? h.reason} (${h.count})`).join(", ")}` : "Nothing held."}
        />
      </div>

      {o.setup.current && (
        <Card id="wa-setup" title="Finish setting up">
          <p className="-mt-2 mb-4 text-sm text-muted">Four short steps. Nothing is sent to customers until they&apos;re done and you switch an automation on.</p>
          <ol className="grid gap-2 sm:grid-cols-4">
            {WA_SETUP_STEPS.map((s, i) => (
              <li key={s} className={`flex gap-3 rounded p-3 text-sm ${s === o.setup.current ? "bg-accent/10" : "bg-home-soft"}`}>
                <StepNumber n={o.setup.done[s] ? <Check size={14} strokeWidth={2.5} /> : i + 1} done={o.setup.done[s]} />
                <span className="min-w-0">
                  <span className="font-medium">
                    <span className="sr-only">{i + 1}. </span>
                    {WA_SETUP_STEP_INFO[s].label}
                  </span>
                  <span className="block text-xs text-muted">{o.setup.done[s] ? "Done" : WA_SETUP_STEP_INFO[s].help}</span>
                </span>
              </li>
            ))}
          </ol>
          <div>
            <Link href={waHref("setup")} className="btn-primary mt-4 inline-flex">
              Continue setup
            </Link>
          </div>
        </Card>
      )}

      {conn && (
        <Card
          id="wa-health"
          title="Connection health"
          aside={
            <button type="button" className="home-btn h-8" onClick={() => void check()} disabled={busy === "check"}>
              {busy === "check" ? "Checking…" : "Check again"}
            </button>
          }
        >
          <p className="-mt-2 mb-3 text-xs text-muted">As WhatsApp&apos;s service last reported it.</p>
          <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
            <Row k="How it connects" v={PROVIDER_INFO[conn.provider].label} />
            <Row k="Status" v={<Badge tone={CONNECTION_TONE[conn.status] ?? "neutral"}>{conn.statusLabel}</Badge>} />
            <Row k="Number" v={conn.phone ?? "–"} />
            <Row k="WhatsApp profile name" v={conn.profileName ?? "–"} />
            <Row k="Connected" v={conn.connectedAt ? fmtAgo(conn.connectedAt) : "–"} />
            <Row k="Last update from WhatsApp" v={fmtAgo(o.health.lastEventAt ?? o.health.lastWebhookAt)} />
            <Row k="Last checked" v={fmtAgo(o.health.lastCheckedAt)} />
            {conn.downSince && <Row k="Down since" v={fmtAgo(conn.downSince)} />}
          </dl>
          {conn.reason && <p className="mt-3 text-sm text-warn">{conn.reason}</p>}
        </Card>
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
        <Card id="wa-failures" title="Failures in the last 7 days" aside="Why messages didn't go, most common first.">
          <ul className="divide-y divide-home-line text-sm">
            {o.queue.failures.map((f) => (
              <li key={`${f.reason}-${f.errorCode}`} className="flex justify-between gap-3 py-2 first:pt-0">
                <span className="min-w-0">{f.label ?? f.reason ?? "Failed"}</span>
                <span className="shrink-0 font-medium tabular-nums">{f.count}</span>
              </li>
            ))}
          </ul>
          <Link href={waHref("messages", { status: "failed" })} className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
            See failed messages
          </Link>
        </Card>
      )}

      <TableCard
        id="wa-recent"
        title="Recent messages"
        actions={
          <Link href={waHref("messages")} className="text-sm font-medium text-accent hover:underline">
            All messages
          </Link>
        }
      >
        {o.recent.length === 0 ? (
          <div className="px-5 pb-5 sm:px-6">
            <Empty>No messages yet.</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-home-line border-t border-home-line">
            {o.recent.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm sm:px-6">
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
      </TableCard>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-home-line py-2">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

/** One count on a soft tile, as the design's results cards set them (screen 17). */
function Count({ label, value, note, tone }: { label: string; value: ReactNode; note?: string; tone?: Tone }) {
  return (
    <div className="min-w-0 rounded bg-home-soft px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 flex items-center gap-2 text-lg leading-6 font-semibold tabular-nums ${tone === "danger" ? "text-danger" : ""}`}>{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

/** Counts from the message records: what WhatsApp took, delivered, read; what failed or didn't go. */
function StatsPanel({ id, title, s }: { id: string; title: string; s: WaStats }) {
  const total = s.sent + s.delivered + s.read + s.failed + s.notSent + s.waiting;
  return (
    <Card id={id} title={title}>
      <p className="-mt-2 mb-3 text-xs text-muted">Counted from each message&apos;s own record. Delivered and read come only from WhatsApp&apos;s reports.</p>
      {total + s.received === 0 ? (
        <Empty>No messages in this period.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Count label="Sent (no report yet)" value={s.sent} />
          <Count label="Delivered" value={s.delivered} />
          <Count label="Read" value={s.read} />
          <Count label="Failed" value={s.failed} tone={s.failed ? "danger" : undefined} />
          <Count label="Not sent" value={s.notSent} note="Skipped or cancelled, each with its reason." />
          <Count label="From customers" value={s.received} />
          <Count label="Delivery rate" value={fmtShare(s.deliveryRate)} note="Delivered or read, of what reached WhatsApp." />
          <Count label="Read rate" value={fmtShare(s.readRate)} />
          <Count label="Waiting" value={s.waiting} />
        </div>
      )}
    </Card>
  );
}
