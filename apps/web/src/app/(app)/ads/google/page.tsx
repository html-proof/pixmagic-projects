"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StoresPending, useApp } from "@/components/AppContext";
import { CompareDates, CompareSelect, CustomDates, DateRangeSelect, useDateRange, type Shown } from "@/components/dashboard/DateRange";
import { fmtRelative } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { GoogleIcon } from "@/components/BrandIcons";
import { CampaignsSection } from "@/components/ads/google/Campaigns";
import { CombinedSection } from "@/components/ads/google/Combined";
import { ConversionsSection } from "@/components/ads/google/Conversions";
import { OverviewSection } from "@/components/ads/google/Overview";
import { RecommendationsSection } from "@/components/ads/google/Recommendations";
import { SpendingSection } from "@/components/ads/google/Spending";
import { AudienceSection, DevicesSection } from "@/components/ads/google/Splits";
import { DemoDataBadge } from "@/components/ads/google/ui";
import { api, useApi } from "@/lib/api";
import type { GoogleAdsAnalytics, GoogleAdsStatus } from "@/lib/googleAds";

// ---------------------------------------------------------------------------
// Google Ads Analytics: one Google Ads connection's figures for the dates picked, in seven sections
// (docs/ads-demo.md). The demo (simulated) by default, a real account when the store has one: the
// same page, the same figures from the same stored days; the DEMO DATA badge and the disclaimer
// appear on every section whose figures are simulated, and the combined demo-store section only
// for the demo. The dates live in the address bar, as on the dashboard.
// ---------------------------------------------------------------------------

/** While the account is fetching its first days (or a sync someone asked for), look again this often. */
const SYNCING_EVERY_MS = 5_000;

