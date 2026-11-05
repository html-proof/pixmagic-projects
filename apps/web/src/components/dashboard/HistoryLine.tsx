"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarRange, History, LoaderCircle } from "lucide-react";
import { addDays, ALL_HISTORY } from "@app/shared/dates";
import { fmtDay, fmtRange, plural } from "./format";
import type { Overview } from "./types";

/**
 * How far back the store's orders go, said beside the dates rather than folded away at the foot of
 * the page: picking 2024 on a store whose orders start in August 2026 otherwise reads as a year of
 * zero sales.
 *
 * Shopify shares the last 60 days of orders with an app until it holds read_all_orders, which a
 * public app gets only once Shopify approves it for the scope (docs/shopify-setup.md). So the line
 * says, in order: the dates shown (whole days in the store's time zone); from when the orders are in
 * and why not earlier; how a full history import is getting on, a year at a time; and, when the
 * dates reach back before the orders that are in, that those days are missing, not zero.
 */
export function HistoryLine({
  ov,
  loading,
  canManage,
  reconnectHref,
  onImportHistory,
  importing,
  brief = false,
}: {
  ov: Overview;
  /** The dates being loaded now, while the numbers below are still the previous dates'. */
  loading: string | null;
  canManage: boolean;
  reconnectHref: string;
  onImportHistory: () => void;
  importing: boolean;
  /**
   * The simple Home: its date chip says the dates and its foot how far back the orders go
   * (HistoryFoot), so only what can't wait: the dates loading, and days that weren't imported.
   */
  brief?: boolean;
}) {
  const d = ov.data;
  const { range } = ov;
  const history = d?.history;
  const historyFrom = d?.historyFrom ?? null;
  const whole = historyFrom === ALL_HISTORY;
  const years = history?.years ?? [];
  const done = years.filter((y) => y.status === "done");
  const reading = years.find((y) => y.status === "running" || y.status === "queued");
  const failed = years.find((y) => y.status === "failed");
  // From when the orders are in; the dates before that hold none because none were shared yet.
  const gap = historyFrom && !whole && range.from < historyFrom ? { from: range.from, to: range.to < historyFrom ? range.to : addDays(historyFrom, -1) } : null;

  if (brief && !loading && !gap) return null;
  return (
    <section aria-label="What the numbers cover" className="space-y-1.5 text-sm" data-testid="history-line">
      {brief && loading && (
        <p className="inline-flex items-center gap-1 text-accent" role="status" data-testid="dates-loading">
          <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> Loading {loading}…
        </p>
      )}
      {!brief && (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <CalendarRange aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.8} />
        <span>
          Showing <span className="font-medium text-text" data-testid="shown-dates">{fmtRange(range.from, range.to)}</span>, whole days in the store&apos;s time zone ({ov.store.timezone})
          {d?.createdDay ? <> · store created {fmtDay(d.createdDay)}</> : null}
        </span>
        {loading && (
          <span className="inline-flex items-center gap-1 text-accent" role="status" data-testid="dates-loading">
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> Loading {loading}…
          </span>
        )}
      </p>
      )}
      {history && !brief && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted" data-testid="history-availability">
          <History aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.8} />
          {history.access === "granted" ? (
            failed ? (
              <span className="text-warn">
                Importing {failed.year} from Shopify stopped. bizinsights tries again about every half hour while this page is open, carrying on from {failed.year}
                {done.length ? `; ${listYears(done.map((y) => y.year))} ${done.length === 1 ? "is" : "are"} in` : ""}.
              </span>
            ) : reading ? (
              <span>
                Importing your full order history from Shopify, newest first:{" "}
                {done.length ? `${listYears(done.map((y) => y.year))} ${done.length === 1 ? "is" : "are"} in, ` : ""}
                {reading.year} now ({done.length + 1} of {plural(years.length, "year")}). This page fills in by itself.
              </span>
            ) : whole ? (
              <span>
                Full order history: every order{d?.oldestOrderDay ? ` since ${fmtDay(d.oldestOrderDay)}` : ""}
                {done.length ? ` (${plural(done.reduce((a, y) => a + y.orders, 0), "order")} over ${plural(done.length, "year")})` : ""}.
              </span>
            ) : (
              <span>Your full order history is about to be imported from Shopify.</span>
            )
          ) : (
            <>
              <span>
                {historyFrom ? <>Orders from {fmtDay(historyFrom)} on: </> : null}
                Shopify shares only the last 60 days of orders with an app until the store grants it full order history.
              </span>
              {history.access === "requestable" && canManage && (
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onImportHistory} disabled={importing} data-testid="import-history">
                  {importing ? "Opening Shopify…" : "Import full history"}
                </button>
              )}
              {history.access === "reconnect" && canManage && (
                <Link className="btn-secondary inline-flex h-8 items-center px-3 text-xs" href={reconnectHref}>Reconnect to import full history</Link>
              )}
              {history.access === "awaiting_shopify" && <span>bizinsights can&apos;t ask for it yet: Shopify has to approve bizinsights for full order history first, so there&apos;s nothing to turn on.</span>}
            </>
          )}
        </p>
      )}
      {gap && (
        <p className="alert alert-info text-sm" data-testid="history-gap">
          {gap.to === range.to
            ? `No orders from these dates have been imported: Shopify shared orders from ${fmtDay(historyFrom)} on. These days show as not imported, not as days without sales.`
            : `Orders from ${fmtRange(gap.from, gap.to)} haven't been imported: Shopify shared orders from ${fmtDay(historyFrom)} on. Those days show as not imported, not as days without sales.`}
          {history?.access === "granted" && reading ? " Their year is still being imported." : ""}
        </p>
      )}
    </section>
  );
}

