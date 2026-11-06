"use client";
import { useEffect, useState } from "react";
import { CalendarPlus, Download, Printer, RefreshCw, Sheet, X } from "lucide-react";
import { BUSINESS_EVENT_KINDS, BUSINESS_EVENT_KIND_LABEL } from "@app/shared/businessEvents";
import { SHEET_GRAINS, WEEKDAY_SETS, type EventFilter, type SheetGrain } from "@app/shared/sheet";
import { useApp } from "@/components/AppContext";
import { CustomDates, DateRangeSelect } from "@/components/dashboard/DateRange";
import { fmtRange, fmtRelative, fmtSpan, weekdayNames } from "@/components/dashboard/format";
import type { SheetState } from "./useSheet";

const GRAIN_LABEL: Record<SheetGrain, string> = { day: "Days", week: "Weeks", month: "Months" };

/** Which preset the weekdays picked are, if any. */
function weekdayChoice(days: readonly number[]): "all" | "weekdays" | "weekends" | "pick" {
  if (!days.length) return "all";
  for (const [name, set] of Object.entries(WEEKDAY_SETS)) if (set.length === days.length && set.every((d, i) => d === days[i])) return name as "weekdays" | "weekends";
  return "pick";
}

/**
 * The sheet's title and what can be done with it: refresh, download and print, and adding a
 * business event. Its question (the dates, columns and days shown) is SheetControls', above the table.
 */
