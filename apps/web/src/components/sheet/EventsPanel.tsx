"use client";
import type { ReactNode } from "react";
import { CalendarPlus, Filter, Pencil } from "lucide-react";
import { BUSINESS_EVENT_KIND_LABEL, type BusinessEvent } from "@app/shared/businessEvents";
import { changeFrom, perDay, type EventComparison, type SheetFigure, type SheetTotals } from "@app/shared/sheet";
import { fmtSpan, plural } from "@/components/dashboard/format";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { EVENT_DOT } from "./sheetUi";

const ratio = (a: SheetFigure, b: SheetFigure) => (a === undefined || a === null || b === undefined || b === null || b === 0 ? null : a / b);

/** The few figures an event's days are set against the other days on: a day's net sales and orders, conversion, ads' share. */
function measures(t: SheetTotals, comparable: boolean) {
  return {
    sales: perDay(t.netSales, t),
    orders: perDay(t.orders, t),
    conversion: ratio(t.orders, t.visits),
    adsShare: comparable ? ratio(t.adSpend, t.netSales) : undefined,
  };
}

function Change({ now, before }: { now: SheetFigure; before: SheetFigure }) {
  const c = changeFrom(now, before);
  if (c === null) return null;
  const up = c >= 0;
  return (
    <span className={`ml-1 text-xs font-medium ${up ? "text-good" : "text-danger"}`} title="Against an average day without events">
      {up ? "▲" : "▼"} {fmtPct(Math.abs(c))}
    </span>
  );
}

/**
 * The business events of the dates on screen and what their days did: a day with an event against
 * a day without one (net sales, orders, conversion, ads' share of sales), then each event's own days.
 * Only the store's own figures, added up over those days (@app/shared/sheet eventComparison): no
 * estimate of what the event caused, which the days alone can't tell.
 */
export function EventsPanel({
  comparison,
  currency,
  comparable,
  visitsTracked,
  canEdit,
  filterEvent,
  onAdd,
  onOpen,
  onShowOnly,
}: {
  comparison: EventComparison;
  currency: string;
  comparable: boolean;
  visitsTracked: boolean;
  canEdit: boolean;
  filterEvent: string | null;
  onAdd: () => void;
  onOpen: (e: BusinessEvent) => void;
  onShowOnly: (e: BusinessEvent) => void;
}) {
  const { withEvents, withoutEvents, events } = comparison;
  const on = withEvents ? measures(withEvents, comparable) : null;
  const off = withoutEvents ? measures(withoutEvents, comparable) : null;

  return (
    <section className="card animate-rise" aria-labelledby="events-heading" data-testid="sheet-events-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="events-heading" className="text-base font-semibold">
            Business events in these dates
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">The days of your sales, campaigns, launches and holidays against the days without any: the store&apos;s own figures, a day at a time.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn-secondary h-9 gap-2 px-3 text-sm" onClick={onAdd} data-print-hide>
            <CalendarPlus aria-hidden className="h-4 w-4" />
            Add event
          </button>
        )}
      </div>

      {!events.length ? (
        <p className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted" data-testid="sheet-no-events">
          No business events in these dates yet.{" "}
          {canEdit ? "Mark a sale, an ad campaign, a launch or a holiday with the pencil on its day in the sheet, or with Add event; then show only its days, or compare them with the rest here." : "Someone with access to the sales can mark them."}
        </p>
      ) : (
        <>
          {on && off && withEvents && withoutEvents && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="sheet-event-comparison">
              <Stat label="Net sales a day" on={fmtMoney(on.sales ?? null, currency)} off={fmtMoney(off.sales ?? null, currency)} change={<Change now={on.sales} before={off.sales} />} />
              <Stat label="Orders a day" on={fmtNum(on.orders === undefined || on.orders === null ? null : Math.round(on.orders * 10) / 10)} off={fmtNum(off.orders === undefined || off.orders === null ? null : Math.round(off.orders * 10) / 10)} change={<Change now={on.orders} before={off.orders} />} />
              {visitsTracked && <Stat label="Conversion rate" on={fmtPct(on.conversion)} off={fmtPct(off.conversion)} change={<Change now={on.conversion} before={off.conversion} />} />}
              {on.adsShare !== undefined && <Stat label="Ads as share of sales" on={fmtPct(on.adsShare)} off={fmtPct(off.adsShare ?? null)} />}
              <p className="text-xs text-muted sm:col-span-2 lg:col-span-4">
                {plural(withEvents.days, "day")} with an event, {plural(withoutEvents.days, "day")} without. A day with an event can differ for other reasons too (a weekend, a month&apos;s end), so read it beside the sheet.
              </p>
            </div>
          )}

          <ul className="mt-4 divide-y divide-border rounded-xl border border-border" data-testid="sheet-event-list">
            {events.map(({ event: e, totals }) => {
              const m = measures(totals, comparable);
              return (
                <li key={e.id} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${filterEvent === e.id ? "bg-accent/5" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${EVENT_DOT[e.kind]}`} />
                      <span className="truncate">{e.title}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {BUSINESS_EVENT_KIND_LABEL[e.kind]} · {fmtSpan(e.startsOn, e.endsOn, { year: true })}
                      {totals.days > 0 ? ` · ${plural(totals.days, "day")} in these dates` : ""}
                    </p>
                    {e.note && <p className="mt-1 line-clamp-2 text-xs text-muted">{e.note}</p>}
                  </div>
                  <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    <div>
                      <dt className="text-xs text-muted">Net sales a day</dt>
                      <dd className="font-semibold tabular-nums">
                        {fmtMoney(m.sales ?? null, currency)}
                        {off && <Change now={m.sales} before={off.sales} />}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Orders</dt>
                      <dd className="font-semibold tabular-nums">{fmtNum(totals.orders)}</dd>
                    </div>
                    {visitsTracked && (
                      <div>
                        <dt className="text-xs text-muted">Conversion</dt>
                        <dd className="font-semibold tabular-nums">{fmtPct(m.conversion)}</dd>
                      </div>
                    )}
                    {m.adsShare !== undefined && (
                      <div>
                        <dt className="text-xs text-muted">Ads share</dt>
                        <dd className="font-semibold tabular-nums">{fmtPct(m.adsShare)}</dd>
                      </div>
                    )}
                  </dl>
                  <span className="flex gap-1" data-print-hide>
                    <button type="button" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:bg-bg hover:text-text" onClick={() => onShowOnly(e)} aria-label={`Show only the days of ${e.title}`}>
                      <Filter aria-hidden className="h-3.5 w-3.5" />
                      Only its days
                    </button>
                    {canEdit && (
                      <button type="button" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:bg-bg hover:text-text" onClick={() => onOpen(e)} aria-label={`Change ${e.title}`}>
                        <Pencil aria-hidden className="h-3.5 w-3.5" />
                        Change
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function Stat({ label, on, off, change }: { label: string; on: string; off: string; change?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-bg/60 px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">
        {on}
        {change}
      </p>
      <p className="text-xs text-muted">
        Event days, against <span className="tabular-nums">{off}</span> on other days
      </p>
    </div>
  );
}
