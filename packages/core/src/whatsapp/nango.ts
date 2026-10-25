/**
 * Nango (docs/nango.md) holds each store's WhatsApp access token. Nango's own WhatsApp Business
 * integration (provider `whatsapp-business`) is API-key only: its Connect UI would ask the merchant to
 * paste a token, and it has no Embedded Signup. So the merchant signs in through Meta's Embedded
 * Signup on bizinsights' page (connect.ts), bizinsights exchanges the code for the business token,
 * and hands that token to Nango (Nango's connection import, `credentials.type: API_KEY`). From then
 * on bizinsights asks Nango for it right before each call and keeps it in memory for a few minutes.
 *
 * One Nango connection per store: its id is `wa-<storeId>`, so a reconnect replaces the token in place
 * and a retry never makes a second connection. Tags carry ids only (no personal data). Only Nango's
 * REST API is used, server side, with the environment's secret key.
 */
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { WhatsappError } from "./common.js";

/**
 * bizinsights' WhatsApp integration in its Nango environment: `whatsapp-business`, the one the owner made
 * in Nango's dashboard on 2026-10-24 (made here on first use if it is ever missing).
 */
export const WA_NANGO_INTEGRATION = "whatsapp-business";
/** Nango's provider for it: the WhatsApp Business API-key integration. */
export const WA_NANGO_PROVIDER = "whatsapp-business";

export const waNangoConnectionId = (storeId: string) => `wa-${storeId}`;

/** Nango can't be reached or is busy: try again later. */
export class NangoUnavailableError extends Error {
  override name = "NangoUnavailableError";
}
/** Nango has no token for the connection any more (deleted, or never made): reconnect. */
export class NangoTokenGoneError extends Error {
  override name = "NangoTokenGoneError";
}

interface NangoCfg {
  secretKey: string;
  apiUrl: string;
  fetchImpl: FetchLike;
}

function cfg(fetchImpl: FetchLike): NangoCfg {
  const e = env();
  if (!e.NANGO_SECRET_KEY) throw new WhatsappError("WhatsApp connections aren't set up on bizinsights yet. Please contact support.", 503, "not_configured");
  return { secretKey: e.NANGO_SECRET_KEY, apiUrl: e.NANGO_API_URL.replace(/\/+$/, ""), fetchImpl };
}

