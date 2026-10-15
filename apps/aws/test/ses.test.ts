import { describe, expect, it, vi } from "vitest";

vi.mock("@app/core", async (orig) => ({ ...(await orig<typeof import("@app/core")>()), env: () => ({ EMAIL_FROM: "Insights <no-reply@example.test>" }) }));

const { sesMailer } = await import("../src/sesMailer.js");

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
      FromEmailAddress: "Insights <no-reply@example.test>",
      Destination: { ToAddresses: ["someone@example.test"] },
      Content: { Simple: { Subject: { Data: "Hi", Charset: "UTF-8" }, Body: { Text: { Data: "plain", Charset: "UTF-8" }, Html: { Data: "<p>rich</p>", Charset: "UTF-8" } } } },
      ConfigurationSetName: "cs",
    });
  });

  it("throws with SES's reason (not the recipient) when SES refuses", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "Email address is not verified." }), { status: 400 })) as unknown as typeof fetch;
    const mailer = sesMailer({ region: "ap-southeast-2", credentials: { accessKeyId: "a", secretAccessKey: "b" }, fetchImpl });
    await expect(mailer.send("x@example.test", "s", "t")).rejects.toThrow("SES send failed (400): Email address is not verified.");
  });
});