export default function GoogleAdsAnalyticsPage() {
  const { workspace, store, storesStatus, allowed } = useApp();
  const r = useDateRange(store?.timezone ?? "UTC");
  const base = store ? `/workspaces/${workspace.id}/stores/${store.id}/ads/google` : null;
  const status = useApi<GoogleAdsStatus>(base ? `${base}/status` : null);
  // Which connection: ?connection= in the address, else the demo, else the first real account.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("connection");
    if (q && /^[A-Za-z0-9_-]{1,64}$/.test(q)) setPicked(q);
  }, []);
  const choices = status.data ? [...(status.data.demo.connection ? [status.data.demo.connection] : []), ...status.data.production.connections] : [];
  const chosen = (picked && choices.find((c) => c.id === picked)?.id) || status.data?.demo.connection?.id || status.data?.production.connections[0]?.id || null;
  const dates = r.asking?.qs ?? null;
  const path = base && dates && chosen ? `${base}/analytics?${dates}&connection=${encodeURIComponent(chosen)}` : null;
  const analytics = useApi<GoogleAdsAnalytics>(path);
  const { reload, setData } = analytics;
  const a = analytics.data;
  const syncing = a?.account.status === "demo_syncing" || (!!a && !a.account.lastSyncedAt);
  // A first sync on its way: the figures fill in by themselves.
  useEffect(() => {
    if (!syncing || !path) return;
    const t = window.setInterval(() => {
      api<GoogleAdsAnalytics>(path)
        .then((v) => setData(v))
        .catch(() => undefined);
    }, SYNCING_EVERY_MS);
    return () => window.clearInterval(t);
  }, [syncing, path, setData]);

  if (storesStatus !== "ready") return <StoresPending />;
  if (!store || !base) {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">Google Ads Analytics</h1>
        <p className="mt-1 text-sm text-muted">Connect a Shopify store first; ad accounts are connected to a store.</p>
      </div>
    );
  }
  const demo = !!a?.account.demo;
  const currency = a?.account.currency ?? store.currency;
  const shown: Shown = a ? { range: a.range, previous: a.previous, timezone: a.account.timezone ?? store.timezone } : null;
  const types = [...new Set((a?.campaigns ?? []).map((c) => c.type).filter((t): t is string => !!t))];
  const statuses = [...new Set((a?.campaigns ?? []).map((c) => c.status).filter((s): s is string => !!s))];
  const manage = allowed("integrations.manage");

  return (
    <div className="space-y-4">
      <div className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              <GoogleIcon size={20} />
              Google Ads Analytics
              {demo && <DemoDataBadge />}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {a
                ? demo
                  ? `${a.account.name ?? a.account.accountId} · ${a.account.accountId} · simulated by bizinsights, not verified by Google · in ${currency}`
                  : `${a.account.name ?? a.account.accountId} · ${a.account.accountId} · in ${currency}`
                : "Spend, clicks, conversions and campaigns for one Google Ads account."}
              {a?.account.lastSyncedAt ? ` · figures updated ${fmtRelative(a.account.lastSyncedAt)}` : ""}
            </p>
            {a?.disclaimer && (
              <p className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" data-testid="ga-disclaimer">
                {a.disclaimer}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {choices.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-muted">
                Account
                <select className="input h-9 w-auto py-0 text-sm" value={chosen ?? ""} onChange={(e) => setPicked(e.target.value)} data-testid="ga-account">
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.demo ? `${c.accountName ?? c.accountId} (demo)` : (c.accountName ?? c.accountId)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <DateRangeSelect r={r} shown={shown} id="ga-dates" label="Dates" size="sm" />
            <CompareSelect r={r} shown={shown} current={!!a} id="ga-compare" label="Compare with" size="sm" />
            {manage && (
              <Link className="btn-secondary h-9" href="/settings/ads">
                Manage
              </Link>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <CustomDates r={r} />
          <CompareDates r={r} />
        </div>
      </div>

      {status.error && !status.data ? (
        <LoadError what="your Google Ads accounts" error={status.error} onRetry={() => void status.reload()} busy={status.loading} />
      ) : status.data && !chosen ? (
        <EmptyState
          title="No Google Ads account is connected to this store"
          body={status.data.demo.enabled ? "Connect a real Google Ads account, or try the demo: a simulated account that needs no Google sign-in and spends nothing." : "Connect a Google Ads account in Settings → Advertising."}
          action={
            manage ? (
              <Link className="btn-primary" href="/settings/ads">
                {status.data.demo.enabled ? "Connect Google Ads or try the demo" : "Connect Google Ads"}
              </Link>
            ) : undefined
          }
        />
      ) : analytics.error && !a ? (
        <LoadError what="the Google Ads analytics" error={analytics.error} onRetry={() => void reload()} busy={analytics.loading} />
      ) : !a ? (
        <div className="card">
          <div className="skeleton h-40" aria-hidden="true" />
        </div>
      ) : (
        <>
          {syncing && (
            <Alert kind="info">
              <span className="inline-flex items-center gap-2" data-testid="ga-syncing">
                <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {demo ? "Generating the demo's figures" : "Fetching this account's figures"}: they fill in within a minute or two, and this page updates by itself.
              </span>
            </Alert>
          )}
          {!a.coverage.complete && !syncing && (
            <Alert kind="info">
              {a.coverage.through
                ? `This account has figures from ${a.coverage.from} to ${a.coverage.through}: days outside that aren't counted in these totals.`
                : "Nothing has been stored for this account yet."}
            </Alert>
          )}
          <OverviewSection current={a.overview.current} deltas={a.overview.deltas} previous={a.overview.previous} currency={currency} demo={demo} compared={a.overview.previous ? a.previous : null} />
          {a.campaigns ? (
            <CampaignsSection base={base} dates={`${dates}&connection=${encodeURIComponent(chosen!)}`} currency={currency} demo={demo} types={types} statuses={statuses} />
          ) : (
            <p className="text-sm text-muted">Campaign figures need the &ldquo;View campaigns&rdquo; permission.</p>
          )}
          <SpendingSection series={a.series} campaigns={a.campaigns} currency={currency} demo={demo} today={a.today} range={a.range} />
          <ConversionsSection series={a.conversions.series} top={a.conversions.top} currency={currency} demo={demo} today={a.today} range={a.range} />
          <DevicesSection devices={a.devices} currency={currency} demo={demo} range={a.range} note={a.audience.note} />
          <AudienceSection audience={a.audience} currency={currency} demo={demo} range={a.range} />
          <RecommendationsSection recommendations={a.recommendations} demo={demo} />
          {a.combined && <CombinedSection days={a.combined.days} totals={a.combined.totals} note={a.combined.note} campaigns={a.campaigns} daily={a.series.day} currency={currency} today={a.today} range={a.range} />}
          {!demo && (
            <p className="text-xs text-muted">
              A real account&apos;s spend is set against your store&apos;s own sales on the{" "}
              <Link className="text-accent underline" href="/dashboard?view=ads">
                dashboard&apos;s Marketing panel
              </Link>
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}
