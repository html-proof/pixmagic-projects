import { GoogleUnverified } from "@/components/GoogleAdsAccess";
import { MetaTestersOnly } from "@/components/MetaAdsAccess";
import type { StoreSummary } from "@/components/AppContext";
import { RECONNECT_STATES, type AdConnection, type AdProvider, type AdsState, type AdState } from "@/lib/adConnections";
import { AD_PLATFORMS, type AdPlatformInfo } from "./adPlatforms";

/** What an ad platform's card is given, on Settings → Connect your business (AdPlatformCard) and Settings → Advertising (AdPlatformPanel). */
export interface AdPlatformProps {
  provider: AdProvider;
  answer: AdsState | null;
  loadError: unknown;
  /** This platform's connections. */
  connections: AdConnection[];
  /** Where the card stands, and whether every account it shows is the demo. */
  view: { state: AdState; hidden: boolean; demo?: boolean };
  store: StoreSummary | null;
  manage: boolean;
  /** The action running on the page, if any (every button waits for it). */
  busy: string | null;
  /** This platform's sign-in is being opened. */
  leaving: boolean;
  /** Meta's testers-only note (not again right after coming back from Facebook, which explains it). */
  showMetaNote: boolean;
  onConnect: () => void;
  /** The account rows' recent syncs are read from `${base}/ads/connections/:id/syncs`. */
  base?: string | null;
  onRefresh: () => void;
  onToggle: (c: AdConnection) => void;
  onDisconnect: (c: AdConnection) => void;
  /** Google Ads: open the demo's connection flow (offered while this server switches the demo on and none is connected). */
  onTryDemo?: () => void;
  onDemoSync?: () => void;
  onDemoReset?: () => void;
}

/** What every ad platform card works out from its props before drawing anything. */
export function platformFacts({ provider, answer, connections, view, store, manage }: AdPlatformProps) {
  // The demo (Google Ads): offered by this server, and not connected yet. The real sign-in's button is about real accounts only.
  const real = connections.filter((c) => !c.demo);
  return {
    P: AD_PLATFORMS[provider],
    configured: answer?.configured[provider] ?? false,
    restricted: answer?.restricted[provider] ?? false,
    reconnect: RECONNECT_STATES.has(view.state) || connections.some((c) => c.status === "reconnect"),
    readable: connections.some((c) => c.enabled && c.status !== "reconnect"),
    canAct: manage && !!store && !!answer,
    real,
    demoOffered: provider === "google" && !!answer?.demo?.google,
    demoConnected: connections.some((c) => c.demo),
    missing: answer?.missing?.[provider] ?? [],
  };
}

/** The platform isn't set up on this server: what it still needs (for those who can set it up), or that it is on its way. */
export function NotConfiguredNote({ P, manage, missing, demoOffered, button, testid }: { P: AdPlatformInfo; manage: boolean; missing: string[]; demoOffered: boolean; button: string; testid: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted" data-testid={testid}>
      {manage && missing.length ? (
        <>
          The real {P.name} sign-in isn&apos;t set up on this server yet: it still needs {missing.join(", ")} (docs/ads-setup.md).
          {demoOffered ? " Meanwhile, Try demo connects a simulated account that needs none of them." : ""}
        </>
      ) : (
        <>
          {P.name} sign-in is being switched on for bizinsights. Once it&apos;s on, this card shows a &ldquo;{button}&rdquo; button: there are no keys or codes to copy.
          {demoOffered && manage ? " Meanwhile, Try demo connects a simulated account." : ""}
        </>
      )}
    </p>
  );
}

/** Read before going to the platform: who it lets in, and what it shows first. */
export function RestrictedNotes({ provider, connected, showMetaNote }: { provider: AdProvider; connected: boolean; showMetaNote: boolean }) {
  return (
    <>
      {provider === "meta" && !connected && showMetaNote && <MetaTestersOnly />}
      {provider === "google" && <GoogleUnverified brief={connected} />}
    </>
  );
}
