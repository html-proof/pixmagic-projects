// A stand-in for Evolution API 2.3.7 (the endpoints bizinsights calls: packages/core/src/whatsapp/
// evolution.ts), for the API and worker tests: instances, their webhooks, pairing with a QR code,
// the connection state, sends, and webhooks back to bizinsights signed the way Evolution signs them
// (an HS256 JWT made from the instance's jwt_key). Nothing leaves the process.
import { createHmac } from "node:crypto";

export const EVOLUTION_URL = "http://evolution.test:8080";
export const EVOLUTION_KEY = "global-evolution-key-for-tests";
export const EVOLUTION_ENV = { EVOLUTION_API_URL: EVOLUTION_URL, EVOLUTION_API_KEY: EVOLUTION_KEY, EVOLUTION_SHARD: "a" };

/** A 1x1 PNG, as Evolution's QR codes are data URLs of PNGs. */
export const QR_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (status: number, message: unknown) => json({ status, error: status === 404 ? "Not Found" : status === 401 ? "Unauthorized" : "Bad Request", response: { message } }, status);

export interface FakeInstance {
  name: string;
  id: string;
  token: string;
  integration: string;
  state: "close" | "connecting" | "open";
  qrCount: number;
  webhook: { url: string; jwtKey: string; events: string[] } | null;
  ownerJid: string | null;
  profileName: string | null;
  number: string | null;
}

export interface EvolutionFake {
  instances: Map<string, FakeInstance>;
  sends: Array<{ instance: string; path: string; body: Record<string, unknown>; id: string }>;
  calls: Array<{ method: string; path: string; apikey: string | null }>;
  /** Numbers the fake says aren't on WhatsApp. */
  notOnWhatsapp: Set<string>;
  /** Every call fails this way (null: none): "refused" never connects, "unreachable" drops the connection. */
  down: null | "refused" | "unreachable" | "timeout" | 500;
  /** Sends fail this way (null: they work). */
  sendFails: null | "refused" | "reset" | "timeout" | 500;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The phone scanned: the instance opens. */
  open(name: string, phone?: string, profileName?: string): void;
  /** A webhook for an instance, signed as Evolution signs it (`key` overrides the instance's own). */
  webhook(name: string, event: string, data: unknown, opts?: { key?: string; at?: Date; expiresIn?: number; instance?: string }): { url: string; headers: Record<string, string>; body: string };
}

/** HS256 JWT as Evolution makes them (jsonwebtoken's sign, webhook.controller.ts). */
export function evolutionJwt(key: string, opts: { iat?: number; exp?: number; app?: string; alg?: string } = {}): string {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: opts.alg ?? "HS256", typ: "JWT" });
  const body = b({ iat, exp: opts.exp ?? iat + 600, app: opts.app ?? "evolution", action: "webhook" });
  const sig = createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let seq = 0;

