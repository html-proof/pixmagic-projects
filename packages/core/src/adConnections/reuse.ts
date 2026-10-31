/**
 * A Meta sign-in someone already gave bizinsights, used again for another of their stores, so they
 * aren't sent to Meta's screen for a permission bizinsights holds already. It is the same person's
 * grant to bizinsights' own Meta app (ads_read), never anything of Shopify's or another app's: Meta
 * ties a token to the person and the app, not to a store, and every store it serves is stored with
 * who granted it (externalUserId), so revoking, Meta's deauthorize and data deletion callbacks, and
 * taking the grant back on a last disconnect (connect.ts grantStillUsed) all see every copy.
 *
 * Only their own sign-in (connectedByUserId), still working, with ads_read, and not ending within a
 * day: what it reaches is listed again at Meta, and the person picks this store's ad accounts as
 * after a sign-in (routes/ads.ts).
 */
import { crossTenant, systemDb, type AdConnection } from "@app/db";
import { AdsApiError, AdsNoAccountsError, metaAdAccounts, REQUIRED_AD_SCOPE, type AdAccountList, type TokenSet } from "../ads.js";
import type { FetchLike } from "../shopify.js";
import { metaConfig } from "./config.js";
import { adAccessToken } from "./credentials.js";

/** A sign-in that ends sooner than this isn't taken to another store: the person would only be asked again tomorrow. */
const REUSE_MARGIN_MS = 24 * 3600_000;

/** Ads_read is among what was granted (or the grant didn't list its permissions: Meta's listing of accounts is then the test). */
const readsAds = (c: Pick<AdConnection, "grantedScopes">) => !c.grantedScopes.length || c.grantedScopes.includes(REQUIRED_AD_SCOPE.meta);

/**
 * The Meta sign-in this person gave bizinsights for another store (in any of their workspaces: the
 * `ad_grants` reason) that can serve `storeId` too, the latest first; null when there is none.
 */
export async function reusableMetaSignIn(userId: string, storeId: string, now = Date.now()): Promise<AdConnection | null> {
  const rows = await crossTenant("ad_grants", () =>
    systemDb.adConnection.findMany({
      where: {
        provider: "meta",
        connectedByUserId: userId,
        storeId: { not: storeId },
        source: "direct",
        status: { not: "reconnect" },
        accessTokenEnc: { not: "" },
        OR: [{ accessTokenExpiresAt: null }, { accessTokenExpiresAt: { gt: new Date(now + REUSE_MARGIN_MS) } }],
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  );
  return rows.find(readsAds) ?? null;
}

/** What a reused sign-in reaches now, with the tokens to connect this store's accounts with. */
export interface ReusedMetaSignIn {
  accounts: AdAccountList;
  tokens: TokenSet;
  externalUserId: string | null;
}

/**
 * Ask Meta which ad accounts the sign-in reaches now. Throws AdsAuthError when Meta no longer accepts
 * it, AdsNoAccountsError when it reaches none, and Meta's other errors as a sync would.
 */
export async function readReusedMetaSignIn(row: AdConnection, fetchImpl?: FetchLike): Promise<ReusedMetaSignIn> {
  const cfg = metaConfig(fetchImpl);
  if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503, undefined, "not_configured");
  const accessToken = await adAccessToken(row, fetchImpl);
  const accounts = await metaAdAccounts(cfg, accessToken);
  if (!accounts.length) throw new AdsNoAccountsError("The sign-in reaches no ad account", "no_ads_account");
  return {
    accounts,
    tokens: { accessToken, refreshToken: null, expiresAt: row.accessTokenExpiresAt, grantedScopes: row.grantedScopes.length ? row.grantedScopes : undefined },
    externalUserId: row.externalUserId,
  };
}
