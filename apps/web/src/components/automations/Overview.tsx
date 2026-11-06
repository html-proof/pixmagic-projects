"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CircleAlert, FlaskConical, Pause, Pencil, Play, Plus, Power, Search, Trash2, TriangleAlert } from "lucide-react";
import { CHANNEL_INFO, HUB_TRIGGER_INFO, type HubAction, type HubChannel } from "@app/shared/automations";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert, EmptyState } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { ChannelCards } from "./Channels";
import { AutomationStatusBadge, CHANNEL_NAME, ChannelIcon, delayWords, fmtWhen, HubStatusBadge, HubTriggerIconView, hubError, useHub } from "./HubUi";
import { Chip, FactsLine, FootLine, TableCard } from "./MarketingKit";
import type { ChannelConnection, HubAutomation, OverviewResponse } from "./types";

// ---------------------------------------------------------------------------
// Automations, as the Stitch design's screen 14 draws them: the few facts on one line ("3 of 7
// on · 779 sent in 30 days · 1 needs you"), a red row for each channel that stops messages, then
// every automation of every channel as a row: its name and trigger, its channel, its real state
// (the channel's own rule, as stored), its last 30 days and the controls its state allows (on,
// pause, resume, disable, edit, delete). Each channel's card follows under the list. Nothing here
// is the page's guess: each change is the API's answer, read back.
// ---------------------------------------------------------------------------

type ChannelFilter = "all" | HubChannel;
type StatusFilter = "all" | "active" | "paused" | "draft" | "disabled";

/** Problems that don't stop a channel's messages: test mode is the platform's state, marketing is per message. */
const NOT_BLOCKING = ["test_mode", "marketing_platform_off", "marketing_off"];
const blockingOf = (c: ChannelConnection | undefined) => c?.problems.filter((p) => !NOT_BLOCKING.includes(p.code)) ?? [];

/** Messages an automation handed to the provider in its last 30 days, as the Home's "Working for you" counts them. */
const sentOf = (a: HubAutomation) => a.last30Days.sent + a.last30Days.delivered + a.last30Days.undelivered;

/** The last 30 days in a line, on the hub's scale: accepted is not delivered. */
function monthLine(a: HubAutomation): string | null {
  const c = a.last30Days;
  const bits = [
    c.sent ? `${fmtNum(c.sent)} accepted by the provider` : null,
    c.delivered ? `${fmtNum(c.delivered)} delivered` : null,
    c.undelivered + c.failed ? `${fmtNum(c.undelivered + c.failed)} failed` : null,
    c.not_sent ? `${fmtNum(c.not_sent)} not sent` : null,
    c.test_only ? `${fmtNum(c.test_only)} test only` : null,
    c.queued + c.processing ? `${fmtNum(c.queued + c.processing)} waiting` : null,
    c.unknown ? `${fmtNum(c.unknown)} unknown` : null,
  ].filter(Boolean);
  return bits.length ? `Last 30 days: ${bits.join(" · ")}` : null;
}

const ACTION_LABEL: Record<HubAction, string> = { activate: "Turn on", resume: "Resume", pause: "Pause", disable: "Disable" };
const ACTION_ICON: Record<HubAction, typeof Play> = { activate: Power, resume: Play, pause: Pause, disable: Power };

/** The list's columns from a laptop up (one grid for the head row and every row); a phone stacks each row. */
const COLUMNS = "xl:grid-cols-[minmax(0,2.6fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,2fr)] xl:items-center xl:gap-4";

