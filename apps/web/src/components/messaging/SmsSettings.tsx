"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Cloud } from "lucide-react";
import { ORDER_STATUS_WORD, previewSms } from "@app/shared/sms";
import { ConfirmDialog, PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtMonth } from "@/components/dashboard/format";
import { Alert } from "@/components/ui";
import { api, fmtPct, useApi } from "@/lib/api";
import { countryName, fmtUsd, fmtWhen, ModeBanner, purposeLabel, SmsStatusBadge, TextBubble, useSms, useSmsAction } from "./MessagingUi";
import { MasterSwitch, SENDER_STATUS } from "./Setup";
import type { SmsMessage, SmsOverview, SmsSetupState } from "./types";

/**
 * SMS Settings: everything Set up SMS set, on one page in plain words: the connection, the sender
 * name and its approval, the messages, the last test, the automatic texts, recent texts and what
 * they cost. Changes go through the same API as the setup; the advanced pages stay in the menu.
 */

const CONNECTION: Record<SmsSetupState["connection"]["status"], { tone: Tone; label: string; help: string }> = {
  not_connected: { tone: "neutral", label: "Not connected", help: "Connect to start setting up SMS." },
  connected: { tone: "good", label: "Connected", help: "bizinsights reaches AWS End User Messaging SMS for you. No keys are stored in your account or your browser." },
  failed: { tone: "danger", label: "Connection failed", help: "AWS didn't answer the last check, or SMS isn't switched on for bizinsights yet. Try again in a few minutes." },
  disconnected: { tone: "neutral", label: "Disconnected", help: "Nothing is sent. Your sender name, messages and history are kept: reconnect any time." },
};

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card animate-rise space-y-3" aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const linkCls = "text-sm text-accent underline-offset-2 hover:underline";

