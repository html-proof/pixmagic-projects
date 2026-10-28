/**
 * Connecting through Meta's official WhatsApp Business Platform (Cloud API), docs/whatsapp.md,
 * "Cloud API". Meta's Embedded Signup (in the page, with bizinsights' Meta app and its Facebook
 * Login for Business configuration) gives a code and the business's choices; then, server side:
 *  1. the code becomes the business's token (it lives 30 seconds);
 *  2. Meta's token inspector must say it was issued to bizinsights' app, with both WhatsApp
 *     permissions, for the account the business chose;
 *  3. the number must belong to that account; the account's webhooks are subscribed to
 *     bizinsights' app; the number is registered with the Cloud API;
 *  4. Evolution API gets a WHATSAPP-BUSINESS instance for it (number = Meta's phone number id,
 *     businessId = the account, token = the business's token), and sends through it from then on.
 * The connection is "connected" only once Meta answered all of that. Embedded Signup tokens expire
 * after 60 days; the sweep renews them (a new instance with the new token: a Cloud API instance
 * holds no session).
 *
 * Meta's webhooks for these numbers (statuses, customers' messages, template reviews) come to
 * bizinsights itself, signed with the app secret (X-Hub-Signature-256), and are applied here.
 * Meta onboards a business through Embedded Signup only once it has approved bizinsights as a
 * Tech Provider (business verification, App Review); until then its window says so, not this code.
 */
import { randomBytes, randomInt } from "node:crypto";
import { systemDb, type Store, type WappConnection } from "@app/db";
import { maskPhone, normalizePhone } from "@app/shared";
import { z } from "zod";
import { env } from "../env.js";
import { graphCall, type GraphFailure } from "../metaGraph.js";
import { logger } from "../logger.js";
import { audit, resolveAlerts } from "../notify.js";
import type { FetchLike } from "../shopify.js";
import { connectionOf, waEncrypt, WhatsappError, type WaDeps } from "./common.js";
import { applyInbound } from "./inbound.js";
import { applyMessageStatus } from "./messages.js";
import { clientFor, instanceToken, providerProblem, WA_ALERTS, webhookUrlFor } from "./connection.js";
import { defaultShard, evolutionClient, evolutionConfigured } from "./evolution.js";
import { cloudApiMissing } from "./overview.js";

export interface MetaApp {
  appId: string;
  appSecret: string;
  configId: string;
  version: string;
  verifyToken: string;
}

/** bizinsights' Meta app for WhatsApp (its own, or the Meta Ads app's), or null until every setting is there. */
export function metaApp(): MetaApp | null {
  if (cloudApiMissing().length) return null;
  const e = env();
  const appId = e.WHATSAPP_APP_ID || e.META_APP_ID;
  const appSecret = e.WHATSAPP_APP_SECRET || e.META_APP_SECRET;
  return { appId, appSecret, configId: e.WHATSAPP_CONFIG_ID, version: e.WHATSAPP_API_VERSION, verifyToken: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN };
}

/** What the page needs to open Meta's window (all public). */
export const metaSignupConfig = () => {
  const p = metaApp();
  return p ? { appId: p.appId, configId: p.configId, version: p.version } : null;
};