export function AutomationsOverview() {
  const { path, store, auditAllowed } = useHub();
  const toast = useToast();
  const data = useApi<OverviewResponse>(path(""));
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ a: HubAutomation; action: HubAction | "delete" } | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data.data?.automations ?? []).filter(
      (a) =>
        (channel === "all" || a.channel === channel) &&
        (status === "all" || (status === "draft" ? a.status === "draft" || a.status === "pending_approval" : a.status === status)) &&
        (!q || [a.name, a.triggerLabel, a.body ?? "", a.subject ?? ""].some((x) => x.toLowerCase().includes(q))),
    );
  }, [data.data, query, channel, status]);

  if (data.error && !data.data) return <LoadError what="your automations" error={data.error} onRetry={() => void data.reload()} busy={data.loading} />;
  if (!data.data) return <Skeleton lines={8} />;
  const { connections, permissions, automations, smsMode } = data.data;
  const canCreate = permissions.manage.sms || permissions.manage.email;
  const active = automations.filter((a) => a.status === "active").length;
  const sent30 = automations.reduce((n, a) => n + sentOf(a), 0);
  // "Needs you": a channel that's connected but stopped, each with what stops it and its one fix.
  const stopped = connections.filter((c) => c.state === "needs_attention" && blockingOf(c).length > 0);

  const act = async (a: HubAutomation, action: HubAction | "delete") => {
    setBusy(`${a.channel}:${a.id}`);
    setProblem(null);
    try {
      if (action === "delete") await api(path(`/items/${a.channel}/${a.id}`), { method: "DELETE" });
      else await api(path(`/items/${a.channel}/${a.id}/${action}`), { method: "POST", body: { confirm: action === "activate" || action === "resume" } });
      await data.reload();
      toast(
        "success",
        action === "delete"
          ? `Deleted "${a.name}".`
          : action === "pause"
            ? `Paused "${a.name}". Messages still waiting were cancelled.`
            : action === "disable"
              ? `Disabled "${a.name}".`
              : a.channel === "sms" && smsMode !== "live"
                ? `"${a.name}" is on. In test mode its texts are recorded, not sent.`
                : `"${a.name}" is on.`,
      );
      return true;
    } catch (e) {
      setProblem(hubError(e, action === "delete" ? "delete the automation" : `${ACTION_LABEL[action].toLowerCase()} the automation`));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const create = (
    <Link href="/automations/new" className="btn-primary inline-flex items-center gap-1.5">
      <Plus aria-hidden className="h-4 w-4" /> Create automation
    </Link>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Automations"
        sub={
          <>
            Message customers automatically on WhatsApp, by SMS or by email when something happens in your store: connect a channel, choose a trigger, write the message, then review and turn it on.
            {store ? ` SMS is set up per store (now: ${store.name ?? "this store"}); email belongs to the whole workspace.` : ""}
          </>
        }
        actions={canCreate ? create : undefined}
      />

      {automations.length > 0 && (
        <FactsLine
          testId="automations-facts"
          items={[
            `${fmtNum(active)} of ${fmtNum(automations.length)} on`,
            `${fmtNum(sent30)} sent in 30 days`,
            stopped.length > 0 && (
              <span className="inline-flex items-center gap-1.5 font-medium text-danger">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
                {fmtNum(stopped.length)} {stopped.length === 1 ? "needs" : "need"} you
              </span>
            ),
          ]}
        />
      )}

      {stopped.map((c) => {
        const p = blockingOf(c)[0]!;
        return (
          <div key={c.channel} className="alert alert-error" data-testid={`needs-you-${c.channel}`}>
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1">
              <span className="font-semibold">{CHANNEL_NAME[c.channel]}: </span>
              {p.message}
            </p>
            {p.fix && (
              <Link href={p.fix.href} className="home-btn h-8 shrink-0 bg-surface text-danger">
                {p.fix.label}
              </Link>
            )}
          </div>
        );
      })}

      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}

      {automations.length === 0 ? (
        <EmptyState
          title="No automations yet"
          body="Start with an order confirmation or a shipping update. It takes four short steps, and nothing is sent until you turn it on."
          action={canCreate ? create : <p className="text-sm text-muted">Only owners and admins can create automations.</p>}
        />
      ) : (
        <TableCard
          id="automations"
          title="Your automations"
          aside="Each one's channel, its state as stored, and what it sent in the last 30 days."
        >
          <div className="flex flex-wrap items-end gap-3 border-t border-home-line px-5 py-3 sm:px-6" role="search">
            <div className="min-w-[12rem] flex-1">
              <label className="label text-xs text-muted" htmlFor="hub-search">
                Search
              </label>
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
                <input id="hub-search" className="input pl-9" type="search" placeholder="Name, trigger or message" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label text-xs text-muted" htmlFor="hub-channel">
                Channel
              </label>
              <select id="hub-channel" className="input" value={channel} onChange={(e) => setChannel(e.target.value as ChannelFilter)}>
                <option value="all">All channels</option>
                <option value="sms">SMS</option>
                <option value="email">Email</option>
              </select>
            </div>
            <div>
              <label className="label text-xs text-muted" htmlFor="hub-status">
                Status
              </label>
              <select id="hub-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="draft">Drafts</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="border-t border-home-line px-5 py-6 text-sm text-muted sm:px-6">No automation matches these filters.</p>
          ) : (
            <>
              {/* The design's head row, for the eye: each row says the same in words. */}
              <div aria-hidden className={`hidden bg-home-soft px-6 py-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase xl:grid ${COLUMNS}`}>
                <span>Automation</span>
                <span>Channel</span>
                <span>Status</span>
                <span className="text-right">Last 30 days</span>
                <span className="text-right">State</span>
              </div>
              <ul className="divide-y divide-home-line border-t border-home-line xl:border-t-0" aria-label="Automations">
                {shown.map((a) => {
                  const month = monthLine(a);
                  const key = `${a.channel}:${a.id}`;
                  const blocked = blockingOf(connections.find((c) => c.channel === a.channel));
                  const icon = a.trigger ? HUB_TRIGGER_INFO[a.trigger].icon : "webhook";
                  const sent = sentOf(a);
                  return (
                    <li key={key} className="px-5 py-4 sm:px-6" aria-label={`${a.name} (${CHANNEL_NAME[a.channel]})`}>
                      <div className={`grid gap-3 ${COLUMNS}`}>
                        <div className="flex min-w-0 items-start gap-3">
                          <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent/10 text-accent">
                            <HubTriggerIconView icon={icon} className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{a.name}</p>
                            <p className="mt-0.5 text-xs text-muted">
                              {CHANNEL_INFO[a.channel].label} · When: {a.triggerLabel} · {delayWords(a.delayMinutes)}
                            </p>
                            {(a.subject || a.body) && (
                              <p className="mt-1 line-clamp-2 text-xs whitespace-pre-line text-muted">
                                {a.subject && <span className="font-medium text-text">{a.subject} · </span>}
                                {a.body}
                              </p>
                            )}
                          </div>
                        </div>
                        <p className="flex flex-wrap items-center gap-1.5">
                          <Chip>
                            <ChannelIcon channel={a.channel} className="h-3 w-3" /> {CHANNEL_NAME[a.channel]}
                          </Chip>
                          {a.category === "marketing" && <Chip tone="accent">marketing</Chip>}
                          {a.testMode && (
                            <Chip>
                              <FlaskConical aria-hidden className="h-3 w-3" /> Test mode
                            </Chip>
                          )}
                        </p>
                        <p className="flex flex-wrap items-center gap-1.5">
                          <AutomationStatusBadge status={a.status} />
                          {a.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
                        </p>
                        <div className="text-sm xl:text-right">
                          <p className="font-medium tabular-nums">{sent ? `${fmtNum(sent)} sent` : <span className="text-muted">Nothing sent</span>}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted xl:justify-end">
                            {a.lastResult ? (
                              <>
                                Last message {fmtWhen(a.lastResult.at, store?.timezone)}: <HubStatusBadge status={a.lastResult.status} />
                              </>
                            ) : a.lastRunAt ? (
                              `Last ran ${fmtWhen(a.lastRunAt, store?.timezone)}`
                            ) : (
                              "Hasn't run yet"
                            )}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                          {(permissions.manage[a.channel] || !a.editable) && (
                            <Link href={a.editHref} className="inline-flex h-8 items-center gap-1.5 px-1 text-[13px] font-medium text-accent hover:underline" aria-label={`Edit ${a.name}`}>
                              <Pencil aria-hidden className="h-3.5 w-3.5" /> {a.editable ? "Edit" : "Open"}
                            </Link>
                          )}
                          {a.actions.map((action) => {
                            const Icon = ACTION_ICON[action];
                            return (
                              <button
                                key={action}
                                type="button"
                                className={`${action === "activate" || action === "resume" ? "btn-primary" : "btn-secondary"} h-8 px-3 text-xs`}
                                disabled={!!busy}
                                aria-label={`${ACTION_LABEL[action]} ${a.name}`}
                                onClick={() => setConfirming({ a, action })}
                              >
                                <Icon aria-hidden className="h-3.5 w-3.5" /> {busy === key ? "Working…" : ACTION_LABEL[action]}
                              </button>
                            );
                          })}
                          {a.pendingChanges && a.actions.length > 0 && (
                            <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={!!busy} onClick={() => setConfirming({ a, action: "activate" })}>
                              Put changes live
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted xl:pl-11">
                          {a.lastResult?.reason && <span>{a.lastResult.reason}</span>}
                          {month && <span>{month}</span>}
                          {a.status === "active" && blocked.length > 0 && (
                            <span className="flex gap-1.5 text-warn">
                              <CircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Not reaching customers yet: {blocked[0]!.message}
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-1">
                            <Link href={`/automations/history?automation=${a.channel}:${encodeURIComponent(a.id)}`} className="inline-flex h-7 items-center px-1.5 hover:text-text">
                              Messages
                            </Link>
                            {permissions.manage[a.channel] && (
                              <button type="button" className="inline-flex h-7 items-center gap-1.5 px-1.5 hover:text-danger" disabled={!!busy} aria-label={`Delete ${a.name}`} onClick={() => setConfirming({ a, action: "delete" })}>
                                <Trash2 aria-hidden className="h-3.5 w-3.5" /> Delete
                              </button>
                            )}
                          </span>
                        </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </TableCard>
      )}

      <FootLine
        actions={
          <>
            <Link href="/automations/history" className="font-medium text-accent hover:underline">
              Message history
            </Link>
            {auditAllowed && (
              <>
                <span aria-hidden>·</span>
                <Link href="/automations/audit" className="font-medium text-accent hover:underline">
                  Audit log
                </Link>
              </>
            )}
          </>
        }
      >
        Each event messages a customer once per automation, however often the store reports it. Consent, opt-outs and limits are checked again right before each message goes, and a message counts as delivered only when the
        provider&apos;s delivery report says so.
      </FootLine>

      <section aria-labelledby="channels-h" className="space-y-3">
        <h2 id="channels-h" className="home-h2">
          Channels
        </h2>
        <ChannelCards connections={connections} permissions={permissions} onChanged={() => data.reload()} />
      </section>

      <ConfirmDialog
        open={!!confirming}
        title={confirming ? (confirming.action === "delete" ? `Delete "${confirming.a.name}"?` : `${ACTION_LABEL[confirming.action]} "${confirming.a.name}"?`) : ""}
        confirmLabel={confirming ? (confirming.action === "delete" ? "Delete" : ACTION_LABEL[confirming.action]) : ""}
        danger={confirming?.action === "delete" || confirming?.action === "disable"}
        busy={!!busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act(confirming!.a, confirming!.action).then((ok) => ok && setConfirming(null))}
      >
        {confirming?.action === "activate" || confirming?.action === "resume" ? (
          <>
            <p>
              From now on, each time its trigger happens this automation {confirming.a.channel === "sms" ? "texts" : "emails"} the customer, if they may receive it (consent, opt-outs and limits are checked every time).
            </p>
            {confirming.a.channel === "sms" && smsMode !== "live" && <p className="font-medium">bizinsights is in test mode: texts are recorded in the history, not sent to anyone.</p>}
          </>
        ) : confirming?.action === "delete" ? (
          <p>It stops at once and its waiting messages are cancelled. Messages it already sent stay in the history. This can&apos;t be undone.</p>
        ) : confirming?.action === "disable" ? (
          <p>It stops at once and its waiting messages are cancelled. To use it again, edit it and turn it on.</p>
        ) : (
          <p>It stops at once and its waiting messages are cancelled. You can resume it any time.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
