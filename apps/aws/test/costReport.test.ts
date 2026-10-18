import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache, type Mailer } from "@app/core";
import { costEmail, costReportDeps, costRequest, dayLabel, fetchCosts, money, reportPeriod, sendCostReport, summarizeCosts, type CostExplorerPage } from "../src/costReport.js";

const TO = "owner@example.test";

/** One day of Cost Explorer's DAILY + SERVICE answer: UnblendedCost per service, amounts as strings. */
function day(start: string, costs: Record<string, string>, unit = "USD") {
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    TimePeriod: { Start: start, End: end },
    Total: {},
    Groups: Object.entries(costs).map(([service, amount]) => ({ Keys: [service], Metrics: { UnblendedCost: { Amount: amount, Unit: unit } } })),
    Estimated: true,
  };
}

/** Shaped like the account's October: the NAT gateway gone after the 16th, RDS the biggest. */
const OCTOBER: CostExplorerPage = {
  ResultsByTime: [
    day("2026-10-16", { "Amazon Relational Database Service": "1.4", "EC2 - Other": "1.38", "AWS WAF": "0.29", "Amazon Virtual Private Cloud": "0.15" }),
    day("2026-10-17", {
      "Amazon Relational Database Service": "1.2241",
      "Amazon Elastic Compute Cloud - Compute": "0.2544",
      "AWS WAF": "0.2901",
      "Amazon Virtual Private Cloud": "0.24",
      "AWS Cost Explorer": "0.15",
      "AWS Key Management Service": "0.0330",
      "AWS Secrets Manager": "0.0401",
      "AmazonCloudWatch": "0.0412",
      "Amazon Simple Storage Service": "0.0061",
      "Amazon DynamoDB": "0.0000031",
      "AWS Lambda": "0",
    }),
  ],
};

describe("the period", () => {
  it("reports yesterday (UTC) and the month up to it", () => {
    expect(reportPeriod(new Date("2026-10-18T20:00:00Z"))).toEqual({ day: "2026-10-17", start: "2026-10-01", end: "2026-10-18" });
    // 07:00 in Melbourne is still the day before in UTC.
    expect(reportPeriod(new Date("2026-10-19T07:00:00+11:00"))).toEqual({ day: "2026-10-17", start: "2026-10-01", end: "2026-10-18" });
  });

  it("on the 1st reports last month whole, across a year too", () => {
    expect(reportPeriod(new Date("2026-11-01T20:00:00Z"))).toEqual({ day: "2026-10-31", start: "2026-10-01", end: "2026-11-01" });
    expect(reportPeriod(new Date("2027-01-01T00:00:00Z"))).toEqual({ day: "2026-12-31", start: "2026-12-01", end: "2027-01-01" });
    expect(reportPeriod(new Date("2026-10-02T23:59:59Z"))).toEqual({ day: "2026-10-01", start: "2026-10-01", end: "2026-10-02" });
  });

  it("asks Cost Explorer for daily unblended cost by service", () => {
    expect(costRequest({ start: "2026-10-01", end: "2026-10-18" })).toEqual({
      TimePeriod: { Start: "2026-10-01", End: "2026-10-18" },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    });
    expect(costRequest({ start: "2026-10-01", end: "2026-10-18" }, "tok")).toMatchObject({ NextPageToken: "tok" });
  });
});