export function SmsSettings() {
  const { base, manage, store } = useSms();
  const tz = store?.timezone;
  const setup = useApi<SmsSetupState>(base ? `${base}/setup` : null);
  const overview = useApi<SmsOverview>(base);
  const recent = useApi<{ messages: SmsMessage[] }>(base ? `${base}/messages?limit=5` : null);
  const { busy, run } = useSmsAction();
  const [confirm, setConfirm] = useState<"disconnect" | { master: boolean } | null>(null);
  if (setup.error) return <LoadError what="SMS settings" error={setup.error} onRetry={() => void setup.reload()} busy={setup.loading} />;
  const d = setup.data;
  if (!d || !base) return <Skeleton lines={8} />;
  const conn = CONNECTION[d.connection.status];
  const status = SENDER_STATUS[d.senderName.status] ?? SENDER_STATUS.draft!;
  const spend = overview.data?.spend;
  const business = d.businessName || d.defaultBusinessName;

  const connect = () =>
    run("connect", "connect", async () => {
      const r = await api<{ result: { connected: boolean }; setup: SmsSetupState }>(`${base}/setup/connect`, { method: "POST", body: {} });
      setup.setData(r.setup);
      return r.result.connected ? "Connected." : "The connection failed: see why below.";
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="SMS Settings"
        sub="Your SMS connection, sender name, messages and automatic texts, in one place."
        actions={
          <Link href="/messaging/setup" className={d.completedAt ? "btn-secondary" : "btn-primary"}>
            {d.completedAt ? "Open Set up SMS" : "Continue setup"}
          </Link>
        }
      />
      <ModeBanner mode={d.mode} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          id="set-conn"
          title="SMS provider"
          action={<Badge tone={conn.tone}>{conn.label}</Badge>}
        >
          <div className="flex items-center gap-3">
            <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Cloud className="h-5 w-5" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-medium">{d.connection.provider}</p>
              <p className="text-muted">
                Region {d.connection.region}
                {d.connection.connectedAt ? ` · connected ${fmtWhen(d.connection.connectedAt, tz)}` : ""}
                {d.connection.checkedAt ? ` · checked ${fmtWhen(d.connection.checkedAt, tz)}` : ""}
              </p>
            </div>
          </div>
          <p className="text-sm text-muted">{conn.help}</p>
          {manage && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={d.connection.status === "connected" ? "btn-secondary" : "btn-primary"} disabled={!!busy} onClick={() => void connect()}>
                {busy === "connect" ? "Checking…" : d.connection.status === "connected" ? "Check connection" : d.connection.status === "disconnected" ? "Reconnect" : "Connect"}
              </button>
              {d.connection.status === "connected" && (
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => setConfirm("disconnect")}>
                  Disconnect
                </button>
              )}
            </div>
          )}
        </Section>

        <Section id="set-sender" title="Sender name" action={<Badge tone={status.tone}>{status.label}</Badge>}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted">Requested name</dt>
              <dd className="font-mono">{d.senderName.support === "none" ? "A phone number" : (d.senderName.name ?? "—")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Customers in</dt>
              <dd>{d.senderName.country ? countryName(d.senderName.country) : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Texts come from now</dt>
              <dd>{d.sender?.identityCheck === "verified" ? <strong>{d.sender.identityLabel}</strong> : "No approved sender yet"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last checked with AWS</dt>
              <dd>{fmtWhen(d.senderName.checkedAt, tz)}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted">{status.help}</p>
          <div className="flex flex-wrap gap-2">
            {manage && d.senderName.status !== "draft" && (
              <button
                type="button"
                className="btn-secondary"
                disabled={!!busy}
                onClick={() =>
                  void run("check", "check with AWS", async () => {
                    const r = await api<{ result: { status: string }; setup: SmsSetupState }>(`${base}/setup/sender/check`, { method: "POST", body: {} });
                    setup.setData(r.setup);
                    return `AWS check: ${SENDER_STATUS[r.result.status]?.label ?? r.result.status}.`;
                  })
                }
              >
                {busy === "check" ? "Checking…" : "Check status"}
              </button>
            )}
            <Link className="btn-secondary" href="/messaging/setup?step=sender">
              {d.senderName.name ? "Change sender name" : "Choose a sender name"}
            </Link>
          </div>
        </Section>
      </div>

      <Section
        id="set-auto"
        title="Automatic SMS"
        action={
          <Link className={linkCls} href="/messaging/setup?step=automate">
            Edit messages and rules
          </Link>
        }
      >
        <MasterSwitch data={d} manage={manage} busy={busy} onToggle={(on) => setConfirm({ master: on })} />
        <ul className="divide-y divide-border">
          {d.automations
            .filter((a) => !a.unavailable)
            .map((a) => (
              <li key={a.key} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {a.label} <Badge tone={a.on ? "good" : "neutral"}>{a.on ? "On" : "Off"}</Badge>
                    {a.templateStatus === "approved" ? <Badge tone="good">Message approved</Badge> : a.templateId ? <Badge tone="neutral">Message not approved yet</Badge> : null}
                  </p>
                  <TextBubble>{previewSms(a.body, { customer_name: "Sarah", order_number: "#1042", business_name: business, order_status: (a.trigger && ORDER_STATUS_WORD[a.trigger]) || "confirmed" })}</TextBubble>
                </div>
              </li>
            ))}
        </ul>
        <p className="text-xs text-muted">
          More texts and conditions: <Link className="underline" href="/messaging/automations">Automated Workflows</Link> · all message templates: <Link className="underline" href="/messaging/templates">Message Templates</Link>.
        </p>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          id="set-test"
          title="Test SMS"
          action={
            <Link className={linkCls} href="/messaging/setup?step=test">
              Send a test
            </Link>
          }
        >
          {d.lastTest ? (
            <div className="space-y-1 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <SmsStatusBadge status={d.lastTest.status} why={d.lastTest.reasonLabel} />
                {d.lastTest.to && <span className="text-muted">to {d.lastTest.to}</span>}
                <span className="text-muted">· {fmtWhen(d.lastTest.createdAt, tz)}</span>
              </p>
              {d.lastTest.providerExplanation && <p className="text-muted">{d.lastTest.providerExplanation}</p>}
            </div>
          ) : (
            <p className="text-sm text-muted">No test sent yet. Send one to your own phone to see exactly what customers get.</p>
          )}
          <p className="text-xs text-muted">
            Verified test numbers: {d.testNumbers.filter((t) => t.status === "verified").length || "none"}
            {d.testNumbers.length ? ` (${d.testNumbers.map((t) => t.number).join(", ")})` : ""}
          </p>
        </Section>

        <Section
          id="set-cost"
          title="Usage and estimated costs"
          action={
            <Link className={linkCls} href="/messaging/billing">
              SMS Billing
            </Link>
          }
        >
          {spend ? (
            <div className="text-sm">
              <p className="text-2xl font-semibold tabular-nums">{fmtUsd(spend.totalUsd)}</p>
              <p className="text-muted">
                spent in {fmtMonth(spend.month, { year: true })}
                {spend.budgetUsd > 0 ? ` of your ${fmtUsd(spend.budgetUsd)} limit${spend.usedPct !== null ? ` (${fmtPct(spend.usedPct / 100)})` : ""}` : " · no monthly limit set, so nothing is sent"}
              </p>
            </div>
          ) : overview.error ? (
            <p className="text-sm text-muted">Couldn&apos;t load this month&apos;s spend.</p>
          ) : (
            <div className="skeleton h-12" />
          )}
          <p className="text-sm text-muted">
            {d.price && d.price.perPartUsd > 0
              ? `A one-part text to ${countryName(d.price.country)} costs about ${fmtUsd(d.price.perPartUsd)} (${d.price.source === "aws_billed" ? "the average AWS charged recently" : "AWS's price list"}).`
              : "No price per text yet: it appears once AWS prices your first texts."}{" "}
            Amounts are AWS&apos;s, in US dollars; texts not priced yet count at their estimate.
          </p>
        </Section>
      </div>

      <Section
        id="set-history"
        title="Recent messages and delivery"
        action={
          <Link className={linkCls} href="/messaging/history">
            Message History
          </Link>
        }
      >
        {recent.error ? (
          <p className="text-sm text-muted">Couldn&apos;t load recent messages.</p>
        ) : !recent.data ? (
          <div className="skeleton h-16" />
        ) : !recent.data.messages.length ? (
          <p className="text-sm text-muted">No texts yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {recent.data.messages.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="w-32 shrink-0 text-muted">{fmtWhen(m.createdAt, tz)}</span>
                <span className="min-w-0 flex-1">{purposeLabel(m.purpose, m.trigger)}</span>
                {m.to && <span className="font-mono text-xs text-muted">{m.to}</span>}
                <SmsStatusBadge status={m.status} why={m.providerExplanation ?? m.reasonLabel} />
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">&quot;Delivered&quot; only when the phone confirmed it; &quot;Accepted by AWS&quot; means AWS took it and the carrier hasn&apos;t answered yet.</p>
      </Section>

      {!manage && <Alert kind="info">Only owners and admins can change SMS settings.</Alert>}

      <ConfirmDialog
        open={!!confirm}
        title={confirm === "disconnect" ? "Disconnect SMS?" : confirm?.master ? "Enable automatic SMS?" : "Turn automatic SMS off?"}
        confirmLabel={confirm === "disconnect" ? "Disconnect" : confirm?.master ? "Turn on" : "Turn off"}
        danger={confirm === "disconnect" || (typeof confirm === "object" && confirm?.master === false)}
        busy={!!busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          if (c === "disconnect")
            void run("disconnect", "disconnect", async () => {
              setup.setData(await api<SmsSetupState>(`${base}/setup/disconnect`, { method: "POST", body: {} }));
              setConfirm(null);
              return "Disconnected. Nothing is sent until you reconnect.";
            }).then((ok) => !ok && setConfirm(null));
          else if (c)
            void run("master", c.master ? "turn automatic SMS on" : "turn automatic SMS off", async () => {
              setup.setData(await api<SmsSetupState>(`${base}/setup/automatic`, { method: "POST", body: { on: c.master } }));
              setConfirm(null);
              return c.master ? "Automatic SMS is on." : "Automatic SMS is off.";
            }).then((ok) => !ok && setConfirm(null));
        }}
      >
        {confirm === "disconnect" ? (
          <p>Texting stops at once and texts waiting to go are cancelled. Your sender name, messages and history are kept, so you can reconnect later.</p>
        ) : confirm?.master ? (
          <p>Your automatic texts that are on start going to real customers as their orders happen{d.mode === "live" ? "." : ". bizinsights is in test mode for now, so they're recorded in Message History instead of sent."}</p>
        ) : (
          <p>No more automatic texts go out. Texts waiting to go are cancelled.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
