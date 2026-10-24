/**
 * Customer Messaging (SMS through AWS End User Messaging): the pure parts. How a message is
 * encoded and split into billed parts, the template variables and how untrusted values are
 * cleaned before they go into a text, what each Shopify event offers a template, the template,
 * rule and campaign life cycles, who may receive what (consent), how AWS's delivery events and
 * errors map to a message's status, retries, budgets and quiet hours. Everything that touches
 * the network or the database is in packages/core/src/sms.
 *
 * Imported by the UI through `@app/shared/sms`: no I/O, no node: imports.
 */
import { z } from "./zod";
import { addDays, customRangeProblem, isDay } from "./dates";
import { maskPhone, nextSendTime } from "./whatsapp";

// ---------------------------------------------------------------------------
// Encoding and message parts
// ---------------------------------------------------------------------------

/**
 * GSM 03.38, the 7-bit alphabet every handset reads. A text made only of these goes out as GSM-7
 * (160 characters in one part); one character outside it turns the whole text into UCS-2 (70).
 */
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** The extension table: each of these costs two septets (an escape and the character). */
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

export type SmsEncoding = "GSM" | "UCS2";

export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Characters as the merchant sees them (code points). */
  characters: number;
  /** What the parts are counted in: septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  /** Billed message parts. 0 for an empty text. */
  segments: number;
  /** Units one part holds at this length (160/153 GSM-7, 70/67 UCS-2). */
  perSegment: number;
  /** Units left in the last part before another one starts. */
  remaining: number;
  /** The characters that forced UCS-2, each once, in the order they appear. */
  nonGsm: string[];
}

/** Longest text AWS accepts (SendTextMessage MessageBody, characters). */
export const SMS_MAX_BODY = 1600;
/** Longest text bizinsights lets a template render to: past this the cost and the carriers' filtering both climb. */
export const SMS_MAX_SEGMENTS = 6;

/**
 * How a text will be encoded and how many parts AWS will bill for it. Concatenated parts give up
 * room to a header (153 septets / 67 units instead of 160 / 70); an escape pair or a surrogate
 * pair is never split between two parts, so a part can end a unit early. Some countries' carriers
 * count differently; AWS reports the parts it actually billed with each delivery event.
 */
export function smsSegments(text: string): SegmentInfo {
  const chars = Array.from(text);
  const nonGsm: string[] = [];
  for (const ch of chars) if (!GSM_BASIC.has(ch) && !GSM_EXTENDED.has(ch) && !nonGsm.includes(ch)) nonGsm.push(ch);
  const encoding: SmsEncoding = nonGsm.length ? "UCS2" : "GSM";
  const widths = chars.map((ch) => (encoding === "GSM" ? (GSM_EXTENDED.has(ch) ? 2 : 1) : ch.length));
  const units = widths.reduce((a, b) => a + b, 0);
  const single = encoding === "GSM" ? 160 : 70;
  const multi = encoding === "GSM" ? 153 : 67;
  if (units === 0) return { encoding, characters: 0, units: 0, segments: 0, perSegment: single, remaining: single, nonGsm };
  if (units <= single) return { encoding, characters: chars.length, units, segments: 1, perSegment: single, remaining: single - units, nonGsm };
  let segments = 1;
  let used = 0;
  for (const w of widths) {
    if (used + w > multi) {
      segments++;
      used = 0;
    }
    used += w;
  }
  return { encoding, characters: chars.length, units, segments, perSegment: multi, remaining: multi - used, nonGsm };
}

/** Look-alikes that quietly turn a text into UCS-2 (pasted from a word processor), and their GSM-7 forms. */
const GSM_FRIENDLY: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
  "•": "-",
  "´": "'",
  "ʼ": "'",
};

/** The text with typographic quotes, dashes and ellipses replaced by their GSM-7 forms (nothing else changes). */
export function toGsmFriendly(text: string): string {
  return Array.from(text)
    .map((ch) => GSM_FRIENDLY[ch] ?? ch)
    .join("");
}

// ---------------------------------------------------------------------------
// Template variables
// ---------------------------------------------------------------------------

export const SMS_VARIABLES = [
  "customer_name",
  "store_name",
  "business_name",
  "order_number",
  "order_status",
  "order_total",
  "currency",
  "product_name",
  "tracking_url",
  "discount_code",
  "checkout_url",
  "opt_out_url",
] as const;
export type SmsVariable = (typeof SMS_VARIABLES)[number];

export interface VariableInfo {
  label: string;
  /** What the preview shows. */
  sample: string;
  /** Longest value that goes into a text: longer values are shortened (names, products) or refused (links, codes). */
  maxLength: number;
  kind: "text" | "url" | "money" | "code" | "currency";
  description: string;
}

export const SMS_VARIABLE_INFO: Record<SmsVariable, VariableInfo> = {
  customer_name: { label: "Customer first name", sample: "Sam", maxLength: 24, kind: "text", description: "The first name on the order or checkout. Only letters, spaces, hyphens and apostrophes are kept." },
  store_name: { label: "Store name", sample: "Acme Outfitters", maxLength: 40, kind: "text", description: "Your store's name in Shopify." },
  business_name: { label: "Business name", sample: "Acme", maxLength: 40, kind: "text", description: "The business name you gave in SMS setup (your store's name until you give one)." },
  order_number: { label: "Order number", sample: "#1042", maxLength: 20, kind: "code", description: "The order's name in Shopify, such as #1042." },
  order_status: { label: "Order status", sample: "confirmed", maxLength: 20, kind: "text", description: "What happened to the order, in a word: confirmed, paid, shipped, delivered, cancelled or refunded." },
  order_total: { label: "Order total", sample: "89.95", maxLength: 16, kind: "money", description: "The order total, two decimals, without a currency sign." },
  currency: { label: "Currency", sample: "AUD", maxLength: 3, kind: "currency", description: "The order's three-letter currency code." },
  product_name: { label: "Product name", sample: "Merino Crew Sweater", maxLength: 40, kind: "text", description: "The first item on the order or checkout, shortened to 40 characters; links are taken out." },
  tracking_url: { label: "Tracking link", sample: "https://track.example.com/AB123", maxLength: 300, kind: "url", description: "The carrier's tracking link Shopify has for the parcel (fulfillment and delivery messages only)." },
  discount_code: { label: "Discount code", sample: "WELCOME10", maxLength: 30, kind: "code", description: "The code you enter on the campaign or rule. Marketing messages only." },
  checkout_url: { label: "Checkout link", sample: "https://acme.myshopify.com/checkouts/c/abc123/recover", maxLength: 300, kind: "url", description: "Shopify's link back to the customer's unfinished checkout (abandoned checkout messages only)." },
  opt_out_url: { label: "Opt-out link", sample: "https://bizinsights.io/stop?c=Ab3dE9xYz1", maxLength: 80, kind: "url", description: "A link that stops your marketing texts to this number at once. Required in every marketing message." },
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export interface TemplateVariables {
  /** Known variables, each once, in the order they first appear. */
  used: SmsVariable[];
  /** `{{names}}` that aren't variables. */
  unknown: string[];
  /** Braces that don't form a placeholder: `{{name}` or `{customer_name}}`. */
  malformed: boolean;
}

export const isSmsVariable = (name: string): name is SmsVariable => (SMS_VARIABLES as readonly string[]).includes(name);

export function templateVariables(body: string): TemplateVariables {
  const used: SmsVariable[] = [];
  const unknown: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (isSmsVariable(name)) {
      if (!used.includes(name)) used.push(name);
    } else if (!unknown.includes(name)) unknown.push(name);
  }
  const rest = body.replace(PLACEHOLDER, "");
  return { used, unknown, malformed: /\{\{|\}\}/.test(rest) };
}

/**
 * Names people write for a variable that has another name here ({{order_id}} for
 * {{order_number}}): the editor offers to fix them, and the "unknown variable" error says which
 * one was meant.
 */
export const SMS_VARIABLE_ALIASES: Record<string, SmsVariable> = {
  order_id: "order_number",
  order: "order_number",
  order_no: "order_number",
  name: "customer_name",
  first_name: "customer_name",
  customer: "customer_name",
  business: "business_name",
  brand: "business_name",
  company_name: "business_name",
  shop_name: "store_name",
  status: "order_status",
  total: "order_total",
  tracking_link: "tracking_url",
  tracking: "tracking_url",
  product: "product_name",
};

/** The body with every aliased placeholder written as the variable it means ({{order_id}} → {{order_number}}). */
export function fixVariableAliases(body: string): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => {
    const meant = SMS_VARIABLE_ALIASES[name.toLowerCase()] ?? (isSmsVariable(name.toLowerCase()) ? name.toLowerCase() : null);
    return meant ? `{{${meant}}}` : whole;
  });
}

/** Control characters and the bidirectional overrides that can make a text read differently from what it says. */
function unsafeChar(cp: number): boolean {
  return (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069) || cp === 0xfeff;
}
const stripUnsafe = (s: string) => Array.from(s).filter((ch) => !unsafeChar(ch.codePointAt(0)!)).join("");

/** Anything that reads as a link inside a value that isn't one ("Visit evil.example"): taken out of names and products. */
const LINK_LIKE = /(https?:\/\/|www\.)\S*|\b[a-z0-9-]+\.(com|net|org|io|co|ly|me|info|biz|xyz|app|link|site|shop|store)(\/\S*)?\b/gi;

const clip = (s: string, max: number) => (Array.from(s).length <= max ? s : `${Array.from(s).slice(0, max - 1).join("")}…`);