async function nango<T>(c: NangoCfg, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; json: T }> {
  let res: Response;
  try {
    res = await c.fetchImpl(`${c.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${c.secretKey}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new NangoUnavailableError(`Nango didn't answer: ${(err as Error)?.name ?? "network error"}`);
  }
  const json = (await res.json().catch(() => ({}))) as T;
  if (res.status === 429 || res.status >= 500) throw new NangoUnavailableError(`Nango answered ${res.status}`);
  if (res.status === 401 || res.status === 403) {
    logger.error({ status: res.status }, "nango refused bizinsights' secret key");
    throw new WhatsappError("WhatsApp connections aren't set up correctly on bizinsights. Please contact support.", 503, "not_configured");
  }
  return { status: res.status, json };
}

const READY_KEY = "wa:nango:integration";

/**
 * Make sure bizinsights' Nango environment has the WhatsApp integration (an API-key integration needs
 * no credentials of its own, so bizinsights makes it itself). Checked at most every 5 minutes.
 */
export async function ensureNangoIntegration(coord: Coord, fetchImpl: FetchLike): Promise<void> {
  if (await coord.peek(READY_KEY).catch(() => null)) return;
  const c = cfg(fetchImpl);
  const got = await nango<{ data?: { provider?: string } }>(c, "GET", `/integrations/${WA_NANGO_INTEGRATION}`);
  if (got.status === 404) {
    const made = await nango<{ error?: { code?: string } }>(c, "POST", "/integrations", { unique_key: WA_NANGO_INTEGRATION, provider: WA_NANGO_PROVIDER, display_name: "bizinsights · WhatsApp" });
    if (made.status >= 300) {
      logger.error({ status: made.status, code: made.json.error?.code }, "nango: couldn't create the WhatsApp integration");
      throw new WhatsappError("WhatsApp connections aren't set up correctly on bizinsights. Please contact support.", 503, "not_configured");
    }
    logger.info({ integration: WA_NANGO_INTEGRATION }, "nango: WhatsApp integration created");
  } else if (got.status >= 300) {
    throw new NangoUnavailableError(`Nango answered ${got.status} for the WhatsApp integration`);
  } else if (got.json.data?.provider && got.json.data.provider !== WA_NANGO_PROVIDER) {
    logger.error({ provider: got.json.data.provider }, "nango: the WhatsApp integration is made from another provider; delete it in Nango's dashboard");
    throw new WhatsappError("WhatsApp connections aren't set up correctly on bizinsights. Please contact support.", 503, "not_configured");
  }
  await coord.put(READY_KEY, "1", 300).catch(() => undefined);
}

/** Ids only: who connected, the workspace, the store, the account. */
export interface WaNangoTags {
  /** Left out when the person who connected has since been deleted. */
  end_user_id?: string;
  organization_id: string;
  bi_store: string;
  bi_provider: "whatsapp";
  bi_waba: string;
}

/** Hand Nango the business token (it replaces the one an earlier connect left under the same id). */
export async function storeTokenInNango(input: { storeId: string; token: string; tags: WaNangoTags }, deps: { coord: Coord; fetchImpl: FetchLike }): Promise<string> {
  await ensureNangoIntegration(deps.coord, deps.fetchImpl);
  const connectionId = waNangoConnectionId(input.storeId);
  const r = await nango<{ error?: { code?: string } }>(cfg(deps.fetchImpl), "POST", "/connections", {
    provider_config_key: WA_NANGO_INTEGRATION,
    connection_id: connectionId,
    credentials: { type: "API_KEY", apiKey: input.token },
    tags: input.tags,
  });
  if (r.status >= 300) {
    logger.error({ status: r.status, code: r.json.error?.code }, "nango refused the WhatsApp token import");
    throw new WhatsappError("bizinsights couldn't save your WhatsApp connection just now. Press Connect WhatsApp again in a minute.", 502, "save_failed");
  }
  forgetWaToken(connectionId);
  return connectionId;
}

const TOKEN_TTL_MS = 4 * 60_000;
const cache = new Map<string, { token: string; at: number }>();

/** Forget a cached token (after a reconnect, a disconnect, or Meta refusing it). */
export function forgetWaToken(connectionId: string) {
  cache.delete(connectionId);
}

/** The business token for a connection, from Nango (cached a few minutes in this process). */
export async function waTokenFor(connectionId: string, fetchImpl: FetchLike): Promise<string> {
  const hit = cache.get(connectionId);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const r = await nango<{ credentials?: { type?: string; apiKey?: string; api_key?: string } }>(cfg(fetchImpl), "GET", `/connections/${encodeURIComponent(connectionId)}?provider_config_key=${WA_NANGO_INTEGRATION}`);
  if (r.status === 404) throw new NangoTokenGoneError("Nango has no WhatsApp connection with that id");
  if (r.status >= 300) throw new NangoUnavailableError(`Nango answered ${r.status}`);
  const token = r.json.credentials?.apiKey ?? r.json.credentials?.api_key;
  if (!token) throw new NangoTokenGoneError("The Nango connection holds no WhatsApp token");
  if (cache.size > 5000) cache.clear();
  cache.set(connectionId, { token, at: Date.now() });
  return token;
}

/** Delete the store's connection at Nango, with its token. "gone": it wasn't there. */
export async function deleteNangoToken(connectionId: string, fetchImpl: FetchLike): Promise<"deleted" | "gone"> {
  forgetWaToken(connectionId);
  const r = await nango(cfg(fetchImpl), "DELETE", `/connections/${encodeURIComponent(connectionId)}?provider_config_key=${WA_NANGO_INTEGRATION}`);
  if (r.status === 404) return "gone";
  if (r.status >= 300) throw new NangoUnavailableError(`Nango answered ${r.status}`);
  return "deleted";
}

/**
 * Connections in the WhatsApp integration that aren't a store's (`wa-<storeId>`): tokens the earlier
 * "add your token in Nango's window" flow (2026-10-24) left behind when its page closed before it
 * finished. Deleted once they are 30 minutes old, so Nango keeps no token bizinsights doesn't use.
 */
export async function sweepStrayNangoTokens(fetchImpl: FetchLike): Promise<number> {
  if (!env().NANGO_SECRET_KEY) return 0;
  const c = cfg(fetchImpl);
  const r = await nango<{ connections?: Array<{ connection_id?: string; provider_config_key?: string; created?: string }> }>(c, "GET", "/connections");
  if (r.status >= 300) throw new NangoUnavailableError(`Nango answered ${r.status}`);
  const cutoff = Date.now() - 30 * 60_000;
  let deleted = 0;
  for (const x of r.json.connections ?? []) {
    if (x.provider_config_key !== WA_NANGO_INTEGRATION || !x.connection_id || x.connection_id.startsWith("wa-")) continue;
    const created = x.created ? Date.parse(x.created) : 0;
    if (Number.isFinite(created) && created > cutoff) continue;
    if ((await deleteNangoToken(x.connection_id, fetchImpl).catch(() => "gone")) === "deleted") deleted++;
  }
  if (deleted) logger.info({ deleted }, "nango: stray WhatsApp tokens deleted");
  return deleted;
}
