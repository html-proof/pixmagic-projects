/**
 * Messages to the store's own team (Inventory's stock alerts, docs/inventory.md): a short text from
 * the store's connected WhatsApp to the numbers the merchant chose in Inventory → Settings. They are
 * the store's own people, so customer consent doesn't apply; they keep to the sending hours, count
 * against the daily limit, and each number gets at most one alert an hour.
 *
 * On the Cloud API, Meta delivers a free-form text only to someone who messaged the business number
 * in the last 24 hours; a team member who hasn't sees it fail in the history with Meta's reason.
 */
import type { Store } from "@app/db";
import { normalizePhone } from "@app/shared";
import { businessNameOf, connectionListens, liveConnection, settingsOf, storeById, waPhoneHash, type WaDeps } from "./common.js";
import { queueMessage } from "./messages.js";

export async function queueTeamAlert(deps: Pick<WaDeps, "queues">, input: { store: Pick<Store, "id">; numbers: string[]; summary: string; at: Date }): Promise<number> {
  const conn = await liveConnection(input.store.id);
  const store = await storeById(input.store.id);
  if (!store || !connectionListens(conn)) return 0;
  const settings = await settingsOf(store);
  const text = `Stock alert for ${businessNameOf(store, settings)}: ${input.summary}`.slice(0, 1000);
  const hour = Math.floor(input.at.getTime() / 3600_000);
  let queued = 0;
  for (const raw of input.numbers.slice(0, 5)) {
    const phone = normalizePhone(raw, null);
    if (!phone) continue;
    const { created } = await queueMessage(deps, {
      store,
      conn,
      source: "team_alert",
      category: "transactional",
      phone,
      payload: { text },
      idempotencyKey: `team:${waPhoneHash(store.id, phone.waId).slice(0, 16)}:${hour}`,
    });
    if (created) queued++;
  }
  return queued;
}
