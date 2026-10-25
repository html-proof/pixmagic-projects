/**
 * WhatsApp Automation (WhatsApp Business Platform, Cloud API): the pure parts, shared by the API,
 * the worker and the dashboard (`@app/shared/whatsapp`). Message templates and their variables,
 * who may receive what (consent), workflow triggers and conditions, campaign audiences, message
 * statuses, and what to do about each error Meta returns. Everything that touches the network or
 * the database is in packages/core/src/whatsapp; docs/whatsapp.md describes the whole feature.
 *
 * Phone numbers and sending hours are shared with Customer Messaging (SMS): `./messaging.ts`.
 */
import { z } from "./zod";

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/** A template's component as Meta stores and returns it (GET /{waba}/message_templates). */
export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type: string; text?: string; url?: string; phone_number?: string }>;
}

/** The categories bizinsights creates. Authentication templates (one-time codes) aren't for this feature. */
export const TEMPLATE_CATEGORIES = ["UTILITY", "MARKETING"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_CATEGORY_INFO: Record<TemplateCategory, { label: string; help: string }> = {
  UTILITY: {
    label: "Order and service updates",
    help: "Updates a customer expects about something they did: an order confirmation, shipping, an appointment. No offers or promotions in these.",
  },
  MARKETING: {
    label: "Marketing",
    help: "Offers, reminders about a cart, welcome messages, news. Only customers who agreed to marketing on WhatsApp receive these.",
  },
};

/** Languages offered when writing a template (Meta's codes). Any code Meta accepts can still be synced from WhatsApp Manager. */
export const TEMPLATE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "es", label: "Spanish" },
  { code: "es_MX", label: "Spanish (Mexico)" },
  { code: "pt_BR", label: "Portuguese (Brazil)" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "hi", label: "Hindi" },
  { code: "ml", label: "Malayalam" },
  { code: "ta", label: "Tamil" },
  { code: "ar", label: "Arabic" },
  { code: "id", label: "Indonesian" },
  { code: "ms", label: "Malay" },
  { code: "zh_CN", label: "Chinese (simplified)" },
];

/** Template statuses Meta reports, in words. */
export const TEMPLATE_STATUS_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  PENDING: "Waiting for Meta's review",
  IN_APPEAL: "Appealed",
  REJECTED: "Rejected by Meta",
  PAUSED: "Paused by Meta (low quality)",
  DISABLED: "Disabled by Meta",
  PENDING_DELETION: "Being deleted",
  DELETED: "Deleted",
  LIMIT_EXCEEDED: "Template limit reached",
};

/** The highest {{n}} in a text (Meta numbers variables 1, 2, 3...). */
export function countVariables(text: string | undefined | null): number {
  if (!text) return 0;
  const nums = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((x) => Number(x[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export interface TemplateShape {
  bodyVars: number;
  headerFormat: "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  headerVars: number;
  /** Indexes (in the template's button list) of URL buttons whose link ends in a variable. */
  dynamicUrlButtons: number[];
}

/** What a stored template needs filled in when it is sent. */
export function templateShape(components: TemplateComponent[]): TemplateShape {
  const body = components.find((c) => c.type.toUpperCase() === "BODY");
  const header = components.find((c) => c.type.toUpperCase() === "HEADER");
  const buttons = components.find((c) => c.type.toUpperCase() === "BUTTONS")?.buttons ?? [];
  const format = (header?.format?.toUpperCase() ?? "NONE") as TemplateShape["headerFormat"];
  return {
    bodyVars: countVariables(body?.text),
    headerFormat: header ? format : "NONE",
    headerVars: format === "TEXT" ? countVariables(header?.text) : 0,
    dynamicUrlButtons: buttons.flatMap((b, i) => (b.type.toUpperCase() === "URL" && countVariables(b.url) > 0 ? [i] : [])),
  };
}

/** A template's texts, for previews: header, body, footer and the buttons' labels. */
export function templateTexts(components: TemplateComponent[]): { header: string | null; headerFormat: TemplateShape["headerFormat"]; body: string; footer: string | null; buttons: string[] } {
  const find = (t: string) => components.find((c) => c.type.toUpperCase() === t);
  const header = find("HEADER");
  return {
    header: header?.format?.toUpperCase() === "TEXT" ? (header.text ?? null) : null,
    headerFormat: templateShape(components).headerFormat,
    body: find("BODY")?.text ?? "",
    footer: find("FOOTER")?.text ?? null,
    buttons: (find("BUTTONS")?.buttons ?? []).map((b) => b.text ?? "").filter(Boolean),
  };
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const varsOf = (text: string) => [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));

/** A template the merchant writes in the dashboard, before it goes to Meta for review. */
export const templateDraftSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the template a name")
    .max(512)
    .transform((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
    .refine((s) => TEMPLATE_NAME.test(s), "Use letters, numbers and underscores"),
  language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Pick a language"),
  category: z.enum(TEMPLATE_CATEGORIES),
  header: z.discriminatedUnion("type", [z.object({ type: z.literal("none") }), z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(60), example: z.string().trim().max(60).optional() })]),
  body: z.string().trim().min(1, "Write the message").max(1024, "WhatsApp allows 1,024 characters"),
  /** One example value per {{n}} in the body, in order: Meta's reviewers read the template with them. */
  bodyExamples: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  footer: z.string().trim().max(60).optional().nullable(),
  buttons: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("quick_reply"), text: z.string().trim().min(1).max(25) }),
        z.object({
          type: z.literal("url"),
          text: z.string().trim().min(1).max(25),
          url: z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "Links must start with https://"),
          example: z.string().trim().max(2000).optional(),
        }),
      ]),
    )
    .max(3)
    .default([]),
});
export type TemplateDraft = z.output<typeof templateDraftSchema>;

export interface TemplateIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

/** What Meta would refuse in a draft (errors), and what is likely to get it rejected or paused (warnings). */
export function checkTemplateDraft(d: TemplateDraft): TemplateIssue[] {
  const out: TemplateIssue[] = [];
  const vars = varsOf(d.body);
  const n = vars.length ? Math.max(...vars) : 0;
  for (let i = 1; i <= n; i++) if (!vars.includes(i)) out.push({ level: "error", code: "variables_gap", message: `Variables must be numbered in order: {{${i}}} is missing.` });
  if (n && d.bodyExamples.length < n) out.push({ level: "error", code: "examples_missing", message: `Give an example for each variable (${n} needed): Meta's reviewers read the message with them.` });
  const trimmed = d.body.trim();
  if (/^\{\{\s*\d+\s*\}\}/.test(trimmed) || /\{\{\s*\d+\s*\}\}[.!?]?$/.test(trimmed)) out.push({ level: "error", code: "variable_at_edge", message: "The message can't start or end with a variable. Add a few words before or after it." });
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(d.body)) out.push({ level: "error", code: "adjacent_variables", message: "Two variables can't sit side by side: put words between them." });
  const words = trimmed.replace(/\{\{\s*\d+\s*\}\}/g, " ").split(/\s+/).filter(Boolean).length;
  if (n && words < n * 3) out.push({ level: "error", code: "too_many_variables", message: "Meta rejects templates that are mostly variables. Add more fixed words." });
  if (d.header.type === "text" && countVariables(d.header.text) > 1) out.push({ level: "error", code: "header_variables", message: "A header can have at most one variable." });
  if (d.header.type === "text" && countVariables(d.header.text) === 1 && !d.header.example) out.push({ level: "error", code: "header_example", message: "Give an example for the header's variable." });
  if (d.footer && countVariables(d.footer)) out.push({ level: "error", code: "footer_variables", message: "The footer can't have variables." });
  for (const b of d.buttons) {
    if (b.type !== "url") continue;
    const v = countVariables(b.url);
    if (v > 1 || (v === 1 && !/\{\{\s*1\s*\}\}$/.test(b.url))) out.push({ level: "error", code: "button_url_variable", message: `"${b.text}": a link can have one variable, at its very end ({{1}}).` });
    if (v === 1 && !b.example) out.push({ level: "error", code: "button_url_example", message: `"${b.text}": give an example of the full link.` });
  }
  if (d.buttons.filter((b) => b.type === "url").length > 2) out.push({ level: "error", code: "too_many_links", message: "A template can have at most two link buttons." });
  if (d.category === "MARKETING" && !d.buttons.some((b) => b.type === "quick_reply" && /stop|unsubscribe/i.test(b.text)) && !/stop/i.test(`${d.body} ${d.footer ?? ""}`)) {
    out.push({ level: "warning", code: "no_opt_out", message: 'Marketing messages should tell people how to stop them: add a "Stop promotions" quick reply, or "Reply STOP to unsubscribe" in the footer.' });
  }
  if (d.category === "UTILITY" && /\b(\d{1,2}% ?off|discount|sale|offer|coupon|promo)\b/i.test(d.body)) {
    out.push({ level: "warning", code: "marketing_words", message: "This reads like an offer. Meta moves utility templates with offers to Marketing, which only opted-in customers receive." });
  }
  return out;
}

