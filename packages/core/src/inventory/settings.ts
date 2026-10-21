/** A store's inventory settings (thresholds, alerts, the check's schedule, restock planning). */
import { systemDb, type InventorySettings, type Store } from "@app/db";
import { decrypt, encrypt, INVENTORY_DEFAULTS, keyVersionOf, type InventorySettingsInput } from "@app/shared";
import { logger } from "../logger.js";
import { keyring } from "../tokens.js";

export type StoreInventorySettings = Omit<InventorySettings, "workspaceId" | "updatedAt" | "whatsappToEnc"> & { whatsappTo: string[]; updatedAt: Date | null };

const aad = (storeId: string) => `inventory:${storeId}:whatsapp-to`;

/** The store's settings, or the defaults when none were saved. */
export async function inventorySettings(storeId: string): Promise<StoreInventorySettings> {
  const row = await systemDb.inventorySettings.findUnique({ where: { storeId } });
  if (!row) return { storeId, ...INVENTORY_DEFAULTS, whatsappTemplate: null, whatsappTo: [], updatedAt: null };
  const { whatsappToEnc, workspaceId: _ws, ...rest } = row;
  return { ...rest, whatsappTo: whatsappToEnc ? readNumbers(storeId, whatsappToEnc) : [] };
}

function readNumbers(storeId: string, enc: string): string[] {
  try {
    const list: unknown = JSON.parse(decrypt(enc, keyring(), aad(storeId)));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch (err) {
    logger.error({ err, storeId }, "inventory alert numbers could not be read");
    return [];
  }
}

/** Save the settings; `whatsappTo` absent keeps the numbers stored. */
export async function saveInventorySettings(store: Pick<Store, "id" | "workspaceId">, input: InventorySettingsInput): Promise<StoreInventorySettings> {
  const { whatsappTo, ...fields } = input;
  const enc = whatsappTo === undefined ? undefined : whatsappTo.length ? encrypt(JSON.stringify(whatsappTo), keyring(), aad(store.id)) : null;
  await systemDb.inventorySettings.upsert({
    where: { storeId: store.id },
    create: { storeId: store.id, workspaceId: store.workspaceId, ...fields, whatsappToEnc: enc ?? null },
    update: { ...fields, ...(enc !== undefined ? { whatsappToEnc: enc } : {}) },
  });
  return inventorySettings(store.id);
}

/** A number as the API shows it: the country code's start and the last three digits. */
export function maskNumber(n: string): string {
  return n.length > 6 ? `${n.slice(0, 3)}••••${n.slice(-3)}` : "••••";
}

/** Key rotation (keyRotation.ts): the alert numbers under the active key. Returns the rows rewritten. */
export async function reencryptInventorySettings(): Promise<number> {
  const ring = keyring();
  const rows = await systemDb.inventorySettings.findMany({ where: { whatsappToEnc: { not: null } }, select: { storeId: true, whatsappToEnc: true } });
  let n = 0;
  for (const r of rows) {
    if (keyVersionOf(r.whatsappToEnc!) === ring.active) continue;
    const plain = decrypt(r.whatsappToEnc!, ring, aad(r.storeId));
    await systemDb.inventorySettings.update({ where: { storeId: r.storeId }, data: { whatsappToEnc: encrypt(plain, ring, aad(r.storeId)) } });
    n++;
  }
  return n;
}
