"use client";
import Link from "next/link";
import { useState } from "react";
import { errorLabel, MESSAGE_STATUS_LABEL } from "@app/shared/email";
import { StepNumber } from "@/components/automations/MarketingKit";
import { AccountStatusBadge, Note, ProviderMark, providerLabel } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Card, FigureTile } from "@/components/PageKit";
import { Alert } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { fmtNum, useApi } from "@/lib/api";
import { isoDay, useEmail, type OverviewResponse } from "@/lib/email";

const PERIODS = [
  [7, "Last 7 days"],
  [30, "Last 30 days"],
  [90, "Last 90 days"],
] as const;

/** One of a card's counts on a soft box, as the Stitch design's screen 17 shows a channel's figures. */
function Count({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "good" | "danger" }) {
  return (
    <div className="flex min-w-0 flex-col rounded bg-home-soft px-3 py-2.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-lg leading-6 font-semibold tabular-nums ${tone === "good" ? "text-good" : tone === "danger" ? "text-danger" : ""}`}>{value}</span>
      {note && <span className="mt-0.5 text-xs text-muted">{note}</span>}
    </div>
  );
}

/**
 * Settings → Email integrations → Overview: every number here is counted from what was actually
 * sent. Laid out as the Stitch design's Marketing pages (screen 17): the few numbers as tiles,
 * then the period's emails on a white card, honest about what providers don't report.
 */
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
  const steps = [
    "Connect the mailbox you want to send from (Gmail, Google Workspace, Outlook, Microsoft 365 or another provider over SMTP).",
    <>Write a template: the email, with placeholders such as the customer&apos;s name or order number.</>,
    "Create an automation: when an order is paid (or another event happens), send that template.",
  ];

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

      {data.sending.suspended && <Alert>Sending is suspended for this workspace by bizinsights. Contact support.</Alert>}
      {data.sending.paused && !data.sending.suspended && (
        <Alert kind="info">
          Sending is paused. Automations still run and queue their emails; they go out when you <Link className="underline" href="/settings/email/settings">resume sending</Link>.
        </Alert>
      )}

      {noAccounts && (
        <Card id="email-start" title="Start here">
          <ol className="space-y-3 text-sm text-muted">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <StepNumber n={i + 1} />
                <span className="min-w-0 pt-0.5">
                  <span className="sr-only">{i + 1}. </span>
                  {s}
                </span>
              </li>
            ))}
          </ol>
          {manage && (
            <Link href="/settings/email/accounts?add=1" className="btn-primary mt-4 inline-flex w-fit">
              Connect an email account
            </Link>
          )}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <FigureTile title="Connected accounts" value={fmtNum(data.accounts.total)} sub={`${data.accounts.healthy} working`} testId="email-figure-accounts" />
        <FigureTile title="Verified domains" value={fmtNum(data.domains.verified)} sub={`of ${data.domains.total}`} testId="email-figure-domains" />
        <FigureTile title="Active automations" value={fmtNum(data.automations.active)} sub={`of ${data.automations.total}`} testId="email-figure-automations" />
        <FigureTile title="Templates" value={fmtNum(data.templates)} testId="email-figure-templates" />
      </div>

      <Card id="email-sent" title="Emails in this period">
        <p className="-mt-2 mb-4 text-xs text-muted">Counted from bizinsights&apos; own records. Providers confirm they accepted a message, not that it reached the inbox.</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Count label="Waiting to send" value={fmtNum(m.queued)} />
          <Count label="Accepted by provider" value={fmtNum(m.accepted)} tone={m.accepted ? "good" : undefined} />
          <Count label="Confirmed delivered" value={m.delivered === null ? "Not reported" : fmtNum(m.delivered)} note={m.delivered === null ? data.analytics.unavailable.delivered : undefined} />
          <Count label="Failed or bounced" value={fmtNum(m.failed)} tone={m.failed ? "danger" : undefined} />
          <Count label="Suppressed" value={fmtNum(m.suppressed)} note="Unsubscribed or blocked" />
        </div>
        {m.unknown > 0 && (
          <p className="mt-3 text-sm">
            <Link className="underline" href="/settings/email/activity?status=unknown">
              {m.unknown} {m.unknown === 1 ? "message has" : "messages have"} an unknown outcome
            </Link>{" "}
            <span className="text-muted">— sending was interrupted; they weren&apos;t retried automatically, to avoid duplicates.</span>
          </p>
        )}
        <div className="mt-5">
          {days_.length === 0 ? (
            <p className="rounded bg-home-soft px-4 py-6 text-center text-sm text-muted">No emails in this period.</p>
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
      </Card>

      <Card id="email-attention" title="Accounts needing attention">
        {data.accounts.attention.length === 0 ? (
          <p className="text-sm text-muted">{noAccounts ? "No accounts connected yet." : "Every connected account is working."}</p>
        ) : (
          <ul className="divide-y divide-home-line">
            {data.accounts.attention.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <ProviderMark provider={a.provider} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{a.email}</span>
                  <span className="text-xs text-muted">
                    {providerLabel(a.provider)}
                    {a.reason ? ` · ${errorLabel(a.reason)}` : ""}
                  </span>
                </span>
                <AccountStatusBadge status={a.status} />
                <Link className="home-btn h-8" href="/settings/email/accounts">
                  Fix
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

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
