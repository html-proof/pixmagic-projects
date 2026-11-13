import { describe, expect, it } from "vitest";
import { consumeSqs, isSqsEvent, type SqsEvent } from "../src/consumer.js";
import { s3Blobs } from "../src/s3Blobs.js";
import { NOT_BEFORE, parseQueueUrls, sqsApi, sqsQueues } from "../src/sqsQueues.js";

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" };
const urls = {
  sync: "https://sqs.ap-southeast-2.amazonaws.com/123/insights-test-sync",
  webhooks: "https://sqs.ap-southeast-2.amazonaws.com/123/insights-test-webhooks",
  aggregate: "https://sqs.ap-southeast-2.amazonaws.com/123/insights-test-aggregate",
  email: "https://sqs.ap-southeast-2.amazonaws.com/123/insights-test-email",
  whatsapp: "https://sqs.ap-southeast-2.amazonaws.com/123/insights-test-whatsapp",
};

/** An SQS that records the calls it gets (JSON protocol). */
function fakeSqs() {
  const calls: Array<{ op: string; body: Record<string, unknown>; signed: boolean }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ op: req.headers.get("x-amz-target")!.split(".")[1]!, body: JSON.parse(await req.text()), signed: !!req.headers.get("authorization") });
    return new Response(JSON.stringify({ MessageId: "m" }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const record = (queue: string, body: unknown, receives = 1, id = "msg-1") => ({
  messageId: id,
  receiptHandle: `rh-${id}`,
  body: JSON.stringify(body),
  attributes: { ApproximateReceiveCount: String(receives) },
  eventSourceARN: `arn:aws:sqs:ap-southeast-2:123:insights-test-${queue}`,
  eventSource: "aws:sqs",
});

describe("SQS producers", () => {
  it("send signed SendMessage calls to the job's queue, with the delay", async () => {
    const sqs = fakeSqs();
    const queues = sqsQueues(urls, { region: "ap-southeast-2", credentials: creds, fetchImpl: sqs.fetchImpl });
    await queues.webhooks.send({ eventId: "e1" } as never, { delaySeconds: 30 });
    expect(sqs.calls).toEqual([{ op: "SendMessage", signed: true, body: { QueueUrl: urls.webhooks, MessageBody: JSON.stringify({ eventId: "e1" }), DelaySeconds: 30 } }]);
  });

  it("carry a delay past SQS's 15 minutes in the body", async () => {
    const sqs = fakeSqs();
    const queues = sqsQueues(urls, { region: "ap-southeast-2", credentials: creds, fetchImpl: sqs.fetchImpl, now: () => 1_000_000 });
    await queues.email.send({ kind: "team_invitation", deliveryId: "x" }, { delaySeconds: 7200 });
    const sent = sqs.calls[0]!.body;
    expect(sent.DelaySeconds).toBe(900);
    expect(JSON.parse(sent.MessageBody as string)).toEqual({ kind: "team_invitation", deliveryId: "x", [NOT_BEFORE]: 1_000_000 + 7_200_000 });
  });

  it("refuse a QUEUE_URLS without every queue", () => {
    expect(() => parseQueueUrls(JSON.stringify({ sync: "x" }))).toThrow(/webhooks/);
    expect(parseQueueUrls(undefined)).toBeNull();
  });
});

describe("the SQS consumer", () => {
  it("recognises SQS events only", () => {
    expect(isSqsEvent({ Records: [record("sync", {})] })).toBe(true);
    expect(isSqsEvent({ Records: [{ eventSource: "aws:s3" }] })).toBe(false);
    expect(isSqsEvent({ cron: "*/15 * * * *" })).toBe(false);
  });

  it("hands each message to the worker with its queue and attempt count; an ack is a success", async () => {
    const sqs = fakeSqs();
    const seen: Array<{ queue: string; body: unknown; attempts: number }> = [];
    const result = await consumeSqs({ Records: [record("aggregate", { storeId: "s1" }, 3)] } as SqsEvent, {
      call: sqsApi({ region: "ap-southeast-2", credentials: creds, fetchImpl: sqs.fetchImpl }),
      urls,
      run: async (queue, msg) => {
        seen.push({ queue, body: msg.body, attempts: msg.attempts });
        msg.ack();
      },
    });
    expect(seen).toEqual([{ queue: "aggregate", body: { storeId: "s1" }, attempts: 3 }]);
    expect(result.batchItemFailures).toEqual([]);
    expect(sqs.calls).toEqual([]);
  });

  it("turns retry(delay) into a visibility change and a reported failure, for that message only", async () => {
    const sqs = fakeSqs();
    const result = await consumeSqs({ Records: [record("sync", { n: 1 }, 1, "a"), record("sync", { n: 2 }, 1, "b")] } as SqsEvent, {
      call: sqsApi({ region: "ap-southeast-2", credentials: creds, fetchImpl: sqs.fetchImpl }),
      urls,
      run: async (_q, msg) => ((msg.body as { n: number }).n === 1 ? msg.retry({ delaySeconds: 40 }) : msg.ack()),
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "a" }]);
    expect(sqs.calls).toEqual([{ op: "ChangeMessageVisibility", signed: true, body: { QueueUrl: urls.sync, ReceiptHandle: "rh-a", VisibilityTimeout: 40 } }]);
  });

  it("re-sends a message that isn't due yet without running it or spending an attempt", async () => {
    const sqs = fakeSqs();
    let ran = false;
    const now = 5_000_000;
    const result = await consumeSqs({ Records: [record("email", { kind: "team_invitation", deliveryId: "x", [NOT_BEFORE]: now + 3_600_000 })] } as SqsEvent, {
      call: sqsApi({ region: "ap-southeast-2", credentials: creds, fetchImpl: sqs.fetchImpl }),
      urls,
      now: () => now,
      run: async () => {
        ran = true;
      },
    });
    expect(ran).toBe(false);
    expect(result.batchItemFailures).toEqual([]);
    expect(sqs.calls[0]!.op).toBe("SendMessage");
    expect(sqs.calls[0]!.body.DelaySeconds).toBe(900);
    expect(JSON.parse(sqs.calls[0]!.body.MessageBody as string)[NOT_BEFORE]).toBe(now + 3_600_000);
  });

  it("runs a due message without the bookkeeping field", async () => {
    const sqs = fakeSqs();
    let body: unknown;
    await consumeSqs({ Records: [record("email", { kind: "team_invitation", deliveryId: "x", [NOT_BEFORE]: 1 })] } as SqsEvent, {
      call: sqsApi({ region: "ap-southeast-2", credentials: creds, fetchImpl: sqs.fetchImpl }),
      urls,
      run: async (_q, msg) => {
        body = msg.body;
        msg.ack();
      },
    });
    expect(body).toEqual({ kind: "team_invitation", deliveryId: "x" });
  });

  it("reports a message from an unknown queue as failed (the redrive policy parks it)", async () => {
    const sqs = fakeSqs();
    const rec = { ...record("sync", {}), eventSourceARN: "arn:aws:sqs:ap-southeast-2:123:someone-else" };
    const result = await consumeSqs({ Records: [rec] } as SqsEvent, { call: sqsApi({ region: "x", credentials: creds, fetchImpl: sqs.fetchImpl }), urls, run: async () => {} });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
  });
});

describe("S3 payloads", () => {
  it("put, get (null when missing) and delete objects, signed, on the bucket's regional endpoint", async () => {
    const objects = new Map<string, string>();
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.host}${url.pathname} ${req.headers.get("authorization") ? "signed" : "unsigned"}`);
      if (req.method === "PUT") objects.set(url.pathname, await req.text());
      if (req.method === "DELETE") objects.delete(url.pathname);
      if (req.method === "GET") return objects.has(url.pathname) ? new Response(objects.get(url.pathname)) : new Response("NoSuchKey", { status: 404 });
      return new Response(null, { status: req.method === "DELETE" ? 204 : 200 });
    }) as typeof fetch;
    const blobs = s3Blobs({ bucket: "b", region: "ap-southeast-2", credentials: creds, fetchImpl });
    await blobs.put("webhooks/a b.json", '{"x":1}');
    expect(await blobs.get("webhooks/a b.json")).toBe('{"x":1}');
    await blobs.delete("webhooks/a b.json");
    expect(await blobs.get("webhooks/a b.json")).toBeNull();
    expect(seen[0]).toBe("PUT b.s3.ap-southeast-2.amazonaws.com/webhooks/a%20b.json signed");
  });
});
