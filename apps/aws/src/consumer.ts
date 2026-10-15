import { logger, withLogContext, type QueueName } from "@app/core";
import type { QueueMessage } from "@app/worker";
import { NOT_BEFORE, SQS_MAX_DELAY_S, type SqsCall } from "./sqsQueues.js";

type Outcome = { kind: "ack" } | { kind: "retry"; delaySeconds: number };

/**
 * SQS → the worker's `consume()` (apps/worker), which was written against Cloudflare Queues'
 * message API. The mapping:
 *   - attempts      = ApproximateReceiveCount (1 on the first delivery)
 *   - ack()         = report success; Lambda's event source mapping deletes the message
 *   - retry(delay)  = ChangeMessageVisibility(delay) and report the message as failed, so it comes
 *                     back after `delay` (up to 12 hours) instead of the queue's visibility timeout
 * Partial batch responses (ReportBatchItemFailures) mean one failure never redelivers the batch.
 * The queues' redrive policies (maxReceiveCount above MAX_ATTEMPTS) catch anything consume() never
 * settles, and park it in the dead-letter queue.
 */
export interface SqsRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: { ApproximateReceiveCount?: string };
  eventSourceARN: string;
}

export interface SqsEvent {
  Records: SqsRecord[];
}

export function isSqsEvent(event: unknown): event is SqsEvent {
  const records = (event as { Records?: Array<{ eventSource?: string }> } | null)?.Records;
  return Array.isArray(records) && records.length > 0 && records.every((r) => r.eventSource === "aws:sqs");
}

/** Longest visibility SQS accepts (12 hours). */
const MAX_VISIBILITY_S = 43_200;

export interface ConsumeSqsDeps {
  call: SqsCall;
  /** Queue URL per job type; the queue a record came from is matched by name. */
  urls: Record<QueueName, string>;
  run: (queue: QueueName, msg: QueueMessage) => Promise<void>;
  now?: () => number;
}

const queueNameOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

export async function consumeSqs(event: SqsEvent, deps: ConsumeSqsDeps): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const now = deps.now ?? Date.now;
  const byName = new Map<string, QueueName>(Object.entries(deps.urls).map(([q, url]) => [queueNameOf(url), q as QueueName]));
  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    const sqsName = record.eventSourceARN.slice(record.eventSourceARN.lastIndexOf(":") + 1);
    const queue = byName.get(sqsName);
    const url = queue ? deps.urls[queue] : undefined;
    if (!queue || !url) {
      logger.error({ queue: sqsName, messageId: record.messageId }, "message from unknown queue");
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(record.body) as Record<string, unknown>;
    } catch {
      // Not ours to fix by retrying: it would only come back the same. Dropped, loudly.
      logger.error({ queue, messageId: record.messageId }, "message body is not JSON: dropped");
      continue;
    }

    // A delay longer than SQS allows: re-send the rest of it (no attempt spent) until it is due.
    const notBefore = typeof body[NOT_BEFORE] === "number" ? (body[NOT_BEFORE] as number) : null;
    if (notBefore !== null && notBefore - now() > 1000) {
      try {
        const left = Math.ceil((notBefore - now()) / 1000);
        await deps.call("SendMessage", {
          QueueUrl: url,
          MessageBody: JSON.stringify(body),
          DelaySeconds: Math.min(left, SQS_MAX_DELAY_S),
        });
      } catch (err) {
        logger.error({ err, queue, messageId: record.messageId }, "re-sending a delayed job failed");
        failures.push({ itemIdentifier: record.messageId });
      }
      continue;
    }
    delete body[NOT_BEFORE];

    // Settled by consume() through the callbacks below (a holder: closures don't narrow a let).
    const state: { outcome: Outcome | null } = { outcome: null };
    const msg: QueueMessage = {
      id: record.messageId,
      body,
      attempts: Number(record.attributes.ApproximateReceiveCount ?? "1") || 1,
      ack: () => {
        state.outcome = { kind: "ack" };
      },
      retry: (opts) => {
        state.outcome = { kind: "retry", delaySeconds: opts?.delaySeconds ?? 0 };
      },
    };
    try {
      await withLogContext({ queue, messageId: record.messageId }, () => deps.run(queue, msg));
    } catch (err) {
      // consume() never throws; anything else that does gets the queue's own retry.
      logger.error({ err, queue, messageId: record.messageId }, "job threw");
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const settled = state.outcome;
    if (settled?.kind === "retry") {
      try {
        await deps.call("ChangeMessageVisibility", {
          QueueUrl: url,
          ReceiptHandle: record.receiptHandle,
          VisibilityTimeout: Math.min(MAX_VISIBILITY_S, Math.max(0, Math.ceil(settled.delaySeconds))),
        });
      } catch (err) {
        // It still comes back, after the queue's visibility timeout instead.
        logger.warn({ err, queue, messageId: record.messageId }, "could not set the retry delay");
      }
      failures.push({ itemIdentifier: record.messageId });
    } else if (!settled) {
      logger.error({ queue, messageId: record.messageId }, "job neither acked nor retried: retrying");
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

