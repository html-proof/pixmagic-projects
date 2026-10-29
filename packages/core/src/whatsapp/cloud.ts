/**
 * Connecting through Meta's WhatsApp Business Platform (Cloud API), the only way to connect
 * (docs/whatsapp.md, "Connecting"). Meta's Embedded Signup (in the page, with bizinsights' Meta app
 * and its Facebook Login for Business configuration) gives a code and the business's choices; then,
 * server side:
 *  1. the code becomes the business's token (it lives 30 seconds);
 *  2. Meta's token inspector must say it was issued to bizinsights' app, with both WhatsApp
 *     permissions, for the account the business chose;
 *  3. the number must belong to that account; the account's webhooks are subscribed to
 *     bizinsights' app; the number is registered with the Cloud API;
 *  4. the token is kept on the connection row, encrypted, and bizinsights sends with it (cloudApi.ts).
 * The connection is "connected" only once Meta answered all of that. Embedded Signup tokens expire
 * after 60 days; the sweep renews them (renewCloudToken) and asks for a reconnect when it can't.
 *
 * Meta's webhooks for these numbers (statuses, customers' messages, template reviews) come to
 * bizinsights itself, signed with the app secret (X-Hub-Signature-256), and are applied here.
 * Meta onboards a business through Embedded Signup only once it has approved bizinsights as a
 * Tech Provider (business verification, App Review); until then its window says so, not this code.
 * Meanwhile the workspaces in WHATSAPP_TOKEN_CONNECT_WORKSPACES (bizinsights' own team) may start at
 * step 2 instead, with a token of bizinsights' app made in Meta's dashboard (connectCloudApiWithToken):
 * the same checks, so App Review can be recorded with the app's own test number.
 */
import { randomInt } from "node:crypto";
import { systemDb, type Store, type WappConnection } from "@app/db";
import { maskPhone, normalizePhone, WA_RETIRED_PROVIDER } from "@app/shared";
import { z } from "zod";
import { env } from "../env.js";
import { graphCall, type GraphFailure } from "../metaGraph.js";
import { logger } from "../logger.js";
import { audit, resolveAlerts } from "../notify.js";
import type { FetchLike } from "../shopify.js";
import { connectionOf, WA_ALERTS, waEncrypt, WhatsappError, type WaDeps } from "./common.js";
import { businessToken, CloudApiError, cloudFailure, metaApp, metaErrorInfo, type MetaApp } from "./cloudApi.js";
import { markReconnect, reconnectReasonOf } from "./connection.js";
import { applyInbound } from "./inbound.js";
import { applyMessageStatus } from "./messages.js";
import { dropEvolutionInstance, retireQrConnection } from "./retireQr.js";

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
/** Where bizinsights keeps Cloud API numbers: Meta's servers (the row's `shard` named an Evolution API server before). */
const META_SHARD = "meta";

export const cloudConnectSchema = z.object({
  code: z.string().trim().min(10).max(2000),
  wabaId: z.string().regex(/^\d{5,25}$/),
  phoneNumberId: z.string().regex(/^\d{5,25}$/),
  businessId: z.string().regex(/^\d{5,25}$/).nullable().optional(),
});

export const cloudTokenConnectSchema = z.object({
  accessToken: z.string().trim().min(20).max(2000).regex(/^\S+$/),
  wabaId: z.string().trim().regex(/^\d{5,25}$/),
  phoneNumberId: z.string().trim().regex(/^\d{5,25}$/),
});

/** Whether this workspace may connect with a token of bizinsights' own Meta app (WHATSAPP_TOKEN_CONNECT_WORKSPACES). */
export const tokenConnectAllowed = (workspaceId: string): boolean =>
  env()
    .WHATSAPP_TOKEN_CONNECT_WORKSPACES.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(workspaceId);

type Via = "embedded_signup" | "app_token";

/** Each refusal in the words of the way the business came in. */
const REFUSED: Record<Via, Record<"wrongApp" | "missing" | "waba" | "phone" | "list", string>> = {
  embedded_signup: {
    wrongApp: "Meta's sign-up wasn't for bizinsights' app. Open Meta's window again from this page.",
    missing: "Meta didn't give bizinsights both WhatsApp permissions (manage and message). Open Meta's window again and allow both.",
    waba: "Meta didn't share that WhatsApp Business account with bizinsights.",
    phone: "The number you picked isn't in the WhatsApp Business account Meta shared. Try again and pick both in Meta's window.",
    list: "Meta didn't show bizinsights the account's phone numbers. Open Meta's window again.",
  },
  app_token: {
    wrongApp: "Meta says that token isn't a valid one of bizinsights' Meta app. Make a new one for the app bizinsights.",
    missing: "That token doesn't have both WhatsApp permissions (whatsapp_business_management and whatsapp_business_messaging). Make one that has both.",
    waba: "That token can't reach that WhatsApp Business account.",
    phone: "That phone number ID isn't in that WhatsApp Business account. Copy both from Meta's API Setup page.",
    list: "Meta didn't show bizinsights that account's phone numbers with that token.",
  },
};

