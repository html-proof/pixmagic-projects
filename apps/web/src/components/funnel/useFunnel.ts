"use client";
import { COUNTRY_CODE, FUNNEL_DEVICES, VISITOR_KINDS, type FunnelDevice, type FunnelFilter, type VisitorKind } from "@app/shared/funnel";
import { SITE_SECTIONS, type SiteSection } from "@app/shared/journey";
import { TRAFFIC_SOURCES, type TrafficSource } from "@app/shared/traffic";
import { useApp } from "@/components/AppContext";
import { useQueryParam } from "@/components/advertising/useAdvertising";
import { useDateRange, type Shown } from "@/components/dashboard/DateRange";
import type { FunnelPageModule, Overview } from "@/components/dashboard/types";
import { apiHref, useLiveApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// What the Shopping Funnel page asks: the dashboard's dates (the same address-bar state as every
// dashboard page), the filter (?device=&visitor=&landing=&country=&source=, so a link reproduces the view),
// and the dashboard's own answer narrowed to the page (GET …/overview?parts=funnel,
// apps/api/src/routes/dashboard.ts). Every figure is worked out by the API, never here.
// ---------------------------------------------------------------------------

/** Visits arrive within a minute of a shopper browsing; the page looks again every minute. */
const LIVE_EVERY_MS = 60_000;

const isDevice = (v: string): v is FunnelDevice => (FUNNEL_DEVICES as readonly string[]).includes(v);
const isVisitor = (v: string): v is VisitorKind => (VISITOR_KINDS as readonly string[]).includes(v);
const isLanding = (v: string): v is SiteSection => (SITE_SECTIONS as readonly string[]).includes(v);
const isCountry = (v: string): v is string => COUNTRY_CODE.test(v);
const isSource = (v: string): v is TrafficSource => (TRAFFIC_SOURCES as readonly string[]).includes(v);

export type FunnelFilterKey = keyof FunnelFilter;

export function useFunnel() {
  const { workspace, store } = useApp();
  // Where the store's dates begin, from the store list (the API checks the same limits).
  const dates = useDateRange(store?.timezone ?? "UTC", { day: store?.startDay ?? null, created: !!store?.shopCreatedAt });
  const [device, setDevice] = useQueryParam("device", isDevice);
  const [visitor, setVisitor] = useQueryParam("visitor", isVisitor);
  const [landing, setLanding] = useQueryParam("landing", isLanding);
  const [country, setCountry] = useQueryParam("country", isCountry);
  const [source, setSource] = useQueryParam("source", isSource);
  const filter: FunnelFilter = { ...(device ? { device } : {}), ...(visitor ? { visitor } : {}), ...(landing ? { landing } : {}), ...(country ? { country } : {}), ...(source ? { source } : {}) };
  const setFilter = (key: FunnelFilterKey, value: string | null) => {
    if (key === "device") setDevice(value && isDevice(value) ? value : null);
    if (key === "visitor") setVisitor(value && isVisitor(value) ? value : null);
    if (key === "landing") setLanding(value && isLanding(value) ? value : null);
    if (key === "country") setCountry(value && isCountry(value) ? value : null);
    if (key === "source") setSource(value && isSource(value) ? value : null);
  };
  const clearFilter = () => {
    setDevice(null);
    setVisitor(null);
    setLanding(null);
    setCountry(null);
    setSource(null);
  };
  const filterQs = (Object.entries(filter) as Array<[string, string]>).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
  /** The question as the API takes it (…/overview?<query>, …/export?section=funnel&<query>). */
  const query = dates.asking ? `${dates.asking.qs}${filterQs}` : null;
  const path = store && query ? `/workspaces/${workspace.id}/stores/${store.id}/overview?${query}&parts=funnel` : null;
  const live = useLiveApi<Overview>(path, LIVE_EVERY_MS);
  // Never one store's figures under another store's name while switching.
  const ov = live.data && store && live.data.store.id === store.id ? live.data : null;
  const shown: Shown = ov && { range: ov.range, timezone: ov.store.timezone };
  return {
    dates,
    filter,
    filtered: filterQs !== "",
    setFilter,
    clearFilter,
    query,
    ov,
    /** The page's funnel, when the store has it (the visit-tracking permissions, and this member sees it). */
    funnel: (ov?.modules.funnel as FunnelPageModule | undefined) ?? null,
    shown,
    error: live.error,
    loading: live.loading,
    checkedAt: live.checkedAt,
    /** The figures on screen are still for the question asked before (new dates loading, or failing to). */
    older: ov !== null && live.dataPath !== path,
    exportHref: store && query ? apiHref(`/workspaces/${workspace.id}/stores/${store.id}/export?section=funnel&${query}`) : null,
    /** Ask again now rather than at the next minute. */
    refresh: () => window.dispatchEvent(new Event("insights:retry")),
  };
}

export type FunnelState = ReturnType<typeof useFunnel>;
