/**
 * WhatsApp in the hub: a card that points to the WhatsApp pages, where its connection (Meta's
 * Embedded Signup or a token), its Meta-approved templates and its own automations live. The
 * hub doesn't read or change WhatsApp's tables: its module is being rebuilt, and joins the hub as
 * an adapter like sms.ts and email.ts once that lands (docs/automations.md, "WhatsApp").
 */
import { HUB_TRIGGERS, type HubTrigger } from "@app/shared/automations";
import type { ChannelConnection, ChannelTriggerState, HubContext } from "./common.js";

export function whatsappConnection(ctx: HubContext): ChannelConnection {
  return {
    channel: "whatsapp",
    allowed: ctx.can.read.whatsapp,
    state: "elsewhere",
    summary: ctx.can.read.whatsapp ? "Connected and automated on the WhatsApp page: its messages use templates Meta approved." : "You don't have access to WhatsApp.",
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
  for (const t of HUB_TRIGGERS) out.set(t, { state: "unavailable", reason: "WhatsApp automations are set up on the WhatsApp page.", lastEventAt: null, fix: { label: "Open WhatsApp", href: "/whatsapp" }, category: null });
  return out;
}
