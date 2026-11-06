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
import { Chip, FactsLine, FootLine, Switch, TableCard } from "@/components/automations/MarketingKit";
import { api, fmtNum, useApi } from "@/lib/api";
import { ActivateDialog, AUTOMATION_STATUS, problemsFor, timingWords, TriggerIcon } from "./AutomationUi";
import { fmtWhen, smsError, SmsStatusBadge, useSms } from "./MessagingUi";
import { RuleEditor } from "./RuleEditor";
import type { AutomationsResponse, AutomationView, SmsTemplate } from "./types";

// ---------------------------------------------------------------------------
// SMS Automations, as the Stitch design's screen 14 lists them: a line of how many are on and what
// they sent, then one row each (what starts it, who gets it and its message; its channel; its
// status; its last 30 days; Edit, its switch and a menu to duplicate it, see its texts or delete
// it). Every state shown is the API's (apps/api/src/routes/smsAutomations.ts): "Active" is the
// rule's stored status, and a text is "Delivered" only on the carrier's delivery report.
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
/** The rows' columns on a wide screen (the design's table); a narrower one stacks each row. */
const COLUMNS = "xl:grid xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto] xl:items-start xl:gap-4";
/** A head cell of that row, as MarketingKit's TH draws one (the row sets the side padding). */
const HEAD = "py-2.5 text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase";

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
  const onCount = automations.filter((a) => a.status === "active").length;
  const sentTotal = automations.reduce((n, a) => n + a.last30Days.accepted, 0);

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
      {automations.length > 0 && (
        <FactsLine
          testId="automations-facts"
          items={[
            `${fmtNum(onCount)} of ${fmtNum(automations.length)} on`,
            `${fmtNum(sentTotal)} sent in 30 days`,
            missing.length > 0 && (
              <span className="inline-flex items-center gap-1.5 font-medium text-danger">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
                {fmtNum(missing.length)} {missing.length === 1 ? "needs" : "need"} you
              </span>
            ),
          ]}
        />
      )}

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
            <div className="home-card animate-rise flex flex-wrap items-end gap-3 p-4 sm:p-5" role="search">
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
            <div className="home-card p-5 text-sm text-muted">
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
            <TableCard id="sms-automations" testId="sms-automations">
              {/* The design's head row: for the eye only, each row below names its own parts. */}
              <div aria-hidden className={`hidden bg-home-soft px-5 sm:px-6 ${COLUMNS}`}>
                <span className={HEAD}>Automation</span>
                <span className={HEAD}>Channel</span>
                <span className={HEAD}>Status</span>
                <span className={`${HEAD} text-right`}>Last 30 days</span>
                <span className={`${HEAD} text-right`}>{manage ? "State" : ""}</span>
              </div>
              <ul className="divide-y divide-home-line" aria-label="Automations">
                {shown.map((a) => {
                  const s = AUTOMATION_STATUS[a.status] ?? AUTOMATION_STATUS.draft;
                  const on = a.status === "active";
                  const blocked = problemsFor(problems, a.category);
                  const sent = a.last30Days.accepted;
                  return (
                    <li key={a.id} className={`relative flex flex-col gap-3 px-5 py-4 focus-within:z-10 sm:px-6 ${COLUMNS}`} aria-label={a.name}>
                      <div className="flex min-w-0 items-start gap-3">
                        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-accent/10 text-accent">
                          <TriggerIcon trigger={a.trigger} className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="truncate font-semibold">{a.name}</p>
                          <p className="text-xs text-muted">
                            {a.triggerLabel ? `When: ${a.triggerLabel.toLowerCase()}` : "Its settings need fixing"}
                            {a.config ? ` · ${timingWords(a.config).toLowerCase()}` : ""}
                          </p>
                          {a.audienceLabel && (
                            <p className="flex gap-1.5 text-xs text-muted">
                              <Users aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              {a.audienceLabel}
                            </p>
                          )}
                          {a.body && (
                            <p className="line-clamp-2 rounded bg-home-soft px-3 py-2 text-xs leading-relaxed">
                              <MessageWithVariables body={a.body} />
                            </p>
                          )}
                        </div>
                      </div>

                      <p className="flex flex-wrap items-center gap-1.5">
                        <Chip>SMS</Chip>
                        {a.category === "marketing" && <Chip tone="accent">marketing</Chip>}
                        {a.dryRun && <Badge tone="neutral">Practice run</Badge>}
                      </p>

                      <p className="flex flex-wrap items-center gap-1.5 text-sm">
                        <Badge tone={s.tone}>{on ? "✓ Active" : a.status === "paused" ? "● Paused" : s.label}</Badge>
                        {a.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
                      </p>

                      <div className="space-y-1 text-xs text-muted xl:text-right">
                        <p className="font-medium text-text tabular-nums">
                          {fmtNum(sent)} message{sent === 1 ? "" : "s"} sent <span className="font-normal text-muted">in the last 30 days</span>
                          {a.last30Days.dryRun ? <span className="font-normal text-muted"> · {fmtNum(a.last30Days.dryRun)} recorded only</span> : null}
                        </p>
                        <p className="flex flex-wrap items-center gap-1.5 xl:justify-end">
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
                      </div>

                      {manage && (
                        <div className="flex items-center gap-3 xl:justify-end">
                          <Link href={`/messaging/automations/edit?id=${a.id}`} className="inline-flex h-8 items-center gap-1.5 text-[13px] font-medium text-accent hover:underline" aria-label={`Edit ${a.name}`}>
                            <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                          </Link>
                          {busy === `dup:${a.id}` && <span className="text-xs text-muted">Copying…</span>}
                          <label className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted xl:ml-0">
                            <span>{on ? "On" : "Off"}</span>
                            <Switch aria-label={`${a.name}: ${on ? "on" : "off"}`} checked={on} disabled={!!busy || !a.config} onChange={() => (on ? setPausing(a) : setActivating(a))} />
                          </label>
                          <Menu<MenuAction>
                            label={`More for ${a.name}`}
                            items={[
                              ...(a.config ? [{ id: "duplicate" as const, label: "Duplicate", icon: Copy }] : []),
                              { id: "history", label: "View history", icon: History },
                              { id: "advanced", label: "Advanced settings", icon: SlidersHorizontal },
                              { id: "delete", label: "Delete", icon: Trash2, danger: true },
                            ]}
                            onPick={onMenu(a)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded bg-home-soft text-muted transition-colors outline-none hover:bg-home-soft-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
                            trigger={<MoreHorizontal aria-hidden className="h-4 w-4" />}
                          />
                        </div>
                      )}

                      {on && blocked.length > 0 && (
                        <p className="flex gap-1.5 text-xs text-warn xl:col-span-5">
                          <CircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {blocked[0]!.code === "test_mode" ? "Test mode: recorded in Message History, not sent." : `Not reaching customers yet: ${blocked[0]!.message}`}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </TableCard>
          )}
        </>
      )}

      {advanced && templates.data && (
        <RuleEditor key={advanced.key} id={advanced.id} templates={templates.data.templates} onClose={() => setAdvanced(null)} onChanged={() => void list.reload()} />
      )}

      <FootLine
        actions={
          <Link href="/messaging/history" className="font-medium text-accent hover:underline">
            Message History
          </Link>
        }
      >
        Each Shopify event texts a customer once per automation, however often Shopify reports it. The customer&apos;s permission, opt-outs, quiet hours and your monthly limit are checked again right
        before each text goes, and a text counts as delivered only when the carrier confirms it.
      </FootLine>

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
