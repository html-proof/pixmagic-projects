"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Download } from "lucide-react";
import type { AdProvider } from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { CompareDates, CompareSelect, CustomDates, DateRangeSelect, type DateRangeState, type Shown } from "@/components/dashboard/DateRange";
import { fmtRange } from "@/components/dashboard/format";
import type { Overview } from "@/components/dashboard/types";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { apiHref, friendlyError, isTransient } from "@/lib/api";
import type { AccountChoice, AdvertisingState } from "./useAdvertising";

// ---------------------------------------------------------------------------
// The pieces every Advertising page shares: its header (the dates, what they're compared with, the
// account picked, a download), the loading and failure states, and what to say with nothing connected.
// ---------------------------------------------------------------------------

export const PLATFORM: Record<AdProvider, { name: string; Icon: (p: { size?: number }) => ReactNode }> = {
  meta: { name: "Meta Ads", Icon: MetaIcon },
  google: { name: "Google Ads", Icon: GoogleIcon },
  adsense: { name: "Google AdSense", Icon: GoogleIcon },
};

/** The menu of the platform's accounts: all of them, or one. Only with two or more to pick from. */
export function AccountSelect({ accounts, value, onChange, all = "All accounts" }: { accounts: AccountChoice[]; value: string | null; onChange: (id: string | null) => void; all?: string }) {
  // One picked by a link that isn't among them (another store's, or one since hidden) still shows, so the menu says what's asked.
  if (accounts.length < 2 && !value) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      Account
      <select className="input h-9 w-auto max-w-[16rem] py-0 text-sm" aria-label="Ad account" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} data-testid="ad-account-filter">
        <option value="">{all}</option>
        {accounts.map((c) => (
          <option key={c.id} value={c.id}>
            {accounts.some((o) => o.provider !== c.provider) ? `${PLATFORM[c.provider].name}: ` : ""}
            {c.accountName ?? c.accountId}
            {c.demo ? " (demo)" : ""}
          </option>
        ))}
        {value && !accounts.some((c) => c.id === value) && <option value={value}>Another account</option>}
      </select>
    </label>
  );
}

/** A download of one report for the question on screen ("Export approved reports"; the API checks it too). */
export function DownloadCsv({ section, query, label = "Download CSV" }: { section: string; query: string | null; label?: string }) {
  const { workspace, store, allowed } = useApp();
  if (!allowed("reports.export") || !store || !query) return null;
  return (
    <a className="btn-secondary h-9 gap-2 px-3 text-sm sm:ml-auto" href={apiHref(`/workspaces/${workspace.id}/stores/${store.id}/export?section=${section}&${query}`)} download data-testid={`download-${section}`}>
      <Download aria-hidden className="h-4 w-4" />
      {label}
    </a>
  );
}

/** The page's title and its question: the dates, what they're compared with, and (`actions`) the account and a download. */
export function AdvertisingHeader({ title, icon, sub, r, shown, current, actions }: { title: string; icon?: ReactNode; sub: ReactNode; r: DateRangeState; shown: Shown; current: boolean; actions?: ReactNode }) {
  return (
    <div className="card animate-rise">
      <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        {icon}
        {title}
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">{sub}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <DateRangeSelect r={r} shown={shown} id="ad-dates" label="Dates" size="sm" />
        <CompareSelect r={r} shown={shown} current={current} id="ad-compare" label="Compare with" size="sm" />
        {actions}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 empty:hidden">
        <CustomDates r={r} />
        <CompareDates r={r} />
      </div>
    </div>
  );
}

/**
 * The page's figures once they're in: a skeleton while the first answer loads, the failure when it
 * can't (or, with older figures on screen, what they are for), then `children` with the answer.
 */
export function AdvertisingBody({ s, what, children }: { s: AdvertisingState; what: string; children: (ov: Overview) => ReactNode }) {
  const retry = () => window.dispatchEvent(new Event("insights:retry"));
  if (!s.ov) {
    if (s.error) return <LoadError what={what} error={s.error} onRetry={retry} busy={s.loading} />;
    return (
      <div className="space-y-4" aria-hidden>
        <p className="sr-only" role="status">Loading {what}…</p>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-28" />)}
        </div>
        <div className="skeleton h-72" />
      </div>
    );
  }
  return (
    <>
      {s.error && s.older && (
        <Alert kind={isTransient(s.error) ? "info" : "error"}>
          Couldn&apos;t load {s.dates.asking?.label}, so the figures below are still for {fmtRange(s.ov.range.from, s.ov.range.to)}. {friendlyError(s.error)}
        </Alert>
      )}
      {children(s.ov)}
    </>
  );
}

/** Nothing of this platform (or of any) connected to the store, or every account hidden: where that's changed. */
export function NotConnected({ ov, platform }: { ov: Overview; platform?: AdProvider }) {
  const { allowed } = useApp();
  const manage = allowed("integrations.manage");
  const n = ov.modules.ad_connections;
  const name = platform ? PLATFORM[platform].name : "advertising";
  const hidden = !!n && n.hidden > 0 && (platform ? n[platform] > 0 : n.meta + n.google + n.adsense > 0);
  const body = hidden
    ? `This store's ${platform ? `${name} ` : "ad "}accounts are hidden from the dashboard. ${manage ? "Turn on the ones that belong to this store to see their figures here." : "Ask a workspace owner or admin to turn them on."}`
    : platform === "adsense"
      ? `Connect Google AdSense to see what the ads on your site earn. Its earnings are money in, kept apart from what you spend on ads. ${manage ? "" : "Ask a workspace owner or admin to connect it."}`
      : `Connect ${platform ? name : "Meta Ads or Google Ads"} to see what you spend and what the platform credits to its ads. bizinsights only reads: it never changes your ads. ${manage ? "" : "Ask a workspace owner or admin to connect it."}`;
  return (
    <div data-testid="advertising-not-connected">
      <EmptyState
        title={hidden ? "Hidden from the dashboard" : platform ? `No ${name} account is connected to this store` : "No ad accounts are connected to this store"}
        body={body.trim()}
        action={
          manage ? (
            // One platform's page goes to its card; the overview, to every platform on Settings → Integrations.
            <Link className="btn-primary" href={hidden || platform ? "/settings/ads" : "/settings/integrations"}>
              {hidden ? "Manage ad accounts" : `Connect ${platform ? name : "advertising accounts"}`}
            </Link>
          ) : undefined
        }
      />
    </div>
  );
}

/** The account picked (by a link, or before another store was picked) has nothing here: back to all of them. */
export function AccountGone({ onClear }: { onClear: () => void }) {
  return (
    <div className="card flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="ad-account-gone">
      <span className="text-muted">The account picked isn&apos;t one of this store&apos;s accounts shown on the dashboard.</span>
      <button type="button" className="btn-secondary h-9" onClick={onClear}>
        Show every account
      </button>
    </div>
  );
}
