/**
 * Who stands behind a Zapier grant, and what each trigger lets them be sent. Read from the database
 * on every request and every delivery, so a removed permission, a revoked membership or an
 * uninstalled store applies to the very next one.
 */
import { systemDb, type ZapierGrant } from "@app/db";
import { allows, describeAlert, mayFixAlert, type AlertArea, type MemberAccess } from "@app/shared";
import type { StaffRole } from "@app/shared/staff";
import { ZAPIER_EVENT_INFO, type ZapierEvent } from "@app/shared/zapier";
import { memberState } from "../team/common.js";

export interface AuthorizerAccess {
  access: MemberAccess;
  staffRole: StaffRole | null;
  store: { id: string; name: string | null; shopDomain: string; timezone: string; currency: string };
}

/**
 * The access of the member who allowed a grant, if it still stands: an active membership (not revoked,
 * not past its end date) that may manage integrations, and the store still connected in that
 * workspace. Null otherwise: the grant's tokens then stop working (401, Zapier asks to reconnect).
 */
export async function authorizerAccess(g: Pick<ZapierGrant, "workspaceId" | "userId" | "storeId">, now = new Date()): Promise<AuthorizerAccess | null> {
  const [m, store] = await Promise.all([
    systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: g.workspaceId, userId: g.userId } } }),
    systemDb.store.findFirst({
      where: { id: g.storeId, workspaceId: g.workspaceId, status: { not: "uninstalled" } },
      select: { id: true, name: true, shopDomain: true, timezone: true, currency: true },
    }),
  ]);
  if (!m || !store || memberState(m, now) !== "active") return null;
  const access: MemberAccess = { role: m.role, permissions: m.permissions };
  if (!allows(access, "integrations.manage")) return null;
  return { access, staffRole: m.staffRole, store };
}

/** Whether a member may have a trigger of this kind at all (its data permission). */
export function eventAllowed(event: ZapierEvent, who: Pick<AuthorizerAccess, "access">): boolean {
  const need = ZAPIER_EVENT_INFO[event].needs;
  return !need || allows(who.access, need);
}

/**
 * Whether one event may go to a member's trigger: the trigger's own permission, and for an alert the
 * bell's rule for its area (an alert they couldn't see in bizinsights isn't sent to their Zap either).
 */
export function eventDataAllowed(event: ZapierEvent, data: Record<string, unknown>, who: Pick<AuthorizerAccess, "access" | "staffRole">): boolean {
  if (!eventAllowed(event, who)) return false;
  if (event === "alert_raised") return mayFixAlert(data.area as AlertArea, who.access, who.staffRole);
  return true;
}

/** An alert's area, as the bell words it (for the check above, before its event is written). */
export const alertArea = (alert: { code: string; severity: string; message: string }): AlertArea => describeAlert(alert).area;

/**
 * An event's data as one member may receive it: the daily summary's Shopify sales only for someone
 * who may see the store's sales in bizinsights.
 */
export function redactFor(event: ZapierEvent, data: Record<string, unknown>, who: Pick<AuthorizerAccess, "access">): Record<string, unknown> {
  if (event === "ads_daily_summary" && !allows(who.access, "analytics.sales")) {
    const { shopify: _shopify, ...rest } = data;
    return { ...rest, shopify: null };
  }
  return data;
}
