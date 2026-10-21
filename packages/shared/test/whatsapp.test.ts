import { describe, expect, it } from "vitest";
import {
  buildComponents,
  campaignCan,
  campaignEditable,
  campaignStatusAfter,
  classifyGraphError,
  cleanParam,
  evaluateConditions,
  inSendWindow,
  isStartKeyword,
  isStopKeyword,
  isStopPromotionsReply,
  kindSetting,
  kindsOf,
  maskPhone,
  messageKinds,
  nextSendTime,
  normalizePhone,
  previewText,
  ruleConflicts,
  shipmentStage,
  signMetaBody,
  TEMPLATE_LIBRARY,
  templateShape,
  verifyMetaSignature,
  whatsappConfigSchema,
  type RuleLike,
} from "../src/index.js";

describe("normalizePhone", () => {
  it("keeps international numbers, whatever the spacing", () => {
    expect(normalizePhone("+61 412 345 678")?.waId).toBe("61412345678");
    expect(normalizePhone("+91-98765-43210")?.e164).toBe("+919876543210");
    expect(normalizePhone("0061 412 345 678")?.waId).toBe("61412345678");
    expect(normalizePhone("+1 (415) 555-0123")?.country).toBe("US");
  });

  it("turns a local number international only when the country is known", () => {
    expect(normalizePhone("0412 345 678", "AU")?.waId).toBe("61412345678");
    expect(normalizePhone("098765 43210", "IN")?.waId).toBe("919876543210");
    expect(normalizePhone("9876543210", "IN")?.waId).toBe("919876543210");
    expect(normalizePhone("919876543210", "IN")?.waId).toBe("919876543210");
    expect(normalizePhone("(415) 555-0123", "US")?.waId).toBe("14155550123");
    expect(normalizePhone("1 415 555 0123", "US")?.waId).toBe("14155550123");
    expect(normalizePhone("312 345 6789", "IT")?.waId).toBe("393123456789");
    // No country: a local number can't be placed, so it is refused rather than guessed.
    expect(normalizePhone("0412 345 678")).toBeNull();
    expect(normalizePhone("0412 345 678", "ZZ")).toBeNull();
  });

  it("refuses what isn't a phone number", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
    expect(normalizePhone("+12")).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
    expect(normalizePhone("041234", "AU")).toBeNull();
    expect(normalizePhone("+61 412+345")).toBeNull();
  });

  it("masks all but the country code and last three digits", () => {
    expect(maskPhone("+61412345678")).toBe("+61 •••••• 678");
    expect(maskPhone("+919876543210")).toBe("+91 ••••••• 210");
  });
});

describe("keywords", () => {
  it("recognises STOP and START however they're typed", () => {
    expect(isStopKeyword(" Stop ")).toBe(true);
    expect(isStopKeyword("UNSUBSCRIBE!")).toBe(true);
    expect(isStopKeyword("please stop sending these")).toBe(false);
    expect(isStartKeyword("start")).toBe(true);
    expect(isStopPromotionsReply("Stop promotions")).toBe(true);
    expect(isStopPromotionsReply("stop")).toBe(false);
  });
});

describe("parcel stages", () => {
  it("maps Shopify's shipment statuses", () => {
    expect(shipmentStage("in_transit")).toBe("in_transit");
    expect(shipmentStage("OUT_FOR_DELIVERY")).toBe("out_for_delivery");
    expect(shipmentStage("delivered")).toBe("delivered");
    expect(shipmentStage("attempted_delivery")).toBe("failed");
    expect(shipmentStage("label_printed")).toBe("shipped");
    expect(shipmentStage(null)).toBeNull();
    expect(shipmentStage("something_new")).toBeNull();
  });
});

