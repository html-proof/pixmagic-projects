/**
 * WhatsApp Automation's rules (docs/whatsapp.md), shared by the API, the worker and the dashboard
 * (`@app/shared/whatsapp`): how a store connects (a WhatsApp phone linked by QR code or pairing
 * code, through bizinsights' Evolution API service; or Meta's official Cloud API), the states a
 * connection and a message go through, message templates and their variables, who may receive
 * what (consent), automation triggers and conditions, campaigns, and the four-step setup.
 *
 * Pure: no I/O, no node: imports, safe in the browser. Phone numbers and sending hours are in
 * ./messaging.
 */
import { z } from "./zod";

// ---------------------------------------------------------------------------
// How a store connects
// ---------------------------------------------------------------------------

/**
 * `qr`: a WhatsApp or WhatsApp Business app on the merchant's phone, linked as a device (WhatsApp
 * Web's protocol, through Evolution API's Baileys integration). `cloud_api`: Meta's WhatsApp
 * Business Platform, connected with Meta's Embedded Signup (Evolution API's WHATSAPP-BUSINESS
 * integration sends through it).
 */
export const WA_PROVIDERS = ["qr", "cloud_api"] as const;
export type WaProvider = (typeof WA_PROVIDERS)[number];

export interface ProviderInfo {
  label: string;
  /** One line for a picker. */
  short: string;
  /** Meta's official business messaging (true), or WhatsApp Web's linked-device protocol (false). */
  official: boolean;
  /** What the merchant gets, in plain words. */
  good: string[];
  /** What the merchant must know before choosing it. Shown in full before anything is created. */
  limits: string[];
}

export const PROVIDER_INFO: Record<WaProvider, ProviderInfo> = {
  cloud_api: {
    label: "Official WhatsApp Business Platform (Cloud API)",
    short: "Meta's official API for business messaging: approved templates, a verified business, higher volumes.",
    official: true,
    good: [
      "Meta's official way for businesses to message customers, with message templates Meta reviews",
      "Built for higher volumes, with delivery reports from Meta",
      "Your number stays on Meta's servers: no phone needs to stay online",
    ],
    limits: [
      "You sign in with Meta and pick or create a WhatsApp Business account; Meta may ask to verify your business",
      "Messages that start a conversation must use a template Meta approved; Meta charges per conversation",
      "A number used here can't also be used in the WhatsApp app on a phone",
    ],
  },
  qr: {
    label: "Link a WhatsApp phone with a QR code",
    short: "Link the WhatsApp or WhatsApp Business app on your phone, like WhatsApp Web. Quick to set up.",
    official: false,
    good: [
      "Ready in a minute: scan a code with the phone that has your business's WhatsApp",
      "Messages come from your existing number and appear in the app on your phone",
      "No Meta business verification or template review",
    ],
    limits: [
      "This uses WhatsApp Web's linked-device connection, not Meta's official business API. WhatsApp's terms limit automated and bulk messages from the app, and WhatsApp may restrict or ban a number it sees sending unwanted messages",
      "Keep the phone connected to the internet at least every 14 days, or WhatsApp logs the link out",
      "bizinsights paces messages and caps how many go out a day to protect your number; it is not built for large broadcasts",
      "Delivery and read reports depend on WhatsApp sending them: some messages may only ever show as sent",
    ],
  },
};

// ---------------------------------------------------------------------------
// Connection states (what the provider last said, never assumed)
// ---------------------------------------------------------------------------

/**
 * pairing: created, waiting for the phone to scan the code (or type the pairing code)
 * connected: the provider reports the connection open
 * reconnecting: the provider lost the connection and is reconnecting by itself
 * logged_out: the phone (or WhatsApp) ended the link; it must be paired again
 * failed: pairing gave up (the codes ran out) or the provider refused the connection
 * disconnected: the merchant disconnected it (the provider's instance is deleted); history is kept
 */
export const WA_CONNECTION_STATUSES = ["pairing", "connected", "reconnecting", "logged_out", "failed", "disconnected"] as const;
export type WaConnectionStatus = (typeof WA_CONNECTION_STATUSES)[number];

export const WA_CONNECTION_LABEL: Record<WaConnectionStatus, string> = {
  pairing: "Waiting for your phone",
  connected: "Connected",
  reconnecting: "Reconnecting",
  logged_out: "Logged out",
  failed: "Not connected",
  disconnected: "Disconnected",
};

/** Whether a connection in this state can send now. */
export const waCanSend = (status: string | null | undefined) => status === "connected";

/**
 * Evolution API's connection state (`open`, `connecting`, `close`, and `refused` once its QR codes
 * run out) as a connection status. `connecting` on a connection that was connected before is the
 * provider reconnecting; before that, it is waiting for the phone.
 */
export function connectionStatusFromProvider(state: string | null | undefined, previous: WaConnectionStatus | null): WaConnectionStatus | null {
  switch (state) {
    case "open":
      return "connected";
    case "connecting":
      return previous === "connected" || previous === "reconnecting" ? "reconnecting" : "pairing";
    case "refused":
      return "failed";
    case "close":
      return previous === "connected" || previous === "reconnecting" ? "reconnecting" : previous === "pairing" ? "failed" : previous;
    default:
      return null;
  }
}

/**
 * WhatsApp's (Baileys') reasons a connection closed, as Evolution API reports them in
 * `statusReason`. 401 (logged out) and 403 (forbidden) end the link: it must be paired again.
 */
