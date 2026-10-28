import { describe, expect, it } from "vitest";
import {
  cleanValue,
  evaluateWaConditions,
  messageStatusFromProvider,
  parseEmbeddedSignupMessage,
  providerLabel,
  renderWaText,
  statusAfterReport,
  statusBucket,
  variablesIn,
  waAutomationSchema,
  waConsentProblem,
  waHasErrors,
  waIsStart,
  waIsStop,
  WaMissingValueError,
  waSendSchema,
  waSetupProgress,
  waTemplateIssues,
  WA_STARTER_TEMPLATES,
  type WaFacts,
} from "../src/whatsapp";

describe("message statuses", () => {
  it("maps Meta's words (and the last QR-linked phones' Baileys words), and says nothing of what it doesn't know", () => {
    expect(messageStatusFromProvider("accepted")).toBe("accepted");
    expect(messageStatusFromProvider("held_for_quality_assessment")).toBe("accepted");
    expect(messageStatusFromProvider("sent")).toBe("sent");
    expect(messageStatusFromProvider("read")).toBe("read");
    expect(messageStatusFromProvider("PENDING")).toBe("accepted");
    expect(messageStatusFromProvider("SERVER_ACK")).toBe("sent");
    expect(messageStatusFromProvider("DELIVERY_ACK")).toBe("delivered");
    expect(messageStatusFromProvider("READ")).toBe("read");
    expect(messageStatusFromProvider("PLAYED")).toBe("read");
    expect(messageStatusFromProvider("ERROR")).toBe("failed");
    expect(messageStatusFromProvider("delivered")).toBe("delivered");
    expect(messageStatusFromProvider("failed")).toBe("failed");
    expect(messageStatusFromProvider("DELETED")).toBeNull();
    expect(messageStatusFromProvider(null)).toBeNull();
  });

  it("only moves forward, whatever order the reports arrive in", () => {
    expect(statusAfterReport("accepted", "sent")).toBe("sent");
    expect(statusAfterReport("sent", "delivered")).toBe("delivered");
    expect(statusAfterReport("accepted", "read")).toBe("read");
    // Late or repeated reports change nothing.
    expect(statusAfterReport("read", "delivered")).toBeNull();
    expect(statusAfterReport("delivered", "sent")).toBeNull();
    expect(statusAfterReport("delivered", "delivered")).toBeNull();
    // A failure can't follow a delivery; a delivery after a failure report wins (the report was wrong).
    expect(statusAfterReport("delivered", "failed")).toBeNull();
    expect(statusAfterReport("sent", "failed")).toBe("failed");
    expect(statusAfterReport("failed", "delivered")).toBe("delivered");
    // Messages that never went out stay as they are.
    expect(statusAfterReport("skipped", "sent")).toBeNull();
    expect(statusAfterReport("cancelled", "delivered")).toBeNull();
  });

  it("groups statuses for the statistics without counting a send as a delivery", () => {
    expect(statusBucket("accepted")).toBe("sent");
    expect(statusBucket("sent")).toBe("sent");
    expect(statusBucket("delivered")).toBe("delivered");
    expect(statusBucket("queued")).toBe("waiting");
    expect(statusBucket("skipped")).toBe("not_sent");
  });
});

describe("connection providers", () => {
  it("names the one way to connect, and a retired QR link for its history only", () => {
    expect(providerLabel("cloud_api")).toBe("WhatsApp Business Platform (Meta)");
    expect(providerLabel("qr")).toMatch(/retired/);
    expect(providerLabel(null)).toBe("Not connected");
  });
});

