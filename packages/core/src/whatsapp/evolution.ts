/**
 * Evolution API (https://github.com/evolution-foundation/evolution-api), the service that holds
 * each store's WhatsApp connection. Pinned to release 2.3.7 (infra/cdk/lib/whatsapp-stack.ts); every
 * path, field and answer below was read from that release's source (src/api/routes,
 * src/api/controllers, src/api/integrations), not guessed.
 *
 *  - Auth: the `apikey` header. The global key (EVOLUTION_API_KEY) only creates and lists
 *    instances; everything about one instance uses that instance's own key, kept encrypted on its
 *    connection row.
 *  - Errors: a non-2xx answer is `{ status, error, response: { message } }`; a few endpoints answer
 *    200 with `{ error: true, message }` instead (connect, restart).
 *  - Every call has a timeout (EVOLUTION_TIMEOUT_MS). Reads are retried twice on a network error or
 *    a 5xx; sends never are: a send that timed out may still have gone out, and a second would reach
 *    the customer twice.
 *
 * Nothing here logs a key, a QR code, a pairing code, a number or a message.
 */
import { z } from "zod";
import { env } from "../env.js";
import { providerDetail } from "../errors.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";

export type EvolutionErrorKind = "unreachable" | "timeout" | "unauthorized" | "not_found" | "bad_request" | "server" | "invalid_response" | "not_configured";

export class EvolutionError extends Error {
  constructor(
    public readonly kind: EvolutionErrorKind,
    /** The HTTP status (0 when no answer came). */
    public readonly status: number,
    /** Evolution's own words, cleaned (providerDetail): fit for the merchant only through WhatsappError. */
    public readonly detail: string,
    /** For a send: whether the request may have reached WhatsApp (a timeout after it was sent). */
    public readonly uncertain = false,
    /** Evolution's answer, when it said the number isn't on WhatsApp. */
    public readonly notOnWhatsapp = false,
  ) {
    super(`Evolution API ${kind} (${status}): ${detail}`);
    this.name = "EvolutionError";
  }
}

/** "Connection Closed" and the like: the instance isn't connected to WhatsApp right now. */
export const isNotConnected = (e: unknown) => e instanceof EvolutionError && (e.kind === "bad_request" || e.kind === "server") && /connection closed|not connected|closed|socket/i.test(e.detail);

export interface EvolutionServer {
  shard: string;
  url: string;
  apiKey: string;
  timeoutMs: number;
}

/** Whether bizinsights' Evolution API service is set up on this server. */
export const evolutionConfigured = () => !!env().EVOLUTION_API_URL && !!env().EVOLUTION_API_KEY;

/** The shard new connections go to. */
export const defaultShard = () => env().EVOLUTION_SHARD;

/**
 * The server that holds a shard's instances. One shard today (EVOLUTION_SHARD at EVOLUTION_API_URL);
 * a second server is a second ECS service with its own DATABASE_CONNECTION_CLIENT_NAME, and its
 * own URL and key here (docs/whatsapp.md, "Scaling").
 */
export function evolutionServer(shard: string): EvolutionServer {
  const e = env();
  if (!evolutionConfigured()) throw new EvolutionError("not_configured", 0, "Evolution API isn't set up on this server");
  if (shard !== e.EVOLUTION_SHARD) throw new EvolutionError("not_configured", 0, `No Evolution API server for shard ${shard}`);
  return { shard, url: e.EVOLUTION_API_URL.replace(/\/+$/, ""), apiKey: e.EVOLUTION_API_KEY, timeoutMs: e.EVOLUTION_TIMEOUT_MS };
}

// ---------------------------------------------------------------------------
// Answers (only the fields bizinsights reads; anything else Evolution adds passes through)
// ---------------------------------------------------------------------------

const createdSchema = z.object({
  instance: z.object({ instanceName: z.string(), instanceId: z.string(), status: z.string().optional().nullable() }).passthrough(),
}).passthrough();

const qrSchema = z
  .object({
    pairingCode: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    base64: z.string().nullable().optional(),
    count: z.number().nullable().optional(),
  })
  .passthrough();

const stateSchema = z.object({ instance: z.object({ instanceName: z.string(), state: z.string().nullable().optional() }).passthrough() }).passthrough();

const instanceInfoSchema = z
  .object({
    name: z.string(),
    id: z.string().optional(),
    connectionStatus: z.string().nullable().optional(),
    ownerJid: z.string().nullable().optional(),
    profileName: z.string().nullable().optional(),
    integration: z.string().nullable().optional(),
    disconnectionReasonCode: z.number().nullable().optional(),
  })
  .passthrough();

const numberSchema = z.object({ exists: z.boolean(), jid: z.string().optional().nullable(), number: z.string().optional().nullable() }).passthrough();

