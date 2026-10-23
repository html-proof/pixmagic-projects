"use client";
import { useState } from "react";
import { FlaskConical } from "lucide-react";
import type { StoreSummary } from "@/components/AppContext";
import { Dialog } from "@/components/AppUi";
import { GoogleUnverified } from "@/components/GoogleAdsAccess";
import { MetaTestersOnly } from "@/components/MetaAdsAccess";
import { friendlyError } from "@/lib/api";
import { accountLabel, stateInfo, type AdConnection, type AdProvider, type AdState } from "@/lib/adConnections";
import { AD_PLATFORMS } from "./adPlatforms";
import { ConnectButton, IntegrationRow, ManageLink, RowPill } from "./IntegrationRow";
import type { useAdConnections } from "./useAdConnections";

// ---------------------------------------------------------------------------
// An ad platform's row on Settings → Integrations (Google Ads, Meta Ads, Google AdSense): where it
// stands, one button that opens the platform's own sign-in (after what its screen will say first,
// while the platform hasn't finished reviewing bizinsights), and the accounts connected. Everything
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

/** The platform's sign-in, as named on the "before you go" window. */
const SIGN_IN: Partial<Record<AdProvider, string>> = { google: "Google", meta: "Facebook" };

/**
 * Where a row stands: its platform's state (lib/adConnections.ts, platformState), except that a
 * platform still under its own review is "Not connected" here while nothing is connected, not
 * "Verification pending": its warning comes when Connect is pressed, before anyone is sent there.
 */
export function rowState(ads: Ads, store: StoreSummary | null, p: AdProvider): { state: AdState; demo: boolean } {
  if (!store) return { state: "not_connected", demo: false };
  const v = ads.view(p);
  const none = !ads.connections.some((c) => c.provider === p);
  return { state: v.state === "verification_pending" && none ? "not_connected" : v.state, demo: v.demo };
}

/** "Brand Search", "Brand Search +2 more", with "(demo)" for the simulated one. */
function accountsLine(list: AdConnection[]): string {
  const first = list[0]!;
  return `${accountLabel(first)}${first.demo ? " (demo)" : ""}${list.length > 1 ? ` +${list.length - 1} more` : ""}`;
}

export function AdRow({ provider: p, ads, store, manage }: { provider: AdProvider; ads: Ads; store: StoreSummary | null; manage: boolean }) {
  const [before, setBefore] = useState(false);
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
  const where = SIGN_IN[p];
  // While Google (Google Ads) or Meta hasn't finished reviewing bizinsights, its screen says so first: the page says it before.
  const warnFirst = !!where && !!answer?.restricted[p];
  const connect = () => {
    setBefore(false);
    void ads.connect(p);
  };
  const press = () => (warnFirst ? setBefore(true) : connect());
  const tryDemo = () => ads.openDemo();

  const action =
    mine.length > 0 ? (
      <ManageLink name={P.name} href="/settings/ads" attention={ATTENTION.has(state)} />
    ) : canAct && configured ? (
      <ConnectButton name={P.name} onClick={press} disabled={!!ads.busy} busy={leaving ? P.opening : null} testid={`int-${p}-connect`} />
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
        <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={press} disabled={!!ads.busy} data-testid={`int-add-${p}`}>
          {leaving ? P.opening : `+ Connect your own ${P.name} account`}
        </button>
      )}
    </>
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
    <>
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

      {where && (
        <Dialog open={before} title={`Before you go to ${where}`} onClose={() => setBefore(false)}>
          {p === "meta" ? <MetaTestersOnly /> : <GoogleUnverified />}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setBefore(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={connect} disabled={!!ads.busy} data-testid={`int-${p}-continue`}>
              Continue to {where}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
