// A stand-in for Meta's Graph API as WhatsApp's Cloud API uses it (packages/core/src/whatsapp/cloud.ts
// and cloudApi.ts), for the core, API and worker tests: Embedded Signup's code exchange and Meta's
// token inspector, an account's numbers, its webhook subscription, a number's registration and
// details, messages (text, templates, media by id), media uploads, message templates, token renewal;
// and Meta's webhooks back to bizinsights, signed the way Meta signs them (X-Hub-Signature-256 with
// the app secret). It checks what Meta checks: the token in the Authorization header, its
// appsecret_proof, the token's app and permissions. Nothing leaves the process.
import { createHmac } from "node:crypto";

export const META_APP_ID = "971575545351940";
export const META_APP_SECRET = "meta-secret-for-tests";
export const META_ENV = {
  META_APP_ID,
  META_APP_SECRET,
  WHATSAPP_APP_ID: "",
  WHATSAPP_APP_SECRET: "",
  WHATSAPP_CONFIG_ID: "2228218088074576",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-me",
  WHATSAPP_API_VERSION: "v26.0",
};
/** The settings' names, to clear them after a suite. */
export const META_ENV_OFF = Object.fromEntries(Object.keys(META_ENV).map((k) => [k, ""]));

const GRAPH = "https://graph.facebook.com/v26.0/";
const REQUIRED = ["whatsapp_business_management", "whatsapp_business_messaging"];

export interface FakeToken {
  token: string;
  appId: string;
  scopes: string[];
  wabaIds: string[];
  /** Unix seconds (null: never). */
  expiresAt: number | null;
  valid: boolean;
}

export interface FakeNumber {
  id: string;
  wabaId: string;
  display: string;
  verifiedName: string;
  platformType: "CLOUD_API" | "NOT_APPLICABLE";
}

export interface FakeSend {
  id: string;
  phoneNumberId: string;
  to: string;
  type: string;
  text: string | null;
  template: { name: string; language: string; params: string[] } | null;
  mediaId: string | null;
  caption: string | null;
  filename: string | null;
  reference: string | null;
}

/** How one send fails: Meta's error code (HTTP 400 unless given), no answer at all, or a 2xx without a message id. */
export type FakeFailure = { code: number; status?: number; message?: string } | "refused" | "reset" | "timeout" | 500 | "no_id";

type Webhook = { url: string; headers: Record<string, string>; body: string };

