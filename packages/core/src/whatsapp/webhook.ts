/**
 * Evolution API's webhooks (docs/whatsapp.md, "Webhooks and security").
 *
 * Evolution API 2.3.7 doesn't sign a webhook's body. What it can do (webhook.controller.ts): turn a
 * `jwt_key` header in an instance's webhook settings into `Authorization: Bearer <JWT>`, an HS256
 * token it makes for every call (claims app "evolution", action "webhook", valid 10 minutes). Each
 * connection gets a random key of its own for this, kept encrypted, so a webhook is accepted only
 * when:
 *  - its path names a connection's instance (random names; an unknown one is refused);
 *  - its JWT verifies with that connection's key (HS256 only, compared in constant time), and is
 *    neither expired nor issued in the future;
 *  - the body is JSON that fits the envelope's schema, names the same instance, and isn't too big;
 *  - the instance isn't sending more than RATE_PER_MINUTE.
 * That authenticates the sender, not the body's integrity; the compensating controls are TLS all
 * the way (Evolution posts to bizinsights' HTTPS address), the 10-minute expiry as the replay
 * window, each body stored once by its SHA-256 (a replay inside the window is a duplicate), schema
 * checks, and the instance's events being limited to what bizinsights asked for.
 *
 * Connection events (small, no customer data) are applied at once, so the page sees "connected"
 * the moment WhatsApp says so. Message events are stored encrypted and applied by the worker
 * (the whatsapp queue's wapp_event job), which retries and finally sets an event aside.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { systemDb, type WappConnection } from "@app/db";
import { z } from "zod";
import { logger } from "../logger.js";
import { parsePayload } from "../payloads.js";
import { waDecrypt, waEncrypt, waQueue, type WaDeps } from "./common.js";
import { applyConnectionEvent, type ConnectionEvent } from "./connection.js";
import { applyInbound, textOf } from "./inbound.js";
import { applyMessageStatus } from "./messages.js";

/** Bodies bigger than this are refused (media isn't sent in webhooks: base64 is off). */
export const WEBHOOK_MAX_BYTES = 256 * 1024;
/** Webhooks one instance may send a minute before bizinsights asks it to slow down (429; Evolution retries). */
const RATE_PER_MINUTE = 1200;
/** A stored event that keeps failing is set aside after this many tries. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** Verifies an HS256 JWT as Evolution makes them. */
export function verifyEvolutionJwt(token: string, key: string, nowMs = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: unknown; typ?: unknown };
  let payload: { exp?: unknown; iat?: unknown; app?: unknown; action?: unknown };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return false;
  if (header.alg !== "HS256") return false;
  const expected = createHmac("sha256", key).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const now = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 30) return false;
  if (typeof payload.iat !== "number" || payload.iat > now + 60 || payload.exp - payload.iat > 3600) return false;
  return payload.app === "evolution" && payload.action === "webhook";
}

const envelopeSchema = z
  .object({
    event: z.string().min(1).max(60),
    instance: z.string().min(1).max(100),
    data: z.unknown().optional(),
    date_time: z.string().max(40).optional().nullable(),
  })
  .passthrough();

const connectionDataSchema = z
  .object({ state: z.string().max(20).optional().nullable(), statusReason: z.number().optional().nullable(), wuid: z.string().max(100).optional().nullable(), profileName: z.string().max(200).optional().nullable() })
  .passthrough();
const qrDataSchema = z.object({ message: z.string().max(300).optional().nullable(), statusCode: z.number().optional().nullable() }).passthrough();
const upsertDataSchema = z
  .object({
    key: z.object({ id: z.string().min(1).max(200), remoteJid: z.string().max(200), fromMe: z.boolean() }).passthrough(),
    message: z.record(z.string(), z.unknown()).optional().nullable(),
    messageType: z.string().max(60).optional().nullable(),
    messageTimestamp: z.union([z.number(), z.string()]).optional().nullable(),
  })
  .passthrough();
const updateDataSchema = z.object({ keyId: z.string().min(1).max(200), fromMe: z.boolean().optional().nullable(), status: z.string().max(40) }).passthrough();

/** Evolution's event name in one form: "connection.update" and "CONNECTION_UPDATE" are the same event. */
export const eventName = (e: string) => e.replace(/[.-]/g, "_").toUpperCase();

const parseTime = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

export type WebhookAnswer = { status: 200 | 400 | 401 | 413 | 429; outcome: string };

