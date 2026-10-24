import { describe, expect, it } from "vitest";
import {
  acceptanceRate,
  channelRuns,
  checkEmailMessage,
  deliveryRate,
  emailCategoryOf,
  emailEventFor,
  emailHubStatus,
  EMAIL_STATUSES_FOR,
  hubActionsFor,
  hubEmailAutomationSchema,
  hubTriggerOfEmail,
  hubTriggerOfSms,
  HUB_STATUSES,
  HUB_TRIGGER_INFO,
  HUB_TRIGGERS,
  smsHubStatus,
  smsHubStatusOf,
  SMS_STATUSES_FOR,
  textToEmailHtml,
  triggerCategory,
  zeroCounts,
} from "../src/automations";
import { MESSAGE_STATUSES, SHOPIFY_EVENT_TYPES } from "../src/email";
import { SMS_STATUSES, SMS_TRIGGERS, TRIGGER_INFO } from "../src/sms";

describe("the hub's triggers", () => {
  it("names every channel trigger once, and only real ones", () => {
    const sms = HUB_TRIGGERS.map((t) => HUB_TRIGGER_INFO[t].sms).filter(Boolean);
    expect(new Set(sms).size).toBe(sms.length);
    for (const t of sms) expect(SMS_TRIGGERS).toContain(t);
    const email = HUB_TRIGGERS.map((t) => HUB_TRIGGER_INFO[t].email).filter((e) => e && e !== "custom");
    expect(new Set(email).size).toBe(email.length);
    for (const e of email) expect(SHOPIFY_EVENT_TYPES).toContain(e);
    // Every Shopify event an email automation can use has a card.
    for (const e of SHOPIFY_EVENT_TYPES) expect(hubTriggerOfEmail(e), e).not.toBeNull();
    // Every SMS trigger that runs has a card (birthday has no event at all).
    for (const t of SMS_TRIGGERS) if (TRIGGER_INFO[t].available) expect(hubTriggerOfSms(t), t).not.toBeNull();
    expect(hubTriggerOfEmail("appointment.booked")).toBe("external_event");
    expect(hubTriggerOfEmail("order.lost")).toBeNull();
  });

  it("says why a channel can't run a trigger, in words", () => {
    expect(channelRuns("order_created", "sms")).toEqual({ ok: true });
    expect(channelRuns("customer_signup", "email")).toMatchObject({ ok: false, reason: expect.stringMatching(/new-customer/) });
    expect(channelRuns("inbound_message", "sms")).toMatchObject({ ok: false, reason: expect.stringMatching(/STOP/) });
    expect(channelRuns("scheduled_message", "sms")).toMatchObject({ ok: false, reason: expect.stringMatching(/campaign/) });
    expect(channelRuns("order_created", "whatsapp")).toMatchObject({ ok: false });
    expect(triggerCategory("checkout_abandoned", "sms")).toBe("marketing");
    expect(triggerCategory("order_created", "email")).toBe("transactional");
    expect(triggerCategory("external_event", "email")).toBe("either");
  });
});