export function evolutionFake(): EvolutionFake {
  const f: EvolutionFake = {
    instances: new Map(),
    sends: [],
    calls: [],
    notOnWhatsapp: new Set(),
    down: null,
    sendFails: null,
    open(name, phone = "61400000099", profileName = "Acme Shop") {
      const i = f.instances.get(name);
      if (!i) throw new Error(`no instance ${name}`);
      i.state = "open";
      i.ownerJid = `${phone}@s.whatsapp.net`;
      i.profileName = profileName;
    },
    webhook(name, event, data, opts = {}) {
      const i = f.instances.get(name);
      const key = opts.key ?? i?.webhook?.jwtKey ?? "unknown";
      const at = opts.at ?? new Date();
      const iat = Math.floor(Date.now() / 1000);
      return {
        url: `/webhooks/whatsapp/evolution/${name}`,
        headers: { authorization: `Bearer ${evolutionJwt(key, { iat, exp: iat + (opts.expiresIn ?? 600) })}`, "content-type": "application/json" },
        body: JSON.stringify({ event, instance: opts.instance ?? name, data, destination: i?.webhook?.url, date_time: at.toISOString(), sender: i?.ownerJid ?? null, server_url: EVOLUTION_URL, apikey: null }),
      };
    },
    fetch: async (input, init) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (u.origin !== EVOLUTION_URL) throw new Error(`unexpected call to ${u.origin}`);
      const method = init?.method ?? "GET";
      const apikey = new Headers(init?.headers).get("apikey");
      f.calls.push({ method, path: u.pathname, apikey });
      if (f.down === "refused") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      if (f.down === "unreachable") throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
      if (f.down === "timeout") {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      if (f.down === 500) return error(500, "Internal Server Error");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const [, area, action, rawName] = u.pathname.split("/");
      const name = rawName ? decodeURIComponent(rawName) : "";
      const inst = name ? f.instances.get(name) : undefined;
      const globalKey = apikey === EVOLUTION_KEY;
      if (!(area === "instance" && (action === "create" || action === "fetchInstances"))) {
        if (!inst) return error(404, [`The "${name}" instance does not exist`]);
        if (!globalKey && apikey !== inst.token) return error(401, "Unauthorized");
      } else if (!globalKey) return error(401, "Unauthorized");

      if (area === "instance" && action === "create") {
        const instanceName = String(body.instanceName);
        if (f.instances.has(instanceName)) return error(403, [`This name "${instanceName}" is already in use.`]);
        const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        f.instances.set(instanceName, { name: instanceName, id, token: String(body.token), integration: String(body.integration), state: body.integration === "WHATSAPP-BUSINESS" ? "open" : "close", qrCount: 0, webhook: null, ownerJid: null, profileName: null, number: (body.number as string) ?? null });
        return json({ instance: { instanceName, instanceId: id, integration: body.integration, status: "close" }, hash: body.token, settings: {} }, 201);
      }
      if (area === "instance" && action === "fetchInstances") {
        const only = u.searchParams.get("instanceName");
        const list = [...f.instances.values()].filter((i) => !only || i.name === only);
        if (only && !list.length) return error(404, [`Instance "${only}" not found`]);
        return json(list.map((i) => ({ id: i.id, name: i.name, connectionStatus: i.state, ownerJid: i.ownerJid, profileName: i.profileName, integration: i.integration, token: i.token })));
      }
      if (area === "webhook" && action === "set") {
        const w = body.webhook as { url: string; headers: { jwt_key: string }; events: string[] };
        inst!.webhook = { url: w.url, jwtKey: w.headers.jwt_key, events: w.events };
        return json({ id: "wh", url: w.url, enabled: true }, 201);
      }
      if (area === "instance" && action === "connect") {
        if (inst!.state === "open") return json({ instance: { instanceName: name, state: "open" } });
        if (inst!.state === "close") inst!.state = "connecting";
        inst!.qrCount++;
        const number = u.searchParams.get("number");
        return json({ pairingCode: number ? "WZYEH1YY" : null, code: `2@fake,${inst!.qrCount}`, base64: QR_PNG, count: inst!.qrCount });
      }
      if (area === "instance" && action === "connectionState") return json({ instance: { instanceName: name, state: inst!.state } });
      if (area === "instance" && action === "restart") {
        if (inst!.state === "close") return error(400, [`The "${name}" instance is not connected`]);
        return json({ instance: { instanceName: name, status: inst!.state } });
      }
      if (area === "instance" && action === "logout") {
        if (inst!.state === "close") return error(400, [`The "${name}" instance is not connected`]);
        inst!.state = "close";
        return json({ status: "SUCCESS", error: false, response: { message: "Instance logged out" } });
      }
      if (area === "instance" && action === "delete") {
        f.instances.delete(name);
        return json({ status: "SUCCESS", error: false, response: { message: "Instance deleted" } });
      }
      if (area === "message") {
        if (f.sendFails === "refused") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
        if (f.sendFails === "reset") throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
        if (f.sendFails === "timeout") {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        if (f.sendFails === 500) return error(500, "Internal Server Error");
        if (inst!.state !== "open") return error(400, ["Error: Connection Closed"]);
        const number = String(body.number);
        if (f.notOnWhatsapp.has(number)) return error(400, [{ jid: `${number}@s.whatsapp.net`, exists: false, number }]);
        const id = `3EB0${String(++seq).padStart(16, "0")}`;
        f.sends.push({ instance: name, path: action!, body, id });
        return json({ key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: true, id }, pushName: "Você", status: "PENDING", message: { conversation: body.text }, messageType: "conversation", messageTimestamp: Math.floor(Date.now() / 1000) }, 201);
      }
      if (area === "chat" && action === "whatsappNumbers") {
        return json(((body.numbers as string[]) ?? []).map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: !f.notOnWhatsapp.has(n), number: n })));
      }
      return error(404, "Not Found");
    },
  };
  return f;
}