export const hasErrors = (issues: TemplateIssue[]) => issues.some((i) => i.level === "error");

/** A draft as the components of Meta's "create template" call (POST /{waba}/message_templates). */
export function toMetaComponents(d: TemplateDraft): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (d.header.type === "text") {
    out.push({ type: "HEADER", format: "TEXT", text: d.header.text, ...(countVariables(d.header.text) && d.header.example ? { example: { header_text: [d.header.example] } } : {}) });
  }
  const n = countVariables(d.body);
  out.push({ type: "BODY", text: d.body, ...(n ? { example: { body_text: [d.bodyExamples.slice(0, n)] } } : {}) });
  if (d.footer) out.push({ type: "FOOTER", text: d.footer });
  if (d.buttons.length) {
    out.push({
      type: "BUTTONS",
      buttons: d.buttons.map((b) =>
        b.type === "quick_reply" ? { type: "QUICK_REPLY", text: b.text } : { type: "URL", text: b.text, url: b.url, ...(countVariables(b.url) && b.example ? { example: [b.example] } : {}) },
      ),
    });
  }
  return out;
}

/** A draft as the components Meta would store, for previews before it is submitted. */
export function draftComponents(d: TemplateDraft): TemplateComponent[] {
  return toMetaComponents(d) as unknown as TemplateComponent[];
}

// ---------------------------------------------------------------------------
// Variables: where each {{n}} takes its value from when a message is sent
// ---------------------------------------------------------------------------

export const VARIABLE_SOURCES = [
  "customer_first_name",
  "store_name",
  "order_number",
  "order_total",
  "order_status_url",
  "product_names",
  "tracking_number",
  "tracking_url",
  "carrier",
  "checkout_url",
  "event_date",
  "event_time",
  "event_value",
  "custom_text",
] as const;
export type VariableSource = (typeof VARIABLE_SOURCES)[number];

export const VARIABLE_INFO: Record<VariableSource, { label: string; sample: string; help?: string }> = {
  customer_first_name: { label: "Customer's first name", sample: "Priya", help: "\"there\" when the order has no name." },
  store_name: { label: "Your store's name", sample: "Kerala Spices" },
  order_number: { label: "Order number", sample: "#1042" },
  order_total: { label: "Order total", sample: "$58.00" },
  order_status_url: { label: "Order status page (Shopify)", sample: "https://shop.example.com/orders/abc" },
  product_names: { label: "Products ordered", sample: "Cardamom 200g, Black pepper 100g" },
  tracking_number: { label: "Tracking number", sample: "LX123456789AU" },
  tracking_url: { label: "Tracking link", sample: "https://auspost.com.au/track/LX123456789AU" },
  carrier: { label: "Courier", sample: "Australia Post" },
  checkout_url: { label: "Link back to the checkout", sample: "https://shop.example.com/checkouts/recover" },
  event_date: { label: "Event date (custom events)", sample: "Monday 3 November" },
  event_time: { label: "Event time (custom events)", sample: "10:30 am" },
  event_value: { label: "A value sent with the event", sample: "Haircut with Sam", help: "The key you name, from the event's values." },
  custom_text: { label: "Fixed text", sample: "", help: "The same words for everyone." },
};

/** One {{n}}: where its value comes from. `text` is the fixed text (custom_text) or the event value's key (event_value). */
export const variableRefSchema = z.object({ source: z.enum(VARIABLE_SOURCES), text: z.string().trim().max(300).optional() });
export type VariableRef = z.output<typeof variableRefSchema>;

export const mappingSchema = z.object({
  header: variableRefSchema.nullable().optional(),
  body: z.array(variableRefSchema).max(20).default([]),
  /** One per URL button whose link ends in a variable, in the template's button order. */
  buttons: z.array(variableRefSchema).max(2).default([]),
});
export type TemplateMapping = z.output<typeof mappingSchema>;

/** What one event knows: the values the variables take. Missing ones are absent. */
export type SendValues = Partial<Record<Exclude<VariableSource, "custom_text" | "event_value">, string>> & { event?: Record<string, string> };

/** Meta refuses parameters with newlines, tabs or more than four spaces in a row, and empty ones. */
export function cleanParam(value: string | null | undefined, max = 600): string {
  return (value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, max);
}

/** The value a variable takes from `values`; null when the event doesn't know it. */
export function resolveVariable(ref: VariableRef | null | undefined, values: SendValues): string | null {
  if (!ref) return null;
  if (ref.source === "custom_text") return ref.text?.trim() || null;
  if (ref.source === "event_value") return (ref.text && values.event?.[ref.text]?.trim()) || null;
  if (ref.source === "customer_first_name") return values.customer_first_name?.trim() || "there";
  return values[ref.source]?.trim() || null;
}

/** Variable sources a template uses that `values` doesn't hold (they'd send an empty value, which Meta refuses). */
export function missingValues(shape: TemplateShape, mapping: TemplateMapping, values: SendValues): string[] {
  const refs = [...(shape.headerVars ? [mapping.header ?? null] : []), ...mapping.body.slice(0, shape.bodyVars), ...mapping.buttons.slice(0, shape.dynamicUrlButtons.length)];
  const missing = refs.flatMap((r, i) => (resolveVariable(r, values) ? [] : [r ? VARIABLE_INFO[r.source].label : `variable ${i + 1}`]));
  if (mapping.body.length < shape.bodyVars) missing.push(`${shape.bodyVars - mapping.body.length} body variable(s) not chosen`);
  return [...new Set(missing)];
}

export class MissingValueError extends Error {
  override name = "MissingValueError";
  constructor(readonly missing: string[]) {
    super(`Missing: ${missing.join(", ")}`);
  }
}

/**
 * The `template.components` of a Cloud API send. Throws MissingValueError when a variable has no
 * value (Meta would refuse the whole message), and when a media header has no link.
 */
export function buildSendComponents(shape: TemplateShape, mapping: TemplateMapping, values: SendValues, headerMediaUrl?: string | null): Array<Record<string, unknown>> {
  const missing = missingValues(shape, mapping, values);
  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(shape.headerFormat) && !headerMediaUrl) missing.push(`a ${shape.headerFormat.toLowerCase()} for the header`);
  if (missing.length) throw new MissingValueError(missing);
  const out: Array<Record<string, unknown>> = [];
  if (shape.headerFormat === "TEXT" && shape.headerVars) {
    out.push({ type: "header", parameters: [{ type: "text", text: cleanParam(resolveVariable(mapping.header, values), 60) }] });
  } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(shape.headerFormat)) {
    const kind = shape.headerFormat.toLowerCase();
    out.push({ type: "header", parameters: [{ type: kind, [kind]: { link: headerMediaUrl } }] });
  }
  if (shape.bodyVars) {
    out.push({ type: "body", parameters: mapping.body.slice(0, shape.bodyVars).map((r) => ({ type: "text", text: cleanParam(resolveVariable(r, values)) })) });
  }
  shape.dynamicUrlButtons.forEach((index, n) => {
    out.push({ type: "button", sub_type: "url", index: String(index), parameters: [{ type: "text", text: cleanParam(resolveVariable(mapping.buttons[n], values), 2000) }] });
  });
  return out;
}

