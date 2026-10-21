import type { Tx } from "@app/db";
import { builtInPreset, CUSTOM_NAME, readCalculation, type SalesCalculation, type SalesCalculationInput } from "@app/shared";

/**
 * A store's own sales calculation ("Custom sales", docs/kpis.md): which lines of Shopify's total
 * sales it counts, whether the dashboard shows it, and the calculations kept to switch between.
 * Only the choice is stored: every amount comes from the store's sales records for the dates on
 * screen (reports/overview.ts), so nothing here can drift from Shopify's figures.
 *
 * `tx` is a tenant transaction (`withTenant`): RLS keeps every workspace to its own stores, and
 * the workspace is in the filter as well.
 */
export async function storeSalesCalculation(tx: Tx, scope: { ws: string; storeId: string }): Promise<SalesCalculation> {
  const row = await tx.salesCalculation.findFirst({ where: { storeId: scope.storeId, workspaceId: scope.ws } });
  return readCalculation(row);
}

/**
 * Saves the store's calculation, whole, and returns it with what it replaced (for the audit log).
 * A selection that is one of the built-in calculations keeps no name of its own: it is called by
 * that calculation's name wherever it shows.
 */
export async function saveSalesCalculation(
  tx: Tx,
  scope: { ws: string; storeId: string },
  input: SalesCalculationInput,
  userId: string | null,
): Promise<{ saved: SalesCalculation; before: SalesCalculation }> {
  const before = await storeSalesCalculation(tx, scope);
  const label = builtInPreset(input.components) ? null : (input.label ?? CUSTOM_NAME);
  const data = { components: input.components, label, applyToDashboard: input.applyToDashboard, presets: input.presets, updatedByUserId: userId };
  const row = await tx.salesCalculation.upsert({
    where: { storeId: scope.storeId },
    create: { storeId: scope.storeId, workspaceId: scope.ws, ...data },
    update: data,
  });
  return { saved: readCalculation(row), before };
}