export function closeReasonLabel(code: number | null | undefined): string | null {
  switch (code) {
    case 401:
      return "The phone logged this link out (or removed it under Linked devices).";
    case 403:
      return "WhatsApp refused this number's connection. Open WhatsApp on the phone for details.";
    case 408:
      return "The connection timed out.";
    case 411:
      return "WhatsApp asked for the link to be set up again.";
    case 428:
      return "WhatsApp closed the connection.";
    case 440:
      return "This link was replaced by another session of the same account.";
    case 500:
      return "The session's keys stopped working; pair the phone again.";
    case 503:
      return "WhatsApp was unavailable.";
    case 515:
      return "WhatsApp asked for a restart.";
    default:
      return null;
  }
}

/** Close reasons after which reconnecting by itself can't work. */
export const isTerminalCloseReason = (code: number | null | undefined) => code === 401 || code === 403 || code === 500;

// ---------------------------------------------------------------------------
// Messages and their states
// ---------------------------------------------------------------------------

/**
 * queued (waiting its time or its turn) → sending (handed to the worker) → accepted (the provider
 * took it; nothing from WhatsApp yet) → sent (WhatsApp's server has it) → delivered (on the
 * customer's phone) → read. failed / cancelled / skipped end it with a reason. received: a
 * customer's message to the store.
 */
export const WA_MESSAGE_STATUSES = ["queued", "sending", "accepted", "sent", "delivered", "read", "failed", "cancelled", "skipped", "received"] as const;
export type WaMessageStatus = (typeof WA_MESSAGE_STATUSES)[number];

export const WA_MESSAGE_LABEL: Record<WaMessageStatus, string> = {
  queued: "Waiting to send",
  sending: "Sending",
  accepted: "Accepted (no report from WhatsApp yet)",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Not sent",
  received: "Received",
};

/** How far along a message is: a status report never moves it back. */
const STATUS_RANK: Partial<Record<WaMessageStatus, number>> = { queued: 0, sending: 1, accepted: 2, sent: 3, delivered: 4, read: 5 };

/** Finished: nothing more will happen to it (read can still follow delivered; it is not final). */
export const isFinalStatus = (s: string) => s === "read" || s === "failed" || s === "cancelled" || s === "skipped" || s === "received";

/**
 * The provider's word for a message's state (Evolution API: Baileys' ERROR, PENDING, SERVER_ACK,
 * DELIVERY_ACK, READ, PLAYED; Meta's sent, delivered, read, failed upper-cased) as a status, or
 * null when it isn't one bizinsights knows (it is then recorded but changes nothing).
 */
export function messageStatusFromProvider(status: string | null | undefined): WaMessageStatus | null {
  switch ((status ?? "").toUpperCase()) {
    case "PENDING":
      return "accepted";
    case "SERVER_ACK":
    case "SENT":
      return "sent";
    case "DELIVERY_ACK":
    case "DELIVERED":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    case "ERROR":
    case "FAILED":
      return "failed";
    default:
      return null;
  }
}

/**
 * The status a message moves to when a report arrives, or null when the report changes nothing:
 * reports arrive out of order and more than once, so a message only moves forward, and "failed"
 * can't follow a delivery.
 */
export function statusAfterReport(current: string, reported: WaMessageStatus): WaMessageStatus | null {
  if (current === reported) return null;
  if (current === "cancelled" || current === "skipped" || current === "received") return null;
  if (reported === "failed") return (STATUS_RANK[current as WaMessageStatus] ?? 99) < (STATUS_RANK.delivered ?? 4) ? "failed" : null;
  const to = STATUS_RANK[reported];
  if (to === undefined) return null;
  if (current === "failed") return to >= (STATUS_RANK.delivered ?? 4) ? reported : null;
  const from = STATUS_RANK[current as WaMessageStatus];
  return from === undefined || to > from ? reported : null;
}

/** Grouping for the statistics: what reached WhatsApp, what reached the customer, what didn't. */
export function statusBucket(status: string): "waiting" | "sent" | "delivered" | "read" | "failed" | "not_sent" | "received" {
  if (status === "queued" || status === "sending") return "waiting";
  if (status === "accepted" || status === "sent") return "sent";
  if (status === "delivered") return "delivered";
  if (status === "read") return "read";
  if (status === "failed") return "failed";
  if (status === "received") return "received";
  return "not_sent";
}

/** Why a message wasn't sent, is held, or was cancelled. */
export const WA_SKIP_REASONS = [
  "opted_out",
  "suppressed",
  "no_consent",
  "no_marketing_consent",
  "consent_basis_unset",
  "marketing_off",
  "no_phone",
  "invalid_phone",
  "not_on_whatsapp",
  "not_connected",
  "connection_changed",
  "automation_paused",
  "automation_off",
  "daily_limit",
  "customer_limit",
  "duplicate",
  "conditions",
  "stale_event",
  "order_cancelled",
  "checkout_completed",
  "template_unavailable",
  "missing_values",
  "test_mode",
  "campaign_cancelled",
  "provider_rejected",
  "gave_up",
  "unknown_contact",
  "manual_cancel",
  "qr_linking_retired",
  "outside_window",
] as const;
export type WaSkipReason = (typeof WA_SKIP_REASONS)[number];

