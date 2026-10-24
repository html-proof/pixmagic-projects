/**
 * Adding the access token through Nango (docs/whatsapp.md "Through Nango"): bizinsights' Nango
 * environment holds an API-key integration, `whatsapp-business`, so Nango's Connect UI is where the
 * merchant pastes their system-user token, in Nango's window instead of bizinsights' own box. The rest
 * is the manual connect (connect.ts): the numbers the token reaches, then the app secret.
 *
 * Nango keeps no copy. bizinsights reads the token once, right after the Connect UI says it was saved,
 * and deletes the connection there whatever happens next (so none counts toward Nango's plan either).
 * Until the merchant finishes, the token waits here sealed for its store, under a handle only the person
 * who added it can use; the browser never sees it. A connection nobody finished (the page closed first)
 * is deleted by the cron's sweep.
 */
import { randomToken } from "@app/shared";
import { nangoApiKey, nangoConnections, nangoCreateConnectSession, nangoDeleteConnection, nangoIntegrations, type NangoConfig } from "../ads.js";
import { nangoConfig } from "../adConnections/config.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { WhatsappConnectError } from "./connect.js";
import { waDecrypt, waEncrypt } from "./store.js";

/** The integration's unique key in bizinsights' Nango environment, made in Nango's dashboard. */
export const WHATSAPP_NANGO_INTEGRATION = "whatsapp-business";
/** The Nango provider it must be made from: an API-key one, whose key is the WhatsApp access token. */
const WHATSAPP_NANGO_PROVIDER = "whatsapp-business";

/** A Connect UI session's lifetime at Nango, so its state here; a token waits as long for the merchant. */
export const WA_NANGO_TTL_S = 30 * 60;
const READY_TTL_S = 5 * 60;

const READY_KEY = "nango-whatsapp-ready";
const sessionKey = (nonce: string) => `oauth:wa-nango:${nonce}`;
const heldKey = (handle: string) => `wa-nango-token:${handle}`;

/** Who added a token: the person, and the workspace and store it is for. */
export interface WaNangoWho {
  userId: string;
  workspaceId: string;
  storeId: string;
}

/**
 * Whether the token can be added through Nango now: this server has Nango's key and Nango holds the
 * integration, made from the right provider (asked of Nango, kept 5 minutes). Not offered while Nango
 * can't say: the token box works without it.
 */
export async function whatsappNangoReady(coord: Coord, fetchImpl?: FetchLike): Promise<boolean> {
  const cfg = nangoConfig(fetchImpl);
  if (!cfg) return false;
  const cached = await coord.peek(READY_KEY).catch(() => null);
  if (cached) return cached === "1";
  let ready: boolean;
  try {
    ready = (await nangoIntegrations(cfg)).some((i) => i.integrationKey === WHATSAPP_NANGO_INTEGRATION && i.provider === WHATSAPP_NANGO_PROVIDER);
  } catch (err) {
    logger.warn({ err }, "nango's integrations couldn't be listed; WhatsApp offers only its own token box for now");
    await coord.put(READY_KEY, "0", 60).catch(() => undefined);
    return false;
  }
  await coord.put(READY_KEY, ready ? "1" : "0", READY_TTL_S).catch(() => undefined);
  return ready;
}

/**
 * A Connect UI session limited to the WhatsApp integration, tagged with ids only, among them `nonce`, by
 * which takeWhatsappNangoToken later knows the connection came from this session.
 */
export async function startWhatsappNangoSession(coord: Coord, cfg: NangoConfig, nonce: string, who: WaNangoWho): Promise<{ token: string; expiresAt: string | null }> {
  const session = await nangoCreateConnectSession(cfg, {
    integrationKey: WHATSAPP_NANGO_INTEGRATION,
    tags: { end_user_id: who.userId, organization_id: who.workspaceId, bi_store: who.storeId, bi_provider: "whatsapp", bi_session: nonce },
  });
  await coord.put(sessionKey(nonce), JSON.stringify(who), WA_NANGO_TTL_S);
  return session;
}

/**
 * The token pasted in Nango's window for session `nonce`, read once: the session must be this person's,
 * for this store, and the connection must carry its tags as Nango holds them (nothing the browser says
 * is trusted past the connection's id). The connection is deleted at Nango whatever the outcome.
 */
