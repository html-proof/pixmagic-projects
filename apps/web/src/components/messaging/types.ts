import type { SegmentFilter, SegmentInfo, SenderIdSupport, SenderNameStatus, SetupStep, SmsAutomationInput, SmsCategory, SmsRuleInput, SmsStatus, SmsTransactionalBasis, SmsTrigger, TemplateIssue } from "@app/shared/sms";

// ---------------------------------------------------------------------------
// What the Customer Messaging API answers (apps/api/src/routes/sms*.ts), as the pages read it.
// Dates arrive as ISO strings.
// ---------------------------------------------------------------------------

export type SmsMode = "off" | "sandbox" | "live";

/** The status counts the overview and analytics report (packages/core/src/sms/analytics.ts countStatuses). */
export interface StatusCounts {
  requested: number;
  accepted: number;
  delivered: number;
  carrierAccepted: number;
  pending: number;
  failed: number;
  unknown: number;
  optedOut: number;
  notSent: number;
  dryRun: number;
  scheduled: number;
}

export interface SmsOverview {
  store: { id: string; name: string; timezone: string; currency: string };
  mode: SmsMode;
  marketingSwitch: boolean;
  sender: {
    problem: "missing" | "unverified" | "no_countries" | "sending_off" | "held" | null;
    identityCheck: string;
    identityLabel: string | null;
    registrationStatus: string;
    countries: string[];
    sendingEnabled: boolean;
    marketingEnabled: boolean;
    transactionalBasis: string;
    heldUntil: string | null;
    heldReason: string | null;
  } | null;
  setup: { sender: boolean; verified: boolean; budget: boolean; basis: boolean; approvedTemplate: boolean; activeRule: boolean; testNumber: boolean; sending: boolean };
  last7Days: StatusCounts & { deliveryRate: number | null };
  scheduled: number;
  templates: Record<string, number>;
  rules: Record<string, number>;
  pendingApprovals: { rules: number; templates: number; campaigns: number };
  campaigns: Array<{ id: string; name: string; status: string; scheduledAt: string | null }>;
  contacts: number;
  subscribed: number;
  attention: Record<string, number>;
  spend: { month: string; totalUsd: number; budgetUsd: number; usedPct: number | null };
  /** The store's calendar month so far, and the cap on texts a month (null: no cap). */
  thisMonth: StatusCounts & { deliveryRate: number | null; from: string; quota: number | null };
  readiness: MessagingReadiness;
}

/** packages/core/src/sms/readiness.ts: the store's messaging in a word, and only what's missing. */
export interface ReadinessItem {
  key: "sender" | "verification" | "permissions" | "limit" | "sending" | "account" | "test_recipient";
  label: string;
  ok: boolean;
  detail: string;
  fix: { label: string; href: string } | null;
  optional: boolean;
  /** bizinsights and the SMS provider are finishing it: nothing for the store to do. */
  waiting: boolean;
}

export interface MessagingReadiness {
  status: "ready" | "setup_required" | "action_required";
  ready: boolean;
  testMode: boolean;
  sender: boolean;
  verification: boolean;
  budget: boolean;
  consent: boolean;
  sending: boolean;
  testNumber: boolean;
  items: ReadinessItem[];
  problems: SendingProblem[];
}

/** GET …/automations/:id/checks: the review step's checks, and whether switching on would be accepted now. */
export interface AutomationCheck {
  key: string;
  label: string;
  ok: boolean;
  message: string;
  fix: { label: string; href: string } | null;
  blocking: boolean;
}
export interface AutomationChecks {
  canActivate: boolean;
  checks: AutomationCheck[];
}

/** POST …/automations/audience. */
export interface AudienceEstimate {
  customers: number | null;
  perEvent: boolean;
}

/** GET …/automations/audience/customers: customers to choose by name (masked numbers). */
export interface AudienceCustomer {
  id: string;
  name: string | null;
  number: string;
  country: string | null;
  consent: string;
  consentLabel: string;
  optedOut: boolean;
  orders: number;
}