/** Fill {{n}} with values (1-based), leaving unknown ones as they are. */
export function fillText(text: string, values: Array<string | null | undefined>): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n: string) => values[Number(n) - 1] || all);
}

/** A template as the customer would read it with `values` (samples when null), for previews and the message history. */
export function renderTemplate(components: TemplateComponent[], mapping: TemplateMapping | null, values: SendValues | null): { header: string | null; body: string; footer: string | null; buttons: string[] } {
  const t = templateTexts(components);
  const pick = (r: VariableRef | null | undefined) => {
    if (!r) return null;
    if (values) return resolveVariable(r, values);
    return r.source === "custom_text" ? r.text || null : r.source === "event_value" ? `[${r.text || "value"}]` : VARIABLE_INFO[r.source].sample;
  };
  return {
    header: t.header ? fillText(t.header, [pick(mapping?.header)]) : null,
    body: fillText(t.body, (mapping?.body ?? []).map(pick)),
    footer: t.footer,
    buttons: t.buttons,
  };
}

// ---------------------------------------------------------------------------
// Starter templates: written for the common jobs, reviewed by the merchant before Meta sees them
// ---------------------------------------------------------------------------

export interface StarterTemplate {
  key: string;
  title: string;
  description: string;
  draft: TemplateDraft;
  /** How each body variable is filled when the template is used in a workflow. */
  mapping: TemplateMapping;
}

const ref = (source: VariableSource, text?: string): VariableRef => (text ? { source, text } : { source });

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: "order_confirmation",
    title: "Order confirmation",
    description: "Thanks the customer and confirms their order.",
    draft: {
      name: "order_confirmation",
      language: "en",
      category: "UTILITY",
      header: { type: "none" },
      body: "Hi {{1}}, thank you for your order {{2}} from {{3}}. We're getting it ready and will message you when it ships.",
      bodyExamples: ["Priya", "#1042", "Kerala Spices"],
      footer: "Reply STOP to stop these updates",
      buttons: [],
    },
    mapping: { body: [ref("customer_first_name"), ref("order_number"), ref("store_name")], buttons: [] },
  },
  {
    key: "shipping_update",
    title: "Shipping update",
    description: "Tells the customer their order is on its way, with tracking.",
    draft: {
      name: "shipping_update",
      language: "en",
      category: "UTILITY",
      header: { type: "none" },
      body: "Good news {{1}}! Your order {{2}} is on its way with {{3}}, tracking number {{4}}. We will let you know if anything changes.",
      bodyExamples: ["Priya", "#1042", "Australia Post", "LX123456789AU"],
      footer: "Reply STOP to stop these updates",
      buttons: [],
    },
    mapping: { body: [ref("customer_first_name"), ref("order_number"), ref("carrier"), ref("tracking_number")], buttons: [] },
  },
  {
    key: "abandoned_checkout",
    title: "Abandoned checkout reminder",
    description: "Reminds an opted-in customer about the items they left in checkout.",
    draft: {
      name: "checkout_reminder",
      language: "en",
      category: "MARKETING",
      header: { type: "none" },
      body: "Hi {{1}}, you left {{2}} in your cart at {{3}}. Your items are still waiting for you whenever you're ready.",
      bodyExamples: ["Priya", "Cardamom 200g", "Kerala Spices"],
      footer: null,
      buttons: [{ type: "quick_reply", text: "Stop promotions" }],
    },
    mapping: { body: [ref("customer_first_name"), ref("product_names"), ref("store_name")], buttons: [] },
  },
  {
    key: "follow_up",
    title: "Follow-up after an order",
    description: "Checks in a few days after the order shipped.",
    draft: {
      name: "order_follow_up",
      language: "en",
      category: "MARKETING",
      header: { type: "none" },
      body: "Hi {{1}}, we hope you're enjoying your order {{2}} from {{3}}. If anything isn't right, just reply to this message.",
      bodyExamples: ["Priya", "#1042", "Kerala Spices"],
      footer: null,
      buttons: [{ type: "quick_reply", text: "Stop promotions" }],
    },
    mapping: { body: [ref("customer_first_name"), ref("order_number"), ref("store_name")], buttons: [] },
  },
  {
    key: "welcome",
    title: "Welcome a new customer",
    description: "Greets a customer who just created an account and agreed to marketing.",
    draft: {
      name: "welcome_customer",
      language: "en",
      category: "MARKETING",
      header: { type: "none" },
      body: "Welcome to {{1}}, {{2}}! We'll send you our news and offers here now and then.",
      bodyExamples: ["Kerala Spices", "Priya"],
      footer: null,
      buttons: [{ type: "quick_reply", text: "Stop promotions" }],
    },
    mapping: { body: [ref("store_name"), ref("customer_first_name")], buttons: [] },
  },
  {
    key: "appointment_reminder",
    title: "Appointment reminder",
    description: "Reminds a customer of a booking (sent from a custom event).",
    draft: {
      name: "appointment_reminder",
      language: "en",
      category: "UTILITY",
      header: { type: "none" },
      body: "Hi {{1}}, this is a reminder of your appointment with {{2}} on {{3}} at {{4}}. Reply if you need to change it.",
      bodyExamples: ["Priya", "Kerala Spices", "Monday 3 November", "10:30 am"],
      footer: "Reply STOP to stop these reminders",
      buttons: [],
    },
    mapping: { body: [ref("customer_first_name"), ref("store_name"), ref("event_date"), ref("event_time")], buttons: [] },
  },
  {
    key: "promotion",
    title: "Promotion",
    description: "A campaign message for customers who opted in to offers.",
    draft: {
      name: "store_promotion",
      language: "en",
      category: "MARKETING",
      header: { type: "none" },
      body: "Hi {{1}}, something new at {{2}}: {{3}}. Reply to this message if you have any questions.",
      bodyExamples: ["Priya", "Kerala Spices", "our festive spice boxes are here"],
      footer: null,
      buttons: [{ type: "quick_reply", text: "Stop promotions" }],
    },
    mapping: { body: [ref("customer_first_name"), ref("store_name"), ref("custom_text", "our new arrivals are here")], buttons: [] },
  },
  {
    key: "stock_alert",
    title: "Stock alert (to your team)",
    description: "Inventory's low and sold-out stock alerts, sent to your own team's numbers.",
    draft: {
      name: "team_stock_alert",
      language: "en",
      category: "UTILITY",
      header: { type: "none" },
      body: "Stock alert from {{1}}: {{2}}. Open bizinsights to see which products.",
      bodyExamples: ["Kerala Spices", "2 products sold out, 5 running low"],
      footer: null,
      buttons: [],
    },
    mapping: { body: [ref("store_name"), ref("custom_text", "stock summary")], buttons: [] },
  },
];

export const starterTemplate = (key: string) => STARTER_TEMPLATES.find((t) => t.key === key) ?? null;

// ---------------------------------------------------------------------------
// Opt-out and opt-in keywords (an inbound message whose whole text is one of these)
// ---------------------------------------------------------------------------

// Not "cancel": in a conversation about an order it usually means the order, not the messages.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "end", "quit", "optout", "opt out", "no more", "remove me"]);
const START_WORDS = new Set(["start", "subscribe", "optin", "opt in", "unstop"]);
const keyword = (text: string) => text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");

/** "STOP": the customer wants no more messages from this business at all. */
export const isStopKeyword = (text: string | null | undefined) => !!text && STOP_WORDS.has(keyword(text));
/** "START": the customer asks for messages again, offers included. */
export const isStartKeyword = (text: string | null | undefined) => !!text && START_WORDS.has(keyword(text));
/** The "Stop promotions" quick reply: marketing stops, order updates continue. */
export const isStopPromotionsReply = (text: string | null | undefined) => !!text && /^stop promotions?$/.test(keyword(text));