describe("reading Cost Explorer's answer", () => {
  it("adds up the day and the month per service, the day's biggest first", () => {
    const s = summarizeCosts([OCTOBER], "2026-10-17");
    expect(s).toMatchObject({ day: "2026-10-17", monthStart: "2026-10-01", currency: "USD", dayFound: true, daysWithCost: 2 });
    expect(s.dayTotal).toBeCloseTo(2.2790031, 6);
    expect(s.monthTotal).toBeCloseTo(2.2790031 + 3.22, 6);
    expect(s.services.map((r) => r.service).slice(0, 4)).toEqual(["Amazon Relational Database Service", "AWS WAF", "Amazon Elastic Compute Cloud - Compute", "Amazon Virtual Private Cloud"]);
    const rds = s.services.find((r) => r.service === "Amazon Relational Database Service")!;
    expect(rds.day).toBeCloseTo(1.2241, 6);
    expect(rds.month).toBeCloseTo(2.6241, 6);
    // Nothing on the day, still in the month.
    expect(s.services.find((r) => r.service === "EC2 - Other")).toMatchObject({ day: 0, month: 1.38 });
    // A zero is no service at all.
    expect(s.services.some((r) => r.service === "AWS Lambda")).toBe(false);
  });

  it("joins pages, and says when the day isn't in Cost Explorer yet", () => {
    const [first, second] = OCTOBER.ResultsByTime!;
    const s = summarizeCosts([{ ResultsByTime: [first!], NextPageToken: "p2" }, { ResultsByTime: [second!] }], "2026-10-17");
    expect(s.monthTotal).toBeCloseTo(summarizeCosts([OCTOBER], "2026-10-17").monthTotal, 9);
    const lagging = summarizeCosts([{ ResultsByTime: [first!] }], "2026-10-17");
    expect(lagging).toMatchObject({ dayFound: false, dayTotal: 0 });
    expect(lagging.monthTotal).toBeCloseTo(3.22, 6);
    expect(summarizeCosts([{}], "2026-10-17")).toMatchObject({ dayFound: false, dayTotal: 0, monthTotal: 0, services: [] });
  });

  it("keeps credits negative and refuses to add two currencies", () => {
    const s = summarizeCosts([{ ResultsByTime: [day("2026-10-17", { "Amazon Relational Database Service": "1.00", Credits: "-0.40" })] }], "2026-10-17");
    expect(s.dayTotal).toBeCloseTo(0.6, 9);
    expect(() => summarizeCosts([{ ResultsByTime: [day("2026-10-16", { A: "1" }), day("2026-10-17", { B: "1" }, "EUR")] }], "2026-10-17")).toThrow(/more than one currency/);
  });
});

describe("the email", () => {
  it("formats money and days", () => {
    expect(money(2.406)).toBe("US$2.41");
    expect(money(0)).toBe("US$0.00");
    expect(money(0.004)).toBe("<US$0.01");
    expect(money(-1.234)).toBe("-US$1.23");
    expect(money(12.5, "EUR")).toBe("EUR 12.50");
    expect(dayLabel("2026-10-17")).toBe("Sat 17 Oct 2026");
    expect(dayLabel("2026-11-01")).toBe("Sun 1 Nov 2026");
  });

  it("leads with the day and the month so far, lists the day's services, and says what the bill adds", () => {
    const m = costEmail(summarizeCosts([OCTOBER], "2026-10-17"));
    expect(m.subject).toBe("AWS cost 17 Oct: US$2.28, October so far US$5.50");
    const lines = m.text.split("\n");
    expect(lines[0]).toBe("Sat 17 Oct 2026 (UTC): US$2.28");
    expect(lines[1]).toBe("October so far (1-17 Oct): US$5.50, about US$2.75 a day over the 2 days Cost Explorer has");
    expect(m.text).toMatch(/^Amazon Relational Database Service\s+US\$1\.22\s+US\$2\.62$/m);
    // The NAT gateway's day: nothing yesterday, but a quarter of the month, so it is listed.
    expect(m.text).toMatch(/^EC2 - Other\s+US\$0\.00\s+US\$1\.38$/m);
    // Eight of the day's services, then the rest together (S3's and DynamoDB's few cents).
    expect(m.text).toMatch(/^Everything else \(2 services\)\s+US\$0\.01\s+US\$0\.01$/m);
    expect(m.text).not.toMatch(/^Amazon DynamoDB/m);
    expect(m.text).toMatch(/^Total\s+US\$2\.28\s+US\$5\.50$/m);
    expect(m.text).toContain("Business Support+");
    expect(m.text).toContain("GST");
    expect(m.text).toContain("about a day behind the Bills page");
    expect(m.text).not.toContain("still coming in");
    expect(m.html).toContain("<td");
    expect(m.html).toContain("US$15.72");
  });

  it("says when the day is missing, names a non-production environment, and escapes service names", () => {
    const s = summarizeCosts([{ ResultsByTime: [day("2026-10-01", { "A <b>&</b> B": "1" })] }], "2026-10-02");
    const m = costEmail(s, "staging");
    expect(m.subject).toBe("AWS cost (staging) 2 Oct: US$0.00, October so far US$1.00");
    expect(m.text).toContain("Cost Explorer has nothing for Fri 2 Oct 2026 yet");
    expect(m.text).toContain("October so far (1-2 Oct)");
    expect(m.html).toContain("A &lt;b&gt;&amp;&lt;/b&gt; B");
    expect(m.html).not.toContain("<b>&</b>");
    expect(costEmail(summarizeCosts([OCTOBER], "2026-10-01")).text).toContain("October so far (1 Oct)");
  });
});

