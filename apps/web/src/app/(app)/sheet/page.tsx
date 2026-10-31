"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { byStart, type BusinessEvent } from "@app/shared/businessEvents";
import { eventComparison } from "@app/shared/sheet";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { Skeleton } from "@/components/AppUi";
import { fmtRange, fmtSpan, plural } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { EventDialog, type EventDraft } from "@/components/sheet/EventDialog";
import { EventsPanel } from "@/components/sheet/EventsPanel";
import { SheetHeader } from "@/components/sheet/SheetHeader";
import { SheetTable } from "@/components/sheet/SheetTable";
import { columnDates, csvField, csvFigure } from "@/components/sheet/sheetUi";
import { useSheet, type SheetState } from "@/components/sheet/useSheet";
import { Alert, EmptyState } from "@/components/ui";
import { friendlyError, isTransient } from "@/lib/api";

/**
 * The Profit sheet: every figure bizinsights has for the store, a column per day, week or month,
 * with the team's business events on their days, and the days narrowed to some weekdays or to those
 * events (components/sheet/, docs/kpis.md "Profit sheet"). Every figure comes from the dashboard's
 * own answer (GET …/overview?parts=sheet), added up by @app/shared/sheet; nothing is estimated.
 */
export default function SheetPage() {
  const { storesStatus, stores, store, workspace } = useApp();
  if (storesStatus !== "ready") return <StoresPending />;
  if (!stores.length || !store) {
    return (
      <EmptyState
        title="Connect your store to see your profit sheet"
        body="Once your Shopify store is connected, this page lays out its sales, orders, visits and ad spend day by day, with your business events on their days."
        action={canManage(workspace.role) ? <Link className="btn-primary" href={`/onboarding?ws=${encodeURIComponent(workspace.id)}`}>Continue with Shopify</Link> : undefined}
      />
    );
  }
  // A store's own page: switching stores starts again (dates and filters stay in the address).
  return <SheetView key={store.id} />;
}