export const WA_SKIP_LABEL: Record<WaSkipReason, string> = {
  opted_out: "The customer opted out of WhatsApp messages",
  suppressed: "The number is on the store's do-not-message list",
  no_consent: "The customer hasn't agreed to WhatsApp updates",
  no_marketing_consent: "The customer hasn't agreed to marketing messages",
  consent_basis_unset: "The store hasn't chosen how customers agree to order updates (Settings)",
  marketing_off: "Marketing messages are switched off in Settings",
  no_phone: "No phone number on the order or customer",
  invalid_phone: "The phone number isn't a valid international number",
  not_on_whatsapp: "The number isn't on WhatsApp",
  not_connected: "WhatsApp wasn't connected",
  connection_changed: "The WhatsApp connection changed before it was sent",
  automation_paused: "All automation was paused",
  automation_off: "The automation was switched off",
  daily_limit: "The store's daily message limit was reached",
  customer_limit: "The customer already got the most messages allowed today",
  duplicate: "Already sent for this event",
  conditions: "The automation's conditions didn't match",
  stale_event: "The event was too old to message about",
  order_cancelled: "The order was cancelled",
  checkout_completed: "The customer finished their checkout",
  template_unavailable: "The template was switched off, deleted or isn't approved",
  missing_values: "A value the template needs wasn't in the event",
  test_mode: "Test mode: sent to the store's test number instead",
  campaign_cancelled: "The campaign was cancelled",
  provider_rejected: "WhatsApp refused it",
  gave_up: "Couldn't be sent after several tries",
  unknown_contact: "The number isn't one of the store's customers",
  manual_cancel: "Cancelled by the store",
  qr_linking_retired: "Cancelled on 28 October, while QR-code linking was switched off (it wasn't sent)",
  outside_window: "The customer last wrote more than 24 hours ago: only a template Meta approved can be sent",
};

export const waSkipLabel = (reason: string | null | undefined): string | null =>
  reason ? (WA_SKIP_LABEL[reason as WaSkipReason] ?? reason.replace(/_/g, " ")) : null;

/** Delays before each retry of a send that failed for a reason that can pass (the provider down, a timeout). */
export const WA_RETRY_DELAYS_S = [30, 120, 600, 1800];
export const WA_MAX_SEND_ATTEMPTS = WA_RETRY_DELAYS_S.length + 1;

// ---------------------------------------------------------------------------
// Sending limits (per connection; protect the merchant's number and the platform)
// ---------------------------------------------------------------------------

/**
 * A linked phone (QR) gets at most one message every QR_MIN_GAP_MS, plus a random extra pause, so
 * a burst looks like a person typing rather than a broadcast. The Cloud API is paced per second.
 */
export const QR_MIN_GAP_MS = 4_000;
export const QR_GAP_JITTER_MS = 4_000;
export const CLOUD_SENDS_PER_SECOND = 20;
/** Messages a store may start in a day by default, and the most it may choose, per provider. */
export const WA_DAILY_LIMIT: Record<WaProvider, { default: number; max: number }> = { qr: { default: 200, max: 1000 }, cloud_api: { default: 1000, max: 100_000 } };
/** Business-started messages one customer may get in a day by default (a reply to their message doesn't count). */
export const WA_PER_CUSTOMER_DAILY = { default: 3, max: 10 };

// ---------------------------------------------------------------------------
// Variables, templates and rendering
// ---------------------------------------------------------------------------

/** Values a template can use. Each comes from Shopify's verified events or the store's settings, never from a customer's message. */
export const WA_VARIABLES = [
  "customer_first_name",
  "store_name",
  "order_number",
  "order_total",
  "product_names",
  "order_status_url",
  "tracking_number",
  "tracking_url",
  "carrier",
  "checkout_url",
] as const;
export type WaVariable = (typeof WA_VARIABLES)[number];

export const WA_VARIABLE_INFO: Record<WaVariable, { label: string; sample: string }> = {
  customer_first_name: { label: "Customer's first name", sample: "Sam" },
  store_name: { label: "Your business name", sample: "Example Store" },
  order_number: { label: "Order number", sample: "#1042" },
  order_total: { label: "Order total", sample: "$58.00" },
  product_names: { label: "Products", sample: "Linen shirt ×2, Canvas tote" },
  order_status_url: { label: "Order status page link", sample: "https://example.com/orders/1042" },
  tracking_number: { label: "Tracking number", sample: "LX123456789AU" },
  tracking_url: { label: "Tracking link", sample: "https://track.example.com/LX123456789AU" },
  carrier: { label: "Carrier", sample: "Australia Post" },
  checkout_url: { label: "Checkout link", sample: "https://example.com/checkouts/abc" },
};

export type WaValues = Partial<Record<WaVariable, string>>;

/** The sample values the previews and test messages use. */
export const waSampleValues = (storeName?: string | null): WaValues => {
  const out: WaValues = {};
  for (const v of WA_VARIABLES) out[v] = WA_VARIABLE_INFO[v].sample;
  if (storeName) out.store_name = storeName;
  return out;
};

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** The variables a text uses, each once, in the order they first appear (unknown names included). */
export function variablesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VARIABLE_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * A value as it may go into a message: one line, no control characters, at most `max` characters.
 * Values are put in after the template is read, so a value that looks like {{a_variable}} stays text.
 */