describe("one status scale", () => {
  it("places every channel status, and never calls an accepted message delivered", () => {
    for (const s of SMS_STATUSES) expect(HUB_STATUSES).toContain(smsHubStatus(s));
    for (const s of MESSAGE_STATUSES) expect(HUB_STATUSES).toContain(emailHubStatus(s));
    expect(smsHubStatus("accepted")).toBe("sent");
    expect(smsHubStatus("carrier_accepted")).toBe("sent");
    expect(emailHubStatus("accepted_by_provider")).toBe("sent");
    expect(smsHubStatus("delivered")).toBe("delivered");
    expect(smsHubStatus("uncertain")).toBe("unknown");
    expect(smsHubStatus("dry_run")).toBe("test_only");
    expect(emailHubStatus("deferred")).toBe("queued");
    expect(emailHubStatus("bounced")).toBe("undelivered");
  });

  it("tells a carrier's refusal from a failure to send", () => {
    expect(smsHubStatusOf({ status: "failed", acceptedAt: null })).toBe("failed");
    expect(smsHubStatusOf({ status: "failed", acceptedAt: new Date() })).toBe("undelivered");
  });

  it("filters each table by the statuses behind a hub status", () => {
    for (const s of HUB_STATUSES) {
      for (const x of SMS_STATUSES_FOR[s]) expect(smsHubStatus(x) === s || (s === "undelivered" && x === "failed")).toBe(true);
      for (const x of EMAIL_STATUSES_FOR[s]) expect(emailHubStatus(x)).toBe(s);
    }
  });

  it("rates delivery only from delivery reports", () => {
    const c = zeroCounts();
    expect(deliveryRate(c)).toBeNull();
    c.sent = 10;
    expect(deliveryRate(c)).toBeNull();
    expect(acceptanceRate(c)).toBe(1);
    c.delivered = 3;
    c.undelivered = 1;
    c.failed = 6;
    expect(deliveryRate(c)).toBe(0.75);
    expect(acceptanceRate(c)).toBe(0.7);
  });
});

describe("controls", () => {
  it("offers only the moves an automation's status allows", () => {
    expect(hubActionsFor("sms", "draft")).toEqual(["activate"]);
    expect(hubActionsFor("sms", "active")).toEqual(["pause", "disable"]);
    expect(hubActionsFor("sms", "paused")).toEqual(["resume", "disable"]);
    expect(hubActionsFor("email", "active")).toEqual(["pause"]);
    expect(hubActionsFor("email", "paused")).toEqual(["resume"]);
    expect(hubActionsFor("whatsapp", "active")).toEqual([]);
  });
});

describe("email written in the hub", () => {
  it("turns plain text into safe HTML and keeps placeholders as written", () => {
    expect(textToEmailHtml('Hi {{customer.first_name | default: "there"}},\n\nYour <order> & more\nline two')).toBe('<p>Hi {{customer.first_name | default: "there"}},</p>\n<p>Your &lt;order&gt; &amp; more<br>line two</p>');
    expect(textToEmailHtml("\r\n\r\n")).toBe("");
  });

  it("checks the message against its event, and says what is wrong", () => {
    expect(checkEmailMessage({ subject: "Order {{order.id}}", text: "Hi {{customer.first_name}}" }, "order.paid", "transactional")).toEqual([]);
    const bad = checkEmailMessage({ subject: "", text: "Track {{order.tracking}} {{ broken" }, "order.paid", "transactional");
    expect(bad.map((i) => i.code)).toEqual(expect.arrayContaining(["subject_missing", "unsupported_variable", "broken_variable"]));
    const marketing = checkEmailMessage({ subject: "Come back", text: "Your cart: {{checkout.recovery_url}}" }, "checkout.abandoned", "marketing");
    expect(marketing).toEqual([expect.objectContaining({ level: "warning", code: "unsubscribe_footer" })]);
  });

  it("validates an automation, its own event name and its category", () => {
    const base = { name: "Thanks", trigger: "payment_confirmed", senderIdentityId: "s1", subject: "x", text: "y" };
    expect(hubEmailAutomationSchema.safeParse(base).success).toBe(true);
    expect(hubEmailAutomationSchema.safeParse({ ...base, trigger: "customer_signup" }).success).toBe(false);
    expect(hubEmailAutomationSchema.safeParse({ ...base, trigger: "external_event" }).success).toBe(false);
    expect(hubEmailAutomationSchema.safeParse({ ...base, trigger: "external_event", customEvent: "order.lost" }).success).toBe(false);
    const custom = hubEmailAutomationSchema.parse({ ...base, trigger: "external_event", customEvent: "appointment.booked", category: "marketing" });
    expect(emailEventFor(custom.trigger, custom.customEvent)).toBe("appointment.booked");
    expect(emailCategoryOf(custom)).toBe("marketing");
    // A Shopify trigger's category is fixed, whatever was sent.
    expect(emailCategoryOf({ trigger: "checkout_abandoned", category: "transactional" })).toBe("marketing");
  });
});
