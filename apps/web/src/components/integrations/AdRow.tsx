"use client";
import { FlaskConical } from "lucide-react";
import type { StoreSummary } from "@/components/AppContext";
import { friendlyError } from "@/lib/api";
import { accountLabel, adLoginOf, stateInfo, type AdConnection, type AdProvider, type AdState } from "@/lib/adConnections";
import { loginOfPlatform, loginWords } from "../settings/ads/LoginPanel";
import { AD_PLATFORMS } from "./adPlatforms";
import { ConnectButton, IntegrationRow, ManageLink, RowPill } from "./IntegrationRow";
import type { useAdConnections } from "./useAdConnections";

// ---------------------------------------------------------------------------
// An ad platform's row on Settings → Integrations (Google Ads, Meta Ads, Google AdSense): where it
// stands, one button that opens the platform's own sign-in, and the accounts connected. Everything
// about single accounts (refresh, hide, sites, disconnect) stays on Settings → Advertising, behind
// Manage.
// ---------------------------------------------------------------------------

type Ads = ReturnType<typeof useAdConnections>;

/** A state that has an account waiting for someone: the row's button goes to where it's fixed. */
const ATTENTION: ReadonlySet<AdState> = new Set(["reconnect_required", "authorization_required", "permission_missing", "sync_failed", "verification_pending"]);

/** What each platform does for a store, in the row under its name. */
const SUB: Record<AdProvider, string> = {
  google: "Get campaign performance, spend, conversions and more directly from your Google Ads account.",
  meta: "Track your Facebook and Instagram ad performance, audience insights and more.",
  adsense: "View your earnings, sites and performance data from Google AdSense.",
};

/** Where a row stands: its platform's state (lib/adConnections.ts, platformState), or "Not connected" without a store. */
export function rowState(ads: Ads, store: StoreSummary | null, p: AdProvider): { state: AdState; demo: boolean } {
  if (!store) return { state: "not_connected", demo: false };
  const v = ads.view(p);
  return { state: v.state, demo: v.demo };
}

/** "Brand Search", "Brand Search +2 more", with "(demo)" for the simulated one. */
function accountsLine(list: AdConnection[]): string {
  const first = list[0]!;
  return `${accountLabel(first)}${first.demo ? " (demo)" : ""}${list.length > 1 ? ` +${list.length - 1} more` : ""}`;
}

export function AdRow({ provider: p, ads, store, manage }: { provider: AdProvider; ads: Ads; store: StoreSummary | null; manage: boolean }) {
  const P = AD_PLATFORMS[p];
  const answer = ads.answer;
  const canAct = manage && !!store && !!answer;
  const mine = ads.connections.filter((c) => c.provider === p);
  const { state, demo } = rowState(ads, store, p);
  const s = stateInfo(state, demo);
  const configured = !!answer?.configured[p];
  // The Google Ads demo: offered by this server while none is connected.
  const demoOffered = p === "google" && !!answer?.demo?.google && !mine.some((c) => c.demo);
  const leaving = ads.leaving === p;
  const connect = () => void ads.connect(p);
  const tryDemo = () => ads.openDemo();

  // Signed in with no ad account yet: connected, its accounts follow by themselves.
  const login = mine.length ? null : adLoginOf(answer, p);

  const action =
    mine.length > 0 || login ? (
      <ManageLink name={P.name} href="/settings/ads" attention={ATTENTION.has(state)} />
    ) : canAct && configured ? (
      <ConnectButton name={P.name} onClick={connect} disabled={!!ads.busy} busy={leaving ? P.opening : null} testid={`int-${p}-connect`} />
    ) : canAct && demoOffered ? (
      // Nothing real to sign in to on this server: the demo is the only thing to press.
      <ConnectButton name={P.name} onClick={tryDemo} disabled={!!ads.busy} testid="int-google-try-demo" icon={FlaskConical}>
        Try demo
      </ConnectButton>
    ) : null;

  const details = !store ? (
    <p className="text-muted">Connect Shopify first: ad accounts belong to a store.</p>
  ) : !answer && ads.loadError ? (
    <p className="text-muted">
      We couldn&apos;t check {P.name} just now. {friendlyError(ads.loadError)}
    </p>
  ) : !answer ? null : mine.length > 0 ? (
    <>
      <p data-testid={`int-${p}-accounts`}>
        <span className="text-muted">{mine.length > 1 ? "Accounts" : "Account"}:</span> {accountsLine(mine)}
      </p>
      {/* Only the demo so far: the real sign-in is still to be had. */}
      {canAct && configured && mine.every((c) => c.demo) && (
        <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={connect} disabled={!!ads.busy} data-testid={`int-add-${p}`}>
          {leaving ? P.opening : `+ Connect your own ${P.name} account`}
        </button>
      )}
    </>
  ) : login ? (
    <p data-testid={`int-${p}-login`}>
      <span className="text-muted">Signed in as:</span> {login.name ?? `Your ${loginOfPlatform(login)}`}
      <span className="text-muted"> · {loginWords(login).short}</span>
    </p>
  ) : state === "coming_soon" ? (
    <p className="text-muted">{P.name} sign-in is being switched on for bizinsights.</p>
  ) : canAct && configured && demoOffered ? (
    <p className="text-muted">
      No {P.name} account?{" "}
      <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={tryDemo} disabled={!!ads.busy} data-testid="int-google-try-demo">
        Try demo
      </button>{" "}
      with sample figures.
    </p>
  ) : null;

  return (
    <IntegrationRow
      testid={`int-${p}`}
      state={state}
      logo={<P.Icon size={p === "meta" ? 46 : 42} />}
      name={P.name}
      sub={SUB[p]}
      pill={<RowPill label={s.label} tone={s.tone} busy={s.busy} state={state} />}
      action={action}
      brings={P.reads.map((r) => r.label)}
    >
      {details}
    </IntegrationRow>
  );
}