export function cleanValue(value: string | null | undefined, max = 200): string {
  const v = (value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

export class WaMissingValueError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing values: ${missing.join(", ")}`);
    this.name = "WaMissingValueError";
  }
}

/**
 * The text a customer receives. Every variable must have a value (an empty one too would read
 * "Hi , your order…"), else WaMissingValueError lists them; `lenient` fills missing ones with ""
 * for previews instead.
 */
export function renderWaText(body: string, values: WaValues, opts: { lenient?: boolean } = {}): string {
  const missing: string[] = [];
  const out = body.replace(VARIABLE_RE, (_all, name: string) => {
    const v = (values as Record<string, string | undefined>)[name];
    const clean = cleanValue(v, name.endsWith("_url") ? 500 : 200);
    if (!clean) missing.push(name);
    return clean;
  });
  if (missing.length && !opts.lenient) throw new WaMissingValueError([...new Set(missing)]);
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/** transactional: about something the customer did (an order, a checkout they asked about); marketing: promotions, reminders, news. */
export const WA_TEMPLATE_CATEGORIES = ["transactional", "marketing"] as const;
export type WaTemplateCategory = (typeof WA_TEMPLATE_CATEGORIES)[number];

export const WA_CATEGORY_INFO: Record<WaTemplateCategory, { label: string; help: string }> = {
  transactional: {
    label: "Order and service update",
    help: "About something the customer did: their order, payment, shipping or a question they asked. Goes to customers under the consent choice in Settings.",
  },
  marketing: {
    label: "Marketing",
    help: "Promotions, cart reminders, news. Only goes to customers who agreed to marketing messages, and must tell them how to stop (Reply STOP).",
  },
};

/** WhatsApp's own limit is 4,096 characters; a template of Meta's allows 1,024 in its body. */
export const WA_TEXT_MAX = 1024;

export const waTemplateSchema = z.object({
  name: z.string().trim().min(1, "Give the template a name").max(80),
  category: z.enum(WA_TEMPLATE_CATEGORIES),
  body: z.string().trim().min(1, "Write the message").max(WA_TEXT_MAX, `At most ${WA_TEXT_MAX} characters`),
  active: z.boolean().default(true),
});
export type WaTemplateInput = z.output<typeof waTemplateSchema>;

export interface WaTemplateIssue {
  level: "error" | "warning";
  message: string;
}

const SHORTENERS = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rb\.gy)\//i;

/** What's wrong with a template before it can be saved (errors) or what may hurt it (warnings). */
export function waTemplateIssues(t: Pick<WaTemplateInput, "body" | "category">): WaTemplateIssue[] {
  const out: WaTemplateIssue[] = [];
  const body = t.body.trim();
  if (!body) out.push({ level: "error", message: "Write the message." });
  if (body.length > WA_TEXT_MAX) out.push({ level: "error", message: `The message is ${body.length} characters; WhatsApp templates allow ${WA_TEXT_MAX}.` });
  const unknown = variablesIn(body).filter((v) => !(WA_VARIABLES as readonly string[]).includes(v));
  if (unknown.length) out.push({ level: "error", message: `Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map((v) => `{{${v}}}`).join(", ")}. Use the variables listed beside the editor.` });
  if (/\{\{|\}\}/.test(body.replace(VARIABLE_RE, ""))) out.push({ level: "error", message: "A variable is missing a brace: write it as {{customer_first_name}}." });
  if (t.category === "marketing" && !/\bstop\b/i.test(body)) out.push({ level: "error", message: 'Marketing messages must say how to stop them, for example "Reply STOP to unsubscribe."' });
  if (SHORTENERS.test(body)) out.push({ level: "warning", message: "Link shorteners make messages look like spam to customers and WhatsApp. Use your store's own links." });
  if (/^[^a-z]*$/.test(body) && /[A-Z]{12,}/.test(body)) out.push({ level: "warning", message: "A message in capitals reads as shouting." });
  return out;
}

export const waHasErrors = (issues: WaTemplateIssue[]) => issues.some((i) => i.level === "error");

/** Ready-made templates the editor starts from. */
export const WA_STARTER_TEMPLATES: Array<{ key: string; name: string; category: WaTemplateCategory; body: string }> = [
  { key: "order_confirmation", name: "Order confirmation", category: "transactional", body: "Hi {{customer_first_name}}, thanks for your order {{order_number}} from {{store_name}}! Total: {{order_total}}. We'll message you when it ships." },
  { key: "payment_received", name: "Payment received", category: "transactional", body: "Hi {{customer_first_name}}, we've received your payment for order {{order_number}}. Thank you for shopping with {{store_name}}." },
  {
    key: "shipping_update",
    name: "Shipping update",
    category: "transactional",
    body: "Good news {{customer_first_name}}: your order {{order_number}} is on its way with {{carrier}}. Track it here: {{tracking_url}}",
  },
  { key: "order_cancelled", name: "Order cancelled", category: "transactional", body: "Hi {{customer_first_name}}, your order {{order_number}} from {{store_name}} has been cancelled. Reply here if you have any questions." },
  {
    key: "abandoned_checkout",
    name: "Cart reminder",
    category: "marketing",
    body: "Hi {{customer_first_name}}, you left {{product_names}} in your cart at {{store_name}}. Finish your order here: {{checkout_url}}\n\nReply STOP to unsubscribe.",
  },
  { key: "welcome", name: "Welcome", category: "marketing", body: "Welcome to {{store_name}}, {{customer_first_name}}! We'll share news and offers here now and then.\n\nReply STOP to unsubscribe." },
  { key: "auto_reply", name: "Auto-reply", category: "transactional", body: "Thanks for your message! The {{store_name}} team will get back to you as soon as we can." },
];

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * How customers agree to order updates on WhatsApp (the store chooses, in Settings):
 * opt_in_only: only customers who agreed (marketing consent, START, or recorded by the store);
 * checkout_notice: the store tells customers at checkout that order updates come by WhatsApp,
 * and every customer with a number gets them unless they opted out.
 */
export const WA_ORDER_UPDATE_BASES = ["unset", "opt_in_only", "checkout_notice"] as const;
export type WaOrderUpdateBasis = (typeof WA_ORDER_UPDATE_BASES)[number];

export const WA_ORDER_UPDATE_INFO: Record<WaOrderUpdateBasis, { label: string; help: string }> = {
  unset: { label: "Not chosen yet", help: "Order updates can't be sent until you choose." },
  opt_in_only: { label: "Only customers who agreed", help: "Customers who agreed to WhatsApp or text messages, replied START, or whose consent you recorded." },
  checkout_notice: {
    label: "Customers told at checkout",
    help: "Your checkout or privacy policy tells customers order updates come by WhatsApp. Everyone with a number gets them unless they reply STOP.",
  },
};

export type WaMarketingState = "opted_in" | "opted_out" | "unknown";

export interface WaConsentFacts {
  /** Replied STOP or was opted out: nothing at all is sent. */
  optedOut: boolean;
  /** Agreed to order updates themselves (START, recorded by the store). */
  optedIn: boolean;
  marketing: WaMarketingState;
  /** On the store's do-not-message list for this purpose. */
  suppressed: boolean;
}

/** Why a message of this category may not go to this customer (null: it may). */
export function waConsentProblem(category: WaTemplateCategory, c: WaConsentFacts, s: { orderUpdates: WaOrderUpdateBasis; marketingEnabled: boolean }): WaSkipReason | null {
  if (c.optedOut) return "opted_out";
  if (c.suppressed) return "suppressed";
  if (category === "marketing") {
    if (!s.marketingEnabled) return "marketing_off";
    return c.marketing === "opted_in" ? null : "no_marketing_consent";
  }
  if (s.orderUpdates === "unset") return "consent_basis_unset";
  if (s.orderUpdates === "opt_in_only" && !c.optedIn && c.marketing !== "opted_in") return "no_consent";
  return null;
}

const keyword = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!¡¿?"'*_]/g, "")
    .replace(/\s+/g, " ");
const STOP_WORDS = new Set(["stop", "unsubscribe", "stop all", "opt out", "optout", "cancel messages", "parar", "sair", "arrêt", "arret", "stopp", "basta"]);
const START_WORDS = new Set(["start", "subscribe", "unstop", "opt in", "optin", "yes start"]);

/** A customer's reply that opts them out of everything (STOP), or back in (START). */
export const waIsStop = (text: string | null | undefined) => !!text && STOP_WORDS.has(keyword(text));
export const waIsStart = (text: string | null | undefined) => !!text && START_WORDS.has(keyword(text));

/** Where a consent change came from. */
export const WA_CONSENT_SOURCES = ["whatsapp_stop", "whatsapp_start", "shopify_sms", "merchant", "zapier", "customer_redact"] as const;
export type WaConsentSource = (typeof WA_CONSENT_SOURCES)[number];

export const WA_CONSENT_SOURCE_LABEL: Record<WaConsentSource, string> = {
  whatsapp_stop: "Replied STOP on WhatsApp",
  whatsapp_start: "Replied START on WhatsApp",
  shopify_sms: "Shopify's text-message consent (the store says it covers WhatsApp)",
  merchant: "Recorded by the store",
  zapier: "Recorded by the store's Zap in Zapier (the Zap said the customer agreed)",
  customer_redact: "Erased at the customer's request",
};

/** The store's do-not-message list: everything, or marketing only. */
export const WA_SUPPRESSION_SCOPES = ["all", "marketing"] as const;
export type WaSuppressionScope = (typeof WA_SUPPRESSION_SCOPES)[number];

// ---------------------------------------------------------------------------
// Automation triggers and conditions
// ---------------------------------------------------------------------------

export const WA_TRIGGERS = ["order_created", "order_paid", "order_fulfilled", "order_cancelled", "checkout_abandoned", "customer_created", "message_received"] as const;
export type WaTrigger = (typeof WA_TRIGGERS)[number];

export interface WaTriggerInfo {
  label: string;
  description: string;
  /** Shopify's webhook topics that start it (empty: not a Shopify event). */
  topics: string[];
  /** The kind of template it sends: a cart reminder or a welcome is marketing. */
  category: WaTemplateCategory;
  variables: WaVariable[];
  /** A sensible wait before sending (minutes). */
  defaultDelayMinutes: number;
}

const ORDER_VARS: WaVariable[] = ["customer_first_name", "store_name", "order_number", "order_total", "product_names", "order_status_url"];

export const WA_TRIGGER_INFO: Record<WaTrigger, WaTriggerInfo> = {
  order_created: { label: "An order is placed", description: "Shopify tells bizinsights about a new order.", topics: ["orders/create"], category: "transactional", variables: ORDER_VARS, defaultDelayMinutes: 0 },
  order_paid: { label: "An order is paid", description: "Shopify marks an order paid.", topics: ["orders/paid"], category: "transactional", variables: ORDER_VARS, defaultDelayMinutes: 0 },
  order_fulfilled: {
    label: "An order ships",
    description: "The first parcel of an order is fulfilled (with its tracking when there is one).",
    topics: ["orders/fulfilled", "orders/partially_fulfilled"],
    category: "transactional",
    variables: [...ORDER_VARS, "tracking_number", "tracking_url", "carrier"],
    defaultDelayMinutes: 0,
  },
  order_cancelled: { label: "An order is cancelled", description: "Shopify cancels an order.", topics: ["orders/cancelled"], category: "transactional", variables: ORDER_VARS, defaultDelayMinutes: 0 },
  checkout_abandoned: {
    label: "A checkout is left unfinished",
    description: "A customer entered their number at checkout and didn't finish. Timed from their last change; finishing the order cancels it.",
    topics: ["checkouts/create", "checkouts/update"],
    category: "marketing",
    variables: ["customer_first_name", "store_name", "order_total", "product_names", "checkout_url"],
    defaultDelayMinutes: 60,
  },
  customer_created: {
    label: "A customer signs up",
    description: "A new customer account is created in Shopify (needs access to your customers).",
    topics: ["customers/create"],
    category: "marketing",
    variables: ["customer_first_name", "store_name"],
    defaultDelayMinutes: 0,
  },
  message_received: {
    label: "A customer sends a message",
    description: "A customer writes to your WhatsApp number. Replies at most once per customer in the cool-down you set.",
    topics: [],
    category: "transactional",
    variables: ["customer_first_name", "store_name"],
    defaultDelayMinutes: 0,
  },
};

export const WA_CONDITION_FIELDS = ["order_total", "country", "product", "customer_type", "order_tag", "message_text"] as const;
export type WaConditionField = (typeof WA_CONDITION_FIELDS)[number];

export const waConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("order_total"), op: z.enum(["gte", "lte"]), value: z.number().min(0).max(1_000_000_000) }),
  z.object({ field: z.literal("country"), op: z.enum(["in", "not_in"]), value: z.array(z.string().trim().length(2).toUpperCase()).min(1).max(50) }),
  z.object({ field: z.literal("product"), op: z.literal("contains"), value: z.string().trim().min(1).max(100) }),
  z.object({ field: z.literal("customer_type"), op: z.literal("is"), value: z.enum(["new", "returning"]) }),
  z.object({ field: z.literal("order_tag"), op: z.literal("has"), value: z.string().trim().min(1).max(60) }),
  z.object({ field: z.literal("message_text"), op: z.enum(["contains", "equals"]), value: z.string().trim().min(1).max(100) }),
]);
export type WaCondition = z.output<typeof waConditionSchema>;

/** The conditions a trigger's events can answer. */
export function waConditionFields(trigger: WaTrigger): WaConditionField[] {
  if (trigger === "message_received") return ["message_text"];
  if (trigger === "customer_created") return ["country"];
  if (trigger === "checkout_abandoned") return ["order_total", "country", "product", "customer_type"];
  return ["order_total", "country", "product", "customer_type", "order_tag"];
}

/** What an event says, for the conditions. Null: the event didn't carry it (a condition on it then doesn't match). */
export interface WaFacts {
  orderTotal: number | null;
  country: string | null;
  productTitles: string[];
  customerType: "new" | "returning" | null;
  tags: string[];
  messageText: string | null;
}

export const WA_CONDITION_LABEL: Record<WaConditionField, string> = {
  order_total: "Order total",
  country: "Country",
  product: "Product",
  customer_type: "Customer",
  order_tag: "Order tag",
  message_text: "Message",
};

export function describeWaCondition(c: WaCondition): string {
  switch (c.field) {
    case "order_total":
      return `Order total ${c.op === "gte" ? "at least" : "at most"} ${c.value}`;
    case "country":
      return `Country ${c.op === "in" ? "is" : "is not"} ${c.value.join(", ")}`;
    case "product":
      return `A product's name contains "${c.value}"`;
    case "customer_type":
      return c.value === "new" ? "First order" : "Returning customer";
    case "order_tag":
      return `Order tagged "${c.value}"`;
    case "message_text":
      return `Message ${c.op === "equals" ? "is" : "contains"} "${c.value}"`;
  }
}

