// The WhatsApp Automation API's answers (apps/api/src/routes/whatsapp.ts, whatsappAutomation.ts,
// whatsappCommon.ts), as the dashboard reads them. Dates arrive as ISO strings.
import type {
  AutomationState,
  CampaignAudience,
  OrderUpdateBasis,
  StarterTemplate,
  TemplateComponent,
  TemplateMapping,
  TemplateShape,
  TriggerInfo,
  VariableSource,
  WaConnectionStatus,
  WaMessageStatus,
  WorkflowCondition,
  WorkflowTiming,
  WorkflowTrigger,
} from "@app/shared/whatsapp";

export interface WaCan {
  /** Connect, choose a number, enter the PIN, check again, disconnect ("Manage integrations"). */
  connect: boolean;
  /** Templates, workflows, campaigns, settings, sends (owners and admins). */
  manage: boolean;
  /** Customers' numbers, names and what was said ("View contact information"). */
  contacts: boolean;
  /** See the PIN bizinsights set on the number (owners and admins). */
  pin: boolean;
}

export interface WaConnection {
  status: WaConnectionStatus;
  statusLabel: string;
  step: string | null;
  statusDetail: string | null;
  signupFlow: string | null;
  businessId: string | null;
  wabaId: string;
  wabaName: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  nameStatus: string | null;
  qualityRating: string | null;
  qualityLabel: string | null;
  messagingLimitTier: string | null;
  dailyConversationLimit: number | null;
  registered: boolean;
  subscribed: boolean;
  subscribedAt: string | null;
  /** The permissions Meta said bizinsights' access holds (whatsapp_business_management, whatsapp_business_messaging). */
  grantedScopes: string[];
  hasPin: boolean;
  lastWebhookAt: string | null;
  lastCheckedAt: string | null;
  connectedAt: string;
  disconnectedAt: string | null;
}

export interface WaSettings {
  orderUpdates: OrderUpdateBasis;
  orderUpdatesSetAt: string | null;
  shopifySmsConsent: boolean;
  sendWindow: { start: number; end: number };
  dailyLimit: number | null;
  /** The merchant's own number for tests, masked. */
  testPhone: string | null;
  eventKey: { hint: string; createdAt: string } | null;
  /** "Pause all automation": since when (null: automation runs). */
  automationPausedAt: string | null;
}

export interface WaMessage {
  id: string;
  direction: "out" | "in";
  source: string;
  type: string;
  templateName: string | null;
  templateLanguage: string | null;
  category: string | null;
  status: WaMessageStatus;
  statusLabel: string;
  reason: string | null;
  reasonLabel: string | null;
  errorCode: string | null;
  errorTitle: string | null;
  /** Meta's id for it, once Meta accepted it (or a customer's message). */
  wamid: string | null;
  phone: string | null;
  contactId: string | null;
  /** What the customer reads (or wrote): only for those who may see contact information. */
  preview: string | null;
  workflowId: string | null;
  campaignId: string | null;
  createdAt: string;
  sendAfter: string;
  acceptedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  attempts: number;
  canRetry: boolean;
}

export interface WaStats {
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  received: number;
}

export interface WaPlatform {
  ready: boolean;
  appId?: string;
  configId?: string;
  version?: string;
  /** For who may connect: the server settings still missing. */
  missing?: string[];
  /** For who may connect: how Meta last answered when bizinsights pointed its app's webhook at itself (null: not yet). */
  webhook?: { outcome: "set" | "already" | "in_use" | "failed"; at: string; detail?: string } | null;
}

export interface WaOverview {
  /** Meta's public ids come once connecting is switched on (the page loads Meta's SDK with them). */
  platform: WaPlatform;
  connection: WaConnection | null;
  legacy: { displayPhoneNumber: string | null; connectedAt: string } | null;
  can: WaCan;
  store: { name: string; timezone: string; currency: string };
  settings: WaSettings;
  /** Where automation stands, from the stored state (never the page's guess). */
  automation: { state: AutomationState; label: string; pausedAt: string | null; blocked: Array<{ id: string; name: string; problem: string }> };
  /** Messages waiting to go: how many, how many are held and why, and when the next one is due. */
  queue: { waiting: number; held: number; heldReasons: Array<{ reason: string; count: number }>; nextDueAt: string | null };
  /** The last week's failed messages, newest first (five at most). */
  recentFailures: WaMessage[];
  stats: { last7Days: WaStats; last30Days: WaStats };
  checklist: { connected: boolean; registered: boolean; subscribed: boolean; approvedTemplates: number; consentChosen: boolean; testPhone: boolean; activeWorkflows: number };
  counts: { templates: { approved: number; pending: number; rejected: number }; workflows: { active: number; total: number }; campaigns: { scheduled: number; sending: number; total: number } };
  problems: Array<{ key: string; title: string; detail: string }>;
  recent: WaMessage[];
  webhookUrl: string;
}

