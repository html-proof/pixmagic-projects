import { randomUUID } from "node:crypto";
import { logger, withLogContext, type Producer, type QueueName, type Queues } from "@app/core";
import type { QueueMessage } from "@app/worker";

/**
 * Background jobs inside one process, for the local server (local.ts): each message is handed to
 * `run` after its delay, as SQS hands it to the jobs function on AWS. Same contract as there:
 * `attempts` counts deliveries, retry() brings the message back after its delay, a message that
 * is neither acked nor retried counts as done, and one still failing after MAX_RECEIVES
 * deliveries is dropped with an error (AWS parks it in the dead-letter queue).
 */

/** Deliveries before a message is given up on: the SQS queues' maxReceiveCount (infra/cdk). */
export const MAX_RECEIVES = 10;

export interface LocalQueues extends Queues {
  /** Resolves once nothing is running or waiting to run within `withinMs` (tests). */
  idle(withinMs?: number): Promise<void>;
  /** Forget every message still waiting for its delay (shutdown). */
  close(): void;
}

export function localQueues(run: (queue: QueueName, msg: QueueMessage) => Promise<void>, opts: { concurrency?: number } = {}): LocalQueues {
  const concurrency = opts.concurrency ?? 4;
  const running: Record<QueueName, number> = { sync: 0, webhooks: 0, aggregate: 0, email: 0, whatsapp: 0 };
  const ready: Record<QueueName, Array<() => Promise<void>>> = { sync: [], webhooks: [], aggregate: [], email: [], whatsapp: [] };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let busy = 0;
  const settled: Array<() => void> = [];

  const done = () => {
    busy--;
    if (busy === 0) for (const resolve of settled.splice(0)) resolve();
  };

  const pump = (queue: QueueName) => {
    while (running[queue] < concurrency && ready[queue].length) {
      const job = ready[queue].shift()!;
      running[queue]++;
      void job().finally(() => {
        running[queue]--;
        done();
        pump(queue);
      });
    }
  };

  const deliver = (queue: QueueName, id: string, body: unknown, attempts: number, delaySeconds: number) => {
    busy++;
    const timer = setTimeout(() => {
      timers.delete(timer);
      ready[queue].push(async () => {
        let retryIn: number | null = null;
        const msg: QueueMessage = {
          id,
          body: structuredClone(body),
          attempts,
          ack() {
            retryIn = null;
          },
          retry(o) {
            retryIn = o?.delaySeconds ?? 0;
          },
        };
        try {
          await withLogContext({ queue, messageId: id }, () => run(queue, msg));
        } catch (err) {
          // consume() never throws; anything else that does gets the queue's own redelivery.
          logger.error({ err, queue, messageId: id }, "job threw");
          retryIn ??= 30;
        }
        if (retryIn === null) return;
        if (attempts >= MAX_RECEIVES) {
          logger.error({ queue, messageId: id, attempts }, "job dropped after its last delivery (on AWS: the dead-letter queue)");
          return;
        }
        deliver(queue, id, body, attempts + 1, retryIn);
      });
      pump(queue);
    }, Math.max(0, delaySeconds) * 1000);
    timers.add(timer);
  };

  const producer = <T>(queue: QueueName): Producer<T> => ({
    async send(body, o) {
      deliver(queue, randomUUID(), structuredClone(body), 1, o?.delaySeconds ?? 0);
    },
  });

  return {
    sync: producer("sync"),
    webhooks: producer("webhooks"),
    aggregate: producer("aggregate"),
    email: producer("email"),
    whatsapp: producer("whatsapp"),
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    idle(withinMs = 10_000) {
      if (busy === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`queues still busy after ${withinMs} ms`)), withinMs);
        settled.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
