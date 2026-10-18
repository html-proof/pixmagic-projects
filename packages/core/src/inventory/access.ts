/** What a store's Shopify grant lets the Inventory module do. */
import { CAPABILITIES, expandScopes, type ModuleId } from "@app/shared";

/** Whether `granted` covers every scope the capability needs (write_X covering read_X). */
export function hasCapabilityScopes(granted: readonly string[], id: ModuleId): boolean {
  const g = expandScopes([...granted]);
  return (CAPABILITIES.find((c) => c.id === id)?.requiredScopes ?? []).every((s) => g.has(s));
}
