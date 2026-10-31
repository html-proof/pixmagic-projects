/**
 * Automations: one four-step setup (connect, trigger, message, activate) and one place to watch
 * every channel's automated messages, over the channels' own engines (docs/automations.md).
 * Customer Messaging's SMS rules (`@app/shared/sms`) and the email module's rules
 * (`@app/shared/email`) stay what runs: this file only says how the hub names their triggers and
 * statuses, so the API and the page answer from the same table.
 *
 * Imported by the UI through `@app/shared/automations`: no I/O, no node: imports.
 */
import { z } from "./zod";
import {
  CUSTOM_EVENT_PATTERN,
  escapeHtml,
  frequencySchema,
  isAllowedVariable,
  isCustomEventType,
  MAX_DELAY_MINUTES,
  parseTemplate,
  placeholdersIn,
  templateVariables,
  type EventField,
  type ShopifyEventType,
} from "./email/index";
import { TRIGGER_INFO, type SmsTrigger } from "./sms";

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const HUB_CHANNELS = ["whatsapp", "sms", "email"] as const;
export type HubChannel = (typeof HUB_CHANNELS)[number];
/** The channels whose automations the hub creates and runs itself (WhatsApp keeps its own pages until its module joins). */
export const HUB_BUILDABLE: readonly HubChannel[] = ["sms", "email"];
export const isHubChannel = (c: string): c is HubChannel => (HUB_CHANNELS as readonly string[]).includes(c);

export interface ChannelInfo {
  label: string;
  /** Who carries the messages. */
  provider: string;
  description: string;
  /** What the business needs before its first message, in its own words. */
  requirements: string[];
  /** What bizinsights is allowed to do with the connection, and nothing more. */
  permissions: string[];
  /** Where the channel's own pages are (advanced settings, everything the hub doesn't show). */
  home: string;
}

export const CHANNEL_INFO: Record<HubChannel, ChannelInfo> = {
  whatsapp: {
    label: "WhatsApp Business",
    provider: "Meta WhatsApp Cloud API",
    description: "Order updates and approved template messages on WhatsApp, from your own WhatsApp Business number.",
    requirements: [
      "A Meta Business account and a WhatsApp Business account with a phone number.",
      "Message templates approved by Meta before they can start a conversation.",
      "Customers who agreed to hear from you on WhatsApp.",
    ],
    permissions: ["Send messages and templates from your number", "Read delivery and read receipts for those messages"],
    home: "/dashboard/whatsapp-automation",
  },
  sms: {
    label: "SMS",
    provider: "AWS End User Messaging SMS (bizinsights' account)",
    description: "Text messages to your customers' mobiles. bizinsights sends them; you need no AWS account and give no keys.",
    requirements: [
      "A sender name or number AWS has approved for your store's country (registered where the country requires it).",
      "A monthly SMS spending limit above zero.",
      "For order updates: how your customers agreed to get them by text. For marketing: Shopify's SMS marketing consent.",
    ],
    permissions: ["Send texts from the sender approved for your store", "Read AWS's delivery reports for those texts"],
    home: "/messaging",
  },
  email: {
    label: "Email",
    provider: "Your own mailbox (Gmail, Google Workspace, Outlook, Microsoft 365 or SMTP)",
    description: "Email from your own address, sent through the mailbox you connect.",
    requirements: [
      "A mailbox you can sign in to (Google or Microsoft), or your mail server's SMTP details.",
      "A verified sender address.",
      "For marketing email: the customer's email marketing consent and your postal address (printed in the footer).",
    ],
    permissions: ["Send email as the connected address (gmail.send or Mail.Send): no reading of your mail", "Nothing else in your mailbox"],
    home: "/settings/email",
  },
};

// ---------------------------------------------------------------------------
// Triggers: the hub's names, and what each channel runs for them
// ---------------------------------------------------------------------------

export const HUB_TRIGGERS = [
  "order_created",
  "payment_confirmed",
  "order_fulfilled",
  "order_delivered",
  "checkout_abandoned",
  "customer_signup",
  "order_cancelled",
  "refund_issued",
  "customer_inactive",
  "customer_vip",
  "customer_segment",
  "scheduled_message",
  "inbound_message",
  "external_event",
] as const;
export type HubTrigger = (typeof HUB_TRIGGERS)[number];
export const isHubTrigger = (t: string): t is HubTrigger => (HUB_TRIGGERS as readonly string[]).includes(t);

