"use client";
import Link from "next/link";
import { useState } from "react";
import { errorLabel } from "@app/shared/email";
import { Badge } from "@/components/dashboard/primitives";
import { MessageStatusBadge, relative } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction } from "@/components/whatsapp/common";
import { api, useApi } from "@/lib/api";
import { fmtDateTime, useEmail, type RuleView } from "@/lib/email";

interface Execution {
  id: string;
  status: string;
  detail: string | null;
  failureReason: string | null;
  evaluatedAt: string;
  event: { type: string; source: string; occurredAt: string };
  message: { id: string; status: string; recipientMasked: string; lastErrorCode: string | null } | null;
}

const delayText = (m: number) => (m === 0 ? "right away" : m % 1440 === 0 ? `after ${m / 1440} day${m === 1440 ? "" : "s"}` : m % 60 === 0 ? `after ${m / 60} hour${m === 60 ? "" : "s"}` : `after ${m} minutes`);

/** Settings → Email → Automations. */
export default function EmailAutomationsPage() {
  const { base, automate, activity } = useEmail();
  const { data, error, loading, reload } = useApi<{ automations: RuleView[] }>(`${base}/automations`);
  const { busy, run } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [remove, setRemove] = useState<RuleView | null>(null);
  if (error && !data) return <LoadError what="your automations" error={error} onRetry={reload} busy={loading} />;
  if (!data) return <Skeleton lines={4} />;

  const toggle = (r: RuleView) =>
    run(`t-${r.id}`, r.enabled ? "turn the automation off" : "turn the automation on", async () => {
      const res = await api<{ cancelled?: number }>(`${base}/automations/${r.id}/${r.enabled ? "disable" : "enable"}`, { method: "POST" });
      await reload();
      return r.enabled ? `Turned off.${res.cancelled ? ` ${res.cancelled} waiting email${res.cancelled === 1 ? " was" : "s were"} cancelled.` : ""}` : "Turned on. It runs for new events from now.";
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automations"
        sub="When something happens, send an email. Each automation sends at most once per event."
        actions={
          automate && (
            <Link className="btn-primary" href="/settings/email/automations/edit">
              New automation
            </Link>
          )
        }
      />
      {data.automations.length === 0 ? (
        <EmptyState title="No automations yet" body="For example: when an order is paid and its total is over 100, send “Thanks for your order” five minutes later." />
      ) : (
        data.automations.map((r) => (
          <section key={r.id} className="card space-y-2">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {r.name}
                  <Badge tone={r.enabled ? "good" : "neutral"}>{r.enabled ? "On" : "Off"}</Badge>
                  {!r.valid && <Badge tone="danger">Needs editing</Badge>}
                </p>
                <p className="text-sm text-muted">
                  When <b className="text-text">{r.eventLabel}</b>
                  {r.conditions ? <> and {r.conditionsText.toLowerCase()}</> : ""}, send <b className="text-text">{r.template?.name ?? "(missing template)"}</b> from {r.sender?.email ?? "(missing sender)"} to {r.recipient?.type === "fixed" ? r.recipient.address : "the customer"} {delayText(r.delayMinutes)}.
                </p>
                <p className="text-xs text-muted">Last ran {relative(r.lastTriggeredAt)}</p>
              </div>
              {automate && (
                <div className="flex flex-wrap gap-2">
                  <button className={r.enabled ? "btn-secondary" : "btn-primary"} disabled={!!busy} onClick={() => toggle(r)}>
                    {r.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <Link className="btn-secondary" href={`/settings/email/automations/edit?id=${r.id}`}>
                    Edit
                  </Link>
                  <button className="btn-secondary text-danger" disabled={!!busy} onClick={() => setRemove(r)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
            {r.sender && r.sender.status !== "verified" && <Alert kind="info">Its sender address isn&apos;t verified any more, so it can&apos;t send. Choose another sender.</Alert>}
            {activity && (
              <button className="text-sm text-accent underline" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                {open === r.id ? "Hide recent runs" : "Show recent runs"}
              </button>
            )}
            {open === r.id && <Executions ruleId={r.id} />}
          </section>
        ))
      )}
      <ConfirmDialog
        open={!!remove}
        title={`Delete “${remove?.name}”?`}
        confirmLabel="Delete"
        danger
        busy={busy === "delete"}
        onCancel={() => setRemove(null)}
        onConfirm={async () => {
          await run("delete", "delete the automation", async () => {
            await api(`${base}/automations/${remove!.id}`, { method: "DELETE" });
            await reload();
            return "Automation deleted. Emails it had scheduled were cancelled.";
          });
          setRemove(null);
        }}
      >
        <p>Emails it already sent stay in the activity log.</p>
      </ConfirmDialog>
    </div>
  );
}

function Executions({ ruleId }: { ruleId: string }) {
  const { base } = useEmail();
  const { data, error, loading, reload } = useApi<{ executions: Execution[]; nextCursor: string | null }>(`${base}/automations/${ruleId}/executions?limit=25`);
  if (error && !data) return <LoadError what="recent runs" error={error} onRetry={reload} busy={loading} />;
  if (!data) return <Skeleton lines={2} />;
  if (!data.executions.length) return <p className="text-sm text-muted">No events have reached this automation yet.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border text-sm">
      {data.executions.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="w-40 shrink-0 text-xs text-muted">{fmtDateTime(e.evaluatedAt)}</span>
          <span className="min-w-0 flex-1">
            {e.message ? (
              <>
                {e.message.recipientMasked} <MessageStatusBadge status={e.message.status} />
              </>
            ) : (
              <span className="text-muted">{e.detail ?? errorLabel(e.failureReason)}</span>
            )}
          </span>
          <Badge tone={e.status === "scheduled" ? "good" : e.status === "failed" ? "danger" : "neutral"}>{e.status === "scheduled" ? "Sent to queue" : e.status === "skipped" ? "Skipped" : e.status === "suppressed" ? "Suppressed" : e.status === "failed" ? "Couldn't send" : e.status}</Badge>
        </li>
      ))}
    </ul>
  );
}