// ---------------------------------------------------------------------------
// Consent: who may receive what
// ---------------------------------------------------------------------------

/**
 * How customers agree to order and service updates on WhatsApp (the store's choice, audited):
 *  - opt_in_only: only customers who opted in themselves (START, a "yes" recorded by the store, or
 *    Shopify's text-message consent when the store says its wording covers WhatsApp);
 *  - checkout_notice: the store's checkout or terms tell customers they'll get order updates on
 *    WhatsApp, and how to stop them. Everyone who ordered gets updates until they reply STOP.
 * Until the store chooses, no order update is sent.
 */
export const ORDER_UPDATE_BASES = ["unset", "opt_in_only", "checkout_notice"] as const;
export type OrderUpdateBasis = (typeof ORDER_UPDATE_BASES)[number];

export const ORDER_UPDATE_BASIS_INFO: Record<OrderUpdateBasis, { label: string; help: string }> = {
  unset: { label: "Not chosen yet", help: "No order or service update is sent until you choose." },
  opt_in_only: { label: "Only customers who opted in", help: "Customers who replied START, who you recorded as agreeing, or who accepted text-message marketing at checkout (when you say that covers WhatsApp)." },
  checkout_notice: {
    label: "My checkout tells customers",
    help: "Your checkout or terms say customers get order updates on WhatsApp and can reply STOP. Every customer with a phone number gets updates until they reply STOP.",
  },
};

export type MarketingStatus = "opted_in" | "opted_out" | "unknown";

export interface ConsentFacts {
  /** Replied STOP (or was recorded as opted out): nothing at all is sent. */
  optedOut: boolean;
  /** Agreed to messages from the store themselves (START, recorded by the store, Shopify's consent); "Stop promotions" doesn't undo it. */
  optedIn: boolean;
  marketing: MarketingStatus;
}

export interface ConsentSettings {
  orderUpdates: OrderUpdateBasis;
}

/** Why a message may not go to this customer, or null when it may. Meta's category of the template decides which rule applies. */
export function consentProblem(category: string, contact: ConsentFacts, settings: ConsentSettings): SkipReason | null {
  if (contact.optedOut) return "opted_out";
  const c = category.toUpperCase();
  if (c === "MARKETING") return contact.marketing === "opted_in" ? null : "no_marketing_consent";
  if (c === "UTILITY") return contact.optedIn || settings.orderUpdates === "checkout_notice" ? null : "no_order_update_consent";
  // Authentication (one-time codes) and anything Meta may add: not sent by this feature.
  return "template_not_allowed";
}

export const CONSENT_SOURCES = ["whatsapp_start", "whatsapp_stop", "stop_promotions", "meta_preferences", "meta_error", "shopify_sms", "merchant"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_SOURCE_LABEL: Record<ConsentSource, string> = {
  whatsapp_start: "Replied START on WhatsApp",
  whatsapp_stop: "Replied STOP on WhatsApp",
  stop_promotions: 'Pressed "Stop promotions"',
  meta_preferences: "Changed their marketing setting in WhatsApp",
  meta_error: "WhatsApp said they stopped marketing messages",
  shopify_sms: "Text-message marketing consent in Shopify",
  merchant: "Recorded by your team",
};

// ---------------------------------------------------------------------------
// Message statuses
// ---------------------------------------------------------------------------

/**
 *  - queued: waiting for its time (a delay, a workflow's timing, a campaign's turn);
 *  - sending: being handed to Meta right now;
 *  - accepted: Meta's API accepted it and gave its id (the first proof it exists);
 *  - sent / delivered / read: Meta's webhooks (read only when the customer has read receipts on);
 *  - failed: Meta refused it, or reported it undeliverable;
 *  - cancelled: no longer wanted (the order was cancelled, the workflow paused, the campaign cancelled);
 *  - skipped: never sent, with the reason (no consent, no number, outside the 24-hour window...).
 */
export const WA_MESSAGE_STATUSES = ["queued", "sending", "accepted", "sent", "delivered", "read", "failed", "cancelled", "skipped"] as const;
export type WaMessageStatus = (typeof WA_MESSAGE_STATUSES)[number];

export const WA_STATUS_LABEL: Record<WaMessageStatus, string> = {
  queued: "Waiting to send",
  sending: "Sending",
  accepted: "Accepted by WhatsApp",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Not sent",
};

/** How far along a message is. Statuses only move forward; failed is final unless it was already delivered. */
export const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, accepted: 2, sent: 3, delivered: 4, read: 5 };

/** The status after Meta reports `event` (sent | delivered | read | failed) for a message now at `current`; null: no change. */
export function statusAfterEvent(current: string, event: string): WaMessageStatus | null {
  const now = STATUS_RANK[current];
  if (event === "failed") return now !== undefined && now < STATUS_RANK.delivered! ? "failed" : null;
  const next = STATUS_RANK[event];
  if (next === undefined) return null;
  // A late "sent" after "failed" doesn't revive it; a "delivered" after "failed" does (it's a fact).
  if (current === "failed") return next >= STATUS_RANK.delivered! ? (event as WaMessageStatus) : null;
  if (now === undefined) return null;
  return next > now ? (event as WaMessageStatus) : null;
}

/** The overview's buckets: waiting, sent (Meta has it), delivered (delivered or read), failed. */
export function statusBucket(status: string): "pending" | "sent" | "delivered" | "failed" | "other" {
  if (status === "queued" || status === "sending") return "pending";
  if (status === "accepted" || status === "sent") return "sent";
  if (status === "delivered" || status === "read") return "delivered";
  if (status === "failed") return "failed";
  return "other";
}