describe("template components", () => {
  const lib = TEMPLATE_LIBRARY.find((t) => t.name === "insights_order_shipped")!;
  const components = [{ type: "BODY", text: lib.body }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://x.test/track?t={{1}}" }] }];

  it("reads a template's variables and dynamic buttons", () => {
    expect(templateShape(components)).toEqual({ bodyVars: 4, headerFormat: "NONE", headerVars: 0, dynamicUrlButtons: [0] });
  });

  it("fills body variables in order and the button suffix, cleaning what Meta refuses", () => {
    const out = buildComponents(templateShape(components), lib.mapping, {
      customer_name: "Asha\nK",
      order_number: "#1042",
      courier_name: "Blue Dart",
      tracking_number: "",
      tracking_token: "tok123",
    });
    expect(out.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Asha K" }, { type: "text", text: "#1042" }, { type: "text", text: "Blue Dart" }, { type: "text", text: "-" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "tok123" }] },
    ]);
  });

  it("refuses a send that would not match the template", () => {
    expect(() => buildComponents(templateShape(components), { body: ["customer_name"], buttons: ["tracking_token"], fixed: {} }, {})).toThrow(/4 variables/);
    expect(() => buildComponents(templateShape([{ type: "HEADER", format: "IMAGE" }]), { body: [], buttons: [], fixed: {} }, {})).toThrow(/image/);
  });

  it("previews with values", () => {
    expect(previewText("Hi {{1}}, order {{2}}", ["Asha", "#1"])).toBe("Hi Asha, order #1");
    expect(cleanParam("a     b")).toBe("a   b");
  });

  it("library templates start and end with text, and map every variable", () => {
    for (const t of TEMPLATE_LIBRARY) {
      expect(t.body.trimStart().startsWith("{{"), t.name).toBe(false);
      expect(t.body.trimEnd().endsWith("}}"), t.name).toBe(false);
      expect(t.mapping.body.length, t.name).toBe(templateShape([{ type: "BODY", text: t.body }]).bodyVars);
      expect(t.examples.length, t.name).toBe(t.mapping.body.length);
    }
  });
});

describe("errors", () => {
  it("decides what to do about each Cloud API error", () => {
    expect(classifyGraphError(190, 401)).toBe("reconnect");
    expect(classifyGraphError(131050, 400)).toBe("marketing_opt_out");
    expect(classifyGraphError(130429, 400)).toBe("retry");
    expect(classifyGraphError(131026, 400)).toBe("fail");
    expect(classifyGraphError(null, 503)).toBe("retry");
    expect(classifyGraphError(null, 400)).toBe("fail");
  });
});

describe("send window", () => {
  it("knows store-local hours, across midnight too", () => {
    const at = new Date("2026-10-10T03:30:00Z"); // 09:00 in Kolkata
    expect(inSendWindow(at, "Asia/Kolkata", 9, 21)).toBe(true);
    expect(inSendWindow(at, "UTC", 9, 21)).toBe(false);
    expect(inSendWindow(new Date("2026-10-10T23:00:00Z"), "UTC", 22, 6)).toBe(true);
  });

  it("finds the next moment inside the window", () => {
    const at = new Date("2026-10-10T22:15:00Z");
    const next = nextSendTime(at, "UTC", 9, 21);
    expect(next.toISOString()).toBe("2026-10-11T09:00:00.000Z");
    expect(nextSendTime(new Date("2026-10-10T10:00:00Z"), "UTC", 9, 21).toISOString()).toBe("2026-10-10T10:00:00.000Z");
  });
});

describe("automation conditions", () => {
  const facts = { orderValue: 120, productIds: ["7"], productTitles: ["Kerala Saree"], orderStatus: "placed", customerSegment: "new" as const, country: "IN", marketingConsent: true };

  it("ANDs every condition", () => {
    expect(evaluateConditions([{ field: "order_value", op: "gte", value: 100 }, { field: "country", op: "in", value: ["IN", "AE"] }], facts).pass).toBe(true);
    expect(evaluateConditions([{ field: "order_value", op: "gt", value: 200 }], facts).pass).toBe(false);
    expect(evaluateConditions([{ field: "product", op: "contains", value: "saree" }], facts).pass).toBe(true);
    expect(evaluateConditions([{ field: "marketing_consent", op: "eq", value: true }], facts).pass).toBe(true);
    expect(evaluateConditions([{ field: "previous_message_status", op: "eq", value: "none" }], facts).pass).toBe(true);
  });

  it("treats a missing fact as not met", () => {
    expect(evaluateConditions([{ field: "order_value", op: "gt", value: 1 }], {}).pass).toBe(false);
  });
});

