import type { FetchLike, Producer, QueueName, Queues } from "@app/core";
import { jsonApi, type AwsCredentials } from "./awsClient.js";

/**
 * Background jobs on Amazon SQS (one standard queue per job type): producers here, the consumer in
 * consumer.ts. Delivery is at-least-once, and the handlers are idempotent.
 *
 * SQS delays a message by at most 15 minutes; scheduled email and WhatsApp sends ask for up to
 * 12 hours. A longer delay is carried in the body (NOT_BEFORE) and the
 * consumer re-sends the message in 15-minute hops until it is due, without spending an attempt.
 */
export const SQS_MAX_DELAY_S = 900;
/** Body field holding "deliver no earlier than" (epoch ms) for delays past SQS's limit. */
export const NOT_BEFORE = "__notBefore";

export interface SqsOptions {
  region: string;
  credentials: AwsCredentials;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export type SqsCall = ReturnType<typeof jsonApi>;

export function sqsApi(o: SqsOptions): SqsCall {
  return jsonApi({ service: "sqs", region: o.region, credentials: o.credentials, jsonVersion: "1.0", targetPrefix: "AmazonSQS", fetchImpl: o.fetchImpl });
}

/** SendMessage with the delay split as above. */
export async function sqsSend(call: SqsCall, queueUrl: string, body: unknown, delaySeconds = 0, now = Date.now): Promise<void> {
  const delay = Math.max(0, Math.ceil(delaySeconds));
  let payload = body;
  if (delay > SQS_MAX_DELAY_S) payload = { ...(body as object), [NOT_BEFORE]: now() + delay * 1000 };
  await call("SendMessage", { QueueUrl: queueUrl, MessageBody: JSON.stringify(payload), DelaySeconds: Math.min(delay, SQS_MAX_DELAY_S) });
}

export function sqsQueues(urls: Record<QueueName, string>, o: SqsOptions): Queues {
  const call = sqsApi(o);
  const producer = <T>(name: QueueName): Producer<T> => ({
    send: (body, opts) => sqsSend(call, urls[name], body, opts?.delaySeconds, o.now),
  });
  return { sync: producer("sync"), webhooks: producer("webhooks"), aggregate: producer("aggregate"), email: producer("email"), smsEvents: producer("smsEvents") };
}

/** QUEUE_URLS (set by the CDK app): {"sync":"https://sqs...","webhooks":...}. */
export function parseQueueUrls(raw: string | undefined): Record<QueueName, string> | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<Record<QueueName, string>>;
  const names: QueueName[] = ["sync", "webhooks", "aggregate", "email", "smsEvents"];
  for (const n of names) if (!parsed[n]) throw new Error(`QUEUE_URLS has no "${n}" queue`);
  return parsed as Record<QueueName, string>;
}
