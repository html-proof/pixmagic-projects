import type {
  WaAudience,
  WaAutomationState,
  WaCondition,
  WaConnectionStatus,
  WaMessageStatus,
  WaOrderUpdateBasis,
  WaProvider,
  WaRecipient,
  WaSendWindow,
  WaSetupStep,
  WaTemplateCategory,
  WaTrigger,
  WaValues,
} from "@app/shared/whatsapp";

// What the WhatsApp Automation API answers (apps/api/src/routes/whatsapp.ts). Dates arrive as ISO strings.

export interface WaConnection {
  provider: WaProvider;
  status: WaConnectionStatus;
  statusLabel: string;
  /** Why it is in that state, in the merchant's words (null: nothing to say). */
  reason: string | null;
  pairingMethod: "qr" | "code" | null;
  phone: string | null;
  profileName: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  qrCount: number;
  pairingStartedAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  downSince: string | null;
  lastEventAt: string | null;
  lastCheckedAt: string | null;
}

/** POST /connection and GET /connection/pairing: the provider's current code, or the state reached. */
export interface WaPairing {
  status: WaConnectionStatus;
  /** A PNG data URL of the QR code WhatsApp issued. */
  qr: string | null;
  pairingCode: string | null;
  qrCount: number;
  reason: string | null;
  phone: string | null;
  profileName: string | null;
}

export interface WaSettings {
  businessName: string | null;
  orderUpdates: WaOrderUpdateBasis;
  orderUpdatesSetAt: string | null;
  marketingEnabled: boolean;
  shopifySmsConsent: boolean;
  sendWindow: WaSendWindow;
  /** The zone the sending hours are in (the setting, or the store's). */
  timeZone: string;
  timeZoneSet: string | null;
  dailyLimit: number | null;
  perCustomerDailyLimit: number;
  retentionDays: number;
  configuredAt: string | null;
  testPhone: string | null;
  /** The verified test number is the linked phone's own: its tests land in that phone's chat with itself. */
  testIsLinkedNumber?: boolean;
  testVerifiedAt: string | null;
  testPassedAt: string | null;
  testCodeExpiresAt: string | null;
  automationPausedAt: string | null;
}

export interface WaStats {
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  notSent: number;
  received: number;
  deliveryRate: number | null;
  readRate: number | null;
}

export interface WaMessage {
  id: string;
  direction: "out" | "in";
  source: string;
  category: WaTemplateCategory | null;
  type: string;
  status: WaMessageStatus;
  statusLabel: string;
  reason: string | null;
  reasonLabel: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  providerMessageId: string | null;
  phone: string | null;
  contactId: string | null;
  /** The text (only for people who may see contact information; null after the store's retention). */
  preview: string | null;
  automationId: string | null;
  campaignId: string | null;
  templateId: string | null;
  attempts: number;
  createdAt: string;
  sendAfter: string;
  acceptedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  canRetry: boolean;
}

export interface WaMessageEvent {
  status: string;
  providerStatus: string | null;
  at: string;
}

export interface WaCan {
  /** Connect and disconnect the number (Manage integrations, signed in). */
  connect: boolean;
  /** Settings, templates, automations, campaigns, sends (owners and admins, signed in). */
  manage: boolean;
  /** Customers' numbers, names and texts (View contact information). */
  contacts: boolean;
}

export type WaTriggerAvailability = Record<WaTrigger, { available: boolean; reason: string | null }>;

export interface WaOverview {
  store: { id: string; name: string; timezone: string };
  platform: { evolution: boolean; cloudApi: { missing: string[] } };
  connection: WaConnection | null;
  settings: WaSettings;
  setup: { done: Record<WaSetupStep, boolean>; current: WaSetupStep | null };
  automation: { state: WaAutomationState; total: number; active: number; testMode: number; blocked: Array<{ id: string; name: string; problems: string[] }> };
  templates: { active: number };
  campaigns: Record<string, number>;
  stats: { week: WaStats; month: WaStats };
  limits: { dailyLimit: number; dailyMax: number; sentToday: number };
  queue: {
    waiting: number;
    held: Array<{ reason: string | null; label: string | null; count: number }>;
    failures: Array<{ reason: string | null; label: string | null; errorCode: string | null; count: number }>;
  };
  health: { lastWebhookAt: string | null; lastEventAt: string | null; lastCheckedAt: string | null };
  recent: WaMessage[];
  retired: { displayPhoneNumber: string | null; connectedAt: string } | null;
  /** Evolution API's licence notice. */
  notice: string;
  can: WaCan;
  triggers: WaTriggerAvailability;
  /** The Meta app's public ids for Embedded Signup (only for people who may connect; null when it isn't set up). */
  cloudSignup: { appId: string; configId: string; version: string } | null;
}

export interface WaTemplate {
  id: string;
  name: string;
  category: WaTemplateCategory;
  body: string;
  active: boolean;
  variables: string[];
  usable: boolean;
  unusableReason: string | null;
  meta: { name: string; language: string | null; status: string | null; reason: string | null; checkedAt: string | null } | null;
  usedBy: { automations: number; campaigns: number } | null;
  updatedAt: string;
}

export interface WaTemplatesResponse {
  templates: WaTemplate[];
  samples: WaValues;
}

export interface WaAutomation {
  id: string;
  name: string;
  description: string | null;
  trigger: WaTrigger;
  conditions: WaCondition[];
  templateId: string;
  recipient: WaRecipient;
  delayMinutes: number;
  sendWindow: WaSendWindow | null;
  testMode: boolean;
  cooldownMinutes: number | null;
  status: "draft" | "active" | "paused";
  version: number;
  triggerLabel: string;
  conditionLabels: string[];
  /** Why it can't be switched on (null: not checked in this answer). */
  problems: string[] | null;
  /** The last 30 days' runs. */
  stats: { queued: number; skipped: number } | null;
  activatedAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaAutomationRun {
  id: string;
  subject: string | null;
  outcome: "queued" | "skipped";
  reason: string | null;
  reasonLabel: string | null;
  detail: string | null;
  testMode: boolean;
  messageId: string | null;
  messageStatus: WaMessageStatus | null;
  at: string;
}

export interface WaCampaignReport {
  total: number;
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  notSent: number;
}

export interface WaCampaign {
  id: string;
  name: string;
  templateId: string;
  audience: WaAudience;
  audienceLabel: string;
  status: "draft" | "scheduled" | "sending" | "completed" | "cancelled";
  scheduledAt: string | null;
  confirmedRecipients: number | null;
  recipients: number;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  report: WaCampaignReport | null;
  createdAt: string;
}

export interface WaContact {
  id: string;
  phone: string;
  firstName: string | null;
  country: string | null;
  optedOut: boolean;
  optedIn: boolean;
  marketing: "opted_in" | "opted_out" | "unknown";
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  ordersCount: number;
  history: Array<{ scope: string; status: string; source: string; sourceLabel: string; note: string | null; at: string }>;
}

export interface WaSuppression {
  id: string;
  phone: string;
  scope: "all" | "marketing";
  reason: string;
  note: string | null;
  createdAt: string;
}
