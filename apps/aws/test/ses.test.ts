import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@app/core/mailer", async (orig) => ({ ...(await orig<typeof import("@app/core/mailer")>()), env: () => ({ EMAIL_FROM: "bizinsights <no-reply@example.test>" }) }));

const { sesMailer } = await import("../src/sesMailer.js");
const { chooseMailer } = await import("../src/mailers.js");
const { MailError, resetEnvCache } = await import("@app/core");
type MailError = InstanceType<typeof MailError>;

describe("the SES mailer", () => {
  it("sends text and HTML through SES v2 from EMAIL_FROM, signed", async () => {
    const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, auth: req.headers.get("authorization"), body: JSON.parse(await req.text()) });
      return new Response(JSON.stringify({ MessageId: "1" }));
    }) as typeof fetch;
    const mailer = sesMailer({ region: "ap-southeast-2", credentials: { accessKeyId: "a", secretAccessKey: "b" }, configurationSet: "cs", fetchImpl });
    await mailer.send("someone@example.test", "Hi", "plain", "<p>rich</p>");
    expect(seen[0]!.url).toBe("https://email.ap-southeast-2.amazonaws.com/v2/email/outbound-emails");
    expect(seen[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 .*\/ap-southeast-2\/ses\/aws4_request/);
    expect(seen[0]!.body).toEqual({
      FromEmailAddress: "bizinsights <no-reply@example.test>",
      Destination: { ToAddresses: ["someone@example.test"] },
      Content: { Simple: { Subject: { Data: "Hi", Charset: "UTF-8" }, Body: { Text: { Data: "plain", Charset: "UTF-8" }, Html: { Data: "<p>rich</p>", Charset: "UTF-8" } } } },
      ConfigurationSetName: "cs",
    });
  });

  it("sends replies where the message says (an invitation: to whoever sent it)", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(await new Request(input, init).text());
      return new Response(JSON.stringify({ MessageId: "1" }));
    }) as typeof fetch;
    const mailer = sesMailer({ region: "ap-southeast-2", credentials: { accessKeyId: "a", secretAccessKey: "b" }, fetchImpl });
    await mailer.send("client@example.test", "Hi", "plain", undefined, { replyTo: "owner@example.test" });
    expect(body.ReplyToAddresses).toEqual(["owner@example.test"]);
    await mailer.send("client@example.test", "Hi", "plain");
    expect(body).not.toHaveProperty("ReplyToAddresses");
  });

  it("throws with SES's reason (not the recipient) when SES refuses, telling its sandbox from an outage", async () => {
    const answer = (status: number, message: string, type?: string) =>
      (async () => new Response(JSON.stringify({ message }), { status, headers: type ? { "x-amzn-errortype": `${type}:http://internal.amazon.com/` } : {} })) as unknown as typeof fetch;
    const mailer = (fetchImpl: typeof fetch) => sesMailer({ region: "ap-southeast-2", credentials: { accessKeyId: "a", secretAccessKey: "b" }, fetchImpl });
    const sandbox = await mailer(answer(400, "Email address is not verified. The following identities failed the check in region AP-SOUTHEAST-2: x@example.test", "MessageRejected"))
      .send("x@example.test", "s", "t")
      .catch((e: MailError) => e);
    expect(sandbox).toBeInstanceOf(MailError);
    expect(sandbox).toMatchObject({ provider: "ses", failure: "not_allowed", code: "MessageRejected" });
    expect((sandbox as MailError).message).toContain("SES send failed (400 MessageRejected): Email address is not verified.");
    expect((sandbox as MailError).message).not.toContain("x@example.test");
    expect(await mailer(answer(429, "Maximum sending rate exceeded.", "ThrottlingException")).send("x@example.test", "s", "t").catch((e: MailError) => e.failure)).toBe("transient");
    expect(await mailer(answer(503, "Service unavailable")).send("x@example.test", "s", "t").catch((e: MailError) => e.failure)).toBe("transient");
    expect(await mailer(answer(400, "Illegal address", "BadRequestException")).send("x@example.test", "s", "t").catch((e: MailError) => e.failure)).toBe("permanent");
  });

  it("returns SES's message id, for the delivery record", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ MessageId: "0108019a-ses-id" }), { status: 200 })) as unknown as typeof fetch;
    const mailer = sesMailer({ region: "ap-southeast-2", credentials: { accessKeyId: "a", secretAccessKey: "b" }, fetchImpl });
    expect(await mailer.send("x@example.test", "s", "t")).toEqual({ provider: "ses", messageId: "0108019a-ses-id" });
  });
});

describe("choosing the mail provider", () => {
  const creds = { accessKeyId: "a", secretAccessKey: "b" };
  // The Resend mailer lives in core and reads core's own settings (not the mocked env above).
  const saved = { ...process.env };
  beforeAll(() => {
    Object.assign(process.env, { NODE_ENV: "test", SESSION_SECRET: "unit-session-secret-123456", OTP_PEPPER: "unit-pepper", TOKEN_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 1).toString("base64")}` });
    resetEnvCache();
  });
  afterAll(() => {
    process.env = saved;
    resetEnvCache();
  });
  it("uses Resend once its key is in the app secret, SES otherwise, and says nothing is sent without either", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "re_1", MessageId: "ses_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await chooseMailer({ RESEND_API_KEY: "re_x", SES_REGION: "ap-southeast-2" }, creds, fetchImpl).send("a@b.co", "s", "t")).toEqual({ provider: "resend", messageId: "re_1" });
    expect(await chooseMailer({ SES_REGION: "ap-southeast-2" }, creds, fetchImpl).send("a@b.co", "s", "t")).toEqual({ provider: "ses", messageId: "ses_1" });
    expect(await chooseMailer({ EMAIL_PROVIDER: "ses", RESEND_API_KEY: "re_x", SES_REGION: "ap-southeast-2" }, creds, fetchImpl).send("a@b.co", "s", "t")).toEqual({ provider: "ses", messageId: "ses_1" });
    // Resend asked for but its key missing: SES rather than nothing.
    expect(await chooseMailer({ EMAIL_PROVIDER: "resend", SES_REGION: "ap-southeast-2" }, creds, fetchImpl).send("a@b.co", "s", "t")).toEqual({ provider: "ses", messageId: "ses_1" });
    expect(await chooseMailer({}, creds, fetchImpl).send("a@b.co", "s", "t")).toEqual({ provider: "log", messageId: null });
    expect(calls.filter((u) => u.includes("api.resend.com"))).toHaveLength(1);
  });
});
