import { describe, expect, it } from "vitest";
import {
  buildSendComponents,
  campaignCan,
  checkTemplateDraft,
  classifyMetaError,
  consentProblem,
  describeAudience,
  evaluateWorkflowConditions,
  hasErrors,
  isStartKeyword,
  isStopKeyword,
  isStopPromotionsReply,
  metaErrorExplanation,
  missingValues,
  MissingValueError,
  parseEmbeddedSignupMessage,
  renderTemplate,
  STARTER_TEMPLATES,
  statusAfterEvent,
  statusBucket,
  templateDraftSchema,
  templateShape,
  tierLimit,
  toMetaComponents,
  workflowSchema,
  type TemplateComponent,
  type WorkflowFacts,
} from "../src/whatsapp";
import { maskPhone, nextSendTime, normalizePhone } from "../src/messaging";

const draft = (over: Record<string, unknown> = {}) =>
  templateDraftSchema.parse({ name: "Order Confirmation!", language: "en", category: "UTILITY", header: { type: "none" }, body: "Hi {{1}}, your order {{2}} is confirmed. Thank you!", bodyExamples: ["Priya", "#1042"], ...over });

describe("templates", () => {
  it("normalises the name the way Meta wants it", () => {
    expect(draft().name).toBe("order_confirmation");
  });

  it("accepts every starter template as written", () => {
    for (const s of STARTER_TEMPLATES) {
      const d = templateDraftSchema.parse(s.draft);
      expect(hasErrors(checkTemplateDraft(d)), s.key).toBe(false);
      expect(s.mapping.body.length, s.key).toBe(templateShape(toMetaComponents(d) as unknown as TemplateComponent[]).bodyVars);
    }
  });

  it("refuses what Meta refuses", () => {
    const codes = (d: ReturnType<typeof draft>) => checkTemplateDraft(d).filter((i) => i.level === "error").map((i) => i.code);
    expect(codes(draft({ body: "Hi {{1}} and {{3}} welcome to the shop", bodyExamples: ["a", "b", "c"] }))).toContain("variables_gap");
    expect(codes(draft({ body: "{{1}} your order is ready for pickup today", bodyExamples: ["a"] }))).toContain("variable_at_edge");
    expect(codes(draft({ body: "Your order is ready for pickup {{1}}", bodyExamples: ["a"] }))).toContain("variable_at_edge");
    expect(codes(draft({ body: "Hello there {{1}} {{2}} and welcome back", bodyExamples: ["a", "b"] }))).toContain("adjacent_variables");
    expect(codes(draft({ bodyExamples: ["Priya"] }))).toContain("examples_missing");
    expect(codes(draft({ body: "Hi {{1}}, {{2}}, ok {{3}}!", bodyExamples: ["a", "b", "c"] }))).toContain("too_many_variables");
    expect(codes(draft({ footer: "Reply {{1}}" }))).toContain("footer_variables");
    expect(codes(draft({ buttons: [{ type: "url", text: "Track", url: "https://x.example/{{1}}/track" }] }))).toContain("button_url_variable");
  });

  it("warns about marketing without a way out, and offers in utility templates", () => {
    const m = checkTemplateDraft(draft({ category: "MARKETING" }));
    expect(m.find((i) => i.code === "no_opt_out")?.level).toBe("warning");
    expect(checkTemplateDraft(draft({ category: "MARKETING", buttons: [{ type: "quick_reply", text: "Stop promotions" }] })).some((i) => i.code === "no_opt_out")).toBe(false);
    expect(checkTemplateDraft(draft({ body: "Hi {{1}}, get 20% off your next order {{2}} today!" })).some((i) => i.code === "marketing_words")).toBe(true);
  });

  it("builds Meta's create call with examples", () => {
    const comps = toMetaComponents(draft({ header: { type: "text", text: "Order {{1}}", example: "#1042" }, footer: "Reply STOP", buttons: [{ type: "url", text: "Track", url: "https://x.example/t/{{1}}", example: "https://x.example/t/abc" }] }));
    expect(comps).toEqual([
      { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["#1042"] } },
      { type: "BODY", text: "Hi {{1}}, your order {{2}} is confirmed. Thank you!", example: { body_text: [["Priya", "#1042"]] } },
      { type: "FOOTER", text: "Reply STOP" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://x.example/t/{{1}}", example: ["https://x.example/t/abc"] }] },
    ]);
  });
});

