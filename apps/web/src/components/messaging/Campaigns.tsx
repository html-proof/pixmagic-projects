"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SMS_STATUS_LABEL, SMS_STATUSES, smsCampaignCan, smsCampaignEditable, type SmsCampaignAction } from "@app/shared/sms";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Chip, FootLine, TableCard } from "@/components/automations/MarketingKit";
import { Empty } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { ApiError, api, fmtNum, useApi } from "@/lib/api";
import { CampaignEditor } from "./CampaignEditor";
import { CAMPAIGN_STATUS, fmtUsd, fmtWhen, ModeBanner, smsError, StatusPill, useSms, useSmsAction } from "./MessagingUi";
import type { CampaignEstimate, SmsCampaign, SmsOverview, SmsSegment, SmsTemplate } from "./types";

// ---------------------------------------------------------------------------
// SMS campaigns, as the Stitch design's screen 15 draws them: the campaigns as rows of a table
// (name, channel, status, date, then delivered, orders that followed and cost, which only SMS
// reports), and under them the one being written, in numbered steps (./CampaignEditor.tsx). Every
// figure is the campaign's own (its metrics, once texts went out); a campaign that hasn't sent
// shows a dash, never a zero. Approval and the typed count stay exactly as they work.
// ---------------------------------------------------------------------------

/** The rows' columns from a laptop up (one grid for the head row and every row); a phone stacks each row. */
const COLUMNS = "xl:grid-cols-[minmax(0,2.4fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.2fr)] xl:items-center xl:gap-4";

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
            SMS Sender
          </Link>{" "}
          before scheduling a campaign.
        </Alert>
      )}

      {!campaigns.data.campaigns.length ? (
        !editing && <Empty>No campaigns yet.</Empty>
      ) : (
        <TableCard id="campaigns" title="Your campaigns" aside="Newest first. Delivered, orders that followed and cost are counted once texts go out.">
          {/* The design's head row, for the eye: each row says the same in words. */}
          <div aria-hidden className={`hidden bg-home-soft px-6 py-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase xl:grid ${COLUMNS}`}>
            <span>Name</span>
            <span>Channel</span>
            <span>Status</span>
            <span>Date</span>
            <span className="text-right">Customers</span>
            <span className="text-right">Delivered</span>
            <span className="text-right">Orders that followed</span>
            <span className="text-right">Cost</span>
          </div>
          <ul className="divide-y divide-home-line border-t border-home-line xl:border-t-0" aria-label="Campaigns">
            {campaigns.data.campaigns.map((c) => {
              const m = c.metrics;
              const counts = m ? SMS_STATUSES.filter((s) => (m.counts[s] ?? 0) > 0) : [];
              const customers = c.confirmedRecipients !== null ? fmtNum(c.confirmedRecipients) : c.estimatedRecipients !== null ? `about ${fmtNum(c.estimatedRecipients)}` : "—";
              const figure = (label: string, value: string) => (
                <p className="flex items-baseline justify-between gap-2 text-sm tabular-nums xl:block xl:text-right">
                  <span className="text-xs text-muted xl:sr-only">{label}</span>
                  <span className={value === "—" ? "text-muted" : "font-medium"}>{value}</span>
                </p>
              );
              return (
                <li key={c.id} className="px-5 py-4 sm:px-6" aria-label={c.name}>
                  <div className={`grid gap-2 ${COLUMNS}`}>
                    <div className="min-w-0">
                      <p className="font-semibold">{c.name}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        “{names.get(c.templateId) ?? "Template"}” · {c.segmentId ? (segmentNames.get(c.segmentId) ?? "a segment") : (c.audience ?? "custom audience")}
                        {c.discountCode ? ` · code ${c.discountCode}` : ""}
                      </p>
                    </div>
                    <p>
                      <Chip>SMS</Chip>
                    </p>
                    <p>
                      <StatusPill map={CAMPAIGN_STATUS} status={c.status} />
                    </p>
                    <p className="text-xs text-muted xl:text-sm xl:text-text">
                      {c.scheduledAt ? `${c.startedAt ? "Started" : "Starts"} ${fmtWhen(c.startedAt ?? c.scheduledAt, store?.timezone)}` : `Created ${fmtWhen(c.createdAt, store?.timezone)}`}
                      {c.completedAt ? <span className="block text-xs text-muted">Finished {fmtWhen(c.completedAt, store?.timezone)}</span> : null}
                    </p>
                    {figure(c.confirmedRecipients !== null ? "Confirmed customers" : "Customers when last counted", customers)}
                    {figure("Delivered", m ? fmtNum(m.counts.delivered ?? 0) : "—")}
                    {figure("Orders that followed", m ? fmtNum(m.attributedOrders) : "—")}
                    {figure(m ? "Cost (billed by AWS)" : "Expected cost (estimate)", m ? fmtUsd(m.costUsd) : c.estimatedCostUsd !== null ? `${fmtUsd(c.estimatedCostUsd)} (estimate)` : "—")}
                  </div>
                  {(counts.length > 0 || manage) && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                      {counts.length > 0 ? (
                        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label={`${c.name}: texts by status`}>
                          {counts.map((s) => (
                            <li key={s}>
                              {SMS_STATUS_LABEL[s]}: <span className="font-medium text-text tabular-nums">{fmtNum(m!.counts[s])}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span />
                      )}
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
                  )}
                </li>
              );
            })}
          </ul>
        </TableCard>
      )}

      {/* The design's screen 15: the campaigns first, then the one being written, in numbered steps. */}
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
      <FootLine>
        &ldquo;Orders that followed&rdquo; counts an order once, for the last text its customer received within the campaign&apos;s attribution window. It shows what followed a text, not that the text
        caused it. Revenue by currency is in{" "}
        <Link className="text-accent underline" href="/messaging/analytics">
          Delivery Analytics
        </Link>
        .
      </FootLine>

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