/** Whether an event passes every condition, and which didn't. */
export function evaluateWaConditions(conditions: WaCondition[], f: WaFacts): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  const low = (s: string) => s.toLowerCase();
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
        ok = f.productTitles.some((t) => low(t).includes(low(c.value)));
        break;
      case "customer_type":
        ok = f.customerType === c.value;
        break;
      case "order_tag":
        ok = f.tags.some((t) => low(t) === low(c.value));
        break;
      case "message_text": {
        const text = low((f.messageText ?? "").trim());
        ok = !!text && (c.op === "equals" ? text === low(c.value) : text.includes(low(c.value)));
        break;
      }
    }
    if (!ok) failed.push(describeWaCondition(c));
  }
  return { pass: failed.length === 0, failed };
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

/** Who the message goes to: the customer's own number, or the number on the shipping or billing address. */
export const WA_RECIPIENTS = ["customer", "shipping_address", "billing_address"] as const;
export type WaRecipient = (typeof WA_RECIPIENTS)[number];

export const WA_RECIPIENT_LABEL: Record<WaRecipient, string> = {
  customer: "The customer's phone (from the order or account, then the addresses)",
  shipping_address: "The phone on the shipping address",
  billing_address: "The phone on the billing address",
};

export const waSendWindowSchema = z
  .object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(24) })
  .refine((w) => w.start !== w.end, "The start and end can't be the same hour");