/** A link a message may carry: http(s), a host with a dot, no spaces or quotes, no credentials. */
export function safeUrl(raw: string | null | undefined, opts: { httpsOnly?: boolean; max?: number; local?: boolean } = {}): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || /[\s"'<>`]/.test(s) || s.length > (opts.max ?? 300)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && (opts.httpsOnly || u.protocol !== "http:")) return null;
    if ((!opts.local && !u.hostname.includes(".")) || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * A value as it may go into a text, or null when it can't go in safely (the message is then not
 * sent: a broken link or an empty name is worse than no message). Values come from Shopify and
 * from what customers typed, so none of them is trusted: control characters and direction
 * overrides go, line breaks become spaces, names lose anything that isn't part of a name,
 * products lose anything that looks like a link, and links and codes must have their exact shape.
 */
export function cleanVariable(variable: SmsVariable, raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const info = SMS_VARIABLE_INFO[variable];
  const text = stripUnsafe(String(raw)).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!text) return null;
  switch (variable) {
    case "customer_name": {
      const first = text.split(" ")[0] ?? "";
      const name = first.replace(/[^\p{L}\p{M}'’-]/gu, "");
      return name ? clip(name, info.maxLength) : null;
    }
    case "order_status":
      return /^[a-z][a-z ]{0,19}$/.test(text) ? text : null;
    case "store_name":
    case "business_name":
    case "product_name": {
      const v = text.replace(LINK_LIKE, "").replace(/\s{2,}/g, " ").trim();
      return v ? clip(v, info.maxLength) : null;
    }
    case "order_number":
      return /^[#A-Za-z0-9_-]{1,20}$/.test(text) ? text : null;
    case "order_total": {
      const n = Number(text);
      return Number.isFinite(n) && n >= 0 && n < 1e12 ? n.toFixed(2) : null;
    }
    case "currency":
      return /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : null;
    case "discount_code":
      return /^[A-Za-z0-9_-]{1,30}$/.test(text) ? text : null;
    case "tracking_url":
      return safeUrl(text, { max: info.maxLength });
    case "checkout_url":
      return safeUrl(text, { httpsOnly: true, max: info.maxLength });
    case "opt_out_url":
      // Ours (APP_URL's /stop page), not the customer's or Shopify's: a local server's http://localhost one passes too.
      return safeUrl(text, { local: true, max: info.maxLength });
  }
}

export type SmsValues = Partial<Record<SmsVariable, string | number | null | undefined>>;

export type RenderResult = { ok: true; text: string; segments: SegmentInfo } | { ok: false; missing: SmsVariable[]; invalid: SmsVariable[]; unknown: string[] };

/**
 * The text a template turns into for one customer. Every variable it uses must have a value that
 * survives `cleanVariable`; otherwise nothing is rendered and the caller records why.
 */
export function renderSms(body: string, values: SmsValues): RenderResult {
  const vars = templateVariables(body);
  const missing: SmsVariable[] = [];
  const invalid: SmsVariable[] = [];
  const clean: Partial<Record<SmsVariable, string>> = {};
  for (const v of vars.used) {
    const raw = values[v];
    if (raw === null || raw === undefined || String(raw).trim() === "") {
      missing.push(v);
      continue;
    }
    const c = cleanVariable(v, raw);
    if (c === null) invalid.push(v);
    else clean[v] = c;
  }
  if (missing.length || invalid.length || vars.unknown.length || vars.malformed) return { ok: false, missing, invalid, unknown: vars.unknown };
  const text = body.replace(PLACEHOLDER, (_, name: string) => clean[name as SmsVariable] ?? "").trim();
  return { ok: true, text, segments: smsSegments(text) };
}

/** The template with each variable's sample value: what the editor's preview shows. */
export function previewSms(body: string, overrides: SmsValues = {}): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => {
    if (!isSmsVariable(name)) return whole;
    const v = overrides[name] ?? SMS_VARIABLE_INFO[name].sample;
    return cleanVariable(name, v) ?? SMS_VARIABLE_INFO[name].sample;
  });
}

/**
 * The longest the template can get: each variable at its longest. What the editor shows as "up
 * to N parts", since one customer's long name can tip a text into another part. (A name with a
 * letter outside GSM-7 can also turn one customer's text into UCS-2; the parts AWS billed are on
 * each message.)
 */
export function worstCaseSegments(body: string): SegmentInfo {
  return smsSegments(body.replace(PLACEHOLDER, (whole, name: string) => (isSmsVariable(name) ? "x".repeat(SMS_VARIABLE_INFO[name].maxLength) : whole)));
}

// ---------------------------------------------------------------------------
// India: DLT templates
// ---------------------------------------------------------------------------

/**
 * TRAI's DLT registers each template with `{#var#}` where the variable parts go, and carriers
 * reject a text whose fixed parts differ from the registered ones. This is the template in that
 * form, to compare with what the merchant registered.
 */
export const dltShape = (body: string) => body.replace(PLACEHOLDER, "{#var#}").replace(/\r\n/g, "\n").trim();

/** Whether a template is exactly the DLT template registered for it (only the variables may differ). */
export function dltMatches(body: string, registered: string | null | undefined): boolean {
  if (!registered) return false;
  return dltShape(body) === registered.replace(/\r\n/g, "\n").trim();
}

/** DLT caps each variable at 30 characters. */
export const DLT_MAX_VALUE = 30;

// ---------------------------------------------------------------------------
// Template rules
// ---------------------------------------------------------------------------

export const SMS_CATEGORIES = ["transactional", "marketing"] as const;
export type SmsCategory = (typeof SMS_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<SmsCategory, string> = {
  transactional: "Transactional (order and delivery updates)",
  marketing: "Marketing (offers, reminders, promotions)",
};

/** Variables only marketing messages may carry: a discount or a nudge back to checkout is promotion. */
const MARKETING_ONLY: SmsVariable[] = ["discount_code", "checkout_url"];

/** Public link shorteners: carriers filter texts carrying them as likely spam. */
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)\b/i;

export interface TemplateIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface TemplateCheckInput {
  category: SmsCategory;
  body: string;
  /** India: the DLT template as registered, and its id. */
  dltTemplateId?: string | null;
  dltText?: string | null;
  /** Whether the template is meant for India (a DLT template is then required). */
  forIndia?: boolean;
}

/** What is wrong with a template (errors block review and sending; warnings don't). */
export function checkTemplate(t: TemplateCheckInput): TemplateIssue[] {
  const out: TemplateIssue[] = [];
  const body = t.body ?? "";
  const vars = templateVariables(body);
  if (!body.trim()) out.push({ level: "error", code: "empty", message: "Write the message." });
  if (Array.from(body).length > SMS_MAX_BODY) out.push({ level: "error", code: "too_long", message: `Messages can be at most ${SMS_MAX_BODY} characters.` });
  if (vars.unknown.length) {
    const meant = vars.unknown.map((u) => [u, SMS_VARIABLE_ALIASES[u.toLowerCase()] ?? (isSmsVariable(u.toLowerCase()) ? u.toLowerCase() : null)] as const).filter((p): p is readonly [string, SmsVariable] => !!p[1]);
    const hint = meant.length ? ` Did you mean ${meant.map(([, v]) => `{{${v}}}`).join(", ")}?` : "";
    out.push({ level: "error", code: "unknown_variable", message: `Unknown variable${vars.unknown.length > 1 ? "s" : ""}: ${vars.unknown.map((u) => `{{${u}}}`).join(", ")}.${hint}` });
  }
  if (vars.malformed) out.push({ level: "error", code: "malformed", message: "A variable isn't closed: write it as {{variable_name}}." });
  if (t.category === "transactional") {
    const promo = vars.used.filter((v) => MARKETING_ONLY.includes(v));
    if (promo.length) out.push({ level: "error", code: "promotional_variable", message: `${promo.map((v) => `{{${v}}}`).join(" and ")} make this a marketing message: choose Marketing, which only reaches customers who agreed to marketing texts.` });
    if (vars.used.includes("opt_out_url")) out.push({ level: "warning", code: "opt_out_in_transactional", message: "Order updates don't need an opt-out link; customers who opt out of marketing still get them." });
  }
  if (t.category === "marketing") {
    if (!vars.used.includes("opt_out_url")) out.push({ level: "error", code: "no_opt_out", message: "Marketing messages must tell customers how to stop them: add {{opt_out_url}} (for example \"Opt out: {{opt_out_url}}\")." });
    if (!vars.used.includes("store_name") && !vars.used.includes("business_name")) out.push({ level: "warning", code: "no_sender_name", message: "Say who the message is from: add {{business_name}}, unless your sender ID already shows it." });
  }
  if (SHORTENERS.test(body)) out.push({ level: "warning", code: "link_shortener", message: "Carriers often block texts with public link shorteners. Use your own domain's links." });
  const worst = worstCaseSegments(body);
  if (body.trim() && worst.segments > SMS_MAX_SEGMENTS) out.push({ level: "error", code: "too_many_parts", message: `With long names and links this can reach ${worst.segments} parts; keep it to ${SMS_MAX_SEGMENTS} at most.` });
  else if (body.trim() && worst.segments > 2) out.push({ level: "warning", code: "many_parts", message: `This can reach ${worst.segments} billed parts per customer.` });
  const enc = smsSegments(body);
  if (enc.encoding === "UCS2") {
    const fixable = enc.nonGsm.filter((c) => GSM_FRIENDLY[c]);
    out.push({
      level: "warning",
      code: "unicode",
      message: fixable.length
        ? `Typographic characters (${fixable.join(" ")}) make every part hold 70 characters instead of 160. Replace them to fit more in each part.`
        : `Characters such as ${enc.nonGsm.slice(0, 5).join(" ")} make every part hold 70 characters instead of 160.`,
    });
  }
  if (t.forIndia || t.dltTemplateId || t.dltText) {
    if (!t.dltTemplateId) out.push({ level: "error", code: "dlt_template_id", message: "Messages to India need the DLT template id this text was registered under." });
    else if (!/^\d{1,30}$/.test(t.dltTemplateId)) out.push({ level: "error", code: "dlt_template_id", message: "A DLT template id is a number of up to 30 digits." });
    if (!t.dltText) out.push({ level: "error", code: "dlt_text", message: "Paste the template exactly as registered on the DLT portal, with {#var#} where the variables go." });
    else if (!dltMatches(body, t.dltText)) out.push({ level: "error", code: "dlt_mismatch", message: "This message doesn't match the registered DLT template word for word. Indian carriers reject texts that differ." });
  }
  return out;
}

export const hasErrors = (issues: TemplateIssue[]) => issues.some((i) => i.level === "error");

/**
 * A template's life: written (draft) → sent for review → approved (the version messages use) →
 * archived. Editing an approved template makes a new draft version; messages keep using the
 * approved one until the new one is approved.
 */
export const TEMPLATE_STATUSES = ["draft", "in_review", "approved", "archived"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
export const VERSION_STATUSES = ["draft", "in_review", "approved", "rejected", "superseded"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export type TemplateAction = "submit" | "approve" | "reject" | "archive" | "restore";

const TEMPLATE_FROM: Record<TemplateAction, readonly string[]> = {
  submit: ["draft"],
  approve: ["in_review"],
  reject: ["in_review"],
  archive: ["draft", "in_review", "approved"],
  restore: ["archived"],
};
/** Whether `action` can be taken on a version (or, for archive/restore, a template) in `status`. */
export const templateCan = (status: string, action: TemplateAction) => TEMPLATE_FROM[action].includes(status);

// ---------------------------------------------------------------------------
// Shopify events (what can start an automation)
// ---------------------------------------------------------------------------

export const SMS_TRIGGERS = [
  "order_created",
  "payment_completed",
  "fulfillment_created",
  "delivery_confirmed",
  "order_cancelled",
  "refund_issued",
  "checkout_abandoned",
  "customer_registered",
  "customer_birthday",
  "customer_inactive",
  "customer_vip",
] as const;
export type SmsTrigger = (typeof SMS_TRIGGERS)[number];

export interface TriggerInfo {
  label: string;
  /** The category a template for it must have. */
  category: SmsCategory;
  /** What tells bizinsights it happened (verified against Shopify Admin API 2026-10). */
  source: string;
  /** Variables it can fill; anything else in the template would be missing. */
  variables: SmsVariable[];
  /** False: can't run on Shopify's data today, and why. */
  available: boolean;
  unavailableReason?: string;
  /** Suggested wait before sending, minutes. */
  defaultDelay: number;
}

const ORDER_VARS: SmsVariable[] = ["customer_name", "store_name", "order_number", "order_status", "order_total", "currency", "product_name"];

export const TRIGGER_INFO: Record<SmsTrigger, TriggerInfo> = {
  order_created: { label: "Order created", category: "transactional", source: "orders/create webhook", variables: ORDER_VARS, available: true, defaultDelay: 0 },
  payment_completed: { label: "Payment completed", category: "transactional", source: "orders/paid webhook (an order that wasn't paid at checkout becoming paid)", variables: ORDER_VARS, available: true, defaultDelay: 0 },
  fulfillment_created: { label: "Order shipped (fulfillment created)", category: "transactional", source: "A new fulfillment on orders/fulfilled, orders/partially_fulfilled or orders/updated", variables: [...ORDER_VARS, "tracking_url"], available: true, defaultDelay: 0 },
  delivery_confirmed: {
    label: "Delivery confirmed",
    category: "transactional",
    source: "A fulfillment whose shipment_status Shopify reports as delivered (carrier tracking)",
    variables: [...ORDER_VARS, "tracking_url"],
    available: true,
    defaultDelay: 0,
  },
  order_cancelled: { label: "Order cancelled", category: "transactional", source: "orders/cancelled webhook", variables: ORDER_VARS, available: true, defaultDelay: 0 },
  refund_issued: { label: "Refund issued", category: "transactional", source: "refunds/create webhook", variables: ORDER_VARS, available: true, defaultDelay: 0 },
  checkout_abandoned: {
    label: "Checkout abandoned",
    category: "marketing",
    source: "checkouts/create and checkouts/update webhooks with a phone number; cancelled when the order arrives",
    variables: ["customer_name", "store_name", "product_name", "checkout_url", "discount_code", "opt_out_url"],
    available: true,
    defaultDelay: 60,
  },
  customer_registered: {
    label: "Customer registered",
    category: "marketing",
    source: "customers/create webhook (subscribed for each store once it grants read_customers)",
    variables: ["customer_name", "store_name", "discount_code", "opt_out_url"],
    available: true,
    defaultDelay: 0,
  },
  customer_birthday: {
    label: "Customer birthday",
    category: "marketing",
    source: "None: Shopify customers have no birthday field",
    variables: ["customer_name", "store_name", "discount_code", "opt_out_url"],
    available: false,
    unavailableReason: "Shopify has no birthday on its customers. It needs a birthday metafield on each customer and the read_customers permission, which bizinsights doesn't read yet.",
    defaultDelay: 0,
  },
  customer_inactive: {
    label: "Inactive customer",
    category: "marketing",
    source: "Daily check: a customer with marketing consent whose last order is older than the days you set",
    variables: ["customer_name", "store_name", "discount_code", "opt_out_url"],
    available: true,
    defaultDelay: 0,
  },
  customer_vip: {
    label: "VIP customer",
    category: "marketing",
    source: "Daily check: a customer with marketing consent whose orders or spend reach what you set",
    variables: ["customer_name", "store_name", "discount_code", "opt_out_url"],
    available: true,
    defaultDelay: 0,
  },
};

/** {{order_status}} for each order event: the word a text says about the order. */
export const ORDER_STATUS_WORD: Partial<Record<SmsTrigger, string>> = {
  order_created: "confirmed",
  payment_completed: "paid",
  fulfillment_created: "shipped",
  delivery_confirmed: "delivered",
  order_cancelled: "cancelled",
  refund_issued: "refunded",
};

/** Variables a template uses that a trigger can't fill (the rule can't be approved with them). The store's and business's names are always there. */
export function missingForTrigger(body: string, trigger: SmsTrigger): SmsVariable[] {
  const can = new Set<SmsVariable>([...TRIGGER_INFO[trigger].variables, "store_name", "business_name"]);
  return templateVariables(body).used.filter((v) => !can.has(v));
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/** A customer's SMS marketing consent, as Shopify reports it (SmsMarketingConsent.marketingState, lowercased). */
export const CONSENT_STATES = ["subscribed", "not_subscribed", "unsubscribed", "pending", "redacted", "invalid", "unknown"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const CONSENT_LABEL: Record<ConsentState, string> = {
  subscribed: "Subscribed",
  not_subscribed: "Not subscribed",
  unsubscribed: "Unsubscribed",
  pending: "Confirmation pending",
  redacted: "Erased",
  invalid: "Invalid",
  unknown: "Unknown",
};

/** Shopify's state (REST `sms_marketing_consent.state` or GraphQL `marketingState`) as one of ours; anything else is unknown. */
export function consentState(raw: string | null | undefined): ConsentState {
  const s = String(raw ?? "").toLowerCase();
  return (CONSENT_STATES as readonly string[]).includes(s) ? (s as ConsentState) : "unknown";
}

/**
 * What lets bizinsights send a store's order updates by SMS. Nothing is sent until the merchant
 * chooses: a phone number alone, or a past purchase, is never taken as agreement.
 *  - checkout_notice: the merchant attests their checkout tells customers who leave a mobile number
 *    that order updates come by SMS (audited, with who chose it).
 *  - sms_consent: only customers subscribed to the store's SMS marketing in Shopify.
 */
export const SMS_TRANSACTIONAL_BASES = ["none", "checkout_notice", "sms_consent"] as const;
export type SmsTransactionalBasis = (typeof SMS_TRANSACTIONAL_BASES)[number];

export interface Recipient {
  consent: ConsentState;
  /** On the store's suppression list for everything (opt-out link, AWS opt-out list, merchant). */
  suppressedAll: boolean;
  /** On it for marketing only. */
  suppressedMarketing: boolean;
}

export type EligibilityReason = "suppressed" | "no_marketing_consent" | "no_transactional_basis" | "consent_redacted";

/** Whether a customer may receive a message of `category` now. Checked when a message is scheduled and again right before it is sent. */
export function mayReceive(category: SmsCategory, r: Recipient, basis: SmsTransactionalBasis): { ok: true } | { ok: false; reason: EligibilityReason } {
  if (r.consent === "redacted") return { ok: false, reason: "consent_redacted" };
  if (r.suppressedAll) return { ok: false, reason: "suppressed" };
  if (category === "marketing") {
    if (r.suppressedMarketing) return { ok: false, reason: "suppressed" };
    return r.consent === "subscribed" ? { ok: true } : { ok: false, reason: "no_marketing_consent" };
  }
  // Unsubscribing from marketing doesn't stop order updates; an opt-out (suppression) does.
  if (basis === "checkout_notice") return { ok: true };
  if (basis === "sms_consent") return r.consent === "subscribed" ? { ok: true } : { ok: false, reason: "no_transactional_basis" };
  return { ok: false, reason: "no_transactional_basis" };
}

/** Opt-out keywords on two-way numbers (AWS keeps its own list from these as well). */
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "remove", "arret"]);
export const isSmsStopKeyword = (text: string | null | undefined) => !!text && STOP_WORDS.has(text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " "));

export const SUPPRESSION_REASONS = ["opt_out_link", "aws_opt_out", "carrier_opt_out", "keyword_stop", "shopify_unsubscribed", "merchant", "invalid_number", "customer_redact"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];
export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  opt_out_link: "Used the opt-out link",
  aws_opt_out: "On the AWS opt-out list (replied STOP)",
  carrier_opt_out: "Opted out with the carrier",
  keyword_stop: "Replied STOP",
  shopify_unsubscribed: "Unsubscribed in Shopify",
  merchant: "Added by your team",
  invalid_number: "Number can't receive texts",
  customer_redact: "Customer data erased",
};
/** Suppressions the merchant may lift: never one the customer asked for. */
export const liftableSuppression = (reason: string) => reason === "merchant" || reason === "invalid_number";

// ---------------------------------------------------------------------------
// Message statuses and AWS's delivery events
// ---------------------------------------------------------------------------

/**
 *  - scheduled: waiting for its time (a delay, quiet hours, a held budget)
 *  - sending: claimed by a worker; the call to AWS is in flight
 *  - accepted: AWS took it (we hold its message id); nothing heard from the carrier yet
 *  - pending: the carrier is still working on it (AWS's PENDING/QUEUED/SENT)
 *  - delivered: the handset confirmed it (DELIVERED)
 *  - carrier_accepted: the carrier took it and the network gives no handset receipt (final SUCCESSFUL)
 *  - failed: AWS or the carrier refused it, or it expired
 *  - unknown: no final word from AWS within 72 hours, or AWS said UNKNOWN
 *  - uncertain: the call to AWS broke off without an answer; never re-sent on its own
 *  - opted_out: the number is on an opt-out list
 *  - skipped: bizinsights didn't send it (consent, quiet hours past, missing value…)
 *  - cancelled: no longer wanted (order completed, rule paused, campaign cancelled)
 *  - dry_run: a rule in dry-run mode recorded what it would have sent
 */
export const SMS_STATUSES = ["scheduled", "sending", "accepted", "pending", "delivered", "carrier_accepted", "failed", "unknown", "uncertain", "opted_out", "skipped", "cancelled", "dry_run"] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

export const SMS_STATUS_LABEL: Record<SmsStatus, string> = {
  scheduled: "Scheduled",
  sending: "Sending",
  accepted: "Accepted by AWS",
  pending: "With the carrier",
  delivered: "Delivered",
  carrier_accepted: "Accepted by carrier",
  failed: "Failed",
  unknown: "Unknown outcome",
  uncertain: "Outcome uncertain",
  opted_out: "Opted out",
  skipped: "Not sent",
  cancelled: "Cancelled",
  dry_run: "Dry run",
};

/** Statuses that end a message's story (no event will move it on, except a late final event for accepted/pending ones). */
export const FINAL_STATUSES: readonly SmsStatus[] = ["delivered", "carrier_accepted", "failed", "unknown", "uncertain", "opted_out", "skipped", "cancelled", "dry_run"];
export const isFinalStatus = (s: string) => (FINAL_STATUSES as readonly string[]).includes(s);
/** Statuses that mean AWS accepted the message (it costs money, whatever happens next). */
export const ACCEPTED_STATUSES: readonly SmsStatus[] = ["accepted", "pending", "delivered", "carrier_accepted", "failed", "unknown"];

/** AWS's messageStatus values that are failures when final. */
const FAILED_PROVIDER = new Set(["INVALID", "INVALID_MESSAGE", "BLOCKED", "CARRIER_BLOCKED", "SPAM", "UNREACHABLE", "CARRIER_UNREACHABLE", "TTL_EXPIRED", "FAILED", "UNROUTABLE", "PROTECT_BLOCKED"]);

/**
 * A message's status after an AWS delivery event (eventType TEXT_* / messageStatus, isFinal). An
 * event that isn't final only ever says "still with the carrier"; "delivered" needs DELIVERED,
 * and an acceptance by the API is never taken for a delivery.
 */
export function statusFromEvent(messageStatus: string, isFinal: boolean): SmsStatus {
  const s = messageStatus.toUpperCase();
  if (s === "DELIVERED") return "delivered";
  // UNREACHABLE and CARRIER_UNREACHABLE come as interim reports while the carrier keeps trying.
  if (!isFinal) return "pending";
  if (s === "SUCCESSFUL") return "carrier_accepted";
  if (FAILED_PROVIDER.has(s)) return "failed";
  return "unknown";
}

const RANK: Partial<Record<SmsStatus, number>> = { sending: 0, accepted: 1, pending: 2 };

/**
 * Whether an event's status may replace the stored one. Events arrive late, twice and out of
 * order: a final status is only replaced by a later final one, and nothing goes backwards.
 */
export function statusMayMove(current: SmsStatus, next: SmsStatus, currentAt: number | null, nextAt: number): boolean {
  if (current === next) return false;
  if (current === "opted_out" || current === "skipped" || current === "cancelled" || current === "dry_run") return false;
  const curFinal = isFinalStatus(current);
  const nextFinal = isFinalStatus(next);
  if (curFinal && !nextFinal) return false;
  // "uncertain" and the 72-hour "unknown" were our guess: AWS's own final word replaces them.
  if (curFinal && nextFinal) return current === "uncertain" || current === "unknown" ? true : currentAt === null || nextAt > currentAt;
  if (!curFinal && nextFinal) return true;
  return (RANK[next] ?? 0) > (RANK[current] ?? 0);
}

/** After this long with no final event, AWS itself reports UNKNOWN; we stop waiting a little later. */
export const FINAL_EVENT_WAIT_MS = 74 * 3600_000;

export const DELIVERY_EXPLANATION: Record<string, string> = {
  INVALID: "The number isn't a valid mobile number.",
  INVALID_MESSAGE: "The carrier couldn't accept the message's text.",
  BLOCKED: "The recipient's phone blocks texts from this sender.",
  CARRIER_BLOCKED: "The recipient's carrier blocked the message.",
  SPAM: "The carrier treated the message as spam.",
  UNREACHABLE: "The phone was off or out of coverage.",
  CARRIER_UNREACHABLE: "The recipient's mobile network had a problem.",
  TTL_EXPIRED: "It couldn't be delivered in time and was dropped.",
  FAILED: "The carrier couldn't deliver it.",
  UNROUTABLE: "AWS couldn't route it: the sender isn't set up for this country.",
  PROTECT_BLOCKED: "AWS's SMS Protect rules blocked it.",
  UNKNOWN: "The carrier never said whether it arrived.",
  SUCCESSFUL: "The carrier accepted it; this network doesn't confirm delivery to the phone.",
  DELIVERED: "The phone confirmed delivery.",
};

// ---------------------------------------------------------------------------
// What AWS's answer to a send means
// ---------------------------------------------------------------------------

export type SendErrorAction =
  /** AWS didn't take it, and will take it later: try again after a wait. */
  | "retry"
  /** It will never go: record why. */
  | "fail"
  /** The number is on an AWS opt-out list. */
  | "opt_out"
  /** The account can't send now (monthly spend limit): hold every message. */
  | "hold_account"
  /** The sender is broken (missing, not allowed): hold this store's messages and tell the merchant. */
  | "hold_sender"
  /** AWS may have taken it: never send it again on our own. */
  | "uncertain";

export interface SendErrorFacts {
  /** The exception's name (ThrottlingException, ConflictException…), or "network" / "timeout". */
  type: string;
  /** Its Reason field, when AWS gave one. */
  reason?: string | null;
  /** HTTP status, when there was a response. */
  status?: number | null;
  /** The request never left this machine (DNS, refused connection): safe to retry. */
  notSent?: boolean;
}

/**
 * How a failed SendTextMessage is handled. The one rule that matters most: when AWS may have
 * accepted the message (a 500, a broken connection, a timeout) it is never sent again on its own,
 * because a second text to a customer is worse than a missing one.
 */
export function classifySendError(f: SendErrorFacts): { action: SendErrorAction; code: string } {
  const type = f.type;
  const reason = (f.reason ?? "").toUpperCase();
  if (f.notSent) return { action: "retry", code: "network_not_sent" };
  if (type === "ThrottlingException") return { action: "retry", code: "throttled" };
  if (type === "ServiceQuotaExceededException") {
    if (/SPEND_LIMIT/.test(reason)) return { action: "hold_account", code: "aws_spend_limit" };
    return { action: "retry", code: "aws_quota" };
  }
  if (type === "ConflictException") {
    if (/OPTED_OUT/.test(reason)) return { action: "opt_out", code: "opted_out" };
    if (/DESTINATION_COUNTRY_BLOCKED|COUNTRY/.test(reason)) return { action: "fail", code: "country_blocked" };
    return { action: "fail", code: reason.toLowerCase() || "conflict" };
  }
  if (type === "ValidationException") {
    if (/VERIF/.test(reason)) return { action: "fail", code: "destination_not_verified" };
    if (/PHONE|DESTINATION/.test(reason)) return { action: "fail", code: "invalid_number" };
    if (/PRICE/.test(reason)) return { action: "fail", code: "over_max_price" };
    return { action: "fail", code: "rejected" };
  }
  if (type === "ResourceNotFoundException") return { action: "hold_sender", code: "sender_not_found" };
  if (type === "AccessDeniedException") {
    if (/VERIF/.test(reason)) return { action: "fail", code: "destination_not_verified" };
    return { action: "hold_sender", code: "sender_not_allowed" };
  }
  return { action: "uncertain", code: type === "InternalServerException" ? "aws_internal_error" : type === "timeout" ? "timeout" : "no_answer" };
}

/** Attempts at a send that AWS asked us to retry (throttling), counting the first. */
export const SMS_MAX_ATTEMPTS = 6;

/** Exponential backoff with full jitter: a random wait up to 30 s, 60 s, 120 s… capped at an hour. */
export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.max(5, Math.round(ceiling * (0.5 + random() / 2)));
}

