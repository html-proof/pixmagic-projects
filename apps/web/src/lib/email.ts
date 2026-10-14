"use client";
import { can } from "@app/shared/roles";
import type { CheckResult, ConditionNode, DnsRecordInstruction, EventField, FrequencyPolicy, MessageStatus, RecipientSelection } from "@app/shared/email";
import { useApp } from "@/components/AppContext";

// ---------------------------------------------------------------------------------------------
// Settings → Email integrations: who may do what, and the shapes the email API answers with.
// ---------------------------------------------------------------------------------------------

/** The current workspace's email API base, and what this member may do there. */
export function useEmail() {
  const { workspace, me } = useApp();
  const role = workspace.role;
  return {
    ws: workspace.id,
    base: `/workspaces/${workspace.id}/email`,
    me: me.user,
    read: can(role, "email:read"),
    /** See recipients and what was sent. */
    activity: can(role, "email:activity"),
    /** Templates and automations. */
    automate: can(role, "email:automate"),
    /** Accounts, credentials, domains, senders, keys. */
    manage: can(role, "email:manage"),
    audit: can(role, "audit:read"),
  };
}

export interface SenderView {
  id: string;
  accountId: string;
  email: string;
  name: string | null;
  status: "pending" | "verified" | "revoked";
  method: string | null;
  verifiedAt: string | null;
  isDefault: boolean;
  codeSentAt: string | null;
}

export interface AccountView {
  id: string;
  provider: "gmail" | "google_workspace" | "outlook" | "microsoft_365" | "smtp";
  connectionMethod: "oauth_google" | "oauth_microsoft" | "smtp";
  email: string;
  displayName: string | null;
  replyTo: string | null;
  status: string;
  statusReason: string | null;
  canSend: boolean;
  grantedScopes: string[];
  providerTenantId: string | null;
  dailyLimit: number;
  providerDailyLimit: number;
  perMinuteLimit: number;
  lastVerifiedAt: string | null;
  lastSuccessfulSendAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  connectedAt: string;
  smtp: { host: string; port: number; encryption: string; username: string } | null;
  senders: SenderView[];
  isDefault: boolean;
}

export interface AccountsResponse {
  accounts: AccountView[];
  configured: { google: boolean; microsoft: boolean };
  smtpAvailable: boolean;
}

export interface DomainView {
  id: string;
  domain: string;
  status: string;
  verifiedAt: string | null;
  challengeExpiresAt: string;
  sendingService: "google" | "microsoft" | "other";
  dkimSelectors: string[];
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  results: { checkedAt: string; error?: string; ownership?: CheckResult; spf?: CheckResult; dkim?: CheckResult; dmarc?: CheckResult } | null;
  records: { ownership: DnsRecordInstruction; spf: DnsRecordInstruction; dkim: DnsRecordInstruction[]; dmarc: DnsRecordInstruction };
}

export interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  category: "transactional" | "marketing";
  eventType: string | null;
  subject: string;
  html: string;
  text: string;
  variables: string[];
  version: number;
  status: "draft" | "active" | "archived";
  replyTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuleView {
  id: string;
  name: string;
  description: string | null;
  eventType: string;
  eventLabel: string;
  storeId: string | null;
  conditions: ConditionNode | null;
  conditionsText: string;
  recipient: RecipientSelection | null;
  frequency: FrequencyPolicy | null;
  senderIdentityId: string;
  sender: { email: string; status: string } | null;
  templateId: string;
  template: { name: string; status: string; category: string } | null;
  delayMinutes: number;
  maxAttempts: number;
  priority: number;
  enabled: boolean;
  valid: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogResponse {
  events: Array<{ type: string; label: string; description: string; source: string; fields: EventField[]; available: boolean }>;
  customEvents: { examples: string[]; fields: EventField[]; note: string };
  operators: Array<{ op: string; label: string }>;
  operatorsFor: Record<string, string[]>;
  globalVariables: EventField[];
  unsubscribeVariable: EventField;
  stores: Array<{ id: string; name: string }>;
  providersConfigured: { google: boolean; microsoft: boolean };
}

export interface RenderedPreview {
  subject: string;
  html: string;
  text: string;
}

export interface MessageRow {
  id: string;
  createdAt: string;
  scheduledAt: string;
  recipient: string;
  sender: string;
  account: string | null;
  accountId: string;
  provider: string;
  kind: string;
  category: string;
  ruleId: string | null;
  rule: string | null;
  subject: string;
  status: MessageStatus;
  attempts: number;
  providerAcceptedAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface MessageDetail extends Omit<MessageRow, "accountId"> {
  template: string | null;
  templateVersion: number | null;
  maxAttempts: number;
  messageIdHeader: string;
  providerMessageId: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  events: Array<{ type: string; at: string; metadata: Record<string, unknown> | null }>;
}

export type StatusCounts = Record<MessageStatus, number>;

export interface AnalyticsResponse {
  from: string;
  to: string;
  totals: StatusCounts;
  byDay: Array<{ day: string; counts: StatusCounts }>;
  byAccount: Array<{ id: string; counts: StatusCounts }>;
  byRule: Array<{ id: string; counts: StatusCounts }>;
  unavailable: Record<string, string>;
}

export interface OverviewResponse {
  accounts: { total: number; healthy: number; attention: Array<{ id: string; email: string; provider: string; status: string; reason: string | null }>; disabled: number };
  domains: { total: number; verified: number };
  automations: { active: number; total: number };
  templates: number;
  messages: { queued: number; accepted: number; delivered: number | null; failed: number; suppressed: number; cancelled: number; unknown: number };
  analytics: AnalyticsResponse;
  sending: { paused: boolean; suspended: boolean };
  providersConfigured: { google: boolean; microsoft: boolean };
}

/** `YYYY-MM-DD` in the viewer's own calendar. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
};