describe("templates", () => {
  it("lists variables, renders values as text (never as more variables), and refuses a missing one", () => {
    expect(variablesIn("Hi {{customer_first_name}}, order {{ order_number }}; {{customer_first_name}}")).toEqual(["customer_first_name", "order_number"]);
    const text = renderWaText("Hi {{customer_first_name}}, your order {{order_number}} is confirmed.", { customer_first_name: "{{order_number}}", order_number: "#1042" });
    expect(text).toBe("Hi {{order_number}}, your order #1042 is confirmed.");
    expect(() => renderWaText("Hi {{customer_first_name}}", {})).toThrow(WaMissingValueError);
    expect(renderWaText("Hi {{customer_first_name}}!", {}, { lenient: true })).toBe("Hi !");
  });

  it("cleans values: one line, no control characters, a length cap", () => {
    expect(cleanValue("  Sam\n\t\u0000 Lee  ")).toBe("Sam Lee");
    expect(cleanValue("x".repeat(300)).length).toBe(200);
  });

  it("refuses unknown variables and marketing without a way to stop, warns about link shorteners", () => {
    expect(waHasErrors(waTemplateIssues({ category: "transactional", body: "Hi {{first_name}}" }))).toBe(true);
    expect(waHasErrors(waTemplateIssues({ category: "marketing", body: "Big sale today!" }))).toBe(true);
    expect(waHasErrors(waTemplateIssues({ category: "marketing", body: "Big sale today! Reply STOP to unsubscribe." }))).toBe(false);
    expect(waTemplateIssues({ category: "transactional", body: "Track it: https://bit.ly/x" }).map((i) => i.level)).toEqual(["warning"]);
    expect(waHasErrors(waTemplateIssues({ category: "transactional", body: "Hi {customer_first_name}}" }))).toBe(true);
  });

  it("ships starters that pass their own checks", () => {
    for (const t of WA_STARTER_TEMPLATES) expect(waHasErrors(waTemplateIssues(t)), t.key).toBe(false);
  });
});

describe("consent", () => {
  const facts = { optedOut: false, optedIn: false, marketing: "unknown" as const, suppressed: false };
  it("stops everything for an opt-out or the do-not-message list", () => {
    expect(waConsentProblem("transactional", { ...facts, optedOut: true }, { orderUpdates: "checkout_notice", marketingEnabled: true })).toBe("opted_out");
    expect(waConsentProblem("transactional", { ...facts, suppressed: true }, { orderUpdates: "checkout_notice", marketingEnabled: true })).toBe("suppressed");
  });

  it("sends order updates only under the store's chosen basis", () => {
    expect(waConsentProblem("transactional", facts, { orderUpdates: "unset", marketingEnabled: false })).toBe("consent_basis_unset");
    expect(waConsentProblem("transactional", facts, { orderUpdates: "opt_in_only", marketingEnabled: false })).toBe("no_consent");
    expect(waConsentProblem("transactional", { ...facts, optedIn: true }, { orderUpdates: "opt_in_only", marketingEnabled: false })).toBeNull();
    expect(waConsentProblem("transactional", facts, { orderUpdates: "checkout_notice", marketingEnabled: false })).toBeNull();
  });

  it("sends marketing only with marketing switched on and the customer's own yes", () => {
    expect(waConsentProblem("marketing", { ...facts, marketing: "opted_in" }, { orderUpdates: "checkout_notice", marketingEnabled: false })).toBe("marketing_off");
    expect(waConsentProblem("marketing", facts, { orderUpdates: "checkout_notice", marketingEnabled: true })).toBe("no_marketing_consent");
    expect(waConsentProblem("marketing", { ...facts, marketing: "opted_in" }, { orderUpdates: "unset", marketingEnabled: true })).toBeNull();
  });

  it("hears STOP and START however they are typed", () => {
    for (const s of ["STOP", "stop", " Stop! ", "unsubscribe", "Opt out"]) expect(waIsStop(s), s).toBe(true);
    for (const s of ["START", "start", "Subscribe"]) expect(waIsStart(s), s).toBe(true);
    for (const s of ["please don't stop", "stopped", "", null]) expect(waIsStop(s)).toBe(false);
  });
});

