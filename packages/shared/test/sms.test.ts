import { describe, expect, it } from "vitest";
import {
  afterQuietHours,
  budgetAllows,
  budgetLevelsReached,
  checkTemplate,
  classifySendError,
  cleanVariable,
  consentState,
  customerTimeZone,
  dltMatches,
  dltShape,
  estimateCostUsd,
  evaluateRuleConditions,
  hasErrors,
  isSmsStopKeyword,
  mayReceive,
  missingForTrigger,
  previewSms,
  renderSms,
  retryDelaySeconds,
  ruleCan,
  safeUrl,
  smsCampaignCan,
  smsPeriodRange,
  smsRuleSchema,
  smsSegments,
  statusFromEvent,
  statusMayMove,
  templateCan,
  templateVariables,
  toGsmFriendly,
  worstCaseSegments,
  checkSenderName,
  fixVariableAliases,
  ORDER_STATUS_WORD,
  senderIdSupport,
  senderNameStatus,
  SETUP_AUTOMATIONS,
  suggestSenderName,
  AUTOMATION_STARTERS,
  AUTOMATION_TRIGGER_CARDS,
  automationRule,
  automationVariables,
  checkAutomationMessage,
  smsAutomationSchema,
  SMS_TRIGGERS,
  TRIGGER_CONDITION_FIELDS,
  TRIGGER_INFO,
  TRIGGER_SOURCES,
} from "../src/sms.js";

describe("smsSegments", () => {
  it("fits 160 GSM-7 characters in one part and splits longer texts into 153-septet parts", () => {
    expect(smsSegments("")).toMatchObject({ segments: 0, encoding: "GSM" });
    expect(smsSegments("a".repeat(160))).toMatchObject({ segments: 1, encoding: "GSM", units: 160, remaining: 0 });
    expect(smsSegments("a".repeat(161))).toMatchObject({ segments: 2, perSegment: 153 });
    expect(smsSegments("a".repeat(306)).segments).toBe(2);
    expect(smsSegments("a".repeat(307)).segments).toBe(3);
  });

  it("counts the extension table's characters twice and never splits their escape", () => {
    expect(smsSegments("€".repeat(80))).toMatchObject({ encoding: "GSM", units: 160, segments: 1 });
    expect(smsSegments("€".repeat(81)).segments).toBe(2);
    // 152 septets, then a two-septet character that would straddle the 153 boundary: it moves to part 2.
    expect(smsSegments(`${"a".repeat(152)}€${"a".repeat(10)}`).segments).toBe(2);
  });

  it("switches the whole text to UCS-2 for one character outside GSM-7 (70, then 67 per part)", () => {
    const s = smsSegments(`Hi 👋 ${"a".repeat(60)}`);
    expect(s.encoding).toBe("UCS2");
    expect(s.nonGsm).toEqual(["👋"]);
    expect(smsSegments("ł".repeat(70)).segments).toBe(1);
    expect(smsSegments("ł".repeat(71))).toMatchObject({ segments: 2, perSegment: 67 });
    // An emoji is two UTF-16 units and is never split across parts: 134 units take 3 parts, not 2.
    expect(smsSegments(`${"ł".repeat(66)}👋`).segments).toBe(1);
    expect(smsSegments(`${"ł".repeat(66)}👋${"ł".repeat(66)}`).segments).toBe(3);
  });

  it("offers GSM-7 forms of typographic look-alikes", () => {
    const text = "Your order’s on its way – “soon”…";
    expect(smsSegments(text).encoding).toBe("UCS2");
    expect(toGsmFriendly(text)).toBe("Your order's on its way - \"soon\"...");
    expect(smsSegments(toGsmFriendly(text)).encoding).toBe("GSM");
  });
});

