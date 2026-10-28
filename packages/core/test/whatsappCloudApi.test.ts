import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudApiMissing, CloudApiError, cloudFailure, createCloudTemplate, listCloudTemplates, metaApp, metaErrorInfo, resetEnvCache, sendCloudMessage, waEncrypt } from "../src/index.js";
import type { GraphFailure } from "../src/metaGraph.js";
import { cloudApiFake, META_APP_SECRET, META_ENV } from "../../../test-support/cloudApiFake.js";

/**
 * Meta's WhatsApp Cloud API client (core whatsapp/cloudApi.ts), without a database: what each call
 * sends Meta (the token in the header and never the URL, its appsecret_proof, the message's shape),
 * and how each of Meta's failures is sorted, above all which sends may have reached the customer.
 */

const BASE_ENV = { SESSION_SECRET: "0123456789abcdef", TOKEN_ENCRYPTION_KEYS: "1:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=", OTP_PEPPER: "pepper-value", ...META_ENV };

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const failure = (extra: Partial<GraphFailure>): GraphFailure => ({ reason: "refused", status: 400, code: null, subcode: null, type: null, message: null, userTitle: null, userMessage: null, details: null, text: null, headers: null, ...extra });

describe("Meta's failures", () => {
  it("tells a send that never reached Meta (try again) from one that may have (never repeated)", () => {
    const never = cloudFailure(failure({ reason: "network", status: 0, networkCode: "ECONNREFUSED" }), true);
    expect(never).toMatchObject({ kind: "unreachable", uncertain: false });
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) expect(cloudFailure(failure({ reason: "network", status: 0, networkCode: code }), true).uncertain, code).toBe(false);
    expect(cloudFailure(failure({ reason: "network", status: 0, networkCode: "ECONNRESET" }), true)).toMatchObject({ kind: "unreachable", uncertain: true });
    expect(cloudFailure(failure({ reason: "network", status: 0, networkCode: "TimeoutError" }), true)).toMatchObject({ kind: "timeout", uncertain: true });
    // Meta failing while it handled the send: it may have gone out.
    expect(cloudFailure(failure({ status: 500, code: 131000 }), true)).toMatchObject({ kind: "server", uncertain: true });
    expect(cloudFailure(failure({ status: 503, code: 2 }), true)).toMatchObject({ kind: "server", uncertain: true });
    // Not a send: nothing reached a customer whatever happened.
    expect(cloudFailure(failure({ reason: "network", status: 0, networkCode: "ECONNRESET" }), false).uncertain).toBe(false);
    expect(cloudFailure(failure({ status: 500, code: 131000 }), false).uncertain).toBe(false);
  });

  it("sorts Meta's codes into what bizinsights does about them, in the merchant's words", () => {
    const kind = (code: number, status = 400) => cloudFailure(failure({ status, code }), true);
    expect(kind(190, 401)).toMatchObject({ kind: "auth", uncertain: false, metaCode: 190, detail: expect.stringMatching(/Connect WhatsApp again/) });
    expect(kind(10, 403).kind).toBe("auth");
    expect(kind(200, 403).kind).toBe("auth");
    expect(kind(130429).kind).toBe("rate_limited");
    expect(kind(80007).kind).toBe("rate_limited");
    expect(kind(4).kind).toBe("rate_limited");
    expect(kind(131056).kind).toBe("pair_rate_limited");
    expect(kind(131047)).toMatchObject({ kind: "outside_window", detail: expect.stringMatching(/24 hours/) });
    expect(kind(131026).kind).toBe("undeliverable");
    expect(kind(131030)).toMatchObject({ kind: "recipient_not_allowed", detail: expect.stringMatching(/test number/) });
    for (const code of [132000, 132001, 132015, 132016, 132999]) expect(kind(code).kind, String(code)).toBe("template");
    expect(kind(131042).kind).toBe("account");
    // A code bizinsights doesn't know: Meta's own reason, cleaned (no links, no token-like strings).
    const other = cloudFailure(failure({ code: 99999, details: "See https://developers.facebook.com/x for EAAGsomeverylongtokenlikestring0123456789abcdef" }), true);
    expect(other).toMatchObject({ kind: "refused", uncertain: false });
    expect(other.detail).not.toMatch(/https?:|EAAG/);
    expect(metaErrorInfo(null, null).text).toBe("WhatsApp refused it.");
  });
});