describe("automations", () => {
  const facts: WaFacts = { orderTotal: 80, country: "AU", productTitles: ["Linen shirt"], customerType: "returning", tags: ["vip"], messageText: null };
  it("evaluates conditions and says which failed", () => {
    expect(evaluateWaConditions([{ field: "order_total", op: "gte", value: 50 }, { field: "country", op: "in", value: ["AU", "NZ"] }], facts).pass).toBe(true);
    const r = evaluateWaConditions([{ field: "order_total", op: "lte", value: 50 }, { field: "product", op: "contains", value: "SHIRT" }], facts);
    expect(r.pass).toBe(false);
    expect(r.failed).toEqual(["Order total at most 50"]);
    // A fact the event didn't carry never matches.
    expect(evaluateWaConditions([{ field: "order_total", op: "gte", value: 0 }], { ...facts, orderTotal: null }).pass).toBe(false);
  });

  it("starts every automation in test mode and refuses conditions its trigger can't answer", () => {
    const a = waAutomationSchema.parse({ name: "Thanks", trigger: "order_created", templateId: "t1" });
    expect(a.testMode).toBe(true);
    expect(a.recipient).toBe("customer");
    expect(() => waAutomationSchema.parse({ name: "x", trigger: "customer_created", templateId: "t1", conditions: [{ field: "order_total", op: "gte", value: 1 }] })).toThrow();
    expect(() => waAutomationSchema.parse({ name: "x", trigger: "order_created", templateId: "t1", cooldownMinutes: 60 })).toThrow();
  });
});

describe("sending from the dashboard", () => {
  it("needs something to send and an idempotency key", () => {
    expect(() => waSendSchema.parse({ phone: "+61412345678", reason: "reply", idempotencyKey: "k-1234567" })).toThrow();
    expect(() => waSendSchema.parse({ phone: "+61412345678", reason: "reply", text: "Hi" })).toThrow();
    expect(waSendSchema.parse({ phone: "+61412345678", reason: "reply", text: "Hi", idempotencyKey: "k-1234567" }).customerAsked).toBe(false);
    expect(() => waSendSchema.parse({ phone: "+61412345678", reason: "reply", idempotencyKey: "k-1234567", attachment: { name: "a.exe", mime: "application/x-msdownload", data: "AA==" } })).toThrow();
  });
});

describe("the four-step setup", () => {
  it("is done step by step, and only with a verified number and a test WhatsApp reported", () => {
    const base = { provider: null, status: null, configuredAt: null, orderUpdates: "unset" as const, testVerifiedAt: null, testPassedAt: null };
    expect(waSetupProgress(base).current).toBe("connect");
    expect(waSetupProgress({ ...base, provider: "qr", status: "pairing" }).current).toBe("authorize");
    expect(waSetupProgress({ ...base, provider: "qr", status: "connected" }).current).toBe("configure");
    expect(waSetupProgress({ ...base, provider: "qr", status: "connected", configuredAt: new Date(), orderUpdates: "opt_in_only" }).current).toBe("test");
    expect(waSetupProgress({ ...base, provider: "qr", status: "connected", configuredAt: new Date(), orderUpdates: "opt_in_only", testVerifiedAt: new Date() }).current).toBe("test");
    expect(waSetupProgress({ provider: "qr", status: "connected", configuredAt: new Date(), orderUpdates: "opt_in_only", testVerifiedAt: new Date(), testPassedAt: new Date() }).current).toBeNull();
  });
});

describe("Meta's Embedded Signup window", () => {
  it("reads the finish, cancel and error messages Meta posts, and nothing else", () => {
    expect(parseEmbeddedSignupMessage(JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "123456", waba_id: "654321", business_id: "999000" } }))).toEqual({
      type: "finish",
      flow: "cloud_api",
      phoneNumberId: "123456",
      wabaId: "654321",
      businessId: "999000",
    });
    expect(parseEmbeddedSignupMessage({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } })).toEqual({ type: "cancel", step: "PHONE_NUMBER_SETUP" });
    expect(parseEmbeddedSignupMessage({ type: "something_else" })).toBeNull();
    expect(parseEmbeddedSignupMessage("not json")).toBeNull();
  });
});