describe("template variables", () => {
  it("finds known, unknown and malformed placeholders", () => {
    expect(templateVariables("Hi {{customer_name}}, {{ order_number }} {{nope}}")).toEqual({ used: ["customer_name", "order_number"], unknown: ["nope"], malformed: false });
    expect(templateVariables("Hi {{customer_name}").malformed).toBe(true);
    expect(templateVariables("Hi customer_name}}").malformed).toBe(true);
  });

  it("cleans untrusted values before they go into a text", () => {
    expect(cleanVariable("customer_name", "  Sam‮ O'Brien-Smith  ")).toBe("Sam");
    expect(cleanVariable("customer_name", "José")).toBe("José");
    expect(cleanVariable("customer_name", "<script>")).toBe("script");
    expect(cleanVariable("customer_name", "1234")).toBeNull();
    expect(cleanVariable("product_name", "Shirt\nvisit http://evil.example/x now")).toBe("Shirt visit now");
    expect(cleanVariable("product_name", "Cap — see bad-site.com")).toBe("Cap — see");
    expect(cleanVariable("product_name", "x".repeat(60))).toHaveLength(40);
    expect(cleanVariable("order_number", "#1042")).toBe("#1042");
    expect(cleanVariable("order_number", "#10 42; DROP")).toBeNull();
    expect(cleanVariable("order_total", "89.9")).toBe("89.90");
    expect(cleanVariable("order_total", "lots")).toBeNull();
    expect(cleanVariable("currency", "aud")).toBe("AUD");
    expect(cleanVariable("discount_code", "WELCOME10")).toBe("WELCOME10");
    expect(cleanVariable("discount_code", "TEN OFF")).toBeNull();
  });

  it("only lets well-formed links through (no broken or disguised links)", () => {
    expect(cleanVariable("checkout_url", "https://shop.example.com/checkouts/abc/recover")).toBe("https://shop.example.com/checkouts/abc/recover");
    expect(cleanVariable("checkout_url", "http://shop.example.com/x")).toBeNull();
    expect(cleanVariable("tracking_url", "http://track.example.com/1Z999")).toBe("http://track.example.com/1Z999");
    expect(cleanVariable("tracking_url", "javascript:alert(1)")).toBeNull();
    expect(cleanVariable("tracking_url", "https://user:pw@track.example.com/")).toBeNull();
    expect(cleanVariable("tracking_url", "https://localhost/x")).toBeNull();
    expect(safeUrl("https://a.example.com/a b")).toBeNull();
  });

  it("renders a template only when every value it needs is there and usable", () => {
    const r = renderSms("Hi {{customer_name}}, order {{order_number}} is on its way: {{tracking_url}}", { customer_name: "Sam", order_number: "#1042", tracking_url: "https://t.example.com/1" });
    expect(r).toMatchObject({ ok: true, text: "Hi Sam, order #1042 is on its way: https://t.example.com/1" });
    expect(renderSms("Hi {{customer_name}}", {})).toEqual({ ok: false, missing: ["customer_name"], invalid: [], unknown: [] });
    expect(renderSms("Track {{tracking_url}}", { tracking_url: "not a link" })).toEqual({ ok: false, missing: [], invalid: ["tracking_url"], unknown: [] });
    expect(renderSms("Hi {{who}}", {})).toMatchObject({ ok: false, unknown: ["who"] });
  });

  it("previews with sample values and knows the worst case", () => {
    expect(previewSms("Hi {{customer_name}} from {{store_name}}")).toBe("Hi Sam from Acme Outfitters");
    expect(worstCaseSegments("{{product_name}} {{checkout_url}}").segments).toBeGreaterThanOrEqual(3);
    expect(missingForTrigger("Track {{tracking_url}} {{checkout_url}}", "order_created")).toEqual(["tracking_url", "checkout_url"]);
    expect(missingForTrigger("{{store_name}}: order {{order_number}}", "order_created")).toEqual([]);
  });
});

