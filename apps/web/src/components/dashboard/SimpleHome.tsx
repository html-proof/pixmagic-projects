"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, ChevronRight, CircleCheck } from "lucide-react";
import type { AlertView } from "@app/shared/alerts";
import type { Health } from "@app/shared/health";
import { CHANNEL_NAME, useHub } from "@/components/automations/HubUi";
import type { HubAutomation, OverviewResponse } from "@/components/automations/types";
import { fmtMoney, fmtNum, useApi } from "@/lib/api";
import { SIMPLE_HOME } from "@/lib/features";
import { HOME_LAYOUT_KEY, readLocal, writeLocal } from "@/lib/storage";
import { fmtMoneyCompact, fmtRange } from "./format";
import { ChangeText } from "./HomeCards";
import type { Need, NeedAction, NeedTone } from "./homeNeeds";
import { LineChart } from "./LineChart";
import { businessHealth } from "./Overview";
import type { Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// The simple Home (lib/features.ts SIMPLE_HOME), as the owner's approved prototype lays it out:
// what needs you, four numbers, sales by day, what changed, and the automations working for you.
// Every figure is one the full dashboard shows too, worked out by the same code; the full dashboard
// stays one click away ("Show the full dashboard", kept per device).
// ---------------------------------------------------------------------------

export type HomeLayout = "simple" | "full";

/** Which Home this device shows: the simple one unless "Show the full dashboard" was chosen here. */
export function useHomeLayout(): [HomeLayout, (l: HomeLayout) => void] {
  const [saved, setSaved] = useState<HomeLayout | null>(null);
  // After mounting: the page is drawn before storage is read anywhere else, and the numbers load after this.
  useEffect(() => {
    const v = readLocal(HOME_LAYOUT_KEY);
    if (v === "simple" || v === "full") setSaved(v);
  }, []);
  const layout: HomeLayout = !SIMPLE_HOME ? "full" : (saved ?? "simple");
  return [
    layout,
    (l) => {
      writeLocal(HOME_LAYOUT_KEY, l);
      setSaved(l);
    },
  ];
}

/** "Good afternoon" by the clock of whoever is looking. */
export const greeting = (hour: number) => (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");

/** A white panel with its heading, one quiet line under it, and a link at its top right. */
function Panel({ id, title, sub, action, className = "", children }: { id: string; title: string; sub?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} data-testid={`home-${id}`} className={`card animate-rise flex min-w-0 flex-col rounded-2xl p-5 sm:p-6 ${className}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-h`} className="text-lg font-semibold leading-tight">{title}</h2>
          {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      <div className="mt-4 flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** "See all →" at a panel's top right. */
function PanelLink({ href, onClick, children }: { href?: string; onClick?: () => void; children: ReactNode }) {
  const cls = "inline-flex items-center gap-1 whitespace-nowrap rounded-md text-xs font-semibold text-accent hover:underline";
  const inner = (
    <>
      {children}
      <ArrowRight aria-hidden className="h-3.5 w-3.5" />
    </>
  );
  return href ? <Link href={href} className={cls}>{inner}</Link> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

// ---- Needs you ----------------------------------------------------------------------------------

const DOT: Record<NeedTone, string> = { danger: "bg-fill-danger", warn: "bg-amber-500", info: "bg-text/30" };
const TONE_WORD: Record<NeedTone, string> = { danger: "Urgent", warn: "Soon", info: "When you can" };

function NeedButton({ a, onOpen }: { a: NeedAction; onOpen: (t: Topic) => void }) {
  const cls = "btn-secondary inline-flex h-9 shrink-0 items-center gap-1.5 px-3 text-xs font-semibold";
  if ("topic" in a) {
    return <button type="button" className={cls} onClick={() => onOpen(a.topic)}>{a.label}</button>;
  }
  return a.external ? (
    <a className={cls} href={a.href} target="_blank" rel="noopener noreferrer">
      {a.label}
      <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <Link className={cls} href={a.href}>{a.label}</Link>
  );
}

/** The few things to do now (`needsOf`), worst first, or that there are none. */
export function NeedsYou({ needs, onOpen }: { needs: Need[]; onOpen: (t: Topic) => void }) {
  return (
    <section aria-labelledby="needs-h" data-testid="home-needs" className="card animate-rise rounded-2xl p-0">
      <h2 id="needs-h" className="px-5 pt-5 text-lg font-semibold leading-tight sm:px-6">Needs you</h2>
      {needs.length === 0 ? (
        <p className="flex items-center gap-2 px-5 pb-5 pt-3 text-sm text-muted sm:px-6" data-testid="needs-none">
          <CircleCheck aria-hidden className="h-4 w-4 shrink-0 text-good" strokeWidth={2.25} />
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border border-t border-border">
          {needs.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 sm:flex-nowrap sm:px-6" data-testid={`need-${n.id}`}>
              <span className="flex min-w-0 flex-1 items-start gap-3">
                <span aria-hidden className={`mt-[0.45rem] h-2 w-2 shrink-0 rounded-full ${DOT[n.tone]}`} />
                <span className="min-w-0 text-sm">
                  <span className="sr-only">{TONE_WORD[n.tone]}: </span>
                  {n.text}
                  {n.detail && <span className="mt-0.5 block text-xs leading-relaxed text-muted">{n.detail}</span>}
                </span>
              </span>
              {n.action && (
                <span className="ml-5 sm:ml-0">
                  <NeedButton a={n.action} onOpen={onOpen} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- The four numbers ---------------------------------------------------------------------------

/**
 * One of the four numbers: what it is, the figure, and its change on the dates compared with (or
 * `sub` in its place, for a figure with no earlier one). The test id is the full dashboard's
 * (`metric-<title>`), so a figure reads the same whichever Home is shown. Opens its details.
 */
export function NumberTile({
  title,
  value,
  delta,
  versus,
  compared,
  sub,
  extra,
  i = 0,
  onClick,
}: {
  title: string;
  value: ReactNode;
  delta?: number | null;
  versus?: string;
  compared?: string;
  sub?: ReactNode;
  extra?: ReactNode;
  i?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card lift animate-rise flex min-w-0 flex-col rounded-2xl p-4 text-left sm:p-5"
      style={{ ["--i" as string]: i }}
      data-testid={`metric-${title}`}
    >
      <span className="block truncate text-sm font-medium text-muted">{title}</span>
      <span className="mt-2 block truncate text-2xl font-bold tabular-nums tracking-tight sm:text-[1.9rem] sm:leading-10">{value}</span>
      <span className="mt-1.5 block min-w-0 text-xs text-muted">
        {sub ?? (
          <>
            <ChangeText value={delta} />
            {delta !== null && delta !== undefined && versus && (
              <span className="ml-1" title={compared}>
                {versus}
              </span>
            )}
          </>
        )}
      </span>
      {extra && <span className="mt-1.5 block min-w-0 text-xs text-muted">{extra}</span>}
      <span className="sr-only"> – open details</span>
    </button>
  );
}

// ---- Sales by day -------------------------------------------------------------------------------

/** One chart: total sales (net sales for a member not shown tax and shipping) each day of the dates. */
export function SalesByDay({ ov, currency }: { ov: Overview; currency: string }) {
  const s = ov.modules.sales_overview!;
  const total = s.current.totalSales !== undefined;
  const money = (n: number) => fmtMoney(n, currency);
  const what = total ? "Total sales" : "Net sales";
  return (
    <Panel id="sales-by-day" title="Sales by day" sub={`${what} each day, ${fmtRange(ov.range.from, ov.range.to)}.${ov.range.to === ov.today ? " Today is so far." : ""}`}>
      <LineChart
        days={s.series.map((d) => d.day)}
        series={[{ key: "sales", label: what, color: "var(--viz-cat-3)", values: s.series.map((d) => (total ? (d.totalSales ?? d.netSales) : d.netSales)) }]}
        bars
        today={ov.today}
        height={240}
        label={`${what} by day`}
        format={money}
        fmtAxis={(v) => fmtMoneyCompact(v, currency)}
      />
    </Panel>
  );
}

// ---- What changed -------------------------------------------------------------------------------

const HEALTH_DOT: Record<Health, string> = { attention: "bg-fill-danger", watch: "bg-amber-500", good: "bg-emerald-500", info: "bg-sky-500" };
const HEALTH_WORD: Record<Health, string> = { attention: "Needs attention", watch: "Keep an eye on", good: "Looking good", info: "For your info" };

/** The business health check's first three (worst first, `businessHealth`), each opening its details. */
export function WhatChanged({ ov, currency, onOpen, report }: { ov: Overview; currency: string; onOpen: (t: Topic) => void; report: boolean }) {
  const checks = businessHealth(ov, currency).slice(0, 3);
  return (
    <Panel id="what-changed" title="What changed" sub="What stands out for these dates." action={report ? <PanelLink onClick={() => onOpen("overview")}>See all</PanelLink> : undefined}>
      {checks.length === 0 ? (
        <p className="text-sm text-muted">Nothing to point out yet: this fills in once orders come in.</p>
      ) : (
        <ul className="space-y-2.5">
          {checks.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onOpen(c.topic)} className="flex w-full items-center gap-3 rounded-xl bg-text/[0.035] px-3.5 py-3 text-left transition-colors hover:bg-text/[0.06]" data-testid={`insight-${c.id}`}>
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${HEALTH_DOT[c.health]}`} />
                <span className="min-w-0 flex-1 text-sm leading-snug">
                  <span className="sr-only">{HEALTH_WORD[c.health]}: </span>
                  <span className="font-semibold">{c.area}</span> <span className="text-muted">·</span> {c.text}
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-accent">
                  See why
                  <ChevronRight aria-hidden className="h-3.5 w-3.5" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---- Working for you ----------------------------------------------------------------------------

/** Messages an automation handed to the provider in its last 30 days (test-only ones aren't sent). */
const sentOf = (a: HubAutomation) => a.last30Days.sent + a.last30Days.delivered + a.last30Days.undelivered;

const OFF_WORD: Partial<Record<HubAutomation["status"], string>> = { paused: "Paused", draft: "Off", pending_approval: "Waiting for approval", disabled: "Off" };

/**
 * The automations hub's own answer (GET .../automations, as /automations shows it): those on, with
 * what each sent in the last 30 days, and one that's off to look at. Turning one on asks to confirm,
 * so that is done on the Automations page.
 */
export function WorkingForYou() {
  const { path } = useHub();
  const { data, error } = useApi<OverviewResponse>(path(""));
  const all = data?.automations ?? [];
  const on = all.filter((a) => a.status === "active").sort((a, b) => sentOf(b) - sentOf(a));
  const off = all.filter((a) => a.status !== "active");
  const shown = on.slice(0, 4);
  const offShown = shown.length < 4 ? off.slice(0, 1) : [];
  const canCreate = !!data && (data.permissions.manage.sms || data.permissions.manage.email);
  return (
    <Panel id="working" title="Working for you" sub="Your automations, last 30 days." action={<PanelLink href="/automations">See all</PanelLink>}>
      {!data ? (
        error ? (
          <p className="text-sm text-muted">
            We couldn&apos;t load your automations.{" "}
            <Link href="/automations" className="font-medium text-accent hover:underline">Open Automations</Link>
          </p>
        ) : (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-10 rounded-lg" />)}
          </div>
        )
      ) : shown.length === 0 && offShown.length === 0 ? (
        <div className="text-sm text-muted">
          <p>No automations yet. They can confirm orders, send shipping updates and remind shoppers who left at checkout.</p>
          <Link href={canCreate ? "/automations/new" : "/automations"} className="btn-primary mt-3 inline-flex h-9 items-center px-3 text-xs">
            {canCreate ? "Set one up" : "Open Automations"}
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((a) => {
            const n = sentOf(a);
            return (
              <li key={`${a.channel}:${a.id}`} className="flex items-center gap-3 py-3 first:pt-0" data-testid="working-on">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{a.name}</span>
                  <span className="block text-xs text-muted">
                    {CHANNEL_NAME[a.channel]} · On{a.testMode ? " in test mode: messages are recorded, not sent" : ` · ${n ? `${fmtNum(n)} sent` : "nothing sent yet"}`}
                  </span>
                </span>
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
              </li>
            );
          })}
          {offShown.map((a) => (
            <li key={`${a.channel}:${a.id}`} className="flex items-center gap-3 py-3 first:pt-0" data-testid="working-off">
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{a.name}</span>
                <span className="block text-xs text-muted">
                  {CHANNEL_NAME[a.channel]} · {OFF_WORD[a.status] ?? "Off"}
                </span>
              </span>
              <Link href="/automations" className="btn-secondary inline-flex h-8 shrink-0 items-center px-3 text-xs font-semibold">Review</Link>
            </li>
          ))}
          {on.length > shown.length && <li className="pt-3 text-xs text-muted">and {fmtNum(on.length - shown.length)} more on</li>}
        </ul>
      )}
    </Panel>
  );
}

/** The bell's alerts for the Needs you list (`ws` null: not asked); null until they arrive, or if they can't be read. */
export function useHomeAlerts(ws: string | null): AlertView[] | null {
  const { data } = useApi<{ alerts: AlertView[] }>(ws ? `/workspaces/${ws}/alerts` : null);
  return data?.alerts ?? null;
}
