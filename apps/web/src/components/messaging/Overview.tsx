"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { skipLabel } from "@app/shared/sms";
import { Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, Empty, Stat, type Tone } from "@/components/dashboard/Primitives";
import { fmtMonth } from "@/components/dashboard/format";
import { Alert } from "@/components/ui";
import { fmtNum, fmtPct, useApi } from "@/lib/api";
import { CAMPAIGN_STATUS, countryName, fmtUsd, fmtWhen, ModeBanner, plural, StatusPill, useSms } from "./MessagingUi";
import type { SmsOverview } from "./types";

const MODE: Record<SmsOverview["mode"], { tone: Tone; label: string }> = {
  off: { tone: "neutral", label: "Not switched on" },
  sandbox: { tone: "warn", label: "Test mode" },
  live: { tone: "good", label: "Live" },
};

function Step({ done, href, children }: { done: boolean; href: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-good text-white" : "border border-border text-muted"}`}>
        {done ? "✓" : ""}
      </span>
      <span className={`text-sm ${done ? "text-muted line-through decoration-border" : ""}`}>
        <span className="sr-only">{done ? "Done: " : "To do: "}</span>
        {done ? (
          children
        ) : (
          <Link className="text-accent underline-offset-2 hover:underline" href={href}>
            {children}
          </Link>
        )}
      </span>
    </li>
  );
}