async function inspect(p: MetaApp, fetchImpl: FetchLike, token: string) {
  const r = await graph<{ data?: { app_id?: string; is_valid?: boolean; scopes?: string[]; expires_at?: number; granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }>(p, fetchImpl, `${p.appId}|${p.appSecret}`, "GET", "debug_token", {
    query: { input_token: token },
    appToken: true,
  });
  const d = r.data ?? {};
  const targets = (d.granular_scopes ?? []).filter((g) => g.scope && REQUIRED_SCOPES.includes(g.scope)).flatMap((g) => g.target_ids ?? []);
  return { appId: d.app_id ? String(d.app_id) : null, valid: d.is_valid !== false, scopes: d.scopes ?? [], wabaIds: [...new Set(targets.map(String))], expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null };
}

type ConnectInput = { store: Pick<Store, "id" | "workspaceId">; userId: string; data: unknown; ip?: string };

/** What both ways in check first: bizinsights' Meta app is set up, the store isn't connected, not too many tries. */
function requireMetaApp(): MetaApp {
  const p = metaApp();
  if (!p) throw new WhatsappError("Connecting WhatsApp isn't set up on bizinsights yet: its Meta app isn't configured.", 503, "cloud_api_off");
  return p;
}
async function connectable(deps: Pick<WaDeps, "coord">, storeId: string): Promise<WappConnection | null> {
  const existing = await connectionOf(storeId);
  if (existing && existing.provider === "cloud_api" && existing.instanceTokenEnc && (existing.status === "connected" || existing.status === "reconnecting")) {
    throw new WhatsappError("WhatsApp is already connected for this store. Disconnect it first.", 409, "already_connected");
  }
  if ((await deps.coord.hit(`wapp:cloud:${storeId}`, 3600)) > 10) throw new WhatsappError("Too many connection attempts in the last hour. Try again later.", 429, "rate_limited");
  return existing;
}

/**
 * Steps 1-4 above, after Meta's window finished. Refuses (and changes nothing) when any check fails.
 */
export async function connectCloudApi(deps: Pick<WaDeps, "fetchImpl" | "coord" | "mailer">, input: ConnectInput): Promise<WappConnection> {
  const p = requireMetaApp();
  const d = cloudConnectSchema.parse(input.data);
  const existing = await connectable(deps, input.store.id);
  let token: string;
  let info: Awaited<ReturnType<typeof inspect>>;
  try {
    const r = await graphCall<{ access_token?: string }>(deps.fetchImpl, { version: p.version, method: "GET", path: "oauth/access_token", query: { client_id: p.appId, client_secret: p.appSecret, code: d.code } }, metaError);
    if (!r.access_token) throw new MetaError(400, null, "no token for the code");
    token = r.access_token;
    info = await inspect(p, deps.fetchImpl, token);
  } catch (e) {
    logger.warn({ err: e, storeId: input.store.id }, "whatsapp cloud api: Meta refused the sign-up");
    throw new WhatsappError("Meta didn't accept the sign-up (its code lasts 30 seconds). Open Meta's window again.", 502, "meta_refused");
  }
  return finishConnect(deps, p, "embedded_signup", { ...input, existing, token, info, wabaId: d.wabaId, phoneNumberId: d.phoneNumberId, businessId: d.businessId ?? null });
}

/**
 * Steps 2-4 above with a token of bizinsights' own Meta app that someone with a role on the app made
 * in Meta's dashboard (a system user's, or API Setup's temporary one), for the workspaces in
 * WHATSAPP_TOKEN_CONNECT_WORKSPACES only. Meta's token inspector decides the rest, as for Embedded
 * Signup: bizinsights' app, both WhatsApp permissions, the account. The token is never logged.
 */
export async function connectCloudApiWithToken(deps: Pick<WaDeps, "fetchImpl" | "coord" | "mailer">, input: ConnectInput): Promise<WappConnection> {
  if (!tokenConnectAllowed(input.store.workspaceId)) throw new WhatsappError("Connecting with a token of bizinsights' own Meta app isn't offered to this workspace. Connect WhatsApp Business with Meta's window.", 403, "token_connect_off");
  const p = requireMetaApp();
  const d = cloudTokenConnectSchema.parse(input.data);
  const existing = await connectable(deps, input.store.id);
  let info: Awaited<ReturnType<typeof inspect>>;
  try {
    info = await inspect(p, deps.fetchImpl, d.accessToken);
  } catch (e) {
    logger.warn({ err: e, storeId: input.store.id }, "whatsapp cloud api: Meta didn't inspect the app token");
    throw new WhatsappError("Meta didn't check that token for bizinsights. Try again in a minute.", 502, "meta_refused");
  }
  return finishConnect(deps, p, "app_token", { ...input, existing, token: d.accessToken, info, wabaId: d.wabaId, phoneNumberId: d.phoneNumberId, businessId: null });
}

/** Steps 2-4, the same whichever way the token came: refuses (and changes nothing) when any check fails. */
async function finishConnect(
  deps: Pick<WaDeps, "fetchImpl" | "coord" | "mailer">,
  p: MetaApp,
  via: Via,
  input: ConnectInput & { existing: WappConnection | null; token: string; info: Awaited<ReturnType<typeof inspect>>; wabaId: string; phoneNumberId: string; businessId: string | null },
): Promise<WappConnection> {
  const { existing, token, info } = input;
  const d = { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, businessId: input.businessId };
  const say = REFUSED[via];
  const f = deps.fetchImpl;
  let phone: { display_phone_number?: string; verified_name?: string; platform_type?: string; status?: string };
  // Checked before the token is used for anything: it must be bizinsights' app's, for this account.
  if (!info.valid || info.appId !== p.appId) throw new WhatsappError(say.wrongApp, 400, "wrong_app");
  const missing = REQUIRED_SCOPES.filter((s) => !info.scopes.includes(s));
  if (missing.length) throw new WhatsappError(say.missing, 400, "missing_permissions", { missing });
  if (info.wabaIds.length && !info.wabaIds.includes(d.wabaId)) throw new WhatsappError(say.waba, 400, "waba_not_granted");
  try {
    const phones = await graph<{ data?: Array<{ id: string; display_phone_number?: string; verified_name?: string; platform_type?: string; status?: string }> }>(p, f, token, "GET", `${d.wabaId}/phone_numbers`, {
      query: { fields: "id,display_phone_number,verified_name,platform_type,status", limit: "100" },
    });
    const found = (phones.data ?? []).find((x) => x.id === d.phoneNumberId);
    if (!found) throw new WhatsappError(say.phone, 400, "phone_not_in_account");
    phone = found;
  } catch (e) {
    if (e instanceof WhatsappError) throw e;
    logger.warn({ err: e, storeId: input.store.id }, "whatsapp cloud api: Meta didn't list the account's numbers");
    throw new WhatsappError(say.list, 502, "meta_refused");
  }
  // Another store can't hold the same number (phone_number_id is unique while connected).
  const taken = await systemDb.wappConnection.findFirst({ where: { phoneNumberId: d.phoneNumberId, storeId: { not: input.store.id } }, select: { id: true } });
  if (taken) throw new WhatsappError("This number is already connected to another store on bizinsights.", 409, "number_taken");

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

  // What the store had before goes first: a phone linked with a QR code is retired (its waiting
  // messages cancelled with that reason, never sent through the new number); an Evolution API
  // instance left from an earlier Cloud API connection is deleted.
  if (existing?.provider === WA_RETIRED_PROVIDER) await retireQrConnection(deps, existing);
  else if (existing?.instanceName) await dropEvolutionInstance(existing, deps);

  const now = new Date();
  const e164 = normalizePhone(phone.display_phone_number ?? null, null)?.e164 ?? null;
  const fields = {
    provider: "cloud_api",
    status: "connected",
    statusReason: null,
    shard: META_SHARD,
    instanceName: null,
    instanceId: null,
    instanceTokenEnc: waEncrypt(input.store.id, "instance_token", token),
    webhookKeyEnc: null,
    pairingMethod: null,
    phoneEnc: e164 ? waEncrypt(input.store.id, "linked_phone", e164) : null,
    phoneMasked: e164 ? maskPhone(e164) : (phone.display_phone_number ?? null),
    profileName: phone.verified_name?.slice(0, 100) ?? null,
    wabaId: d.wabaId,
    phoneNumberId: d.phoneNumberId,
    businessId: d.businessId,
    tokenExpiresAt: info.expiresAt,
    qrCount: 0,
    pairingStartedAt: null,
    connectedAt: now,
    disconnectedAt: null,
    lastEventAt: null,
    lastCheckedAt: now,
    downSince: null,
    createdByUserId: input.userId,
  };
  const conn = await systemDb.wappConnection.upsert({ where: { storeId: input.store.id }, create: { workspaceId: input.store.workspaceId, storeId: input.store.id, ...fields }, update: fields });
  await resolveAlerts(input.store.id, [WA_ALERTS.reconnect, WA_ALERTS.down, WA_ALERTS.qrRetired, WA_ALERTS.loggedOut, WA_ALERTS.provider]);
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.connected", targetType: "store", targetId: input.store.id, metadata: { provider: "cloud_api", wabaId: d.wabaId, via }, ip: input.ip });
  logger.info({ connectionId: conn.id, storeId: input.store.id, via }, "whatsapp connected through Meta's Cloud API");
  return conn;
}

/** Fewer days than this left on the token: the sweep renews it. */
const RENEW_BEFORE_MS = 30 * 86_400_000;

/**
 * Renews a connection's token before it expires (fewer than 30 days left), on the row. Returns
 * whether it renewed. A token Meta no longer accepts (or one already past its expiry) means the
 * merchant connects again: the connection says so and the alert goes (markReconnect).
 */
export async function renewCloudToken(deps: Pick<WaDeps, "fetchImpl" | "mailer">, conn: WappConnection): Promise<boolean> {
  const p = metaApp();
  if (!p || conn.provider !== "cloud_api" || conn.status !== "connected" || !conn.instanceTokenEnc || !conn.tokenExpiresAt) return false;
  if (conn.tokenExpiresAt.getTime() - Date.now() > RENEW_BEFORE_MS) return false;
  if (conn.tokenExpiresAt.getTime() <= Date.now()) {
    await markReconnect(deps, conn, "token_expired");
    return false;
  }
  let r: { access_token?: string; expires_in?: number };
  try {
    r = await graphCall(
      deps.fetchImpl,
      { version: p.version, method: "GET", path: "oauth/access_token", query: { grant_type: "fb_exchange_token", client_id: p.appId, client_secret: p.appSecret, set_token_expires_in_60_days: "true", fb_exchange_token: businessToken(conn) } },
      (f) => cloudFailure(f, false),
    );
  } catch (e) {
    if (e instanceof CloudApiError && e.kind === "auth") {
      await markReconnect(deps, conn, reconnectReasonOf(e), e.metaCode);
      return false;
    }
    throw e;
  }
  if (!r.access_token) return false;
  // Only over the token that was read: a reconnect meanwhile keeps its own.
  const n = await systemDb.wappConnection.updateMany({
    where: { id: conn.id, instanceTokenEnc: conn.instanceTokenEnc },
    data: { instanceTokenEnc: waEncrypt(conn.storeId, "instance_token", r.access_token), tokenExpiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : null },
  });
  if (n.count) logger.info({ connectionId: conn.id, storeId: conn.storeId }, "whatsapp cloud api token renewed");
  return n.count > 0;
}

// ---------------------------------------------------------------------------
// Meta's webhooks
// ---------------------------------------------------------------------------

const statusSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    timestamp: z.union([z.string(), z.number()]).nullish(),
    biz_opaque_callback_data: z.string().max(512).nullish(),
    errors: z.array(z.object({ code: z.number().nullish(), title: z.string().nullish(), message: z.string().nullish(), error_data: z.object({ details: z.string().nullish() }).passthrough().nullish() }).passthrough()).nullish(),
  })
  .passthrough();
const inboundSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.union([z.string(), z.number()]).nullish(),
    type: z.string().nullish(),
    text: z.object({ body: z.string().nullish() }).passthrough().nullish(),
    button: z.object({ text: z.string().nullish() }).passthrough().nullish(),
    interactive: z.object({ button_reply: z.object({ title: z.string().nullish() }).passthrough().nullish(), list_reply: z.object({ title: z.string().nullish() }).passthrough().nullish() }).passthrough().nullish(),
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
 * idempotent (Meta delivers again what it didn't get a 200 for): a status is recorded once per
 * message and status, a customer's message once by its id.
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
      // A number disconnected here was let go (phone_number_id cleared): its reports belong to nobody now.
      if (!conn || conn.provider !== "cloud_api" || conn.status === "disconnected") {
        skipped++;
        continue;
      }
      await systemDb.wappConnection.update({ where: { id: conn.id }, data: { lastEventAt: new Date() } });
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        const st = statusSchema.safeParse(s);
        if (!st.success) continue;
        const err = st.data.errors?.[0];
        const code = err?.code ?? null;
        await applyMessageStatus(conn, {
          providerMessageId: st.data.id,
          status: st.data.status,
          at: unix(st.data.timestamp),
          reference: st.data.biz_opaque_callback_data ?? null,
          error: err ? { code, detail: metaErrorInfo(code, err.error_data?.details ?? err.message ?? err.title).text } : null,
        });
        applied++;
      }
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const im = inboundSchema.safeParse(m);
        if (!im.success) continue;
        const text = im.data.text?.body ?? im.data.button?.text ?? im.data.interactive?.button_reply?.title ?? im.data.interactive?.list_reply?.title ?? im.data.image?.caption ?? im.data.document?.caption ?? null;
        await applyInbound(deps, conn, { id: im.data.id, remoteJid: `${im.data.from}@s.whatsapp.net`, fromMe: false, messageType: im.data.type ?? null, text, at: unix(im.data.timestamp) });
        applied++;
      }
    }
  }
  return { applied, skipped };
}