export const SKIP_LABEL: Record<string, string> = {
  no_phone: "No mobile number on the order",
  invalid_number: "Not a valid mobile number",
  country_not_enabled: "Sending to this country isn't switched on",
  suppressed: "The customer opted out",
  no_marketing_consent: "No marketing consent",
  no_transactional_basis: "No basis for order updates chosen in Sender settings",
  consent_redacted: "The customer's data was erased",
  missing_variable: "A value the template needs is missing",
  invalid_variable: "A value the template needs isn't usable (for example a broken link)",
  template_not_approved: "The template has no approved version",
  template_category_changed: "The template's approved version is now of the other category: approve the rule again",
  sender_not_ready: "The sender isn't set up or verified",
  sending_disabled: "Sending is switched off for this store",
  marketing_disabled: "Marketing texts are switched off",
  platform_off: "SMS isn't switched on for bizinsights yet",
  sandbox_unverified: "AWS's test mode only reaches verified test numbers",
  quiet_hours: "Would have arrived in quiet hours",
  frequency_cap: "The customer already got the most texts allowed",
  rule_cap: "The rule already reached this customer",
  budget_reached: "The monthly SMS budget is used up",
  account_limit: "The account's SMS spending limit is reached",
  checkout_completed: "The customer finished their order",
  order_cancelled: "The order was cancelled",
  rule_inactive: "The rule was paused or changed",
  campaign_stopped: "The campaign was paused or cancelled",
  dlt_mismatch: "The text doesn't match its registered DLT template",
  dlt_missing: "No DLT template for India",
  stale: "The event was too old to announce",
  too_long: "The text is longer than allowed",
};