describe("the client", () => {
  const conn = (f: ReturnType<typeof cloudApiFake>) => {
    const s = f.signup({ registered: true });
    return { storeId: "store-1", instanceTokenEnc: waEncrypt("store-1", "instance_token", f.tokenFor(s.phoneNumberId).token), phoneNumberId: s.phoneNumberId, wabaId: s.wabaId };
  };

  it("sends text, a template with its values, and an attachment by Meta's media id, each carrying bizinsights' reference", async () => {
    const f = cloudApiFake();
    const c = conn(f);
    const deps = { fetchImpl: f.fetch };
    expect(await sendCloudMessage(deps, c, { to: "61412345678", text: "Hi", reference: "msg-1" })).toEqual({ id: expect.stringMatching(/^wamid\./), status: null });
    await sendCloudMessage(deps, c, { to: "61412345678", text: "ignored", template: { name: "order_thanks_abc123", language: "en", params: ["Pat", "#1001"] }, reference: "msg-2" });
    await sendCloudMessage(deps, c, { to: "61412345678", text: "Your receipt", media: { kind: "document", mime: "application/pdf", name: "receipt.pdf", base64: Buffer.from("%PDF-1.4 x").toString("base64") }, reference: "msg-3" });
    expect(f.sends.map(({ type, text, template, mediaId, caption, filename, reference }) => ({ type, text, template, mediaId, caption, filename, reference }))).toEqual([
      { type: "text", text: "Hi", template: null, mediaId: null, caption: null, filename: null, reference: "msg-1" },
      { type: "template", text: null, template: { name: "order_thanks_abc123", language: "en", params: ["Pat", "#1001"] }, mediaId: null, caption: null, filename: null, reference: "msg-2" },
      { type: "document", text: null, template: null, mediaId: f.uploads[0]!.id, caption: "Your receipt", filename: "receipt.pdf", reference: "msg-3" },
    ]);
    expect(f.uploads[0]).toMatchObject({ type: "application/pdf", name: "receipt.pdf", size: 10 });
    // The token travels in the header with its proof, never in a URL.
    expect(f.calls.every((x) => x.token && x.proof)).toBe(true);
  });

  it("calls a 2xx without a message id uncertain, and a refusal what Meta said", async () => {
    const f = cloudApiFake();
    const c = conn(f);
    f.sendFails.push("no_id", { code: 131047 }, "refused");
    const send = () => sendCloudMessage({ fetchImpl: f.fetch }, c, { to: "61412345678", text: "Hi", reference: "m" });
    await expect(send()).rejects.toMatchObject({ kind: "server", uncertain: true });
    await expect(send()).rejects.toMatchObject({ kind: "outside_window", uncertain: false, metaCode: 131047 });
    await expect(send()).rejects.toMatchObject({ kind: "unreachable", uncertain: false });
    // A token Meta no longer accepts.
    f.tokens.forEach((t) => (t.valid = false));
    await expect(send()).rejects.toSatisfy((e: unknown) => e instanceof CloudApiError && e.kind === "auth" && e.metaCode === 190);
  });

  it("submits a template and lists Meta's review of each", async () => {
    const f = cloudApiFake();
    const c = conn(f);
    const r = await createCloudTemplate({ fetchImpl: f.fetch }, c, { name: "order_thanks_abc123", category: "UTILITY", language: "en", components: [{ type: "BODY", text: "Hi {{1}}" }] });
    expect(r).toMatchObject({ status: "PENDING" });
    expect((await listCloudTemplates({ fetchImpl: f.fetch }, c)).map((t) => [t.name, t.status])).toEqual([["order_thanks_abc123", "PENDING"]]);
  });

  it("needs every Meta setting before it is offered, and never runs without them", async () => {
    expect(cloudApiMissing()).toEqual([]);
    expect(metaApp()).toMatchObject({ appSecret: META_APP_SECRET, configId: "2228218088074576" });
    vi.stubEnv("WHATSAPP_CONFIG_ID", "");
    vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "");
    resetEnvCache();
    expect(cloudApiMissing()).toEqual(["WHATSAPP_CONFIG_ID", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"]);
    expect(metaApp()).toBeNull();
    const f = cloudApiFake();
    await expect(sendCloudMessage({ fetchImpl: f.fetch }, { storeId: "s", instanceTokenEnc: "x", phoneNumberId: "1", wabaId: "2" }, { to: "1", text: "x", reference: "m" })).rejects.toMatchObject({ kind: "not_configured" });
    expect(f.calls).toEqual([]);
  });
});
