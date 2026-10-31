"use client";
import { Fragment } from "react";
import { CircleHelp, Pencil } from "lucide-react";
import { BUSINESS_EVENT_KIND_LABEL, type BusinessEvent } from "@app/shared/businessEvents";
import { SHEET_SECTION_LABEL, SHEET_SECTIONS, type SheetColumn, type SheetRow, type SheetTotals } from "@app/shared/sheet";
import { fmtSpan, plural } from "@/components/dashboard/format";
import { columnDates, columnLabel, EVENT_CHIP, fmtFigure } from "./sheetUi";

const LABEL_W = "w-[9.5rem] min-w-[9.5rem] max-w-[9.5rem] sm:w-[15rem] sm:min-w-[15rem] sm:max-w-[15rem]";
const TOTAL_LEFT = "left-[9.5rem] sm:left-[15rem]";
const CELL = "whitespace-nowrap px-3 py-2 text-right tabular-nums";

/**
 * The sheet: a row per figure, grouped as the owner's own spreadsheet would be (revenue, sales,
 * store performance, advertising), the days shown added up first, then a column per day, week or
 * month. The figure names and the total stay in view while the columns scroll; the business events
 * sit under each column's dates, and the pencil on a column marks a new one there.
 */
export function SheetTable({
  columns,
  rows,
  total,
  totalLabel,
  currency,
  adCurrency,
  today,
  canEdit,
  onAddEvent,
  onOpenEvent,
}: {
  columns: SheetColumn[];
  rows: SheetRow[];
  total: SheetTotals;
  totalLabel: string;
  currency: string;
  adCurrency: string;
  today: string;
  canEdit: boolean;
  onAddEvent: (from: string, to: string) => void;
  onOpenEvent: (e: BusinessEvent) => void;
}) {
  const sections = SHEET_SECTIONS.map((s) => ({ section: s, rows: rows.filter((r) => r.section === s && (r.value(total, null) !== undefined || columns.some((c) => r.value(c.totals, c.rolling) !== undefined))) })).filter(
    (s) => s.rows.length > 0,
  );
  const running = (c: SheetColumn) => c.from <= today && today <= c.to;

  return (
    <div className="card overflow-hidden p-0" data-testid="sheet">
      {/* On a phone the page scrolls down and the sheet sideways; from a tablet up the sheet scrolls both ways under its own headings. */}
      <div className="overflow-auto overscroll-x-contain sm:max-h-[calc(100dvh-9rem)]" tabIndex={0} role="region" aria-label="Profit sheet">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" className={`sticky left-0 top-0 z-30 border-b border-r border-border bg-surface px-3 py-2 text-left text-xs font-medium text-muted ${LABEL_W}`}>
                <span className="sr-only">Figure</span>
              </th>
              <th scope="col" className={`sticky top-0 z-30 border-b border-r border-border bg-surface px-3 py-2 text-right ${TOTAL_LEFT}`} data-testid="sheet-total-head">
                <span className="block text-xs font-medium text-muted">Total</span>
                <span className="block whitespace-nowrap font-semibold">{totalLabel}</span>
              </th>
              {columns.map((c, i) => {
                const label = columnLabel(c, i === 0 || c.key.endsWith("-01"));
                const part = c.shownDays < c.periodDays;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={`group sticky top-0 z-20 min-w-[6.5rem] border-b border-border px-3 py-2 text-right align-bottom ${running(c) ? "bg-accent/8" : c.events.length ? "bg-bg" : "bg-surface"}`}
                    title={`${columnDates(c)}${part ? ` (${c.shownDays} of ${c.periodDays} days shown)` : ""}`}
                    data-testid="sheet-col"
                    data-key={c.key}
                  >
                    <span className="flex items-center justify-end gap-1 text-xs font-medium text-muted">
                      {running(c) ? <span className="text-accent">{c.grain === "day" ? "Today" : "So far"}</span> : label.top}
                    </span>
                    <span className="flex items-center justify-end gap-1.5">
                      <span className="whitespace-nowrap font-semibold">{label.bottom}</span>
                      {canEdit && (
                        <button
                          type="button"
                          className="grid size-6 place-items-center rounded-md text-muted opacity-60 transition hover:bg-accent/10 hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => onAddEvent(c.from, c.to)}
                          aria-label={`Mark a business event on ${columnDates(c)}`}
                          title="Mark a business event on these days"
                          data-print-hide
                          data-testid="sheet-add-event"
                        >
                          <Pencil aria-hidden className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                    {part && <span className="block whitespace-nowrap text-[11px] font-normal text-muted">{plural(c.shownDays, "day")} shown</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {columns.some((c) => c.events.length) && (
              <tr data-testid="sheet-events-row">
                <th scope="row" className={`sticky left-0 z-10 border-b border-r border-border bg-surface px-3 py-2 text-left align-top text-xs font-semibold uppercase tracking-wide text-muted ${LABEL_W}`}>
                  Business events
                </th>
                <td className={`sticky z-10 border-b border-r border-border bg-surface px-3 py-2 text-right align-top text-xs text-muted ${TOTAL_LEFT}`}>{plural(new Set(columns.flatMap((c) => c.events.map((e) => e.id))).size, "event")}</td>
                {columns.map((c) => (
                  <td key={c.key} className="max-w-[10rem] border-b border-border px-2 py-1.5 align-top">
                    <span className="flex flex-col items-end gap-1">
                      {c.events.slice(0, 3).map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          className={`max-w-full truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 ${EVENT_CHIP[e.kind]}`}
                          title={`${e.title} · ${BUSINESS_EVENT_KIND_LABEL[e.kind]} · ${e.startsOn === e.endsOn ? columnDates({ from: e.startsOn, to: e.endsOn }) : fmtSpan(e.startsOn, e.endsOn, { year: true })}${e.note ? `\n${e.note}` : ""}`}
                          onClick={() => onOpenEvent(e)}
                          data-testid="sheet-event-chip"
                        >
                          {c.grain === "day" && e.startsOn < c.key && c.key !== columns[0]!.key ? "↳ " : ""}
                          {e.title}
                        </button>
                      ))}
                      {c.events.length > 3 && <span className="text-[11px] text-muted">+{c.events.length - 3} more</span>}
                    </span>
                  </td>
                ))}
              </tr>
            )}
            {sections.map(({ section, rows: list }) => (
              <Fragment key={section}>
                <tr>
                  <th scope="rowgroup" colSpan={2} className="sticky left-0 z-10 border-b border-border bg-text px-3 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-bg">
                    {SHEET_SECTION_LABEL[section]}
                  </th>
                  <td colSpan={columns.length} className="border-b border-border bg-text/90" />
                </tr>
                {list.map((r) => (
                  <tr key={r.id} className="group/row" data-testid={`sheet-row-${r.id}`}>
                    <th scope="row" className={`sticky left-0 z-10 border-b border-r border-border bg-surface px-3 py-2 text-left font-normal group-hover/row:bg-bg ${LABEL_W}`}>
                      <span className={`flex items-center gap-1.5 ${r.strong ? "font-semibold" : ""} ${r.format === "percent" || r.format === "times" ? "italic" : ""}`}>
                        <span className="min-w-0 truncate" title={r.label}>
                          {r.label}
                        </span>
                        <span className="shrink-0 cursor-help text-muted/70" title={r.help} aria-label={r.help} role="img">
                          <CircleHelp aria-hidden className="h-3.5 w-3.5" />
                        </span>
                      </span>
                    </th>
                    <td className={`sticky z-10 border-b border-r border-border bg-surface group-hover/row:bg-bg ${TOTAL_LEFT} ${CELL} ${r.strong ? "font-semibold" : "font-medium"}`} data-testid="sheet-total-cell">
                      <Figure value={fmtFigure(r.value(total, null), r.format, r.adCurrency ? adCurrency : currency)} />
                    </td>
                    {columns.map((c) => (
                      <td key={c.key} className={`border-b border-border group-hover/row:bg-bg ${CELL} ${r.strong ? "font-semibold" : ""} ${running(c) ? "bg-accent/5" : ""}`}>
                        <Figure value={fmtFigure(r.value(c.totals, c.rolling), r.format, r.adCurrency ? adCurrency : currency)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Figure({ value }: { value: string }) {
  return value === "—" ? <span className="text-muted/60">—</span> : <>{value}</>;
}