/** The icons the trigger cards use (lucide names; the page draws them). */
export type HubTriggerIcon = "shopping-bag" | "credit-card" | "truck" | "package-check" | "shopping-cart" | "user-plus" | "circle-x" | "undo" | "moon" | "crown" | "calendar-clock" | "message-circle-reply" | "webhook" | "users";

export interface HubTriggerInfo {
  key: HubTrigger;
  label: string;
  description: string;
  icon: HubTriggerIcon;
  /** Shown first; the rest are under "More triggers". */
  main: boolean;
  /** The SMS rule's trigger, or null with the reason it isn't offered for SMS. */
  sms: SmsTrigger | null;
  smsUnavailable?: string;
  /** Set when SMS runs it but only Customer Messaging's builder sets it up (it needs a choice the hub doesn't offer): why. */
  smsBuilderOnly?: string;
  /** The email rule's event (a Shopify event, or "custom": the business's own event through the event API), or null with the reason. */
  email: ShopifyEventType | "custom" | null;
  emailUnavailable?: string;
  /** Where something close to it is done instead, when the hub doesn't build it. */
  instead?: { label: string; href: string };
}

const SCHEDULED = "A message at a time you choose, to a group of customers, is a campaign rather than an automation.";
const INBOUND_SMS = "bizinsights texts from a one-way sender: replies other than STOP aren't read, so nothing can start from them.";
const INBOUND_EMAIL = "Connected mailboxes are send-only (gmail.send / Mail.Send): bizinsights can't read replies, so nothing can start from them.";

export const HUB_TRIGGER_INFO: Record<HubTrigger, HubTriggerInfo> = {
  order_created: { key: "order_created", label: "Order placed", description: "When a customer places an order in your Shopify store.", icon: "shopping-bag", main: true, sms: "order_created", email: "order.created" },
  payment_confirmed: {
    key: "payment_confirmed",
    label: "Payment confirmed",
    description: "When Shopify marks an order as paid.",
    icon: "credit-card",
    main: true,
    sms: "payment_completed",
    email: "order.paid",
  },
  order_fulfilled: {
    key: "order_fulfilled",
    label: "Order shipped or fulfilled",
    description: "When you fulfil an order (texts can carry the tracking link).",
    icon: "truck",
    main: true,
    sms: "fulfillment_created",
    email: "order.fulfilled",
  },
  order_delivered: {
    key: "order_delivered",
    label: "Order delivered",
    description: "When the carrier tells Shopify the parcel arrived.",
    icon: "package-check",
    main: false,
    sms: "delivery_confirmed",
    email: null,
    emailUnavailable: "Email automations don't receive Shopify's delivery updates yet.",
  },
  checkout_abandoned: {
    key: "checkout_abandoned",
    label: "Abandoned checkout",
    description: "When a customer leaves checkout with their contact details and doesn't order.",
    icon: "shopping-cart",
    main: true,
    sms: "checkout_abandoned",
    email: "checkout.abandoned",
  },
  customer_signup: {
    key: "customer_signup",
    label: "Customer signup",
    description: "When a customer creates an account with your store.",
    icon: "user-plus",
    main: true,
    sms: "customer_registered",
    email: null,
    emailUnavailable: "Email automations don't receive Shopify's new-customer event yet.",
  },
  order_cancelled: { key: "order_cancelled", label: "Order cancelled", description: "When an order is cancelled.", icon: "circle-x", main: false, sms: "order_cancelled", email: "order.cancelled" },
  refund_issued: {
    key: "refund_issued",
    label: "Refund issued",
    description: "When you refund an order.",
    icon: "undo",
    main: false,
    sms: "refund_issued",
    email: null,
    emailUnavailable: "Refunds aren't an email event yet.",
  },
  customer_inactive: {
    key: "customer_inactive",
    label: "Inactive customer",
    description: "Once a customer hasn't ordered for the number of days you choose (checked daily).",
    icon: "moon",
    main: false,
    sms: "customer_inactive",
    email: null,
    emailUnavailable: "Only SMS automations keep the order history this needs.",
  },
  customer_vip: {
    key: "customer_vip",
    label: "VIP customer",
    description: "Once a customer reaches the orders or spend you choose (checked daily).",
    icon: "crown",
    main: false,
    sms: "customer_vip",
    email: null,
    emailUnavailable: "Only SMS automations keep the order history this needs.",
  },
  customer_segment: {
    key: "customer_segment",
    label: "Customer joins a segment",
    description: "Once a customer matches one of your SMS customer segments (checked daily).",
    icon: "users",
    main: false,
    sms: "customer_segment",
    smsBuilderOnly: "The segment is chosen in Customer Messaging's SMS builder.",
    email: null,
    emailUnavailable: "Only SMS automations keep the customer segments this needs.",
    instead: { label: "Set it up in Customer Messaging", href: "/messaging/automations/edit?trigger=customer_segment" },
  },
  scheduled_message: {
    key: "scheduled_message",
    label: "Scheduled message",
    description: "At a date and time you choose, to customers you pick.",
    icon: "calendar-clock",
    main: true,
    sms: null,
    smsUnavailable: SCHEDULED,
    email: null,
    emailUnavailable: "Scheduled email to a group of customers isn't built: email automations start from events.",
    instead: { label: "Schedule an SMS campaign", href: "/messaging/campaigns" },
  },
  inbound_message: {
    key: "inbound_message",
    label: "Customer replies",
    description: "When a customer sends you a message.",
    icon: "message-circle-reply",
    main: false,
    sms: null,
    smsUnavailable: INBOUND_SMS,
    email: null,
    emailUnavailable: INBOUND_EMAIL,
    instead: { label: "WhatsApp handles replies on its own page", href: "/dashboard/whatsapp-automation" },
  },
  external_event: {
    key: "external_event",
    label: "Event from another app",
    description: "When your own system (bookings, invoices, a CRM) sends bizinsights an event through the event API.",
    icon: "webhook",
    main: true,
    sms: null,
    smsUnavailable: "Texts start only from Shopify's events: an event of your own can't start a text yet.",
    email: "custom",
  },
};