describe("sending a template", () => {
  const components: TemplateComponent[] = [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Hi {{1}}, order {{2}} shipped with {{3}}." },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://t.example/{{1}}" }] },
  ];
  const shape = templateShape(components);
  const mapping = { body: [{ source: "customer_first_name" as const }, { source: "order_number" as const }, { source: "custom_text" as const, text: "Australia Post" }], buttons: [{ source: "tracking_number" as const }] };

  it("fills every variable, the media header and the link button", () => {
    expect(buildSendComponents(shape, mapping, { customer_first_name: "Priya", order_number: "#1042", tracking_number: "LX1" }, "https://cdn.example/a.jpg")).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example/a.jpg" } }] },
      { type: "body", parameters: [{ type: "text", text: "Priya" }, { type: "text", text: "#1042" }, { type: "text", text: "Australia Post" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "LX1" }] },
    ]);
  });

  it("says hello to a customer without a name rather than sending nothing", () => {
    expect(missingValues(shape, mapping, { order_number: "#1", tracking_number: "x" })).toEqual([]);
  });

  it("refuses to send with a value missing (Meta would refuse the whole message)", () => {
    expect(() => buildSendComponents(shape, mapping, { order_number: "#1042" }, "https://cdn.example/a.jpg")).toThrow(MissingValueError);
    expect(() => buildSendComponents(shape, mapping, { order_number: "#1042", tracking_number: "LX1" }, null)).toThrow(/image/);
  });

  it("cleans values Meta refuses (newlines, long runs of spaces)", () => {
    const [, body] = buildSendComponents(shape, { ...mapping, body: [{ source: "custom_text", text: "a\nb      c" }, ...mapping.body.slice(1)] }, { order_number: "1", tracking_number: "2" }, "https://x.example/i.png") as Array<{ parameters: Array<{ text: string }> }>;
    expect(body!.parameters[0]!.text).toBe("a b   c");
  });

  it("renders the preview the customer will read", () => {
    expect(renderTemplate(components, mapping, { customer_first_name: "Priya", order_number: "#9" }).body).toBe("Hi Priya, order #9 shipped with Australia Post.");
    expect(renderTemplate(components, mapping, null).body).toBe("Hi Priya, order #1042 shipped with Australia Post.");
  });
});

describe("consent", () => {
  const none = { optedOut: false, optedIn: false, marketing: "unknown" as const };
  it("sends nothing after STOP", () => {
    expect(consentProblem("UTILITY", { ...none, optedOut: true, optedIn: true }, { orderUpdates: "checkout_notice" })).toBe("opted_out");
    expect(consentProblem("MARKETING", { optedOut: true, optedIn: true, marketing: "opted_in" }, { orderUpdates: "checkout_notice" })).toBe("opted_out");
  });
  it("sends marketing only to customers who opted in to it", () => {
    expect(consentProblem("MARKETING", none, { orderUpdates: "checkout_notice" })).toBe("no_marketing_consent");
    expect(consentProblem("MARKETING", { ...none, marketing: "opted_out", optedIn: true }, { orderUpdates: "checkout_notice" })).toBe("no_marketing_consent");
    expect(consentProblem("MARKETING", { ...none, marketing: "opted_in", optedIn: true }, { orderUpdates: "unset" })).toBeNull();
  });
  it("sends order updates by the store's chosen basis, and to anyone who opted in", () => {
    expect(consentProblem("UTILITY", none, { orderUpdates: "unset" })).toBe("no_order_update_consent");
    expect(consentProblem("UTILITY", none, { orderUpdates: "opt_in_only" })).toBe("no_order_update_consent");
    expect(consentProblem("UTILITY", none, { orderUpdates: "checkout_notice" })).toBeNull();
    // "Stop promotions" leaves order updates on.
    expect(consentProblem("UTILITY", { optedOut: false, optedIn: true, marketing: "opted_out" }, { orderUpdates: "opt_in_only" })).toBeNull();
  });
  it("never sends authentication templates from here", () => {
    expect(consentProblem("AUTHENTICATION", { optedOut: false, optedIn: true, marketing: "opted_in" }, { orderUpdates: "checkout_notice" })).toBe("template_not_allowed");
  });
  it("reads STOP, START and Stop promotions, but not an order's 'cancel'", () => {
    expect(isStopKeyword(" Stop. ")).toBe(true);
    expect(isStopKeyword("unsubscribe")).toBe(true);
    expect(isStopKeyword("cancel")).toBe(false);
    expect(isStopKeyword("please stop sending")).toBe(false);
    expect(isStartKeyword("START")).toBe(true);
    expect(isStopPromotionsReply("Stop promotions")).toBe(true);
    expect(isStopKeyword("Stop promotions")).toBe(false);
  });
});