describe("sending it", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  function recordingMailer() {
    const sent: Array<{ to: string; subject: string; text: string; html?: string; idempotencyKey?: string }> = [];
    const mailer: Mailer = {
      async send(to, subject, text, html, opts) {
        sent.push({ to, subject, text, html, idempotencyKey: opts?.idempotencyKey });
        return { provider: "resend", messageId: "re_123" };
      },
    };
    return { mailer, sent };
  }

  it("makes one Cost Explorer call, sends once per invocation, and logs the message id but never the address", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    vi.stubEnv("LOG_LEVEL", "debug");
    const calls: Array<[string, Record<string, unknown>]> = [];
    const call = async <T,>(operation: string, body: Record<string, unknown>) => {
      calls.push([operation, body]);
      return OCTOBER as T;
    };
    const { mailer, sent } = recordingMailer();
    const result = await sendCostReport({ call, mailer, to: TO, environment: "production", now: new Date("2026-10-18T20:00:00Z"), invocationId: "req-1" });
    expect(calls).toEqual([["GetCostAndUsage", costRequest({ start: "2026-10-01", end: "2026-10-18" })]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: TO, subject: "AWS cost 17 Oct: US$2.28, October so far US$5.50", idempotencyKey: "cost-report-2026-10-17-req-1" });
    expect(result).toEqual({ sent: true, day: "2026-10-17", dayTotal: 2.28, monthTotal: 5.5, services: 11, pages: 1, provider: "resend", messageId: "re_123" });
    const log = lines.join("\n");
    expect(log).toContain("re_123");
    expect(log).not.toContain(TO);
    expect(log).not.toContain("example.test");
  });

  it("follows Cost Explorer's pages, but only so far (each is a paid call)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tokens: Array<unknown> = [];
    const paging = async <T,>(_op: string, body: Record<string, unknown>) => {
      tokens.push(body.NextPageToken);
      return { ResultsByTime: [], NextPageToken: `t${tokens.length}` } as T;
    };
    expect(await fetchCosts(paging, { start: "2026-10-01", end: "2026-10-18" })).toHaveLength(3);
    expect(tokens).toEqual([undefined, "t1", "t2"]);
  });

  it("calls Cost Explorer's us-east-1 endpoint signed for `ce`, and Resend with the app secret's key", async () => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return String(input).includes("resend") ? Response.json({ id: "re_abc" }) : Response.json(OCTOBER);
    };
    const env = { COST_REPORT_TO: TO, RESEND_API_KEY: "re_test_key", APP_ENVIRONMENT: "production" } as NodeJS.ProcessEnv;
    // The Resend mailer reads EMAIL_FROM from the app's settings, which need these to parse.
    for (const [k, v] of Object.entries({ SESSION_SECRET: "unit-session-secret-123456", OTP_PEPPER: "unit-pepper", TOKEN_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 1).toString("base64")}`, EMAIL_FROM: "bizinsights <noreply@bizinsights.io>" })) vi.stubEnv(k, v);
    resetEnvCache();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = costReportDeps(env, { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" }, fetchImpl);
    const result = await sendCostReport({ ...deps, now: new Date("2026-10-18T20:00:00Z"), invocationId: "req-2" });
    expect(result.messageId).toBe("re_abc");
    expect(requests).toHaveLength(2);
    const [ce, resend] = requests;
    expect(ce!.url).toBe("https://ce.us-east-1.amazonaws.com/");
    expect(ce!.headers.get("x-amz-target")).toBe("AWSInsightsIndexService.GetCostAndUsage");
    expect(ce!.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(ce!.headers.get("authorization")).toMatch(/Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ce\/aws4_request/);
    expect(JSON.parse(ce!.body)).toEqual(costRequest({ start: "2026-10-01", end: "2026-10-18" }));
    expect(resend!.url).toBe("https://api.resend.com/emails");
    expect(resend!.headers.get("authorization")).toBe("Bearer re_test_key");
    expect(resend!.headers.get("idempotency-key")).toBe("cost-report-2026-10-17-req-2");
    expect(JSON.parse(resend!.body)).toMatchObject({ to: [TO], subject: "AWS cost 17 Oct: US$2.28, October so far US$5.50" });
  });

  it("refuses to run without a recipient or Resend (never SES)", () => {
    const creds = { accessKeyId: "a", secretAccessKey: "b" };
    expect(() => costReportDeps({ RESEND_API_KEY: "k" } as NodeJS.ProcessEnv, creds)).toThrow(/COST_REPORT_TO/);
    expect(() => costReportDeps({ COST_REPORT_TO: TO, SES_REGION: "ap-southeast-2" } as NodeJS.ProcessEnv, creds)).toThrow(/RESEND_API_KEY/);
  });
});