export const skipLabel = (code: string | null | undefined) => (code ? (SKIP_LABEL[code] ?? code.replace(/_/g, " ")) : null);

// ---------------------------------------------------------------------------
// Budgets and cost
// ---------------------------------------------------------------------------

/** Percent of a monthly budget at which the merchant is told. */
export const BUDGET_LEVELS = [50, 80, 100] as const;

/** Levels newly reached at `spent` that haven't been announced this month. */
export function budgetLevelsReached(spentUsd: number, budgetUsd: number, announced: readonly number[]): number[] {
  if (!(budgetUsd > 0)) return [];
  const pct = (spentUsd / budgetUsd) * 100;
  return BUDGET_LEVELS.filter((l) => pct >= l && !announced.includes(l));
}

/** Whether another message estimated at `nextUsd` still fits the budget. A budget of 0 sends nothing. */
export const budgetAllows = (spentUsd: number, nextUsd: number, budgetUsd: number) => budgetUsd > 0 && spentUsd + nextUsd <= budgetUsd + 1e-9;

/** "2026-10" for a moment, in UTC (AWS bills SMS per calendar month in UTC). */
export const billingMonth = (at: Date) => at.toISOString().slice(0, 7);

/**
 * AWS reports each message's price with its delivery event (totalMessagePrice, US dollars, and
 * totalCarrierFee). Estimates use the average AWS charged this account for the same country, or a
 * price the platform owner entered from AWS's price list; with neither, there is no estimate.
 */