class MetaError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly detail: string,
  ) {
    super(`Meta ${status}${code !== null ? ` (#${code})` : ""}: ${detail}`);
    this.name = "MetaError";
  }
}
const metaError = (f: GraphFailure) => new MetaError(f.reason === "network" ? 0 : f.status, f.reason === "network" ? null : f.code, f.reason === "network" ? "network" : (f.details || f.userMessage || f.message || "error"));

function graph<T>(p: MetaApp, fetchImpl: FetchLike, token: string, method: "GET" | "POST" | "DELETE", path: string, opts: { query?: Record<string, string>; body?: unknown; appToken?: boolean } = {}): Promise<T> {
  return graphCall<T>(fetchImpl, { version: p.version, method, path, token, ...(opts.appToken ? {} : { appSecret: p.appSecret }), query: opts.query, json: opts.body }, metaError);
}

const REQUIRED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"];
/** Meta's answer when the number already has a two-step verification PIN other than the one sent. */
const PIN_MISMATCH = new Set([133005, 133006]);

export const cloudConnectSchema = z.object({
  code: z.string().trim().min(10).max(2000),
  wabaId: z.string().regex(/^\d{5,25}$/),
  phoneNumberId: z.string().regex(/^\d{5,25}$/),
  businessId: z.string().regex(/^\d{5,25}$/).nullable().optional(),
});

async function inspect(p: MetaApp, fetchImpl: FetchLike, token: string) {
  const r = await graph<{ data?: { app_id?: string; is_valid?: boolean; scopes?: string[]; expires_at?: number; granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }>(p, fetchImpl, `${p.appId}|${p.appSecret}`, "GET", "debug_token", {
    query: { input_token: token },
    appToken: true,
  });
  const d = r.data ?? {};
  const targets = (d.granular_scopes ?? []).filter((g) => g.scope && REQUIRED_SCOPES.includes(g.scope)).flatMap((g) => g.target_ids ?? []);
  return { appId: d.app_id ? String(d.app_id) : null, valid: d.is_valid !== false, scopes: d.scopes ?? [], wabaIds: [...new Set(targets.map(String))], expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null };
}

/**
 * Steps 2-4 above, after Meta's window finished. Refuses (and changes nothing) when any check fails.
 */
export async function connectCloudApi(deps: Pick<WaDeps, "fetchImpl" | "coord">, input: { store: Pick<Store, "id" | "workspaceId">; userId: string; data: unknown; ip?: string }): Promise<WappConnection> {
  const p = metaApp();
  if (!p || !evolutionConfigured()) throw new WhatsappError("Connecting through Meta's Cloud API isn't set up on bizinsights yet.", 503, "cloud_api_off");
  const d = cloudConnectSchema.parse(input.data);
  const existing = await connectionOf(input.store.id);
  if (existing && existing.instanceName && (existing.status === "connected" || existing.status === "reconnecting")) {
    throw new WhatsappError("WhatsApp is already connected for this store. Disconnect it first.", 409, "already_connected");
  }
  if ((await deps.coord.hit(`wapp:cloud:${input.store.id}`, 3600)) > 10) throw new WhatsappError("Too many connection attempts in the last hour. Try again later.", 429, "rate_limited");
  const f = deps.fetchImpl;
  let token: string;
  let info: Awaited<ReturnType<typeof inspect>>;
  let phone: { display_phone_number?: string; verified_name?: string; platform_type?: string; status?: string };
  try {
    const r = await graphCall<{ access_token?: string }>(f, { version: p.version, method: "GET", path: "oauth/access_token", query: { client_id: p.appId, client_secret: p.appSecret, code: d.code } }, metaError);
    if (!r.access_token) throw new MetaError(400, null, "no token for the code");
    token = r.access_token;
    info = await inspect(p, f, token);
    const phones = await graph<{ data?: Array<{ id: string; display_phone_number?: string; verified_name?: string; platform_type?: string; status?: string }> }>(p, f, token, "GET", `${d.wabaId}/phone_numbers`, {
      query: { fields: "id,display_phone_number,verified_name,platform_type,status", limit: "100" },
    });
    const found = (phones.data ?? []).find((x) => x.id === d.phoneNumberId);
    if (!found) throw new WhatsappError("The number you picked isn't in the WhatsApp Business account Meta shared. Try again and pick both in Meta's window.", 400, "phone_not_in_account");
    phone = found;
  } catch (e) {
    if (e instanceof WhatsappError) throw e;
    logger.warn({ err: e, storeId: input.store.id }, "whatsapp cloud api: Meta refused the sign-up");
    throw new WhatsappError("Meta didn't accept the sign-up (its code lasts 30 seconds). Open Meta's window again.", 502, "meta_refused");
  }
  if (!info.valid || info.appId !== p.appId) throw new WhatsappError("Meta's sign-up wasn't for bizinsights' app. Open Meta's window again from this page.", 400, "wrong_app");
  const missing = REQUIRED_SCOPES.filter((s) => !info.scopes.includes(s));
  if (missing.length) throw new WhatsappError("Meta didn't give bizinsights both WhatsApp permissions (manage and message). Open Meta's window again and allow both.", 400, "missing_permissions", { missing });
  if (info.wabaIds.length && !info.wabaIds.includes(d.wabaId)) throw new WhatsappError("Meta didn't share that WhatsApp Business account with bizinsights.", 400, "waba_not_granted");

  try {
    await graph(p, f, token, "POST", `${d.wabaId}/subscribed_apps`);
    if (phone.platform_type !== "CLOUD_API") {
      const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
      try {
        await graph(p, f, token, "POST", `${d.phoneNumberId}/register`, { body: { messaging_product: "whatsapp", pin } });
      } catch (e) {
        if (e instanceof MetaError && e.code !== null && PIN_MISMATCH.has(e.code)) {
          throw new WhatsappError("This number has a two-step verification PIN. Turn it off in WhatsApp Manager (Phone numbers → Two-step verification), then connect again.", 409, "pin_set");
        }
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof WhatsappError) throw e;
    logger.warn({ err: e, storeId: input.store.id }, "whatsapp cloud api: setting up the number failed");
    throw new WhatsappError("Meta refused to set up the number for sending. Check it in WhatsApp Manager, then connect again.", 502, "meta_setup_failed");
  }

  if (existing?.instanceName) {
    try {
      await clientFor(existing, deps).deleteInstance(existing.instanceName, instanceToken(existing));
    } catch {
      /* the sweep removes leftovers */
    }
  }
  const shard = defaultShard();
  const instanceName = `bi_${randomBytes(12).toString("hex")}`;
  const webhookKey = randomBytes(32).toString("base64url");
  const now = new Date();
  const e164 = normalizePhone(phone.display_phone_number ?? null, null)?.e164 ?? null;
  const fields = {
    provider: "cloud_api",
    status: "pairing",
    statusReason: null,
    shard,
    instanceName,
    instanceId: null,
    instanceTokenEnc: waEncrypt(input.store.id, "instance_token", token),
    webhookKeyEnc: waEncrypt(input.store.id, "webhook_key", webhookKey),
    pairingMethod: null,
    phoneEnc: e164 ? waEncrypt(input.store.id, "linked_phone", e164) : null,
    phoneMasked: e164 ? maskPhone(e164) : (phone.display_phone_number ?? null),
    profileName: phone.verified_name?.slice(0, 100) ?? null,
    wabaId: d.wabaId,
    phoneNumberId: d.phoneNumberId,
    businessId: d.businessId ?? null,
    tokenExpiresAt: info.expiresAt,
    qrCount: 0,
    pairingStartedAt: now,
    connectedAt: null,
    disconnectedAt: null,
    lastEventAt: null,
    lastCheckedAt: now,
    downSince: null,
    createdByUserId: input.userId,
  };
  // Another store can't hold the same number (phone_number_id is unique while connected).
  const taken = await systemDb.wappConnection.findFirst({ where: { phoneNumberId: d.phoneNumberId, storeId: { not: input.store.id } }, select: { id: true } });
  if (taken) throw new WhatsappError("This number is already connected to another store on bizinsights.", 409, "number_taken");
  const conn = await systemDb.wappConnection.upsert({ where: { storeId: input.store.id }, create: { workspaceId: input.store.workspaceId, storeId: input.store.id, ...fields }, update: fields });
  const client = evolutionClient(shard, f);
  try {
    const created = await client.createInstance({ instanceName, token, integration: "WHATSAPP-BUSINESS", number: d.phoneNumberId, businessId: d.wabaId });
    await client.setWebhook(instanceName, token, { url: webhookUrlFor(instanceName), jwtKey: webhookKey });
    const updated = await systemDb.wappConnection.update({ where: { id: conn.id }, data: { instanceId: created.instanceId, status: "connected", connectedAt: now } });
    await resolveAlerts(input.store.id, [WA_ALERTS.loggedOut, WA_ALERTS.down, WA_ALERTS.qrRetired]);
    await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.connected", targetType: "store", targetId: input.store.id, metadata: { provider: "cloud_api", wabaId: d.wabaId }, ip: input.ip });
    return updated;
  } catch (e) {
    // The number is let go: another attempt, or another store, may connect it.
    await systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "failed", statusReason: "create_failed", instanceName: null, instanceTokenEnc: null, webhookKeyEnc: null, phoneNumberId: null } });
    throw providerProblem(e);
  }
}