describe("checkTemplate", () => {
  it("requires an opt-out link in marketing and keeps promotion out of order updates", () => {
    expect(checkTemplate({ category: "marketing", body: "Sale at {{store_name}}!" }).map((i) => i.code)).toContain("no_opt_out");
    expect(hasErrors(checkTemplate({ category: "marketing", body: "{{store_name}}: 10% off with {{discount_code}}. Opt out: {{opt_out_url}}" }))).toBe(false);
    expect(checkTemplate({ category: "transactional", body: "Order {{order_number}} shipped. Use {{discount_code}} next time" }).map((i) => i.code)).toContain("promotional_variable");
    expect(checkTemplate({ category: "transactional", body: "" }).map((i) => i.code)).toContain("empty");
  });

  it("warns about link shorteners, Unicode and long texts", () => {
    const codes = checkTemplate({ category: "transactional", body: "Order {{order_number}} – see bit.ly/abc" }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["link_shortener", "unicode"]));
    expect(checkTemplate({ category: "transactional", body: "x".repeat(1601) }).map((i) => i.code)).toContain("too_long");
  });

  it("insists an Indian template is the registered DLT template word for word", () => {
    const body = "Dear {{customer_name}}, your order {{order_number}} is confirmed - {{store_name}}";
    expect(dltShape(body)).toBe("Dear {#var#}, your order {#var#} is confirmed - {#var#}");
    expect(dltMatches(body, "Dear {#var#}, your order {#var#} is confirmed - {#var#}")).toBe(true);
    expect(dltMatches(body, "Dear {#var#}, your order {#var#} has been confirmed - {#var#}")).toBe(false);
    expect(checkTemplate({ category: "transactional", body, forIndia: true }).map((i) => i.code)).toEqual(expect.arrayContaining(["dlt_template_id", "dlt_text"]));
    expect(checkTemplate({ category: "transactional", body, dltTemplateId: "1107161234567890", dltText: "Dear {#var#}, your order {#var#} has been confirmed" }).map((i) => i.code)).toContain("dlt_mismatch");
    expect(hasErrors(checkTemplate({ category: "transactional", body, dltTemplateId: "1107161234567890", dltText: dltShape(body) }))).toBe(false);
  });

  it("walks templates through draft, review, approval and archive", () => {
    expect(templateCan("draft", "submit")).toBe(true);
    expect(templateCan("draft", "approve")).toBe(false);
    expect(templateCan("in_review", "approve")).toBe(true);
    expect(templateCan("archived", "restore")).toBe(true);
    expect(ruleCan("active", "pause")).toBe(true);
    expect(ruleCan("draft", "resume")).toBe(false);
    expect(smsCampaignCan("approved", "schedule")).toBe(true);
    expect(smsCampaignCan("draft", "schedule")).toBe(false);
    expect(smsCampaignCan("completed", "cancel")).toBe(false);
  });
});

describe("consent", () => {
  const r = (consent: Parameters<typeof mayReceive>[1]["consent"], o: Partial<Parameters<typeof mayReceive>[1]> = {}) => ({ consent, suppressedAll: false, suppressedMarketing: false, ...o });

  it("sends marketing only to customers subscribed to SMS marketing", () => {
    expect(mayReceive("marketing", r("subscribed"), "none")).toEqual({ ok: true });
    expect(mayReceive("marketing", r("not_subscribed"), "checkout_notice")).toEqual({ ok: false, reason: "no_marketing_consent" });
    // A number on an order, or a past purchase, is never consent.
    expect(mayReceive("marketing", r("unknown"), "checkout_notice")).toEqual({ ok: false, reason: "no_marketing_consent" });
    expect(mayReceive("marketing", r("pending"), "none").ok).toBe(false);
    expect(mayReceive("marketing", r("subscribed", { suppressedMarketing: true }), "none")).toEqual({ ok: false, reason: "suppressed" });
  });

  it("sends order updates only on the basis the merchant chose, and never to someone who opted out", () => {
    expect(mayReceive("transactional", r("unknown"), "none")).toEqual({ ok: false, reason: "no_transactional_basis" });
    expect(mayReceive("transactional", r("unknown"), "checkout_notice")).toEqual({ ok: true });
    // Unsubscribing from marketing doesn't stop order updates...
    expect(mayReceive("transactional", r("unsubscribed"), "checkout_notice")).toEqual({ ok: true });
    // ...an opt-out of everything does.
    expect(mayReceive("transactional", r("subscribed", { suppressedAll: true }), "checkout_notice")).toEqual({ ok: false, reason: "suppressed" });
    expect(mayReceive("transactional", r("not_subscribed"), "sms_consent")).toEqual({ ok: false, reason: "no_transactional_basis" });
    expect(mayReceive("transactional", r("redacted"), "checkout_notice")).toEqual({ ok: false, reason: "consent_redacted" });
  });

  it("reads Shopify's consent states and STOP words", () => {
    expect(consentState("SUBSCRIBED")).toBe("subscribed");
    expect(consentState("not_subscribed")).toBe("not_subscribed");
    expect(consentState("whatever")).toBe("unknown");
    expect(consentState(null)).toBe("unknown");
    expect(isSmsStopKeyword(" Stop. ")).toBe(true);
    expect(isSmsStopKeyword("stop sending me deals please")).toBe(false);
  });
});

