"use client";
import Link from "next/link";
import { useState } from "react";
import { TRIGGER_INFO } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, Empty } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtDelay, fmtWhen, RULE_STATUS, sendable, StatusPill, useSms } from "./MessagingUi";
import { RuleEditor } from "./RuleEditor";
import type { SmsRule, SmsTemplate } from "./types";

/** Automated Workflows: when something happens in Shopify, text the customer, once approved. */
export function AutomatedWorkflows() {
  const { base, manage, store } = useSms();
  const rules = useApi<{ rules: SmsRule[] }>(base ? `${base}/rules` : null);
  const templates = useApi<{ templates: SmsTemplate[] }>(base ? `${base}/templates` : null);
  const [open, setOpen] = useState<{ id: string | null; key: number } | null>(null);
  const error = rules.error ?? templates.error;
  if (error) return <LoadError what="your workflows" error={error} onRetry={() => void Promise.all([rules.reload(), templates.reload()])} />;
  if (!rules.data || !templates.data) return <Skeleton lines={5} />;
  const names = new Map(templates.data.templates.map((t) => [t.id, t.name]));
  const anyApproved = templates.data.templates.some(sendable);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automated Workflows"
        sub="When something happens in Shopify (an order ships, a checkout is left behind), wait if you like, then send an approved template. A workflow runs only once an owner or admin approved it, starts as a dry run that sends nothing, and an edit waits for approval while the approved version keeps running."
        actions={
          manage && !open ? (
            <button type="button" className="btn-primary" onClick={() => setOpen({ id: null, key: Date.now() })}>
              New workflow
            </button>
          ) : undefined
        }
      />
      {!anyApproved && (
        <Alert kind="info">
          A workflow sends an approved template. Write one and get it approved in{" "}
          <Link className="underline" href="/messaging/templates">
            Message Templates
          </Link>{" "}
          first.
        </Alert>
      )}
      {open && <RuleEditor key={open.key} id={open.id} templates={templates.data.templates} onClose={() => setOpen(null)} onChanged={() => void rules.reload()} />}

      {!rules.data.rules.length ? (
        !open && <Empty>No workflows yet. A good first one: &ldquo;Order shipped&rdquo; with the tracking link.</Empty>
      ) : (
        <ul className="space-y-3">
          {rules.data.rules.map((r) => {
            const running = r.activeConfig;
            return (
              <li key={r.id} className="card animate-rise">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {r.name}
                      <StatusPill map={RULE_STATUS} status={r.status} />
                      {r.unapprovedVersion && (r.status === "active" || r.status === "paused") && <Badge tone="warn">{r.awaitingApproval ? "Edit awaiting approval" : "Edit not submitted"}</Badge>}
                      {r.dryRun && <Badge tone="neutral">Dry run</Badge>}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {r.trigger ? `When ${TRIGGER_INFO[r.trigger].label.toLowerCase()}` : "Settings need fixing"}
                      {running ? `, wait ${fmtDelay(running.delayMinutes)}, send “${names.get(running.templateId) ?? "a template"}”` : ""}
                      {running?.conditions.length ? ` · ${running.conditions.length} condition${running.conditions.length === 1 ? "" : "s"}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      Priority {r.priority} · version {r.version}
                      {r.activeVersion ? ` (version ${r.activeVersion} approved)` : ""}
                      {r.lastRunAt ? ` · last ran ${fmtWhen(r.lastRunAt, store?.timezone)}` : " · hasn't run yet"}
                    </p>
                  </div>
                  <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setOpen({ id: r.id, key: Date.now() })} aria-label={`${manage ? "Open" : "View"} ${r.name}`}>
                    {manage ? "Open" : "View"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted">
        Each event texts a customer once per workflow, however often Shopify reports it, and the same template reaches a customer once per order even when two workflows match. Consent, opt-outs,
        quiet hours and your budget are checked again right before each text goes.
      </p>
    </div>
  );
}
