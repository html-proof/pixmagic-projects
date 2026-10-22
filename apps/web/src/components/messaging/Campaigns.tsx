"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SMS_STATUS_LABEL, SMS_STATUSES, smsCampaignCan, smsCampaignEditable, type SmsCampaignAction } from "@app/shared/sms";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Empty } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { ApiError, api, fmtNum, useApi } from "@/lib/api";
import { CampaignEditor } from "./CampaignEditor";
import { CAMPAIGN_STATUS, fmtUsd, fmtWhen, ModeBanner, smsError, StatusPill, useSms, useSmsAction } from "./MessagingUi";
import type { CampaignEstimate, SmsCampaign, SmsOverview, SmsSegment, SmsTemplate } from "./types";

/** "2026-10-22T09:30" in the browser's own zone, for datetime-local inputs. */
const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Schedule a campaign: the exact number of customers is counted now and typed back to confirm it. */
function ScheduleDialog({ c, onClose }: { c: SmsCampaign; onClose: (done: boolean) => void }) {
  const { base, store } = useSms();
  const toast = useToast();
  const [estimate, setEstimate] = useState<CampaignEstimate | null>(null);
  const [typed, setTyped] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ estimate: CampaignEstimate | null }>(`${base}/campaigns/${c.id}`)
      .then((r) => (r.estimate ? setEstimate(r.estimate) : setError("This campaign can't be counted any more. Reload the page.")))
      .catch((e) => setError(smsError(e, "count the customers")));
  }, [base, c.id]);
  const count = estimate?.recipients ?? null;
  const matches = count !== null && typed.trim() !== "" && Number(typed) === count;
  const confirm = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/campaigns/${c.id}/schedule`, { method: "POST", body: { confirmRecipients: count, ...(when ? { scheduledAt: new Date(when).toISOString() } : {}) } });
      toast("success", `Scheduled for ${fmtNum(count)} customers${when ? `, starting ${fmtWhen(new Date(when).toISOString(), store?.timezone)}` : ", starting within 15 minutes"}.`);
      onClose(true);
    } catch (e) {
      const fresh = e instanceof ApiError && e.code === "recipients_changed" ? (e.data.detail as { recipients?: number } | undefined)?.recipients : undefined;
      if (typeof fresh === "number") {
        setEstimate((prev) => (prev ? { ...prev, recipients: fresh } : prev));
        setTyped("");
        setError(`The audience changed while you were looking: it is now ${fmtNum(fresh)} customers. Type the new number to confirm.`);
      } else setError(smsError(e, "schedule the campaign"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      title={`Schedule “${c.name}”?`}
      confirmLabel={count === null ? "Counting…" : `Send to ${fmtNum(count)} customers`}
      busy={busy}
      confirmDisabled={!matches}
      onCancel={() => onClose(false)}
      onConfirm={() => void confirm()}
    >
      {error && <Alert>{error}</Alert>}
      {estimate ? (
        <>
          <p>
            It goes to <strong className="text-text">{fmtNum(estimate.recipients)}</strong> customer{estimate.recipients === 1 ? "" : "s"} subscribed to your SMS marketing, {estimate.partsPerText} part
            {estimate.partsPerText === 1 ? "" : "s"} each. Expected cost{" "}
            <strong className="text-text">{estimate.recipients - estimate.unpricedRecipients > 0 ? fmtUsd(estimate.estimatedCostUsd) : "—"}</strong>
            {estimate.unpricedRecipients ? `, plus ${fmtNum(estimate.unpricedRecipients)} in countries without a price yet` : ""}. It can&apos;t start if it could go over this month&apos;s budget.
          </p>
          <div>
            <label className="label text-text" htmlFor="sched-count">
              Type {fmtNum(estimate.recipients)} to confirm the number of customers
            </label>
            {/* The dialog opened while counting, before this field existed: it takes the focus when it appears. */}
            <input id="sched-count" className="input text-text" inputMode="numeric" autoComplete="off" autoFocus value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div>
            <label className="label text-text" htmlFor="sched-when">
              Start (optional)
            </label>
            <input id="sched-when" className="input text-text" type="datetime-local" min={localInput(new Date())} value={when} onChange={(e) => setWhen(e.target.value)} />
            <p className="mt-1 text-xs">Your computer&apos;s time. Empty: it starts within 15 minutes. Texts are paced, and anyone who opts out before theirs goes is skipped.</p>
          </div>
        </>
      ) : (
        !error && <p>Counting the customers…</p>
      )}
    </ConfirmDialog>
  );
}

const DONE: Record<SmsCampaignAction, string> = {
  submit: "Sent for approval.",
  approve: "Approved. Schedule it when you're ready.",
  reject: "Sent back to draft.",
  schedule: "Scheduled.",
  pause: "Paused.",
  resume: "Resumed.",
  cancel: "Cancelled: nothing more is sent.",
};

/** Campaigns: one marketing text to an audience, written, approved, then scheduled with the exact count confirmed. */
export function SmsCampaigns() {
  const { base, manage, store } = useSms();
  const campaigns = useApi<{ campaigns: SmsCampaign[] }>(base ? `${base}/campaigns` : null);
  const templates = useApi<{ templates: SmsTemplate[] }>(base ? `${base}/templates` : null);
  const segments = useApi<{ segments: SmsSegment[] }>(base ? `${base}/segments` : null);
  const overview = useApi<SmsOverview>(base);
  const [editing, setEditing] = useState<{ campaign: SmsCampaign | null; key: number } | null>(null);
  const [scheduling, setScheduling] = useState<SmsCampaign | null>(null);
  const [cancelling, setCancelling] = useState<SmsCampaign | null>(null);
  const { busy, run } = useSmsAction();
  const error = campaigns.error ?? templates.error ?? segments.error ?? overview.error;
  if (error) return <LoadError what="your campaigns" error={error} onRetry={() => void Promise.all([campaigns.reload(), templates.reload(), segments.reload(), overview.reload()])} />;
  if (!campaigns.data || !templates.data || !segments.data || !overview.data) return <Skeleton lines={5} />;
  const o = overview.data;
  const names = new Map(templates.data.templates.map((t) => [t.id, t.name]));
  const segmentNames = new Map(segments.data.segments.map((s) => [s.id, s.name]));
  const act = (c: SmsCampaign, action: SmsCampaignAction) =>
    run(`${c.id}:${action}`, `${action} the campaign`, async () => {
      await api(`${base}/campaigns/${c.id}/${action}`, { method: "POST", body: {} });
      await campaigns.reload();
      return DONE[action];
    });
  const button = (c: SmsCampaign, action: SmsCampaignAction, label: string, primary = false) =>
    smsCampaignCan(c.status, action) ? (
      <button type="button" className={`${primary ? "btn-primary" : "btn-secondary"} h-8 px-3 text-xs`} disabled={!!busy} onClick={() => void act(c, action)}>
        {busy === `${c.id}:${action}` ? "Working…" : label}
      </button>
    ) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campaigns"
        sub="One marketing text to an audience you choose, such as a sale. Nothing goes out because a date comes near: you write it, an owner or admin approves it, and then you schedule it, confirming the exact number of customers. Only customers subscribed to your SMS marketing in Shopify who haven't opted out are ever texted."
        actions={
          manage && !editing ? (
            <button type="button" className="btn-primary" onClick={() => setEditing({ campaign: null, key: Date.now() })}>
              New campaign
            </button>
          ) : undefined
        }
      />
      <ModeBanner mode={o.mode} />
      {!o.marketingSwitch && <Alert kind="info">Marketing texts aren&apos;t switched on for bizinsights yet. You can write and approve campaigns, but none can be scheduled until they are.</Alert>}
      {o.marketingSwitch && !o.sender?.marketingEnabled && (
        <Alert kind="info">
          Marketing texts are off for this store. Turn them on in{" "}
          <Link className="underline" href="/messaging/sender">
            Sender Configuration
          </Link>{" "}
          before scheduling a campaign.
        </Alert>
      )}

      {editing && (
        <CampaignEditor
          key={editing.key}
          campaign={editing.campaign}
          templates={templates.data.templates}
          segments={segments.data.segments}
          onDone={(saved) => {
            setEditing(null);
            if (saved) void campaigns.reload();
          }}
        />
      )}

      {!campaigns.data.campaigns.length ? (
        !editing && <Empty>No campaigns yet.</Empty>
      ) : (
        <ul className="space-y-3">
          {campaigns.data.campaigns.map((c) => {
            const m = c.metrics;
            const counts = m ? SMS_STATUSES.filter((s) => (m.counts[s] ?? 0) > 0) : [];
            return (
              <li key={c.id} className="card animate-rise">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {c.name} <StatusPill map={CAMPAIGN_STATUS} status={c.status} />
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      “{names.get(c.templateId) ?? "Template"}” · {c.segmentId ? (segmentNames.get(c.segmentId) ?? "a segment") : (c.audience ?? "custom audience")}
                      {c.discountCode ? ` · code ${c.discountCode}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {c.scheduledAt ? `${c.startedAt ? "Started" : "Starts"} ${fmtWhen(c.startedAt ?? c.scheduledAt, store?.timezone)}` : `Created ${fmtWhen(c.createdAt, store?.timezone)}`}
                      {c.confirmedRecipients !== null ? ` · ${fmtNum(c.confirmedRecipients)} confirmed customers` : c.estimatedRecipients !== null ? ` · about ${fmtNum(c.estimatedRecipients)} customers when last counted` : ""}
                      {!m && c.estimatedCostUsd !== null ? ` · expected cost ${fmtUsd(c.estimatedCostUsd)} (estimate)` : ""}
                      {c.completedAt ? ` · finished ${fmtWhen(c.completedAt, store?.timezone)}` : ""}
                    </p>
                  </div>
                  {manage && (
                    <div className="flex flex-wrap gap-2">
                      {smsCampaignEditable(c.status) && (
                        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setEditing({ campaign: c, key: Date.now() })}>
                          Edit
                        </button>
                      )}
                      {button(c, "submit", "Submit for approval")}
                      {button(c, "approve", "Approve", true)}
                      {button(c, "reject", "Send back")}
                      {smsCampaignCan(c.status, "schedule") && (
                        <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={!!busy} onClick={() => setScheduling(c)}>
                          Schedule…
                        </button>
                      )}
                      {button(c, "pause", "Pause")}
                      {button(c, "resume", "Resume", true)}
                      {smsCampaignCan(c.status, "cancel") && (
                        <button type="button" className="btn-danger h-8 px-3 text-xs" disabled={!!busy} onClick={() => setCancelling(c)}>
                          Cancel campaign…
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {m && (
                  <div className="mt-3 border-t border-border pt-3">
                    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <div>
                        <dt className="text-xs text-muted">Cost (billed by AWS)</dt>
                        <dd className="font-medium tabular-nums">{fmtUsd(m.costUsd)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Orders that followed</dt>
                        <dd className="font-medium tabular-nums">{fmtNum(m.attributedOrders)}</dd>
                      </div>
                    </dl>
                    {counts.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        {counts.map((s) => (
                          <li key={s}>
                            {SMS_STATUS_LABEL[s]}: <span className="font-medium text-text tabular-nums">{fmtNum(m.counts[s])}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted">
        &ldquo;Orders that followed&rdquo; counts an order once, for the last text its customer received within the campaign&apos;s attribution window. It shows what followed a text, not that the text
        caused it. Revenue by currency is in{" "}
        <Link className="text-accent underline" href="/messaging/analytics">
          Delivery Analytics
        </Link>
        .
      </p>

      {scheduling && (
        <ScheduleDialog
          c={scheduling}
          onClose={(done) => {
            setScheduling(null);
            if (done) void campaigns.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={!!cancelling}
        title={`Cancel “${cancelling?.name ?? ""}”?`}
        confirmLabel="Cancel campaign"
        danger
        busy={!!busy}
        onCancel={() => setCancelling(null)}
        onConfirm={() => void act(cancelling!, "cancel").then(() => setCancelling(null))}
      >
        <p>Texts not yet sent won&apos;t be. Texts already sent can&apos;t be called back. A cancelled campaign can&apos;t be restarted.</p>
      </ConfirmDialog>
    </div>
  );
}
