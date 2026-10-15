import { Prisma, type Tx } from "@app/db";
import { formatScaled, minorToString, RATE_SCALE, type StaffAccess } from "@app/shared/staff";
import type { Role } from "@app/shared/roles";
import { AppError } from "../errors.js";

/**
 * A Staff Management rule the caller broke, with the HTTP status the API answers it with and a
 * message written for the person using the app. Anything else thrown from here is a bug or an
 * outage and becomes a generic 500.
 */
export class StaffError extends AppError {
  constructor(status: 400 | 403 | 404 | 409 | 422 | 429, code: string, message: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "StaffError";
  }
}

export const notFound = (what = "That record") => new StaffError(404, "not_found", `${what} wasn't found.`);

/** Who is acting: a workspace member with staff access (never an API key). */
export interface StaffActor {
  workspaceId: string;
  userId: string;
  access: StaffAccess;
  /** The actor's workspace role; only "owner" relaxes the own-record rule below. */
  memberRole?: Role;
  ip?: string;
}

/**
 * Separation of duties: nobody approves, edits or sets the pay of their own employee record (a
 * payroll manager or HR manager can also be an employee). The workspace owner is the exception:
 * there is no one above them to ask.
 */
export function assertNotOwnRecord(actor: StaffActor, employeeUserId: string | null | undefined, what: string) {
  if (employeeUserId && employeeUserId === actor.userId && actor.memberRole !== "owner") {
    throw new StaffError(403, "own_record", `You can't ${what} on your own employee record. Ask another manager, an admin or the owner.`);
  }
}

/** The employees an actor may see: everyone, or (supervisors) those assigned to them. */
export function employeeScope(actor: StaffActor): Prisma.EmployeeWhereInput {
  return actor.access.scope === "assigned" ? { workspaceId: actor.workspaceId, managerUserId: actor.userId } : { workspaceId: actor.workspaceId };
}

/** Load one employee the actor may act on, or 404 (never 403: ids can't be probed). */
export async function scopedEmployee(tx: Tx, actor: StaffActor, employeeId: string) {
  const e = await tx.employee.findFirst({ where: { ...employeeScope(actor), id: employeeId } });
  if (!e) throw notFound("That employee");
  return e;
}

/** Postgres unique violation (Prisma P2002), optionally on a named index or columns. */
export function isUniqueViolation(err: unknown, target?: string): boolean {
  const e = err as { code?: string; meta?: { target?: unknown; constraint?: unknown }; message?: string };
  if (e?.code !== "P2002" && !/unique constraint|duplicate key/i.test(e?.message ?? "")) return false;
  if (!target) return true;
  const meta = JSON.stringify(e.meta ?? {}) + (e.message ?? "");
  return meta.includes(target);
}

/** A check_violation raised by the freeze triggers (finalized payroll or locked shifts). */
export function isFrozenViolation(err: unknown): boolean {
  return /finalized pay period|part of a finalized payroll/.test((err as Error)?.message ?? "");
}

/** Prisma Decimal to a fixed-scale string ("20.0000"), exactly. */
export function decimalString(d: Prisma.Decimal | null | undefined, scale = RATE_SCALE): string | null {
  if (d === null || d === undefined) return null;
  return d.toFixed(scale);
}

/** A rate for people: "20.00" (at least the currency's places, more only when the rate has them). */
export function displayRate(rate: string, currency: string): string {
  const [whole, frac = ""] = rate.split(".");
  const minPlaces = minorToString(0n, currency).split(".")[1]?.length ?? 0;
  const trimmed = frac.replace(/0+$/, "");
  const places = Math.max(minPlaces, trimmed.length);
  return places ? `${whole}.${frac.padEnd(places, "0").slice(0, places)}` : whole!;
}

export const multiplierString = (scaled: bigint) => formatScaled(scaled, 4);

/** `new Date()` for every server timestamp in one place, so tests can see where time comes from. */
export const serverNow = () => new Date();

/** Postgres advisory lock for this transaction, keyed by a string. */
export async function advisoryLock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** Lock an employee row for the rest of the transaction: every clock action for one person runs one at a time. */
export async function lockEmployee(tx: Tx, workspaceId: string, employeeId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM employees WHERE id = ${employeeId} AND workspace_id = ${workspaceId} FOR UPDATE`;
  return rows.length === 1;
}