describe("statuses", () => {
  it("only moves a message forward, whatever order Meta's reports arrive in", () => {
    expect(statusAfterEvent("accepted", "sent")).toBe("sent");
    expect(statusAfterEvent("accepted", "delivered")).toBe("delivered");
    expect(statusAfterEvent("delivered", "sent")).toBeNull();
    expect(statusAfterEvent("read", "delivered")).toBeNull();
    expect(statusAfterEvent("sent", "failed")).toBe("failed");
    expect(statusAfterEvent("delivered", "failed")).toBeNull();
    // Delivered after a failure report is a fact: it wins.
    expect(statusAfterEvent("failed", "delivered")).toBe("delivered");
    expect(statusAfterEvent("failed", "sent")).toBeNull();
    expect(statusAfterEvent("cancelled", "sent")).toBeNull();
  });
  it("buckets statuses for the overview", () => {
    expect(["queued", "sending", "accepted", "sent", "delivered", "read", "failed", "skipped"].map(statusBucket)).toEqual(["pending", "pending", "sent", "sent", "delivered", "delivered", "failed", "other"]);
  });
});

describe("Meta's errors", () => {
  it("sorts what to do", () => {
    expect(classifyMetaError(190, 401)).toBe("reconnect");
    expect(classifyMetaError(130429, 400)).toBe("retry");
    expect(classifyMetaError(131050, 400)).toBe("marketing_opt_out");
    expect(classifyMetaError(133010, 400)).toBe("account");
    expect(classifyMetaError(131026, 400)).toBe("fail");
    expect(classifyMetaError(null, 503)).toBe("retry");
    expect(classifyMetaError(null, 400)).toBe("fail");
  });
  it("explains them in plain words", () => {
    expect(metaErrorExplanation(131047)).toMatch(/24 hours/);
    expect(metaErrorExplanation(999999, "Something odd")).toBe("Something odd");
  });
  it("knows Meta's messaging limit tiers", () => {
    expect(tierLimit("TIER_250")).toBe(250);
    expect(tierLimit("TIER_1K")).toBe(1000);
    expect(tierLimit("TIER_100K")).toBe(100000);
    expect(tierLimit("TIER_UNLIMITED")).toBeNull();
    expect(tierLimit(null)).toBe(250);
  });
});

