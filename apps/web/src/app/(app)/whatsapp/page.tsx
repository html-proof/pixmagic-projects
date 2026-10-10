"use client";
import Link from "next/link";
import { KIND_INFO, type NotificationKind } from "@app/shared/whatsapp";
import { Badge, Stat } from "@/components/dashboard/primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { fmtNum, fmtPct, useApi } from "@/lib/api";
import { LoadError } from "@/components/LoadError";
import { fmtWhen, Skeleton, useWa, WhatsappIcon } from "@/components/whatsapp/common";
import { connectionStatus, quality, tier, type Overview } from "@/components/whatsapp/types";

function Step({ done, children, href }: { done: boolean; children: React.ReactNode; href?: string }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-good text-white" : "border border-border text-muted"}`}>
        {done ? "✓" : ""}
      </span>
      <span className={`text-sm ${done ? "text-muted line-through decoration-border" : ""}`}>
        <span className="sr-only">{done ? "Done: " : "To do: "}</span>
        {href && !done ? (
          <Link className="text-accent underline-offset-2 hover:underline" href={href}>
            {children}
          </Link>
        ) : (
          children
        )}
      </span>
    </li>
  );
}

export default function WhatsappOverview() {
  const { base } = useWa();
  const { data, error, reload } = useApi<Overview>(base);
  if (error) return <LoadError what="WhatsApp" error={error} onRetry={() => void reload()} />;
  if (!data) return <Skeleton lines={6} />;
  const c = data.connection;
  const status = connectionStatus(c);
  const s = data.last7Days;
  const on = data.notifications.filter((n) => n.enabled);
  const a = data.attention;
  const attention = a.failed.length + a.pendingTemplates + a.rejectedTemplates + a.problems.length + a.pendingReviews;

  return (
    <div className="space-y-4">
      <section className="card animate-rise" aria-labelledby="wa-h">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-white">
              <WhatsappIcon size={28} />
            </span>
            <div className="min-w-0">
              <h1 id="wa-h" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                WhatsApp for {data.store.name} <Badge tone={status.tone}>{status.label}</Badge>
              </h1>
              {c ? (
                <p className="text-sm text-muted">
                  {c.verifiedName ?? "Your business"} · {c.displayPhoneNumber ?? c.phoneNumberId}
                  {c.lastSyncedAt ? ` · checked ${fmtRelative(c.lastSyncedAt)}` : ""}
                </p>
              ) : (
                <p className="text-sm text-muted">Order updates, delivery updates, cart reminders, reviews and campaigns, sent from your own WhatsApp Business number.</p>
              )}
            </div>
          </div>
          {!c ? (
            <Link href="/whatsapp/connect" className="btn-primary">
              Connect WhatsApp Business
            </Link>
          ) : c.status === "reconnect" ? (
            <Link href="/whatsapp/connect" className="btn-primary">
              Reconnect
            </Link>
          ) : (
            <Link href="/whatsapp/connect" className="btn-secondary">
              Connection details
            </Link>
          )}
        </div>
        {c && (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Quality rating</dt>
              <dd>{quality(c.qualityRating)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Messaging limit</dt>
              <dd>{tier(c.messagingLimitTier)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Approved templates</dt>
              <dd>{data.setup.approvedTemplates}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last webhook from Meta</dt>
              <dd>{c.lastWebhookAt ? fmtRelative(c.lastWebhookAt) : "None yet"}</dd>
            </div>
          </dl>
        )}
        {c?.lastError && c.status !== "active" && <p className="mt-3 rounded-lg border border-danger px-3 py-2 text-sm text-danger">{c.lastError}</p>}
      </section>

      {(!data.setup.connected || !data.setup.registered || !data.setup.webhookVerified || data.setup.consentBasis === "none" || data.setup.notificationsReady === 0) && (
        <section className="card animate-rise" aria-labelledby="setup-h" style={{ ["--i" as string]: 1 }}>
          <h2 id="setup-h" className="font-semibold">
            Finish setting up
          </h2>
          <p className="text-sm text-muted">Nothing is sent to customers until each step is done.</p>
          <ol className="mt-2 divide-y divide-border">
            <Step done={data.setup.connected} href="/whatsapp/connect">
              Connect your WhatsApp Business number
            </Step>
            <Step done={data.setup.registered} href="/whatsapp/connect">
              Register the number with WhatsApp&apos;s Cloud API
            </Step>
            <Step done={data.setup.webhookVerified} href="/whatsapp/connect">
              Let Meta reach Insights (webhook), so delivery reports and STOP replies arrive
            </Step>
            <Step done={data.setup.consentBasis !== "none"} href="/whatsapp/settings">
              Choose how customers agree to WhatsApp order updates
            </Step>
            <Step done={data.setup.notificationsReady > 0} href="/whatsapp/orders">
              Turn on a notification with an approved template
            </Step>
          </ol>
        </section>
      )}

      <section aria-label="Last 7 days" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sent (7 days)" value={fmtNum(s.sent)} note={data.scheduled ? `${fmtNum(data.scheduled)} scheduled` : "None waiting"} />
        <Stat label="Delivered" value={fmtNum(s.delivered)} note={s.sent ? `${fmtPct(s.delivered / s.sent)} of sent` : "—"} tone={s.sent ? "good" : undefined} />
        <Stat label="Read" value={fmtNum(s.read)} note={s.delivered ? `${fmtPct(s.read / s.delivered)} of delivered · when customers share read receipts` : "Shown when customers share read receipts"} />
        <Stat label="Failed" value={fmtNum(s.failed)} note={s.skipped ? `${fmtNum(s.skipped)} not sent (consent, opt-out…)` : "—"} tone={s.failed ? "danger" : undefined} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card animate-rise" aria-labelledby="on-h">
          <div className="flex items-center justify-between gap-2">
            <h2 id="on-h" className="font-semibold">
              What&apos;s switched on
            </h2>
            <Link className="text-sm text-accent underline-offset-2 hover:underline" href="/whatsapp/automations">
              {data.automationsEnabled} automation{data.automationsEnabled === 1 ? "" : "s"} on
            </Link>
          </div>
          {on.length ? (
            <ul className="mt-2 divide-y divide-border text-sm">
              {on.map((n) => (
                <li key={n.kind} className="flex items-center justify-between gap-2 py-2">
                  <span>{KIND_INFO[n.kind].label}</span>
                  <Badge tone={n.check.state === "ready" ? "good" : n.check.state === "pending" ? "neutral" : "warn"}>{n.check.state === "ready" ? "Ready" : n.check.state === "pending" ? "Template in review" : "Needs attention"}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">
              No notifications are on yet. Start with{" "}
              <Link className="text-accent underline" href="/whatsapp/orders">
                order notifications
              </Link>
              .
            </p>
          )}
        </section>

        <section className="card animate-rise" aria-labelledby="att-h">
          <h2 id="att-h" className="font-semibold">
            Needs attention {attention ? <Badge tone="warn">{attention}</Badge> : null}
          </h2>
          {!attention && !a.campaigns.length && !a.openCarts ? <p className="mt-2 text-sm text-muted">Nothing right now.</p> : null}
          <ul className="mt-2 space-y-2 text-sm">
            {a.problems.map((p) => (
              <li key={p.kind}>
                <span className="font-medium">{KIND_INFO[p.kind].label}:</span> <span className="text-warn">{p.problem}</span>
              </li>
            ))}
            {a.failed.length > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/whatsapp/messages?status=failed">
                  {a.failed.length} failed message{a.failed.length === 1 ? "" : "s"} this week
                </Link>
                <ul className="mt-1 space-y-1 text-xs text-muted">
                  {a.failed.slice(0, 3).map((f) => (
                    <li key={f.id}>
                      {fmtWhen(f.createdAt, data.store.timezone)} · {f.orderName ?? KIND_INFO[f.kind as NotificationKind]?.label ?? f.kind} · {f.errorTitle ?? "failed"}
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {a.pendingTemplates > 0 && <li>{a.pendingTemplates} template{a.pendingTemplates === 1 ? " is" : "s are"} waiting for Meta&apos;s review.</li>}
            {a.rejectedTemplates > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/whatsapp/templates">
                  {a.rejectedTemplates} template{a.rejectedTemplates === 1 ? " was" : "s were"} rejected or paused
                </Link>
              </li>
            )}
            {a.pendingReviews > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/whatsapp/reviews">
                  {a.pendingReviews} review{a.pendingReviews === 1 ? "" : "s"} to moderate
                </Link>
              </li>
            )}
            {a.openCarts > 0 && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href="/whatsapp/carts">
                  {a.openCarts} unfinished checkout{a.openCarts === 1 ? "" : "s"} with a WhatsApp number
                </Link>
              </li>
            )}
            {a.campaigns.map((cmp) => (
              <li key={cmp.id}>
                <Link className="text-accent underline-offset-2 hover:underline" href="/whatsapp/campaigns">
                  Campaign &ldquo;{cmp.name}&rdquo;
                </Link>{" "}
                <Badge tone={cmp.status === "paused" ? "warn" : "neutral"}>{cmp.status}</Badge> {cmp.status === "scheduled" ? `starts ${fmtWhen(cmp.startAt, data.store.timezone)}` : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
