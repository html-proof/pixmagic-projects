/**
 * WhatsApp in the hub: a card that points to the WhatsApp Automation page
 * (/dashboard/whatsapp-automation), where its connection (a phone linked through Evolution API, or
 * Meta's Cloud API), its templates, automations and campaigns live. The hub doesn't read or change
 * WhatsApp's tables; it may join the hub as an adapter like sms.ts and email.ts later
 * (docs/automations.md, "WhatsApp").
 */
import { HUB_TRIGGERS, type HubTrigger } from "@app/shared/automations";
import type { ChannelConnection, ChannelTriggerState, HubContext } from "./common.js";

export function whatsappConnection(ctx: HubContext): ChannelConnection {
  return {
    channel: "whatsapp",
    allowed: ctx.can.read.whatsapp,
    state: "elsewhere",
    // The hub doesn't read WhatsApp's connection, so this says where it is, not whether it works.
    summary: ctx.can.read.whatsapp ? "Its connection, templates, automations and campaigns are on the WhatsApp Automation page." : "You don't have access to WhatsApp.",
    accounts: [],
    problems: [],
    checkedAt: null,
    actions: [],
    mode: null,
    oauth: null,
  };
}

export function whatsappTriggerStates(): Map<HubTrigger, ChannelTriggerState> {
  const out = new Map<HubTrigger, ChannelTriggerState>();
  for (const t of HUB_TRIGGERS) out.set(t, { state: "unavailable", reason: "WhatsApp automations are set up on the WhatsApp Automation page.", lastEventAt: null, fix: { label: "Open WhatsApp Automation", href: "/dashboard/whatsapp-automation" }, category: null });
  return out;
}
