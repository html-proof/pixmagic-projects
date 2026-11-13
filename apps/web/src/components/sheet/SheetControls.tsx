"use client";
import { useEffect, useState } from "react";
import { CalendarPlus, Download, RefreshCw, Sheet, X } from "lucide-react";
import { BUSINESS_EVENT_KINDS, BUSINESS_EVENT_KIND_LABEL } from "@app/shared/businessEvents";
import { WEEKDAY_SETS, type EventFilter } from "@app/shared/sheet";
import { useApp } from "@/components/AppContext";
import { fmtRelative, fmtSpan, weekdayNames } from "@/components/dashboard/format";
import type { SheetState } from "./useSheet";

/** Which preset the weekdays picked are, if any. */
function weekdayChoice(days: readonly number[]): "all" | "weekdays" | "weekends" | "pick" {
  if (!days.length) return "all";
  for (const [name, set] of Object.entries(WEEKDAY_SETS)) if (set.length === days.length && set.every((d, i) => d === days[i])) return name as "weekdays" | "weekends";
  return "pick";
}

/**
 * The head of the day-by-day sheet on Profit & Loss (its Detailed Table): what it is, adding a
 * business event, refreshing and downloading it, and which days it shows (weekdays, and the business
 * events on them). Its dates and its columns (days, weeks or months) are the page's own, at the top.
 */
export function SheetControls({ s, onAddEvent, onDownload }: { s: SheetState; onAddEvent: () => void; onDownload: (() => void) | null }) {
  const { store } = useApp();
  const [now, setNow] = useState(() => Date.now());
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const ordersAsOf = fmtRelative(s.ov?.freshness?.asOf, now);
  const choice = picking && weekdayChoice(s.weekdays) === "all" ? "pick" : weekdayChoice(s.weekdays);
  const names = weekdayNames("short");
  const longNames = weekdayNames("long");
  const eventsInRange = s.events;

  const toggleDay = (d: number) => {
    const next = s.weekdays.includes(d) ? s.weekdays.filter((x) => x !== d) : [...s.weekdays, d].sort();
    s.setWeekdays(next);
  };

  return (
    <section className="home-card animate-rise p-5 sm:p-6" aria-labelledby="sheet-controls-h">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
            <Sheet className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="sheet-controls-h" className="home-h2">
              Day-by-Day Sheet
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted">Every figure for these dates in a column per day, week or month. Mark your business events on their days, then show only those days or set them against the rest.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-print-hide>
          {s.canEdit && (
            <button type="button" className="home-btn border border-home-line bg-surface" onClick={onAddEvent} disabled={!s.ov} data-testid="sheet-new-event">
              <CalendarPlus aria-hidden className="h-4 w-4" />
              Add business event
            </button>
          )}
          <button type="button" className="home-btn border border-home-line bg-surface" onClick={s.refresh} disabled={s.loading} data-testid="sheet-refresh">
            <RefreshCw aria-hidden className={`h-4 w-4 ${s.loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {onDownload && (
            <button type="button" className="home-btn border border-home-line bg-surface" onClick={onDownload} data-testid="sheet-download-csv">
              <Download aria-hidden className="h-4 w-4" />
              Download CSV
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-home-line pt-4" role="group" aria-label="Which days to show" data-print-hide>
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