export interface PublicSender {
  senderType: string;
  /** Only owners and admins see it. */
  originationIdentity: string | null;
  identityLabel: string | null;
  identityCountry: string | null;
  identityStatus: string | null;
  identityCheck: string;
  identityCheckedAt: string | null;
  registrationStatus: string;
  twoWay: boolean;
  awsRegion: string;
  configurationSet: string | null;
  countries: string[];
  sendingEnabled: boolean;
  marketingEnabled: boolean;
  monthlyBudgetUsd: number;
  hardStop: boolean;
  monthlyMessageQuota: number | null;
  transactionalBasis: string;
  transactionalBasisAt: string | null;
  quietStart: number;
  quietEnd: number;
  maxPerCustomerDay: number;
  maxMarketingPerWeek: number;
  dltEntityId: string | null;
  heldUntil: string | null;
  heldReason: string | null;
  updatedAt: string;
}

export interface SenderResponse {
  mode: SmsMode;
  marketingSwitch: boolean;
  account: { sandbox: boolean; tier: string; spendLimitUsd?: number | null; spendLimitMaxUsd?: number | null } | null;
  accountError: boolean;
  configurationSet: string | null;
  sender: PublicSender | null;
  sharedSender: boolean;
}

export interface TestNumber {
  id: string;
  number: string;
  country: string | null;
  status: string;
  verifiedAt?: string | null;
  createdAt?: string;
}