export type WaSendWindow = z.output<typeof waSendWindowSchema>;
export const WA_DEFAULT_SEND_WINDOW: WaSendWindow = { start: 9, end: 20 };

/** The longest an automation may wait before sending (minutes): 30 days. */
export const WA_MAX_DELAY_MINUTES = 30 * 24 * 60;

export const waAutomationSchema = z
  .object({
    name: z.string().trim().min(1, "Name the automation").max(80),
    description: z.string().trim().max(300).optional().nullable(),
    trigger: z.enum(WA_TRIGGERS),
    conditions: z.array(waConditionSchema).max(10).default([]),
    templateId: z.string().trim().min(1, "Pick a message template").max(40),
    recipient: z.enum(WA_RECIPIENTS).default("customer"),
    delayMinutes: z.number().int().min(0).max(WA_MAX_DELAY_MINUTES).default(0),
    /** Store-time hours it may send in; null: the store's sending hours. */
    sendWindow: waSendWindowSchema.nullable().default(null),
    /** Test mode: every message goes to the store's verified test number instead of the customer. */
    testMode: z.boolean().default(true),
    /** message_received only: the same customer gets this reply at most once in this many minutes. */
    cooldownMinutes: z.number().int().min(5).max(7 * 24 * 60).nullable().default(null),
  })
  .superRefine((a, ctx) => {
    const allowed = waConditionFields(a.trigger);
    a.conditions.forEach((c, i) => {
      if (!allowed.includes(c.field)) ctx.addIssue({ code: "custom", path: ["conditions", i], message: `"${WA_CONDITION_LABEL[c.field]}" can't be checked for "${WA_TRIGGER_INFO[a.trigger].label}"` });
    });
    if (a.trigger !== "message_received" && a.cooldownMinutes != null) ctx.addIssue({ code: "custom", path: ["cooldownMinutes"], message: "Only a reply to a customer's message has a cool-down" });
  });
