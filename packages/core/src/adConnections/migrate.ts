/**
 * Moving the connections bizinsights' own sign-in made before every platform went through Nango
 * (`source` "direct": the platform's tokens sealed on the rows) to Nango, without the merchant doing
 * anything (docs/nango.md, "Connections made before Nango").
 *
 * Each sign-in (the accounts connected in one go, which share their tokens) becomes one Nango
 * connection: its tokens are handed to Nango (Nango's import, POST /connections), Nango is asked for a
 * working token (for Google, forcing a renewal, which proves Nango can renew it with its integration's
 * client), and only then are the rows rewritten to hold the sealed reference instead of the tokens, as
 * a connection made through Nango does. The grant itself doesn't change: it was always to bizinsights'
 * own Meta app or Google client, which Nango's integrations carry. Nothing is revoked, nothing is
 * deleted, and the rows keep their ids, settings and stored days.
 *
 * A sign-in Nango can't take (its integration missing, Nango's plan full, Nango or the platform not
 * answering, a grant that no longer works) stays exactly as it was and keeps working the old way
 * (credentials.ts) until a later try: the Nango connection is deleted again, and the sign-in waits
 * MOVE_RETRY_S. A rollback of the code needs nothing either: every release since Nango came in reads
 * a row with `source` "nango" for any platform.
 */
import { randomUUID } from "node:crypto";
import { systemDb, type AdConnection } from "@app/db";
import { decrypt, type AdProvider } from "@app/shared";
import { AdsApiError, AdsAuthError, AdsRateLimitedError, AdsRetryableError, NANGO_INTEGRATION, nangoAccessToken, nangoDeleteConnection, nangoImportConnection } from "../ads.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";
import { nangoConfig } from "./config.js";
import { aad, encryptNangoCredential, forgetNangoToken } from "./credentials.js";
import { connectableAdProviders } from "./nango.js";

/** At most this many sign-ins are moved per run (the cron tick, every 15 minutes), so one run stays short. */
export const MOVE_SIGN_INS_PER_RUN = 25;
/** How long a sign-in Nango couldn't take waits before it is tried again. */
export const MOVE_RETRY_S = 6 * 3600;

const LOCK_KEY = "ads-nango-move";
const waitKey = (connectionId: string) => `ads-nango-move-wait:${connectionId}`;

/** Rows a move is about: made by the direct sign-in, holding its tokens, with a grant that may still work. Never the demo, which holds no grant. */
const movable = { source: "direct", isDemo: false, accessTokenEnc: { not: "" }, status: { not: "reconnect" } };

export interface DirectMoveResult {
  /** Rows now read through Nango. */
  moved: number;
  /** Sign-ins Nango couldn't take this time (they wait MOVE_RETRY_S, and keep working as before). */
  failed: number;
  /** Sign-ins still waiting from an earlier failure. */
  waiting: number;
  /** Rows still made by the direct sign-in after this run (0: the move is complete). */
  left: number;
}

