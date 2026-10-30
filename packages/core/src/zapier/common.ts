/** What the Zapier modules share: their error, the delivery job and the payload's envelope. */
import type { ZAPIER_SCHEMA_VERSION, ZapierEvent } from "@app/shared/zapier";
import { AppError } from "../errors.js";
import type { Producer, Queues } from "../queues.js";

/** A rule a Zapier request broke (a target that isn't Zapier's, a trigger the member may not have): answered as is. */
export class ZapierError extends AppError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
    this.name = "ZapierError";
  }
}

/** One delivery (an event for one trigger): it rides the sync queue, like texts and ad syncs, told apart by its kind. */
export interface ZapierJob {
  kind: "zapier";
  deliveryId: string;
}

export const zapierQueue = (queues: Pick<Queues, "sync">) => queues.sync as unknown as Producer<ZapierJob>;

/**
 * What a Zap receives for every trigger. `id` is the happening's own key (the same for every Zap it
 * goes to, and for a retried delivery), which Zapier uses to tell items apart. `schema_version` is
 * the envelope's shape (ZAPIER_SCHEMA_VERSION), so a Zap can tell a change that would break it.
 */
export interface ZapierEnvelope {
  id: string;
  event: ZapierEvent;
  schema_version: typeof ZAPIER_SCHEMA_VERSION;
  occurred_at: string;
  store: { id: string; name: string; shop_domain: string };
  data: Record<string, unknown>;
}
