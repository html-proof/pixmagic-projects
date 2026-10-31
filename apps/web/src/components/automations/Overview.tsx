"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CircleAlert, FlaskConical, Pause, Pencil, Play, Plus, Power, Search, Trash2 } from "lucide-react";
import { CHANNEL_INFO, HUB_TRIGGER_INFO, type HubAction, type HubChannel } from "@app/shared/automations";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert, EmptyState } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { ChannelCards } from "./Channels";
import { AutomationStatusBadge, CHANNEL_NAME, ChannelIcon, delayWords, fmtWhen, HubStatusBadge, HubTriggerIconView, hubError, useHub } from "./HubUi";
import type { HubAutomation, OverviewResponse } from "./types";

// ---------------------------------------------------------------------------
// Automations: every channel's connection, and every automation of every channel with its real
// state (the channel's own rule, as stored), its last message and its last 30 days, with the
// controls its state allows (on, pause, resume, disable, edit, delete). Nothing here is the
// page's guess: each change is the API's answer, read back.
// ---------------------------------------------------------------------------

type ChannelFilter = "all" | HubChannel;
type StatusFilter = "all" | "active" | "paused" | "draft" | "disabled";

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

export function AutomationsOverview() {
  const { path, store } = useHub();
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
    <div className="space-y-4">
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

      <section aria-labelledby="channels-h" className="space-y-2">
        <h2 id="channels-h" className="text-sm font-semibold">
          Channels
        </h2>
        <ChannelCards connections={connections} permissions={permissions} onChanged={() => data.reload()} />
      </section>

      <section aria-labelledby="automations-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="automations-h" className="text-sm font-semibold">
            Your automations
          </h2>
          <Link href="/automations/history" className="text-sm font-medium text-accent underline-offset-2 hover:underline">
            Message history
          </Link>
        </div>
        {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}

        {automations.length === 0 ? (
          <EmptyState
            title="No automations yet"
            body="Start with an order confirmation or a shipping update. It takes four short steps, and nothing is sent until you turn it on."
            action={canCreate ? create : <p className="text-sm text-muted">Only owners and admins can create automations.</p>}
          />
        ) : (
          <>
            <div className="card animate-rise flex flex-wrap items-end gap-3" role="search">
              <div className="min-w-[12rem] flex-1">
                <label className="label" htmlFor="hub-search">
                  Search
                </label>
                <div className="relative">
                  <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input id="hub-search" className="input pl-9" type="search" placeholder="Name, trigger or message" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="hub-channel">
                  Channel
                </label>
                <select id="hub-channel" className="input" value={channel} onChange={(e) => setChannel(e.target.value as ChannelFilter)}>
                  <option value="all">All channels</option>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="hub-status">
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
              <div className="card text-sm text-muted">No automation matches these filters.</div>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2" aria-label="Automations">
                {shown.map((a) => {
                  const on = a.status === "active";
                  const month = monthLine(a);
                  const key = `${a.channel}:${a.id}`;
                  const blocked = connections.find((c) => c.channel === a.channel)?.problems.filter((p) => !["test_mode", "marketing_platform_off", "marketing_off"].includes(p.code)) ?? [];
                  const icon = a.trigger ? HUB_TRIGGER_INFO[a.trigger].icon : "webhook";
                  return (
                    <li key={key} className={`card animate-rise flex flex-col gap-3 ${on ? "border-good/40" : ""}`} aria-label={`${a.name} (${CHANNEL_NAME[a.channel]})`}>
                      <div className="flex items-start gap-3">
                        <span aria-hidden className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                          <HubTriggerIconView icon={icon} />
                          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-muted">
                            <ChannelIcon channel={a.channel} className="h-3 w-3" />
                          </span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 font-semibold">
                            <span className="truncate">{a.name}</span>
                            <AutomationStatusBadge status={a.status} />
                            {a.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
                            {a.testMode && (
                              <Badge tone="neutral">
                                <FlaskConical aria-hidden className="h-3 w-3" /> Test mode
                              </Badge>
                            )}
                          </p>
                          <p className="mt-0.5 text-sm text-muted">
                            {CHANNEL_INFO[a.channel].label} · When: {a.triggerLabel} · {delayWords(a.delayMinutes)}
                          </p>
                        </div>
                      </div>

                      {(a.subject || a.body) && (
                        <div className="rounded-xl border border-border bg-bg/60 px-3 py-2 text-sm leading-relaxed">
                          {a.subject && <p className="font-medium">{a.subject}</p>}
                          {a.body && <p className="line-clamp-3 whitespace-pre-line text-muted">{a.body}</p>}
                        </div>
                      )}

                      <div className="space-y-1 text-xs text-muted">
                        <p className="flex flex-wrap items-center gap-1.5">
                          {a.lastResult ? (
                            <>
                              Last message {fmtWhen(a.lastResult.at, store?.timezone)}: <HubStatusBadge status={a.lastResult.status} />
                              {a.lastResult.reason && <span>{a.lastResult.reason}</span>}
                            </>
                          ) : a.lastRunAt ? (
                            `Last ran ${fmtWhen(a.lastRunAt, store?.timezone)}`
                          ) : (
                            "Hasn't run yet"
                          )}
                        </p>
                        {month && <p>{month}</p>}
                        {on && blocked.length > 0 && (
                          <p className="flex gap-1.5 text-warn">
                            <CircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Not reaching customers yet: {blocked[0]!.message}
                          </p>
                        )}
                      </div>

                      <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
                        {a.actions.map((action) => {
                          const Icon = ACTION_ICON[action];
                          return (
                            <button
                              key={action}
                              type="button"
                              className={`${action === "activate" || action === "resume" ? "btn-primary" : "btn-secondary"} inline-flex h-8 items-center gap-1.5 px-3 text-xs`}
                              disabled={!!busy}
                              aria-label={`${ACTION_LABEL[action]} ${a.name}`}
                              onClick={() => setConfirming({ a, action })}
                            >
                              <Icon aria-hidden className="h-3.5 w-3.5" /> {busy === key ? "Working…" : ACTION_LABEL[action]}
                            </button>
                          );
                        })}
                        {a.pendingChanges && a.actions.length > 0 && (
                          <button type="button" className="btn-primary inline-flex h-8 items-center px-3 text-xs" disabled={!!busy} onClick={() => setConfirming({ a, action: "activate" })}>
                            Put changes live
                          </button>
                        )}
                        {(permissions.manage[a.channel] || !a.editable) && (
                          <Link href={a.editHref} className="btn-secondary inline-flex h-8 items-center gap-1.5 px-3 text-xs" aria-label={`Edit ${a.name}`}>
                            <Pencil aria-hidden className="h-3.5 w-3.5" /> {a.editable ? "Edit" : "Open"}
                          </Link>
                        )}
                        <Link href={`/automations/history?automation=${a.channel}:${encodeURIComponent(a.id)}`} className="inline-flex h-8 items-center px-2 text-xs text-muted hover:text-text">
                          Messages
                        </Link>
                        {permissions.manage[a.channel] && (
                          <button type="button" className="ml-auto inline-flex h-8 items-center gap-1.5 px-2 text-xs text-muted hover:text-danger" disabled={!!busy} aria-label={`Delete ${a.name}`} onClick={() => setConfirming({ a, action: "delete" })}>
                            <Trash2 aria-hidden className="h-3.5 w-3.5" /> Delete
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <p className="text-xs text-muted">
        Each event messages a customer once per automation, however often the store reports it. Consent, opt-outs and limits are checked again right before each message goes, and a message counts as delivered only when the
        provider&apos;s delivery report says so.
      </p>

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
