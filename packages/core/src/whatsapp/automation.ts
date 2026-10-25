/**
 * The store's automation as a whole: "Pause all automation" and resuming it, and what bizinsights
 * last heard when it pointed its Meta app's webhook at itself (the platform check the dashboard
 * shows to people who manage integrations).
 *
 * Pausing stops workflows from starting anything (each trigger is recorded as a run that sent
 * nothing), holds their and campaigns' waiting messages, and keeps due campaigns from starting.
 * Tests and messages a person sends from the dashboard still go: they are explicit actions.
 * Resuming releases what was held; a pause longer than 48 hours cancels what was held instead
 * (old news shouldn't reach customers days late).
 */
import { systemDb, type Store } from "@app/db";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import { settingsOf, type WaDeps, type WaSettingsView } from "./common.js";
import { resumeCampaigns } from "./campaigns.js";
import { releasePausedMessages } from "./messages.js";

/** Pause all automation for the store. Pausing again keeps the first time. */
export async function pauseAutomation(input: { store: Pick<Store, "id" | "workspaceId">; userId: string; ip?: string }): Promise<WaSettingsView> {
  const now = new Date();
  const before = await settingsOf(input.store.id);
  if (!before.automationPausedAt) {
    await systemDb.waSettings.upsert({
      where: { storeId: input.store.id },
      create: { storeId: input.store.id, workspaceId: input.store.workspaceId, automationPausedAt: now, automationPausedBy: input.userId, updatedByUserId: input.userId },
      update: { automationPausedAt: now, automationPausedBy: input.userId, updatedByUserId: input.userId },
    });
    await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.automation_paused", targetType: "store", targetId: input.store.id, ip: input.ip });
  }
  return settingsOf(input.store.id);
}

/** Resume automation: held messages go, sending campaigns carry on, due ones start. */
export async function resumeAutomation(deps: Pick<WaDeps, "queues">, input: { store: Pick<Store, "id" | "workspaceId">; userId: string; ip?: string }): Promise<{ settings: WaSettingsView; released: number; campaigns: number }> {
  const before = await settingsOf(input.store.id);
  if (!before.automationPausedAt) return { settings: before, released: 0, campaigns: 0 };
  const r = await systemDb.waSettings.updateMany({ where: { storeId: input.store.id, automationPausedAt: { not: null } }, data: { automationPausedAt: null, automationPausedBy: null, updatedByUserId: input.userId } });
  if (!r.count) return { settings: await settingsOf(input.store.id), released: 0, campaigns: 0 };
  const released = await releasePausedMessages(input.store.id, deps);
  const campaigns = await resumeCampaigns(input.store.id, deps);
  const pausedMinutes = Math.round((Date.now() - before.automationPausedAt.getTime()) / 60_000);
  await audit({ workspaceId: input.store.workspaceId, actorUserId: input.userId, action: "whatsapp.automation_resumed", targetType: "store", targetId: input.store.id, metadata: { pausedMinutes, released, campaigns }, ip: input.ip });
  logger.info({ storeId: input.store.id, released, campaigns, pausedMinutes }, "whatsapp automation resumed");
  return { settings: await settingsOf(input.store.id), released, campaigns };
}

// ---------------------------------------------------------------------------
// bizinsights' Meta app webhook, as last checked (sweep.ts points it at bizinsights)
// ---------------------------------------------------------------------------

/**
 *  - set / already: Meta's app webhook for WhatsApp points at bizinsights with every field it reads.
 *    "set" also means Meta just called bizinsights' verification endpoint with the verify token and
 *    accepted the answer, so the callback URL is reachable from Meta.
 *  - in_use: the app's webhook points somewhere else; bizinsights left it alone (the owner fixes it).
 *  - failed: Meta refused or didn't answer (the detail says what, for the owner).
 */
export interface AppWebhookState {
  outcome: "set" | "already" | "in_use" | "failed";
  at: string;
  detail?: string;
}

const APP_WEBHOOK_STATE = "wa:app-webhook:state";

export async function recordAppWebhook(coord: Coord, state: Omit<AppWebhookState, "at">): Promise<void> {
  await coord.put(APP_WEBHOOK_STATE, JSON.stringify({ ...state, at: new Date().toISOString() }), 7 * 86_400).catch(() => undefined);
}

export async function appWebhookState(coord: Coord): Promise<AppWebhookState | null> {
  const raw = await coord.peek(APP_WEBHOOK_STATE).catch(() => null);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as AppWebhookState;
    return ["set", "already", "in_use", "failed"].includes(v.outcome) ? v : null;
  } catch {
    return null;
  }
}