/** The hub's trigger for a channel's own one (null: the hub has no card for it). */
export function hubTriggerOfSms(t: string | null | undefined): HubTrigger | null {
  return HUB_TRIGGERS.find((k) => HUB_TRIGGER_INFO[k].sms === t) ?? null;
}
export function hubTriggerOfEmail(eventType: string | null | undefined): HubTrigger | null {
  if (!eventType) return null;
  if (isCustomEventType(eventType)) return "external_event";
  return HUB_TRIGGERS.find((k) => HUB_TRIGGER_INFO[k].email === eventType) ?? null;
}

/** Whether a channel can run a trigger at all, and why not (the store's own state is the API's answer). */
export function channelRuns(trigger: HubTrigger, channel: HubChannel): { ok: true } | { ok: false; reason: string } {
  const info = HUB_TRIGGER_INFO[trigger];
  if (channel === "whatsapp") return { ok: false, reason: "WhatsApp automations are set up on the WhatsApp page." };
  if (channel === "sms") {
    if (!info.sms) return { ok: false, reason: info.smsUnavailable ?? "Not available for SMS." };
    if (info.smsBuilderOnly) return { ok: false, reason: info.smsBuilderOnly };
    if (!TRIGGER_INFO[info.sms].available) return { ok: false, reason: TRIGGER_INFO[info.sms].unavailableReason ?? "Not available for SMS." };
    return { ok: true };
  }
  if (!info.email) return { ok: false, reason: info.emailUnavailable ?? "Not available for email." };
  return { ok: true };
}

/** Marketing (needs consent and an opt-out) or an update about something the customer did. */
export type MessageCategory = "transactional" | "marketing";

/** The category a trigger's message must have on a channel ("either" for the business's own events: it says which). */
export function triggerCategory(trigger: HubTrigger, channel: HubChannel): MessageCategory | "either" {
  const info = HUB_TRIGGER_INFO[trigger];
  if (channel === "sms" && info.sms) return TRIGGER_INFO[info.sms].category;
  if (info.email === "custom") return "either";
  return trigger === "checkout_abandoned" || trigger === "customer_signup" || trigger === "customer_inactive" || trigger === "customer_vip" || trigger === "customer_segment" ? "marketing" : "transactional";
}

