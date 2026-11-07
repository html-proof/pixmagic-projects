import { logger, type FetchLike, type Producer } from "@app/core";
import type { AwsCredentials } from "./awsClient.js";
import { sqsApi, type SqsCall } from "./sqsQueues.js";

/**
 * SMS delivery events on the iKorex server (docs/ikorex-migration). Texts are still sent through AWS
 * End User Messaging SMS, and its configuration set still sends every event to the SNS topic that
 * delivers them, raw, to the smsEvents SQS queue (infra/cdk app-stack.ts): only this account's SMS
 * service can write there. The server's worker long-polls that queue and moves each event into its
 * own smsEvents queue in PostgreSQL, where the same handler (core/sms/delivery.ts) applies it.
 *
 * Why a poll and not an HTTPS subscription to the app: SQS keeps an event 4 days, so the server can
 * be down for hours and lose none, where SNS gives up on an HTTPS endpoint after an hour of retries;
 * and nothing new is opened to the internet. Long polls of 20 seconds are ~130,000 requests a
 * month, inside SQS's free tier.
 *
 * A message leaves SQS only once it is in PostgreSQL. A crash in between brings it back after the
 * visibility timeout, and the handler stores each event once, so the repeat changes nothing.
 */

const QUEUE_URL = /^https:\/\/sqs\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,80}$/;

/** The queue's region, from its URL; null when the URL isn't an SQS queue URL. */
export function sqsQueueRegion(url: string): string | null {
  return QUEUE_URL.exec(url)?.[1] ?? null;
}

interface SqsMessage {
  MessageId: string;
  ReceiptHandle: string;
  Body: string;
}

export interface BridgeOptions {
  call: SqsCall;
  queueUrl: string;
  /** The local queue the events go to (pgQueues' smsEvents). */
  target: Producer<Record<string, unknown>>;
  /** Long-poll wait, seconds (SQS allows 0-20). */
  waitS?: number;
  /** How long a received message stays hidden from another receive, seconds. */
  visibilityS?: number;
  /** Pause after a failed receive, milliseconds. */
  errorPauseMs?: number;
  onMoved?: (count: number) => void;
  onError?: (err: unknown) => void;
}

/** One receive: move what came into the local queue, then delete it from SQS. Returns how many moved. */
export async function bridgeOnce(o: BridgeOptions): Promise<number> {
  const res = await o.call<{ Messages?: SqsMessage[] }>("ReceiveMessage", {
    QueueUrl: o.queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: o.waitS ?? 20,
    VisibilityTimeout: o.visibilityS ?? 120,
  });
  const messages = res.Messages ?? [];
  if (!messages.length) return 0;
  const done: SqsMessage[] = [];
  for (const m of messages) {
    let body: unknown;
    try {
      body = JSON.parse(m.Body);
    } catch {
      body = null;
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      // A failure here throws before the delete: the message comes back after the visibility timeout.
      await o.target.send(body as Record<string, unknown>);
    } else {
      logger.warn({ messageId: m.MessageId }, "sms event from SQS is not a JSON object: dropped");
    }
    done.push(m);
  }
  const deleted = await o.call<{ Failed?: Array<{ Id: string; Code?: string }> }>("DeleteMessageBatch", {
    QueueUrl: o.queueUrl,
    Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
  });
  // Not deleted: it comes back once more, and the handler ignores the repeat.
  if (deleted.Failed?.length) logger.warn({ failed: deleted.Failed.length, codes: deleted.Failed.map((f) => f.Code) }, "sms events moved but not deleted from SQS");
  return done.length;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Poll until stopped. stop() waits for the receive in flight (at most the long-poll wait). */
export function startSqsBridge(o: BridgeOptions): { stop(): Promise<void> } {
  const stopped = new AbortController();
  const loop = (async () => {
    while (!stopped.signal.aborted) {
      try {
        const moved = await bridgeOnce(o);
        if (moved) o.onMoved?.(moved);
      } catch (err) {
        o.onError?.(err);
        logger.warn({ err }, "reading SMS events from SQS failed; trying again shortly");
        await pause(o.errorPauseMs ?? 30_000, stopped.signal);
      }
    }
  })();
  return {
    async stop() {
      stopped.abort();
      await loop;
    },
  };
}

/** The bridge's SQS client: the IAM user's keys, the queue's own region, a time limit over the long poll. */
export function bridgeCall(queueUrl: string, credentials: AwsCredentials, fetchImpl: FetchLike): SqsCall {
  const region = sqsQueueRegion(queueUrl);
  if (!region) throw new Error("SMS_EVENTS_QUEUE_URL is not an SQS queue URL (https://sqs.<region>.amazonaws.com/<account>/<name>)");
  return sqsApi({ region, credentials, fetchImpl });
}