/** Why a message wasn't sent, or was cancelled. */
export const SKIP_REASONS = [
  "opted_out",
  "no_marketing_consent",
  "no_order_update_consent",
  "template_not_allowed",
  "template_not_approved",
  "missing_values",
  "no_phone",
  "outside_window",
  "not_connected",
  "disconnected",
  "reconnect_timeout",
  "workflow_paused",
  "campaign_cancelled",
  "order_cancelled",
  "checkout_completed",
  "conditions_not_met",
  "stale",
  "erased",
  "automation_paused",
  "recently_replied",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_LABEL: Record<SkipReason, string> = {
  opted_out: "The customer replied STOP",
  no_marketing_consent: "The customer hasn't agreed to marketing on WhatsApp",
  no_order_update_consent: "The customer hasn't agreed to order updates on WhatsApp",
  template_not_allowed: "This kind of template isn't sent from here",
  template_not_approved: "The template isn't approved by Meta",
  missing_values: "A variable had no value for this customer",
  no_phone: "No phone number on the order",
  outside_window: "More than 24 hours since the customer last wrote",
  not_connected: "WhatsApp isn't connected",
  disconnected: "WhatsApp was disconnected",
  reconnect_timeout: "WhatsApp needed reconnecting for too long",
  workflow_paused: "The workflow was paused or changed",
  campaign_cancelled: "The campaign was cancelled",
  order_cancelled: "The order was cancelled",
  checkout_completed: "The customer finished the checkout",
  conditions_not_met: "The workflow's conditions didn't match",
  stale: "The event was too old to message about",
  erased: "The customer's data was erased",
  automation_paused: "Automation was paused for the store",
  recently_replied: "This customer already got this reply recently",
};

export const skipLabel = (reason: string | null | undefined): string | null => (reason ? (SKIP_LABEL[reason as SkipReason] ?? reason.replace(/_/g, " ")) : null);

// ---------------------------------------------------------------------------
// Meta's errors: what to do about each
// ---------------------------------------------------------------------------

export type ErrorAction =
  /** Try again later (rate limits, Meta busy). */
  | "retry"
  /** bizinsights' access ended: the connection needs reconnecting; nothing sends until then. */
  | "reconnect"
  /** The number needs a step in WhatsApp (registration, payment method, display name). */
  | "account"
  /** The customer stopped marketing messages from this business. */
  | "marketing_opt_out"
  /** This message can't be sent as it is (bad template values, number not on WhatsApp, outside the window). */
  | "fail";

/**
 * Codes from Meta's Cloud API error reference. Unknown codes fail the message rather than retry it
 * forever; a 5xx or 429 without a code retries.
 */
export function classifyMetaError(code: number | null | undefined, httpStatus: number): ErrorAction {
  if (code === 190 || code === 102 || code === 10 || code === 200 || code === 3 || code === 33 || (code === 100 && httpStatus === 401)) return "reconnect";
  if (code === 131050 || code === 498) return "marketing_opt_out";
  if ([4, 80007, 130429, 131016, 131048, 131056, 131000, 133004, 2, 1, 131049].includes(code ?? -1)) return "retry";
  if ([133010, 131042, 131031, 133000, 368].includes(code ?? -1)) return "account";
  if (code === null || code === undefined) return httpStatus >= 500 || httpStatus === 429 ? "retry" : "fail";
  return "fail";
}

/** Plain words for the failures a merchant is most likely to see, with what to do. */
export function metaErrorExplanation(code: string | number | null | undefined, fallback?: string | null): string {
  switch (Number(code)) {
    case 131026:
      return "This number isn't on WhatsApp, or couldn't receive the message.";
    case 131047:
      return "More than 24 hours since the customer last wrote, so only an approved template can be sent.";
    case 131049:
      return "Meta held back this marketing message because the customer received many recently.";
    case 131050:
    case 498:
      return "The customer has stopped marketing messages from your business.";
    case 131051:
      return "WhatsApp doesn't support this kind of message.";
    case 131052:
    case 131053:
      return "WhatsApp couldn't download the media. Check the link opens without signing in.";
    case 131056:
      return "Too many messages to this customer in a short time.";
    case 131008:
    case 131009:
    case 132000:
      return "The values sent don't match the template's variables.";
    case 132001:
      return "The template doesn't exist in this language, or isn't approved.";
    case 132005:
      return "A variable's value is too long.";
    case 132007:
      return "The template's content breaks WhatsApp's policy.";
    case 132012:
      return "A variable's value has a format WhatsApp refuses.";
    case 132015:
    case 132016:
      return "The template is paused or disabled because of its quality.";
    case 131042:
      return "WhatsApp needs a payment method on your WhatsApp Business account. Add one in WhatsApp Manager.";
    case 131031:
      return "Your WhatsApp Business account is locked or restricted. Check WhatsApp Manager.";
    case 133010:
      return "Your phone number isn't registered with the Cloud API yet.";
    case 130429:
    case 80007:
    case 4:
      return "WhatsApp's rate limit was reached.";
    case 190:
    case 102:
      return "Meta no longer accepts bizinsights' access to your WhatsApp. Reconnect WhatsApp.";
    case 10:
    case 200:
      return "bizinsights doesn't have permission to send from this WhatsApp account. Reconnect and leave both WhatsApp permissions ticked.";
    case 368:
      return "Your WhatsApp account is temporarily blocked for policy violations.";
    case 131021:
      return "A message can't be sent to the business's own number.";
    default:
      return fallback?.trim() || "WhatsApp couldn't send this message.";
  }
}

/** Waits before the next try of a message that failed with "retry": 30 s, 2 min, 10 min, 30 min, 2 h. */
export const WA_RETRY_DELAYS_S = [30, 120, 600, 1800, 7200];
export const WA_MAX_ATTEMPTS = WA_RETRY_DELAYS_S.length + 1;

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/**
 *  - active: connected and able to send;
 *  - action_required: connected, but the merchant must do one thing first (register the number with
 *    their PIN, pick a number, add a number in WhatsApp Manager);
 *  - reconnect: Meta no longer accepts bizinsights' access (revoked, removed, expired);
 *  - error: Meta restricted or disabled the account;
 *  - disconnected: the merchant disconnected it (the row stays, for the message history).
 */
export const WA_CONNECTION_STATUSES = ["active", "action_required", "reconnect", "error", "disconnected"] as const;
export type WaConnectionStatus = (typeof WA_CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABEL: Record<WaConnectionStatus, string> = {
  active: "Connected",
  action_required: "Action needed",
  reconnect: "Reconnect needed",
  error: "Problem with the account",
  disconnected: "Disconnected",
};

/** The steps a connection can wait for, and what the merchant does about each. */
export const CONNECTION_STEPS = {
  pin_required: "Your number already has a two-step verification PIN. Enter that 6-digit PIN to finish registering it.",
  choose_number: "Choose which of your WhatsApp numbers bizinsights sends from.",
  no_number: "Your WhatsApp Business account has no phone number yet. Add one in WhatsApp Manager, then press Check again.",
  business_app_number: "This number is used in the WhatsApp Business app. bizinsights will send from it once Meta finishes moving its messages; press Check again in a few minutes.",
  register_failed: "Meta couldn't register your number for sending. Press Check again; if it keeps failing, check the number in WhatsApp Manager.",
} as const;
export type ConnectionStep = keyof typeof CONNECTION_STEPS;

/** Meta's messaging limit tier: how many customers a day the business may start conversations with (null: no limit). */
export function tierLimit(tier: string | null | undefined): number | null {
  const m = /^TIER_(\d+)(K)?$/i.exec(tier ?? "");
  if (m) return Number(m[1]) * (m[2] ? 1000 : 1);
  if (/UNLIMITED/i.test(tier ?? "")) return null;
  // Unknown: Meta starts new numbers at 250.
  return 250;
}

export const QUALITY_LABEL: Record<string, string> = { GREEN: "High", YELLOW: "Medium", RED: "Low", UNKNOWN: "Not rated yet" };

// ---------------------------------------------------------------------------
// Embedded Signup (Meta's "Continue with WhatsApp" window), as the browser hears it
// ---------------------------------------------------------------------------

export type EmbeddedSignupEvent =
  | { type: "finish"; flow: "cloud_api" | "only_waba" | "business_app" | "other"; phoneNumberId: string | null; wabaId: string | null; businessId: string | null }
  | { type: "cancel"; step: string | null }
  | { type: "error"; message: string | null; code: string | null; sessionId: string | null };

const idOrNull = (v: unknown) => (typeof v === "string" && /^\d{3,30}$/.test(v) ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null);

/**
 * Meta's `WA_EMBEDDED_SIGNUP` window message (`event.data`, as a string or an object), or null for
 * anything else. Only call it for messages whose origin is facebook.com.
 */
export function parseEmbeddedSignupMessage(data: unknown): EmbeddedSignupEvent | null {
  let d: unknown = data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const m = d as { type?: unknown; event?: unknown; data?: Record<string, unknown> | null };
  if (m.type !== "WA_EMBEDDED_SIGNUP") return null;
  const data2 = m.data && typeof m.data === "object" ? m.data : {};
  const event = String(m.event ?? "");
  if (data2.error_message || event === "ERROR") {
    return { type: "error", message: typeof data2.error_message === "string" ? data2.error_message.slice(0, 300) : null, code: data2.error_code ? String(data2.error_code).slice(0, 40) : null, sessionId: data2.session_id ? String(data2.session_id).slice(0, 80) : null };
  }
  if (event === "CANCEL") return { type: "cancel", step: typeof data2.current_step === "string" ? data2.current_step.slice(0, 80) : null };
  if (event.startsWith("FINISH")) {
    const flow = event === "FINISH" ? "cloud_api" : event === "FINISH_ONLY_WABA" ? "only_waba" : event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" ? "business_app" : "other";
    return { type: "finish", flow, phoneNumberId: idOrNull(data2.phone_number_id), wabaId: idOrNull(data2.waba_id), businessId: idOrNull(data2.business_id) };
  }
  return null;
}

/** Meta's screens in its window (a CANCEL's `current_step`, as Meta's "Embedded Signup Flow Errors" lists them), in words. */
const SIGNUP_STEPS: Record<string, string> = {
  BUSINESS_ACCOUNT_SELECTION: "choosing the business portfolio",
  WABA_PHONE_PROFILE_PICKER: "choosing the WhatsApp Business account",
  WHATSAPP_BUSINESS_PROFILE_SETUP: "creating the WhatsApp Business account",
  PHONE_NUMBER_SETUP: "adding the phone number",
  PHONE_NUMBER_VERIFICATION: "verifying the phone number",
  PERMISSIONS: "reviewing permissions",
};

/** Meta's screens in its window, in words (the step a person closed it at). */
export function signupStepLabel(step: string | null | undefined): string | null {
  if (!step) return null;
  return SIGNUP_STEPS[step.toUpperCase()] ?? step.toLowerCase().replace(/_/g, " ");
}

/**
 * Whether Meta's window may have stopped on Meta's own limits for the business portfolio rather
 * than been closed by choice: anywhere but the phone number and permissions, or before Meta said
 * where. An unverified business may create only a few WhatsApp Business accounts, one whose
 * verification is still pending none, a restricted one none; and Meta's window has been seen
 * crashing while it tried to say so (a blank screen, "Unexpected null value
 * [WhatsAppBizxPlatformMetaBusinessAccountIntegrityLimitView.react]" in its console, 2026-10-25),
 * with no message for this page. Only Meta's side can lift those limits.
 */
export function signupMayBeMetaLimit(step: string | null | undefined): boolean {
  const s = step?.toUpperCase() ?? "";
  return !s.includes("PHONE_NUMBER") && s !== "PERMISSIONS";
}

// ---------------------------------------------------------------------------
// Workflows: trigger → conditions → message → timing
// ---------------------------------------------------------------------------

export const WORKFLOW_TRIGGERS = ["order_created", "order_paid", "order_fulfilled", "order_cancelled", "checkout_abandoned", "customer_created", "custom_event", "message_received"] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export interface TriggerInfo {
  label: string;
  /** What starts it, in a sentence a store owner understands. */
  when: string;
  /** Shopify's webhook topics that start it (none for custom events and customers' messages). */
  topics: string[];
  /** The values its messages can use. */
  variables: VariableSource[];
  /** The kind of template it usually sends (marketing ones only reach opted-in customers). */
  category: TemplateCategory;
  /**
   * What it sends: an approved template, or (a customer's message) a reply the merchant writes,
   * which WhatsApp allows without a template because the customer has just written.
   */
  sends: "template" | "reply";
}

const ORDER_VARS: VariableSource[] = ["customer_first_name", "store_name", "order_number", "order_total", "order_status_url", "product_names", "custom_text"];

export const TRIGGER_INFO: Record<WorkflowTrigger, TriggerInfo> = {
  order_created: { label: "New order", when: "A customer places an order in your Shopify store.", topics: ["orders/create"], variables: ORDER_VARS, category: "UTILITY", sends: "template" },
  order_paid: { label: "Order paid", when: "An order is paid, including cash on delivery or bank transfer orders paid later.", topics: ["orders/paid"], variables: ORDER_VARS, category: "UTILITY", sends: "template" },
  order_fulfilled: {
    label: "Order shipped",
    when: "You fulfill an order in Shopify (all of it, or the first parcel).",
    topics: ["orders/fulfilled", "orders/partially_fulfilled"],
    variables: [...ORDER_VARS, "tracking_number", "tracking_url", "carrier"],
    category: "UTILITY",
    sends: "template",
  },
  order_cancelled: { label: "Order cancelled", when: "An order is cancelled in Shopify.", topics: ["orders/cancelled"], variables: ORDER_VARS, category: "UTILITY", sends: "template" },
  checkout_abandoned: {
    label: "Checkout abandoned",
    when: "A customer gives a phone number in checkout and doesn't finish within the wait you choose.",
    topics: ["checkouts/create", "checkouts/update"],
    variables: ["customer_first_name", "store_name", "product_names", "order_total", "checkout_url", "custom_text"],
    category: "MARKETING",
    sends: "template",
  },
  customer_created: {
    label: "New customer",
    when: "A customer creates an account or is added in Shopify.",
    topics: ["customers/create"],
    variables: ["customer_first_name", "store_name", "custom_text"],
    category: "MARKETING",
    sends: "template",
  },
  custom_event: {
    label: "Custom event",
    when: "Your booking tool, form or another app sends bizinsights an event (an appointment, a service visit, a sign-up).",
    topics: [],
    variables: ["customer_first_name", "store_name", "event_date", "event_time", "event_value", "custom_text"],
    category: "UTILITY",
    sends: "template",
  },
  message_received: {
    label: "Customer sends a message",
    when: "A customer writes to your WhatsApp number. STOP, START and \"stop promotions\" are handled by bizinsights and never start a workflow.",
    topics: [],
    variables: [],
    category: "UTILITY",
    sends: "reply",
  },
};

export const CONDITION_FIELDS = ["order_total", "country", "product", "customer_type", "order_tag", "payment_method", "message_text", "received_at"] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

const hourSchema = z.number().int().min(0).max(23);

export const workflowConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("order_total"), op: z.enum(["gte", "lte"]), value: z.number().min(0).max(1e9) }),
  z.object({ field: z.literal("country"), op: z.enum(["in", "not_in"]), value: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(50) }),
  z.object({ field: z.literal("product"), op: z.literal("contains"), value: z.string().trim().min(1).max(100) }),
  z.object({ field: z.literal("customer_type"), op: z.literal("is"), value: z.enum(["new", "returning"]) }),
  z.object({ field: z.literal("order_tag"), op: z.enum(["has", "lacks"]), value: z.string().trim().min(1).max(60) }),
  z.object({ field: z.literal("payment_method"), op: z.literal("contains"), value: z.string().trim().min(1).max(60) }),
  /** The customer's message contains one of these words or phrases (any case). */
  z.object({ field: z.literal("message_text"), op: z.literal("contains_any"), value: z.array(z.string().trim().min(1).max(60)).min(1).max(20) }),
  /** The customer wrote outside (or within) these store-time hours: an "away" message, or business hours only. */
  z.object({ field: z.literal("received_at"), op: z.enum(["outside_hours", "within_hours"]), value: z.object({ start: hourSchema, end: hourSchema }).refine((w) => w.start !== w.end, "The start and end can't be the same hour") }),
]);
export type WorkflowCondition = z.output<typeof workflowConditionSchema>;

