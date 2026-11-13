"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdProvider } from "@app/shared/ads";
import { useApp } from "@/components/AppContext";
import { refreshing } from "@/components/dashboard/AdsCommon";
import { useDateRange, type Shown } from "@/components/dashboard/DateRange";
import type { Overview } from "@/components/dashboard/types";
import { useApi, useLiveApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// What every Advertising page asks: the dashboard's dates (the same address-bar state, ?preset=&from=
// &to=, kept for the tab as on the dashboard), the platform and ad account picked
// (?platform=, ?account=), and the dashboard's own answer narrowed to the advertising modules
// (GET …/overview?parts=advertising, apps/api/src/routes/dashboard.ts). The figures are the
// dashboard's: worked out by the API, never here.
// ---------------------------------------------------------------------------

/**
 * The pages look again this often (the dashboard, every 15 s); while an account fetches its first days,
 * or a refresh someone asked for is on its way (`refreshing`), more often.
 */
const LIVE_EVERY_MS = 30_000;
const FETCHING_EVERY_MS = 5_000;

/**
 * One choice kept in the address bar beside the dates (?account=…), so a link reproduces the view;
 * `valid` keeps out what the page can't ask for.
 */
export function useQueryParam<T extends string>(name: string, valid: (v: string) => v is T): [T | null, (v: T | null) => void] {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get(name);
    if (q && valid(q)) setValue(q);
    // Read once, when the page opens; from then on the page's state leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  const choose = useCallback(
    (v: T | null) => {
      setValue(v);
      const url = new URL(window.location.href);
      if (v) url.searchParams.set(name, v);
      else url.searchParams.delete(name);
      // Replace rather than push, as the dates do: each pick isn't a page to go back through.
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
    },
    [name],
  );
  return [value, choose];
}

const isAccountId = (v: string): v is string => /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** A live report's drill-down in the address bar (dashboard/ReportDrill.tsx): the campaign opened, and its ad set or ad group. */
export const REPORT_DRILL_PARAMS = ["campaign", "adset", "adgroup"] as const;

/**
 * The ad account picked; one belongs to a store, so picking another store starts from all its accounts,
 * and from none of the other store's campaigns opened in a live report.
 */
function useAccountParam(storeId: string | undefined) {
  const [account, setAccount] = useQueryParam("account", isAccountId);
  const store = useRef(storeId);
  useEffect(() => {
    if (store.current !== undefined && storeId !== store.current) {
      setAccount(null);
      const url = new URL(window.location.href);
      for (const p of REPORT_DRILL_PARAMS) url.searchParams.delete(p);
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
    }
    store.current = storeId;
  }, [storeId, setAccount]);
  return [account, setAccount] as const;
}

/**
 * The question an Advertising page asks, without asking it: the dates, and the platform and account
 * picked. `query` is it as the API takes it (…/overview?<query>, …/export?section=…&<query>).
 */
export function useAdvertisingQuestion(platform?: AdProvider | null) {
  const { store } = useApp();
  const dates = useDateRange(store?.timezone ?? "UTC");
  const [account, setAccount] = useAccountParam(store?.id);
  const narrowed = `${platform ? `&platform=${platform}` : ""}${account ? `&account=${encodeURIComponent(account)}` : ""}`;
  return { dates, account, setAccount, query: dates.asking ? `${dates.asking.qs}${narrowed}` : null };
}

/** The Advertising answer for the question: every platform, or one (`platform`), and one account when one is picked. */
export function useAdvertising(platform?: AdProvider | null) {
  const { workspace, store } = useApp();
  const question = useAdvertisingQuestion(platform);
  const [every, setEvery] = useState(LIVE_EVERY_MS);
  const path = store && question.query ? `/workspaces/${workspace.id}/stores/${store.id}/overview?${question.query}&parts=advertising` : null;
  const live = useLiveApi<Overview>(path, every);
  // Never one store's figures under another store's name while switching.
  const ov = live.data && store && live.data.store.id === store.id ? live.data : null;
  const fetching = !!ov && [...(ov.modules.ads?.accounts ?? []), ...(ov.modules.adsense?.accounts ?? [])].some((a) => (a.status === "active" && !a.lastSyncedAt) || refreshing(a));
  useEffect(() => setEvery(fetching ? FETCHING_EVERY_MS : LIVE_EVERY_MS), [fetching]);
  const shown: Shown = ov && { range: ov.range, timezone: ov.store.timezone };
  return {
    ...question,
    shown,
    ov,
    error: live.error,
    loading: live.loading,
    /** The figures on screen are still for the question asked before (new dates loading, or failing to). */
    older: ov !== null && live.dataPath !== path,
  };
}

export type AdvertisingState = ReturnType<typeof useAdvertising>;

/** One connected ad account, as the account menus list it (GET …/ads, apps/api/src/routes/ads.ts). */
export interface AccountChoice {
  id: string;
  provider: AdProvider;
  accountId: string;
  accountName: string | null;
  enabled: boolean;
  demo?: boolean;
}

/** The accounts shown on the store's dashboard for these platforms, to pick one from. */
export function useAccountChoices(platforms: readonly AdProvider[]) {
  const { workspace, store } = useApp();
  const { data } = useApi<{ connections: AccountChoice[] }>(store ? `/workspaces/${workspace.id}/stores/${store.id}/ads` : null);
  return (data?.connections ?? []).filter((c) => c.enabled && platforms.includes(c.provider));
}