export type WaAutomationInput = z.output<typeof waAutomationSchema>;

export const WA_AUTOMATION_STATUSES = ["draft", "active", "paused"] as const;
export type WaAutomationStatus = (typeof WA_AUTOMATION_STATUSES)[number];

/** The cool-down a reply automation gets when none is set: a day. */
export const WA_DEFAULT_REPLY_COOLDOWN = 24 * 60;

/** Ready-made automations (with the starter template each uses). */
export const WA_AUTOMATION_PRESETS: Array<{ key: string; name: string; trigger: WaTrigger; template: string; delayMinutes: number; description: string }> = [
  { key: "order_confirmation", name: "Order confirmation", trigger: "order_created", template: "order_confirmation", delayMinutes: 0, description: "Thank customers and confirm their order as soon as it's placed." },
  { key: "shipping_update", name: "Shipping update", trigger: "order_fulfilled", template: "shipping_update", delayMinutes: 0, description: "Send the tracking link when an order ships." },
  { key: "cart_reminder", name: "Cart reminder", trigger: "checkout_abandoned", template: "abandoned_checkout", delayMinutes: 60, description: "Remind customers who agreed to marketing about the checkout they left, an hour later." },
  { key: "auto_reply", name: "Auto-reply", trigger: "message_received", template: "auto_reply", delayMinutes: 0, description: "Let customers who write in know you'll get back to them (once a day each)." },
];

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const waAudienceSchema = z.object({
  countries: z.array(z.string().trim().length(2).toUpperCase()).max(50).default([]),
  customerType: z.enum(["any", "new", "returning"]).default("any"),
  orderedWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
  notOrderedForDays: z.number().int().min(1).max(3650).nullable().default(null),
  minOrders: z.number().int().min(1).max(100_000).nullable().default(null),
  minSpent: z.number().min(0).max(1_000_000_000).nullable().default(null),
});
export type WaAudience = z.output<typeof waAudienceSchema>;

export function describeWaAudience(a: WaAudience): string {
  const parts = ["Customers who agreed to marketing messages"];
  if (a.countries.length) parts.push(`in ${a.countries.join(", ")}`);
  if (a.customerType === "new") parts.push("with one order");
  if (a.customerType === "returning") parts.push("with more than one order");
  if (a.orderedWithinDays) parts.push(`who ordered in the last ${a.orderedWithinDays} days`);
  if (a.notOrderedForDays) parts.push(`who haven't ordered for ${a.notOrderedForDays} days`);
  if (a.minOrders) parts.push(`with at least ${a.minOrders} orders`);
  if (a.minSpent != null) parts.push(`who spent at least ${a.minSpent}`);
  return parts.join(", ");
}

export const waCampaignSchema = z.object({
  name: z.string().trim().min(1, "Name the campaign").max(80),
  templateId: z.string().trim().min(1, "Pick a marketing template").max(40),
  audience: waAudienceSchema,
});
export type WaCampaignInput = z.output<typeof waCampaignSchema>;

export const WA_CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "completed", "cancelled"] as const;
export type WaCampaignStatus = (typeof WA_CAMPAIGN_STATUSES)[number];

/** The most recipients one campaign may have, per provider: a linked phone isn't for broadcasts. */
export const WA_CAMPAIGN_MAX: Record<WaProvider, number> = { qr: 250, cloud_api: 100_000 };