/**
 * Renews a Cloud API connection's token before it expires (fewer than 30 days left), and gives
 * Evolution a new instance holding it. Returns whether it renewed.
 */
export async function renewCloudToken(deps: Pick<WaDeps, "fetchImpl">, conn: WappConnection): Promise<boolean> {
  const p = metaApp();
  if (!p || conn.provider !== "cloud_api" || !conn.instanceName || !conn.tokenExpiresAt) return false;
  if (conn.tokenExpiresAt.getTime() - Date.now() > 30 * 86_400_000) return false;
  const old = instanceToken(conn);
  const r = await graphCall<{ access_token?: string; expires_in?: number }>(
    deps.fetchImpl,
    { version: p.version, method: "GET", path: "oauth/access_token", query: { grant_type: "fb_exchange_token", client_id: p.appId, client_secret: p.appSecret, set_token_expires_in_60_days: "true", fb_exchange_token: old } },
    metaError,
  );
  if (!r.access_token) return false;
  const client = clientFor(conn, deps);
  const instanceName = `bi_${randomBytes(12).toString("hex")}`;
  const webhookKey = randomBytes(32).toString("base64url");
  const created = await client.createInstance({ instanceName, token: r.access_token, integration: "WHATSAPP-BUSINESS", number: conn.phoneNumberId!, businessId: conn.wabaId! });
  await client.setWebhook(instanceName, r.access_token, { url: webhookUrlFor(instanceName), jwtKey: webhookKey });
  await systemDb.wappConnection.update({
    where: { id: conn.id },
    data: {
      instanceName,
      instanceId: created.instanceId,
      instanceTokenEnc: waEncrypt(conn.storeId, "instance_token", r.access_token),
      webhookKeyEnc: waEncrypt(conn.storeId, "webhook_key", webhookKey),
      tokenExpiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : null,
    },
  });
  await client.deleteInstance(conn.instanceName, old).catch(() => {});
  logger.info({ connectionId: conn.id, storeId: conn.storeId }, "whatsapp cloud api token renewed");
  return true;
}