export function estimateCostUsd(parts: number, pricePerPartUsd: number | null | undefined): number | null {
  if (!(parts > 0) || pricePerPartUsd === null || pricePerPartUsd === undefined || !(pricePerPartUsd >= 0)) return null;
  return Math.round(parts * pricePerPartUsd * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Quiet hours and time zones
// ---------------------------------------------------------------------------

/**
 * Countries with one time zone: a customer's local time is known from their number. Elsewhere
 * (Australia, the US, Canada, Brazil…) the store's time zone is used, and the rule says so.
 */
const COUNTRY_ZONE: Record<string, string> = {
  NZ: "Pacific/Auckland",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  IN: "Asia/Kolkata",
  SG: "Asia/Singapore",
  HK: "Asia/Hong_Kong",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  PH: "Asia/Manila",
  MY: "Asia/Kuala_Lumpur",
  TH: "Asia/Bangkok",
  VN: "Asia/Ho_Chi_Minh",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  QA: "Asia/Qatar",
  IL: "Asia/Jerusalem",
  ZA: "Africa/Johannesburg",
  NG: "Africa/Lagos",
  KE: "Africa/Nairobi",
  DE: "Europe/Berlin",
  FR: "Europe/Paris",
  IT: "Europe/Rome",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  CH: "Europe/Zurich",
  AT: "Europe/Vienna",
  SE: "Europe/Stockholm",
  NO: "Europe/Oslo",
  DK: "Europe/Copenhagen",
  FI: "Europe/Helsinki",
  PL: "Europe/Warsaw",
  GR: "Europe/Athens",
  PK: "Asia/Karachi",
  LK: "Asia/Colombo",
  BD: "Asia/Dhaka",
};

/** The time zone quiet hours are kept in for a customer: their country's, if it has one zone, else the store's. */
export function customerTimeZone(country: string | null | undefined, storeTimeZone: string, useCustomerZone = true): string {
  if (!useCustomerZone || !country) return storeTimeZone;
  return COUNTRY_ZONE[country.toUpperCase()] ?? storeTimeZone;
}

/**
 * When a message due at `due` may go out: outside quiet hours [start, end) in `timeZone` (a window
 * may wrap midnight; equal hours mean no quiet hours). Returns `due` itself when it may go now.
 */
export function afterQuietHours(due: Date, timeZone: string, quietStart: number, quietEnd: number): Date {
  if (quietStart === quietEnd) return due;
  // Sending is allowed in [quietEnd, quietStart).
  return nextSendTime(due, timeZone, quietEnd, quietStart);
}

// ---------------------------------------------------------------------------
// Automation rules
// ---------------------------------------------------------------------------

export const RULE_CONDITION_FIELDS = ["order_total", "country", "product", "customer_orders", "customer_spent", "days_since_last_order", "tag"] as const;
export type RuleConditionField = (typeof RULE_CONDITION_FIELDS)[number];

export const RULE_CONDITION_LABEL: Record<RuleConditionField, string> = {
  order_total: "Order total",
  country: "Customer country",
  product: "Product title",
  customer_orders: "Customer's orders",
  customer_spent: "Customer's total spend",
  days_since_last_order: "Days since last order",
  tag: "Order tag",
};

export const ruleConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("order_total"), op: z.enum(["gte", "lte"]), value: z.number().min(0).max(1e9) }),
  z.object({ field: z.literal("customer_orders"), op: z.enum(["gte", "lte"]), value: z.number().int().min(0).max(1e6) }),
  z.object({ field: z.literal("customer_spent"), op: z.enum(["gte", "lte"]), value: z.number().min(0).max(1e9) }),
  z.object({ field: z.literal("days_since_last_order"), op: z.enum(["gte", "lte"]), value: z.number().int().min(0).max(3650) }),
  z.object({ field: z.literal("country"), op: z.enum(["in", "not_in"]), value: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(50) }),
  z.object({ field: z.literal("product"), op: z.enum(["contains"]), value: z.string().trim().min(1).max(100) }),
  z.object({ field: z.literal("tag"), op: z.enum(["has", "lacks"]), value: z.string().trim().min(1).max(60) }),
]);
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export interface RuleFacts {
  orderTotal?: number | null;
  country?: string | null;
  productTitles?: string[];
  tags?: string[];
  customerOrders?: number | null;
  customerSpent?: number | null;
  daysSinceLastOrder?: number | null;
}

/** Whether every condition holds. A fact the event doesn't have makes its condition fail, never pass. */
export function evaluateRuleConditions(conditions: RuleCondition[], f: RuleFacts): { pass: boolean; results: Array<{ condition: RuleCondition; pass: boolean }> } {
  const num = (v: number | null | undefined, op: "gte" | "lte", target: number) => (v === null || v === undefined ? false : op === "gte" ? v >= target : v <= target);
  const results = conditions.map((c) => {
    let pass: boolean;
    switch (c.field) {
      case "order_total":
        pass = num(f.orderTotal, c.op, c.value);
        break;
      case "customer_orders":
        pass = num(f.customerOrders, c.op, c.value);
        break;
      case "customer_spent":
        pass = num(f.customerSpent, c.op, c.value);
        break;
      case "days_since_last_order":
        pass = num(f.daysSinceLastOrder, c.op, c.value);
        break;
      case "country":
        pass = f.country ? c.value.includes(f.country.toUpperCase()) === (c.op === "in") : false;
        break;
      case "product":
        pass = (f.productTitles ?? []).some((t) => t.toLowerCase().includes(c.value.toLowerCase()));
        break;
      case "tag":
        pass = f.tags ? f.tags.map((t) => t.toLowerCase()).includes(c.value.toLowerCase()) === (c.op === "has") : false;
        break;
    }
    return { condition: c, pass };
  });
  return { pass: results.every((r) => r.pass), results };
}

const hour = z.number().int().min(0).max(23);

/** A rule as the merchant edits it. */
export const smsRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    trigger: z.enum(SMS_TRIGGERS),
    conditions: z.array(ruleConditionSchema).max(10).default([]),
    /** WAIT: minutes after the event (up to 30 days). */
    delayMinutes: z.number().int().min(0).max(43_200).default(0),
    templateId: z.string().min(1).max(40),
    /** Entered on the rule for discount messages. */
    discountCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,30}$/)
      .nullish(),
    /** Quiet hours [start, end) in the customer's (or the store's) time; equal = none. */
    quietStart: hour.default(21),
    quietEnd: hour.default(9),
    useCustomerTimezone: z.boolean().default(true),
    /** At most this many texts from this rule per customer, per `capDays` days. */
    maxPerCustomer: z.number().int().min(1).max(100).default(1),
    capDays: z.number().int().min(1).max(365).default(30),
    /** 1 runs first when two rules match the same event. */
    priority: z.number().int().min(1).max(100).default(50),
    dryRun: z.boolean().default(true),
    /** customer_inactive: days without an order; customer_vip: orders or spend that make a VIP. */
    inactiveDays: z.number().int().min(14).max(1095).nullish(),
    vipMinOrders: z.number().int().min(2).max(10_000).nullish(),
    vipMinSpent: z.number().min(1).max(1e9).nullish(),
  })
  .superRefine((r, ctx) => {
    if (r.trigger === "customer_inactive" && !r.inactiveDays) ctx.addIssue({ code: "custom", path: ["inactiveDays"], message: "Say after how many days without an order a customer counts as inactive." });
    if (r.trigger === "customer_vip" && !r.vipMinOrders && !r.vipMinSpent) ctx.addIssue({ code: "custom", path: ["vipMinOrders"], message: "Say how many orders or how much spend makes a VIP." });
    if (!TRIGGER_INFO[r.trigger].available) ctx.addIssue({ code: "custom", path: ["trigger"], message: TRIGGER_INFO[r.trigger].unavailableReason ?? "This event isn't available." });
  });
export type SmsRuleInput = z.infer<typeof smsRuleSchema>;

/**
 * draft → pending_approval → active ⇄ paused; disabled ends it (it can be edited back to a draft).
 * `ruleCan` answers pause, resume and disable from the status, and submit/approve/reject for a rule
 * never approved. An edit of a running rule is a new version that is submitted and approved while
 * the approved one keeps running: the API's `unapprovedVersion` / `awaitingApproval` say when
 * (core sms/automations.ts), so the pages ask those for these three.
 */
export const RULE_STATUSES = ["draft", "pending_approval", "active", "paused", "disabled"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export type RuleAction = "submit" | "approve" | "reject" | "pause" | "resume" | "disable";
const RULE_FROM: Record<RuleAction, readonly string[]> = {
  submit: ["draft"],
  approve: ["pending_approval"],
  reject: ["pending_approval"],
  pause: ["active"],
  resume: ["paused"],
  disable: ["draft", "pending_approval", "active", "paused"],
};
export const ruleCan = (status: string, action: RuleAction) => RULE_FROM[action].includes(status);
export const RULE_STATUS_AFTER: Record<RuleAction, RuleStatus> = { submit: "pending_approval", approve: "active", reject: "draft", pause: "paused", resume: "active", disable: "disabled" };

// ---------------------------------------------------------------------------
// Segments and campaigns
// ---------------------------------------------------------------------------

/** Who a campaign or segment reaches. Marketing consent is always required on top of these. */
export const segmentFilterSchema = z.object({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).default([]),
  minOrders: z.number().int().min(0).max(1e6).nullish(),
  maxOrders: z.number().int().min(0).max(1e6).nullish(),
  minSpent: z.number().min(0).max(1e9).nullish(),
  /** Bought within the last N days. */
  orderedWithinDays: z.number().int().min(1).max(3650).nullish(),
  /** No order for N days or more. */
  inactiveForDays: z.number().int().min(1).max(3650).nullish(),
});
export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

export function describeSegment(f: SegmentFilter): string {
  const parts = ["Customers subscribed to SMS marketing"];
  if (f.countries.length) parts.push(`in ${f.countries.join(", ")}`);
  if (f.minOrders != null && f.maxOrders != null) parts.push(`with ${f.minOrders}-${f.maxOrders} orders`);
  else if (f.minOrders != null) parts.push(`with ${f.minOrders}+ orders`);
  else if (f.maxOrders != null) parts.push(`with at most ${f.maxOrders} orders`);
  if (f.minSpent != null) parts.push(`who spent ${f.minSpent}+`);
  if (f.orderedWithinDays != null) parts.push(`who ordered in the last ${f.orderedWithinDays} days`);
  if (f.inactiveForDays != null) parts.push(`with no order for ${f.inactiveForDays}+ days`);
  return parts.join(" ");
}

export const SMS_CAMPAIGN_STATUSES = ["draft", "pending_approval", "approved", "scheduled", "sending", "paused", "completed", "cancelled"] as const;
export type SmsCampaignStatus = (typeof SMS_CAMPAIGN_STATUSES)[number];
export type SmsCampaignAction = "submit" | "approve" | "reject" | "schedule" | "pause" | "resume" | "cancel";
const CAMPAIGN_FROM: Record<SmsCampaignAction, readonly string[]> = {
  submit: ["draft"],
  approve: ["pending_approval"],
  reject: ["pending_approval", "approved"],
  schedule: ["approved"],
  pause: ["scheduled", "sending"],
  resume: ["paused"],
  cancel: ["draft", "pending_approval", "approved", "scheduled", "sending", "paused"],
};
export const smsCampaignCan = (status: string, action: SmsCampaignAction) => CAMPAIGN_FROM[action].includes(status);
export const smsCampaignEditable = (status: string) => status === "draft";

/** Most recipients one campaign may have unless the platform owner raises it (SMS_CAMPAIGN_MAX_RECIPIENTS). */
export const DEFAULT_CAMPAIGN_MAX_RECIPIENTS = 2000;

export const smsCampaignSchema = z.object({
  name: z.string().trim().min(1).max(80),
  templateId: z.string().min(1).max(40),
  segmentId: z.string().min(1).max(40).nullish(),
  filter: segmentFilterSchema.default({ countries: [] }),
  discountCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,30}$/)
    .nullish(),
  /** Days after a text an order still counts as following it. */
  attributionDays: z.number().int().min(1).max(14).default(3),
});
export type SmsCampaignInput = z.infer<typeof smsCampaignSchema>;

