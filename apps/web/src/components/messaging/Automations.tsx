"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, CircleAlert, Copy, History, MoreHorizontal, Pencil, Plus, Search, SlidersHorizontal, Trash2, Users } from "lucide-react";
import { AUTOMATION_TRIGGER_CARDS, fixVariableAliases, isSmsVariable, SMS_VARIABLE_INFO, type SmsTrigger } from "@app/shared/sms";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { Menu } from "@/components/team/TeamUi";
import { Alert, EmptyState } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { ActivateDialog, AUTOMATION_STATUS, problemsFor, timingWords, TriggerIcon } from "./AutomationUi";
import { fmtWhen, smsError, SmsStatusBadge, useSms } from "./MessagingUi";
import { RuleEditor } from "./RuleEditor";
import type { AutomationsResponse, AutomationView, SmsTemplate } from "./types";

// ---------------------------------------------------------------------------
// SMS Automations: one card each (what starts it, who gets it, its message, whether it's on and
// what it sent), with its switch, Edit, and a menu to duplicate it, see its texts or delete it.
// Every state shown is the API's (apps/api/src/routes/smsAutomations.ts): "Active" is the rule's
// stored status, and a text is "Delivered" only on the carrier's delivery report.
// ---------------------------------------------------------------------------

type StatusFilter = "all" | "active" | "paused" | "draft" | "disabled";
const STATUS_FILTERS: Array<[StatusFilter, string]> = [
  ["all", "All statuses"],
  ["active", "Active"],
  ["paused", "Paused"],
  ["draft", "Drafts"],
  ["disabled", "Disabled"],
];
const inFilter = (a: AutomationView, f: StatusFilter) => f === "all" || (f === "draft" ? a.status === "draft" || a.status === "pending_approval" : a.status === f);
/** With more than this many automations the list gets its search and filters. */
const FILTER_FROM = 4;