describe("Embedded Signup's window messages", () => {
  it("reads a finish with its ids", () => {
    expect(parseEmbeddedSignupMessage(JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "1061", waba_id: "2072", business_id: "3083" } }))).toEqual({
      type: "finish",
      flow: "cloud_api",
      phoneNumberId: "1061",
      wabaId: "2072",
      businessId: "3083",
    });
    expect(parseEmbeddedSignupMessage({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: "2072" } })).toMatchObject({ flow: "business_app", phoneNumberId: null });
  });
  it("reads a cancel and an error, and ignores everything else", () => {
    expect(parseEmbeddedSignupMessage({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_VERIFICATION" } })).toEqual({ type: "cancel", step: "PHONE_NUMBER_VERIFICATION" });
    expect(parseEmbeddedSignupMessage({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { error_message: "Business blocked", error_code: "524126", session_id: "s1" } })).toMatchObject({ type: "error", message: "Business blocked" });
    expect(parseEmbeddedSignupMessage({ type: "OTHER" })).toBeNull();
    expect(parseEmbeddedSignupMessage("not json")).toBeNull();
    // An id that isn't Meta's numeric id is dropped.
    expect(parseEmbeddedSignupMessage({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "../x" } })).toMatchObject({ wabaId: null });
  });
});

describe("workflows", () => {
  const facts: WorkflowFacts = { orderTotal: 80, country: "AU", productTitles: ["Cardamom 200g"], customerType: "returning", tags: ["vip"], paymentMethods: ["Cash on Delivery (COD)"] };
  it("passes only when every condition holds", () => {
    expect(evaluateWorkflowConditions([{ field: "order_total", op: "gte", value: 50 }, { field: "country", op: "in", value: ["AU", "NZ"] }], facts).pass).toBe(true);
    const r = evaluateWorkflowConditions([{ field: "order_total", op: "gte", value: 100 }, { field: "order_tag", op: "has", value: "VIP" }, { field: "payment_method", op: "contains", value: "cod" }], facts);
    expect(r.pass).toBe(false);
    expect(r.failed).toEqual(["Order total is at least 100"]);
  });
  it("fails a condition on an unknown fact", () => {
    expect(evaluateWorkflowConditions([{ field: "customer_type", op: "is", value: "new" }], { ...facts, customerType: null }).pass).toBe(false);
  });
  it("checks a workflow is coherent", () => {
    const base = { name: "x", template: { name: "t", language: "en" }, mapping: { body: [{ source: "customer_first_name" }] } };
    expect(workflowSchema.safeParse({ ...base, trigger: "order_created" }).success).toBe(true);
    expect(workflowSchema.safeParse({ ...base, trigger: "custom_event" }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...base, trigger: "order_created", timing: { mode: "before_event", minutes: 60 } }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...base, trigger: "checkout_abandoned", timing: { mode: "after_trigger", minutes: 5 } }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...base, trigger: "customer_created", mapping: { body: [{ source: "tracking_number" }] } }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...base, trigger: "customer_created", conditions: [{ field: "order_total", op: "gte", value: 5 }] }).success).toBe(false);
  });
});

describe("campaigns", () => {
  it("says who an audience is", () => {
    expect(describeAudience({ countries: ["AU"], customerType: "returning", notOrderedForDays: 60 })).toBe("Customers who agreed to WhatsApp marketing who ordered more than once, who haven't ordered for 60 days, in AU");
  });
  it("allows each action only from the right status", () => {
    expect(campaignCan("draft", "schedule")).toBe(true);
    expect(campaignCan("sending", "schedule")).toBe(false);
    expect(campaignCan("sending", "cancel")).toBe(true);
    expect(campaignCan("completed", "cancel")).toBe(false);
    expect(campaignCan("scheduled", "delete")).toBe(false);
  });
});

describe("phone numbers and sending hours (shared with SMS)", () => {
  it("reads local and international numbers", () => {
    expect(normalizePhone("0412 345 678", "AU")?.e164).toBe("+61412345678");
    expect(normalizePhone("+91 98765 43210", null)?.country).toBe("IN");
    expect(normalizePhone("0412 345 678", null)).toBeNull();
    expect(maskPhone("+61412345678")).toBe("+61 •••••• 678");
  });
  it("waits for the next sending hour", () => {
    const at = new Date("2026-10-25T12:00:00Z"); // 23:00 in Melbourne
    expect(nextSendTime(at, "Australia/Melbourne", 9, 20).toISOString()).toBe("2026-10-25T22:00:00.000Z");
  });
});