// ---------------------------------------------------------------------------
// Attribution (said plainly: followed, not caused)
// ---------------------------------------------------------------------------

/**
 * An order is attributed to the last marketing or automation text its customer received (AWS
 * accepted it and no failure came back) within the attribution window before the order: one
 * order once, last touch. This says the order followed a text, not that the text caused it; the
 * customer may have bought anyway, so attributed revenue is not incremental revenue.
 */
export const ATTRIBUTION_RULE =
  "An order counts when its customer received a text from you (AWS accepted it and no failure came back) within the attribution window before ordering. Each order counts once, for the last text before it. It shows orders that followed a text, not orders a text caused: some of these customers would have bought anyway.";
export const DEFAULT_ATTRIBUTION_DAYS = 3;
/** Statuses that count as "received" for attribution. */
export const ATTRIBUTABLE_STATUSES: readonly SmsStatus[] = ["accepted", "pending", "delivered", "carrier_accepted"];

/** Return on SMS spend: attributed revenue per dollar spent (null without spend). Shown with the attribution caveat. */
export const smsRoi = (attributedRevenue: number, costUsd: number) => (costUsd > 0 ? attributedRevenue / costUsd : null);

// ---------------------------------------------------------------------------
// Analytics periods
// ---------------------------------------------------------------------------

export const SMS_PERIODS = ["today", "yesterday", "7d", "30d", "this_month", "custom"] as const;
export type SmsPeriod = (typeof SMS_PERIODS)[number];
export const SMS_PERIOD_LABEL: Record<SmsPeriod, string> = { today: "Today", yesterday: "Yesterday", "7d": "Last 7 days", "30d": "Last 30 days", this_month: "This month", custom: "Custom dates" };

/** The store-local days a period covers ("today" is the store's today). Throws on custom dates that can't be reported on. */
export function smsPeriodRange(period: SmsPeriod, today: string, custom?: { from?: string; to?: string }): { from: string; to: string } {
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "this_month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "custom": {
      const problem = customRangeProblem(custom ?? {}, today);
      if (problem || !isDay(custom?.from) || !isDay(custom?.to)) throw new Error(problem === "too_long" ? "Choose up to 12 months." : "Choose a start and an end date, the start first, not in the future.");
      return { from: custom!.from!, to: custom!.to! };
    }
  }
}

// ---------------------------------------------------------------------------
// Sender settings
// ---------------------------------------------------------------------------

export const SENDER_TYPES = ["sender_id", "long_code", "toll_free", "ten_dlc", "short_code", "pool"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];
export const SENDER_TYPE_LABEL: Record<SenderType, string> = {
  sender_id: "Sender ID (letters, one-way)",
  long_code: "Long code (mobile number)",
  toll_free: "Toll-free number (US/Canada)",
  ten_dlc: "10DLC number (US)",
  short_code: "Short code",
  pool: "Phone pool",
};

/** What each country needs before AWS will carry texts there (AWS End User Messaging SMS user guide, checked 2026-10-22). */
export const COUNTRY_RULES: Record<string, { label: string; region: string; registration: string }> = {
  AU: { label: "Australia", region: "ap-southeast-2", registration: "Alphanumeric sender IDs must be registered in ACMA's SMS Sender ID Register (enforced since 1 July 2026; AWS console → Registrations). Unregistered ones show as \"Unverified\" or are blocked." },
  NZ: { label: "New Zealand", region: "ap-southeast-2", registration: "Sender IDs aren't supported: use a long code or a shared short code." },
  US: { label: "United States", region: "ap-southeast-2", registration: "Needs a registered 10DLC campaign, a verified toll-free number or a short code. Unregistered traffic is blocked." },
  CA: { label: "Canada", region: "ap-southeast-2", registration: "Needs a toll-free number (verified) or a long code; sender IDs aren't supported." },
  GB: { label: "United Kingdom", region: "ap-southeast-2", registration: "Sender IDs must be registered (AWS console → Registrations → UK sender ID; AWS user guide, checked 2026-10-23)." },
  IN: { label: "India", region: "ap-south-1", registration: "Local routes need a DLT-registered entity (Entity ID), a registered sender ID (header) and each template's DLT Template ID; AWS sends Indian local traffic only from Mumbai (ap-south-1) or Hyderabad (ap-south-2)." },
};

export const smsSenderSchema = z.object({
  senderType: z.enum(SENDER_TYPES),
  /** The AWS origination identity: its ARN, or its id (phone-number id, sender ID, pool id). */
  originationIdentity: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_:/+-]+$/),
  /** Destination countries this sender may reach. */
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .min(1)
    .max(30),
  monthlyBudgetUsd: z.number().min(0).max(100_000),
  hardStop: z.boolean().default(true),
  monthlyMessageQuota: z.number().int().min(1).max(10_000_000).nullish(),
  transactionalBasis: z.enum(SMS_TRANSACTIONAL_BASES).default("none"),
  quietStart: hour.default(21),
  quietEnd: hour.default(9),
  /** Most texts one customer gets from this store in a day, and marketing texts in a week. */
  maxPerCustomerDay: z.number().int().min(1).max(20).default(3),
  maxMarketingPerWeek: z.number().int().min(0).max(14).default(2),
  /** India: the DLT Principal Entity ID. */
  dltEntityId: z
    .string()
    .trim()
    .regex(/^\d{1,30}$/)
    .nullish(),
});
export type SmsSenderInput = z.infer<typeof smsSenderSchema>;

/** Masked number for the UI. Re-exported so pages import one module. */
export const maskedNumber = (e164: string) => maskPhone(e164);

// ---------------------------------------------------------------------------
// Sender names (alphanumeric sender IDs) and the simple setup
// ---------------------------------------------------------------------------

/**
 * Whether customers in a country can see a business's name as the sender, per AWS End User
 * Messaging SMS ("Supported countries and regions", column "Supports Sender IDs", checked
 * 2026-10-23):
 *  - registered: only a sender ID registered with the country's regulator or carriers (through
 *    AWS's registrations). Unregistered, AWS sends as "NOTICE" or carriers mark it "Likely scam".
 *  - dynamic: any sender ID, no registration.
 *  - none: names aren't shown there: customers see a phone number (or a short code).
 * Countries missing here: not known to bizinsights yet, checked by hand when a merchant asks.
 * This is AWS End User Messaging SMS's sender ID resource, not Amazon SNS's sender ID attribute
 * (which bizinsights doesn't use).
 */
export type SenderIdSupport = "registered" | "dynamic" | "none";

export const SENDER_ID_SUPPORT: Record<string, SenderIdSupport> = {
  AU: "registered",
  NZ: "none",
  US: "none",
  CA: "none",
  GB: "registered",
  IE: "registered",
  IN: "registered",
  SG: "registered",
  PH: "registered",
  AE: "registered",
  SA: "registered",
  QA: "registered",
  KE: "registered",
  ES: "registered",
  TH: "registered",
  ID: "registered",
  VN: "registered",
  TR: "registered",
  LK: "registered",
  EG: "registered",
  HK: "dynamic",
  JP: "dynamic",
  DE: "dynamic",
  FR: "dynamic",
  NL: "dynamic",
  IT: "dynamic",
  AT: "dynamic",
  DK: "dynamic",
  FI: "dynamic",
  NO: "dynamic",
  SE: "dynamic",
  CH: "dynamic",
  PL: "dynamic",
  PT: "dynamic",
  IL: "dynamic",
  MX: "dynamic",
  NG: "dynamic",
  PK: "dynamic",
  MY: "none",
  ZA: "none",
  BE: "none",
  BR: "none",
  AR: "none",
  CL: "none",
  CO: "none",
  KR: "none",
  TW: "none",
  CN: "none",
};

export const senderIdSupport = (country: string | null | undefined): SenderIdSupport | "unknown" => (country ? (SENDER_ID_SUPPORT[country.toUpperCase()] ?? "unknown") : "unknown");

/** AWS's limits on a sender ID: 1 to 11 of a-z, A-Z, 0-9 and "-" (not first or last), at least one letter, no spaces. bizinsights asks for 3 or more, as AWS recommends. */
export const SENDER_NAME_MIN = 3;
export const SENDER_NAME_MAX = 11;

/** Names carriers treat as generic or that AWS uses itself: they say nothing about who sent the text. */
const GENERIC_SENDER_NAMES = new Set(["NOTICE", "INFO", "SMS", "TEXT", "ALERT", "ALERTS", "MESSAGE", "VERIFY", "OTP", "TEST", "AWS", "AMAZON", "BANK", "SUPPORT", "SERVICE", "NOREPLY"]);

export interface SenderNameCheck {
  /** The name as it would be used (trimmed; the case is kept: carriers show it as written). */
  name: string;
  /** Problems with the name itself; empty when it can be asked for. */
  problems: string[];
  support: SenderIdSupport | "unknown";
  /** What a customer in that country sees as the sender, in words. */
  customerSees: string;
  /** What has to happen before it can be used there. */
  next: string;
}

/**
 * Whether `raw` can be a sender name for customers in `country`, and what they would see. The
 * same check runs in the browser (as the merchant types) and on the server (before a request is
 * recorded). It says what is possible; only AWS saying the sender ID exists, is set up for the
 * workspace and is registered (where that is required) makes it usable.
 */
export function checkSenderName(raw: string, country: string | null | undefined): SenderNameCheck {
  const name = (raw ?? "").trim();
  const problems: string[] = [];
  if (!name) problems.push("Enter the name your customers should see.");
  else {
    const compact = name.replace(/\s+/g, "");
    if (/\s/.test(name)) problems.push(`Sender names can't have spaces: try "${compact.slice(0, SENDER_NAME_MAX)}".`);
    if (/[^A-Za-z0-9\s-]/.test(name)) problems.push("Use only letters, numbers and hyphens (no accents, symbols or emoji).");
    if (compact.length > SENDER_NAME_MAX) problems.push(`At most ${SENDER_NAME_MAX} characters: this one has ${compact.length}.`);
    else if (compact.length < SENDER_NAME_MIN) problems.push(`At least ${SENDER_NAME_MIN} characters, so customers can tell who it is.`);
    if (!/[A-Za-z]/.test(name)) problems.push("Include at least one letter: names of only numbers are read as phone numbers.");
    if (/^-|-$/.test(compact)) problems.push("A hyphen can't be the first or last character.");
    if (country?.toUpperCase() === "FR" && name.includes("-")) problems.push("France doesn't allow hyphens in sender names (since 1 March 2026).");
    if (GENERIC_SENDER_NAMES.has(compact.toUpperCase())) problems.push(`"${compact}" doesn't say who you are, and carriers block generic names: use your business's name.`);
  }
  const support = senderIdSupport(country);
  const where = country ? countryLabel(country) : "your customers' country";
  const shown = name || "Your name";
  const sees: Record<SenderIdSupport | "unknown", { customerSees: string; next: string }> = {
    registered: {
      customerSees: `${shown}, once it is registered`,
      next: `${where} only shows registered sender names. bizinsights registers it with AWS for you; texts can't use it until the registration is approved.`,
    },
    dynamic: { customerSees: shown, next: `${where} shows sender names without registration. bizinsights sets it up with AWS for you after checking the name is yours to use.` },
    none: {
      customerSees: "A phone number (or a short code)",
      next: `Phones in ${where} don't show sender names: your texts come from a number. Say who you are in the message itself, for example "{{business_name}}: …".`,
    },
    unknown: { customerSees: `${shown}, if ${where} allows it`, next: `bizinsights checks AWS's rules for ${where} when you ask for the name, and tells you what it needs.` },
  };
  return { name, problems, support, ...sees[support] };
}