function SheetView() {
  const s = useSheet();
  const { workspace, store } = useApp();
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const { ov, sheet } = s;
  const base = store ? `/workspaces/${workspace.id}/stores/${store.id}` : "";
  const comparison = useMemo(() => (sheet ? eventComparison(sheet.days, s.events, s.weekdays) : null), [sheet, s.events, s.weekdays]);
  const totalLabel = ov && sheet ? (s.filtered ? plural(sheet.total.days, "day") : fmtSpan(ov.range.from, ov.range.to)) : "";

  const saved = (e: BusinessEvent) => s.setEventList([...s.events.filter((x) => x.id !== e.id), e].sort(byStart));
  const removed = (id: string) => {
    s.setEventList(s.events.filter((x) => x.id !== id));
    if (s.eventFilter === `event:${id}`) s.setEventFilter("all");
  };

  const download = sheet && ov && s.canExport ? () => downloadCsv(s, ov.store.currency) : null;

  return (
    <div className="space-y-5" data-print-root>
      <SheetHeader s={s} onAddEvent={() => ov && setDraft({ from: ov.range.to, to: ov.range.to })} onDownload={download} />

      {s.error && !ov && <LoadError what="your profit sheet" error={s.error} onRetry={s.refresh} busy={s.loading} />}
      {s.error && ov && s.older && (
        <Alert kind={isTransient(s.error) ? "info" : "error"}>
          Couldn&apos;t load {s.dates.asking?.label}, so the figures below are still for {fmtRange(ov.range.from, ov.range.to)}. {friendlyError(s.error)}
        </Alert>
      )}
      {!ov && !s.error && (
        <div className="card">
          <p className="sr-only" role="status">
            Loading your profit sheet…
          </p>
          <Skeleton lines={8} />
        </div>
      )}
      {s.eventsError && ov && <Alert kind="info">Couldn&apos;t load your business events, so the sheet shows its figures without them for now. {friendlyError(s.eventsError)}</Alert>}

      {ov && ov.store.status === "syncing" && <Alert kind="info">We&apos;re still importing your orders. The sheet fills in over the next few minutes.</Alert>}
      {ov && ov.store.status === "error" && <Alert kind="info">Syncing this store&apos;s orders has stopped, so its figures may be out of date. The dashboard says why and what fixes it.</Alert>}

      {ov && !sheet && <EmptyState title="Your sales aren't shared with you" body="The profit sheet is built on the store's sales. Ask an owner or admin for “View sales and revenue” in Team & Access." />}

      {ov && sheet && (
        <>
          {sheet.columns.length === 0 ? (
            <div className="card text-sm text-muted" data-testid="sheet-nothing-shown">
              No day in these dates matches the days picked.{" "}
              <button type="button" className="font-medium text-accent underline-offset-2 hover:underline" onClick={s.clearFilter}>
                Show every day
              </button>
            </div>
          ) : (
            <SheetTable
              columns={sheet.columns}
              rows={sheet.rows}
              total={sheet.total}
              totalLabel={totalLabel}
              currency={ov.store.currency}
              adCurrency={sheet.ads?.currency ?? ov.store.currency}
              today={ov.today}
              canEdit={s.canEdit}
              onAddEvent={(from, to) => setDraft({ from, to })}
              onOpenEvent={(e) => (s.canEdit ? setDraft({ event: e }) : s.setEventFilter(`event:${e.id}`))}
            />
          )}
          <Notes s={s} />
          {comparison && (
            <EventsPanel
              comparison={comparison}
              currency={ov.store.currency}
              comparable={sheet.comparable}
              visitsTracked={sheet.visitsTracked}
              canEdit={s.canEdit}
              filterEvent={s.eventFilter.startsWith("event:") ? s.eventFilter.slice(6) : null}
              onAdd={() => setDraft({ from: ov.range.to, to: ov.range.to })}
              onOpen={(e) => setDraft({ event: e })}
              onShowOnly={(e) => {
                s.setEventFilter(`event:${e.id}`);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          )}
        </>
      )}

      {ov && <EventDialog draft={draft} base={base} today={ov.today} onClose={() => setDraft(null)} onSaved={saved} onRemoved={removed} />}
    </div>
  );
}

/** What the sheet leaves out and why, in a line each: only what applies to this store and this member. */
function Notes({ s }: { s: SheetState }) {
  const { allowed } = useApp();
  const sheet = s.sheet!;
  const notes: string[] = [];
  if (!sheet.visitsTracked) notes.push("Store visits, and the rates worked out on them, need the bizinsights storefront pixel (Shopping Funnel), which this store doesn't share with you yet.");
  if (!sheet.ads && allowed("marketing.ads")) notes.push("Connect Meta Ads or Google Ads in Settings → Integrations to see your ad spend day by day beside your sales.");
  else if (sheet.ads && !sheet.comparable) notes.push(sheet.ads.demo ? "The Google Ads demo's figures are simulated, so they aren't set against your sales." : `Your ad accounts report in ${sheet.ads.currency}, not the store's ${s.ov!.store.currency}, so the spend isn't set against your sales.`);
  // Shopify's cost of goods sold comes for the dates whole, never by day; the owner's costs (Settings →
  // Costs) are taken off on the dashboard, not here.
  notes.push("The sheet stops at net sales less ad spend and never calls that profit: Shopify gives product costs only for the dates as a whole, not day by day, and your costs aren't taken off here. Business profit overview on the dashboard takes off the costs bizinsights knows.");
  return (
    <ul className="space-y-1 px-1 text-xs text-muted" data-testid="sheet-notes">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

const BOM = String.fromCharCode(0xfeff);

/** The sheet as on screen, a CSV the owner's spreadsheet opens: the figures as plain numbers, the events as a row. */
function downloadCsv(s: SheetState, currency: string) {
  const sheet = s.sheet!;
  const ov = s.ov!;
  const head = ["", `Total (${s.filtered ? plural(sheet.total.days, "day") : fmtRange(ov.range.from, ov.range.to)})`, ...sheet.columns.map((c) => (c.grain === "day" ? c.key : c.grain === "month" ? c.key : columnDates(c)))];
  const lines = [
    head,
    ["Business events", "", ...sheet.columns.map((c) => c.events.map((e) => e.title).join("; "))],
    ...sheet.rows.map((r) => [`${r.label}${r.format === "money" ? ` (${r.adCurrency ? (sheet.ads?.currency ?? currency) : currency})` : ""}`, csvFigure(r.value(sheet.total, null), r.format), ...sheet.columns.map((c) => csvFigure(r.value(c.totals, c.rolling), r.format))]),
  ];
  const text = lines.map((l) => l.map((v) => csvField(v)).join(",")).join("\r\n");
  // A byte order mark first, so Excel reads the file as UTF-8 (currency signs, accented names).
  const url = URL.createObjectURL(new Blob([BOM, `${text}\r\n`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `profit-sheet-${ov.range.from}-to-${ov.range.to}${sheet.grain === "day" ? "" : `-by-${sheet.grain}`}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
