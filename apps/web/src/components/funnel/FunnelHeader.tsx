"use client";
import { useEffect, useState } from "react";
import { Download, Funnel, Printer, RefreshCw, X } from "lucide-react";
import { FUNNEL_DEVICES, FUNNEL_DEVICE_LABEL, VISITOR_KINDS, VISITOR_KIND_LABEL } from "@app/shared/funnel";
import { SITE_SECTIONS } from "@app/shared/journey";
import { hasFullAccess } from "@app/shared/access";
import { TRAFFIC_LABEL, TRAFFIC_SOURCES } from "@app/shared/traffic";
import { useApp } from "@/components/AppContext";
import { CompareDates, CompareSelect, CustomDates, DateRangeSelect, comparedWith } from "@/components/dashboard/DateRange";
import { fmtRange, fmtRelative } from "@/components/dashboard/format";
import { SECTION_LABEL } from "@/components/dashboard/Funnel";
import { countryName } from "./FunnelUi";
import type { FunnelFilterKey, FunnelState } from "./useFunnel";

/** The page's title and its question: the store, the dates and what they're compared with, the filter; how current it is; refresh and download. */
export function FunnelHeader({ s }: { s: FunnelState }) {
  const { stores, store, setStoreId, allowed, access } = useApp();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const f = s.funnel;
  const canExport = allowed("reports.export");
  const canPrint = canExport || hasFullAccess(access.role);
  const compared = comparedWith(s.shown);
  const lastVisit = fmtRelative(f?.lastEventAt, now);
  const ordersAsOf = fmtRelative(s.ov?.freshness?.asOf, now);
  const checked = s.checkedAt ? fmtRelative(new Date(s.checkedAt).toISOString(), now) : null;
  // The countries this answer has visits from, to pick one (and the one picked, whatever the answer).
  const countries = [...new Set([...(f?.segments.country.map((c) => c.key).filter((k) => /^[A-Z]{2}$/.test(k)) ?? []), ...(s.filter.country ? [s.filter.country] : [])])].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  // Likewise the traffic sources (only for members who see them: the answer then has the source segment).
  const sourceKeys = new Set([...(f?.segments.source?.map((x) => x.key) ?? []), ...(s.filter.source ? [s.filter.source] : [])]);
  const sources = TRAFFIC_SOURCES.filter((x) => x !== "unknown" && sourceKeys.has(x));

  const select = (key: FunnelFilterKey, label: string, value: string | undefined, options: Array<[string, string]>, all: string) => (
    <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
      <span className="shrink-0">{label}</span>
      <select className="input h-9 w-auto max-w-[12rem] py-0 text-sm" aria-label={label} value={value ?? ""} onChange={(e) => s.setFilter(key, e.target.value || null)} data-testid={`funnel-filter-${key}`}>
        <option value="">{all}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <header className="card animate-rise">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight sm:text-2xl">
            <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-accent/12 text-accent">
              <Funnel className="h-[18px] w-[18px]" />
            </span>
            Shopping Funnel
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">Understand how visitors become customers and identify where you lose potential sales.</p>
          {s.shown && (
            <p className="mt-1 hidden text-sm print:block">
              {store?.name ?? store?.shopDomain} · {fmtRange(s.shown.range.from, s.shown.range.to)}
              {compared ? ` · ${compared}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2" data-print-hide>
          <button type="button" className="btn-secondary h-9 gap-2 px-3 text-sm" onClick={s.refresh} disabled={s.loading} data-testid="funnel-refresh">
            <RefreshCw aria-hidden className={`h-4 w-4 ${s.loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {canExport && s.exportHref && (
            <a className="btn-secondary h-9 gap-2 px-3 text-sm" href={s.exportHref} download data-testid="funnel-download-csv">
              <Download aria-hidden className="h-4 w-4" />
              Download CSV
            </a>
          )}
          {canPrint && (
            <button type="button" className="btn-secondary h-9 gap-2 px-3 text-sm" onClick={() => window.print()}>
              <Printer aria-hidden className="h-4 w-4" />
              Print or save as PDF
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2" data-print-hide>
        {stores.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Store
            <select className="input h-9 w-auto max-w-[14rem] py-0 text-sm" aria-label="Store" value={store?.id ?? ""} onChange={(e) => setStoreId(e.target.value)} data-testid="funnel-store">
              {stores.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name ?? x.shopDomain}
                </option>
              ))}
            </select>
          </label>
        )}
        <DateRangeSelect r={s.dates} shown={s.shown} id="funnel-dates" label="Dates" size="sm" />
        <CompareSelect r={s.dates} shown={s.shown} current={!s.older} id="funnel-compare" label="Compare with" size="sm" />
      </div>
      <div className="mt-2 flex flex-wrap gap-2 empty:hidden" data-print-hide>
        <CustomDates r={s.dates} />
        <CompareDates r={s.dates} />
      </div>

      {f && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3" role="group" aria-label="Filter visits" data-print-hide>
          {select("device", "Device", s.filter.device, FUNNEL_DEVICES.map((d) => [d, FUNNEL_DEVICE_LABEL[d]]), "All devices")}
          {select("visitor", "Visitors", s.filter.visitor, VISITOR_KINDS.map((v) => [v, VISITOR_KIND_LABEL[v]]), "New and returning")}
          {select("landing", "Landed on", s.filter.landing, SITE_SECTIONS.map((x) => [x, SECTION_LABEL[x]]), "Any page")}
          {select("country", "Country", s.filter.country, countries.map((c) => [c, countryName(c)]), "All countries")}
          {f.segments.source && select("source", "Traffic source", s.filter.source, sources.map((x) => [x, TRAFFIC_LABEL[x]]), "All sources")}
          {s.filtered && (
            <button type="button" className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-muted hover:bg-bg hover:text-text" onClick={s.clearFilter} data-testid="funnel-clear-filter">
              <X aria-hidden className="h-4 w-4" />
              Clear filters
            </button>
          )}
        </div>
      )}

      <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" data-testid="funnel-freshness">
        {lastVisit && <span>Last tracked visit {lastVisit}</span>}
        {ordersAsOf && <span>Orders updated {ordersAsOf}</span>}
        {checked && <span>Checked {checked}</span>}
        <span>Days in the store&apos;s time zone ({store?.timezone ?? "UTC"})</span>
      </p>
    </header>
  );
}
