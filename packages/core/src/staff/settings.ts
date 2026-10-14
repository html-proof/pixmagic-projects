import { systemDb, type BreakPolicy, type OvertimePolicy, type StaffSettings, type Tx } from "@app/db";
import { isCurrencyCode, isTimeZone, localDayOf, startOfWeek, type OvertimeRules, type PayCycle } from "@app/shared/staff";
import { decimalString } from "./common.js";

/**
 * The organization's staff settings, created with defaults on first use: the time zone and
 * currency of the workspace's first connected store when there is one, weekly pay periods
 * starting on Mondays, and a "Standard breaks" policy (short breaks paid, meal breaks unpaid).
 * No overtime policy is assumed: overtime rules differ by jurisdiction, so they are chosen
 * explicitly in Staff → Settings.
 */
export async function ensureStaffSettings(workspaceId: string): Promise<StaffSettings> {
  const existing = await systemDb.staffSettings.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  const store = await systemDb.store.findFirst({ where: { workspaceId, status: { not: "uninstalled" } }, orderBy: { createdAt: "asc" } });
  const timezone = store && isTimeZone(store.timezone) ? store.timezone : "UTC";
  const currency = store && isCurrencyCode(store.currency) ? store.currency : "USD";
  const anchor = startOfWeek(localDayOf(Date.now(), timezone), 1);
  return systemDb.$transaction(async (tx) => {
    const again = await tx.staffSettings.findUnique({ where: { workspaceId } });
    if (again) return again;
    const brk = await tx.breakPolicy.upsert({
      where: { workspaceId_name: { workspaceId, name: "Standard breaks" } },
      create: { workspaceId, name: "Standard breaks", restBreaksPaid: true, mealBreaksPaid: false },
      update: {},
    });
    return tx.staffSettings.create({
      data: { workspaceId, timezone, currency, payCycle: "weekly", payCycleAnchor: anchor, weekStartsOn: 1, defaultBreakPolicyId: brk.id },
    });
  });
}

export interface PayContext {
  timezone: string;
  currency: string;
  weekStartsOn: number;
  payCycle: PayCycle;
  payCycleAnchor: string;
  staleSessionHours: number;
  lateGraceMinutes: number;
  requireApproval: boolean;
}

export const payContext = (s: StaffSettings): PayContext => ({
  timezone: s.timezone,
  currency: s.currency,
  weekStartsOn: s.weekStartsOn,
  payCycle: s.payCycle as PayCycle,
  payCycleAnchor: s.payCycleAnchor,
  staleSessionHours: s.staleSessionHours,
  lateGraceMinutes: s.lateGraceMinutes,
  requireApproval: s.requireApproval,
});

/** A stored overtime policy as engine rules. */
export function overtimeRules(p: OvertimePolicy | null | undefined): OvertimeRules | null {
  if (!p) return null;
  return {
    dailyThresholdMinutes: p.dailyThresholdMinutes,
    weeklyThresholdMinutes: p.weeklyThresholdMinutes,
    multiplier: decimalString(p.multiplier)!,
    doubleTimeDailyThresholdMinutes: p.doubleTimeDailyThresholdMinutes,
    doubleTimeMultiplier: decimalString(p.doubleTimeMultiplier),
    holidayMultiplier: decimalString(p.holidayMultiplier)!,
  };
}

export function overtimePolicyView(p: OvertimePolicy) {
  const trim = (s: string | null) => (s === null ? null : s.replace(/\.?0+$/, ""));
  return {
    id: p.id,
    name: p.name,
    dailyThresholdMinutes: p.dailyThresholdMinutes,
    weeklyThresholdMinutes: p.weeklyThresholdMinutes,
    multiplier: trim(decimalString(p.multiplier))!,
    doubleTimeDailyThresholdMinutes: p.doubleTimeDailyThresholdMinutes,
    doubleTimeMultiplier: trim(decimalString(p.doubleTimeMultiplier)),
    holidayMultiplier: trim(decimalString(p.holidayMultiplier))!,
  };
}

export function breakPolicyView(p: BreakPolicy) {
  return {
    id: p.id,
    name: p.name,
    restBreaksPaid: p.restBreaksPaid,
    mealBreaksPaid: p.mealBreaksPaid,
    maxBreaksPerShift: p.maxBreaksPerShift,
    maxBreakMinutes: p.maxBreakMinutes,
  };
}

export function settingsView(s: StaffSettings) {
  return {
    timezone: s.timezone,
    currency: s.currency,
    payCycle: s.payCycle as PayCycle,
    payCycleAnchor: s.payCycleAnchor,
    weekStartsOn: s.weekStartsOn,
    invitationExpiryHours: s.invitationExpiryHours,
    staleSessionHours: s.staleSessionHours,
    lateGraceMinutes: s.lateGraceMinutes,
    requireApproval: s.requireApproval,
    allowEmployeeCorrections: s.allowEmployeeCorrections,
    jurisdiction: s.jurisdiction,
    supportEmail: s.supportEmail,
    defaultOvertimePolicyId: s.defaultOvertimePolicyId,
    defaultBreakPolicyId: s.defaultBreakPolicyId,
  };
}

/** Holidays between two local days, as a set of days. */
export async function holidaySet(tx: Tx, workspaceId: string, from: string, to: string): Promise<Set<string>> {
  const rows = await tx.staffHoliday.findMany({ where: { workspaceId, day: { gte: from, lte: to } }, select: { day: true } });
  return new Set(rows.map((r) => r.day));
}