export function SheetHeader({ s, onAddEvent, onDownload }: { s: SheetState; onAddEvent: () => void; onDownload: (() => void) | null }) {
  const { store } = useApp();
  return (
    <header className="animate-rise">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="page-title flex items-center gap-2">
            <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-accent/12 text-accent">
              <Sheet className="h-[18px] w-[18px]" />
            </span>
            Profit sheet
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Whether your store is making money, day by day and month by month, and every figure for it in a column per day, week or month. Mark
            your business events on their days, then show only those days or set them against the rest.
          </p>
          {s.shown && (
            <p className="mt-1 hidden text-sm print:block">
              {store?.name ?? store?.shopDomain} · {fmtRange(s.shown.range.from, s.shown.range.to)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2" data-print-hide>
          {s.canEdit && (
            <button type="button" className="btn-primary h-9 gap-2 px-3 text-sm" onClick={onAddEvent} disabled={!s.ov} data-testid="sheet-new-event">
              <CalendarPlus aria-hidden className="h-4 w-4" />
              Add business event
            </button>
          )}
          <button type="button" className="btn-secondary h-9 gap-2 px-3 text-sm" onClick={s.refresh} disabled={s.loading} data-testid="sheet-refresh">
            <RefreshCw aria-hidden className={`h-4 w-4 ${s.loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {onDownload && (
            <button type="button" className="btn-secondary h-9 gap-2 px-3 text-sm" onClick={onDownload} data-testid="sheet-download-csv">
              <Download aria-hidden className="h-4 w-4" />
              Download CSV
            </button>
          )}
          <button type="button" className="btn-secondary h-9 gap-2 px-3 text-sm" onClick={() => window.print()}>
            <Printer aria-hidden className="h-4 w-4" />
            Print
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * The sheet's question: the store and the dates; the columns (days, weeks or months); which days it
 * shows (weekdays, and the business events on them); how current it is.
 */
export function SheetControls({ s }: { s: SheetState }) {
  const { stores, store, setStoreId } = useApp();
  const [now, setNow] = useState(() => Date.now());
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const ordersAsOf = fmtRelative(s.ov?.freshness?.asOf, now);
  const grain = s.sheet?.grain ?? s.by ?? "day";
  const choice = picking && weekdayChoice(s.weekdays) === "all" ? "pick" : weekdayChoice(s.weekdays);
  const names = weekdayNames("short");
  const longNames = weekdayNames("long");
  const eventsInRange = s.events;

  const toggleDay = (d: number) => {
    const next = s.weekdays.includes(d) ? s.weekdays.filter((x) => x !== d) : [...s.weekdays, d].sort();
    s.setWeekdays(next);
  };

  return (
    <section className="card animate-rise" aria-labelledby="sheet-controls-h">
      <h2 id="sheet-controls-h" className="font-semibold">
        The sheet
      </h2>
      <p className="mt-0.5 text-xs text-muted">Every figure for the dates you pick, a column per day, week or month.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2" data-print-hide>
        {stores.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Store
            <select className="input h-9 w-auto max-w-[14rem] py-0 text-sm" aria-label="Store" value={store?.id ?? ""} onChange={(e) => setStoreId(e.target.value)} data-testid="sheet-store">
              {stores.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name ?? x.shopDomain}
                </option>
              ))}
            </select>
          </label>
        )}
        <DateRangeSelect r={s.dates} shown={s.shown} id="sheet-dates" label="Dates" size="sm" />
        <div className="flex items-center rounded-lg border border-border bg-bg p-0.5" role="group" aria-label="Columns" data-testid="sheet-grain">
          {SHEET_GRAINS.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={grain === g}
              className={`h-8 rounded-md px-3 text-sm font-medium transition ${grain === g ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}
              onClick={() => s.setBy(g)}
            >
              {GRAIN_LABEL[g]}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 empty:hidden" data-print-hide>
        <CustomDates r={s.dates} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3" role="group" aria-label="Which days to show" data-print-hide>
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Days</span>
          <select
            className="input h-9 w-auto py-0 text-sm"
            aria-label="Days"
            value={choice}
            onChange={(e) => {
              const v = e.target.value;
              setPicking(v === "pick");
              s.setWeekdays(v === "weekdays" || v === "weekends" ? [...WEEKDAY_SETS[v]] : v === "pick" && choice !== "pick" ? s.weekdays : []);
            }}
            data-testid="sheet-days"
          >
            <option value="all">Every day</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekends">Weekends (Sat–Sun)</option>
            <option value="pick">Pick days of the week…</option>
          </select>
        </label>
        {choice === "pick" && (
          <span className="flex flex-wrap items-center gap-1" role="group" aria-label="Days of the week" data-testid="sheet-weekdays">
            {names.map((n, d) => {
              const on = s.weekdays.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  aria-label={longNames[d]}
                  className={`h-8 min-w-11 rounded-lg border px-2 text-xs font-medium transition ${on ? "border-accent bg-accent/12 text-accent" : "border-border text-muted hover:border-accent/40 hover:text-text"}`}
                  onClick={() => toggleDay(d)}
                >
                  {n}
                </button>
              );
            })}
          </span>
        )}
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Business events</span>
          <select className="input h-9 w-auto max-w-[16rem] py-0 text-sm" aria-label="Business events" value={s.eventFilter} onChange={(e) => s.setEventFilter(e.target.value as EventFilter)} data-testid="sheet-events">
            <option value="all">Every day</option>
            <option value="with">Days with an event</option>
            <option value="without">Days without events</option>
            <optgroup label="Days with an event of a kind">
              {BUSINESS_EVENT_KINDS.map((k) => (
                <option key={k} value={`kind:${k}`}>
                  {BUSINESS_EVENT_KIND_LABEL[k]}
                </option>
              ))}
            </optgroup>
            {(eventsInRange.length > 0 || s.eventFilter.startsWith("event:")) && (
              <optgroup label="The days of one event">
                {eventsInRange.map((e) => (
                  <option key={e.id} value={`event:${e.id}`}>
                    {e.title} ({e.startsOn === e.endsOn ? fmtSpan(e.startsOn, e.startsOn) : fmtSpan(e.startsOn, e.endsOn)})
                  </option>
                ))}
                {s.eventFilter.startsWith("event:") && !eventsInRange.some((e) => `event:${e.id}` === s.eventFilter) && <option value={s.eventFilter}>An event outside these dates</option>}
              </optgroup>
            )}
          </select>
        </label>
        {(s.filtered || picking) && (
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-muted hover:bg-bg hover:text-text"
            onClick={() => {
              setPicking(false);
              s.clearFilter();
            }}
            data-testid="sheet-clear-filter"
          >
            <X aria-hidden className="h-4 w-4" />
            Show every day
          </button>
        )}
      </div>

      <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" data-testid="sheet-freshness">
        {ordersAsOf && <span>Orders updated {ordersAsOf}</span>}
        <span>Days in the store&apos;s time zone ({store?.timezone ?? "UTC"})</span>
        <span>Weeks run Monday to Sunday</span>
      </p>
    </section>
  );
}