const ORDER_CONDITIONS: ConditionField[] = ["order_total", "country", "product", "customer_type", "order_tag", "payment_method"];

/** Which conditions make sense for which trigger. */
export function conditionFieldsFor(trigger: WorkflowTrigger): ConditionField[] {
  if (trigger === "custom_event") return [];
  if (trigger === "message_received") return ["message_text", "received_at"];
  if (trigger === "customer_created") return ["country"];
  if (trigger === "checkout_abandoned") return ["order_total", "country", "product", "customer_type"];
  return [...ORDER_CONDITIONS];
}

/** What an event says about the order, checkout, customer or message it is about. Unknown facts are null. */
export interface WorkflowFacts {
  orderTotal: number | null;
  country: string | null;
  productTitles: string[];
  /** "new": their first order; "returning": they ordered before; null when Shopify didn't say. */
  customerType: "new" | "returning" | null;
  tags: string[];
  paymentMethods: string[];
  /** A customer's message: what it says (null for media without a caption). */
  messageText?: string | null;
  /** A customer's message: the hour (0-23, store time) it was written. */
  localHour?: number | null;
}

export const CONDITION_LABEL: Record<ConditionField, string> = {
  order_total: "Order total",
  country: "Customer's country",
  product: "Products ordered",
  customer_type: "Customer",
  order_tag: "Order tags",
  payment_method: "Payment method",
  message_text: "Words in the message",
  received_at: "Time it arrives",
};