export const waLaunchSchema = z.object({
  /** The recipient count the merchant saw and confirmed: launching refuses if the audience changed since. */
  confirmRecipients: z.number().int().min(1),
  /** Null: now. */
  scheduledAt: z.coerce.date().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const waSettingsSchema = z.object({
  businessName: z.string().trim().max(60).nullable(),
  orderUpdates: z.enum(WA_ORDER_UPDATE_BASES),
  marketingEnabled: z.boolean(),
  /** The store says its Shopify text-message consent wording covers WhatsApp too. */
  shopifySmsConsent: z.boolean(),
  sendWindow: waSendWindowSchema,
  timeZone: z.string().trim().min(1).max(64).nullable(),
  dailyLimit: z.number().int().min(1).max(100_000),
  perCustomerDailyLimit: z.number().int().min(1).max(WA_PER_CUSTOMER_DAILY.max),
  /** Days message texts are kept for the history (then only the record stays). */
  retentionDays: z.number().int().min(7).max(365),
});
export type WaSettingsInput = z.output<typeof waSettingsSchema>;

export const WA_DEFAULT_RETENTION_DAYS = 90;

/** Whether an IANA time zone name works (the browser and Node both accept it). */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Messages from the dashboard
// ---------------------------------------------------------------------------

/** Why the store may message this number: the merchant says so, and it is recorded with their name. */
export const WA_SEND_REASONS = ["order_update", "reply", "marketing"] as const;
export type WaSendReason = (typeof WA_SEND_REASONS)[number];

export const WA_SEND_REASON_INFO: Record<WaSendReason, { label: string; category: WaTemplateCategory }> = {
  order_update: { label: "About the customer's order", category: "transactional" },
  reply: { label: "Answering the customer's question", category: "transactional" },
  marketing: { label: "Marketing (the customer agreed to it)", category: "marketing" },
};

/** Attachments the composer accepts, and how big. */
export const WA_ATTACHMENT_TYPES: Record<string, "image" | "document"> = { "image/jpeg": "image", "image/png": "image", "image/webp": "image", "application/pdf": "document" };
export const WA_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

export const waSendSchema = z
  .object({
    phone: z.string().trim().min(6).max(32),
    /** The country to read a number typed without "+" in. */
    country: z.string().trim().length(2).toUpperCase().nullable().default(null),
    reason: z.enum(WA_SEND_REASONS),
    text: z.string().trim().max(WA_TEXT_MAX).default(""),
    templateId: z.string().trim().max(40).nullable().default(null),
    attachment: z
      .object({
        name: z.string().trim().min(1).max(120),
        mime: z.string().refine((m) => m in WA_ATTACHMENT_TYPES, "Attach a JPEG, PNG or WebP image, or a PDF"),
        /** The file, base64-encoded. */
        data: z.string().min(1).max(Math.ceil((WA_ATTACHMENT_MAX_BYTES * 4) / 3) + 8, "Attachments can be at most 3 MB"),
      })
      .nullable()
      .default(null),
    /** "The customer asked to be messaged on WhatsApp": recorded as consent from the store, with who said it. */
    customerAsked: z.boolean().default(false),
    /** Prevents a double press (or a retried request) sending twice: the same key sends once. */
    idempotencyKey: z.string().trim().min(8).max(80),
  })
  .refine((m) => m.text || m.templateId || m.attachment, { message: "Write a message, pick a template or attach a file", path: ["text"] });
export type WaSendInput = z.output<typeof waSendSchema>;

// ---------------------------------------------------------------------------
// Meta's Embedded Signup window (the Cloud API way to connect), as the browser hears it
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

/** Meta's screens in its window, in words (the step a person closed it at). */
export function signupStepLabel(step: string | null | undefined): string | null {
  if (!step) return null;
  const s = step.toUpperCase();
  if (s.includes("PHONE") || s.includes("VERIFY")) return "adding or verifying the phone number";
  if (s.includes("WABA") || s.includes("ACCOUNT")) return "choosing the WhatsApp Business account";
  if (s.includes("BUSINESS")) return "choosing the business portfolio";
  if (s.includes("PERMISSION")) return "reviewing permissions";
  return step.toLowerCase().replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// The four-step setup
// ---------------------------------------------------------------------------

export const WA_SETUP_STEPS = ["connect", "authorize", "configure", "test"] as const;
export type WaSetupStep = (typeof WA_SETUP_STEPS)[number];

export const WA_SETUP_STEP_INFO: Record<WaSetupStep, { label: string; help: string }> = {
  connect: { label: "Connect", help: "Choose how bizinsights connects to your WhatsApp." },
  authorize: { label: "Authorize", help: "Scan the code with your phone, or sign in with Meta." },
  configure: { label: "Configure", help: "Your business name, how customers agree to messages, sending hours." },
  test: { label: "Test and activate", help: "Send a test to your own verified number, then switch automations on." },
};

export interface WaSetupFacts {
  provider: WaProvider | null;
  status: WaConnectionStatus | null;
  configuredAt: Date | string | null;
  orderUpdates: WaOrderUpdateBasis;
  testVerifiedAt: Date | string | null;
  /** A test message the provider reported as sent (or further) since the connection was made. */
  testPassedAt: Date | string | null;
}

/** Each step done or not, and the first one that isn't (null: set up). */
export function waSetupProgress(f: WaSetupFacts): { done: Record<WaSetupStep, boolean>; current: WaSetupStep | null } {
  const done: Record<WaSetupStep, boolean> = {
    connect: !!f.provider && f.status !== "disconnected",
    authorize: f.status === "connected" || f.status === "reconnecting",
    configure: !!f.configuredAt && f.orderUpdates !== "unset",
    test: !!f.testVerifiedAt && !!f.testPassedAt,
  };
  const current = WA_SETUP_STEPS.find((s) => !done[s]) ?? null;
  return { done, current };
}

/** What a page shows about automation as a whole. */
export type WaAutomationState = "not_connected" | "paused" | "setup" | "needs_attention" | "idle" | "active";

export const WA_AUTOMATION_STATE_LABEL: Record<WaAutomationState, string> = {
  not_connected: "Not connected",
  paused: "Paused",
  setup: "Finish setting up",
  needs_attention: "Needs attention",
  idle: "No automation on",
  active: "Running",
};

export function waAutomationState(f: { connected: boolean; paused: boolean; setupDone: boolean; active: number; blocked: number }): WaAutomationState {
  if (!f.connected) return "not_connected";
  if (f.paused) return "paused";
  if (!f.setupDone) return "setup";
  if (f.blocked) return "needs_attention";
  return f.active ? "active" : "idle";
}

/**
 * The notice Evolution API's licence asks for (its LICENSE, "Usage Notification Requirement"):
 * shown on the WhatsApp settings and in the docs.
 */
export const EVOLUTION_NOTICE =
  "WhatsApp connections run on Evolution API (https://github.com/evolution-foundation/evolution-api), open-source software by Evolution Foundation, licensed under the Apache License 2.0 with additional conditions.";
