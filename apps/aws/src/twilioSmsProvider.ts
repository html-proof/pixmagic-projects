import { createHmac, randomInt, randomUUID } from "node:crypto";
import type { Coord, FetchLike } from "@app/core";
import { SmsProviderError, twilioNumberCountry, twilioRefusal, twilioSafeEqual, twilioTags, type SmsAccountInfo, type SmsIdentityInfo, type SmsProvider, type SmsSendRequest } from "@app/core/sms";

/**
 * Twilio Programmable Messaging for core/sms (docs/sms.md, "Twilio"): form-encoded REST calls with
 * the account SID and Auth Token, no SDK. It answers in the provider interface's words (AWS's,
 * core/sms/provider.ts): Twilio's refusals are mapped by twilioRefusal, its numbers and services
 * become origination identities, and the bizinsights tags are read from their friendly names.
 *
 * Origination identities, as stored on a store's sender:
 *  - "+61400000000" (or "PN…"): one of the account's numbers, sent From it;
 *  - "MG…": a Messaging Service, which picks the sender (a pool);
 *  - "MG…/NAME": an alphanumeric sender ID in that service, sent From NAME through it.
 *
 * What Twilio has no API for, bizinsights does itself: test numbers are proven by a code it texts
 * and checks (kept hashed in coord, 10 minutes, 5 tries); STOP replies come by the inbound webhook
 * (apps/api routes/smsTwilio.ts), so optedOut is empty; prices are asked for after the status
 * reports (messageCost). There is no MaxPrice (Twilio dropped it on 2024-06-03): the stores'
 * budgets and the platform's monthly ceiling are what limit spend.
 *
 * Nothing here logs, and no error carries Twilio's message (it can quote the customer's number).
 */
export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  coord: Coord;
  /** The status-report URL for a send's context (core twilioStatusUrl, under API_URL). */
  statusUrl: (context: Record<string, string>) => string;
  /** Keys the hashes of the test-number codes kept in coord (OTP_PEPPER). */
  pepper: string;
  /** The sender a test-number code goes from when the store has none checked yet (SMS_SHARED_SENDER). */
  fallbackSender?: () => string;
  fetchImpl?: FetchLike;
  /** Overridden in tests. */
  apiBase?: string;
  messagingBase?: string;
}

interface TwilioNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string | null;
  capabilities?: { sms?: boolean } | null;
}

interface TwilioService {
  sid: string;
  friendly_name?: string | null;
}

const NOT_SENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

function networkError(err: unknown): SmsProviderError {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError") return new SmsProviderError("timeout", null, null, false, "Twilio didn't answer in time");
  const code = e?.code ?? e?.cause?.code ?? "";
  return new SmsProviderError("network", code || null, null, NOT_SENT.has(code), `Twilio unreachable (${code || "network"})`);
}

const SERVICE = /^MG[0-9a-f]{32}$/i;
const SERVICE_SENDER = /^(MG[0-9a-f]{32})\/(.+)$/i;
const NUMBER_SID = /^PN[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
/** North American toll-free prefixes: those numbers send as toll-free, with their own verification. */
const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)\d{7}$/;

const CODE_TTL_S = 600;
const CODE_TRIES = 5;