const sentSchema = z
  .object({
    key: z.object({ id: z.string().min(1), remoteJid: z.string().optional().nullable(), fromMe: z.boolean().optional() }).passthrough(),
    status: z.string().optional().nullable(),
    messageTimestamp: z.union([z.number(), z.string()]).optional().nullable(),
  })
  .passthrough();

const errorSchema = z.object({ status: z.number().optional(), error: z.string().optional(), response: z.object({ message: z.unknown() }).passthrough().optional() }).passthrough();

export type EvolutionQr = { base64: string | null; pairingCode: string | null; count: number | null };
export type EvolutionInstance = z.output<typeof instanceInfoSchema>;
export type EvolutionSent = { id: string; status: string | null; timestamp: Date | null };

/** The events each instance's webhook sends (Evolution's names). Nothing about chats, contacts or groups. */
export const WEBHOOK_EVENTS = ["QRCODE_UPDATED", "CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_UPDATE", "LOGOUT_INSTANCE", "REMOVE_INSTANCE"] as const;

/** Evolution's error message (a string, or an array of strings or objects), cleaned. */
function messageOf(body: unknown): string {
  const parsed = errorSchema.safeParse(body);
  const m = parsed.success ? parsed.data.response?.message : (body as { message?: unknown } | null)?.message;
  const text = Array.isArray(m) ? m.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ") : typeof m === "string" ? m : parsed.success ? (parsed.data.error ?? "") : "";
  return providerDetail(text);
}

/** Evolution's "the number isn't on WhatsApp" answer: response.message = [{ exists: false, jid, number }]. */
function notOnWhatsapp(body: unknown): boolean {
  const parsed = errorSchema.safeParse(body);
  const m = parsed.success ? parsed.data.response?.message : undefined;
  return Array.isArray(m) && m.some((x) => !!x && typeof x === "object" && (x as { exists?: unknown }).exists === false);
}

interface CallOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  key: string;
  body?: unknown;
  query?: Record<string, string>;
  /** Retry network errors and 5xx (reads only). */
  retry?: boolean;
  /** A send: a timeout means it may have gone out. */
  send?: boolean;
}

/**
 * The client for one shard's server. `fetchImpl` is the app's (with its own timeout on AWS), and
 * this adds an abort of its own so no call outlives EVOLUTION_TIMEOUT_MS.
 */
