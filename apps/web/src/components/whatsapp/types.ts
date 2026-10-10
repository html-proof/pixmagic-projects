import type { NotificationKind } from "@app/shared/whatsapp";
import type { Tone } from "@/components/dashboard/primitives";

/** Shapes the WhatsApp API returns, and small helpers for showing them. */

export interface Overview {
  platform: { embeddedSignup: boolean; appId?: string; configId?: string; version?: string };
  webhookUrl: string;
  enabled: boolean;
  connection: Connection | null;
  store: { name: string; timezone: string; currency: string };
  setup: { connected: boolean; registered: boolean; webhookVerified: boolean; consentBasis: string; notificationsReady: number; approvedTemplates: number };
  last7Days: { sent: number; delivered: number; read: number; failed: number; skipped: number };
  scheduled: number;
  notifications: Array<{ kind: NotificationKind; enabled: boolean; templateName: string | null; check: { state: string; problem: string | null } }>;
  automationsEnabled: number;
  attention: {
    failed: Array<{ id: string; kind: string; orderName: string | null; errorTitle: string | null; phoneMasked: string | null; createdAt: string }>;
    pendingTemplates: number;
    rejectedTemplates: number;
    openCarts: number;
    pendingReviews: number;
    campaigns: Array<{ id: string; name: string; status: string; startAt: string }>;
    problems: Array<{ kind: NotificationKind; problem: string | null }>;
  };
}

export interface Connection {
  id: string;
  mode: "embedded" | "manual";
  businessId: string | null;
  wabaId: string;
  wabaName: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  nameStatus: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  registered: boolean;
  status: "active" | "pending" | "reconnect" | "error";
  lastError: string | null;
  webhookVerifiedAt: string | null;
  lastWebhookAt: string | null;
  lastSyncedAt: string | null;
  connectedAt: string;
  hasAppSecret: boolean;
  hasPin?: boolean;
  verifyToken: string | null;
}

/** One word for where the connection stands; the words carry the meaning, the colour only helps. */
export function connectionStatus(c: Connection | null): { tone: Tone; label: string } {
  if (!c) return { tone: "neutral", label: "Not connected" };
  if (c.status === "reconnect") return { tone: "danger", label: "Needs reconnecting" };
  if (c.status === "error") return { tone: "danger", label: "Problem" };
  if (!c.registered) return { tone: "warn", label: "Number not registered" };
  if (!c.webhookVerifiedAt) return { tone: "warn", label: "Webhook not verified" };
  return { tone: "good", label: "Connected" };
}

const QUALITY: Record<string, string> = { GREEN: "High", YELLOW: "Medium", RED: "Low", NA: "Not rated yet", UNKNOWN: "Not rated yet" };
export const quality = (q: string | null) => (q ? (QUALITY[q.toUpperCase()] ?? q) : "—");
export const tier = (t: string | null) => (t ? t.replace(/^TIER_/, "").replace("UNLIMITED", "Unlimited") + (t.includes("UNLIMITED") ? "" : " customers / day") : "—");
