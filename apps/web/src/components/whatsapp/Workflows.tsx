"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { TRIGGER_INFO } from "@app/shared/whatsapp";
import { ConfirmDialog, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Stat } from "@/components/dashboard/Primitives";
import { EmptyState } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { fmtDelay, fmtHour, fmtWhen, usePagedList } from "@/components/messaging/MessagingUi";
import { WorkflowBuilder } from "./WorkflowBuilder";
import type { WaOverview, WaRun, WaTemplatesAnswer, WaWorkflow, WaWorkflowsAnswer } from "./types";
import { MessageStatus, Pill, reasonText, useWaAction, waHref, WORKFLOW_STATUS } from "./WaUi";

function timingText(w: Pick<WaWorkflow, "timing" | "sendWindow">) {
  const when = w.timing.mode === "before_event" ? `${fmtDelay(w.timing.minutes)} before the event` : w.timing.minutes ? `${fmtDelay(w.timing.minutes)} after` : "right away";
  return `${when}${w.sendWindow ? `, ${fmtHour(w.sendWindow.start)}–${fmtHour(w.sendWindow.end)}` : ""}`;
}

/** One workflow's results and what happened each time its trigger fired. */
function WorkflowDetail({ base, w, timezone, onBack }: { base: string; w: WaWorkflow; timezone: string; onBack: () => void }) {
  const runs = usePagedList<WaRun>(`${base}/workflows/${w.id}`, "runs");
  const s = w.stats;
  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 font-semibold">
              {w.name} <Pill map={WORKFLOW_STATUS} status={w.status} />
            </h2>
            <p className="mt-1 text-sm text-muted">
              {TRIGGER_INFO[w.trigger].label}
              {w.eventName ? ` "${w.eventName}"` : ""} → {w.template.name} · {timingText(w)}
            </p>
            {w.conditionsText.length > 0 && <p className="mt-1 text-xs text-muted">Only if: {w.conditionsText.join("; ")}</p>}
          </div>
          <button type="button" className="btn-secondary" onClick={onBack}>
            Back to workflows
          </button>
        </div>
      </section>
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Sent (30 days)" value={fmtNum(s.sent + s.delivered)} />
          <Stat label="Delivered" value={fmtNum(s.delivered)} tone={s.delivered ? "good" : undefined} note={s.read ? `${fmtNum(s.read)} read` : undefined} />
          <Stat label="Failed" value={fmtNum(s.failed)} tone={s.failed ? "danger" : undefined} />
          <Stat label="Not sent" value={fmtNum(s.skipped + s.cancelled)} note={s.waiting ? `${fmtNum(s.waiting)} waiting` : "Conditions, consent, no number…"} />
        </div>
      )}
      <section className="card animate-rise" aria-labelledby="wf-runs-h">
        <h3 id="wf-runs-h" className="font-semibold">
          History
        </h3>
        <p className="text-sm text-muted">Each time the trigger fired, and what came of it.</p>
        {runs.error ? (
          <LoadError what="the workflow's history" error={runs.error} onRetry={() => void runs.reload()} busy={runs.loading} />
        ) : !runs.rows ? (
          <p className="mt-2 text-sm text-muted">Loading…</p>
        ) : !runs.rows.length ? (
          <p className="mt-2 text-sm text-muted">Nothing yet. It runs for every new {TRIGGER_INFO[w.trigger].label.toLowerCase()} while it&apos;s on.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">For</th>
                  <th className="py-2 pr-3 font-medium">What happened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap py-2 pr-3 text-muted">{fmtWhen(r.at, timezone)}</td>
                    <td className="py-2 pr-3">{r.subject ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {r.message ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <MessageStatus m={r.message} /> <span className="text-xs text-muted">{r.message.errorTitle ?? reasonText(r.message.reason) ?? ""}</span>
                        </span>
                      ) : (
                        <span className="text-muted">Not sent: {reasonText(r.reason?.split(":")[0]) ?? r.reason ?? r.outcome}{r.reason?.includes(":") ? ` (${r.reason.slice(r.reason.indexOf(":") + 1).trim()})` : ""}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {runs.cursor && (
              <button type="button" className="btn-secondary mt-3" onClick={runs.loadMore} disabled={runs.loading}>
                {runs.loading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** The store's workflows: what each does, how it went, and building new ones. */
export function Workflows({ base, overview }: { base: string; overview: WaOverview }) {
  const router = useRouter();
  const params = useSearchParams();
  const view = params.get("workflow");
  const edit = params.get("edit");
  const preset = params.get("preset");
  const { data, error, loading, reload } = useApi<WaWorkflowsAnswer>(`${base}/workflows`);
  const templates = useApi<WaTemplatesAnswer>(`${base}/templates`);
  const { busy, run } = useWaAction();
  const [deleting, setDeleting] = useState<WaWorkflow | null>(null);
  const can = overview.can;
  const go = (extra: Record<string, string>) => router.push(waHref("workflows", extra));

  if (error || templates.error)
    return (
      <LoadError
        what="your workflows"
        error={error ?? templates.error}
        onRetry={() => {
          void reload();
          void templates.reload();
        }}
        busy={loading || templates.loading}
      />
    );
  if (!data || !templates.data) return <Skeleton lines={5} />;

  if (edit && can.manage) {
    const editing = edit === "new" ? null : (data.workflows.find((w) => w.id === edit) ?? null);
    return (
      <WorkflowBuilder
        key={edit}
        base={base}
        meta={data}
        templates={templates.data.templates}
        starters={templates.data.starters}
        editing={editing}
        presetKey={preset}
        onCancel={() => go({})}
        onDone={(w) => {
          void reload();
          go({ workflow: w.id });
        }}
      />
    );
  }
  const shown = view ? data.workflows.find((w) => w.id === view) : null;
  if (shown) return <WorkflowDetail base={base} w={shown} timezone={overview.store.timezone} onBack={() => go({})} />;

  const toggle = (w: WaWorkflow) =>
    run(`toggle:${w.id}`, w.status === "active" ? "pause the workflow" : "switch on the workflow", async () => {
      if (w.status === "active") {
        const r = await api<{ cancelled: number }>(`${base}/workflows/${w.id}/pause`, { method: "POST", body: {} });
        await reload();
        return `"${w.name}" is paused.${r.cancelled ? ` ${r.cancelled} waiting message${r.cancelled === 1 ? " was" : "s were"} cancelled.` : ""}`;
      }
      await api(`${base}/workflows/${w.id}/activate`, { method: "POST", body: {} });
      await reload();
      return `"${w.name}" is on.`;
    });
  const test = (w: WaWorkflow) =>
    run(`test:${w.id}`, "send the test", async () => {
      await api(`${base}/workflows/${w.id}/test`, { method: "POST", body: {} });
      return "Test sent to your own number with sample values.";
    });

  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <h2 className="font-semibold">Automated workflows</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          A workflow sends an approved template when something happens in your store: a new order, a shipment, an abandoned checkout, a booking. It runs once per order or event, and checks each
          customer&apos;s consent right before sending.
        </p>
        {can.manage && (
          <div className="mt-4">
            <p className="label">Start from</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.presets.map((p) => (
                <button key={p.key} type="button" className="lift rounded-lg border border-border bg-surface p-3 text-left hover:border-accent" onClick={() => go({ edit: "new", preset: p.key })}>
                  <p className="text-sm font-semibold">{p.title}</p>
                  <p className="mt-1 text-xs text-muted">{p.description}</p>
                </button>
              ))}
              <button type="button" className="rounded-lg border border-dashed border-border p-3 text-left hover:border-accent" onClick={() => go({ edit: "new" })}>
                <p className="text-sm font-semibold">Build your own</p>
                <p className="mt-1 text-xs text-muted">Any trigger, conditions and template.</p>
              </button>
            </div>
          </div>
        )}
      </section>
      {!data.workflows.length ? (
        <EmptyState title="No workflows yet" body={can.manage ? "Pick one of the starting points above: an order confirmation is a good first one." : "An owner or admin can set them up."} />
      ) : (
        <div className="space-y-3">
          {data.workflows.map((w) => (
            <article key={w.id} className="card animate-rise" data-testid="wa-workflow">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex flex-wrap items-center gap-2 font-semibold">
                    {w.name} <Pill map={WORKFLOW_STATUS} status={w.status} />
                  </h3>
                  <p className="mt-1 text-sm text-muted">
                    When {TRIGGER_INFO[w.trigger].label.toLowerCase()}
                    {w.eventName ? ` "${w.eventName}"` : ""}
                    {w.conditionsText.length ? ` and ${w.conditionsText.join(" and ").toLowerCase()}` : ""}, send {w.template.name} {timingText(w)}.
                  </p>
                  {w.stats && (
                    <p className="mt-1 text-xs text-muted">
                      Last 30 days: {fmtNum(w.stats.sent + w.stats.delivered)} sent · {fmtNum(w.stats.delivered)} delivered · {fmtNum(w.stats.failed)} failed · {fmtNum(w.stats.skipped)} not sent
                      {w.lastRunAt ? ` · last ran ${fmtWhen(w.lastRunAt, overview.store.timezone)}` : ""}
                    </p>
                  )}
                  {w.status !== "active" && w.problems.length > 0 && <p className="mt-1 text-xs text-warn">To switch it on: {w.problems[0]}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => go({ workflow: w.id })}>
                    History
                  </button>
                  {can.manage && (
                    <>
                      <button type="button" className={w.status === "active" ? "btn-secondary h-8 px-3 text-xs" : "btn-primary h-8 px-3 text-xs"} onClick={() => void toggle(w)} disabled={busy === `toggle:${w.id}`}>
                        {w.status === "active" ? "Pause" : "Switch on"}
                      </button>
                      <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => go({ edit: w.id })}>
                        Edit
                      </button>
                      <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void test(w)} disabled={busy === `test:${w.id}`}>
                        Test
                      </button>
                      <button type="button" className="btn-secondary h-8 px-3 text-xs text-danger" onClick={() => setDeleting(w)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete workflow"
        danger
        busy={busy === "delete"}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void run("delete", "delete the workflow", async () => {
            await api(`${base}/workflows/${deleting!.id}`, { method: "DELETE" });
            setDeleting(null);
            await reload();
            return "Workflow deleted. Messages it was still waiting to send were cancelled; those already sent stay in the history.";
          })
        }
      >
        <p>Messages it was still waiting to send are cancelled. Those already sent stay in the message history.</p>
      </ConfirmDialog>
    </div>
  );
}