export function twilioSmsProvider(o: TwilioOptions): SmsProvider {
  const fetchImpl = o.fetchImpl ?? fetch;
  const api = `${o.apiBase ?? "https://api.twilio.com"}/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}`;
  const messaging = `${o.messagingBase ?? "https://messaging.twilio.com"}/v1`;
  const authorization = `Basic ${Buffer.from(`${o.accountSid}:${o.authToken}`).toString("base64")}`;

  async function call<T>(method: "GET" | "POST", url: string, form?: URLSearchParams): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization, accept: "application/json", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        ...(form ? { body: form.toString() } : {}),
      });
    } catch (err) {
      throw networkError(err);
    }
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const raw = json.code;
      const code = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;
      const { type, reason } = twilioRefusal(res.status, code);
      throw new SmsProviderError(type, reason, res.status, false, `Twilio ${method} failed (${res.status}${code ? ` ${code}` : ""})`);
    }
    return json as T;
  }

  const notFound = (err: unknown) => err instanceof SmsProviderError && err.status === 404;

  // A number stored by its SID is sent From its number: looked up once per instance.
  const numberBySid = new Map<string, string>();
  async function fromNumber(sid: string): Promise<string> {
    let n = numberBySid.get(sid);
    if (!n) {
      n = (await call<TwilioNumber>("GET", `${api}/IncomingPhoneNumbers/${sid}.json`)).phone_number;
      numberBySid.set(sid, n);
    }
    return n;
  }

  function numberInfo(p: TwilioNumber): SmsIdentityInfo {
    return {
      kind: TOLL_FREE.test(p.phone_number) ? "toll_free" : "long_code",
      arn: p.phone_number,
      id: p.sid,
      // The business's own number, not a customer's: shown as it is.
      label: p.phone_number,
      country: twilioNumberCountry(p.phone_number),
      status: "ACTIVE",
      twoWay: true,
      optOutList: null,
      registrationStatus: null,
      tags: twilioTags(p.friendly_name),
    };
  }

  async function number(id: string): Promise<SmsIdentityInfo | null> {
    const p = NUMBER_SID.test(id)
      ? await call<TwilioNumber>("GET", `${api}/IncomingPhoneNumbers/${id}.json`)
      : (await call<{ incoming_phone_numbers?: TwilioNumber[] }>("GET", `${api}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(id)}`)).incoming_phone_numbers?.[0];
    // A number that can't text isn't a sender.
    return p && p.capabilities?.sms !== false ? numberInfo(p) : null;
  }

  async function alphaSenders(serviceSid: string): Promise<string[]> {
    const r = await call<{ alpha_senders?: Array<{ alpha_sender: string }> }>("GET", `${messaging}/Services/${serviceSid}/AlphaSenders?PageSize=100`);
    return (r.alpha_senders ?? []).map((a) => a.alpha_sender);
  }

  /**
   * A name in a service. Twilio's API doesn't report sender ID registrations: the platform owner
   * adds a name to a service only once Twilio shows it approved where that's needed (docs/sms.md).
   */
  const alphaInfo = (s: TwilioService, name: string, country: string | null): SmsIdentityInfo => ({
    kind: "sender_id",
    arn: `${s.sid}/${name}`,
    id: name,
    label: name,
    country,
    status: "REGISTERED",
    twoWay: false,
    optOutList: null,
    registrationStatus: "COMPLETE",
    tags: twilioTags(s.friendly_name),
  });

  async function service(sid: string, name: string | null, country: string | null): Promise<SmsIdentityInfo | null> {
    const s = await call<TwilioService>("GET", `${messaging}/Services/${sid}`);
    if (!name) return { kind: "pool", arn: s.sid, id: s.sid, label: s.sid, country: null, status: "ACTIVE", twoWay: true, optOutList: null, registrationStatus: null, tags: twilioTags(s.friendly_name) };
    const found = (await alphaSenders(s.sid)).find((a) => a.toUpperCase() === name.toUpperCase());
    return found ? alphaInfo(s, found, country) : null;
  }

  /** A bare name: the first service carrying bizinsights tags that has it. */
  async function alphaSender(name: string, country: string | null): Promise<SmsIdentityInfo | null> {
    const r = await call<{ services?: TwilioService[] }>("GET", `${messaging}/Services?PageSize=50`);
    for (const s of r.services ?? []) {
      if (!Object.keys(twilioTags(s.friendly_name)).length) continue;
      const found = (await alphaSenders(s.sid)).find((a) => a.toUpperCase() === name.toUpperCase());
      if (found) return alphaInfo(s, found, country);
    }
    return null;
  }

  async function send(req: SmsSendRequest) {
    // Twilio has no dry run; nothing in core asks for one.
    if (req.dryRun) throw new SmsProviderError("ValidationException", "DRY_RUN_NOT_SUPPORTED", null, false, "Twilio has no dry run");
    const form = new URLSearchParams({ To: req.destination, Body: req.body });
    const identity = req.originationIdentity.trim();
    const inService = SERVICE_SENDER.exec(identity);
    if (inService) {
      form.set("MessagingServiceSid", inService[1]!);
      form.set("From", inService[2]!);
    } else if (SERVICE.test(identity)) {
      form.set("MessagingServiceSid", identity);
    } else {
      form.set("From", NUMBER_SID.test(identity) ? await fromNumber(identity) : identity);
    }
    // Reports only for texts a job follows (a test-number code has none).
    if (req.context.job) form.set("StatusCallback", o.statusUrl(req.context));
    // Twilio keeps a queued text at most 10 hours (36000 s); the send path asks 24 h for order updates.
    if (req.ttlSeconds) form.set("ValidityPeriod", String(Math.max(1, Math.min(36_000, Math.round(req.ttlSeconds)))));
    const r = await call<{ sid?: string }>("POST", `${api}/Messages.json`, form);
    // A 201 without an id is a broken answer, not a refusal: Twilio may have the text.
    if (!r.sid) throw new SmsProviderError("InternalServerException", "NO_MESSAGE_ID", 201, false, "Twilio answered without a message sid");
    return { messageId: r.sid };
  }

  const codeKey = (id: string) => `sms:twilio-code:${id}`;
  const codeHash = (id: string, code: string) => createHmac("sha256", o.pepper).update(`sms-test-number:${id}:${code}`).digest("hex");

  return {
    name: "twilio",
    send,

    async account(): Promise<SmsAccountInfo> {
      const a = await call<{ type?: string; status?: string }>("GET", `${api}.json`);
      const full = (a.type ?? "").toLowerCase() === "full";
      const active = (a.status ?? "").toLowerCase() === "active";
      // A trial account reaches only its verified numbers (21608), like AWS's sandbox. Twilio has
      // no spending limit to read: bizinsights' own budgets and ceiling are the limits.
      return {
        tier: full ? (active ? "PRODUCTION" : (a.status ?? "UNKNOWN").toUpperCase()) : (a.type ?? "UNKNOWN").toUpperCase(),
        sandbox: !full || !active,
        spendLimitUsd: null,
        spendLimitMaxUsd: null,
      };
    },

    async identity(_region: string, identity: string, country?: string | null): Promise<SmsIdentityInfo | null> {
      const id = identity.trim();
      try {
        if (E164.test(id) || NUMBER_SID.test(id)) return await number(id);
        const svc = SERVICE_SENDER.exec(id);
        if (svc) return await service(svc[1]!, svc[2]!, country ?? null);
        if (SERVICE.test(id)) return await service(id, null, null);
        if (!/^[A-Za-z0-9 -]{1,11}$/.test(id)) return null;
        return await alphaSender(id, country ?? null);
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    async taggedNumbers(_region: string, country: string, key: string, value: string): Promise<SmsIdentityInfo[]> {
      const r = await call<{ incoming_phone_numbers?: TwilioNumber[] }>("GET", `${api}/IncomingPhoneNumbers.json?PageSize=1000`);
      return (r.incoming_phone_numbers ?? [])
        .filter((p) => p.capabilities?.sms !== false)
        .map(numberInfo)
        .filter((i) => i.country === country && i.tags[key] === value);
    },

    // STOP replies arrive by the inbound webhook (core/sms/twilio.ts applyTwilioInbound).
    async optedOut() {
      return [];
    },

    async createVerifiedNumber() {
      return { id: `twilio-${randomUUID()}`, status: "PENDING" };
    },

    async sendVerificationCode(_region: string, verifiedId: string, originationIdentity: string | null, _configurationSet: string | null, e164?: string) {
      if (!e164) throw new SmsProviderError("ValidationException", "NO_DESTINATION", null, false, "no number to text the code to");
      const from = originationIdentity || o.fallbackSender?.().trim() || "";
      if (!from) throw new SmsProviderError("ValidationException", "NO_ORIGINATION_IDENTITIES_FOUND", null, false, "no sender to text the code from");
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      await o.coord.put(codeKey(verifiedId), JSON.stringify({ h: codeHash(verifiedId, code), n: 0, exp: Date.now() + CODE_TTL_S * 1000 }), CODE_TTL_S);
      await send({
        region: "",
        destination: e164,
        body: `${code} is your bizinsights code to add this phone as a test recipient. It expires in 10 minutes.`,
        originationIdentity: from,
        messageType: "TRANSACTIONAL",
        ttlSeconds: CODE_TTL_S,
        context: {},
      });
    },

    async verifyNumber(_region: string, verifiedId: string, code: string) {
      const raw = await o.coord.peek(codeKey(verifiedId));
      const kept = raw ? (JSON.parse(raw) as { h: string; n: number; exp: number }) : null;
      if (!kept || kept.exp <= Date.now()) throw new SmsProviderError("ValidationException", "VERIFICATION_CODE_EXPIRED", 400, false, "no code waiting");
      if (!/^\d{6}$/.test(code.trim()) || !twilioSafeEqual(kept.h, codeHash(verifiedId, code.trim()))) {
        const tries = kept.n + 1;
        if (tries >= CODE_TRIES) await o.coord.take(codeKey(verifiedId));
        else await o.coord.put(codeKey(verifiedId), JSON.stringify({ ...kept, n: tries }), Math.max(1, Math.ceil((kept.exp - Date.now()) / 1000)));
        throw new SmsProviderError("ValidationException", tries >= CODE_TRIES ? "VERIFICATION_CODE_EXPIRED" : "INVALID_VERIFICATION_CODE", 400, false, "wrong code");
      }
      await o.coord.take(codeKey(verifiedId));
      return { status: "VERIFIED" };
    },

    async deleteVerifiedNumber(_region: string, verifiedId: string) {
      await o.coord.take(codeKey(verifiedId));
    },

    async messageCost(messageId: string) {
      const m = await call<{ status?: string; price?: string | null; price_unit?: string | null; num_segments?: string | null }>("GET", `${api}/Messages/${encodeURIComponent(messageId)}.json`);
      const segments = m.num_segments !== null && m.num_segments !== undefined && /^\d+$/.test(String(m.num_segments)) ? Number(m.num_segments) : null;
      const parts = segments && segments > 0 ? segments : null;
      // Twilio doesn't charge a text that failed before reaching a carrier.
      if (m.status === "failed" || m.status === "canceled") return { priceUsd: 0, parts };
      if (m.price === null || m.price === undefined || m.price === "" || !Number.isFinite(Number(m.price))) return null;
      // Budgets are in US dollars: a price in another currency stays an estimate (bill the account in USD).
      if ((m.price_unit ?? "").toUpperCase() !== "USD") return null;
      return { priceUsd: Math.abs(Number(m.price)), parts };
    },
  };
}
