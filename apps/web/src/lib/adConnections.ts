/**
 * What GET /workspaces/:ws/stores/:storeId/ads answers (apps/api/src/routes/ads.ts,
 * publicConnection): the store's connected ad accounts and which platforms are set up.
 */
export type AdProvider = "meta" | "google" | "adsense";

export interface AdConnection {
  id: string;
  provider: AdProvider;
  accountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  enabled: boolean;
  status: "active" | "reconnect" | "error";
  lastError: string | null;
  lastSyncedAt: string | null;
  accessExpiresAt: string | null;
  connectedAt: string;
  permission: string | null;
  /** The permissions the person who connected it granted. */
  grantedScopes: string[];
}

export interface AdsState {
  configured: Record<AdProvider, boolean>;
  /**
   * The platform only lets in the people added to Insights' own app (Meta, until Meta approves the
   * app for everyone): anyone else is turned away on the platform's page and never comes back.
   */
  restricted: Record<AdProvider, boolean>;
  connections: AdConnection[];
}
