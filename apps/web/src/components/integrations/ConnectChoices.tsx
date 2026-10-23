"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { StoreSummary } from "@/components/AppContext";
import { Dialog } from "@/components/AppUi";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { GoogleUnverified } from "@/components/GoogleAdsAccess";
import { MetaTestersOnly } from "@/components/MetaAdsAccess";
import { friendlyError } from "@/lib/api";
import { accountLabel, stateInfo, type AdConnection, type AdProvider, type AdState } from "@/lib/adConnections";
import { StateAnnouncer, StateBadge } from "./AdUi";
import { AD_PLATFORMS } from "./adPlatforms";
import type { useAdConnections } from "./useAdConnections";

// ---------------------------------------------------------------------------
// The three choices on Settings → Connect your business: Shopify, Google and Meta, each a tile with
// where it stands and one button. Google is one choice for both of its products (Google Ads, what a
// store spends on ads; AdSense, what a site earns from them): its button asks which. Everything about
// single accounts (refresh, hide, sites, disconnect) stays on Settings → Advertising, behind Manage.
// ---------------------------------------------------------------------------

/** One of the choices: what it is, where it stands, what is connected, and its buttons. */
export function ChoiceTile({
  testid,
  state,
  icon,
  name,
  sub,
  badge,
  children,
  actions,
}: {
  testid: string;
  /** For tests and styling: the state the badge shows. */
  state: string;
  icon: ReactNode;
  name: string;
  sub: string;
  badge: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card animate-rise flex min-w-0 flex-col gap-3" aria-labelledby={`${testid}-h`} data-testid={testid} data-state={state}>
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-white">{icon}</span>
        {badge}
      </div>
      <div className="min-w-0">
        <h2 id={`${testid}-h`} className="text-lg font-semibold">
          {name}
        </h2>
        <p className="text-sm text-muted">{sub}</p>
      </div>
      {children && <div className="space-y-2 text-sm">{children}</div>}
      {actions && <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">{actions}</div>}
    </section>
  );
}

/** Most pressing first, among the platforms of a tile that have accounts. */
const WORST: AdState[] = ["reconnect_required", "authorization_required", "permission_missing", "sync_failed", "verification_pending", "synchronizing", "connected"];

/** A state that has an account waiting for someone: the tile's button goes to where it's fixed. */
const ATTENTION: ReadonlySet<AdState> = new Set(["reconnect_required", "authorization_required", "permission_missing", "sync_failed", "verification_pending"]);

type View = { state: AdState; demo: boolean; accounts: number };

/**
 * Where a tile stands, from its platforms' states (lib/adConnections.ts, platformState): the worst
 * of those with accounts; with none, whether one can be connected. A platform still under its
 * platform's review is "Not connected" here, not "Verification pending": its warning comes before
 * anyone is sent there.
 */
export function tileState(views: View[]): { state: AdState; demo: boolean } {
  const connecting = views.find((v) => v.state === "connecting");
  if (connecting) return { state: "connecting", demo: connecting.demo };
  const mine = views.filter((v) => v.accounts > 0);
  if (mine.length) return { state: WORST.find((s) => mine.some((v) => v.state === s)) ?? "connected", demo: mine.every((v) => v.demo) };
  for (const s of ["checking", "unknown", "disconnected"] as const) {
    const v = views.find((x) => x.state === s);
    if (v) return { state: s, demo: v.demo };
  }
  return { state: views.some((v) => v.state === "not_connected" || v.state === "verification_pending") ? "not_connected" : "coming_soon", demo: false };
}

/** "Brand Search", "Brand Search +2 more", with "(demo)" for the simulated one. */
function accountsLine(list: AdConnection[]): string {
  const first = list[0]!;
  return `${accountLabel(first)}${first.demo ? " (demo)" : ""}${list.length > 1 ? ` +${list.length - 1} more` : ""}`;
}

/** What each Google product is, in the words of someone choosing between them. */
const GOOGLE_WHAT: Record<"google" | "adsense", string> = {
  google: "You pay Google for ads. See what you spend and what it brings, next to your sales.",
  adsense: "Google pays you for ads shown on your website. See what your site earns.",
};

/**
 * The Google and Meta tiles, and what their buttons open: the Google choice (Google Ads or AdSense)
 * and, while Meta lets only its testers in, what Facebook will show everyone else.
 */
export function AdChoices({ ads, store, manage }: { ads: ReturnType<typeof useAdConnections>; store: StoreSummary | null; manage: boolean }) {
  const [googleOpen, setGoogleOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const answer = ads.answer;
  const canAct = manage && !!store && !!answer;
  const of = (p: AdProvider) => ads.connections.filter((c) => c.provider === p);
  const view = (p: AdProvider): View => {
    const v = store ? ads.view(p) : { state: "not_connected" as const, demo: false };
    return { state: v.state, demo: v.demo, accounts: of(p).length };
  };
  const leaving = (p: AdProvider) => ads.leaving === p;

  // ---- Google: Google Ads and AdSense behind one choice.
  const googleAds = of("google");
  const adsense = of("adsense");
  const google = tileState([view("google"), view("adsense")]);
  // The products whose real sign-in this server offers.
  const products = (["google", "adsense"] as const).filter((p) => answer?.configured[p]);
  const demoOffered = !!answer?.demo?.google && !googleAds.some((c) => c.demo);
  const googleOpening = leaving("google") || leaving("adsense");
  const connectGoogle = (p: "google" | "adsense") => {
    setGoogleOpen(false);
    void ads.connect(p);
  };
  const tryDemo = () => {
    setGoogleOpen(false);
    ads.openDemo();
  };

  // ---- Meta.
  const metaAccounts = of("meta");
  const meta = tileState([view("meta")]);
  const metaReady = !!answer?.configured.meta;
  const connectMeta = () => {
    setMetaOpen(false);
    void ads.connect("meta");
  };

  /** Before an answer: why there's nothing to say yet. */
  const pending = (name: string) =>
    !store ? (
      <p className="text-muted">Connect Shopify first: ad accounts belong to a store.</p>
    ) : !answer && ads.loadError ? (
      <p className="text-muted">
        We couldn&apos;t check {name} just now. {friendlyError(ads.loadError)}
      </p>
    ) : !answer ? (
      <div className="skeleton h-6" aria-hidden />
    ) : null;

  const manageLink = (name: string, attention: boolean) => (
    <Link className={attention ? "btn-primary" : "btn-secondary"} href="/settings/ads" aria-label={`${attention ? "Fix" : "Manage"} ${name}`}>
      {attention ? "Fix it" : "Manage"}
    </Link>
  );

  return (
    <>
      <StateAnnouncer
        items={[
          ["Google", stateInfo(google.state, google.demo).label],
          ["Meta", stateInfo(meta.state).label],
        ]}
      />
      <ChoiceTile
        testid="int-google"
        state={google.state}
        icon={<GoogleIcon size={26} />}
        name="Google"
        sub="Google Ads spend, or what your site earns with AdSense"
        badge={<StateBadge state={google.state} demo={google.demo} testid="platform-state" />}
        actions={
          <>
            {canAct && googleAds.length + adsense.length === 0 && products.length > 0 && (
              <button type="button" className="btn-primary" onClick={() => setGoogleOpen(true)} disabled={!!ads.busy} data-testid="int-google-connect">
                {googleOpening ? "Opening Google…" : "Connect Google"}
              </button>
            )}
            {/* Nothing real to sign in to on this server: the demo is the only thing to press. */}
            {canAct && products.length === 0 && demoOffered && (
              <button type="button" className="btn-primary" onClick={tryDemo} disabled={!!ads.busy} data-testid="int-google-try-demo">
                Try demo
              </button>
            )}
            {googleAds.length + adsense.length > 0 && manageLink("Google", ATTENTION.has(google.state))}
          </>
        }
      >
        {pending("Google") ??
          (googleAds.length + adsense.length > 0 ? (
            <ul className="space-y-1" data-testid="int-google-accounts">
              {googleAds.length > 0 && (
                <li>
                  <span className="text-muted">Google Ads:</span> {accountsLine(googleAds)}
                </li>
              )}
              {adsense.length > 0 && (
                <li>
                  <span className="text-muted">AdSense:</span> {accountsLine(adsense)}
                </li>
              )}
              {canAct &&
                products
                  .filter((p) => of(p).every((c) => c.demo))
                  .map((p) => (
                    <li key={p}>
                      <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => connectGoogle(p)} disabled={!!ads.busy} data-testid={`int-add-${p}`}>
                        {leaving(p) ? "Opening Google…" : `+ Add ${AD_PLATFORMS[p].name}`}
                      </button>
                    </li>
                  ))}
            </ul>
          ) : google.state === "coming_soon" ? (
            <p className="text-muted">Google sign-in is being switched on for bizinsights.</p>
          ) : null)}
      </ChoiceTile>

      <ChoiceTile
        testid="int-meta"
        state={meta.state}
        icon={<MetaIcon size={22} />}
        name="Meta"
        sub="Facebook and Instagram ads: spend, reach and purchases"
        badge={<StateBadge state={meta.state} testid="platform-state" />}
        actions={
          <>
            {canAct && metaReady && metaAccounts.length === 0 && (
              <button
                type="button"
                className="btn-primary"
                // While Meta lets only its testers in, say so before Facebook does it with "Feature Unavailable".
                onClick={() => (answer?.restricted.meta ? setMetaOpen(true) : connectMeta())}
                disabled={!!ads.busy}
                data-testid="int-meta-connect"
              >
                {leaving("meta") ? "Opening Meta…" : "Connect Meta"}
              </button>
            )}
            {metaAccounts.length > 0 && manageLink("Meta", ATTENTION.has(meta.state))}
          </>
        }
      >
        {pending("Meta") ??
          (metaAccounts.length > 0 ? (
            <p data-testid="int-meta-accounts">
              <span className="text-muted">Meta Ads:</span> {accountsLine(metaAccounts)}
            </p>
          ) : meta.state === "coming_soon" ? (
            <p className="text-muted">Meta sign-in is being switched on for bizinsights.</p>
          ) : null)}
      </ChoiceTile>

      <Dialog open={googleOpen} title="Which Google do you use?" onClose={() => setGoogleOpen(false)}>
        <div className="grid gap-2" data-testid="google-choice">
          {products.map((p) => {
            const P = AD_PLATFORMS[p];
            const real = of(p).filter((c) => !c.demo);
            return (
              <button
                key={p}
                type="button"
                className="flex w-full items-start gap-3 rounded-xl border border-border p-3 text-left transition hover:border-accent hover:bg-bg disabled:opacity-60"
                onClick={() => connectGoogle(p)}
                disabled={!!ads.busy}
                data-testid={`int-connect-${p}`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-white">
                  <P.Icon size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">
                    {P.name}
                    {real.length > 0 && <span className="ml-2 text-xs font-normal text-muted">Connected</span>}
                  </span>
                  <span className="block text-sm text-muted">{GOOGLE_WHAT[p]}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-muted">You can add the other one later. bizinsights only reads your reports: it can&apos;t change your ads or spend money.</p>
        {products.includes("google") && answer?.restricted.google && (
          <div className="mt-3 space-y-1 rounded-lg border border-dashed border-border px-3 py-2">
            <p className="text-xs font-semibold">Choosing Google Ads?</p>
            <GoogleUnverified brief />
          </div>
        )}
        {demoOffered && (
          <p className="mt-3 text-sm text-muted">
            No Google Ads account?{" "}
            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={tryDemo} data-testid="int-google-try-demo">
              Try demo
            </button>{" "}
            with sample figures.
          </p>
        )}
      </Dialog>

      <Dialog open={metaOpen} title="Before you go to Facebook" onClose={() => setMetaOpen(false)}>
        <MetaTestersOnly />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setMetaOpen(false)}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={connectMeta} disabled={!!ads.busy} data-testid="int-meta-continue">
            Continue to Facebook
          </button>
        </div>
      </Dialog>
    </>
  );
}