/** One webhook from Evolution: authenticated, checked, and applied or stored. */
export async function receiveEvolutionWebhook(deps: Pick<WaDeps, "queues" | "fetchImpl" | "mailer" | "coord">, input: { instanceName: string; authorization: string | null | undefined; rawBody: string }): Promise<WebhookAnswer> {
  if (Buffer.byteLength(input.rawBody, "utf8") > WEBHOOK_MAX_BYTES) return { status: 413, outcome: "too_large" };
  const conn = /^bi_[0-9a-f]{24}$/.test(input.instanceName) ? await systemDb.wappConnection.findUnique({ where: { instanceName: input.instanceName } }) : null;
  const token = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? "")?.[1] ?? null;
  // One answer for every way it can be wrong: nothing tells a caller which instance names exist.
  if (!conn?.webhookKeyEnc || !token || !verifyEvolutionJwt(token, waDecrypt(conn.storeId, "webhook_key", conn.webhookKeyEnc))) {
    logger.warn({ instance: input.instanceName.slice(0, 40), known: !!conn, hasToken: !!token }, "whatsapp webhook refused: not authenticated");
    return { status: 401, outcome: "unauthenticated" };
  }
  if ((await deps.coord.hit(`wapp:wh:${conn.id}`, 60)) > RATE_PER_MINUTE) return { status: 429, outcome: "rate_limited" };
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, outcome: "not_json" };
  }
  const env = parsePayload("Evolution", envelopeSchema, raw, "webhook", { connectionId: conn.id });
  if (!env || env.instance !== conn.instanceName) return { status: 400, outcome: "invalid" };
  const event = eventName(env.event);
  const at = parseTime(env.date_time);

  switch (event) {
    case "CONNECTION_UPDATE": {
      const d = parsePayload("Evolution", connectionDataSchema, env.data ?? {}, event, { connectionId: conn.id });
      if (!d) return { status: 200, outcome: "ignored" };
      await applyConnectionEvent(deps, conn, { event, at, state: d.state ?? null, statusReason: d.statusReason ?? null, wuid: d.wuid ?? null, profileName: d.profileName ?? null });
      return { status: 200, outcome: "applied" };
    }
    case "QRCODE_UPDATED": {
      // The QR code itself is never stored or logged: the page reads the current one from Evolution.
      const d = qrDataSchema.safeParse(env.data ?? {});
      const qrLimit = d.success && !!d.data.message && /limit/i.test(d.data.message);
      await applyConnectionEvent(deps, conn, { event, at, qrLimit });
      return { status: 200, outcome: "applied" };
    }
    case "LOGOUT_INSTANCE":
    case "REMOVE_INSTANCE":
      await applyConnectionEvent(deps, conn, { event, at } as ConnectionEvent);
      return { status: 200, outcome: "applied" };
    case "MESSAGES_UPSERT":
    case "MESSAGES_UPDATE":
      return storeEvent(deps, conn, event, at, input.rawBody);
    default:
      return { status: 200, outcome: "ignored" };
  }
}

async function storeEvent(deps: Pick<WaDeps, "queues">, conn: WappConnection, event: string, at: Date | null, rawBody: string): Promise<WebhookAnswer> {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  let id: string;
  try {
    const row = await systemDb.wappWebhookEvent.create({
      data: { workspaceId: conn.workspaceId, storeId: conn.storeId, connectionId: conn.id, event, bodyHash, bodyEnc: waEncrypt(conn.storeId, "webhook", rawBody), status: "pending", providerAt: at },
    });
    id = row.id;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { status: 200, outcome: "duplicate" };
    throw e;
  }
  await waQueue(deps.queues).send({ kind: "wapp_event", eventId: id });
  await systemDb.wappWebhookEvent.update({ where: { id }, data: { enqueuedAt: new Date() } });
  return { status: 200, outcome: "stored" };
}

/** The worker's half: applies one stored message event. Throws to be retried. */
export async function processWebhookEvent(deps: Pick<WaDeps, "queues">, eventId: string): Promise<string> {
  const ev = await systemDb.wappWebhookEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.status !== "pending" || !ev.bodyEnc) return "not_pending";
  await systemDb.wappWebhookEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 } } });
  const conn = await systemDb.wappConnection.findUnique({ where: { id: ev.connectionId } });
  const done = (status: "processed" | "ignored", outcome: string, lastError: string | null = null) =>
    systemDb.wappWebhookEvent.update({ where: { id: ev.id }, data: { status, processedAt: new Date(), bodyEnc: null, lastError } }).then(() => outcome);
  if (!conn || conn.status === "disconnected") return done("ignored", "no_connection");
  const body = JSON.parse(waDecrypt(ev.storeId, "webhook", ev.bodyEnc)) as { data?: unknown };
  const at = ev.providerAt ?? ev.receivedAt;
  if (ev.event === "MESSAGES_UPDATE") {
    const d = parsePayload("Evolution", updateDataSchema, body.data, ev.event, { connectionId: conn.id });
    if (!d) return done("ignored", "invalid");
    if (d.fromMe === false) return done("ignored", "not_ours");
    const r = await applyMessageStatus(conn, { providerMessageId: d.keyId, status: d.status, at });
    return done("processed", r);
  }
  const d = parsePayload("Evolution", upsertDataSchema, body.data, ev.event, { connectionId: conn.id });
  if (!d) return done("ignored", "invalid");
  const ts = d.messageTimestamp != null ? Number(d.messageTimestamp) : NaN;
  // A chat WhatsApp addresses by LID carries the number in remoteJidAlt (Evolution swaps it in when it has it).
  const alt = (d.key as { remoteJidAlt?: unknown }).remoteJidAlt;
  const r = await applyInbound(deps, conn, {
    id: d.key.id,
    remoteJid: d.key.remoteJid.endsWith("@lid") && typeof alt === "string" ? alt : d.key.remoteJid,
    fromMe: d.key.fromMe,
    messageType: d.messageType ?? null,
    text: textOf(d.message ?? null),
    at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : at,
  });
  return done("processed", r);
}

/** A stored event that kept failing: set aside (its body goes), so it stops costing tries. */
export async function setWebhookEventAside(eventId: string, error: string): Promise<void> {
  await systemDb.wappWebhookEvent.updateMany({ where: { id: eventId, status: "pending" }, data: { status: "dead", lastError: error.slice(0, 300), bodyEnc: null, processedAt: new Date() } });
}