export interface WaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  statusLabel: string;
  rejectedReason: string | null;
  qualityScore: string | null;
  components: TemplateComponent[];
  shape: TemplateShape;
  texts: { header: string | null; headerFormat: TemplateShape["headerFormat"]; body: string; footer: string | null; buttons: string[] };
  madeHere: boolean;
  usedBy: { workflows: number; campaigns: number } | null;
  updatedAt: string;
}

export interface WaTemplatesAnswer {
  templates: WaTemplate[];
  starters: StarterTemplate[];
}

export interface WaWorkflowStats {
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface WaWorkflow {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  eventName?: string | null;
  conditions: WorkflowCondition[];
  /** Null for a "Customer sends a message" workflow, which replies with `replyText`. */
  template: { name: string; language: string } | null;
  mapping: TemplateMapping;
  headerMediaUrl?: string | null;
  replyText?: string | null;
  replyCooldownMinutes?: number | null;
  timing: WorkflowTiming;
  sendWindow?: { start: number; end: number } | null;
  conditionsText: string[];
  status: "draft" | "active" | "paused";
  version: number;
  problems: string[];
  stats: WaWorkflowStats | null;
  lastRunAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaTriggerOption extends Omit<TriggerInfo, "variables"> {
  key: WorkflowTrigger;
  /** Whether it can start a message for this store, and why not. */
  available: boolean;
  reason: string | null;
  fix: "shopify_access" | "whatsapp_webhooks" | null;
  conditionFields: Array<{ key: WorkflowCondition["field"]; label: string }>;
  variables: Array<{ key: VariableSource; label: string; sample: string; help?: string }>;
}

export interface WaPreset {
  key: string;
  title: string;
  description: string;
  trigger: WorkflowTrigger;
  /** The starter template it is written for (template workflows). */
  starter?: string;
  timing: WorkflowTiming;
  eventName?: string;
  /** Reply workflows: the reply it starts with, its cool-down and conditions. */
  replyText?: string;
  replyCooldownMinutes?: number;
  conditions?: WorkflowCondition[];
}

export interface WaWorkflowsAnswer {
  workflows: WaWorkflow[];
  presets: WaPreset[];
  triggers: WaTriggerOption[];
}

export interface WaRun {
  id: string;
  subject: string | null;
  outcome: string;
  reason: string | null;
  at: string;
  version: number;
  message: WaMessage | null;
}

export interface WaCampaignProgress {
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
}

export interface WaCampaign {
  id: string;
  name: string;
  template: { name: string; language: string };
  mapping: TemplateMapping;
  headerMediaUrl?: string | null;
  audience: CampaignAudience;
  audienceText: string;
  status: "draft" | "scheduled" | "sending" | "completed" | "cancelled";
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  estimatedRecipients: number | null;
  recipients: number;
  lastTestAt: string | null;
  progress?: WaCampaignProgress;
  createdAt: string;
}

export interface WaCampaignDetail {
  campaign: WaCampaign & { materialized: boolean; can: { edit: boolean; schedule: boolean; cancel: boolean; delete: boolean; test: boolean } };
  report: { total: number; queued: number; sent: number; delivered: number; read: number; failed: number; skipped: number; cancelled: number; failures: Array<{ code: string | null; title: string | null; reason: string | null; count: number }> };
  problems: string[];
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
  windowOpen: boolean;
  ordersCount?: number;
  lastOrderAt?: string | null;
  createdAt?: string;
}

export interface WaContactDetail {
  contact: WaContact;
  consent: Array<{ scope: string; status: string; source: string; note: string | null; at: string }>;
  messages: WaMessage[];
}

export interface WaNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  registered: boolean;
  inUse: boolean;
}