export function evolutionClient(shard: string, fetchImpl: FetchLike) {
  const server = evolutionServer(shard);

  async function call(o: CallOptions): Promise<unknown> {
    const qs = o.query && Object.keys(o.query).length ? `?${new URLSearchParams(o.query).toString()}` : "";
    const url = `${server.url}${o.path}${qs}`;
    const attempts = o.retry ? 3 : 1;
    let last: EvolutionError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), server.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: o.method,
          headers: { apikey: o.key, accept: "application/json", ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const aborted = ac.signal.aborted || (err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError";
        last = aborted ? new EvolutionError("timeout", 0, "Evolution API didn't answer in time", !!o.send) : new EvolutionError("unreachable", 0, "Evolution API couldn't be reached");
        logger.warn({ shard, path: o.path.replace(/\/[^/]+$/, "/:instance"), attempt, kind: last.kind }, "evolution call failed");
        if (aborted && o.send) throw last;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok) return body;
      const detail = messageOf(body) || `HTTP ${res.status}`;
      const kind: EvolutionErrorKind = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_found" : res.status >= 500 ? "server" : "bad_request";
      last = new EvolutionError(kind, res.status, detail, false, res.status === 400 && notOnWhatsapp(body));
      if (kind !== "server" || attempt >= attempts) throw last;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    throw last ?? new EvolutionError("unreachable", 0, "Evolution API couldn't be reached");
  }

  function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.output<S> {
    const r = schema.safeParse(body);
    if (r.success) return r.data;
    logger.warn({ shard, answer: what, problems: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) }, "evolution answer doesn't fit its schema");
    throw new EvolutionError("invalid_response", 200, `Unexpected answer to ${what}`);
  }

  /** Answers like `{ error: true, message }` with a 200. */
  function refused(body: unknown): EvolutionError | null {
    if (body && typeof body === "object" && (body as { error?: unknown }).error === true) return new EvolutionError("bad_request", 200, providerDetail(String((body as { message?: unknown }).message ?? "")));
    return null;
  }

  return {
    shard,

    /**
     * POST /instance/create (global key). `token` becomes the instance's own key. Groups are
     * ignored, nothing is marked read, no history is synced: bizinsights only needs its own
     * messages and the customers who write to the store.
     */
    async createInstance(input: { instanceName: string; token: string; integration: "WHATSAPP-BAILEYS" | "WHATSAPP-BUSINESS"; number?: string; businessId?: string }) {
      const body = await call({
        method: "POST",
        path: "/instance/create",
        key: server.apiKey,
        body: {
          instanceName: input.instanceName,
          token: input.token,
          integration: input.integration,
          qrcode: false,
          ...(input.number ? { number: input.number } : {}),
          ...(input.businessId ? { businessId: input.businessId } : {}),
          rejectCall: false,
          groupsIgnore: true,
          alwaysOnline: false,
          readMessages: false,
          readStatus: false,
          syncFullHistory: false,
        },
      });
      const created = parse(createdSchema, body, "instance create");
      return { instanceId: created.instance.instanceId, status: created.instance.status ?? null };
    },

    /**
     * POST /webhook/set/{instance}: the instance's events go to bizinsights, each signed with an
     * HS256 JWT made from `jwtKey` (Evolution turns a `jwt_key` header into
     * `Authorization: Bearer <jwt>`, valid 10 minutes; webhook.controller.ts).
     */
    async setWebhook(instanceName: string, token: string, input: { url: string; jwtKey: string }) {
      await call({
        method: "POST",
        path: `/webhook/set/${encodeURIComponent(instanceName)}`,
        key: token,
        body: { webhook: { enabled: true, url: input.url, headers: { jwt_key: input.jwtKey }, byEvents: false, base64: false, events: [...WEBHOOK_EVENTS] } },
      });
    },

    /**
     * GET /instance/connect/{instance}: starts the connection when it is closed, and answers the
     * current QR code (and pairing code, when `number` is given) while it is connecting. Open: the
     * state instead.
     */
    async connect(instanceName: string, token: string, number?: string | null): Promise<{ state: string | null; qr: EvolutionQr | null }> {
      const body = await call({ method: "GET", path: `/instance/connect/${encodeURIComponent(instanceName)}`, key: token, query: number ? { number } : undefined });
      const no = refused(body);
      if (no) throw no;
      const st = stateSchema.safeParse(body);
      if (st.success && st.data.instance.state) return { state: st.data.instance.state, qr: null };
      const qr = parse(qrSchema, body ?? {}, "instance connect");
      // Only a PNG data URL is ever put in front of the merchant.
      const base64 = qr.base64 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr.base64) ? qr.base64 : null;
      return { state: base64 || qr.pairingCode ? "connecting" : null, qr: base64 || qr.pairingCode ? { base64, pairingCode: qr.pairingCode ?? null, count: qr.count ?? null } : null };
    },

    /** GET /instance/connectionState/{instance}: open | connecting | close (null: none yet). */
    async connectionState(instanceName: string, token: string): Promise<string | null> {
      const body = await call({ method: "GET", path: `/instance/connectionState/${encodeURIComponent(instanceName)}`, key: token, retry: true });
      return parse(stateSchema, body, "connection state").instance.state ?? null;
    },

    /** POST /instance/restart/{instance}: closes the socket and reconnects with the saved session. */
    async restart(instanceName: string, token: string) {
      const body = await call({ method: "POST", path: `/instance/restart/${encodeURIComponent(instanceName)}`, key: token });
      const no = refused(body);
      if (no) throw no;
    },

    /** DELETE /instance/logout/{instance}: ends the WhatsApp session (the phone's linked device goes). Not connected already: fine. */
    async logout(instanceName: string, token: string) {
      try {
        await call({ method: "DELETE", path: `/instance/logout/${encodeURIComponent(instanceName)}`, key: token });
      } catch (e) {
        if (e instanceof EvolutionError && (e.kind === "not_found" || (e.kind === "bad_request" && /not connected/i.test(e.detail)))) return;
        throw e;
      }
    },

    /** DELETE /instance/delete/{instance}: the instance and its saved session go. Already gone: fine. */
    async deleteInstance(instanceName: string, token: string) {
      try {
        await call({ method: "DELETE", path: `/instance/delete/${encodeURIComponent(instanceName)}`, key: token });
      } catch (e) {
        if (e instanceof EvolutionError && e.kind === "not_found") return;
        throw e;
      }
    },

    /** GET /instance/fetchInstances (global key): every instance on this server, with the state Evolution last saved. */
    async fetchInstances(instanceName?: string): Promise<EvolutionInstance[]> {
      const body = await call({ method: "GET", path: "/instance/fetchInstances", key: server.apiKey, query: instanceName ? { instanceName } : undefined, retry: true });
      return parse(z.array(instanceInfoSchema), body ?? [], "fetch instances");
    },

    /** POST /chat/whatsappNumbers/{instance}: whether numbers are on WhatsApp. */
    async checkNumbers(instanceName: string, token: string, numbers: string[]) {
      const body = await call({ method: "POST", path: `/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`, key: token, body: { numbers }, retry: true });
      return parse(z.array(numberSchema), body ?? [], "whatsapp numbers");
    },

    /** POST /message/sendText/{instance}. `number`: E.164 digits. */
    async sendText(instanceName: string, token: string, input: { number: string; text: string }): Promise<EvolutionSent> {
      const body = await call({ method: "POST", path: `/message/sendText/${encodeURIComponent(instanceName)}`, key: token, body: { number: input.number, text: input.text, linkPreview: true }, send: true });
      throw0(refusedSend(body));
      return sentOf(parse(sentSchema, body, "send text"));
    },

    /** POST /message/sendMedia/{instance}: an image or document, `media` as base64. */
    async sendMedia(instanceName: string, token: string, input: { number: string; mediatype: "image" | "document"; mimetype: string; media: string; fileName: string; caption?: string }): Promise<EvolutionSent> {
      const body = await call({
        method: "POST",
        path: `/message/sendMedia/${encodeURIComponent(instanceName)}`,
        key: token,
        body: { number: input.number, mediatype: input.mediatype, mimetype: input.mimetype, media: input.media, fileName: input.fileName, ...(input.caption ? { caption: input.caption } : {}) },
        send: true,
      });
      throw0(refusedSend(body));
      return sentOf(parse(sentSchema, body, "send media"));
    },

    /**
     * POST /message/sendTemplate/{instance} (WHATSAPP-BUSINESS instances only): a template Meta
     * approved, with its body's parameters in order.
     */
    async sendTemplate(instanceName: string, token: string, input: { number: string; name: string; language: string; bodyParams: string[] }): Promise<EvolutionSent> {
      const body = await call({
        method: "POST",
        path: `/message/sendTemplate/${encodeURIComponent(instanceName)}`,
        key: token,
        body: {
          number: input.number,
          name: input.name,
          language: input.language,
          components: input.bodyParams.length ? [{ type: "body", parameters: input.bodyParams.map((text) => ({ type: "text", text })) }] : [],
        },
        send: true,
      });
      throw0(refusedSend(body));
      return sentOf(parse(sentSchema, body, "send template"));
    },

    /** POST /template/create/{instance} (WHATSAPP-BUSINESS): submits a template to Meta for review. */
    async createWaTemplate(instanceName: string, token: string, input: { name: string; category: "UTILITY" | "MARKETING"; language: string; components: unknown[] }) {
      const body = await call({ method: "POST", path: `/template/create/${encodeURIComponent(instanceName)}`, key: token, body: { name: input.name, category: input.category, allowCategoryChange: false, language: input.language, components: input.components } });
      return z.object({ id: z.string().optional(), status: z.string().optional(), category: z.string().optional() }).passthrough().parse(body ?? {});
    },

    /** GET /template/find/{instance} (WHATSAPP-BUSINESS): the account's templates, with Meta's review of each. */
    async findTemplates(instanceName: string, token: string) {
      const body = await call({ method: "GET", path: `/template/find/${encodeURIComponent(instanceName)}`, key: token, retry: true });
      const list = Array.isArray(body) ? body : ((body as { data?: unknown })?.data ?? []);
      return parse(z.array(z.object({ id: z.string(), name: z.string(), language: z.string(), status: z.string(), category: z.string().optional(), rejected_reason: z.string().optional().nullable() }).passthrough()), list, "find templates");
    },
  };
}

