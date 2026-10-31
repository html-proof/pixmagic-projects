"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowRight, BarChart3, Check, CircleAlert, Clock, Cloud, FileText, Gauge, History, Radio, ShieldCheck, Smartphone, UserCheck } from "lucide-react";
import { ConfirmDialog, PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtMonth } from "@/components/dashboard/format";
import { Alert } from "@/components/ui";
import { api, fmtPct, useApi } from "@/lib/api";
import { actionLabel, fmtUsd, fmtWhen, usePagedList, useSms, useSmsAction } from "./MessagingUi";
import { MasterSwitch } from "./Setup";
import { TestNumbers } from "./TestNumbers";
import type { ReadinessItem, SmsOverview, SmsSetupState } from "./types";

/**
 * Settings: the store's SMS setup in plain words, done once and used by every automation (sender,
 * verification, customer permissions, the monthly limit, automatic SMS, test recipients), each
 * with where it's changed. Under Advanced, for owners and admins: the specialist pages, the
 * provider connection and the activity log. Changes go through the same API as the setup guide.
 */

const CONNECTION: Record<SmsSetupState["connection"]["status"], { tone: Tone; label: string; help: string }> = {
  not_connected: { tone: "neutral", label: "Not connected", help: "Connect to start setting up SMS." },
  connected: { tone: "good", label: "Connected", help: "bizinsights reaches the SMS provider (AWS End User Messaging SMS) for you. No keys are stored in your account or your browser." },
  failed: { tone: "danger", label: "Connection failed", help: "The provider didn't answer the last check, or SMS isn't switched on for bizinsights yet. Try again in a few minutes." },
  disconnected: { tone: "neutral", label: "Disconnected", help: "Nothing is sent. Your sender name, messages and history are kept: reconnect any time." },
};

/** Where each setup item is changed, when it's already done. */
const CHANGE: Partial<Record<ReadinessItem["key"], { label: string; href: string }>> = {
  sender: { label: "Change", href: "/messaging/setup?step=sender" },
  verification: { label: "Details", href: "/messaging/setup?step=sender" },
  permissions: { label: "Change", href: "/messaging/setup?step=automate" },
  limit: { label: "Change", href: "/messaging/setup?step=automate" },
};

const ADVANCED: Array<{ href: string; title: string; help: string; icon: typeof Cloud }> = [
  { href: "/messaging/sender", title: "SMS Sender", help: "Sender name or number, countries, quiet hours and daily caps.", icon: Radio },
  { href: "/messaging/setup?step=sender", title: "Messaging verification", help: "Your sender name's registration and approval.", icon: ShieldCheck },
  { href: "/messaging/billing", title: "Monthly messaging limit", help: "What texts cost this month, and the limit.", icon: Gauge },
  { href: "/messaging/consent", title: "Customer messaging permissions", help: "Who agreed to texts, opt-outs and the do-not-text list.", icon: UserCheck },
  { href: "/messaging/templates", title: "Message templates", help: "Every message, its versions and approvals.", icon: FileText },
  { href: "/messaging/analytics", title: "Delivery analytics", help: "Delivery, cost and orders that followed a text.", icon: BarChart3 },
];

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card animate-rise scroll-mt-4 space-y-3" aria-labelledby={`${id}-h`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-h`} className="font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  targetType: string | null;
  version: number | null;
  actor: string;
  at: string;
}

/** Who changed what in Customer Messaging, newest first (owners and admins). */
function ActivityLog() {
  const { base, store } = useSms();
  const list = usePagedList<AuditEntry>(base ? `${base}/audit?limit=20` : null, "entries");
  if (list.error && !list.rows) return <p className="text-sm text-muted">Couldn&apos;t load the activity log.</p>;
  if (!list.rows) return <div className="skeleton h-16" />;
  if (!list.rows.length) return <p className="text-sm text-muted">Nothing changed yet.</p>;
  return (
    <>
      <ul className="divide-y divide-border text-sm">
        {list.rows.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
            <span className="w-36 shrink-0 text-xs text-muted">{fmtWhen(e.at, store?.timezone)}</span>
            <span className="min-w-0 flex-1">
              {actionLabel(e.action)}
              {e.targetType ? <span className="text-muted"> · {e.targetType.replace(/^sms_/, "").replace(/_/g, " ")}</span> : null}
              {e.version ? <span className="text-muted"> (version {e.version})</span> : null}
            </span>
            <span className="text-xs text-muted">{e.actor}</span>
          </li>
        ))}
      </ul>
      {list.cursor && (
        <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={list.loading} onClick={list.loadMore}>
          {list.loading ? "Loading…" : "Load more"}
        </button>
      )}
    </>
  );
}

