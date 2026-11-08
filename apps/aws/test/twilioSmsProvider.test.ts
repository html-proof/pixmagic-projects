import { describe, expect, it } from "vitest";
import { memoryCoord } from "@app/core";
import { SmsProviderError, twilioDeliveryStatus, twilioRefusal, twilioSignature, twilioStatusEvent, twilioStatusUrl, twilioTags, validTwilioSignature } from "@app/core/sms";
import { twilioSmsProvider, type TwilioOptions } from "../src/twilioSmsProvider.js";

/**
 * The Twilio adapter (apps/aws/src/twilioSmsProvider.ts) against a stand-in for Twilio's REST API,
 * and core's Twilio helpers (core/sms/twilio.ts): what each call sends, and how Twilio's answers,
 * refusals, statuses and webhook signatures are read. Nothing reaches Twilio.
 */

const SID = "AC" + "0".repeat(32);
const TOKEN = "0123456789abcdef0123456789abcdef";
const SERVICE = "MG" + "1".repeat(32);
const NUMBER_SID = "PN" + "2".repeat(32);
const WS = "ws_123";

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  form: URLSearchParams | null;
}

/** A Twilio stand-in: answers by method and path, records each request. */
function twilio(routes: Record<string, (form: URLSearchParams | null, url: URL) => { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? "GET", url: url.toString(), auth: headers.get("authorization"), form });
    const key = `${init?.method ?? "GET"} ${url.hostname}${url.pathname}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ code: 20404, message: "not found", status: 404 }), { status: 404 });
    const r = route(form, url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const API = `api.twilio.com/2010-04-01/Accounts/${SID}`;
const MSG = "messaging.twilio.com/v1";

function provider(fetchImpl: typeof fetch, extra: Partial<TwilioOptions> = {}) {
  const coord = memoryCoord();
  const p = twilioSmsProvider({
    accountSid: SID,
    authToken: TOKEN,
    coord,
    statusUrl: (ctx) => twilioStatusUrl(ctx, "https://bizinsights.io/api"),
    pepper: "test-pepper-for-codes",
    fetchImpl,
    ...extra,
  });
  return { p, coord };
}

const req = (originationIdentity: string, over: Record<string, unknown> = {}) => ({
  region: "ap-southeast-2",
  destination: "+61412345678",
  body: "Your order is on its way.",
  originationIdentity,
  messageType: "TRANSACTIONAL" as const,
  maxPrice: "0.25000",
  ttlSeconds: 86_400,
  context: { job: "job1", ws: WS },
  ...over,
});

describe("sending", () => {
  it("posts the text with the account's Basic auth, a status URL carrying the job, and Twilio's longest validity", async () => {
    const t = twilio({ [`POST ${API}/Messages.json`]: () => ({ status: 201, body: { sid: "SM" + "a".repeat(32), status: "queued" } }) });
    const { p } = provider(t.fetchImpl);
    expect(p.name).toBe("twilio");
    expect(await p.send(req("+61400000001"))).toEqual({ messageId: "SM" + "a".repeat(32) });
    const s = t.seen[0]!;
    expect(s.auth).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    expect(Object.fromEntries(s.form!)).toEqual({
      To: "+61412345678",
      Body: "Your order is on its way.",
      From: "+61400000001",
      StatusCallback: "https://bizinsights.io/api/webhooks/sms/twilio/status?job=job1&ws=ws_123",
      ValidityPeriod: "36000",
    });
    // No MaxPrice: Twilio dropped it; the budgets are the limit.
    expect(s.form!.has("MaxPrice")).toBe(false);
  });

  it("sends through a Messaging Service, From a name in it, or From a number stored by its SID", async () => {
    const t = twilio({
      [`POST ${API}/Messages.json`]: () => ({ status: 201, body: { sid: "SM1" } }),
      [`GET ${API}/IncomingPhoneNumbers/${NUMBER_SID}.json`]: () => ({ body: { sid: NUMBER_SID, phone_number: "+61400000002" } }),
    });
    const { p } = provider(t.fetchImpl);
    await p.send(req(SERVICE));
    await p.send(req(`${SERVICE}/GreenLeaf`));
    await p.send(req(NUMBER_SID));
    await p.send(req(NUMBER_SID));
    const posts = t.seen.filter((s) => s.method === "POST").map((s) => ({ service: s.form!.get("MessagingServiceSid"), from: s.form!.get("From") }));
    expect(posts).toEqual([
      { service: SERVICE, from: null },
      { service: SERVICE, from: "GreenLeaf" },
      { service: null, from: "+61400000002" },
      { service: null, from: "+61400000002" },
    ]);
    // The number is looked up once.
    expect(t.seen.filter((s) => s.method === "GET")).toHaveLength(1);
  });

  it("reads Twilio's refusals in the send path's words, never quoting Twilio's message", async () => {
    const answer = { status: 400, body: { code: 21610, message: "Attempt to send to unsubscribed recipient +61412345678", status: 400 } };
    const t = twilio({ [`POST ${API}/Messages.json`]: () => answer });
    const { p } = provider(t.fetchImpl);
    const err = await p.send(req("+61400000001")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsProviderError);
    expect(err).toMatchObject({ type: "ConflictException", reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT TWILIO_21610", status: 400, notSent: false });
    expect((err as Error).message).not.toContain("+614");
  });

  it("a connection that never opened may be retried; a timeout may not", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const { p } = provider((async () => {
      throw refused;
    }) as typeof fetch);
    expect(await p.send(req("+61400000001")).catch((e: unknown) => e)).toMatchObject({ type: "network", notSent: true });
    const { p: slow } = provider((async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch);
    expect(await slow.send(req("+61400000001")).catch((e: unknown) => e)).toMatchObject({ type: "timeout", notSent: false });
  });

  it("a text with no job (a test-number code) asks for no status reports", async () => {
    const t = twilio({ [`POST ${API}/Messages.json`]: () => ({ status: 201, body: { sid: "SM2" } }) });
    const { p } = provider(t.fetchImpl);
    await p.send(req("+61400000001", { context: {} }));
    expect(t.seen[0]!.form!.has("StatusCallback")).toBe(false);
  });
});

describe("refusals and statuses (core/sms/twilio.ts)", () => {
  it.each([
    [400, 21610, "ConflictException", /OPTED_OUT/],
    [400, 21608, "ConflictException", /NOT_VERIFIED/],
    [400, 21408, "ValidationException", /DESTINATION_COUNTRY_BLOCKED/],
    [400, 21211, "ValidationException", /INVALID_PHONE_NUMBER/],
    [400, 21614, "ValidationException", /INVALID_PHONE_NUMBER/],
    [400, 21612, "ValidationException", /INVALID_IDENTITY_FOR_DESTINATION_COUNTRY/],
    [400, 21606, "ResourceNotFoundException", /ORIGINATION/],
    [400, 30034, "ValidationException", /REGISTRATION_NOT_COMPLETE/],
    [429, 20429, "ThrottlingException", /TWILIO_20429/],
    [401, 20003, "AccessDeniedException", /AUTHENTICATION_FAILED/],
    [500, null, "InternalServerException", null],
    [400, 99999, "ValidationException", /^TWILIO_99999$/],
  ] as const)("HTTP %i, code %s → %s", (status, code, type, reason) => {
    const r = twilioRefusal(status, code);
    expect(r.type).toBe(type);
    if (reason) expect(r.reason).toMatch(reason);
    else expect(r.reason).toBeNull();
  });

  it("maps statuses to the delivery event's words: delivered, still with the carrier, or failed by its error code", () => {
    expect(twilioDeliveryStatus("delivered", null)).toEqual({ messageStatus: "DELIVERED", isFinal: true });
    for (const s of ["queued", "sending", "sent", "accepted"]) expect(twilioDeliveryStatus(s, null)).toEqual({ messageStatus: "PENDING", isFinal: false });
    expect(twilioDeliveryStatus("undelivered", "30003")).toEqual({ messageStatus: "UNREACHABLE", isFinal: true });
    expect(twilioDeliveryStatus("undelivered", "30005")).toEqual({ messageStatus: "INVALID", isFinal: true });
    expect(twilioDeliveryStatus("undelivered", "30007")).toEqual({ messageStatus: "SPAM", isFinal: true });
    expect(twilioDeliveryStatus("failed", "30008")).toEqual({ messageStatus: "FAILED", isFinal: true });
    expect(twilioDeliveryStatus("received", null)).toBeNull();
  });

  it("builds the event from a status report, with the job and workspace from the signed query", () => {
    const form = new URLSearchParams({ MessageSid: "SM9", MessageStatus: "undelivered", ErrorCode: "30003", To: "+61412345678" });
    expect(twilioStatusEvent(form, new URLSearchParams("job=j1&ws=w1"), 1_700_000_000_000)).toEqual({
      eventType: "TEXT_UNDELIVERED",
      eventVersion: "twilio",
      eventTimestamp: 1_700_000_000_000,
      isFinal: true,
      messageId: "SM9",
      messageStatus: "UNREACHABLE",
      messageStatusDescription: "Twilio undelivered 30003",
      context: { job: "j1", ws: "w1" },
    });
    expect(twilioStatusEvent(new URLSearchParams({ MessageStatus: "delivered" }), new URLSearchParams())).toBeNull();
  });

  it("signs webhooks as Twilio documents it: the URL, then each field's name and value sorted by name, HMAC-SHA1 in base64", () => {
    // Twilio's own worked example (docs "Webhooks security"): this URL, these fields, this token.
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const form = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
    expect(twilioSignature("12345", url, form)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(validTwilioSignature("12345", url, form, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
    expect(validTwilioSignature("12345", url, form, "x")).toBe(false);
    expect(validTwilioSignature("", url, form, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(false);
    form.set("Digits", "1235");
    expect(validTwilioSignature("12345", url, form, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(false);
  });

  it("reads the bizinsights tags from a friendly name", () => {
    expect(twilioTags(`bizinsights:workspace=${WS}`)).toEqual({ "bizinsights:workspace": WS });
    expect(twilioTags("Shared AU; bizinsights:shared=true")).toEqual({ "bizinsights:shared": "true" });
    expect(twilioTags("My number")).toEqual({});
    expect(twilioTags(null)).toEqual({});
  });
});

describe("senders and the account", () => {
  const numbers = {
    incoming_phone_numbers: [
      { sid: NUMBER_SID, phone_number: "+61400000002", friendly_name: `bizinsights:workspace=${WS}`, capabilities: { sms: true } },
      { sid: "PN" + "3".repeat(32), phone_number: "+61400000003", friendly_name: "bizinsights:workspace=other", capabilities: { sms: true } },
      { sid: "PN" + "4".repeat(32), phone_number: "+18885550100", friendly_name: `bizinsights:workspace=${WS}`, capabilities: { sms: true } },
      { sid: "PN" + "5".repeat(32), phone_number: "+61400000005", friendly_name: `bizinsights:workspace=${WS}`, capabilities: { sms: false } },
    ],
  };

  it("finds a number by its number or SID, with its tags, country and kind; a number that can't text isn't one", async () => {
    const t = twilio({
      [`GET ${API}/IncomingPhoneNumbers.json`]: (_f, url) => ({ body: { incoming_phone_numbers: numbers.incoming_phone_numbers.filter((n) => n.phone_number === url.searchParams.get("PhoneNumber")) } }),
      [`GET ${API}/IncomingPhoneNumbers/${NUMBER_SID}.json`]: () => ({ body: numbers.incoming_phone_numbers[0] }),
    });
    const { p } = provider(t.fetchImpl);
    const byNumber = await p.identity("x", "+61400000002");
    expect(byNumber).toMatchObject({ kind: "long_code", arn: "+61400000002", id: NUMBER_SID, label: "+61400000002", country: "AU", twoWay: true, tags: { "bizinsights:workspace": WS } });
    expect(await p.identity("x", NUMBER_SID)).toEqual(byNumber);
    expect(await p.identity("x", "+18885550100")).toMatchObject({ kind: "toll_free", country: "US" });
    expect(await p.identity("x", "+61400000005")).toBeNull();
    expect(await p.identity("x", "+61499999999")).toBeNull();
  });

  it("lists the numbers tagged for a workspace in a country", async () => {
    const t = twilio({ [`GET ${API}/IncomingPhoneNumbers.json`]: () => ({ body: numbers }) });
    const { p } = provider(t.fetchImpl);
    expect((await p.taggedNumbers("x", "AU", "bizinsights:workspace", WS)).map((n) => n.arn)).toEqual(["+61400000002"]);
  });

  it("finds a sender name in a tagged Messaging Service, by the name alone or with its service", async () => {
    const t = twilio({
      [`GET ${MSG}/Services`]: () => ({ body: { services: [{ sid: "MG" + "9".repeat(32), friendly_name: "untagged" }, { sid: SERVICE, friendly_name: `bizinsights:workspace=${WS}` }] } }),
      [`GET ${MSG}/Services/${SERVICE}`]: () => ({ body: { sid: SERVICE, friendly_name: `bizinsights:workspace=${WS}` } }),
      [`GET ${MSG}/Services/${SERVICE}/AlphaSenders`]: () => ({ body: { alpha_senders: [{ alpha_sender: "GreenLeaf" }] } }),
    });
    const { p } = provider(t.fetchImpl);
    const byName = await p.identity("x", "greenleaf", "AU");
    expect(byName).toMatchObject({ kind: "sender_id", arn: `${SERVICE}/GreenLeaf`, id: "GreenLeaf", country: "AU", registrationStatus: "COMPLETE", tags: { "bizinsights:workspace": WS } });
    // The untagged service is never asked about its names.
    expect(t.seen.some((s) => s.url.includes("9".repeat(32)))).toBe(false);
    expect(await p.identity("x", `${SERVICE}/GreenLeaf`, "AU")).toEqual(byName);
    expect(await p.identity("x", `${SERVICE}/Other`, "AU")).toBeNull();
    expect(await p.identity("x", SERVICE)).toMatchObject({ kind: "pool", arn: SERVICE, tags: { "bizinsights:workspace": WS } });
    expect(await p.identity("x", "Nobody", "AU")).toBeNull();
  });

  it("calls a trial account a sandbox, and a full active one production", async () => {
    let account = { type: "Trial", status: "active" };
    const t = twilio({ [`GET ${API}.json`]: () => ({ body: account }) });
    const { p } = provider(t.fetchImpl);
    expect(await p.account("x")).toEqual({ tier: "TRIAL", sandbox: true, spendLimitUsd: null, spendLimitMaxUsd: null });
    account = { type: "Full", status: "active" };
    expect(await p.account("x")).toMatchObject({ tier: "PRODUCTION", sandbox: false });
    account = { type: "Full", status: "suspended" };
    expect(await p.account("x")).toMatchObject({ tier: "SUSPENDED", sandbox: true });
  });

  it("reads the price once Twilio has it, in US dollars only; a failed text costs nothing", async () => {
    let message: Record<string, unknown> = { status: "sent", price: null, price_unit: "USD", num_segments: "1" };
    const t = twilio({ [`GET ${API}/Messages/SM5.json`]: () => ({ body: message }) });
    const { p } = provider(t.fetchImpl);
    expect(await p.messageCost!("SM5")).toBeNull();
    message = { status: "delivered", price: "-0.05250", price_unit: "USD", num_segments: "2" };
    expect(await p.messageCost!("SM5")).toEqual({ priceUsd: 0.0525, parts: 2 });
    message = { status: "delivered", price: "-0.08000", price_unit: "AUD", num_segments: "1" };
    expect(await p.messageCost!("SM5")).toBeNull();
    message = { status: "failed", price: null, price_unit: "USD", num_segments: "1" };
    expect(await p.messageCost!("SM5")).toEqual({ priceUsd: 0, parts: 1 });
  });
});

describe("test numbers: bizinsights texts the code and checks it", () => {
  const codeIn = (body: string) => body.match(/\b(\d{6})\b/)![1]!;

  it("texts a 6-digit code from the store's sender (or the shared one) and accepts it once", async () => {
    const t = twilio({ [`POST ${API}/Messages.json`]: () => ({ status: 201, body: { sid: "SMc" } }) });
    const { p } = provider(t.fetchImpl, { fallbackSender: () => "SHARED" });
    const { id, status } = await p.createVerifiedNumber("x", "+61412345678", {});
    expect(status).toBe("PENDING");
    await p.sendVerificationCode("x", id, null, null, "+61412345678");
    const sent = t.seen[0]!.form!;
    expect(sent.get("To")).toBe("+61412345678");
    expect(sent.get("From")).toBe("SHARED");
    expect(sent.has("StatusCallback")).toBe(false);
    const code = codeIn(sent.get("Body")!);
    expect(await p.verifyNumber("x", id, ` ${code} `)).toEqual({ status: "VERIFIED" });
    await expect(p.verifyNumber("x", id, code)).rejects.toMatchObject({ type: "ValidationException", reason: "VERIFICATION_CODE_EXPIRED" });
  });

  it("refuses a wrong code, and after five wrong ones the code is gone", async () => {
    const t = twilio({ [`POST ${API}/Messages.json`]: () => ({ status: 201, body: { sid: "SMc" } }) });
    const { p } = provider(t.fetchImpl);
    const { id } = await p.createVerifiedNumber("x", "+61412345678", {});
    await p.sendVerificationCode("x", id, "+61400000001", null, "+61412345678");
    const code = codeIn(t.seen[0]!.form!.get("Body")!);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await expect(p.verifyNumber("x", id, wrong)).rejects.toMatchObject({ reason: "INVALID_VERIFICATION_CODE" });
    await expect(p.verifyNumber("x", id, wrong)).rejects.toMatchObject({ reason: "VERIFICATION_CODE_EXPIRED" });
    await expect(p.verifyNumber("x", id, code)).rejects.toMatchObject({ reason: "VERIFICATION_CODE_EXPIRED" });
  });

  it("needs a sender to text the code from, and the number to text it to", async () => {
    const { p } = provider(twilio({}).fetchImpl);
    const { id } = await p.createVerifiedNumber("x", "+61412345678", {});
    await expect(p.sendVerificationCode("x", id, null, null, "+61412345678")).rejects.toMatchObject({ reason: "NO_ORIGINATION_IDENTITIES_FOUND" });
    await expect(p.sendVerificationCode("x", id, "+61400000001", null)).rejects.toMatchObject({ reason: "NO_DESTINATION" });
  });

  it("reports no opt-out list (STOP replies come by webhook)", async () => {
    const { p } = provider(twilio({}).fetchImpl);
    expect(await p.optedOut("x", "Default", null)).toEqual([]);
  });
});