describe("delivery events", () => {
  it("maps AWS's statuses without taking acceptance for delivery", () => {
    expect(statusFromEvent("DELIVERED", true)).toBe("delivered");
    expect(statusFromEvent("SUCCESSFUL", true)).toBe("carrier_accepted");
    expect(statusFromEvent("SUCCESSFUL", false)).toBe("pending");
    expect(statusFromEvent("PENDING", false)).toBe("pending");
    expect(statusFromEvent("CARRIER_UNREACHABLE", false)).toBe("pending");
    expect(statusFromEvent("CARRIER_UNREACHABLE", true)).toBe("failed");
    expect(statusFromEvent("SPAM", true)).toBe("failed");
    expect(statusFromEvent("TTL_EXPIRED", true)).toBe("failed");
    expect(statusFromEvent("UNKNOWN", true)).toBe("unknown");
    expect(statusFromEvent("SOMETHING_NEW", true)).toBe("unknown");
  });

  it("only moves a status forward, whatever order events arrive in", () => {
    expect(statusMayMove("accepted", "pending", null, 2)).toBe(true);
    expect(statusMayMove("pending", "delivered", 1, 2)).toBe(true);
    expect(statusMayMove("delivered", "pending", 2, 3)).toBe(false);
    expect(statusMayMove("delivered", "failed", 5, 4)).toBe(false);
    expect(statusMayMove("failed", "delivered", 4, 5)).toBe(true);
    // Our own guesses give way to AWS's final word.
    expect(statusMayMove("uncertain", "delivered", null, 1)).toBe(true);
    expect(statusMayMove("unknown", "failed", 9, 1)).toBe(true);
    // Texts never sent don't move.
    expect(statusMayMove("skipped", "delivered", null, 1)).toBe(false);
    expect(statusMayMove("cancelled", "delivered", null, 1)).toBe(false);
  });
});