/** A sender name made from a business name: letters and digits only, at most 11, upper case ("Ikorex Store" → "IKOREXSTORE"). */
export function suggestSenderName(business: string): string {
  // NFKD splits "é" into "e" and its accent; the accent is then dropped with everything else that isn't a-z, 0-9.
  return Array.from(business.normalize("NFKD"))
    .filter((ch) => /[A-Za-z0-9]/.test(ch))
    .join("")
    .slice(0, SENDER_NAME_MAX)
    .toUpperCase();
}

/** A country's name from its code without Intl (this module stays free of browser APIs): COUNTRY_RULES's label, else the code. */
function countryLabel(code: string): string {
  return COUNTRY_RULES[code.toUpperCase()]?.label ?? code.toUpperCase();
}

/**
 * A store's sender name, as far as anyone can tell:
 *  - draft: typed and saved, not asked for yet
 *  - requested: sent to bizinsights, which sets it up (and registers it) with AWS
 *  - pending: AWS has it for this workspace; its registration isn't complete yet
 *  - approved: AWS has it for this workspace and it may be used (registered, or none needed)
 *  - needs_changes: the registration was sent back or closed
 *  - unavailable: AWS has this name for another business
 */
export const SENDER_NAME_STATUSES = ["draft", "requested", "pending", "approved", "needs_changes", "unavailable"] as const;
export type SenderNameStatus = (typeof SENDER_NAME_STATUSES)[number];

/**
 * The state from what AWS reported (null: AWS has no such sender ID) and whether it was asked for.
 * `registration` is AWS's registration status (null where the country needs none); a name is only
 * ever "approved" on AWS's word, never because it was asked for.
 */
export function senderNameStatus(found: { mine: boolean; registration: string | null } | null, requested: boolean): SenderNameStatus {
  if (!found) return requested ? "requested" : "draft";
  if (!found.mine) return "unavailable";
  const r = (found.registration ?? "").toUpperCase();
  if (!r || r === "COMPLETE" || r === "REGISTERED" || r === "ACTIVE" || r === "NOT_REQUIRED") return "approved";
  if (/REQUIRES_UPDATES|CLOSED|DELETED|DENIED|REJECTED/.test(r)) return "needs_changes";
  return "pending";
}