// ---------------------------------------------------------------------------
// Message statuses: one scale for every channel
// ---------------------------------------------------------------------------

/**
 * What happened to a message, in the same words for every channel. "sent" means the provider
 * accepted it, which isn't a delivery; "delivered" only comes from the provider's delivery report;
 * "undelivered" is a message the provider accepted and then reported it couldn't deliver.
 */
export const HUB_STATUSES = ["queued", "processing", "sent", "delivered", "undelivered", "failed", "not_sent", "test_only", "unknown"] as const;
export type HubStatus = (typeof HUB_STATUSES)[number];
export const isHubStatus = (s: string): s is HubStatus => (HUB_STATUSES as readonly string[]).includes(s);

export type HubTone = "good" | "warn" | "bad" | "neutral";

export const HUB_STATUS_INFO: Record<HubStatus, { label: string; tone: HubTone; help: string }> = {
  queued: { label: "Queued", tone: "neutral", help: "Waiting for its time (a delay, quiet hours) or its turn to send." },
  processing: { label: "Processing", tone: "neutral", help: "Being handed to the provider now." },
  sent: { label: "Accepted by provider", tone: "neutral", help: "The provider took the message. That isn't proof it reached the customer: only a delivery report is." },
  delivered: { label: "Delivered", tone: "good", help: "The provider's delivery report confirmed it reached the customer's phone or mail server." },
  undelivered: { label: "Undelivered", tone: "bad", help: "The provider accepted it, then reported it couldn't be delivered (a refused number or address, a carrier block)." },
  failed: { label: "Failed", tone: "bad", help: "It couldn't be sent. The reason is shown with it." },
  not_sent: { label: "Not sent", tone: "warn", help: "Deliberately not sent: no consent, opted out, suppressed, outside the rules, or the automation stopped." },
  test_only: { label: "Test only", tone: "neutral", help: "Recorded, not sent: the automation is in test mode, or the platform's SMS is not live yet." },
  unknown: { label: "Outcome unknown", tone: "warn", help: "Sending was cut off after the provider may have taken it, or no final report came. It isn't re-sent by itself, to avoid a duplicate." },
};

/** SMS row statuses (Customer Messaging's sms_message_jobs) on the hub's scale. */
export function smsHubStatus(status: string): HubStatus {
  switch (status) {
    case "scheduled":
      return "queued";
    case "sending":
      return "processing";
    case "accepted":
    case "pending":
    case "carrier_accepted":
      return "sent";
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    case "dry_run":
      return "test_only";
    case "opted_out":
    case "skipped":
    case "cancelled":
      return "not_sent";
    default:
      return "unknown";
  }
}

/** An SMS that AWS accepted and a carrier then refused is undelivered, not failed to send. */
export function smsHubStatusOf(m: { status: string; acceptedAt: Date | string | null }): HubStatus {
  const s = smsHubStatus(m.status);
  return s === "failed" && m.acceptedAt ? "undelivered" : s;
}

/** Email message statuses (email_messages) on the hub's scale. */
export function emailHubStatus(status: string): HubStatus {
  switch (status) {
    case "queued":
    case "deferred":
      return "queued";
    case "processing":
      return "processing";
    case "accepted_by_provider":
      return "sent";
    case "delivered":
      return "delivered";
    case "bounced":
      return "undelivered";
    case "failed":
      return "failed";
    case "suppressed":
    case "cancelled":
      return "not_sent";
    default:
      return "unknown";
  }
}