/**
 * The simple Home's foot (the Stitch design): how far back the orders go, in one centred line,
 * with the one thing to do about it: "Shopify shares your last 60 days of orders · Allow full
 * history". The same states as HistoryLine's, in fewer words.
 */
export function HistoryFoot({
  ov,
  canManage,
  reconnectHref,
  onImportHistory,
  importing,
}: {
  ov: Overview;
  canManage: boolean;
  reconnectHref: string;
  onImportHistory: () => void;
  importing: boolean;
}) {
  const d = ov.data;
  const history = d?.history;
  if (!history) return null;
  const years = history.years;
  const done = years.filter((y) => y.status === "done");
  const reading = years.find((y) => y.status === "running" || y.status === "queued");
  const failed = years.find((y) => y.status === "failed");
  const link = "font-medium text-accent hover:underline disabled:opacity-60";
  let words: ReactNode;
  if (history.access === "granted") {
    words = failed
      ? `Importing ${failed.year} from Shopify stopped: bizinsights tries again about every half hour while this page is open`
      : reading
        ? `Importing your full order history from Shopify: ${reading.year} now (${done.length + 1} of ${plural(years.length, "year")})`
        : d?.historyFrom === ALL_HISTORY
          ? `Full order history${d.oldestOrderDay ? `: every order since ${fmtDay(d.oldestOrderDay)}` : ""}`
          : "Your full order history is about to be imported from Shopify";
  } else {
    words = (
      <>
        Shopify shares your last 60 days of orders
        {history.access === "requestable" && canManage && (
          <>
            {" · "}
            <button type="button" className={link} onClick={onImportHistory} disabled={importing} data-testid="import-history">
              {importing ? "Opening Shopify…" : "Allow full history"}
            </button>
          </>
        )}
        {history.access === "reconnect" && canManage && (
          <>
            {" · "}
            <Link className={link} href={reconnectHref}>Reconnect to allow full history</Link>
          </>
        )}
        {history.access === "awaiting_shopify" && " · full history once Shopify approves bizinsights for it"}
      </>
    );
  }
  return (
    <p className="text-center text-[13px] text-muted" data-testid="history-availability">
      {words}
    </p>
  );
}

/** "2026", "2026 and 2025", "2026, 2025 and 2024": years newest first, a run of them shortened ("2026 to 2021"). */
function listYears(years: number[]): string {
  const ys = [...years].sort((a, b) => b - a);
  if (ys.length > 3 && ys[0]! - ys[ys.length - 1]! === ys.length - 1) return `${ys[0]} to ${ys[ys.length - 1]}`;
  if (ys.length === 1) return String(ys[0]);
  return `${ys.slice(0, -1).join(", ")} and ${ys[ys.length - 1]}`;
}