export interface SmsTemplate {
  id: string;
  name: string;
  category: SmsCategory;
  status: "draft" | "in_review" | "approved" | "archived";
  latestVersion: number;
  approvedVersion: number | null;
  countries: string[];
  body: string | null;
  approvedBody: string | null;
  latestStatus: string | null;
  segments: number | null;
  encoding: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateVersion {
  version: number;
  category: SmsCategory;
  body: string;
  dltTemplateId: string | null;
  dltText: string | null;
  encoding: string;
  segments: number;
  status: string;
  reviewNote: string | null;
  createdBy: string | null;
  createdByName?: string | null;
  createdAt: string;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedByName?: string | null;
  approvedAt: string | null;
}

export interface TemplateDetail {
  template: SmsTemplate;
  versions: TemplateVersion[];
  issues: TemplateIssue[];
  history: Array<{ action: string; version: number | null; actorUserId: string | null; actor?: string; at: string; metadata: Record<string, unknown> | null }>;
}

export interface TemplatePreview {
  text: string;
  segments: SegmentInfo;
  worst: SegmentInfo;
  issues: TemplateIssue[];
  prices: Array<{ country: string; perPartUsd: number | null; source: "aws_billed" | "price_list" | null; estimateUsd: number | null; worstUsd: number | null }>;
}

export interface SmsMessage {
  id: string;
  purpose: string;
  category: string;
  trigger: string | null;
  ruleId: string | null;
  campaignId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  /** Masked; null without "View contact information". */
  to: string | null;
  country: string | null;
  status: SmsStatus;
  statusLabel: string;
  reason: string | null;
  reasonLabel: string | null;
  providerStatus: string | null;
  providerExplanation: string | null;
  errorCode: string | null;
  dryRun: boolean;
  segments: number | null;
  encoding: string | null;
  sendAfter: string | null;
  acceptedAt: string | null;
  finalAt: string | null;
  providerMessageId: string | null;
  estimatedCostUsd: number | null;
  priceUsd: number | null;
  partsBilled: number | null;
  attributedOrderId: string | null;
  attributedRevenue: number | null;
  attributedCurrency: string | null;
  attempts: number;
  createdAt: string;
  text: string | null;
  /** The automation's or campaign's name now, and the customer's first name (with "View contact information"). */
  automationName?: string | null;
  campaignName?: string | null;
  customerName?: string | null;
}

export interface MessageEvent {
  type: string;
  status: string | null;
  final: boolean;
  at: string;
  country: string | null;
  parts: number | null;
  priceUsd: number | null;
  carrierFeeUsd: number | null;
}

export interface Recipient {
  id: string;
  number: string;
  country: string | null;
  consent: string;
  suppressedMarketing: boolean;
  orders: number;
}

export interface SmsRule {
  id: string;
  name: string;
  status: "draft" | "pending_approval" | "active" | "paused" | "disabled";
  /** The latest version (approved or not); raw when it no longer validates. */
  config: SmsRuleInput | Record<string, unknown>;
  trigger: SmsRuleInput["trigger"] | null;
  triggerLabel: string | null;
  version: number;
  activeVersion: number | null;
  activeConfig: SmsRuleInput | null;
  unapprovedVersion: boolean;
  awaitingApproval: boolean;
  dryRun: boolean;
  priority: number;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuleDetail {
  rule: SmsRule;
  history: Array<{ action: string; version: number | null; actorUserId: string | null; actor?: string; at: string; snapshot: unknown }>;
}

export interface DryRunResult {
  checked: number;
  wouldSend: number;
  results: Array<{ subject: string; pass: boolean; reason: string | null }>;
}

export interface SmsSegment {
  id: string;
  name: string;
  filter: SegmentFilter;
  description: string;
  recipients: number;
  updatedAt: string;
}

export interface SegmentEstimate {
  recipients: number;
  byCountry: Array<{ country: string | null; count: number }>;
  description: string;
}

export interface CampaignMetrics {
  counts: Record<string, number>;
  costUsd: number;
  attributedOrders: number;
  /** Null when the attributed orders are in more than one currency (see attributedByCurrency). */
  attributedRevenue: number | null;
  attributedCurrency: string | null;
  attributedByCurrency: Array<{ currency: string | null; orders: number; revenue: number }>;
}

export interface SmsCampaign {
  id: string;
  name: string;
  templateId: string;
  templateVersion: number | null;
  segmentId: string | null;
  filter: SegmentFilter;
  audience: string | null;
  discountCode: string | null;
  attributionDays: number;
  status: "draft" | "pending_approval" | "approved" | "scheduled" | "sending" | "paused" | "completed" | "cancelled";
  estimatedRecipients: number | null;
  estimatedCostUsd: number | null;
  confirmedRecipients: number | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metrics?: CampaignMetrics | null;
}

export interface CampaignEstimate {
  recipients: number;
  byCountry: Array<{ country: string | null; count: number }>;
  partsPerText: number;
  estimatedCostUsd: number;
  unpricedRecipients: number;
  max: number;
}

interface Outcome extends StatusCounts {
  deliveryRate: number | null;
  costUsd: number;
}

export interface SmsAnalytics {
  period: string;
  range: { from: string; to: string };
  totals: StatusCounts & { deliveryRate: number | null };
  costUsd: number;
  byCountry: Array<Outcome & { country: string | null }>;
  campaigns: Array<Outcome & { id: string; name: string; status: string; attributedOrders: number; attributedRevenue: number | null; attributedCurrency: string | null; roi: number | null }>;
  automations: Array<Outcome & { id: string; name: string; status: string; trigger: string | null; attributedOrders: number; attributedRevenue: number | null; attributedCurrency: string | null; roi: number | null }>;
  attribution: { orders: number; byCurrency: Array<{ currency: string; orders: number; revenue: number }>; revenue: number | null; currency: string | null; roi: number | null };
  daily: Array<{ day: string; status: string; count: number }>;
  attributionRule: string;
  timezone: string;
  currency: string;
}

export interface SmsBilling {
  month: string;
  budgetUsd: number;
  hardStop: boolean;
  quota: number | null;
  billedUsd: number;
  pendingUsd: number;
  totalUsd: number;
  messages: number;
  usedPct: number | null;
  alertsRaised: number[];
  byCountry: Array<{ country: string | null; messages: number; parts: number; costUsd: number }>;
  byCampaign: Array<{ id: string | null; name: string; messages: number; costUsd: number }>;
  byRule: Array<{ id: string | null; name: string; messages: number; costUsd: number }>;
  records: Array<{ id: string; jobId: string | null; country: string | null; parts: number; priceUsd: number; carrierFeeUsd: number; totalUsd: number; recordedAt: string }>;
}

export interface SmsContact {
  id: string;
  number: string;
  country: string | null;
  consent: string;
  consentLabel: string;
  consentSource: string | null;
  consentCollectedFrom: string | null;
  consentUpdatedAt: string | null;
  suppressedAll: boolean;
  suppressedMarketing: boolean;
  orders: number;
  lastOrderAt: string | null;
  lastMessageAt: string | null;
}

export interface ContactDetail {
  contact: { id: string; number: string; country: string | null; consent: string; suppressedAll: boolean; suppressedMarketing: boolean };
  history: Array<{ state: string; purpose: string | null; source: string | null; optInLevel: string | null; evidence: unknown; effectiveAt: string | null; recordedAt: string }>;
}

export interface Suppression {
  id: string;
  number: string;
  scope: "all" | "marketing";
  reason: string;
  reasonLabel: string;
  note: string | null;
  liftable: boolean;
  createdAt: string;
}

/** GET …/sms/setup (apps/api/src/routes/smsSetup.ts): Set up SMS and SMS Settings. */
export interface SmsSetupState {
  mode: SmsMode;
  step: SetupStep;
  businessName: string | null;
  defaultBusinessName: string;
  connection: {
    status: "not_connected" | "connected" | "failed" | "disconnected";
    error: "platform_off" | "not_configured" | "aws_unreachable" | null;
    checkedAt: string | null;
    connectedAt: string | null;
    region: string;
    provider: string;
  };
  senderName: {
    name: string | null;
    country: string | null;
    countryChosen: boolean;
    status: SenderNameStatus;
    support: SenderIdSupport | "unknown";
    requestedAt: string | null;
    checkedAt: string | null;
    registration: string | null;
    sharedAvailable: boolean;
  };
  sender: PublicSender | null;
  message: string;
  templateId: string | null;
  automations: Array<{
    key: string;
    trigger: SmsTrigger | null;
    label: string;
    help: string;
    unavailable: string | null;
    body: string;
    on: boolean;
    ruleStatus: string | null;
    templateId: string | null;
    templateStatus: string | null;
  }>;
  sending: { monthlyBudgetUsd: number | null; transactionalBasis: SmsTransactionalBasis; on: boolean };
  price: { country: string | null; perPartUsd: number; source: "aws_billed" | "price_list" } | null;
  testNumbers: TestNumber[];
  lastTest: SmsMessage | null;
  completedAt: string | null;
  done: Record<SetupStep, boolean>;
}

// ---------------------------------------------------------------------------
// Automations, the builder (apps/api/src/routes/smsAutomations.ts)
// ---------------------------------------------------------------------------

export type TriggerState = "ready" | "needs_permission" | "unchecked" | "not_subscribed" | "not_sent" | "unknown_app" | "unavailable";

export interface TriggerCapability {
  key: string;
  trigger: SmsTrigger | null;
  state: TriggerState;
  reason: string | null;
  topics: string[];
  lastEventAt: string | null;
  checkedAt: string | null;
  scope: string | null;
}

export interface TriggersResponse {
  triggers: TriggerCapability[];
  /** Customers with a mobile number that have reached bizinsights from this store. */
  contactsSeen?: number;
}

export interface SendingProblem {
  code: string;
  message: string;
  stops: "all" | SmsCategory;
  /** setup: the store's own (switching on waits for it when SMS is live); temporary: clears by itself; platform: bizinsights' own. */
  kind: "setup" | "temporary" | "platform";
  fix: { label: string; href: string } | null;
}

export interface AutomationView {
  id: string;
  name: string;
  trigger: SmsTrigger | null;
  triggerLabel: string | null;
  category: SmsCategory | null;
  status: "draft" | "pending_approval" | "active" | "paused" | "disabled";
  pendingChanges: boolean;
  dryRun: boolean;
  config: SmsAutomationInput | null;
  audienceLabel: string | null;
  segmentName: string | null;
  templateId: string | null;
  body: string | null;
  liveBody: string | null;
  lastRunAt: string | null;
  lastResult: { status: SmsStatus; statusLabel: string; reason: string | null; reasonLabel: string | null; at: string; dryRun: boolean } | null;
  last30Days: StatusCounts;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationsResponse {
  mode: SmsMode;
  timezone: string;
  automations: AutomationView[];
  problems: SendingProblem[];
  readiness: MessagingReadiness;
}
