// A stand-in for Meta's Graph API on a local port, for the e2e runs (playwright.config.ts): what
// WhatsApp's Cloud API calls (packages/core/src/whatsapp/cloud.ts, cloudApi.ts), answered as Meta
// answers them. The local server sends graph.facebook.com's calls here (LOCAL_GRAPH_URL, apps/aws/
// src/local.ts), so nothing reaches Meta. The tests play Meta's window and WhatsApp through /__control:
//   POST /__control/signup                        Embedded Signup finished: {code, wabaId, phoneNumberId, businessId}
//   GET  /__control/sends                         what was sent: [{id, phoneNumberId, to, type, text, template}]
//   POST /__control/status {id, status, webhook}  Meta's status report for a sent message, posted to bizinsights' webhook, signed
// Usage: node e2e/meta-graph-stub.mjs <port> <app id> <app secret>
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9279);
const appId = process.argv[3] ?? "e2e_meta_app";
const appSecret = process.argv[4] ?? "e2e_meta_secret";
const SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"];

/** token → { wabaId }; code → token; phone number id → { wabaId, display, registered } */
const tokens = new Map();
const codes = new Map();
const numbers = new Map();
const sends = [];
let seq = 0;
const next = () => String(++seq).padStart(6, "0");

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const metaError = (res, code, message, status = 400) => json(res, status, { error: { message, type: "OAuthException", code, fbtrace_id: "Ae2e" } });
const proofOf = (token) => createHmac("sha256", appSecret).update(token).digest("hex");

async function bodyOf(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const raw = await bodyOf(req);
    if (u.pathname.startsWith("/__control/")) {
      const what = u.pathname.slice("/__control/".length);
      if (what === "signup") {
        const n = next();
        const wabaId = `10${n}0000001`;
        const phoneNumberId = `20${n}0000001`;
        const token = `EAAGe2e${n}${"x".repeat(32)}`;
        const code = `AQe2e${n}${"c".repeat(24)}`;
        tokens.set(token, { wabaId });
        codes.set(code, token);
        numbers.set(phoneNumberId, { wabaId, display: "+61 400 000 099", registered: false });
        return json(res, 200, { code, wabaId, phoneNumberId, businessId: `30${n}0000001` });
      }
      if (what === "sends") return json(res, 200, sends);
      if (what === "status") {
        const b = JSON.parse(raw || "{}");
        const sent = sends.find((s) => s.id === b.id);
        if (!sent) return json(res, 404, { error: "no such message" });
        const body = JSON.stringify({
          object: "whatsapp_business_account",
          entry: [{ id: "0", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "61400000099", phone_number_id: sent.phoneNumberId }, statuses: [{ id: sent.id, status: b.status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: sent.to, biz_opaque_callback_data: sent.reference }] } }] }],
        });
        const r = await fetch(b.webhook, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}` }, body });
        return json(res, 200, { delivered: r.status });
      }
      return json(res, 404, { error: "unknown control" });
    }

    const path = u.pathname.replace(/^\/v\d+\.\d+\//, "");
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (path === "oauth/access_token") {
      if (u.searchParams.get("client_id") !== appId || u.searchParams.get("client_secret") !== appSecret) return metaError(res, 1, "Error validating client secret");
      if (u.searchParams.get("grant_type") === "fb_exchange_token") {
        const old = tokens.get(u.searchParams.get("fb_exchange_token") ?? "");
        if (!old) return metaError(res, 190, "Error validating access token");
        const token = `EAAGe2e${next()}${"r".repeat(32)}`;
        tokens.set(token, old);
        return json(res, 200, { access_token: token, token_type: "bearer", expires_in: 60 * 86_400 });
      }
      const token = codes.get(u.searchParams.get("code") ?? "");
      if (!token) return metaError(res, 100, "Invalid verification code format.");
      codes.delete(u.searchParams.get("code"));
      return json(res, 200, { access_token: token, token_type: "bearer" });
    }
    if (path === "debug_token") {
      if (bearer !== `${appId}|${appSecret}`) return metaError(res, 190, "Invalid OAuth access token");
      const t = tokens.get(u.searchParams.get("input_token") ?? "");
      if (!t) return json(res, 200, { data: { is_valid: false } });
      return json(res, 200, { data: { app_id: appId, is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 60 * 86_400, scopes: SCOPES, granular_scopes: SCOPES.map((scope) => ({ scope, target_ids: [t.wabaId] })) } });
    }
    const t = bearer ? tokens.get(bearer) : null;
    if (!t) return metaError(res, 190, "Error validating access token", 401);
    if (u.searchParams.get("appsecret_proof") !== proofOf(bearer)) return metaError(res, 100, "Invalid appsecret_proof provided in the API argument");
    const parts = path.split("/");
    const body = raw && (req.headers["content-type"] ?? "").includes("json") ? JSON.parse(raw) : {};
    if (parts[1] === "phone_numbers") {
      return json(res, 200, { data: [...numbers.entries()].filter(([, n]) => n.wabaId === parts[0]).map(([id, n]) => ({ id, display_phone_number: n.display, verified_name: "Green Leaf", platform_type: n.registered ? "CLOUD_API" : "NOT_APPLICABLE", status: "CONNECTED" })) });
    }
    if (parts[1] === "subscribed_apps") return json(res, 200, { success: true });
    if (parts[1] === "message_templates") return req.method === "POST" ? json(res, 200, { id: `9${next()}`, status: "PENDING", category: body.category }) : json(res, 200, { data: [], paging: {} });
    const number = numbers.get(parts[0]);
    if (!number) return metaError(res, 100, "Unsupported request - object does not exist");
    if (parts.length === 1) return json(res, 200, { id: parts[0], display_phone_number: number.display, verified_name: "Green Leaf", quality_rating: "GREEN", status: "CONNECTED", platform_type: "CLOUD_API" });
    if (parts[1] === "register") {
      number.registered = true;
      return json(res, 200, { success: true });
    }
    if (parts[1] === "media") return json(res, 200, { id: `media-${next()}` });
    if (parts[1] === "messages") {
      const id = `wamid.HBgLe2e${next()}`;
      sends.push({ id, phoneNumberId: parts[0], to: body.to, type: body.type, text: body.text?.body ?? null, template: body.template ?? null, reference: body.biz_opaque_callback_data ?? null });
      console.log(`meta-graph-stub: ${body.type} to …${String(body.to).slice(-3)}`);
      return json(res, 200, { messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] });
    }
    return metaError(res, 100, "Unsupported request");
  } catch (e) {
    json(res, 500, { error: { message: String(e), code: 1 } });
  }
}).listen(port, "127.0.0.1", () => console.log(`meta-graph-stub on ${port}`));