export type EvolutionClient = ReturnType<typeof evolutionClient>;

function throw0(e: EvolutionError | null): void {
  if (e) throw e;
}

/**
 * A send Evolution answered without a message: its Cloud API integration hands back Meta's error object
 * (with a 2xx) instead of failing. Meta's reason, cleaned, as a refusal.
 */
function refusedSend(body: unknown): EvolutionError | null {
  if (!body || typeof body !== "object" || (body as { key?: unknown }).key) return null;
  const b = body as { message?: unknown; error_data?: { details?: unknown } | null; code?: unknown };
  if (b.message === undefined && b.error_data === undefined) return null;
  const detail = providerDetail([b.message, b.error_data?.details].filter((x) => typeof x === "string").join(" - "));
  return new EvolutionError("bad_request", 200, detail || "WhatsApp refused the message", false, false);
}

function sentOf(s: z.output<typeof sentSchema>): EvolutionSent {
  const ts = s.messageTimestamp == null ? null : Number(s.messageTimestamp);
  return { id: s.key.id, status: s.status ?? null, timestamp: ts && Number.isFinite(ts) ? new Date(ts * 1000) : null };
}

/** A WhatsApp JID's number ("61412345678@s.whatsapp.net" → "61412345678"); null for groups, broadcasts, LIDs. */
export function jidNumber(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const m = /^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return m ? m[1]! : null;
}