/** A message with its variables as labelled chips ("Hi [Customer first name], …"). */
export function MessageWithVariables({ body }: { body: string }) {
  const parts: ReactNode[] = [];
  const text = fixVariableAliases(body);
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    const name = m[1]!;
    parts.push(
      <span key={m.index} className="mx-0.5 inline-block rounded bg-accent/10 px-1 text-[0.85em] font-medium text-accent">
        {isSmsVariable(name) ? SMS_VARIABLE_INFO[name].label : name}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

type MenuAction = "duplicate" | "history" | "advanced" | "delete";

export function SmsAutomations() {
  const { base, manage, store } = useSms();
  const router = useRouter();
  const toast = useToast();
  const list = useApi<AutomationsResponse>(base ? `${base}/automations` : null);
  const templates = useApi<{ templates: SmsTemplate[] }>(base && manage ? `${base}/templates` : null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [trigger, setTrigger] = useState<SmsTrigger | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; fix?: { label: string; href: string } | null } | null>(null);
  const [activating, setActivating] = useState<AutomationView | null>(null);
  const [pausing, setPausing] = useState<AutomationView | null>(null);
  const [deleting, setDeleting] = useState<AutomationView | null>(null);
  const [advanced, setAdvanced] = useState<{ id: string; key: number } | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data?.automations ?? []).filter((a) => inFilter(a, status) && (trigger === "all" || a.trigger === trigger) && (!q || a.name.toLowerCase().includes(q) || (a.body ?? "").toLowerCase().includes(q) || (a.triggerLabel ?? "").toLowerCase().includes(q)));
  }, [list.data, query, status, trigger]);

  if (list.error && !list.data) return <LoadError what="your automations" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />;
  if (!list.data || !base) return <Skeleton lines={6} />;
  const { automations, problems, mode, readiness } = list.data;
  const missing = readiness.items.filter((i) => !i.ok && !i.optional && i.key !== "account");
  const triggersUsed = AUTOMATION_TRIGGER_CARDS.filter((c) => c.trigger && automations.some((a) => a.trigger === c.trigger));
  const business = store?.name ?? "your store";

  /** One change, then the list again: the API's answer is what's shown. */
  const act = async (key: string, what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
      await list.reload();
      toast("success", done);
      return true;
    } catch (e) {
      setProblem({ text: smsError(e, what), fix: missing[0]?.fix ?? null });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async (a: AutomationView) => {
    setBusy(`dup:${a.id}`);
    setProblem(null);
    try {
      const r = await api<{ automation: AutomationView }>(`${base}/automations/${a.id}/duplicate`, { method: "POST", body: {} });
      toast("success", `Copied as "${r.automation.name}". Change what you need, then activate it.`);
      router.push(`/messaging/automations/edit?id=${r.automation.id}&step=review`);
    } catch (e) {
      setProblem({ text: smsError(e, "copy the automation") });
      setBusy(null);
    }
  };

  const onMenu = (a: AutomationView) => (id: MenuAction) => {
    if (id === "duplicate") void duplicate(a);
    else if (id === "history") router.push(`/messaging/history?ruleId=${a.id}`);
    else if (id === "advanced") setAdvanced(advanced?.id === a.id ? null : { id: a.id, key: Date.now() });
    else setDeleting(a);
  };

  const create = (
    <Link href="/messaging/automations/edit" className="btn-primary inline-flex items-center gap-1.5">
      <Plus aria-hidden className="h-4 w-4" /> Create Automation
    </Link>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="SMS Automations" sub="Texts that go out by themselves when something happens in your store. Each one: what happened, who gets it, the message, and whether it's on." actions={manage ? create : undefined} />

      {missing.length > 0 && (
        <Alert kind="info">
          <p className="font-medium">Before your automations can text customers:</p>
          <ul className="mt-1 space-y-1">
            {missing.map((i) => (
              <li key={i.key} className="flex flex-wrap items-baseline gap-x-2">
                <span>
                  {i.label}: {i.detail.toLowerCase()}.
                </span>
                {i.fix && manage && (
                  <Link className="inline-flex items-center gap-0.5 font-medium underline" href={i.fix.href}>
                    Fix this <ArrowRight aria-hidden className="h-3 w-3" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {!missing.length && readiness.testMode && (
        <Alert kind="info">
          Your SMS account is still being verified: switched-on automations record what they would send in Message History, and test messages reach approved test recipients.{" "}
          <Link className="font-medium underline" href="/messaging/settings">
            View setup requirements
          </Link>
        </Alert>
      )}
      {problem && (
        <Alert onDismiss={() => setProblem(null)}>
          {problem.text}
          {problem.fix && manage && (
            <Link className="ml-2 font-medium underline" href={problem.fix.href}>
              Fix this
            </Link>
          )}
        </Alert>
      )}

      {automations.length === 0 ? (
        <EmptyState
          title="No automations yet"
          body="Start with a shipping update with the tracking link, or a reminder for abandoned checkouts. Nothing is sent until you activate it."
          action={
            manage ? (
              <div className="flex flex-wrap gap-2">
                {create}
                <Link href="/messaging/automations/edit?trigger=fulfillment_created" className="btn-secondary">
                  Shipping update
                </Link>
                <Link href="/messaging/automations/edit?trigger=checkout_abandoned" className="btn-secondary">
                  Abandoned checkout
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted">Only owners and admins can create automations.</p>
            )
          }
        />
      ) : (
        <>
          {automations.length > FILTER_FROM && (
            <div className="card animate-rise flex flex-wrap items-end gap-3" role="search">
              <div className="min-w-[12rem] flex-1">
                <label className="label" htmlFor="auto-search">
                  Search automations
                </label>
                <div className="relative">
                  <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input id="auto-search" className="input pl-9" type="search" placeholder="Name, trigger or message" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="auto-status">
                  Status
                </label>
                <select id="auto-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  {STATUS_FILTERS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="auto-trigger">
                  Trigger
                </label>
                <select id="auto-trigger" className="input" value={trigger} onChange={(e) => setTrigger(e.target.value as SmsTrigger | "all")}>
                  <option value="all">All triggers</option>
                  {triggersUsed.map((c) => (
                    <option key={c.key} value={c.trigger!}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {shown.length === 0 ? (
            <div className="card text-sm text-muted">
              No automation matches.{" "}
              <button
                type="button"
                className="font-medium text-accent underline-offset-2 hover:underline"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setTrigger("all");
                }}
              >
                Clear the filters
              </button>
            </div>
          ) : (
            <ul className="grid gap-3 lg:grid-cols-2" aria-label="Automations">
              {shown.map((a) => {
                const s = AUTOMATION_STATUS[a.status] ?? AUTOMATION_STATUS.draft;
                const on = a.status === "active";
                const blocked = problemsFor(problems, a.category);
                const sent = a.last30Days.accepted;
                return (
                  <li key={a.id} className={`card animate-rise flex flex-col gap-3 ${on ? "border-good/40" : ""}`} aria-label={a.name}>
                    <div className="flex items-start gap-3">
                      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                        <TriggerIcon trigger={a.trigger} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{a.name}</p>
                        <p className="mt-0.5 text-sm text-muted">
                          {a.triggerLabel ? `When: ${a.triggerLabel.toLowerCase()}` : "Its settings need fixing"}
                          {a.config ? ` · ${timingWords(a.config).toLowerCase()}` : ""}
                        </p>
                      </div>
                      {manage && (
                        <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted">
                          <span>{on ? "On" : "Off"}</span>
                          <input
                            type="checkbox"
                            role="switch"
                            className="h-5 w-5 accent-[var(--accent)]"
                            aria-label={`${a.name}: ${on ? "on" : "off"}`}
                            checked={on}
                            disabled={!!busy || !a.config}
                            onChange={() => (on ? setPausing(a) : setActivating(a))}
                          />
                        </label>
                      )}
                    </div>

                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone={s.tone}>{on ? "✓ Active" : a.status === "paused" ? "● Paused" : s.label}</Badge>
                      {a.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
                      {a.dryRun && <Badge tone="neutral">Practice run</Badge>}
                    </p>
                    {a.audienceLabel && (
                      <p className="flex gap-1.5 text-xs text-muted">
                        <Users aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {a.audienceLabel}
                      </p>
                    )}

                    {a.body && (
                      <p className="line-clamp-3 rounded-xl border border-border bg-bg/60 px-3 py-2 text-sm leading-relaxed">
                        <MessageWithVariables body={a.body} />
                      </p>
                    )}

                    <div className="space-y-1 text-xs text-muted">
                      <p className="font-medium text-text">
                        {fmtNum(sent)} message{sent === 1 ? "" : "s"} sent <span className="font-normal text-muted">in the last 30 days</span>
                        {a.last30Days.dryRun ? <span className="font-normal text-muted"> · {fmtNum(a.last30Days.dryRun)} recorded only</span> : null}
                      </p>
                      <p className="flex flex-wrap items-center gap-1.5">
                        {a.lastResult ? (
                          <>
                            Last text {fmtWhen(a.lastResult.at, store?.timezone)}: <SmsStatusBadge status={a.lastResult.status} why={a.lastResult.reasonLabel} />
                            {a.lastResult.reasonLabel && a.lastResult.status !== "dry_run" && <span>{a.lastResult.reasonLabel}</span>}
                          </>
                        ) : a.lastRunAt ? (
                          `Last ran ${fmtWhen(a.lastRunAt, store?.timezone)}`
                        ) : (
                          "Hasn't run yet"
                        )}
                      </p>
                      {on && blocked.length > 0 && (
                        <p className="flex gap-1.5 text-warn">
                          <CircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {blocked[0]!.code === "test_mode" ? "Test mode: recorded in Message History, not sent." : `Not reaching customers yet: ${blocked[0]!.message}`}
                        </p>
                      )}
                    </div>

                    {manage && (
                      <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
                        <Link href={`/messaging/automations/edit?id=${a.id}`} className="btn-secondary inline-flex h-8 items-center gap-1.5 px-3 text-xs" aria-label={`Edit ${a.name}`}>
                          <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                        </Link>
                        {busy === `dup:${a.id}` && <span className="text-xs text-muted">Copying…</span>}
                        <span className="ml-auto">
                          <Menu<MenuAction>
                            label={`More for ${a.name}`}
                            items={[
                              ...(a.config ? [{ id: "duplicate" as const, label: "Duplicate", icon: Copy }] : []),
                              { id: "history", label: "View history", icon: History },
                              { id: "advanced", label: "Advanced settings", icon: SlidersHorizontal },
                              { id: "delete", label: "Delete", icon: Trash2, danger: true },
                            ]}
                            onPick={onMenu(a)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-text/[0.04] hover:text-text"
                            trigger={<MoreHorizontal aria-hidden className="h-4 w-4" />}
                          />
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {advanced && templates.data && (
        <RuleEditor key={advanced.key} id={advanced.id} templates={templates.data.templates} onClose={() => setAdvanced(null)} onChanged={() => void list.reload()} />
      )}

      <p className="text-xs text-muted">
        Each Shopify event texts a customer once per automation, however often Shopify reports it. The customer&apos;s permission, opt-outs, quiet hours and your monthly limit are checked again right
        before each text goes, and a text counts as delivered only when the carrier confirms it.
      </p>

      <ActivateDialog
        open={!!activating}
        name={activating?.name ?? ""}
        trigger={activating?.trigger ?? null}
        body={activating?.body ?? null}
        business={business}
        mode={mode}
        problems={problems}
        republish={false}
        busy={busy === "activate"}
        onCancel={() => setActivating(null)}
        onConfirm={() =>
          void act("activate", "activate the automation", () => api(`${base}/automations/${activating!.id}/activate`, { method: "POST", body: { confirm: true } }), mode === "live" ? "Activated." : "Activated. While your account is being verified, its texts are recorded, not sent.").then(() =>
            setActivating(null),
          )
        }
      />
      <ConfirmDialog
        open={!!pausing}
        title={`Pause "${pausing?.name ?? ""}"?`}
        confirmLabel="Pause"
        busy={busy === "pause"}
        onCancel={() => setPausing(null)}
        onConfirm={() => void act("pause", "pause the automation", () => api(`${base}/automations/${pausing!.id}/pause`, { method: "POST", body: {} }), "Paused. Its texts still waiting were cancelled.").then(() => setPausing(null))}
      >
        <p>It stops at once, and its texts still waiting to go are cancelled. Switch it back on any time.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!deleting}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete"
        danger
        busy={busy === "delete"}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void act("delete", "delete the automation", () => api(`${base}/automations/${deleting!.id}`, { method: "DELETE" }), "Deleted.").then((ok) => {
            if (ok && advanced?.id === deleting?.id) setAdvanced(null);
            setDeleting(null);
          })
        }
      >
        <p>It stops at once and its texts still waiting are cancelled. Texts it already sent stay in Message History. This can&apos;t be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
