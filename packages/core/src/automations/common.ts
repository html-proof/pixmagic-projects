/**
 * What the Automations hub's channel adapters share: the context a request gives them, the shapes
 * the hub shows (a channel's connection, a trigger's state, an automation, a message), and the
 * hub's error. An adapter speaks for one channel's own engine (sms/, email/); nothing here sends.
 */
import type { Store } from "@app/db";
import type { HubAction, HubAutomationStatus, HubChannel, HubCounts, HubStatus, HubTrigger, HubTriggerIcon, MessageCategory } from "@app/shared/automations";
import { AppError } from "../errors.js";
import type { EmailDeps } from "../email/common.js";
import type { SmsDeps } from "../sms/common.js";

export type HubDeps = SmsDeps & EmailDeps;

/** What the member may do on each channel, worked out by the API from their access (never from the request). */
export interface HubPermissions {
  /** See the channel's connection and automations. */
  read: Record<HubChannel, boolean>;
  /** Create, change, switch on and off, test and delete its automations. */
  manage: Record<HubChannel, boolean>;
  /** Connect, test and disconnect its account. */
  connect: Record<HubChannel, boolean>;
  /** See its message history. */
  history: Record<HubChannel, boolean>;
  /** Masked numbers and addresses, and message texts. */
  contacts: boolean;
}

export interface HubContext {
  workspaceId: string;
  /** The store the page is on: SMS is per store; email belongs to the workspace (an automation may be limited to one store). */
  store: Store | null;
  deps: HubDeps;
  can: HubPermissions;
}

/** Who acts: a signed-in member (the hub has no API-key access). */
export interface HubActor {
  userId: string;
  ip?: string;
  email: string;
  emailVerified: boolean;
}

/** A rule of the hub the member broke, or a step they must take first. */
export class HubError extends AppError {
  constructor(message: string, status: number, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "HubError";
  }
}

export const forbidden = () => new HubError("You don't have permission to do that", 403, "forbidden");
export const hubNotFound = () => new HubError("Not found", 404, "not_found");

// ---------------------------------------------------------------------------
// Step 1: a channel's connection
// ---------------------------------------------------------------------------

/**
 * connected: messages can go. needs_attention: connected, but something stops messages (each in
 * `problems`). not_connected: nothing connected yet. unavailable: the platform doesn't offer it
 * now. elsewhere: set up on its own pages (WhatsApp).
 */
export type ConnectionState = "connected" | "needs_attention" | "not_connected" | "unavailable" | "elsewhere";
export type ConnectionAction = "connect" | "test" | "reconnect" | "disconnect";

export interface ChannelProblem {
  code: string;
  message: string;
  fix: { label: string; href: string } | null;
}

export interface ChannelAccount {
  id: string;
  label: string;
  detail: string | null;
  status: string;
  statusLabel: string;
  canSend: boolean;
}

export interface ChannelConnection {
  channel: HubChannel;
  /** The member may see this channel at all (else nothing else is filled in). */
  allowed: boolean;
  state: ConnectionState;
  summary: string;
  accounts: ChannelAccount[];
  problems: ChannelProblem[];
  checkedAt: Date | null;
  /** What the page may offer, by the member's permission and the connection's state. */
  actions: ConnectionAction[];
  /** SMS: the platform's sending mode (off, sandbox: test texts only, live). */
  mode: string | null;
  /** Email: which sign-ins are configured on the platform. */
  oauth: { google: boolean; microsoft: boolean } | null;
}

// ---------------------------------------------------------------------------
// Step 2: triggers
// ---------------------------------------------------------------------------

/** ready: the channel receives the event for this store. needs_setup: one step away (`fix`). unavailable: not for this channel or store. */
export type TriggerReadiness = "ready" | "needs_setup" | "unavailable";

export interface ChannelTriggerState {
  state: TriggerReadiness;
  reason: string | null;
  lastEventAt: Date | null;
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

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export interface HubAutomation {
  channel: HubChannel;
  id: string;
  name: string;
  trigger: HubTrigger | null;
  triggerLabel: string;
  /** The channel's own trigger (an SMS trigger or an email event type). */
  channelTrigger: string | null;
  category: MessageCategory | null;
  status: HubAutomationStatus;
  /** The controls its status offers (the API refuses the others). */
  actions: HubAction[];
  /** Saved changes that aren't running yet (SMS keeps the activated version until they're put live). */
  pendingChanges: boolean;
  /** Test mode: records what it would send and sends nothing. */
  testMode: boolean;
  subject: string | null;
  body: string | null;
  storeId: string | null;
  delayMinutes: number;
  lastRunAt: Date | null;
  lastResult: { status: HubStatus; reason: string | null; at: Date } | null;
  last30Days: HubCounts;
  /** Whether the hub's builder can edit it (else `editHref` is the channel's own editor). */
  editable: boolean;
  editHref: string;
  /** What the hub's builder edits (null when it can't, or the saved settings no longer validate). */
  config: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface HubMessage {
  channel: HubChannel;
  id: string;
  createdAt: Date;
  /** automation | campaign | test | manual */
  kind: string;
  automation: { id: string; name: string | null } | null;
  trigger: HubTrigger | null;
  /** Masked; only for members who may see customers' contact details. */
  to: string | null;
  subject: string | null;
  status: HubStatus;
  /** The channel's own status, for the detail ("Carrier accepted", "Accepted by provider"…). */
  channelStatus: string;
  channelStatusLabel: string;
  /** Why it ended as it did, in words (no consent, invalid number, the provider's reason). */
  reason: string | null;
  providerMessageId: string | null;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  finalAt: Date | null;
  attempts: number;
  /** What the provider charged (SMS, US$), or null where it doesn't charge per message or hasn't said yet. */
  costUsd: number | null;
  retryable: boolean;
  /** Why it can't be retried, when it ended badly. */
  retryNote: string | null;
}

/** A filter of the message history (the API parsed it; dates are instants). */
export interface HistoryFilter {
  channels: HubChannel[];
  statuses: HubStatus[];
  automation: { channel: HubChannel; id: string } | null;
  from: Date;
  to: Date;
  cursor: HistoryCursor | null;
  limit: number;
}

/** Where a page of the merged history ends: newest first, SMS before email at the same instant, then id. */
export interface HistoryCursor {
  at: Date;
  channel: HubChannel;
  id: string;
}

export const CHANNEL_RANK: Record<HubChannel, number> = { sms: 0, email: 1, whatsapp: 2 };

export function encodeCursor(c: HistoryCursor): string {
  return Buffer.from(JSON.stringify({ t: c.at.toISOString(), c: c.channel, i: c.id })).toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): HistoryCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; c?: unknown; i?: unknown };
    const at = typeof v.t === "string" ? new Date(v.t) : null;
    if (!at || Number.isNaN(at.getTime()) || (v.c !== "sms" && v.c !== "email") || typeof v.i !== "string" || v.i.length > 64) return null;
    return { at, channel: v.c, id: v.i };
  } catch {
    return null;
  }
}

/** Counts and money for one channel over a period. */
export interface ChannelStats {
  channel: HubChannel;
  totals: HubCounts;
  /** Delivered out of every message with a delivery report; null where the provider gives none. */
  deliveryRate: number | null;
  acceptanceRate: number | null;
  /** Why the delivery rate is missing, when it is. */
  deliveryNote: string | null;
  usage: { label: string; value: string }[];
  costUsd: number | null;
}