const hour12 = (h: number) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
/** Whether a store-time hour is inside start..end (end not included; a window may run past midnight). */
const hourIn = (hour: number, start: number, end: number) => (start < end ? hour >= start && hour < end : hour >= start || hour < end);

/** A condition in words: "Order total is at least 50". */
export function describeCondition(c: WorkflowCondition): string {
  switch (c.field) {
    case "order_total":
      return `Order total is ${c.op === "gte" ? "at least" : "at most"} ${c.value}`;
    case "country":
      return `Customer's country is ${c.op === "in" ? "" : "not "}${c.value.join(", ")}`;
    case "product":
      return `A product's name contains "${c.value}"`;
    case "customer_type":
      return c.value === "new" ? "It's the customer's first order" : "The customer has ordered before";
    case "order_tag":
      return `The order ${c.op === "has" ? "has" : "doesn't have"} the tag "${c.value}"`;
    case "payment_method":
      return `The payment method contains "${c.value}"`;
    case "message_text":
      return `The message contains ${c.value.map((w) => `"${w}"`).join(" or ")}`;
    case "received_at":
      return `It arrives ${c.op === "outside_hours" ? "outside" : "between"} ${hour12(c.value.start)} ${c.op === "outside_hours" ? "to" : "and"} ${hour12(c.value.end)} (store time)`;
  }
}

/** Whether every condition holds (an unknown fact fails a condition that needs it). */
export function evaluateWorkflowConditions(conditions: WorkflowCondition[], f: WorkflowFacts): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  for (const c of conditions) {
    let ok: boolean;
    switch (c.field) {
      case "order_total":
        ok = f.orderTotal !== null && (c.op === "gte" ? f.orderTotal >= c.value : f.orderTotal <= c.value);
        break;
      case "country":
        ok = f.country !== null && (c.op === "in") === c.value.includes(f.country.toUpperCase());
        break;
      case "product":
        ok = f.productTitles.some((t) => t.toLowerCase().includes(c.value.toLowerCase()));
        break;
      case "customer_type":
        ok = f.customerType === c.value;
        break;
      case "order_tag": {
        const has = f.tags.some((t) => t.toLowerCase() === c.value.toLowerCase());
        ok = c.op === "has" ? has : !has;
        break;
      }
      case "payment_method":
        ok = f.paymentMethods.some((p) => p.toLowerCase().includes(c.value.toLowerCase()));
        break;
      case "message_text": {
        const text = (f.messageText ?? "").toLowerCase();
        ok = !!text && c.value.some((w) => text.includes(w.toLowerCase()));
        break;
      }
      case "received_at": {
        const h = f.localHour;
        ok = h !== null && h !== undefined && (c.op === "within_hours") === hourIn(h, c.value.start, c.value.end);
        break;
      }
    }
    if (!ok) failed.push(describeCondition(c));
  }
  return { pass: failed.length === 0, failed };
}

/**
 * When the message goes: `after_trigger` (minutes after the event; 0 = at once) or, for custom events
 * with a time (appointments), `before_event` (minutes before it).
 */
export const timingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("after_trigger"), minutes: z.number().int().min(0).max(30 * 24 * 60) }),
  z.object({ mode: z.literal("before_event"), minutes: z.number().int().min(0).max(30 * 24 * 60) }),
]);
export type WorkflowTiming = z.output<typeof timingSchema>;

/** Hours (store time) marketing messages may go out; a message due outside them waits for the next start. */
export const sendWindowSchema = z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).refine((w) => w.start !== w.end, "The start and end can't be the same hour");
export const DEFAULT_SEND_WINDOW = { start: 9, end: 20 };

export const templateRefSchema = z.object({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(10) });

/** The longest automatic reply to a customer's message (Meta allows 4,096 characters; replies should be short). */
export const REPLY_MAX_LENGTH = 1000;
/** A reply waits at most this long: WhatsApp's 24-hour window must still be open when it goes. */
export const REPLY_MAX_DELAY_MINUTES = 12 * 60;
/** By default the same customer gets a workflow's reply at most once a day, so a conversation isn't answered over and over. */
export const DEFAULT_REPLY_COOLDOWN_MINUTES = 24 * 60;

export const workflowSchema = z
  .object({
    name: z.string().trim().min(1, "Name the workflow").max(80),
    trigger: z.enum(WORKFLOW_TRIGGERS),
    /** Custom events only: which event name starts it ("appointment_booked"). */
    eventName: z.string().trim().regex(/^[a-z0-9_.-]{1,60}$/i, "Use letters, numbers, dots, dashes and underscores").nullable().optional(),
    conditions: z.array(workflowConditionSchema).max(10).default([]),
    /** The approved template it sends; none for a "Customer sends a message" workflow, which replies with `replyText`. */
    template: templateRefSchema.nullable().optional(),
    mapping: mappingSchema,
    headerMediaUrl: z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "Links must start with https://").nullable().optional(),
    /** "Customer sends a message" only: the reply, as written (no variables). */
    replyText: z.string().trim().max(REPLY_MAX_LENGTH, `Keep the reply under ${REPLY_MAX_LENGTH} characters`).nullable().optional(),
    /** "Customer sends a message" only: the same customer gets the reply at most once in this many minutes (0: every message). */
    replyCooldownMinutes: z.number().int().min(0).max(30 * 24 * 60).nullable().optional(),
    timing: timingSchema.default({ mode: "after_trigger", minutes: 0 }),
    /** Null: any hour. Marketing workflows default to DEFAULT_SEND_WINDOW. */
    sendWindow: sendWindowSchema.nullable().optional(),
  })
  .superRefine((w, ctx) => {
    if (w.trigger === "custom_event" && !w.eventName) ctx.addIssue({ code: "custom", path: ["eventName"], message: "Name the event that starts this workflow" });
    if (TRIGGER_INFO[w.trigger].sends === "reply") {
      if (!w.replyText) ctx.addIssue({ code: "custom", path: ["replyText"], message: "Write the reply customers receive" });
      if (w.template) ctx.addIssue({ code: "custom", path: ["template"], message: "A reply to a customer's message is your own text, not a template" });
      if (w.timing.minutes > REPLY_MAX_DELAY_MINUTES) ctx.addIssue({ code: "custom", path: ["timing"], message: "Reply within 12 hours: WhatsApp only allows replies without a template for 24 hours after the customer writes" });
    } else {
      if (!w.template) ctx.addIssue({ code: "custom", path: ["template"], message: "Choose the approved template to send" });
      if (w.replyText) ctx.addIssue({ code: "custom", path: ["replyText"], message: "Only a workflow answering a customer's message sends a reply of its own" });
    }
    if (w.timing.mode === "before_event" && w.trigger !== "custom_event") ctx.addIssue({ code: "custom", path: ["timing"], message: '"Before the event" only works with custom events that send a time' });
    if (w.trigger === "checkout_abandoned" && w.timing.minutes < 30) ctx.addIssue({ code: "custom", path: ["timing"], message: "Wait at least 30 minutes before reminding about a checkout" });
    const allowed = new Set(conditionFieldsFor(w.trigger));
    w.conditions.forEach((c, i) => {
      if (!allowed.has(c.field)) ctx.addIssue({ code: "custom", path: ["conditions", i], message: `${CONDITION_LABEL[c.field]} can't be checked for ${TRIGGER_INFO[w.trigger].label.toLowerCase()}` });
    });
    const vars = new Set(TRIGGER_INFO[w.trigger].variables);
    for (const r of [...w.mapping.body, ...w.mapping.buttons, ...(w.mapping.header ? [w.mapping.header] : [])]) {
      if (!vars.has(r.source)) ctx.addIssue({ code: "custom", path: ["mapping"], message: `${VARIABLE_INFO[r.source].label} isn't known for ${TRIGGER_INFO[w.trigger].label.toLowerCase()}` });
      if (r.source === "custom_text" && !r.text) ctx.addIssue({ code: "custom", path: ["mapping"], message: "Write the fixed text" });
      if (r.source === "event_value" && !r.text) ctx.addIssue({ code: "custom", path: ["mapping"], message: "Name the event value to use" });
    }
  });