export async function takeWhatsappNangoToken(coord: Coord, cfg: NangoConfig, nonce: string, connectionId: string, who: WaNangoWho): Promise<string> {
  try {
    const raw = await coord.take(sessionKey(nonce));
    const state = raw ? (JSON.parse(raw) as WaNangoWho) : null;
    if (!state) throw new WhatsappConnectError("That took too long. Press Add your token and paste it again.", "state_expired");
    if (state.userId !== who.userId || state.workspaceId !== who.workspaceId || state.storeId !== who.storeId) {
      throw new WhatsappConnectError("That window was opened by someone else. Press Add your token and paste it again.", "session_mismatch");
    }
    const ours = (await nangoConnections(cfg, connectionId)).some(
      (x) =>
        x.connectionId === connectionId &&
        x.integrationKey === WHATSAPP_NANGO_INTEGRATION &&
        x.tags.bi_session === nonce &&
        x.tags.end_user_id === who.userId &&
        x.tags.organization_id === who.workspaceId &&
        x.tags.bi_store === who.storeId,
    );
    if (!ours) throw new WhatsappConnectError("That token couldn't be matched to this page. Press Add your token and paste it again.", "state_mismatch");
    return await nangoApiKey(cfg, WHATSAPP_NANGO_INTEGRATION, connectionId);
  } finally {
    await nangoDeleteConnection(cfg, WHATSAPP_NANGO_INTEGRATION, connectionId).catch((err: unknown) => {
      logger.warn({ err }, "whatsapp: the nango connection wasn't deleted; the sweep deletes it later");
    });
  }
}

/** Keep a token from Nango's window for the rest of the connect: sealed for its store, under a new handle. */
export async function holdWhatsappToken(coord: Coord, who: WaNangoWho, token: string): Promise<string> {
  const handle = randomToken(24);
  await coord.put(heldKey(handle), JSON.stringify({ userId: who.userId, storeId: who.storeId, enc: waEncrypt(who.storeId, "access", token) }), WA_NANGO_TTL_S);
  return handle;
}

/** The token held under `handle`, for the person and store it was added for only. */
export async function heldWhatsappToken(coord: Coord, handle: string, who: Pick<WaNangoWho, "userId" | "storeId">): Promise<string> {
  const raw = await coord.peek(heldKey(handle)).catch(() => null);
  const held = raw ? (JSON.parse(raw) as { userId: string; storeId: string; enc: string }) : null;
  if (!held || held.userId !== who.userId || held.storeId !== who.storeId) {
    throw new WhatsappConnectError("The token from Nango's window has expired. Press Add your token and paste it again.", "token_expired");
  }
  return waDecrypt(who.storeId, "access", held.enc);
}

/** Forget a held token (the connection saved its own copy). */
export async function dropHeldWhatsappToken(coord: Coord, handle: string): Promise<void> {
  await coord.take(heldKey(handle)).catch(() => null);
}

/**
 * Connections in the WhatsApp integration older than a Connect UI session: tokens added in a window
 * whose page never finished. bizinsights keeps none there, so each is deleted. Returns how many.
 */
export async function sweepWhatsappNangoLeftovers(fetchImpl?: FetchLike, now = Date.now()): Promise<number> {
  const cfg = nangoConfig(fetchImpl);
  if (!cfg) return 0;
  const left = (await nangoConnections(cfg)).filter((x) => {
    if (x.integrationKey !== WHATSAPP_NANGO_INTEGRATION) return false;
    const at = x.createdAt ? Date.parse(x.createdAt) : Number.NaN;
    return !Number.isFinite(at) || now - at > WA_NANGO_TTL_S * 1000;
  });
  let deleted = 0;
  for (const x of left) {
    const outcome = await nangoDeleteConnection(cfg, WHATSAPP_NANGO_INTEGRATION, x.connectionId).catch((err: unknown) => {
      logger.warn({ err }, "whatsapp: a leftover nango connection wasn't deleted; the next tick tries again");
      return null;
    });
    if (outcome) deleted++;
  }
  if (deleted) logger.info({ deleted }, "whatsapp: nango connections nobody finished were deleted");
  return deleted;
}