describe("rule conflicts", () => {
  const send: RuleLike = { id: "a", name: "Thanks", enabled: true, trigger: "order_delivered", conditions: [], action: { type: "send_template", templateName: "t", language: "en", mapping: { body: [], buttons: [], fixed: {} } } };
  it("blocks rules that undo each other and warns about duplicates", () => {
    const cancel: RuleLike = { ...send, id: "b", name: "Quiet", action: { type: "cancel_pending", kinds: ["automation"] } };
    expect(ruleConflicts(cancel, [send])[0]?.severity).toBe("block");
    expect(ruleConflicts({ ...send, id: "c", name: "Again" }, [send])[0]?.severity).toBe("warn");
    expect(ruleConflicts({ ...send, id: "d", trigger: "order_created" }, [send])).toEqual([]);
    expect(ruleConflicts({ ...cancel, enabled: false }, [send])).toEqual([]);
  });
});

describe("settings", () => {
  it("defaults to sending nothing until the merchant chooses", () => {
    const cfg = whatsappConfigSchema.parse({});
    expect(cfg.transactionalBasis).toBe("none");
    expect(kindSetting(cfg, "order_confirmation").enabled).toBe(false);
    expect(kindSetting(cfg, "order_confirmation").mapping.body).toContain("delivery_address");
  });
});

describe("Meta signatures", () => {
  it("verifies X-Hub-Signature-256 against the raw body", () => {
    const raw = '{"object":"whatsapp_business_account"}';
    const sig = signMetaBody(raw, "secret");
    expect(verifyMetaSignature(raw, sig, "secret")).toBe(true);
    expect(verifyMetaSignature(raw + " ", sig, "secret")).toBe(false);
    expect(verifyMetaSignature(raw, sig, "other")).toBe(false);
    expect(verifyMetaSignature(raw, undefined, "secret")).toBe(false);
    expect(verifyMetaSignature(raw, sig.replace("sha256=", ""), "secret")).toBe(false);
  });
});

describe("message groups and the campaign lifecycle (shared by the API and the UI)", () => {
  it("groups notification kinds as KIND_INFO says, and filters the history by group", () => {
    expect(kindsOf("orders")).toEqual(["order_confirmation", "payment_confirmed", "order_processing", "order_packed", "order_cancelled", "refund_processed"]);
    expect(kindsOf("delivery")).toEqual(["order_shipped", "out_for_delivery", "order_delivered", "delivery_failed"]);
    expect(kindsOf("carts")).toEqual(["abandoned_cart_1", "abandoned_cart_2"]);
    expect(kindsOf("reviews")).toEqual(["review_request", "review_reminder"]);
    expect(messageKinds("carts")).toEqual(["abandoned_cart_1", "abandoned_cart_2"]);
    expect(messageKinds("campaign")).toEqual(["campaign"]);
    expect(messageKinds("anything else")).toBeNull();
  });

  it("allows each campaign action only from the states it makes sense in", () => {
    expect(["draft", "scheduled", "sending", "paused", "completed", "cancelled"].filter((s) => campaignCan(s, "pause"))).toEqual(["scheduled", "sending"]);
    expect(["draft", "scheduled", "sending", "paused", "completed", "cancelled"].filter((s) => campaignCan(s, "resume"))).toEqual(["paused"]);
    expect(["draft", "scheduled", "sending", "paused", "completed", "cancelled"].filter((s) => campaignCan(s, "cancel"))).toEqual(["draft", "scheduled", "sending", "paused"]);
    expect(campaignStatusAfter("resume", false)).toBe("scheduled");
    expect(campaignStatusAfter("resume", true)).toBe("sending");
    expect(campaignStatusAfter("pause", true)).toBe("paused");
    expect(campaignEditable("scheduled")).toBe(true);
    expect(campaignEditable("sending")).toBe(false);
  });
});
