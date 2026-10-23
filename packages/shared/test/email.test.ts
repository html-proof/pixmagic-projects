import { describe, expect, it } from "vitest";
import {
  blockedAddressReason,
  conditionNodeSchema,
  conditionProblems,
  customDataProblems,
  describeConditions,
  evaluateConditions,
  evaluateDkim,
  evaluateDmarc,
  evaluateOwnership,
  evaluateSpf,
  htmlToText,
  ingestEventSchema,
  isAllowedVariable,
  isCustomEventType,
  isEmail,
  joinTxt,
  maskEmail,
  normalizeDomain,
  normalizeEmail,
  parseDkim,
  parseIPv6,
  parseTemplate,
  readPath,
  renderTemplate,
  ruleInputSchema,
  sampleEventData,
  sanitizeHtml,
  smtpConnectionSchema,
  smtpHostProblem,
  smtpPortProblem,
  templateProblems,
  verificationRecord,
  type ConditionNode,
} from "../src/email/index.js";

describe("email conditions", () => {
  const order = sampleEventData("order.paid");

  it("evaluates comparisons, and/or groups and exists", () => {
    const rule: ConditionNode = {
      op: "and",
      conditions: [
        { op: "greater_than", field: "order.total", value: 100 },
        { op: "exists", field: "customer.email" },
        { op: "or", conditions: [{ op: "equals", field: "order.currency", value: "usd" }, { op: "in", field: "order.shipping_country", value: ["GB", "FR"] }] },
      ],
    };
    expect(conditionProblems(rule, "order.paid")).toEqual([]);
    expect(evaluateConditions(rule, order, "order.paid").pass).toBe(true);
    expect(evaluateConditions(rule, { ...order, order: { ...(order.order as object), total: 99 } }, "order.paid").pass).toBe(false);
    expect(evaluateConditions(rule, { ...order, customer: {} }, "order.paid").pass).toBe(false);
  });

  it("treats a missing value as not matching, except for negative operators", () => {
    expect(evaluateConditions({ op: "equals", field: "order.currency", value: "USD" }, {}).pass).toBe(false);
    expect(evaluateConditions({ op: "not_equals", field: "order.currency", value: "USD" }, {}).pass).toBe(true);
    expect(evaluateConditions({ op: "not_exists", field: "order.currency" }, {}).pass).toBe(true);
  });

  it("compares lists and numeric strings", () => {
    expect(evaluateConditions({ op: "contains", field: "order.product_titles", value: "linen" }, order).pass).toBe(true);
    expect(evaluateConditions({ op: "not_contains", field: "order.product_titles", value: "boots" }, order).pass).toBe(true);
    expect(evaluateConditions({ op: "greater_or_equal", field: "data.amount", value: 49 }, { data: { amount: "49.00" } }).pass).toBe(true);
    expect(evaluateConditions({ op: "equals", field: "customer.accepts_marketing", value: true }, order).pass).toBe(true);
  });

  it("rejects unknown fields, wrong operators and wrong value types", () => {
    expect(conditionProblems({ op: "equals", field: "order.secret", value: "x" }, "order.paid")[0]).toMatch(/isn't a field/);
    expect(conditionProblems({ op: "greater_than", field: "customer.email", value: 3 }, "order.paid")[0]).toMatch(/can't be used/);
    expect(conditionProblems({ op: "greater_than", field: "order.total", value: "100" as never }, "order.paid")[0]).toMatch(/number/);
    expect(conditionProblems({ op: "in", field: "order.currency", value: [] }, "order.paid")[0]).toMatch(/at least one/);
    // Custom events: any data.* field, nothing else outside the customer fields.
    expect(conditionProblems({ op: "equals", field: "data.plan", value: "pro" }, "subscription.expiring")).toEqual([]);
    expect(conditionProblems({ op: "equals", field: "order.total", value: 1 }, "subscription.expiring")[0]).toMatch(/isn't a field/);
  });

  it("bounds depth and size", () => {
    let deep: ConditionNode = { op: "exists", field: "customer.email" };
    for (let i = 0; i < 6; i++) deep = { op: "and", conditions: [deep] };
    expect(conditionProblems(deep, "order.paid").join(" ")).toMatch(/nested/);
    const wide: ConditionNode = { op: "or", conditions: Array.from({ length: 41 }, () => ({ op: "exists" as const, field: "customer.email" })) };
    expect(conditionProblems(wide, "order.paid").join(" ")).toMatch(/at most 40/);
    expect(conditionNodeSchema.safeParse({ op: "equals", field: "a.b", value: "x", extra: 1 }).success).toBe(false);
    expect(conditionNodeSchema.safeParse({ op: "eval", field: "a", value: "process.exit()" }).success).toBe(false);
  });

  it("masks personal data in traces and describes rules in words", () => {
    const { trace } = evaluateConditions({ op: "exists", field: "customer.email" }, order, "order.paid");
    expect(trace[0]!.actual).toBe("(hidden personal data)");
    expect(describeConditions({ op: "and", conditions: [{ op: "greater_than", field: "order.total", value: 100 }, { op: "exists", field: "customer.email" }] }, "order.paid")).toBe(
      "Order total is more than 100 and Customer email is present",
    );
  });
});

describe("email templates", () => {
  const data = { customer: { first_name: "Alex", email: "alex@example.com" }, order: { total: 129.5, product_titles: ["A", "B"] }, evil: "<script>x</script>" };

  it("renders placeholders, fallbacks and formats", () => {
    expect(renderTemplate("Hi {{ customer.first_name }}, total {{order.total}}: {{ order.product_titles }}", data, "text")).toBe("Hi Alex, total 129.50: A, B");
    expect(renderTemplate('Hi {{ customer.last_name | default: "there" }}', data, "text")).toBe("Hi there");
    expect(renderTemplate("{{ missing.value }}!", data, "text")).toBe("!");
  });

  it("escapes values in HTML and strips line breaks from subjects", () => {
    expect(renderTemplate("<p>{{ evil }}</p>", data, "html")).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
    expect(renderTemplate("Order {{ x }}", { x: "1\r\nBcc: victim@example.com" }, "subject")).toBe("Order 1 Bcc: victim@example.com");
  });

  it("never reaches prototypes or non-data", () => {
    expect(parseTemplate("{{ constructor.constructor }}").errors.length).toBe(1);
    expect(parseTemplate("{{ __proto__ }}").errors.length).toBe(1);
    expect(renderTemplate("{{ toString }}", {}, "text")).toBe("");
    expect(readPath({ a: Object.create({ inherited: "x" }) }, "a.inherited")).toBeUndefined();
    expect(parseTemplate("{{ a | upper }}").errors.length).toBe(1);
    expect(parseTemplate("{{ a").errors[0]).toMatch(/never closed/);
  });

  it("checks variables against the event", () => {
    const allowed = (p: string) => isAllowedVariable("order.paid", "transactional", p);
    expect(templateProblems({ subject: "Order {{order.id}}", html: "<p>{{customer.first_name}}</p>", text: "" }, allowed)).toEqual([]);
    expect(templateProblems({ subject: "{{checkout.recovery_url}}", html: "", text: "" }, allowed)[0]).toMatch(/isn't available/);
    expect(isAllowedVariable("order.paid", "transactional", "unsubscribe_url")).toBe(false);
    expect(isAllowedVariable("order.paid", "marketing", "unsubscribe_url")).toBe(true);
    expect(isAllowedVariable("invoice.overdue", "transactional", "data.amount")).toBe(true);
  });

  it("makes a text version of HTML", () => {
    expect(htmlToText('<p>Hello</p><p>See <a href="https://x.test/a">your order</a></p>')).toBe("Hello\nSee your order (https://x.test/a)");
  });
});

describe("HTML sanitizer", () => {
  it("removes scripts, handlers and dangerous URLs", () => {
    const out = sanitizeHtml(
      `<p onclick="x()">Hi<script>alert(1)</script></p><a href="javascript:alert(1)">a</a><a href="jav&#x09;ascript:alert(1)">b</a><img src="data:image/png;base64,AAA"><iframe src="https://x"></iframe><style>body{}</style>`,
    );
    expect(out).toBe("<p>Hi</p><a>a</a><a>b</a><img>");
  });

  it("keeps email formatting and safe links, re-serialized", () => {
    expect(sanitizeHtml(`<table cellpadding=4><tr><td style="color:red">x</td></tr></table><a href='https://shop.test/?a=1&b=2' target=_blank>go</a>`)).toBe(
      '<table cellpadding="4"><tr><td style="color:red">x</td></tr></table><a href="https://shop.test/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">go</a>',
    );
  });

  it("drops dangerous styles, comments and unknown tags but keeps their text", () => {
    expect(sanitizeHtml(`<div style="background:url(javascript:x)">a</div><!-- c --><custom-el>b</custom-el><div style="width:expression(alert(1))">c</div>`)).toBe("<div>a</div>b<div>c</div>");
  });

  it("can't be tricked into reopening a tag", () => {
    // An unbalanced quote leaves the tag unterminated: everything after it becomes inert text.
    const unbalanced = sanitizeHtml(`<a title="x" href="https://a.test" "><script>alert(1)</script>`);
    expect(unbalanced).not.toContain("<");
    expect(unbalanced).toContain("&lt;script&gt;");
    expect(sanitizeHtml(`<<script>script>alert(1)<</script>/script>`)).toBe("&lt;/script&gt;");
    expect(sanitizeHtml(`<img src="x" onerror="alert(1)"`)).toBe('&lt;img src="x" onerror="alert(1)"');
  });

  it("keeps placeholders in links only when asked", () => {
    expect(sanitizeHtml(`<a href="{{order.status_url}}">x</a>`, { allowPlaceholders: true })).toBe('<a href="{{order.status_url}}">x</a>');
    expect(sanitizeHtml(`<a href="{{order.status_url}}">x</a>`)).toBe("<a>x</a>");
  });
});

describe("addresses and domains", () => {
  it("validates and normalizes addresses", () => {
    expect(normalizeEmail(" Alex@Example.COM ")).toBe("alex@example.com");
    for (const bad of ["a@b", "a b@c.com", "a@b.com\r\nBcc: x@y.com", "<a@b.com>", "a..b@c.com", "a@-b.com", ".a@b.com"]) expect(isEmail(bad)).toBe(false);
    expect(maskEmail("alex@example.com")).toBe("a***x@example.com");
  });

  it("normalizes sending domains and refuses private ones", () => {
    expect(normalizeDomain("https://Example.com/path")).toBe("example.com");
    expect(normalizeDomain("sales@mail.Example.co.uk")).toBe("mail.example.co.uk");
    expect(normalizeDomain("bücher.de")).toBe("xn--bcher-kva.de");
    for (const bad of ["localhost", "10.0.0.1", "intranet", "printer.local", "x.internal", "a..b.com", "-a.com"]) expect(normalizeDomain(bad)).toBeNull();
  });
});

describe("DNS checks", () => {
  it("joins TXT parts", () => {
    expect(joinTxt('"v=spf1 include:_spf.google.com" " ~all"')).toBe("v=spf1 include:_spf.google.com ~all");
  });

  it("verifies the ownership challenge exactly", () => {
    const rec = verificationRecord("example.com", "tok123");
    expect(rec.host).toBe("_insights-verify.example.com");
    expect(evaluateOwnership(["insights-verification=tok123"], rec.value).status).toBe("pass");
    expect(evaluateOwnership(["insights-verification=other"], rec.value).status).toBe("fail");
    expect(evaluateOwnership([], rec.value).status).toBe("missing");
  });

  it("judges SPF", () => {
    expect(evaluateSpf(["v=spf1 include:_spf.google.com ~all"], "google", ["_spf.google.com"]).status).toBe("pass");
    expect(evaluateSpf(["v=spf1 include:spf.protection.outlook.com -all"], "google", ["spf.protection.outlook.com"]).status).toBe("fail");
    expect(evaluateSpf(["v=spf1 a ~all", "v=spf1 mx ~all"], "google", []).status).toBe("fail");
    expect(evaluateSpf(["v=spf1 +all"], "other", []).status).toBe("fail");
    expect(evaluateSpf(["v=spf1 include:mailgun.org ~all"], "other", ["mailgun.org"]).status).toBe("unknown");
    expect(evaluateSpf(["google-site-verification=x"], "google", []).status).toBe("missing");
  });

  it("only reports DKIM from a real key at a known selector", () => {
    const key = `v=DKIM1; k=rsa; p=${"A".repeat(200)}`;
    expect(evaluateDkim([parseDkim("google", [key])], "google").status).toBe("pass");
    expect(evaluateDkim([parseDkim("google", ["v=DKIM1; p="])], "google").status).toBe("fail");
    expect(evaluateDkim([parseDkim("google", ["some-other-txt"])], "google").status).toBe("missing");
    expect(evaluateDkim([], "other").status).toBe("unknown");
  });

  it("judges DMARC", () => {
    expect(evaluateDmarc(["v=DMARC1; p=reject; rua=mailto:d@example.com"]).status).toBe("pass");
    expect(evaluateDmarc(["v=DMARC1; p=none"]).status).toBe("warn");
    expect(evaluateDmarc(["v=DMARC1; rua=mailto:x@y.com"]).status).toBe("fail");
    expect(evaluateDmarc([]).status).toBe("missing");
  });
});

describe("SMTP outbound policy", () => {
  it("blocks private, loopback, link-local, metadata and special addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "ff02::1"]) {
      expect(blockedAddressReason(ip), ip).not.toBeNull();
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "142.250.1.1", "2607:f8b0:4004:c07::6c", "::ffff:8.8.8.8"]) expect(blockedAddressReason(ip), ip).toBeNull();
    expect(parseIPv6("fe80::1%eth0")).toBeNull();
  });

  it("checks host names before any lookup", () => {
    expect(smtpHostProblem("smtp.gmail.com")).toBeNull();
    expect(smtpHostProblem("localhost")).toBe("blocked_destination");
    expect(smtpHostProblem("mail.internal")).toBe("blocked_destination");
    expect(smtpHostProblem("127.0.0.1")).toBe("blocked_destination");
    expect(smtpHostProblem("[::1]")).toBe("blocked_destination");
    expect(smtpHostProblem("metadata.google.internal")).toBe("blocked_destination");
    expect(smtpHostProblem("smtp")).toBe("invalid_host");
    expect(smtpHostProblem("bad host.com")).toBe("invalid_host");
  });

  it("allows only encrypted ports", () => {
    expect(smtpPortProblem(465, "tls")).toBeNull();
    expect(smtpPortProblem(587, "starttls")).toBeNull();
    expect(smtpPortProblem(587, "tls")).toMatch(/STARTTLS/);
    expect(smtpPortProblem(25, "starttls")).toMatch(/isn't supported/);
  });

  it("validates the SMTP form without accepting header injection", () => {
    const ok = smtpConnectionSchema.safeParse({ emailAddress: "Billing@Shop.com", host: "smtp.shop.com", port: 587, encryption: "starttls", username: "u", password: "p" });
    expect(ok.success && ok.data.emailAddress).toBe("billing@shop.com");
    expect(smtpConnectionSchema.safeParse({ emailAddress: "a@b.com", displayName: "A\r\nBcc: x", host: "smtp.b.com", port: 587, encryption: "starttls", username: "u", password: "p" }).success).toBe(false);
  });
});

describe("events and rules", () => {
  it("separates custom events from reserved Shopify ones", () => {
    expect(isCustomEventType("appointment.booked")).toBe(true);
    expect(isCustomEventType("order.paid")).toBe(false);
    expect(isCustomEventType("Order.Paid")).toBe(false);
    expect(isCustomEventType("single")).toBe(false);
  });

  it("limits custom event data", () => {
    expect(customDataProblems({ amount: 1, plan: { name: "pro" } })).toEqual([]);
    expect(customDataProblems({ "Bad-Key": 1 })[0]).toMatch(/lowercase/);
    expect(customDataProblems({ a: { b: { c: { d: 1 } } } })[0]).toMatch(/deeper/);
    expect(customDataProblems([1])[0]).toMatch(/object/);
  });

  it("parses rule and event input with defaults", () => {
    const r = ruleInputSchema.parse({ name: "Thanks", eventType: "order.paid", senderIdentityId: "s1", templateId: "t1" });
    expect(r.recipient).toEqual({ type: "customer" });
    expect(r.frequency).toEqual({ type: "once_per_event" });
    expect(ruleInputSchema.safeParse({ name: "x", eventType: "order.paid", senderIdentityId: "s", templateId: "t", delayMinutes: 50_000 }).success).toBe(false);
    expect(ingestEventSchema.safeParse({ id: "evt 1", type: "a.b" }).success).toBe(false);
  });

  it("takes occurred_at in the ISO 8601 forms senders use, at the same instant", () => {
    const at = (occurred_at?: string) => ingestEventSchema.safeParse({ id: "evt_1", type: "a.b", occurred_at });
    for (const [sent, instant] of [
      ["2026-10-24T10:00:00+05:30", "2026-10-24T04:30:00.000Z"],
      ["2026-10-24T10:00:00+0530", "2026-10-24T04:30:00.000Z"],
      ["2026-10-24T10:00:00.000+0000", "2026-10-24T10:00:00.000Z"],
      ["2026-10-24T01:23:45-0400", "2026-10-24T05:23:45.000Z"],
      ["2026-10-24T10:00Z", "2026-10-24T10:00:00.000Z"],
      ["2026-10-24T10:00+1000", "2026-10-24T00:00:00.000Z"],
      ["2026-10-24T10:00:00.123456Z", "2026-10-24T10:00:00.123Z"],
    ]) {
      const r = at(sent);
      expect(r.success, sent).toBe(true);
      expect(new Date(r.data!.occurred_at!).toISOString(), sent).toBe(instant);
    }
    expect(at(undefined).success).toBe(true);
    for (const bad of ["2026-10-24T10:00:00", "2026-10-24T10:00:00+05", "2026-10-24T10:00:00+99:99", "2026-02-30T10:00:00Z", "2026-10-24 10:00:00Z", "yesterday"]) {
      expect(at(bad).success, bad).toBe(false);
    }
  });
});