export function SmsSettings() {
  const { base, manage, store } = useSms();
  const tz = store?.timezone;
  const setup = useApi<SmsSetupState>(base ? `${base}/setup` : null);
  const overview = useApi<SmsOverview>(base);
  const { busy, run } = useSmsAction();
  const [confirm, setConfirm] = useState<"disconnect" | { master: boolean } | null>(null);
  if (setup.error) return <LoadError what="SMS settings" error={setup.error} onRetry={() => void setup.reload()} busy={setup.loading} />;
  const d = setup.data;
  if (!d || !base) return <Skeleton lines={8} />;
  const conn = CONNECTION[d.connection.status];
  const readiness = overview.data?.readiness;
  const spend = overview.data?.spend;
  const items = (readiness?.items ?? []).filter((i) => i.key !== "sending" && i.key !== "test_recipient");

  const connect = () =>
    run("connect", "connect", async () => {
      const r = await api<{ result: { connected: boolean }; setup: SmsSetupState }>(`${base}/setup/connect`, { method: "POST", body: {} });
      setup.setData(r.setup);
      void overview.reload();
      return r.result.connected ? "Connected." : "The connection failed: see why below.";
    });
  const checkSender = () =>
    run("check", "check your sender", async () => {
      const r = await api<{ result: { status: string }; setup: SmsSetupState }>(`${base}/setup/sender/check`, { method: "POST", body: {} });
      setup.setData(r.setup);
      void overview.reload();
      return r.result.status === "approved" ? "Your sender is verified." : "Checked: your sender isn't verified yet.";
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        sub="Your store's SMS setup. It's done once: every automation uses it from then on."
        actions={
          manage ? (
            <Link href="/messaging/setup" className={d.completedAt ? "btn-secondary" : "btn-primary"}>
              {d.completedAt ? "Open the setup guide" : "Continue setup"}
            </Link>
          ) : undefined
        }
      />
      {readiness?.testMode && (
        <Alert kind="info">
          <strong>Your SMS account is still being verified.</strong> Test messages can be sent to approved numbers until verification is complete; until then automations record what they would send.
          bizinsights finishes this verification with the SMS provider: there&apos;s nothing to do on your side but the steps below.
        </Alert>
      )}

      <Section id="set-setup" title="SMS setup" action={readiness ? <Badge tone={readiness.status === "ready" ? "good" : "warn"}>{readiness.status === "ready" ? "Ready" : readiness.status === "action_required" ? "Action required" : "Setup required"}</Badge> : undefined}>
        {!readiness ? (
          overview.error ? <p className="text-sm text-muted">Couldn&apos;t load your setup.</p> : <div className="skeleton h-24" />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => {
              const link = !i.ok ? i.fix : CHANGE[i.key];
              return (
                <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${i.ok ? "bg-good/15 text-good" : i.waiting ? "bg-text/[0.06] text-muted" : "bg-warn/15 text-warn"}`}>
                    {i.ok ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i.waiting ? <Clock className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{i.label}</span>
                    <span className="block text-xs text-muted">{i.detail}</span>
                  </span>
                  {manage && i.key === "verification" && d.senderName.status !== "draft" && !i.ok && (
                    <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void checkSender()}>
                      {busy === "check" ? "Checking…" : "Check status"}
                    </button>
                  )}
                  {manage && link && (
                    <Link href={link.href} className="btn-secondary inline-flex h-8 items-center gap-1 px-3 text-xs" aria-label={`${i.ok ? link.label : "Fix this"}: ${i.label}`}>
                      {i.ok ? link.label : "Fix this"} {!i.ok && <ArrowRight aria-hidden className="h-3.5 w-3.5" />}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {spend && spend.budgetUsd > 0 && (
          <p className="text-xs text-muted">
            {fmtUsd(spend.totalUsd)} used in {fmtMonth(spend.month, { year: true })} of your {fmtUsd(spend.budgetUsd)} limit{spend.usedPct !== null ? ` (${fmtPct(spend.usedPct / 100)})` : ""}. Amounts are in US dollars; texts not priced yet count at their estimate.
          </p>
        )}
      </Section>

      <Section id="set-auto" title="Automatic SMS">
        <MasterSwitch data={d} manage={manage} busy={busy} onToggle={(on) => setConfirm({ master: on })} onText="Your automations that are active text customers as things happen in your store." />
        <p className="text-sm text-muted">
          The automations themselves are on the{" "}
          <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/automations">
            Automations
          </Link>{" "}
          page.
        </p>
      </Section>

      {manage ? (
        <TestNumbers mode={d.mode} />
      ) : (
        <Section id="test-recipients" title="Test recipients">
          <p className="text-sm text-muted">Approved test numbers: {d.testNumbers.filter((t) => t.status === "verified").length || "none"}. Only owners and admins can add them.</p>
        </Section>
      )}

      {manage && (
        <section className="space-y-3" aria-labelledby="set-adv-h">
          <div>
            <h2 id="set-adv-h" className="font-semibold">
              Advanced
            </h2>
            <p className="text-sm text-muted">For owners and admins. You don&apos;t need these to create an automation.</p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ADVANCED.map((a) => (
              <li key={a.href}>
                <Link href={a.href} className="card flex h-full items-start gap-3 transition hover:border-accent/60">
                  <a.icon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                  <span className="min-w-0">
                    <span className="block font-medium">{a.title}</span>
                    <span className="block text-sm text-muted">{a.help}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <details className="card">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 font-medium">
              <Cloud aria-hidden className="h-4 w-4 text-accent" /> Provider configuration <Badge tone={conn.tone}>{conn.label}</Badge>
            </summary>
            <div className="mt-3 space-y-3 text-sm">
              <p className="font-medium">{d.connection.provider}</p>
              <p className="text-muted">
                Region {d.connection.region}
                {d.connection.connectedAt ? ` · connected ${fmtWhen(d.connection.connectedAt, tz)}` : ""}
                {d.connection.checkedAt ? ` · checked ${fmtWhen(d.connection.checkedAt, tz)}` : ""}
              </p>
              <p className="text-muted">{conn.help}</p>
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
            </div>
          </details>

          <details className="card">
            <summary className="flex cursor-pointer items-center gap-2 font-medium">
              <History aria-hidden className="h-4 w-4 text-accent" /> Activity log
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted">Who changed what in Customer Messaging: messages, automations, sender, approvals and opt-outs.</p>
              <ActivityLog />
            </div>
          </details>

          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Smartphone aria-hidden className="h-3.5 w-3.5" /> Every text is checked right before it goes: the customer&apos;s permission, opt-outs, quiet hours and your monthly limit.
          </p>
        </section>
      )}

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
              void overview.reload();
              return "Disconnected. Nothing is sent until you reconnect.";
            }).then((ok) => !ok && setConfirm(null));
          else if (c)
            void run("master", c.master ? "turn automatic SMS on" : "turn automatic SMS off", async () => {
              setup.setData(await api<SmsSetupState>(`${base}/setup/automatic`, { method: "POST", body: { on: c.master } }));
              setConfirm(null);
              void overview.reload();
              return c.master ? "Automatic SMS is on." : "Automatic SMS is off.";
            }).then((ok) => !ok && setConfirm(null));
        }}
      >
        {confirm === "disconnect" ? (
          <p>Texting stops at once and texts waiting to go are cancelled. Your sender name, messages and history are kept, so you can reconnect later.</p>
        ) : confirm?.master ? (
          <p>Your automations that are on start texting real customers as things happen{d.mode === "live" ? "." : ". While your SMS account is being verified, they're recorded in Message History instead of sent."}</p>
        ) : (
          <p>No more automatic texts go out. Texts waiting to go are cancelled.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
