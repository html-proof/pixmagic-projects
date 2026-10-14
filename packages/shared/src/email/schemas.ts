// Request shapes shared by the API (which enforces them) and the UI (which builds them).

import { z } from "zod";
import { displayNameOk, headerSafe, isEmail } from "./address";
import { conditionNodeSchema } from "./conditions";
import { EMAIL_CATEGORIES, SMTP_ENCRYPTION_MODES, SUPPRESSION_REASONS, SUPPRESSION_SCOPES } from "./constants";
import { DKIM_SELECTOR_RE, SENDING_SERVICES } from "./dns";
import { TEMPLATE_LIMITS } from "./template";

const email = () =>
  z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .refine((s) => isEmail(s), "Enter a valid email address");

const displayName = () =>
  z
    .string()
    .trim()
    .max(100)
    .refine((s) => s === "" || displayNameOk(s), "Use a single line of at most 100 characters");

export const smtpConnectionSchema = z.object({
  emailAddress: email(),
  displayName: displayName().optional().default(""),
  host: z.string().trim().toLowerCase().min(3).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  encryption: z.enum(SMTP_ENCRYPTION_MODES),
  username: z.string().trim().min(1).max(320).refine(headerSafe, "Invalid username"),
  /** Write-only: never returned by any endpoint. */
  password: z.string().min(1).max(512).refine((s) => !/[\r\n\0]/.test(s), "Invalid password"),
  replyTo: email().nullable().optional(),
});
export type SmtpConnectionInput = z.infer<typeof smtpConnectionSchema>;

/** Updating an SMTP connection: the password only when it changes. */
export const smtpUpdateSchema = smtpConnectionSchema.omit({ emailAddress: true, password: true }).extend({
  password: z.string().min(1).max(512).refine((s) => !/[\r\n\0]/.test(s), "Invalid password").optional(),
});

export const accountUpdateSchema = z
  .object({
    displayName: displayName().optional(),
    replyTo: email().nullable().optional(),
    /** false disables sending (queued mail is held, not lost); true re-enables it. */
    enabled: z.boolean().optional(),
    /** Make this account's address the workspace's default sender. */
    isDefault: z.literal(true).optional(),
    /** Messages per day, below the provider's own limit (null: the provider default). */
    dailyLimit: z.number().int().min(1).max(100_000).nullable().optional(),
  })
  .strict();

export const senderCreateSchema = z.object({ senderEmail: email(), senderName: displayName().optional().default("") });

export const domainCreateSchema = z.object({
  domain: z.string().trim().min(3).max(300),
  sendingService: z.enum(SENDING_SERVICES).default("other"),
  dkimSelectors: z.array(z.string().trim().toLowerCase().max(63).regex(DKIM_SELECTOR_RE, "Invalid DKIM selector")).max(5).default([]),
});
export const domainUpdateSchema = domainCreateSchema.omit({ domain: true }).partial();

export const templateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  category: z.enum(EMAIL_CATEGORIES).default("transactional"),
  /** The event whose variables the template uses (null: customer and business variables only). */
  eventType: z.string().trim().max(130).nullable().default(null),
  subject: z.string().max(TEMPLATE_LIMITS.subject).refine((s) => s.trim().length > 0, "A subject is required"),
  html: z.string().max(TEMPLATE_LIMITS.html).default(""),
  /** Empty: generated from the HTML when sending. */
  text: z.string().max(TEMPLATE_LIMITS.text).default(""),
  replyTo: email().nullable().optional(),
  status: z.enum(["draft", "active"]).default("draft"),
});
export type TemplateInput = z.infer<typeof templateInputSchema>;
export const templateUpdateSchema = templateInputSchema.partial().extend({ status: z.enum(["draft", "active", "archived"]).optional() });

export const recipientSchema = z.discriminatedUnion("type", [
  /** The customer the event is about (customer.email). */
  z.object({ type: z.literal("customer") }),
  /** A fixed address, e.g. the team inbox for an internal notice. */
  z.object({ type: z.literal("fixed"), address: email() }),
]);
export type RecipientSelection = z.infer<typeof recipientSchema>;

export const frequencySchema = z.discriminatedUnion("type", [
  /** Once per event (always true: an event never sends twice). */
  z.object({ type: z.literal("once_per_event") }),
  /** At most once per recipient in the window. */
  z.object({ type: z.literal("once_per_recipient"), windowHours: z.number().int().min(1).max(8760) }),
  /** At most `max` per recipient in the window. */
  z.object({ type: z.literal("max_per_recipient"), max: z.number().int().min(1).max(100), windowHours: z.number().int().min(1).max(8760) }),
]);
export type FrequencyPolicy = z.infer<typeof frequencySchema>;

/** Longest delay an automation may wait before sending (30 days). */
export const MAX_DELAY_MINUTES = 43_200;

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  eventType: z.string().trim().min(3).max(130),
  /** Only events from this Shopify store (null: every source). */
  storeId: z.string().max(64).nullable().default(null),
  conditions: conditionNodeSchema.nullable().default(null),
  senderIdentityId: z.string().min(1).max(64),
  templateId: z.string().min(1).max(64),
  recipient: recipientSchema.default({ type: "customer" }),
  delayMinutes: z.number().int().min(0).max(MAX_DELAY_MINUTES).default(0),
  frequency: frequencySchema.default({ type: "once_per_event" }),
  /** Send attempts before the message counts as failed (temporary failures only). */
  maxAttempts: z.number().int().min(1).max(8).default(5),
  priority: z.number().int().min(0).max(1000).default(100),
});
export type RuleInput = z.infer<typeof ruleInputSchema>;
export const ruleUpdateSchema = ruleInputSchema.partial();

/** POST /api/v1/events: one business event from the customer's own systems. */
export const ingestEventSchema = z.object({
  /** The sender's own id for the event: sending it again is a no-op. */
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/, "Use letters, digits and _ . : - only"),
  type: z.string().min(3).max(130),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  customer: z
    .object({
      email: z.string().max(254).optional(),
      first_name: z.string().max(100).optional(),
      last_name: z.string().max(100).optional(),
      accepts_marketing: z.boolean().optional(),
    })
    .strict()
    .optional(),
  data: z.record(z.unknown()).optional(),
});
export type IngestEvent = z.infer<typeof ingestEventSchema>;

export const suppressionCreateSchema = z.object({
  email: email(),
  reason: z.enum(SUPPRESSION_REASONS).default("manual"),
  scope: z.enum(SUPPRESSION_SCOPES).default("all"),
});

export const emailSettingsSchema = z
  .object({
    businessName: z.string().trim().max(120).nullable().optional(),
    /** Printed in marketing email footers (anti-spam laws require a postal address). */
    businessAddress: z.string().trim().max(300).nullable().optional(),
    dailyLimit: z.number().int().min(1).max(100_000).nullable().optional(),
    sendingPaused: z.boolean().optional(),
  })
  .strict();
