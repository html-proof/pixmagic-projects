// A stand-in for Evolution API 2.3.7 on a local port, for the e2e runs (playwright.config.ts): the
// endpoints bizinsights calls (packages/core/src/whatsapp/evolution.ts), answered as Evolution
// answers them, and webhooks back to bizinsights signed the way Evolution signs them (an HS256 JWT
// from the instance's jwt_key). Nothing leaves the machine. The tests play the phone and WhatsApp
// through /__control:
//   POST /__control/scan    {instance?, phone?}  the phone scanned: the instance opens (CONNECTION_UPDATE)
//   GET  /__control/sends                        what was sent: [{instance, number, text, id}]
//   POST /__control/report  {id, status}         WhatsApp's report on a sent message (MESSAGES_UPDATE)
// Usage: node e2e/evolution-stub.mjs <port> [global api key]
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9269);
const globalKey = process.argv[3] ?? "e2e-evolution-key";
const QR_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** name → { name, id, token, integration, state, qrCount, webhook: {url, jwtKey} | null, ownerJid } */
const instances = new Map();
const sends = [];
let seq = 0;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(key) {
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iat, exp: iat + 600, app: "evolution", action: "webhook" });
  return `${head}.${body}.${createHmac("sha256", key).update(`${head}.${body}`).digest("base64url")}`;
}

async function webhook(inst, event, data) {
  if (!inst.webhook) return;
  const res = await fetch(inst.webhook.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt(inst.webhook.jwtKey)}` },
    body: JSON.stringify({ event, instance: inst.name, data, destination: inst.webhook.url, date_time: new Date().toISOString(), sender: inst.ownerJid, server_url: `http://127.0.0.1:${port}`, apikey: null }),
  }).catch((e) => ({ status: `failed: ${e.message}` }));
  console.log(`evolution-stub: ${event} → ${res.status}`);
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const error = (res, status, message) => json(res, status, { status, error: status === 404 ? "Not Found" : status === 401 ? "Unauthorized" : "Bad Request", response: { message } });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const body = req.method === "GET" ? {} : await readBody(req);
    const [, area, action, rawName] = u.pathname.split("/");

    if (area === "__control") {
      if (action === "sends") return json(res, 200, sends.map((s) => ({ instance: s.instance, number: s.body.number, text: s.body.text ?? s.body.caption ?? null, id: s.id })));
      if (action === "scan") {
        const inst = body.instance ? instances.get(body.instance) : [...instances.values()].at(-1);
        if (!inst) return error(res, 404, "no instance");
        const phone = body.phone ?? "61400000099";
        inst.state = "open";
        inst.ownerJid = `${phone}@s.whatsapp.net`;
        await webhook(inst, "connection.update", { instance: inst.name, wuid: inst.ownerJid, profileName: "E2E Shop", state: "open", statusReason: 200 });
        return json(res, 200, { ok: true, instance: inst.name });
      }
      if (action === "report") {
        const s = sends.find((x) => x.id === body.id);
        if (!s) return error(res, 404, "no such message");
        await webhook(instances.get(s.instance), "messages.update", { keyId: s.id, remoteJid: `${s.body.number}@s.whatsapp.net`, fromMe: true, status: body.status, instanceId: instances.get(s.instance).id });
        return json(res, 200, { ok: true });
      }
      return error(res, 404, "Not Found");
    }

    const apikey = req.headers.apikey ?? null;
    const name = rawName ? decodeURIComponent(rawName) : "";
    const inst = name ? instances.get(name) : undefined;
    if (area === "instance" && (action === "create" || action === "fetchInstances")) {
      if (apikey !== globalKey) return error(res, 401, "Unauthorized");
    } else {
      if (!inst) return error(res, 404, [`The "${name}" instance does not exist`]);
      if (apikey !== globalKey && apikey !== inst.token) return error(res, 401, "Unauthorized");
    }

    if (area === "instance" && action === "create") {
      const instanceName = String(body.instanceName);
      if (instances.has(instanceName)) return error(res, 403, [`This name "${instanceName}" is already in use.`]);
      const id = randomUUID();
      instances.set(instanceName, { name: instanceName, id, token: String(body.token), integration: String(body.integration), state: "close", qrCount: 0, webhook: null, ownerJid: null });
      return json(res, 201, { instance: { instanceName, instanceId: id, integration: body.integration, status: "close" }, hash: body.token, settings: {} });
    }
    if (area === "instance" && action === "fetchInstances") {
      const only = u.searchParams.get("instanceName");
      const list = [...instances.values()].filter((i) => !only || i.name === only);
      if (only && !list.length) return error(res, 404, [`Instance "${only}" not found`]);
      return json(res, 200, list.map((i) => ({ id: i.id, name: i.name, connectionStatus: i.state, ownerJid: i.ownerJid, profileName: i.ownerJid ? "E2E Shop" : null, integration: i.integration, token: i.token })));
    }
    if (area === "webhook" && action === "set") {
      inst.webhook = { url: body.webhook.url, jwtKey: body.webhook.headers.jwt_key };
      return json(res, 201, { id: "wh", url: body.webhook.url, enabled: true });
    }
    if (area === "instance" && action === "connect") {
      if (inst.state === "open") return json(res, 200, { instance: { instanceName: name, state: "open" } });
      inst.state = "connecting";
      inst.qrCount++;
      return json(res, 200, { pairingCode: u.searchParams.get("number") ? "WZYEH1YY" : null, code: `2@stub,${inst.qrCount}`, base64: QR_PNG, count: inst.qrCount });
    }
    if (area === "instance" && action === "connectionState") return json(res, 200, { instance: { instanceName: name, state: inst.state } });
    if (area === "instance" && action === "restart") return json(res, 200, { instance: { instanceName: name, status: inst.state } });
    if (area === "instance" && action === "logout") {
      inst.state = "close";
      return json(res, 200, { status: "SUCCESS", error: false, response: { message: "Instance logged out" } });
    }
    if (area === "instance" && action === "delete") {
      instances.delete(name);
      return json(res, 200, { status: "SUCCESS", error: false, response: { message: "Instance deleted" } });
    }
    if (area === "message") {
      if (inst.state !== "open") return error(res, 400, ["Error: Connection Closed"]);
      const id = `3EB0${String(++seq).padStart(16, "0")}`;
      sends.push({ instance: name, path: action, body, id });
      return json(res, 201, { key: { remoteJid: `${body.number}@s.whatsapp.net`, fromMe: true, id }, status: "PENDING", messageTimestamp: Math.floor(Date.now() / 1000) });
    }
    if (area === "chat" && action === "whatsappNumbers") return json(res, 200, (body.numbers ?? []).map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: true, number: n })));
    return error(res, 404, "Not Found");
  } catch (e) {
    console.error("evolution-stub:", e);
    error(res, 500, String(e));
  }
}).listen(port, "127.0.0.1", () => console.log(`evolution-stub on ${port}`));