// ---------------------------------------------------------------------------
// Meta's webhooks for Cloud API numbers
// ---------------------------------------------------------------------------

const statusSchema = z.object({ id: z.string().min(1), status: z.string().min(1), timestamp: z.union([z.string(), z.number()]).nullish() }).passthrough();
const inboundSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.union([z.string(), z.number()]).nullish(),
    type: z.string().nullish(),
    text: z.object({ body: z.string().nullish() }).passthrough().nullish(),
    button: z.object({ text: z.string().nullish() }).passthrough().nullish(),
    image: z.object({ caption: z.string().nullish() }).passthrough().nullish(),
    document: z.object({ caption: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();
const changeSchema = z.object({ field: z.string(), value: z.record(z.string(), z.unknown()).optional() }).passthrough();
const bodySchema = z.object({ object: z.string().nullish(), entry: z.array(z.object({ id: z.union([z.string(), z.number()]).optional(), changes: z.array(z.unknown()).nullish() }).passthrough()).nullish() }).passthrough();

const unix = (v: string | number | null | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

/**
 * One delivery of Meta's webhook (signature already checked by the route): statuses and customers'
 * messages for each connected number, and template reviews. Each part applies on its own and is
 * idempotent (Meta retries a delivery it didn't get a 200 for).
 */
export async function applyMetaWebhook(deps: Pick<WaDeps, "queues">, raw: unknown): Promise<{ applied: number; skipped: number }> {
  const body = bodySchema.safeParse(raw);
  let applied = 0;
  let skipped = 0;
  if (!body.success || body.data.object !== "whatsapp_business_account") return { applied, skipped: 1 };
  for (const entry of body.data.entry ?? []) {
    for (const rawChange of entry.changes ?? []) {
      const ch = changeSchema.safeParse(rawChange);
      if (!ch.success) {
        skipped++;
        continue;
      }
      const v = ch.data.value ?? {};
      if (ch.data.field === "message_template_status_update") {
        const id = v.message_template_id != null ? String(v.message_template_id) : null;
        const event = typeof v.event === "string" ? v.event.toUpperCase() : null;
        if (id && event) {
          const n = await systemDb.wappTemplate.updateMany({ where: { metaId: id }, data: { metaStatus: event, metaReason: typeof v.reason === "string" ? v.reason.slice(0, 300) : null, metaCheckedAt: new Date() } });
          applied += n.count;
        }
        continue;
      }
      if (ch.data.field !== "messages") {
        skipped++;
        continue;
      }
      const meta = (v.metadata ?? {}) as { phone_number_id?: unknown };
      const phoneNumberId = meta.phone_number_id != null ? String(meta.phone_number_id) : null;
      const conn = phoneNumberId ? await systemDb.wappConnection.findUnique({ where: { phoneNumberId } }) : null;
      if (!conn || conn.provider !== "cloud_api" || conn.status === "disconnected") {
        skipped++;
        continue;
      }
      // Meta reaching bizinsights about the number brings a connection back, but only one that still has
      // its instance to send through (a failed setup has none, and stays failed).
      if (conn.status !== "connected" && conn.instanceName) await systemDb.wappConnection.update({ where: { id: conn.id }, data: { status: "connected", statusReason: null, downSince: null } });
      await systemDb.wappConnection.update({ where: { id: conn.id }, data: { lastEventAt: new Date() } });
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        const st = statusSchema.safeParse(s);
        if (!st.success) continue;
        await applyMessageStatus(conn, { providerMessageId: st.data.id, status: st.data.status, at: unix(st.data.timestamp) });
        applied++;
      }
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const im = inboundSchema.safeParse(m);
        if (!im.success) continue;
        const text = im.data.text?.body ?? im.data.button?.text ?? im.data.image?.caption ?? im.data.document?.caption ?? null;
        await applyInbound(deps, conn, { id: im.data.id, remoteJid: `${im.data.from}@s.whatsapp.net`, fromMe: false, messageType: im.data.type ?? null, text, at: unix(im.data.timestamp) });
        applied++;
      }
    }
  }
  return { applied, skipped };
}