/** The channel statuses behind a hub status: what a history filter asks each table for. */
export const SMS_STATUSES_FOR: Record<HubStatus, readonly string[]> = {
  queued: ["scheduled"],
  processing: ["sending"],
  sent: ["accepted", "pending", "carrier_accepted"],
  delivered: ["delivered"],
  undelivered: ["failed"],
  failed: ["failed"],
  not_sent: ["opted_out", "skipped", "cancelled"],
  test_only: ["dry_run"],
  unknown: ["unknown", "uncertain"],
};
export const EMAIL_STATUSES_FOR: Record<HubStatus, readonly string[]> = {
  queued: ["queued", "deferred"],
  processing: ["processing"],
  sent: ["accepted_by_provider"],
  delivered: ["delivered"],
  undelivered: ["bounced"],
  failed: ["failed"],
  not_sent: ["suppressed", "cancelled"],
  test_only: [],
  unknown: ["unknown"],
};

/** Counts on the hub's scale, with the delivery rate only where a provider reports deliveries. */
export type HubCounts = Record<HubStatus, number>;
export const zeroCounts = (): HubCounts => Object.fromEntries(HUB_STATUSES.map((s) => [s, 0])) as HubCounts;

/**
 * Delivered out of everything that reached a final answer from the provider (delivered or
 * undelivered), or null when no delivery report exists (email through a mailbox never has one).
 */
export function deliveryRate(c: HubCounts): number | null {
  const settled = c.delivered + c.undelivered;
  return settled ? c.delivered / settled : null;
}

/** Messages handed to the provider (accepted, then delivered or not), out of everything that tried to send. */
export function acceptanceRate(c: HubCounts): number | null {
  const accepted = c.sent + c.delivered + c.undelivered;
  const tried = accepted + c.failed + c.unknown;
  return tried ? accepted / tried : null;
}

// ---------------------------------------------------------------------------
// Automations as the hub lists them
// ---------------------------------------------------------------------------

/** draft: never switched on. pending_approval: SMS's review step. active: running. paused: stopped, resumable. disabled: retired (edit to use again). */
export const HUB_AUTOMATION_STATUSES = ["draft", "pending_approval", "active", "paused", "disabled"] as const;
export type HubAutomationStatus = (typeof HUB_AUTOMATION_STATUSES)[number];

export const HUB_AUTOMATION_STATUS_INFO: Record<HubAutomationStatus, { label: string; tone: HubTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Waiting for approval", tone: "warn" },
  active: { label: "Active", tone: "good" },
  paused: { label: "Paused", tone: "warn" },
  disabled: { label: "Disabled", tone: "neutral" },
};

export type HubAction = "activate" | "pause" | "resume" | "disable";

/** Which controls an automation in a status offers (the API refuses the rest). */
export function hubActionsFor(channel: HubChannel, status: HubAutomationStatus): HubAction[] {
  if (channel === "whatsapp") return [];
  switch (status) {
    case "draft":
    case "pending_approval":
      return ["activate"];
    case "active":
      return channel === "sms" ? ["pause", "disable"] : ["pause"];
    case "paused":
      return channel === "sms" ? ["resume", "disable"] : ["resume"];
    case "disabled":
      return ["activate"];
  }
}

// ---------------------------------------------------------------------------
// Email messages written in the hub
// ---------------------------------------------------------------------------

/**
 * A plain-text message as the email's HTML: escaped, blank lines between paragraphs, single line
 * breaks kept. Variables ({{customer.first_name}}) pass through untouched: the renderer fills them
 * and escapes their values.
 */
