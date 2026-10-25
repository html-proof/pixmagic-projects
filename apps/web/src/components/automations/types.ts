import type { HubAction, HubAutomationStatus, HubChannel, HubCounts, HubStatus, HubTrigger, HubTriggerIcon, MessageCategory } from "@app/shared/automations";

// The Automations hub's API answers (apps/api/src/routes/automations.ts; core automations/common.ts), as JSON.

export interface HubPermissions {
  read: Record<HubChannel, boolean>;
  manage: Record<HubChannel, boolean>;
  connect: Record<HubChannel, boolean>;
  history: Record<HubChannel, boolean>;
  contacts: boolean;
}

export type ConnectionState = "connected" | "needs_attention" | "not_connected" | "unavailable" | "elsewhere";
export type ConnectionAction = "connect" | "test" | "reconnect" | "disconnect";

export interface ChannelConnection {
  channel: HubChannel;
  allowed: boolean;
  state: ConnectionState;
  summary: string;
  accounts: Array<{ id: string; label: string; detail: string | null; status: string; statusLabel: string; canSend: boolean }>;
  problems: Array<{ code: string; message: string; fix: { label: string; href: string } | null }>;
  checkedAt: string | null;
  actions: ConnectionAction[];
  mode: string | null;
  oauth: { google: boolean; microsoft: boolean } | null;
}

export interface HubAutomation {
  channel: HubChannel;
  id: string;
  name: string;
  trigger: HubTrigger | null;
  triggerLabel: string;
  channelTrigger: string | null;
  category: MessageCategory | null;
  status: HubAutomationStatus;
  actions: HubAction[];
  pendingChanges: boolean;
  testMode: boolean;
  subject: string | null;
  body: string | null;
  storeId: string | null;
  delayMinutes: number;
  lastRunAt: string | null;
  lastResult: { status: HubStatus; reason: string | null; at: string } | null;
  last30Days: HubCounts;
  editable: boolean;
  editHref: string;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface OverviewResponse {
  permissions: HubPermissions;
  smsMode: string;
  storeId: string | null;
  connections: ChannelConnection[];
  automations: HubAutomation[];
}

export interface ChannelTriggerState {
  state: "ready" | "needs_setup" | "unavailable";
  reason: string | null;
  lastEventAt: string | null;
  fix: { label: string; href: string } | null;
  category: MessageCategory | "either" | null;
}

export interface HubTriggerState {
  key: HubTrigger;
  label: string;
  description: string;
  icon: HubTriggerIcon;
  main: boolean;
  channels: Record<HubChannel, ChannelTriggerState>;
  instead: { label: string; href: string } | null;
}

export interface HubMessage {
  channel: HubChannel;
  id: string;
  createdAt: string;
  kind: string;
  automation: { id: string; name: string | null } | null;
  trigger: HubTrigger | null;
  to: string | null;
  subject: string | null;
  status: HubStatus;
  channelStatus: string;
  channelStatusLabel: string;
  reason: string | null;
  providerMessageId: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  finalAt: string | null;
  attempts: number;
  costUsd: number | null;
  retryable: boolean;
  retryNote: string | null;
}

export interface HistoryResponse {
  messages: HubMessage[];
  nextCursor: string | null;
  timeZone: string;
  from: string;
  to: string;
  visible: { sms: boolean; email: boolean };
}

export interface MessageDetail {
  message: HubMessage;
  text: string | null;
  timeline: Array<{ at: string; label: string; detail: string | null }>;
}

export interface ChannelStats {
  channel: HubChannel;
  totals: HubCounts;
  deliveryRate: number | null;
  acceptanceRate: number | null;
  deliveryNote: string | null;
  usage: Array<{ label: string; value: string }>;
  costUsd: number | null;
}

export interface StatsResponse {
  from: string;
  to: string;
  timeZone: string;
  channels: ChannelStats[];
  totals: HubCounts;
  deliveryRate: number | null;
  acceptanceRate: number | null;
  byDay: Array<{ day: string; counts: HubCounts }>;
}

export interface AuditEntry {
  channel: HubChannel;
  id: string;
  at: string;
  action: string;
  label: string;
  actor: string;
  target: { type: string | null; id: string | null };
  detail: Record<string, string | number | boolean> | null;
}
