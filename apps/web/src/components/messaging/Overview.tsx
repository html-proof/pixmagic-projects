"use client";
import Link from "next/link";
import { ArrowRight, Check, CircleAlert, Clock, History, Plus, Send, Settings, ShoppingCart, Sparkles, Truck, Workflow, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { fmtMonth } from "@/components/dashboard/format";
import { Alert } from "@/components/ui";
import { fmtNum, fmtPct, useApi } from "@/lib/api";
import { AUTOMATION_STATUS, TriggerIcon } from "./AutomationUi";
import { fmtUsd, fmtWhen, plural, useSms } from "./MessagingUi";
import type { AutomationsResponse, MessagingReadiness, ReadinessItem, SmsOverview } from "./types";

// ---------------------------------------------------------------------------
// Customer Messaging's home: is texting ready (in one word, with only what's missing), the one
// button that starts an automation, and how this month is going. Every figure and state is the
// API's (apps/api/src/routes/sms.ts, packages/core/src/sms/readiness.ts); nothing here names the
// SMS provider, and the one-time setup lives under Settings and the Advanced pages.
// ---------------------------------------------------------------------------

const STATUS: Record<MessagingReadiness["status"], { tone: Tone; label: string; dot: string }> = {
  ready: { tone: "good", label: "Ready", dot: "bg-good" },
  setup_required: { tone: "warn", label: "Setup required", dot: "bg-warn" },
  action_required: { tone: "warn", label: "Action required", dot: "bg-warn" },
};

/** A first automation in one click: the trigger's ready-made message, opened in the builder. */
const QUICK_STARTS: Array<{ trigger: string; label: string; help: string; icon: LucideIcon }> = [
  { trigger: "fulfillment_created", label: "Order shipped", help: "With the tracking link", icon: Truck },
  { trigger: "order_created", label: "Order confirmation", help: "Thanks for the order", icon: Sparkles },
  { trigger: "checkout_abandoned", label: "Abandoned checkout", help: "A gentle reminder", icon: ShoppingCart },
];

function statusLine(r: MessagingReadiness, missing: ReadinessItem[], automations: number): string {
  if (r.status === "action_required") return r.problems.find((p) => p.kind === "temporary")?.message ?? "Something needs a look before more texts go out.";
  if (missing.length) return `${plural(missing.length, "thing")} to finish before texts reach customers. Each is done once.`;
  if (r.testMode) return "Everything on your side is set up. Your SMS account is still being verified: see below.";
  return automations ? "Your automations text customers as things happen in your store." : "Everything is set up. Create an automation and it starts texting customers.";
}

/** One line of the setup list: what it is now, and the way to fix it. */
export function ReadinessRow({ item, manage }: { item: ReadinessItem; manage: boolean }) {
  const tone = item.ok ? "bg-good/15 text-good" : item.waiting ? "bg-text/[0.06] text-muted" : "bg-warn/15 text-warn";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${tone}`}>
        {item.ok ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : item.waiting ? <Clock className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          <span className="sr-only">{item.ok ? "Ready: " : item.waiting ? "In progress: " : "To do: "}</span>
          {item.label}
          {item.optional && !item.ok ? <span className="ml-1.5 text-xs font-normal text-muted">(optional)</span> : null}
        </span>
        <span className="block text-xs text-muted">{item.detail}</span>
      </span>
      {item.waiting && !item.ok && <span className="text-xs text-muted">In progress</span>}
      {!item.ok && item.fix && (manage ? (
        <Link href={item.fix.href} className="btn-secondary inline-flex h-8 items-center gap-1 px-3 text-xs" aria-label={`${item.fix.label}: ${item.label}`}>
          Fix this <ArrowRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <span className="text-xs text-muted">An owner or admin can fix this</span>
      ))}
    </li>
  );
}

/** Customer Messaging at a glance: whether texting is ready, the automations, and this month's texts. */
export function MessagingOverview() {
  const { base, manage, store } = useSms();
  const { data, error, reload, loading } = useApi<SmsOverview>(base);
  const list = useApi<AutomationsResponse>(base ? `${base}/automations` : null);
  if (error) return <LoadError what="Customer Messaging" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!data) return <Skeleton lines={6} />;

  const r = data.readiness;
  const status = STATUS[r.status];
  const missing = r.items.filter((i) => !i.ok && !i.optional && i.key !== "account");
  const done = r.items.filter((i) => i.ok);
  const month = data.thisMonth;
  const active = data.rules.active ?? 0;
  const paused = data.rules.paused ?? 0;
  const drafts = (data.rules.draft ?? 0) + (data.rules.pending_approval ?? 0);
  const automations = list.data?.automations ?? [];
  const sendsMarketing = automations.some((a) => a.category === "marketing");
  const failedWeek = data.attention.failed ?? 0;
  const unsureWeek = (data.attention.unknown ?? 0) + (data.attention.uncertain ?? 0);
  const held = data.sender?.heldUntil && new Date(data.sender.heldUntil).getTime() > Date.now();
  const tz = data.store.timezone;

  return (
    <div className="space-y-4">
      <section className="card animate-rise" aria-labelledby="sms-h">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h1 id="sms-h" className="text-xl font-semibold">
              Text messages
            </h1>
            <p className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
              <span className="text-muted">Status:</span>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold ${r.status === "ready" ? "bg-good/10 text-good" : "bg-warn/10 text-warn"}`} data-testid="messaging-status">
                <span aria-hidden className={`h-2 w-2 rounded-full ${status.dot}`} />
                {status.label}
              </span>
            </p>
            <p className="max-w-2xl text-sm text-muted">{statusLine(r, missing, active)}</p>
          </div>
          {manage ? (
            <div className="flex flex-wrap gap-2">
              <Link href="/messaging/send" className="btn-secondary inline-flex h-11 items-center gap-2 px-5 text-base">
                <Send aria-hidden className="h-5 w-5" /> Send SMS
              </Link>
              <Link href="/messaging/automations/edit" className="btn-primary inline-flex h-11 items-center gap-2 px-5 text-base">
                <Plus aria-hidden className="h-5 w-5" /> Create SMS Automation
              </Link>
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
          <Link href="/messaging/automations" className="btn-secondary inline-flex items-center gap-1.5">
            <Workflow aria-hidden className="h-4 w-4" /> View Automations
          </Link>
          <Link href="/messaging/history" className="btn-secondary inline-flex items-center gap-1.5">
            <History aria-hidden className="h-4 w-4" /> Message History
          </Link>
          <Link href="/messaging/settings" className="btn-secondary inline-flex items-center gap-1.5">
            <Settings aria-hidden className="h-4 w-4" /> Settings
          </Link>
        </div>
      </section>

      {r.testMode && !missing.length && (
        <Alert kind="info">
          <p>
            <strong>Your SMS account is still being verified.</strong> Test messages can be sent to approved numbers until verification is complete. Until then, automations record what they would
            send in Message History instead of texting customers.
          </p>
          <Link className="mt-1 inline-flex items-center gap-1 font-medium underline" href="/messaging/settings">
            View setup requirements <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </Link>
        </Alert>
      )}
      {held && (
        <Alert>
          Sending is paused until {fmtWhen(data.sender!.heldUntil, tz)} after a problem with your SMS sender. Texts go out once it ends; nothing is lost.
        </Alert>
      )}

      <section aria-label="This month" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card animate-rise">
          <p className="text-xs text-muted">SMS Automations</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-lg bg-good/10 px-2.5 py-1 text-sm font-semibold text-good">Active: {fmtNum(active)}</span>
            <span className="rounded-lg bg-bg px-2.5 py-1 text-sm font-semibold">Paused: {fmtNum(paused)}</span>
          </div>
          <p className="mt-2 text-xs text-muted">{drafts ? `${plural(drafts, "draft")} not switched on yet` : "Switched on ones run by themselves"}</p>
        </div>
        <div className="card animate-rise">
          <p className="text-xs text-muted">Messages sent</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{fmtNum(month.accepted)}</p>
          <p className="mt-1 text-xs text-muted">
            Since {fmtMonth(month.from.slice(0, 7))} 1{month.dryRun ? ` · ${fmtNum(month.dryRun)} recorded in test mode` : ""}
          </p>
        </div>
        <div className="card animate-rise">
          <p className="text-xs text-muted">Delivery rate</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{fmtPct(month.deliveryRate)}</p>
          <p className="mt-1 text-xs text-muted">{month.delivered + month.carrierAccepted ? `${fmtNum(month.delivered + month.carrierAccepted)} delivered this month` : "Once texts have a final outcome"}</p>
        </div>
        <div className="card animate-rise">
          <p className="text-xs text-muted">{month.quota ? "Messages this month" : "Monthly messaging limit"}</p>
          {month.quota ? (
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {fmtNum(month.accepted)} <span className="text-base font-normal text-muted">/ {fmtNum(month.quota)}</span>
            </p>
          ) : (
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {fmtUsd(data.spend.totalUsd)} {data.spend.budgetUsd > 0 && <span className="text-base font-normal text-muted">/ {fmtUsd(data.spend.budgetUsd)}</span>}
            </p>
          )}
          {data.spend.budgetUsd > 0 ? (
            <div className="mt-2 h-1.5 rounded-full bg-bg" aria-hidden>
              <div
                className={`h-1.5 rounded-full ${(data.spend.usedPct ?? 0) >= 100 ? "bg-danger" : (data.spend.usedPct ?? 0) >= 80 ? "bg-warn" : "bg-accent"}`}
                style={{ width: `${Math.min(100, month.quota ? (month.accepted / month.quota) * 100 : (data.spend.usedPct ?? 0))}%` }}
              />
            </div>
          ) : null}
          <p className="mt-1 text-xs text-muted">{data.spend.budgetUsd > 0 ? (month.quota ? `Of at most ${fmtNum(month.quota)} texts · limit ${fmtUsd(data.spend.budgetUsd)}` : "Spent this month, of your limit") : "No monthly limit set yet: nothing is sent"}</p>
        </div>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="card animate-rise" aria-labelledby="auto-h">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="auto-h" className="font-semibold">
              Your automations
            </h2>
            {automations.length > 0 && (
              <Link className="text-sm text-accent underline-offset-2 hover:underline" href="/messaging/automations">
                View all
              </Link>
            )}
          </div>
          {list.error && !list.data ? (
            <p className="mt-2 text-sm text-muted">Couldn&apos;t load your automations.</p>
          ) : !list.data ? (
            <div className="mt-3 space-y-2">
              <div className="skeleton h-12" />
              <div className="skeleton h-12" />
            </div>
          ) : automations.length === 0 ? (
            <div className="mt-2 space-y-3">
              <p className="text-sm text-muted">Pick what happened, choose who gets the text, write it, test it and switch it on. Start from one of these:</p>
              <ul className="grid gap-2 sm:grid-cols-3">
                {QUICK_STARTS.map((q) => (
                  <li key={q.trigger}>
                    {manage ? (
                      <Link href={`/messaging/automations/edit?trigger=${q.trigger}`} className="flex h-full items-center gap-3 rounded-xl border border-border p-3 transition hover:border-accent/60 hover:bg-accent/5">
                        <q.icon aria-hidden className="h-5 w-5 shrink-0 text-accent" />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{q.label}</span>
                          <span className="block text-xs text-muted">{q.help}</span>
                        </span>
                      </Link>
                    ) : (
                      <span className="flex h-full items-center gap-3 rounded-xl border border-border p-3 opacity-70">
                        <q.icon aria-hidden className="h-5 w-5 shrink-0 text-accent" />
                        <span className="text-sm">{q.label}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {!manage && <p className="text-xs text-muted">Only owners and admins can create automations.</p>}
            </div>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {automations.slice(0, 5).map((a) => {
                const s = AUTOMATION_STATUS[a.status] ?? AUTOMATION_STATUS.draft;
                const sent = a.last30Days.accepted;
                return (
                  <li key={a.id}>
                    <Link href={`/messaging/automations/edit?id=${a.id}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition hover:bg-bg">
                      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <TriggerIcon trigger={a.trigger} className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{a.name}</span>
                        <span className="block truncate text-xs text-muted">{a.triggerLabel ? `When: ${a.triggerLabel.toLowerCase()}` : "Its settings need fixing"}</span>
                      </span>
                      <span className="hidden text-xs tabular-nums text-muted sm:block">{sent ? `${fmtNum(sent)} sent in 30 days` : ""}</span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card animate-rise" aria-labelledby="ready-h">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="ready-h" className="font-semibold">
              Messaging setup
            </h2>
            {missing.length ? <Badge tone="warn">{plural(missing.length, "step")} to finish</Badge> : <Badge tone="good">All set</Badge>}
          </div>
          {missing.length > 0 ? (
            <>
              <ul className="mt-1 divide-y divide-border" aria-label="To finish">
                {missing.map((i) => (
                  <ReadinessRow key={i.key} item={i} manage={manage} />
                ))}
              </ul>
              {done.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-xs text-muted">
                  {done.map((i) => (
                    <span key={i.key} className="inline-flex items-center gap-1">
                      <Check aria-hidden className="h-3 w-3 text-good" strokeWidth={3} />
                      {i.label}
                    </span>
                  ))}
                </p>
              )}
            </>
          ) : (
            <ul className="mt-1 divide-y divide-border" aria-label="Setup">
              {r.items.map((i) => (
                <ReadinessRow key={i.key} item={i} manage={manage} />
              ))}
            </ul>
          )}
        </section>
      </div>

      {(failedWeek > 0 || unsureWeek > 0 || data.pendingApprovals.campaigns > 0 || r.problems.some((p) => p.kind !== "platform" && (p.stops !== "marketing" || sendsMarketing))) && (
        <section className="card animate-rise" aria-labelledby="att-h">
          <h2 id="att-h" className="font-semibold">
            Worth a look
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {r.problems
              .filter((p) => p.kind !== "platform" && (p.stops !== "marketing" || sendsMarketing))
              .map((p) => (
                <li key={p.code} className="flex flex-wrap items-baseline gap-x-2">
                  <span>{p.message}</span>
                  {p.fix && manage && (
                    <Link className="font-medium text-accent underline-offset-2 hover:underline" href={p.fix.href}>
                      {p.fix.label}
                    </Link>
                  )}
                </li>
              ))}
            {failedWeek > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/history?status=failed">
                  {plural(failedWeek, "text")} couldn&apos;t be delivered this week
                </Link>
              </li>
            )}
            {unsureWeek > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/history?status=unknown,uncertain">
                  {plural(unsureWeek, "text")} with no final word from the carrier this week
                </Link>
              </li>
            )}
            {data.pendingApprovals.campaigns > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/campaigns">
                  {plural(data.pendingApprovals.campaigns, "campaign")} waiting for approval
                </Link>
              </li>
            )}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted">
        Every text is checked right before it goes: the customer&apos;s permission, opt-outs, quiet hours and your monthly limit. Times are in {store?.name ?? "your store"}&apos;s time zone ({tz}).
      </p>
    </div>
  );
}