export interface CloudFake {
  tokens: Map<string, FakeToken>;
  numbers: Map<string, FakeNumber>;
  subscribed: Set<string>;
  templates: Array<{ id: string; wabaId: string; name: string; language: string; category: string; status: string; rejected_reason: string | null; components: unknown }>;
  sends: FakeSend[];
  uploads: Array<{ id: string; phoneNumberId: string; type: string; size: number; name: string }>;
  calls: Array<{ method: string; path: string; token: string | null; proof: boolean }>;
  /** What the next sends do, in turn; a send with nothing left here works. */
  sendFails: FakeFailure[];
  /** Every call fails this way (null: none). */
  down: null | "refused" | "timeout" | 500;
  /**
   * Embedded Signup finished in Meta's window: a code for a token (and the account and number the
   * business picked). `appId`, `scopes` and `wabaIds` say what Meta granted; `inAccount: false` makes
   * the picked number belong to another account.
   */
  signup(opts?: { appId?: string; scopes?: string[]; wabaId?: string; phoneNumberId?: string; display?: string; inAccount?: boolean; expiresInDays?: number; registered?: boolean }): { code: string; wabaId: string; phoneNumberId: string; businessId: string };
  /** The business's token for a number (after signup). */
  tokenFor(phoneNumberId: string): FakeToken;
  /** Meta's webhook, signed with the app secret (or `key`). */
  webhook(changes: Array<{ field: string; value: unknown }>, opts?: { key?: string }): Webhook;
  /** Meta's status report for a message bizinsights sent. */
  status(send: Pick<FakeSend, "id" | "phoneNumberId" | "to" | "reference">, status: string, opts?: { error?: { code: number; title?: string; details?: string }; reference?: string | null; at?: Date }): Webhook;
  /** A customer's message to a number. */
  inbound(phoneNumberId: string, from: string, text: string, opts?: { id?: string }): Webhook;
  /** Meta's review of a template. */
  templateReview(templateId: string, event: string, reason?: string): Webhook;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const metaError = (code: number, message: string, status = 400, type = "OAuthException") => json({ error: { message, type, code, fbtrace_id: "Afake" } }, status);
const proofOf = (token: string) => createHmac("sha256", META_APP_SECRET).update(token).digest("hex");

let seq = 0;
const next = () => String(++seq).padStart(6, "0");

export function cloudApiFake(): CloudFake {
  const f: CloudFake = {
    tokens: new Map(),
    numbers: new Map(),
    subscribed: new Set(),
    templates: [],
    sends: [],
    uploads: [],
    calls: [],
    sendFails: [],
    down: null,
    signup(opts = {}) {
      const n = next();
      const wabaId = opts.wabaId ?? `10${n}0000001`;
      const phoneNumberId = opts.phoneNumberId ?? `20${n}0000001`;
      const token = `EAAG${n}${"x".repeat(40)}`;
      f.tokens.set(token, {
        token,
        appId: opts.appId ?? META_APP_ID,
        scopes: opts.scopes ?? [...REQUIRED, "business_management"],
        wabaIds: [wabaId],
        expiresAt: Math.floor(Date.now() / 1000) + (opts.expiresInDays ?? 60) * 86_400,
        valid: true,
      });
      f.numbers.set(phoneNumberId, {
        id: phoneNumberId,
        wabaId: opts.inAccount === false ? `99${n}0000009` : wabaId,
        display: opts.display ?? "+61 400 000 099",
        verifiedName: "Green Leaf",
        platformType: opts.registered ? "CLOUD_API" : "NOT_APPLICABLE",
      });
      const code = `AQ${n}${"c".repeat(30)}`;
      codes.set(code, token);
      return { code, wabaId, phoneNumberId, businessId: `30${n}0000001` };
    },
    tokenFor(phoneNumberId) {
      const n = f.numbers.get(phoneNumberId);
      const t = [...f.tokens.values()].reverse().find((x) => n && x.wabaIds.includes(n.wabaId) && x.valid);
      if (!t) throw new Error(`no token for ${phoneNumberId}`);
      return t;
    },
    webhook(changes, opts = {}) {
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "0", changes }] });
      const sig = `sha256=${createHmac("sha256", opts.key ?? META_APP_SECRET).update(body).digest("hex")}`;
      return { url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body };
    },
    status(send, status, opts = {}) {
      const n = f.numbers.get(send.phoneNumberId);
      const ref = opts.reference !== undefined ? opts.reference : send.reference;
      return f.webhook([
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: n?.display.replace(/\D/g, "") ?? "", phone_number_id: send.phoneNumberId },
            statuses: [
              {
                id: send.id,
                status,
                timestamp: String(Math.floor((opts.at ?? new Date()).getTime() / 1000)),
                recipient_id: send.to,
                ...(ref ? { biz_opaque_callback_data: ref } : {}),
                ...(opts.error ? { errors: [{ code: opts.error.code, title: opts.error.title ?? "Error", message: opts.error.title ?? "Error", error_data: { details: opts.error.details ?? "" } }] } : {}),
              },
            ],
          },
        },
      ]);
    },
    inbound(phoneNumberId, from, text, opts = {}) {
      const digits = from.replace(/\D/g, "");
      return f.webhook([
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "61400000099", phone_number_id: phoneNumberId },
            contacts: [{ profile: { name: "Pat" }, wa_id: digits }],
            messages: [{ from: digits, id: opts.id ?? `wamid.IN${next()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
          },
        },
      ]);
    },
    templateReview(templateId, event, reason) {
      const t = f.templates.find((x) => x.id === templateId);
      if (t) t.status = event;
      return f.webhook([{ field: "message_template_status_update", value: { event, message_template_id: Number(templateId), message_template_name: t?.name, message_template_language: t?.language, reason: reason ?? "NONE" } }]);
    },
    fetch: async (input, init) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (!u.href.startsWith(GRAPH)) throw new Error(`unexpected call to ${u.origin}${u.pathname}`);
      const method = init?.method ?? "GET";
      const path = u.pathname.slice("/v26.0/".length);
      const auth = new Headers(init?.headers).get("authorization");
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const proof = u.searchParams.get("appsecret_proof");
      f.calls.push({ method, path, token: bearer, proof: !!proof });
      if (u.searchParams.has("access_token")) return metaError(100, "A token in the URL: bizinsights never sends one there");
      if (f.down === "refused") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      if (f.down === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (f.down === 500) return metaError(2, "Service temporarily unavailable", 503);
      const parts = path.split("/");

      // Embedded Signup's code exchange, and the token's renewal: the app's id and secret, no bearer.
      if (path === "oauth/access_token") {
        if (u.searchParams.get("client_id") !== META_APP_ID || u.searchParams.get("client_secret") !== META_APP_SECRET) return metaError(1, "Error validating client secret");
        if (u.searchParams.get("grant_type") === "fb_exchange_token") {
          const old = f.tokens.get(u.searchParams.get("fb_exchange_token") ?? "");
          if (!old?.valid || (old.expiresAt && old.expiresAt * 1000 < Date.now())) return metaError(190, "Error validating access token: Session has expired", 400);
          const token = `EAAG${next()}${"r".repeat(40)}`;
          f.tokens.set(token, { ...old, token, expiresAt: Math.floor(Date.now() / 1000) + 60 * 86_400 });
          return json({ access_token: token, token_type: "bearer", expires_in: 60 * 86_400 });
        }
        const code = u.searchParams.get("code") ?? "";
        const token = codes.get(code);
        if (!token) return metaError(100, "Invalid verification code format.");
        codes.delete(code);
        return json({ access_token: token, token_type: "bearer" });
      }
      // Meta's token inspector: the app's own token.
      if (path === "debug_token") {
        if (bearer !== `${META_APP_ID}|${META_APP_SECRET}`) return metaError(190, "Invalid OAuth access token - Cannot parse access token", 400);
        const t = f.tokens.get(u.searchParams.get("input_token") ?? "");
        if (!t) return json({ data: { is_valid: false } });
        return json({
          data: {
            app_id: t.appId,
            type: "SYSTEM_USER",
            application: "bizinsights",
            is_valid: t.valid,
            expires_at: t.expiresAt ?? 0,
            scopes: t.scopes,
            granular_scopes: t.scopes.filter((s) => REQUIRED.includes(s)).map((scope) => ({ scope, target_ids: t.wabaIds })),
          },
        });
      }
      // Everything else: the business's token, with its proof.
      const t = bearer ? f.tokens.get(bearer) : undefined;
      if (!t || !t.valid || (t.expiresAt && t.expiresAt * 1000 < Date.now())) return metaError(190, "Error validating access token: Session has expired", 401);
      if (proof !== proofOf(t.token)) return metaError(100, "Invalid appsecret_proof provided in the API argument");
      const owns = (wabaId: string) => t.wabaIds.includes(wabaId);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

      if (parts.length === 2 && parts[1] === "phone_numbers" && method === "GET") {
        if (!owns(parts[0]!)) return metaError(200, "Permissions error", 403);
        return json({ data: [...f.numbers.values()].filter((n) => n.wabaId === parts[0]).map((n) => ({ id: n.id, display_phone_number: n.display, verified_name: n.verifiedName, platform_type: n.platformType, status: "CONNECTED" })) });
      }
      if (parts.length === 2 && parts[1] === "subscribed_apps") {
        if (!owns(parts[0]!)) return metaError(200, "Permissions error", 403);
        if (method === "POST") f.subscribed.add(parts[0]!);
        if (method === "DELETE") f.subscribed.delete(parts[0]!);
        return json({ success: true });
      }
      if (parts.length === 2 && parts[1] === "message_templates") {
        if (!owns(parts[0]!)) return metaError(200, "Permissions error", 403);
        if (method === "POST") {
          if (f.templates.some((x) => x.wabaId === parts[0] && x.name === body.name && x.language === body.language)) return metaError(100, "Message template already exists in this language", 400);
          const id = `9${next()}000`;
          f.templates.push({ id, wabaId: parts[0]!, name: String(body.name), language: String(body.language), category: String(body.category), status: "PENDING", rejected_reason: null, components: body.components });
          return json({ id, status: "PENDING", category: body.category });
        }
        return json({ data: f.templates.filter((x) => x.wabaId === parts[0]).map(({ id, name, language, category, status, rejected_reason }) => ({ id, name, language, category, status, rejected_reason })), paging: {} });
      }
      const number = f.numbers.get(parts[0]!);
      if (!number) return metaError(100, "Unsupported request - object does not exist", 400, "GraphMethodException");
      if (!owns(number.wabaId)) return metaError(10, "Application does not have permission for this action", 403);
      if (parts.length === 1 && method === "GET") {
        return json({ id: number.id, display_phone_number: number.display, verified_name: number.verifiedName, quality_rating: "GREEN", status: "CONNECTED", platform_type: number.platformType });
      }
      if (parts[1] === "register" && method === "POST") {
        if (body.messaging_product !== "whatsapp" || !/^\d{6}$/.test(String(body.pin))) return metaError(100, "Invalid parameter");
        number.platformType = "CLOUD_API";
        return json({ success: true });
      }
      if (parts[1] === "media" && method === "POST") {
        const form = init?.body;
        if (!(form instanceof FormData) || form.get("messaging_product") !== "whatsapp") return metaError(100, "Invalid parameter");
        const file = form.get("file") as File | null;
        const id = `media-${next()}`;
        f.uploads.push({ id, phoneNumberId: number.id, type: String(form.get("type")), size: file?.size ?? 0, name: file?.name ?? "" });
        return json({ id });
      }
      if (parts[1] === "messages" && method === "POST") {
        if (number.platformType !== "CLOUD_API") return metaError(133010, "Account not registered", 400);
        const fail = f.sendFails.shift();
        if (fail === "refused") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
        if (fail === "reset") throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
        if (fail === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        if (fail === 500) return metaError(131000, "Something went wrong", 500);
        if (fail === "no_id") return json({ messaging_product: "whatsapp" });
        if (fail) return metaError(fail.code, fail.message ?? `(#${fail.code}) refused`, fail.status ?? 400);
        if (body.messaging_product !== "whatsapp" || typeof body.to !== "string" || typeof body.type !== "string") return metaError(100, "Invalid parameter");
        const id = `wamid.HBgL${next()}`;
        const tpl = body.template as { name: string; language: { code: string }; components?: Array<{ type: string; parameters: Array<{ text: string }> }> } | undefined;
        const media = (body.image ?? body.document) as { id: string; caption?: string; filename?: string } | undefined;
        f.sends.push({
          id,
          phoneNumberId: number.id,
          to: body.to,
          type: body.type,
          text: (body.text as { body?: string } | undefined)?.body ?? null,
          template: tpl ? { name: tpl.name, language: tpl.language.code, params: (tpl.components ?? []).flatMap((c) => c.parameters.map((p) => p.text)) } : null,
          mediaId: media?.id ?? null,
          caption: media?.caption ?? null,
          filename: media?.filename ?? null,
          reference: typeof body.biz_opaque_callback_data === "string" ? body.biz_opaque_callback_data : null,
        });
        return json({ messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] });
      }
      return metaError(100, "Unsupported request", 400, "GraphMethodException");
    },
  };
  const codes = new Map<string, string>();
  return f;
}
