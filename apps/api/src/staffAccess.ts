import { z } from "zod";
import { systemDb } from "@app/db";
import { employeeForUser, type EmployeeCtx, type StaffActor } from "@app/core";
import { RANGE_PRESETS, staffAccess, staffCan, type StaffPermission } from "@app/shared/staff";
import { clientIp, HttpError, requireUser, type Ctx, type Deps } from "./context.js";

/**
 * Staff Management authorization. Every staff route calls one of these first; nothing relies on the
 * UI hiding a button. API keys never reach staff data (they are read-only dashboard keys), and a
 * workspace someone doesn't belong to answers 404, so ids can't be probed.
 */
export async function requireStaff(c: Ctx, deps: Deps, workspaceId: string, perm: StaffPermission): Promise<StaffActor> {
  const user = await requireUser(c, deps);
  if (!user.emailVerified) throw new HttpError(403, "Verify your email address first.", "email_unverified");
  const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } } });
  if (!m) throw new HttpError(404, "Not found", "not_found");
  const access = staffAccess(m.role, m.staffRole);
  if (!access.permissions.length) throw new HttpError(403, "You don't have access to Staff Management in this workspace. Ask an owner or admin.", "forbidden");
  if (!staffCan(access, perm)) throw new HttpError(403, "You don't have permission to do that", "forbidden");
  return { workspaceId, userId: user.id, access, ip: clientIp(c) };
}

/** An employee acting on their own records. Deactivated employees can still read their history. */
export async function requireEmployee(c: Ctx, deps: Deps, workspaceId: string): Promise<EmployeeCtx> {
  const user = await requireUser(c, deps);
  const employee = await employeeForUser(user.id, workspaceId);
  if (!employee) throw new HttpError(404, "Not found", "not_found");
  if (!user.emailVerified) throw new HttpError(403, "Verify your email address to open your employee account.", "email_unverified");
  return { workspaceId, employee, userId: user.id, ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined };
}

/** The client's Idempotency-Key header (a UUID or similar), if it sent a usable one. */
export function idempotencyKey(c: Ctx, required = false): string | null {
  const key = c.req.header("idempotency-key")?.trim() ?? "";
  if (!key) {
    if (required) throw new HttpError(400, "Missing Idempotency-Key header", "idempotency_key_required");
    return null;
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, "Invalid Idempotency-Key header", "validation");
  return key;
}

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const rangeSchema = z.object({
  preset: z.enum(RANGE_PRESETS).default("this_month"),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const idSchema = z.string().min(1).max(64);
/** An instant from the browser, ISO 8601 with a zone. */
export const instantSchema = z.string().datetime({ offset: true }).transform((s) => new Date(s));