export function textToEmailHtml(text: string): string {
  // Only the words around a placeholder are escaped: `{{ name | default: "there" }}` must reach the renderer as written.
  const escape = (s: string) => s.split(/(\{\{[^{}]*\}\})/).map((part, i) => (i % 2 ? part : escapeHtml(part))).join("");
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** The event an email automation for this trigger listens to. */
export function emailEventFor(trigger: HubTrigger, customEvent?: string | null): string | null {
  const e = HUB_TRIGGER_INFO[trigger].email;
  if (e === "custom") return customEvent && isCustomEventType(customEvent) ? customEvent : null;
  return e;
}

/** The variables the email editor offers for a trigger (the event's fields, the business's, the unsubscribe link for marketing). */
export function emailVariablesFor(trigger: HubTrigger, category: MessageCategory, customEvent?: string | null): EventField[] {
  return templateVariables(emailEventFor(trigger, customEvent), category);
}

export interface MessageIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

/** What is wrong with an email written in the hub, for its event: unknown or misspelled variables, an empty subject or body, a marketing email's footer. */
export function checkEmailMessage(m: { subject: string; text: string }, eventType: string | null, category: MessageCategory): MessageIssue[] {
  const out: MessageIssue[] = [];
  if (!m.subject.trim()) out.push({ level: "error", code: "subject_missing", message: "Write a subject." });
  if (/[\r\n]/.test(m.subject)) out.push({ level: "error", code: "subject_lines", message: "The subject must be one line." });
  if (!m.text.trim()) out.push({ level: "error", code: "body_missing", message: "Write the message." });
  for (const [label, src] of [
    ["subject", m.subject],
    ["message", m.text],
  ] as const) {
    const { tokens, errors } = parseTemplate(src);
    for (const e of errors) out.push({ level: "error", code: "broken_variable", message: `The ${label}: ${e}` });
    for (const t of tokens) {
      if (t.kind === "var" && !isAllowedVariable(eventType, category, t.path)) out.push({ level: "error", code: "unsupported_variable", message: `The ${label} uses {{${t.path}}}, which this trigger doesn't have.` });
    }
  }
  if (category === "marketing" && !placeholdersIn(m.text).includes("unsubscribe_url"))
    out.push({ level: "warning", code: "unsubscribe_footer", message: "Marketing email gets an unsubscribe link and your postal address in its footer automatically." });
  return out.filter((v, i, all) => all.findIndex((x) => x.message === v.message) === i);
}

export const hasErrors = (issues: readonly MessageIssue[]) => issues.some((i) => i.level === "error");

/** An email automation as the hub's builder saves it: its own template (the message) and its rule. */
export const hubEmailAutomationSchema = z
  .object({
    name: z.string().trim().min(1, "Give the automation a name.").max(100),
    trigger: z.enum(HUB_TRIGGERS),
    /** The business's own event name (external_event only), like appointment.booked. */
    customEvent: z.string().trim().max(130).regex(CUSTOM_EVENT_PATTERN, "Use two to four lowercase words joined by dots, like appointment.booked").nullish(),
    /** Only events from this store (Shopify triggers); the API checks it's the workspace's. */
    storeId: z.string().max(64).nullish(),
    /** For the business's own events only; Shopify triggers have a fixed category. */
    category: z.enum(["transactional", "marketing"]).nullish(),
    senderIdentityId: z.string().min(1, "Choose who the email comes from.").max(64),
    subject: z.string().max(250),
    text: z.string().max(20_000),
    delayMinutes: z.number().int().min(0).max(MAX_DELAY_MINUTES).default(0),
    frequency: frequencySchema.default({ type: "once_per_event" }),
  })
  .superRefine((a, ctx) => {
    const runs = channelRuns(a.trigger, "email");
    if (!runs.ok) ctx.addIssue({ code: "custom", path: ["trigger"], message: runs.reason });
    if (a.trigger === "external_event" && !a.customEvent) ctx.addIssue({ code: "custom", path: ["customEvent"], message: "Name the event your system sends, like appointment.booked." });
    if (a.customEvent && !isCustomEventType(a.customEvent)) ctx.addIssue({ code: "custom", path: ["customEvent"], message: "That name is reserved for bizinsights' own events: choose another." });
  });
export type HubEmailAutomationInput = z.infer<typeof hubEmailAutomationSchema>;

/** The category an email automation's message gets. */
export function emailCategoryOf(a: Pick<HubEmailAutomationInput, "trigger" | "category">): MessageCategory {
  const c = triggerCategory(a.trigger, "email");
  return c === "either" ? (a.category ?? "transactional") : c;
}

// ---------------------------------------------------------------------------
// Costs, as the review step says them
// ---------------------------------------------------------------------------

/** How each channel is charged, in words (figures come from the API: SMS prices AWS billed, never guessed). */
export const CHANNEL_COST_NOTE: Record<HubChannel, string> = {
  whatsapp: "Meta charges per conversation, by country and type (marketing, utility); set up and billed on your Meta account.",
  sms: "AWS's price per message part for the customer's country, plus any carrier fee, counted against your store's monthly SMS limit. A long text is several parts.",
  email: "No per-message charge from bizinsights: email goes through your own mailbox, within its own daily sending limit.",
};
