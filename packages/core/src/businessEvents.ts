import type { BusinessEvent as BusinessEventRow, Tx } from "@app/db";
import { byStart, MAX_BUSINESS_EVENTS, type BusinessEvent, type BusinessEventInput, type BusinessEventKind, type DateRange } from "@app/shared";
import { AppError } from "./errors.js";

/**
 * A store's business events (the Profit sheet, /sheet; @app/shared/businessEvents): the sales,
 * campaigns, launches... the team marks on its days. Notes only: nothing is worked out from them.
 *
 * `tx` is a tenant transaction (`withTenant`): RLS keeps every workspace to its own stores, and the
 * workspace is in every filter as well.
 */

export class BusinessEventError extends AppError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
    this.name = "BusinessEventError";
  }
}

type Scope = { ws: string; storeId: string };

function fromRow(r: BusinessEventRow): BusinessEvent {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as BusinessEventKind,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The store's events running on any day of `range` (every one without it), earliest first. */
export async function listBusinessEvents(tx: Tx, scope: Scope, range?: DateRange): Promise<BusinessEvent[]> {
  const rows = await tx.businessEvent.findMany({
    where: { workspaceId: scope.ws, storeId: scope.storeId, ...(range ? { startsOn: { lte: range.to }, endsOn: { gte: range.from } } : {}) },
    orderBy: [{ startsOn: "asc" }, { createdAt: "asc" }],
    take: MAX_BUSINESS_EVENTS,
  });
  return rows.map(fromRow).sort(byStart);
}

export async function createBusinessEvent(tx: Tx, scope: Scope, input: BusinessEventInput, userId: string | null): Promise<BusinessEvent> {
  const count = await tx.businessEvent.count({ where: { workspaceId: scope.ws, storeId: scope.storeId } });
  if (count >= MAX_BUSINESS_EVENTS) throw new BusinessEventError(`A store keeps up to ${MAX_BUSINESS_EVENTS} events. Remove an old one before adding another.`, 409, "too_many_events");
  const row = await tx.businessEvent.create({ data: { workspaceId: scope.ws, storeId: scope.storeId, ...input, createdByUserId: userId, updatedByUserId: userId } });
  return fromRow(row);
}

/** Replaces an event, whole; null when the store has no event by that id. Returns what it replaced too (for the audit log). */
export async function updateBusinessEvent(tx: Tx, scope: Scope, id: string, input: BusinessEventInput, userId: string | null): Promise<{ saved: BusinessEvent; before: BusinessEvent } | null> {
  const row = await tx.businessEvent.findFirst({ where: { id, workspaceId: scope.ws, storeId: scope.storeId } });
  if (!row) return null;
  const saved = await tx.businessEvent.update({ where: { id: row.id }, data: { ...input, updatedByUserId: userId } });
  return { saved: fromRow(saved), before: fromRow(row) };
}

/** Removes an event; null when the store has no event by that id. */
export async function deleteBusinessEvent(tx: Tx, scope: Scope, id: string): Promise<BusinessEvent | null> {
  const row = await tx.businessEvent.findFirst({ where: { id, workspaceId: scope.ws, storeId: scope.storeId } });
  if (!row) return null;
  await tx.businessEvent.delete({ where: { id: row.id } });
  return fromRow(row);
}