/** Customer Messaging at a glance: what is set up, what ran this week, what it cost and what needs a look. */
export function MessagingOverview() {
  const { base } = useSms();
  const { data, error, reload, loading } = useApi<SmsOverview>(base);
  if (error) return <LoadError what="Customer Messaging" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!data) return <Skeleton lines={6} />;
  const { setup, sender, last7Days: w, spend, pendingApprovals: p } = data;
  const steps: Array<[boolean, string, string]> = [
    [setup.sender, "/messaging/sender", "Set up the sender: the AWS number or sender ID your texts come from"],
    [setup.verified, "/messaging/sender", "Check the sender with AWS"],
    [setup.budget, "/messaging/sender", "Set a monthly SMS budget (nothing is sent with a budget of 0)"],
    [setup.basis, "/messaging/sender", "Choose how customers agree to order updates by text"],
    [setup.testNumber, "/messaging/sender", "Add and verify a test number, and send yourself a test"],
    [setup.approvedTemplate, "/messaging/templates", "Write a message template and get it approved"],
    [setup.activeRule, "/messaging/automations", "Approve an automated workflow"],
    [setup.sending, "/messaging/sender", "Turn sending on"],
  ];
  const todo = steps.filter(([done]) => !done).length;
  const pending = p.templates + p.rules + p.campaigns;
  const attention = (data.attention.failed ?? 0) + (data.attention.unknown ?? 0) + (data.attention.uncertain ?? 0);
  const held = sender?.heldUntil && new Date(sender.heldUntil).getTime() > Date.now();
  const anyTexts = w.requested + w.dryRun > 0;

  return (
    <div className="space-y-4">
      <section className="card animate-rise" aria-labelledby="sms-h">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 id="sms-h" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              Customer Messaging for {data.store.name} <Badge tone={MODE[data.mode].tone}>{MODE[data.mode].label}</Badge>
            </h1>
            <p className="mt-1 text-sm text-muted">
              Order updates and marketing texts sent through AWS, only to customers Shopify says may receive them. Every template, workflow and campaign is approved by an owner or admin before it
              reaches anyone.
            </p>
            {sender && (
              <p className="mt-2 text-sm">
                {sender.identityLabel ?? "Sender saved"} · {sender.countries.length ? sender.countries.map(countryName).join(", ") : "no countries yet"} ·{" "}
                <span className={sender.sendingEnabled ? "text-good" : "text-muted"}>{sender.sendingEnabled ? "sending on" : "sending off"}</span> ·{" "}
                <span className={sender.marketingEnabled ? "text-good" : "text-muted"}>{sender.marketingEnabled ? "marketing on" : "marketing off"}</span>
              </p>
            )}
          </div>
          <Link href="/messaging/sender" className={setup.sender ? "btn-secondary" : "btn-primary"}>
            {setup.sender ? "Sender configuration" : "Set up the sender"}
          </Link>
        </div>
      </section>

      <ModeBanner mode={data.mode} showLive />
      {held && (
        <Alert>
          Texts are held until {fmtWhen(sender!.heldUntil, data.store.timezone)}
          {sender!.heldReason ? `: ${skipLabel(sender!.heldReason)}` : ""}. They go out once the hold ends; nothing is lost.
        </Alert>
      )}

      {todo > 0 && (
        <section className="card animate-rise" aria-labelledby="setup-h">
          <h2 id="setup-h" className="font-semibold">
            Finish setting up <span className="text-sm font-normal text-muted">({steps.length - todo} of {steps.length} done)</span>
          </h2>
          <p className="text-sm text-muted">No text reaches a customer until each step is done.</p>
          <ol className="mt-2 divide-y divide-border">
            {steps.map(([done, href, text]) => (
              <Step key={text} done={done} href={href}>
                {text}
              </Step>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="week-h" className="space-y-2">
        <h2 id="week-h" className="text-sm font-semibold">
          Last 7 days
        </h2>
        {!anyTexts ? (
          <Empty>No texts in the last 7 days. Test texts aren&apos;t counted here.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Requested" value={fmtNum(w.requested)} note={w.dryRun ? `${fmtNum(w.dryRun)} more recorded as dry runs` : "Every text something asked for"} />
            <Stat label="Accepted by AWS" value={fmtNum(w.accepted)} note={w.pending ? `${fmtNum(w.pending)} still with AWS or the carrier` : "—"} />
            <Stat
              label="Delivered"
              value={fmtNum(w.delivered)}
              note={w.carrierAccepted ? `+ ${fmtNum(w.carrierAccepted)} accepted by the carrier (networks that give no phone receipt)` : "Confirmed by the phone"}
              tone={w.delivered + w.carrierAccepted ? "good" : undefined}
            />
            <Stat label="Failed" value={fmtNum(w.failed)} tone={w.failed ? "danger" : undefined} note={w.notSent || w.optedOut ? `${fmtNum(w.notSent + w.optedOut)} not sent (consent, opt-out, quiet hours…)` : "—"} />
            <Stat label="Unknown outcome" value={fmtNum(w.unknown)} tone={w.unknown ? "warn" : undefined} note="No final word from the carrier" />
            <Stat label="Delivery rate" value={fmtPct(w.deliveryRate)} note="Of texts with a final outcome, delivered or accepted by the carrier" />
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card animate-rise" aria-labelledby="spend-h">
          <div className="flex items-center justify-between gap-2">
            <h2 id="spend-h" className="font-semibold">
              Spend in {fmtMonth(spend.month, { year: true })}
            </h2>
            <Link className="text-sm text-accent underline-offset-2 hover:underline" href="/messaging/billing">
              SMS Billing
            </Link>
          </div>
          {spend.budgetUsd > 0 ? (
            <>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{fmtUsd(spend.totalUsd)}</p>
              <p className="text-sm text-muted">
                of a {fmtUsd(spend.budgetUsd)} budget{spend.usedPct !== null ? ` · ${fmtPct(spend.usedPct / 100)} used` : ""}
              </p>
              <div className="mt-2 h-2 rounded-full bg-bg" aria-hidden>
                <div className={`h-2 rounded-full ${(spend.usedPct ?? 0) >= 100 ? "bg-danger" : (spend.usedPct ?? 0) >= 80 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.min(100, spend.usedPct ?? 0)}%` }} />
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">
              {spend.totalUsd > 0 ? `${fmtUsd(spend.totalUsd)} so far. ` : ""}No monthly budget is set, so nothing is sent.{" "}
              <Link className="text-accent underline" href="/messaging/sender">
                Set one
              </Link>
              .
            </p>
          )}
          <p className="mt-2 text-xs text-muted">AWS prices each text in US dollars when it reports the delivery; texts it hasn&apos;t priced yet count at their estimate.</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted">Waiting to send</dt>
              <dd>{data.scheduled ? fmtNum(data.scheduled) : "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Subscribed to SMS marketing</dt>
              <dd>{data.contacts ? `${fmtNum(data.subscribed)} of ${plural(data.contacts, "customer")}` : "No customers with a mobile number yet"}</dd>
            </div>
          </dl>
        </section>

        <section className="card animate-rise" aria-labelledby="att-h">
          <h2 id="att-h" className="font-semibold">
            Needs attention {pending + attention ? <Badge tone="warn">{pending + attention}</Badge> : null}
          </h2>
          {!pending && !attention && !data.campaigns.length ? <p className="mt-2 text-sm text-muted">Nothing right now.</p> : null}
          <ul className="mt-2 space-y-2 text-sm">
            {p.templates > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/templates">
                  {plural(p.templates, "template")} waiting for review
                </Link>
              </li>
            )}
            {p.rules > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/automations">
                  {plural(p.rules, "workflow")} waiting for approval
                </Link>
              </li>
            )}
            {p.campaigns > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/campaigns">
                  {plural(p.campaigns, "campaign")} waiting for approval
                </Link>
              </li>
            )}
            {(data.attention.failed ?? 0) > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/history?status=failed">
                  {plural(data.attention.failed!, "failed text")} this week
                </Link>
              </li>
            )}
            {(data.attention.unknown ?? 0) + (data.attention.uncertain ?? 0) > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/history?status=unknown,uncertain">
                  {plural((data.attention.unknown ?? 0) + (data.attention.uncertain ?? 0), "text")} with no final outcome this week
                </Link>
              </li>
            )}
            {data.campaigns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/campaigns">
                  Campaign &ldquo;{c.name}&rdquo;
                </Link>
                <StatusPill map={CAMPAIGN_STATUS} status={c.status} />
                {c.status === "scheduled" && c.scheduledAt ? <span className="text-xs text-muted">starts {fmtWhen(c.scheduledAt, data.store.timezone)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