describe("send errors", () => {
  it("retries only what AWS certainly didn't take", () => {
    expect(classifySendError({ type: "ThrottlingException" }).action).toBe("retry");
    expect(classifySendError({ type: "network", reason: "ENOTFOUND", notSent: true }).action).toBe("retry");
    expect(classifySendError({ type: "ServiceQuotaExceededException", reason: "MONTHLY_SPEND_LIMIT_REACHED_FOR_TEXT" })).toEqual({ action: "hold_account", code: "aws_spend_limit" });
    expect(classifySendError({ type: "ConflictException", reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT" })).toEqual({ action: "opt_out", code: "opted_out" });
    expect(classifySendError({ type: "ValidationException", reason: "INVALID_PHONE_NUMBER" })).toEqual({ action: "fail", code: "invalid_number" });
    expect(classifySendError({ type: "ResourceNotFoundException" }).action).toBe("hold_sender");
  });

  it("never re-sends on its own when AWS may have the text", () => {
    expect(classifySendError({ type: "InternalServerException", status: 500 }).action).toBe("uncertain");
    expect(classifySendError({ type: "timeout" }).action).toBe("uncertain");
    expect(classifySendError({ type: "network", reason: "ECONNRESET", notSent: false }).action).toBe("uncertain");
    expect(classifySendError({ type: "SomethingElse" }).action).toBe("uncertain");
  });

  it("backs off exponentially with jitter, capped at an hour", () => {
    expect(retryDelaySeconds(1, () => 0)).toBe(15);
    expect(retryDelaySeconds(1, () => 1)).toBe(30);
    expect(retryDelaySeconds(3, () => 1)).toBe(120);
    expect(retryDelaySeconds(20, () => 1)).toBe(3600);
    for (let i = 0; i < 20; i++) {
      const d = retryDelaySeconds(4);
      expect(d).toBeGreaterThanOrEqual(120);
      expect(d).toBeLessThanOrEqual(240);
    }
  });
});

describe("budgets and cost", () => {
  it("announces 50, 80 and 100% once each", () => {
    expect(budgetLevelsReached(4, 10, [])).toEqual([]);
    expect(budgetLevelsReached(5, 10, [])).toEqual([50]);
    expect(budgetLevelsReached(8.5, 10, [50])).toEqual([80]);
    expect(budgetLevelsReached(12, 10, [50, 80])).toEqual([100]);
    expect(budgetLevelsReached(12, 10, [50, 80, 100])).toEqual([]);
    expect(budgetLevelsReached(12, 0, [])).toEqual([]);
  });

  it("stops at the budget, and a budget of 0 sends nothing", () => {
    expect(budgetAllows(9.9, 0.1, 10)).toBe(true);
    expect(budgetAllows(9.95, 0.1, 10)).toBe(false);
    expect(budgetAllows(0, 0.01, 0)).toBe(false);
  });

  it("makes no estimate without a known price", () => {
    expect(estimateCostUsd(2, null)).toBeNull();
    expect(estimateCostUsd(0, 0.05)).toBeNull();
    expect(estimateCostUsd(3, 0.0412)).toBeCloseTo(0.1236, 6);
  });
});

describe("quiet hours and time zones", () => {
  it("moves a text due in quiet hours to their end, in the customer's zone", () => {
    // 23:30 in Melbourne (AEDT, +11): quiet 21-9, so 09:00 the next morning.
    const due = new Date("2026-11-10T12:30:00Z");
    expect(afterQuietHours(due, "Australia/Melbourne", 21, 9).toISOString()).toBe("2026-11-10T22:00:00.000Z");
    // 14:00 in Melbourne: goes now.
    const day = new Date("2026-11-10T03:00:00Z");
    expect(afterQuietHours(day, "Australia/Melbourne", 21, 9)).toBe(day);
    // Equal hours: no quiet hours.
    expect(afterQuietHours(due, "Australia/Melbourne", 0, 0)).toBe(due);
  });

  it("knows a customer's zone only where their country has one", () => {
    expect(customerTimeZone("NZ", "Australia/Sydney")).toBe("Pacific/Auckland");
    expect(customerTimeZone("AU", "Australia/Sydney")).toBe("Australia/Sydney");
    expect(customerTimeZone("US", "America/Chicago")).toBe("America/Chicago");
    expect(customerTimeZone("IN", "UTC", false)).toBe("UTC");
  });
});

describe("rules", () => {
  it("fails a condition whose fact the event doesn't have", () => {
    const facts = { orderTotal: 120, country: "AU", productTitles: ["Merino Crew"], tags: ["vip"] };
    expect(evaluateRuleConditions([{ field: "order_total", op: "gte", value: 100 }], facts).pass).toBe(true);
    expect(evaluateRuleConditions([{ field: "country", op: "in", value: ["NZ"] }], facts).pass).toBe(false);
    expect(evaluateRuleConditions([{ field: "product", op: "contains", value: "merino" }], facts).pass).toBe(true);
    expect(evaluateRuleConditions([{ field: "tag", op: "has", value: "VIP" }], facts).pass).toBe(true);
    expect(evaluateRuleConditions([{ field: "customer_orders", op: "gte", value: 2 }], facts).pass).toBe(false);
  });

  it("refuses rules the data can't run, and fills in safe defaults", () => {
    expect(smsRuleSchema.safeParse({ name: "Birthday", trigger: "customer_birthday", templateId: "t1" }).success).toBe(false);
    expect(smsRuleSchema.safeParse({ name: "Win back", trigger: "customer_inactive", templateId: "t1" }).success).toBe(false);
    const ok = smsRuleSchema.parse({ name: "Shipped", trigger: "fulfillment_created", templateId: "t1" });
    expect(ok).toMatchObject({ dryRun: true, delayMinutes: 0, maxPerCustomer: 1, quietStart: 21, quietEnd: 9 });
  });

  it("covers the analytics periods in the store's days", () => {
    expect(smsPeriodRange("today", "2026-10-22")).toEqual({ from: "2026-10-22", to: "2026-10-22" });
    expect(smsPeriodRange("yesterday", "2026-10-22")).toEqual({ from: "2026-10-21", to: "2026-10-21" });
    expect(smsPeriodRange("7d", "2026-10-22")).toEqual({ from: "2026-10-16", to: "2026-10-22" });
    expect(smsPeriodRange("this_month", "2026-10-22")).toEqual({ from: "2026-10-01", to: "2026-10-22" });
    expect(smsPeriodRange("custom", "2026-10-22", { from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(() => smsPeriodRange("custom", "2026-10-22", { from: "2026-10-30", to: "2026-10-01" })).toThrow();
  });
});

describe("sender names (Set up SMS)", () => {
  it("accepts AWS's sender ID shape and says what is wrong with anything else", () => {
    expect(checkSenderName("IKOREX", "AU").problems).toEqual([]);
    expect(checkSenderName("Acme-Shop", "GB").problems).toEqual([]);
    expect(checkSenderName("  ikorex ", "AU").name).toBe("ikorex");
    expect(checkSenderName("", "AU").problems).toEqual(["Enter the name your customers should see."]);
    expect(checkSenderName("ACME SHOP", "AU").problems[0]).toMatch(/can't have spaces: try "ACMESHOP"/);
    expect(checkSenderName("IKÖREX", "AU").problems.join(" ")).toMatch(/only letters, numbers and hyphens/);
    expect(checkSenderName("TWELVECHARSX", "AU").problems.join(" ")).toMatch(/At most 11 characters: this one has 12/);
    expect(checkSenderName("AB", "AU").problems.join(" ")).toMatch(/At least 3 characters/);
    expect(checkSenderName("12345", "AU").problems.join(" ")).toMatch(/at least one letter/);
    expect(checkSenderName("-ACME", "AU").problems.join(" ")).toMatch(/hyphen can't be the first or last/);
    expect(checkSenderName("NOTICE", "AU").problems.join(" ")).toMatch(/doesn't say who you are/);
    // France, since 1 March 2026: no hyphens.
    expect(checkSenderName("Acme-Shop", "FR").problems.join(" ")).toMatch(/France doesn't allow hyphens/);
  });

  it("tells registration countries, free countries and number-only countries apart (AWS's country table)", () => {
    expect(senderIdSupport("AU")).toBe("registered");
    expect(senderIdSupport("GB")).toBe("registered");
    expect(senderIdSupport("DE")).toBe("dynamic");
    expect(senderIdSupport("US")).toBe("none");
    expect(senderIdSupport("ZZ")).toBe("unknown");
    expect(senderIdSupport(null)).toBe("unknown");
    expect(checkSenderName("IKOREX", "AU").customerSees).toBe("IKOREX, once it is registered");
    expect(checkSenderName("IKOREX", "US").customerSees).toMatch(/phone number/);
    expect(checkSenderName("IKOREX", "DE").customerSees).toBe("IKOREX");
  });

  it("is approved only on AWS's word: found, the workspace's, and registered where required", () => {
    expect(senderNameStatus(null, false)).toBe("draft");
    // Asked for, but AWS has nothing yet: never approved for having been asked.
    expect(senderNameStatus(null, true)).toBe("requested");
    expect(senderNameStatus({ mine: false, registration: "COMPLETE" }, true)).toBe("unavailable");
    expect(senderNameStatus({ mine: true, registration: "REQUIRED" }, true)).toBe("pending");
    expect(senderNameStatus({ mine: true, registration: "AWS_REVIEWING" }, true)).toBe("pending");
    expect(senderNameStatus({ mine: true, registration: "REQUIRES_UPDATES" }, true)).toBe("needs_changes");
    expect(senderNameStatus({ mine: true, registration: "COMPLETE" }, true)).toBe("approved");
    // A country that needs no registration.
    expect(senderNameStatus({ mine: true, registration: null }, false)).toBe("approved");
  });

  it("suggests a sender name from the business's", () => {
    expect(suggestSenderName("Ikorex Store")).toBe("IKOREXSTORE");
    expect(suggestSenderName("Café Délice & Co.")).toBe("CAFEDELICEC");
  });
});

describe("the setup's variables and messages", () => {
  it("renders {{business_name}} and {{order_status}}, and fills the order status per event", () => {
    expect(renderSms("Hi {{customer_name}}, your order {{order_number}} has been {{order_status}}. Thank you for shopping with {{business_name}}!", { customer_name: "Sarah", order_number: "#1042", order_status: "confirmed", business_name: "IKOREX" })).toMatchObject({
      ok: true,
      text: "Hi Sarah, your order #1042 has been confirmed. Thank you for shopping with IKOREX!",
    });
    expect(cleanVariable("order_status", "shipped")).toBe("shipped");
    expect(cleanVariable("order_status", "<b>x</b>")).toBeNull();
    expect(ORDER_STATUS_WORD.fulfillment_created).toBe("shipped");
    expect(missingForTrigger("{{business_name}} {{order_status}} {{order_number}}", "order_created")).toEqual([]);
    expect(missingForTrigger("{{tracking_url}}", "order_created")).toEqual(["tracking_url"]);
  });

  it("names the variable an alias meant, and fixes it", () => {
    const issues = checkTemplate({ category: "transactional", body: "Order {{order_id}} from {{business}}" });
    expect(issues.find((i) => i.code === "unknown_variable")?.message).toMatch(/Did you mean \{\{order_number\}\}, \{\{business_name\}\}\?/);
    expect(fixVariableAliases("Order {{order_id}} from {{ Business }} for {{Customer_Name}} {{nope}}")).toBe("Order {{order_number}} from {{business_name}} for {{customer_name}} {{nope}}");
  });

  it("offers only order updates its events can fill, and says why an appointment reminder can't run", () => {
    for (const a of SETUP_AUTOMATIONS.filter((x) => x.trigger)) {
      expect(hasErrors(checkTemplate({ category: "transactional", body: a.body })), a.key).toBe(false);
      expect(missingForTrigger(a.body, a.trigger!), a.key).toEqual([]);
    }
    expect(SETUP_AUTOMATIONS.find((a) => a.key === "appointment_reminder")).toMatchObject({ trigger: null, unavailable: expect.stringMatching(/appointments/) });
  });
});

describe("the automation builder", () => {
  it("has a card for every trigger, and a Shopify source for every trigger it offers", () => {
    for (const t of SMS_TRIGGERS) expect(AUTOMATION_TRIGGER_CARDS.filter((c) => c.trigger === t), t).toHaveLength(1);
    for (const c of AUTOMATION_TRIGGER_CARDS) {
      if (c.unavailable) continue;
      const source = TRIGGER_SOURCES[c.trigger!];
      expect(source && (source.topics.length > 0 || !!source.perStore), c.key).toBe(true);
    }
    expect(AUTOMATION_TRIGGER_CARDS.find((c) => c.key === "custom_event")).toMatchObject({ trigger: null, unavailable: expect.stringMatching(/Shopify's own events/) });
    expect(TRIGGER_INFO.customer_registered).toMatchObject({ category: "marketing", available: true });
    expect(TRIGGER_SOURCES.customer_registered!.perStore).toMatchObject({ topic: "customers/create", scope: "read_customers" });
  });

  it("starts every trigger from ready-made messages that pass its own checks", () => {
    for (const t of SMS_TRIGGERS) {
      if (!TRIGGER_INFO[t].available) continue;
      expect(AUTOMATION_STARTERS[t].length, t).toBeGreaterThan(0);
      for (const s of AUTOMATION_STARTERS[t]) {
        const issues = checkAutomationMessage(s.body, t, "WELCOME10");
        expect(issues.filter((i) => i.level === "error"), `${t}: ${s.name}`).toEqual([]);
        // Every variable it uses is one the editor offers for the trigger.
        expect(templateVariables(s.body).used.every((v) => automationVariables(t).includes(v)), `${t}: ${s.name}`).toBe(true);
      }
    }
  });

  it("says in plain words what a message can't do for its trigger", () => {
    expect(checkAutomationMessage("Order {{order_number}}: {{tracking_url}}", "order_created")).toContainEqual(expect.objectContaining({ level: "error", code: "unsupported_variable", message: expect.stringMatching(/"Order placed" texts have no tracking link/) }));
    expect(checkAutomationMessage("Welcome! {{opt_out_url}}", "customer_registered").some((i) => i.code === "no_opt_out")).toBe(false);
    expect(checkAutomationMessage("Welcome!", "customer_registered").map((i) => i.code)).toContain("no_opt_out");
    expect(checkAutomationMessage("Use {{discount_code}}. Opt out: {{opt_out_url}}", "checkout_abandoned").map((i) => i.code)).toContain("discount_code");
    expect(checkAutomationMessage("Use {{discount_code}}", "order_created").map((i) => i.code)).toContain("promotional_variable");
    expect(checkAutomationMessage("Hi {{customer_name}}, order {{order_number}} shipped: {{tracking_url}}", "fulfillment_created").filter((i) => i.level === "error")).toEqual([]);
  });

  it("checks conditions against what the trigger's event has, and caps order updates per event", () => {
    const base = { name: "A", body: "x", delayMinutes: 0 };
    expect(smsAutomationSchema.safeParse({ ...base, trigger: "refund_issued", conditions: [{ field: "tag", op: "has", value: "vip" }] }).success).toBe(false);
    expect(smsAutomationSchema.safeParse({ ...base, trigger: "order_created", conditions: [{ field: "tag", op: "has", value: "vip" }] }).success).toBe(true);
    expect(smsAutomationSchema.safeParse({ ...base, trigger: "customer_birthday" }).success).toBe(false);
    expect(smsAutomationSchema.safeParse({ ...base, trigger: "customer_inactive" }).success).toBe(false);
    expect(TRIGGER_CONDITION_FIELDS.customer_registered).toEqual(["country"]);
    const order = automationRule(smsAutomationSchema.parse({ ...base, trigger: "order_created" }), "tpl1");
    expect(order).toMatchObject({ templateId: "tpl1", maxPerCustomer: 10, capDays: 1, dryRun: false, quietStart: 21, quietEnd: 9 });
    const cart = automationRule(smsAutomationSchema.parse({ ...base, trigger: "checkout_abandoned", delayMinutes: 60, maxPerCustomer: 2 }), "tpl2");
    expect(cart).toMatchObject({ maxPerCustomer: 2, capDays: 30, delayMinutes: 60 });
  });
});
