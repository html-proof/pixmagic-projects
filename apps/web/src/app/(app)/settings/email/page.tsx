"use client";
import Link from "next/link";
import { useState } from "react";
import { errorLabel, MESSAGE_STATUS_LABEL } from "@app/shared/email";
import { Empty, Panel, Stat } from "@/components/dashboard/primitives";
import { AccountStatusBadge, Note, ProviderMark, providerLabel } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/whatsapp/common";
import { fmtNum, useApi } from "@/lib/api";
import { isoDay, useEmail, type OverviewResponse } from "@/lib/email";

const PERIODS = [
  [7, "Last 7 days"],
  [30, "Last 30 days"],
  [90, "Last 90 days"],
] as const;

/** Settings → Email integrations → Overview: every number here is counted from what was actually sent. */
export default function EmailOverviewPage() {
  const { base, manage } = useEmail();
  const [days, setDays] = useState<number>(30);
  // The last N days in the viewer's own calendar, sent as instants (local midnight to local midnight).
  const today = isoDay(new Date());
  const end = new Date(new Date(`${today}T00:00:00`).getTime() + 86_400_000);
  const start = new Date(end.getTime() - days * 86_400_000);
  const { data, error, loading, reload } = useApi<OverviewResponse>(`${base}/overview?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);

  if (error && !data) return <LoadError what="the email overview" error={error} onRetry={reload} busy={loading} />;
  if (!data) return <Skeleton lines={6} />;
  const m = data.messages;
  const days_ = data.analytics.byDay;
  const peak = Math.max(1, ...days_.map((d) => d.counts.accepted_by_provider + d.counts.failed + d.counts.bounced + d.counts.queued + d.counts.deferred));
  const noAccounts = data.accounts.total === 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Email integrations"
        sub="Send emails from your own Gmail, Microsoft 365 or SMTP accounts, automatically, when things happen in your business."
        actions={
          <select aria-label="Period" className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {PERIODS.map(([d, label]) => (
              <option key={d} value={d}>
                {label}
              </option>
            ))}
          </select>
        }
      />

      {data.sending.suspended && <Alert>Sending is suspended for this workspace by Insights. Contact support.</Alert>}
      {data.sending.paused && !data.sending.suspended && (
        <Alert kind="info">
          Sending is paused. Automations still run and queue their emails; they go out when you <Link className="underline" href="/settings/email/settings">resume sending</Link>.
        </Alert>
      )}

      {noAccounts && (
        <section className="card space-y-2">
          <h2 className="font-semibold">Start here</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Connect the mailbox you want to send from (Gmail, Google Workspace, Outlook, Microsoft 365 or another provider over SMTP).</li>
            <li>Write a template: the email, with placeholders such as the customer&apos;s name or order number.</li>
            <li>Create an automation: when an order is paid (or another event happens), send that template.</li>
          </ol>
          {manage && (
            <Link href="/settings/email/accounts?add=1" className="btn-primary inline-flex">
              Connect an email account
            </Link>
          )}
        </section>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Connected accounts" value={fmtNum(data.accounts.total)} note={`${data.accounts.healthy} working`} tone={data.accounts.attention.length ? "warn" : data.accounts.total ? "good" : undefined} />
        <Stat label="Verified domains" value={fmtNum(data.domains.verified)} note={`of ${data.domains.total}`} />
        <Stat label="Active automations" value={fmtNum(data.automations.active)} note={`of ${data.automations.total}`} />
        <Stat label="Templates" value={fmtNum(data.templates)} />
      </div>

      <Panel id="email-sent" title="Emails in this period" help="Counted from Insights' own records. Providers confirm they accepted a message, not that it reached the inbox.">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Waiting to send" value={fmtNum(m.queued)} />
          <Stat label="Accepted by provider" value={fmtNum(m.accepted)} tone={m.accepted ? "good" : undefined} />
          <Stat label="Confirmed delivered" value={m.delivered === null ? "Not reported" : fmtNum(m.delivered)} note={m.delivered === null ? data.analytics.unavailable.delivered : undefined} />
          <Stat label="Failed or bounced" value={fmtNum(m.failed)} tone={m.failed ? "danger" : undefined} />
          <Stat label="Suppressed" value={fmtNum(m.suppressed)} note="Unsubscribed or blocked" />
        </div>
        {m.unknown > 0 && (
          <p className="mt-3 text-sm">
            <Link className="underline" href="/settings/email/activity?status=unknown">
              {m.unknown} {m.unknown === 1 ? "message has" : "messages have"} an unknown outcome
            </Link>{" "}
            <span className="text-muted">— sending was interrupted; they weren&apos;t retried automatically, to avoid duplicates.</span>
          </p>
        )}
        <div className="mt-4">
          {days_.length === 0 ? (
            <Empty>No emails in this period.</Empty>
          ) : (
            <div>
              <div className="flex h-32 items-end gap-1" role="img" aria-label="Emails per day: accepted and failed">
                {days_.map((d) => {
                  const ok = d.counts.accepted_by_provider + d.counts.delivered;
                  const bad = d.counts.failed + d.counts.bounced;
                  const wait = d.counts.queued + d.counts.deferred + d.counts.processing;
                  return (
                    <div key={d.day} className="flex min-w-[4px] flex-1 flex-col justify-end" title={`${d.day}: ${ok} accepted, ${bad} failed, ${wait} waiting`}>
                      <div className="bg-danger/70" style={{ height: `${(bad / peak) * 100}%` }} />
                      <div className="bg-muted/40" style={{ height: `${(wait / peak) * 100}%` }} />
                      <div className="rounded-t-sm bg-accent" style={{ height: `${(ok / peak) * 100}%` }} />
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
                <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent" />{MESSAGE_STATUS_LABEL.accepted_by_provider}</span>
                <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-muted/60" />Waiting</span>
                <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-danger/70" />Failed</span>
              </p>
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-muted">{data.analytics.unavailable.opens} {data.analytics.unavailable.clicks}</p>
      </Panel>

      <Panel id="email-attention" title="Accounts needing attention">
        {data.accounts.attention.length === 0 ? (
          <Empty>{noAccounts ? "No accounts connected yet." : "Every connected account is working."}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {data.accounts.attention.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <ProviderMark provider={a.provider} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{a.email}</span>
                  <span className="text-xs text-muted">
                    {providerLabel(a.provider)}
                    {a.reason ? ` · ${errorLabel(a.reason)}` : ""}
                  </span>
                </span>
                <AccountStatusBadge status={a.status} />
                <Link className="text-sm text-accent underline" href="/settings/email/accounts">
                  Fix
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {(!data.providersConfigured.google || !data.providersConfigured.microsoft) && (
        <Note>
          {!data.providersConfigured.google && "Connecting Gmail / Google Workspace isn't set up on this server yet. "}
          {!data.providersConfigured.microsoft && "Connecting Outlook / Microsoft 365 isn't set up on this server yet. "}
          Custom SMTP works either way.
        </Note>
      )}
    </div>
  );
}