/** The accounts of one sign-in: same store and platform, same sealed refresh token (Google) or access token (Meta). */
function bySignIn(rows: AdConnection[]): AdConnection[][] {
  const groups = new Map<string, AdConnection[]>();
  for (const r of rows) {
    const key = `${r.storeId}|${r.provider}|${r.refreshTokenEnc ?? r.accessTokenEnc}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()];
}

type Outcome = "moved" | "failed" | "changed" | "stop";

/**
 * Move one sign-in to Nango. "failed": it stays as it was and waits MOVE_RETRY_S. "changed": its rows
 * were rewritten meanwhile (a token renewal of the old way): tried again next run. "stop": Nango can't
 * take any (bizinsights' key or plan, its rate limit): the run ends here.
 */
async function moveSignIn(group: AdConnection[], fetchImpl?: FetchLike): Promise<{ outcome: Outcome; rows: number }> {
  const cfg = nangoConfig(fetchImpl);
  if (!cfg) return { outcome: "stop", rows: 0 };
  const first = group[0]!;
  const provider = first.provider as AdProvider;
  const integrationKey = NANGO_INTEGRATION[provider];
  const k = keyring();
  // Accounts of one sign-in may hold different access tokens (each renewed on its own): the one that lasts longest.
  const freshest = group.reduce((a, b) => ((b.accessTokenExpiresAt?.getTime() ?? 0) > (a.accessTokenExpiresAt?.getTime() ?? 0) ? b : a));
  let tokens: { access: string; refresh: string | null };
  try {
    tokens = {
      access: decrypt(freshest.accessTokenEnc, k, aad(first.storeId, first.provider, "access")),
      refresh: first.refreshTokenEnc ? decrypt(first.refreshTokenEnc, k, aad(first.storeId, first.provider, "refresh")) : null,
    };
  } catch (err) {
    // A key that was removed, or a damaged ciphertext: key rotation's sweep deals with those (reencryptAdTokens).
    logger.error({ err, connectionIds: group.map((c) => c.id) }, "ad tokens couldn't be read to move them to Nango");
    return { outcome: "failed", rows: 0 };
  }
  // Meta's token ran out (about 60 days): nothing is left to move; the next sync puts it on Reconnect, as before.
  if (provider === "meta" && freshest.accessTokenExpiresAt && freshest.accessTokenExpiresAt.getTime() <= Date.now()) return { outcome: "failed", rows: 0 };
  // Google renews with a refresh token; without one there is nothing Nango could keep working.
  if (provider !== "meta" && !tokens.refresh) {
    logger.warn({ connectionIds: group.map((c) => c.id), provider }, "a direct Google sign-in without a refresh token can't move to Nango; it waits for a reconnect");
    return { outcome: "failed", rows: 0 };
  }
  const connectionId = randomUUID();
  let imported = false;
  try {
    await nangoImportConnection(cfg, {
      integrationKey,
      connectionId,
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt: freshest.accessTokenExpiresAt,
      tags: { end_user_id: first.connectedByUserId ?? "unknown", organization_id: first.workspaceId, bi_store: first.storeId, bi_provider: provider, bi_imported: "direct" },
    });
    imported = true;
    // Google: renewed now, with Nango's client, so a client Nango holds wrongly shows here and not as
    // every sync failing later. Meta: Nango's long-lived token, renewed by its `facebook` template.
    const t = await nangoAccessToken(cfg, integrationKey, connectionId, { forceRefresh: provider !== "meta" });
    const sealed = encryptNangoCredential(first.storeId, provider, { connectionId, integrationKey }, t.expiresAt ?? freshest.accessTokenExpiresAt);
    // Only over the ciphertexts read: the old way may have renewed the tokens meanwhile.
    const { count } = await systemDb.adConnection.updateMany({
      where: {
        id: { in: group.map((c) => c.id) },
        source: "direct",
        refreshTokenEnc: first.refreshTokenEnc,
        accessTokenEnc: { in: [...new Set(group.map((c) => c.accessTokenEnc))] },
      },
      data: { ...sealed, source: "nango", sourceLoginId: connectionId },
    });
    if (!count) {
      await nangoDeleteConnection(cfg, integrationKey, connectionId).catch((err: unknown) => logger.warn({ err, provider }, "an unused imported Nango connection wasn't deleted"));
      return { outcome: "changed", rows: 0 };
    }
    forgetNangoToken(connectionId);
    for (const workspaceId of new Set(group.map((c) => c.workspaceId))) {
      await audit({ workspaceId, action: "ads.moved_to_nango", targetType: "store", targetId: first.storeId, metadata: { provider, accounts: count } });
    }
    logger.info({ provider, storeId: first.storeId, accounts: count }, "a direct ad sign-in now reads through Nango");
    return { outcome: "moved", rows: count };
  } catch (err) {
    if (imported) await nangoDeleteConnection(cfg, integrationKey, connectionId).catch((e: unknown) => logger.warn({ err: e, provider }, "a Nango connection whose move failed wasn't deleted"));
    // Ours to fix, for every sign-in alike (the integration missing or holding another client, the key, the plan): the run stops.
    const ours = err instanceof AdsApiError && (err.errorCode === "not_configured" || err.status === 402 || err.status === 403);
    if (ours || err instanceof AdsRateLimitedError) {
      logger.error({ err, provider }, "nango can't take direct ad sign-ins now; they keep working the old way");
      return { outcome: "stop", rows: 0 };
    }
    // Nango itself didn't answer the import: nothing about this sign-in, so none waits; the next tick tries again.
    if (!imported && err instanceof AdsRetryableError) {
      logger.warn({ err, provider }, "nango didn't answer; direct ad sign-ins are moved on a later tick");
      return { outcome: "stop", rows: 0 };
    }
    // A grant Nango couldn't renew is either ended (the next sync says so, as it always did) or Nango's
    // client isn't bizinsights' (then every move fails alike): never put on Reconnect from here.
    logger.warn({ err, provider, connectionIds: group.map((c) => c.id), authEnded: err instanceof AdsAuthError }, "a direct ad sign-in couldn't move to Nango; tried again later");
    return { outcome: "failed", rows: 0 };
  }
}

/**
 * Move up to `limit` direct sign-ins (MOVE_SIGN_INS_PER_RUN) to Nango, for the platforms Nango can
 * connect now (connectableAdProviders). One run at a time. Logs how many direct rows are left, which
 * says when the old way can be removed (0, after a few days). Never throws for one sign-in.
 */
export async function moveDirectAdConnectionsToNango(coord: Coord, opts: { fetchImpl?: FetchLike; limit?: number } = {}): Promise<DirectMoveResult> {
  const out: DirectMoveResult = { moved: 0, failed: 0, waiting: 0, left: 0 };
  const count = () => systemDb.adConnection.count({ where: { source: "direct", isDemo: false, accessTokenEnc: { not: "" } } });
  if (!nangoConfig(opts.fetchImpl) || !(await count())) return out;
  if (!(await coord.acquire(LOCK_KEY, 10 * 60_000))) return { ...out, left: await count() };
  try {
    const ready = await connectableAdProviders(coord, opts.fetchImpl);
    const providers = (Object.keys(ready) as AdProvider[]).filter((p) => ready[p]);
    const rows = providers.length ? await systemDb.adConnection.findMany({ where: { ...movable, provider: { in: providers } }, orderBy: { id: "asc" }, take: 1000 }) : [];
    let tried = 0;
    for (const group of bySignIn(rows)) {
      if (tried >= (opts.limit ?? MOVE_SIGN_INS_PER_RUN)) break;
      if (await coord.peek(waitKey(group[0]!.id)).catch(() => null)) {
        out.waiting++;
        continue;
      }
      tried++;
      const { outcome, rows: moved } = await moveSignIn(group, opts.fetchImpl);
      if (outcome === "moved") out.moved += moved;
      else if (outcome === "failed") {
        out.failed++;
        await coord.put(waitKey(group[0]!.id), "1", MOVE_RETRY_S).catch(() => undefined);
      } else if (outcome === "stop") {
        out.failed++;
        break;
      }
    }
  } finally {
    await coord.release(LOCK_KEY).catch(() => undefined);
  }
  out.left = await count();
  if (out.moved || out.failed || out.left) logger.info(out, "direct ad connections moved to Nango");
  return out;
}