/** The setup's steps, in order. */
export const SETUP_STEPS = ["connect", "sender", "message", "test", "automate"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupAutomation {
  /** The Shopify event it runs on; null when Shopify has no such event. */
  trigger: SmsTrigger | null;
  key: string;
  label: string;
  /** What the merchant reads under the label. */
  help: string;
  /** The message the setup starts from. */
  body: string;
  /** Why it can't be turned on, when it can't. */
  unavailable?: string;
}

/** What the setup's "Automatic SMS" step offers: order updates (transactional), one message each. Marketing texts are on the advanced pages. */
export const SETUP_AUTOMATIONS: SetupAutomation[] = [
  {
    trigger: "order_created",
    key: "order_created",
    label: "New order confirmed",
    help: "Sent when a customer places an order.",
    body: "Hi {{customer_name}}, your order {{order_number}} has been {{order_status}}. Thank you for shopping with {{business_name}}!",
  },
  {
    trigger: "payment_completed",
    key: "payment_completed",
    label: "Payment confirmation",
    help: "Sent when an order that wasn't paid at checkout is paid. Card payments come with the order, so most stores need only one of these two.",
    body: "Hi {{customer_name}}, we've received your payment for order {{order_number}}. Thank you, {{business_name}}.",
  },
  {
    trigger: "fulfillment_created",
    key: "fulfillment_created",
    label: "Order shipped",
    help: "Sent when you fulfill an order. An order shipped without a tracking link doesn't get this text while it shows the link.",
    body: "Good news {{customer_name}}! Your {{business_name}} order {{order_number}} is on its way. Track it: {{tracking_url}}",
  },
  {
    trigger: "delivery_confirmed",
    key: "delivery_confirmed",
    label: "Order delivered",
    help: "Sent when the carrier tells Shopify the parcel arrived (only carriers that report deliveries).",
    body: "Hi {{customer_name}}, your order {{order_number}} has been delivered. Enjoy, from {{business_name}}!",
  },
  {
    trigger: null,
    key: "appointment_reminder",
    label: "Appointment reminder",
    help: "A reminder before a booked appointment.",
    body: "",
    unavailable: "Shopify doesn't record appointments, so there is no appointment to remind customers of.",
  },
];

export const setupAutomation = (trigger: string) => SETUP_AUTOMATIONS.find((a) => a.trigger === trigger) ?? null;

/** The setup's first message (step 3): the order confirmation. */
export const SETUP_FIRST_MESSAGE = SETUP_AUTOMATIONS[0]!.body;

/** Variables the setup's message editor offers as buttons, in order. */
export const SETUP_VARIABLES: SmsVariable[] = ["customer_name", "business_name", "order_number", "order_status", "tracking_url", "order_total", "product_name"];

/** The setup's suggested monthly budget (US$). */
export const SETUP_DEFAULT_BUDGET_USD = 20;

/** What "Save draft" keeps. Every field is optional: a draft is whatever the merchant has so far. */
export const smsSetupDraftSchema = z.object({
  step: z.enum(SETUP_STEPS).optional(),
  businessName: z.string().trim().max(40).nullish(),
  senderName: z.string().trim().max(30).nullish(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullish(),
  message: z.string().max(2000).nullish(),
  monthlyBudgetUsd: z.number().min(0).max(100_000).nullish(),
  transactionalBasis: z.enum(SMS_TRANSACTIONAL_BASES).nullish(),
});
export type SmsSetupDraft = z.infer<typeof smsSetupDraftSchema>;

// ---------------------------------------------------------------------------
// Automations: the four-step builder (trigger, message, timing, test and activate)
// ---------------------------------------------------------------------------

/** The builder's steps, in order. */
export const AUTOMATION_STEPS = ["trigger", "message", "timing", "activate"] as const;
export type AutomationStep = (typeof AUTOMATION_STEPS)[number];

/**
 * Which Shopify webhooks carry each trigger's event (any one of `topics` is enough). `topics` are
 * the app's own subscriptions, declared in its toml, which Shopify sends for every store of that
 * app; `perStore` is subscribed for each store once it granted `scope` (core's ensureSmsWebhooks);
 * `daily`: worked out every day from the orders those topics brought in. Null: no event exists.
 */
export interface TriggerSource {
  topics: string[];
  perStore?: { topic: string; graphqlTopic: string; scope: string };
  daily?: boolean;
}

export const TRIGGER_SOURCES: Record<SmsTrigger, TriggerSource | null> = {
  order_created: { topics: ["orders/create"] },
  payment_completed: { topics: ["orders/paid"] },
  fulfillment_created: { topics: ["orders/fulfilled", "orders/partially_fulfilled", "orders/updated"] },
  delivery_confirmed: { topics: ["orders/updated", "orders/fulfilled"] },
  order_cancelled: { topics: ["orders/cancelled"] },
  refund_issued: { topics: ["refunds/create"] },
  checkout_abandoned: { topics: ["checkouts/create", "checkouts/update"] },
  customer_registered: { topics: [], perStore: { topic: "customers/create", graphqlTopic: "CUSTOMERS_CREATE", scope: "read_customers" } },
  customer_birthday: null,
  customer_inactive: { topics: ["orders/create"], daily: true },
  customer_vip: { topics: ["orders/create"], daily: true },
};

/** The icons the trigger cards use (lucide names; the dashboard draws them). */
export type AutomationIcon = "shopping-bag" | "credit-card" | "truck" | "package-check" | "shopping-cart" | "user-plus" | "webhook" | "circle-x" | "undo" | "moon" | "crown" | "cake";

export interface AutomationTriggerCard {
  /** The trigger, or "custom_event" (no trigger behind it). */
  key: string;
  trigger: SmsTrigger | null;
  label: string;
  description: string;
  icon: AutomationIcon;
  /** Shown first; the rest are under "More triggers". */
  main: boolean;
  /** What the merchant should know before choosing it. */
  note?: string;
  /** Why it can't be chosen at all (there is no such event). */
  unavailable?: string;
}

/** Step 1's cards, in the order they are shown. Whether each works for a store is the API's answer (core sms/builder.ts). */
export const AUTOMATION_TRIGGER_CARDS: AutomationTriggerCard[] = [
  { key: "order_created", trigger: "order_created", label: "Order placed", description: "When a customer places an order.", icon: "shopping-bag", main: true },
  {
    key: "payment_completed",
    trigger: "payment_completed",
    label: "Order paid",
    description: "When an order that wasn't paid at checkout is paid.",
    icon: "credit-card",
    main: true,
    note: "Card payments arrive with the order, so most stores need only one of Order placed and Order paid.",
  },
  { key: "fulfillment_created", trigger: "fulfillment_created", label: "Order shipped or fulfilled", description: "When you fulfil an order. The text can carry the tracking link.", icon: "truck", main: true },
  {
    key: "delivery_confirmed",
    trigger: "delivery_confirmed",
    label: "Order delivered",
    description: "When the carrier tells Shopify the parcel arrived.",
    icon: "package-check",
    main: true,
    note: "Only for carriers that report deliveries to Shopify; other parcels never get this text.",
  },
  {
    key: "checkout_abandoned",
    trigger: "checkout_abandoned",
    label: "Abandoned checkout",
    description: "When a customer leaves checkout with their mobile number and doesn't order.",
    icon: "shopping-cart",
    main: true,
    note: "A reminder is marketing: only customers subscribed to your SMS marketing get it, and it's cancelled if they order.",
  },
  {
    key: "customer_registered",
    trigger: "customer_registered",
    label: "Customer registered",
    description: "When a customer creates an account with your store.",
    icon: "user-plus",
    main: true,
    note: "A welcome text is marketing: only customers subscribed to your SMS marketing get it.",
  },
  {
    key: "custom_event",
    trigger: null,
    label: "Custom event",
    description: "When something outside Shopify's own events happens.",
    icon: "webhook",
    main: true,
    unavailable: "bizinsights starts texts only from Shopify's own events. It can't receive an event of your own yet (from Shopify Flow or another app), so this trigger isn't offered.",
  },
  { key: "order_cancelled", trigger: "order_cancelled", label: "Order cancelled", description: "When an order is cancelled.", icon: "circle-x", main: false },
  { key: "refund_issued", trigger: "refund_issued", label: "Refund issued", description: "When you refund an order. The text says how much was refunded.", icon: "undo", main: false },
  { key: "customer_inactive", trigger: "customer_inactive", label: "Inactive customer", description: "Once a customer hasn't ordered for the number of days you choose (checked daily).", icon: "moon", main: false },
  { key: "customer_vip", trigger: "customer_vip", label: "VIP customer", description: "Once a customer reaches the orders or spend you choose (checked daily).", icon: "crown", main: false },
  { key: "customer_birthday", trigger: "customer_birthday", label: "Customer birthday", description: "On a customer's birthday.", icon: "cake", main: false, unavailable: TRIGGER_INFO.customer_birthday.unavailableReason },
];

/** A trigger's card (every trigger has one). */
export const automationTriggerCard = (trigger: SmsTrigger): AutomationTriggerCard => AUTOMATION_TRIGGER_CARDS.find((c) => c.trigger === trigger)!;

/** Ready-made messages for each trigger (the builder's "Templates"). Marketing ones carry the opt-out link. */
export const AUTOMATION_STARTERS: Record<SmsTrigger, Array<{ name: string; body: string }>> = {
  order_created: [
    { name: "Order confirmation", body: "Hi {{customer_name}}, thanks for your order {{order_number}} with {{business_name}}! We'll text you when it ships." },
    { name: "Confirmation with total", body: "Hi {{customer_name}}, we've got your order {{order_number}} ({{order_total}} {{currency}}). Thank you for shopping with {{business_name}}!" },
  ],
  payment_completed: [{ name: "Payment received", body: "Hi {{customer_name}}, we've received your payment for order {{order_number}}. Thank you, {{business_name}}." }],
  fulfillment_created: [
    { name: "Shipped, with tracking", body: "Good news {{customer_name}}! Your {{business_name}} order {{order_number}} is on its way. Track it: {{tracking_url}}" },
    { name: "Shipped, no link", body: "Hi {{customer_name}}, your order {{order_number}} from {{business_name}} has shipped." },
  ],
  delivery_confirmed: [{ name: "Delivered", body: "Hi {{customer_name}}, your order {{order_number}} has been delivered. Enjoy, from {{business_name}}!" }],
  order_cancelled: [{ name: "Order cancelled", body: "Hi {{customer_name}}, your order {{order_number}} with {{business_name}} has been cancelled. Contact us if you didn't expect this." }],
  refund_issued: [{ name: "Refund issued", body: "Hi {{customer_name}}, we've refunded {{order_total}} {{currency}} for order {{order_number}}. {{business_name}}" }],
  checkout_abandoned: [
    { name: "Gentle reminder", body: "Hi {{customer_name}}, you left something at {{business_name}}. Finish your order here: {{checkout_url}} Opt out: {{opt_out_url}}" },
    { name: "Reminder with a code", body: "Hi {{customer_name}}, still thinking about {{product_name}}? Use {{discount_code}} at checkout: {{checkout_url}} - {{business_name}}. Opt out: {{opt_out_url}}" },
  ],
  customer_registered: [
    { name: "Welcome", body: "Welcome to {{business_name}}, {{customer_name}}! Thanks for joining us. Opt out: {{opt_out_url}}" },
    { name: "Welcome with a code", body: "Welcome to {{business_name}}, {{customer_name}}! Here's a code for your first order: {{discount_code}}. Opt out: {{opt_out_url}}" },
  ],
  customer_birthday: [],
  customer_inactive: [{ name: "We miss you", body: "Hi {{customer_name}}, we miss you at {{business_name}}! Here's a code for your next order: {{discount_code}}. Opt out: {{opt_out_url}}" }],
  customer_vip: [{ name: "Thank you", body: "Hi {{customer_name}}, thank you for being one of {{business_name}}'s best customers! Here's a code just for you: {{discount_code}}. Opt out: {{opt_out_url}}" }],
};

/** The conditions that mean something for each trigger: the facts its event has (a fact it lacks makes a condition fail). */
export const TRIGGER_CONDITION_FIELDS: Record<SmsTrigger, RuleConditionField[]> = {
  order_created: [...RULE_CONDITION_FIELDS],
  payment_completed: [...RULE_CONDITION_FIELDS],
  fulfillment_created: [...RULE_CONDITION_FIELDS],
  delivery_confirmed: [...RULE_CONDITION_FIELDS],
  order_cancelled: [...RULE_CONDITION_FIELDS],
  refund_issued: ["order_total", "country"],
  checkout_abandoned: ["order_total", "country", "product", "customer_orders", "customer_spent"],
  customer_registered: ["country"],
  customer_birthday: [],
  customer_inactive: ["country", "customer_orders", "customer_spent", "days_since_last_order"],
  customer_vip: ["country", "customer_orders", "customer_spent", "days_since_last_order"],
};

/**
 * How often one automation may text one customer, by default. Each event texts a customer once
 * whatever the cap (the dedupe key), so order updates allow several a day (a customer with two
 * orders gets both confirmations); marketing texts reach a customer once a month at most.
 */
export const automationCapDefaults = (trigger: SmsTrigger): { maxPerCustomer: number; capDays: number } =>
  TRIGGER_INFO[trigger].category === "marketing" ? { maxPerCustomer: 1, capDays: 30 } : { maxPerCustomer: 10, capDays: 1 };

/**
 * An automation as the builder saves it. Its message is written in place and kept as the
 * automation's own template; what runs is still a rule (smsRuleSchema) with an approved template.
 * No cap given: automationCapDefaults.
 */
export const smsAutomationSchema = z
  .object({
    name: z.string().trim().min(1, "Give the automation a name.").max(80),
    trigger: z.enum(SMS_TRIGGERS),
    body: z.string().max(SMS_MAX_BODY),
    conditions: z.array(ruleConditionSchema).max(10).default([]),
    delayMinutes: z.number().int().min(0).max(43_200).default(0),
    discountCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,30}$/, "A discount code is letters, digits, - and _ only.")
      .nullish(),
    quietStart: hour.default(21),
    quietEnd: hour.default(9),
    useCustomerTimezone: z.boolean().default(true),
    maxPerCustomer: z.number().int().min(1).max(100).nullish(),
    capDays: z.number().int().min(1).max(365).nullish(),
    priority: z.number().int().min(1).max(100).default(50),
    /** Practice run: record in Message History what it would send, and send nothing. */
    dryRun: z.boolean().default(false),
    inactiveDays: z.number().int().min(14).max(1095).nullish(),
    vipMinOrders: z.number().int().min(2).max(10_000).nullish(),
    vipMinSpent: z.number().min(1).max(1e9).nullish(),
  })
  .superRefine((a, ctx) => {
    const allowed = new Set(TRIGGER_CONDITION_FIELDS[a.trigger]);
    a.conditions.forEach((c, i) => {
      if (!allowed.has(c.field)) ctx.addIssue({ code: "custom", path: ["conditions", i, "field"], message: `"${automationTriggerCard(a.trigger).label}" events have no ${RULE_CONDITION_LABEL[c.field].toLowerCase()} to compare.` });
    });
    if (a.trigger === "customer_inactive" && !a.inactiveDays) ctx.addIssue({ code: "custom", path: ["inactiveDays"], message: "Say after how many days without an order a customer counts as inactive." });
    if (a.trigger === "customer_vip" && !a.vipMinOrders && !a.vipMinSpent) ctx.addIssue({ code: "custom", path: ["vipMinOrders"], message: "Say how many orders or how much spend makes a VIP." });
    if (!TRIGGER_INFO[a.trigger].available) ctx.addIssue({ code: "custom", path: ["trigger"], message: TRIGGER_INFO[a.trigger].unavailableReason ?? "This event isn't available." });
  });
export type SmsAutomationInput = z.infer<typeof smsAutomationSchema>;

/** The rule an automation runs, with its template. */
export function automationRule(a: SmsAutomationInput, templateId: string): SmsRuleInput {
  const cap = automationCapDefaults(a.trigger);
  return smsRuleSchema.parse({
    name: a.name,
    trigger: a.trigger,
    conditions: a.conditions,
    delayMinutes: a.delayMinutes,
    templateId,
    discountCode: a.discountCode || null,
    quietStart: a.quietStart,
    quietEnd: a.quietEnd,
    useCustomerTimezone: a.useCustomerTimezone,
    maxPerCustomer: a.maxPerCustomer ?? cap.maxPerCustomer,
    capDays: a.capDays ?? cap.capDays,
    priority: a.priority,
    dryRun: a.dryRun,
    inactiveDays: a.trigger === "customer_inactive" ? a.inactiveDays : null,
    vipMinOrders: a.trigger === "customer_vip" ? a.vipMinOrders : null,
    vipMinSpent: a.trigger === "customer_vip" ? a.vipMinSpent : null,
  });
}

/**
 * What is wrong with an automation's message for its trigger, in the merchant's words: the
 * template checks for the trigger's category (an opt-out link on marketing, no marketing
 * variables on order updates, length, unknown variables), the details its event can't fill, and
 * a discount code the text shows but the automation doesn't give. Errors keep it from being
 * turned on; warnings don't.
 */
export function checkAutomationMessage(body: string, trigger: SmsTrigger, discountCode?: string | null): TemplateIssue[] {
  const out = checkTemplate({ category: TRIGGER_INFO[trigger].category, body });
  const missing = missingForTrigger(body, trigger);
  if (missing.length) {
    out.push({
      level: "error",
      code: "unsupported_variable",
      message: `"${automationTriggerCard(trigger).label}" texts have no ${missing.map((m) => SMS_VARIABLE_INFO[m].label.toLowerCase()).join(" or ")} to fill in: take ${missing.map((m) => `{{${m}}}`).join(", ")} out.`,
    });
  }
  if (templateVariables(body).used.includes("discount_code") && !discountCode?.trim()) out.push({ level: "error", code: "discount_code", message: "The text shows a discount code: enter the code (create it in Shopify first)." });
  return out;
}

/** The variables the builder's editor offers for a trigger, in the module's order ({{business_name}} stands in for {{store_name}}). */
export function automationVariables(trigger: SmsTrigger): SmsVariable[] {
  const can = new Set<SmsVariable>([...TRIGGER_INFO[trigger].variables, "business_name"]);
  return SMS_VARIABLES.filter((v) => can.has(v) && v !== "store_name");
}