export type WorkflowInput = z.output<typeof workflowSchema>;

export const WORKFLOW_STATUSES = ["draft", "active", "paused"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * Where a store's automation stands, in one word the dashboard shows: what the merchant can rely on.
 *  - disconnected: no WhatsApp number connected;
 *  - paused: the merchant paused all automation;
 *  - needs_attention: connected, but something stops messages (reconnect, a step, no webhooks, a
 *    switched-on workflow that can't send);
 *  - idle: working, but no workflow is switched on;
 *  - active: working, and at least one workflow is on with nothing stopping it.
 */
export type AutomationState = "disconnected" | "paused" | "needs_attention" | "idle" | "active";

export const AUTOMATION_STATE_LABEL: Record<AutomationState, string> = {
  disconnected: "Disconnected",
  paused: "Paused",
  needs_attention: "Needs attention",
  idle: "No workflow on",
  active: "Active",
};

export function automationState(f: {
  connection: { status: string; registered: boolean; subscribed: boolean } | null;
  paused: boolean;
  activeWorkflows: number;
  /** Switched-on workflows that something stops from sending. */
  blockedWorkflows: number;
}): AutomationState {
  const c = f.connection;
  if (!c || c.status === "disconnected") return "disconnected";
  if (f.paused) return "paused";
  if (c.status !== "active" || !c.registered || !c.subscribed || f.blockedWorkflows > 0) return "needs_attention";
  return f.activeWorkflows > 0 ? "active" : "idle";
}

/** Ready-made workflows the builder starts from (a starter template it is written for, or a reply of its own). */
export const WORKFLOW_PRESETS: Array<{
  key: string;
  title: string;
  description: string;
  trigger: WorkflowTrigger;
  starter?: string;
  timing: WorkflowTiming;
  eventName?: string;
  replyText?: string;
  replyCooldownMinutes?: number;
  conditions?: WorkflowCondition[];
}> = [
  { key: "order_confirmation", title: "Order confirmation", description: "Thank customers and confirm every new order.", trigger: "order_created", starter: "order_confirmation", timing: { mode: "after_trigger", minutes: 0 } },
  { key: "shipping_update", title: "Shipping update", description: "Tell customers their order is on its way, with tracking.", trigger: "order_fulfilled", starter: "shipping_update", timing: { mode: "after_trigger", minutes: 0 } },
  { key: "abandoned_checkout", title: "Abandoned checkout reminder", description: "Remind opted-in customers about an unfinished checkout after an hour.", trigger: "checkout_abandoned", starter: "abandoned_checkout", timing: { mode: "after_trigger", minutes: 60 } },
  { key: "follow_up", title: "Customer follow-up", description: "Check in with customers a week after their order ships.", trigger: "order_fulfilled", starter: "follow_up", timing: { mode: "after_trigger", minutes: 7 * 24 * 60 } },
  { key: "welcome", title: "Welcome new customers", description: "Greet new customers who agreed to marketing.", trigger: "customer_created", starter: "welcome", timing: { mode: "after_trigger", minutes: 10 } },
  { key: "appointment_reminder", title: "Appointment reminder", description: "Remind customers a day before a booking your booking tool sends.", trigger: "custom_event", starter: "appointment_reminder", timing: { mode: "before_event", minutes: 24 * 60 }, eventName: "appointment_booked" },
  {
    key: "support_reply",
    title: "Support auto-reply",
    description: "Tell customers who write to you that their message arrived and when you'll answer.",
    trigger: "message_received",
    timing: { mode: "after_trigger", minutes: 0 },
    replyText: "Thanks for your message! We've received it and will reply as soon as we can, usually within a few hours.",
    replyCooldownMinutes: DEFAULT_REPLY_COOLDOWN_MINUTES,
  },
  {
    key: "away_message",
    title: "Away message",
    description: "Answer customers who write outside your opening hours.",
    trigger: "message_received",
    timing: { mode: "after_trigger", minutes: 0 },
    replyText: "Thanks for getting in touch! We're closed right now and will reply when we open.",
    replyCooldownMinutes: 12 * 60,
    conditions: [{ field: "received_at", op: "outside_hours", value: { start: 9, end: 17 } }],
  },
];

/** A custom event another tool (or the dashboard's test) sends: who it is for, when, and its values. */
export const customEventSchema = z.object({
  event: z.string().trim().regex(/^[a-z0-9_.-]{1,60}$/i),
  /** Unique per event in your tool, so a repeat doesn't message twice. */
  eventId: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(6).max(40),
  /** ISO country of the number, when it is written without +. */
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  firstName: z.string().trim().max(60).optional(),
  /** When the appointment or event happens (needed for "before the event" timing). */
  at: z.string().datetime({ offset: true }).optional(),
  values: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/i), z.string().max(300)).refine((v) => Object.keys(v).length <= 20, "At most 20 values").optional(),
  /** The customer agreed to marketing on WhatsApp in your tool (recorded as consent from "your team"). */
  marketingConsent: z.boolean().optional(),
});
export type CustomEventInput = z.output<typeof customEventSchema>;

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const audienceSchema = z.object({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).default([]),
  customerType: z.enum(["any", "new", "returning"]).default("any"),
  /** Ordered within the last N days. */
  orderedWithinDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** Haven't ordered for N days (win-back). */
  notOrderedForDays: z.number().int().min(1).max(3650).nullable().optional(),
  minOrders: z.number().int().min(1).max(10000).nullable().optional(),
  minSpent: z.number().min(0).max(1e9).nullable().optional(),
});
export type CampaignAudience = z.output<typeof audienceSchema>;

/** An audience in words. Everyone in it agreed to marketing and didn't reply STOP; that is always true. */
export function describeAudience(a: CampaignAudience): string {
  const parts: string[] = [];
  if (a.customerType === "new") parts.push("with one order");
  if (a.customerType === "returning") parts.push("who ordered more than once");
  if (a.minOrders) parts.push(`with at least ${a.minOrders} orders`);
  if (a.minSpent) parts.push(`who spent at least ${a.minSpent}`);
  if (a.orderedWithinDays) parts.push(`who ordered in the last ${a.orderedWithinDays} days`);
  if (a.notOrderedForDays) parts.push(`who haven't ordered for ${a.notOrderedForDays} days`);
  if (a.countries.length) parts.push(`in ${a.countries.join(", ")}`);
  return `Customers who agreed to WhatsApp marketing${parts.length ? ` ${parts.join(", ")}` : ""}`;
}

export const campaignSchema = z.object({
  name: z.string().trim().min(1, "Name the campaign").max(80),
  template: templateRefSchema,
  mapping: mappingSchema,
  headerMediaUrl: z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "Links must start with https://").nullable().optional(),
  audience: audienceSchema,
});
export type CampaignInput = z.output<typeof campaignSchema>;

/** Variables a campaign can fill: it has no order, only the customer and the store. */
export const CAMPAIGN_VARIABLES: VariableSource[] = ["customer_first_name", "store_name", "custom_text"];

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type CampaignAction = "edit" | "schedule" | "cancel" | "delete" | "test";

const CAMPAIGN_ACTIONS: Record<CampaignAction, CampaignStatus[]> = {
  edit: ["draft"],
  test: ["draft", "scheduled"],
  schedule: ["draft"],
  cancel: ["scheduled", "sending"],
  delete: ["draft", "cancelled"],
};
export const campaignCan = (status: string, action: CampaignAction) => (CAMPAIGN_ACTIONS[action] as string[]).includes(status);

/** Messages a campaign hands to Meta per second, per store (well under Meta's 80 per second per number). */
export const CAMPAIGN_SENDS_PER_SECOND = 10;
/** The most recipients one campaign may have. */
export const CAMPAIGN_MAX_RECIPIENTS = 100_000;
