import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "@app/api";
import type { QueueMessage, WorkerDeps } from "@app/worker";
import { localHandler } from "../src/local.js";
import { localQueues, MAX_RECEIVES } from "../src/localQueues.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("local queues", () => {
  it("deliver each message after its delay, as its own copy", async () => {
    vi.useFakeTimers();
    const seen: Array<{ queue: string; body: unknown; attempts: number }> = [];
    const queues = localQueues(async (queue, msg) => {
      seen.push({ queue, body: msg.body, attempts: msg.attempts });
      msg.ack();
    });
    const body = { eventId: "e1" };
    await queues.webhooks.send(body as never, { delaySeconds: 30 });
    body.eventId = "changed after sending";
    await vi.advanceTimersByTimeAsync(29_000);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual([{ queue: "webhooks", body: { eventId: "e1" }, attempts: 1 }]);
    await queues.idle();
  });

  it("bring a retried message back after the delay it asks for, counting deliveries", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const queues = localQueues(async (_queue, msg) => {
      attempts.push(msg.attempts);
      if (msg.attempts < 3) msg.retry({ delaySeconds: 10 });
      else msg.ack();
    });
    await queues.sync.send({ storeId: "s" } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual([1, 2, 3]);
    await queues.idle();
  });

  it("give a message up after MAX_RECEIVES deliveries, and count a throw as a retry", async () => {
    vi.useFakeTimers();
    let deliveries = 0;
    const queues = localQueues(async () => {
      deliveries++;
      throw new Error("always");
    });
    await queues.aggregate.send({ storeId: "s" } as never);
    await vi.advanceTimersByTimeAsync(MAX_RECEIVES * 30_000);
    expect(deliveries).toBe(MAX_RECEIVES);
    await queues.idle();
  });

  it("run at most `concurrency` messages of a queue at once", async () => {
    let running = 0;
    let most = 0;
    const queues = localQueues(
      async (_queue, msg: QueueMessage) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        msg.ack();
      },
      { concurrency: 2 },
    );
    for (let i = 0; i < 6; i++) await queues.email.send({ messageId: String(i) } as never);
    await queues.idle();
    expect(most).toBe(2);
  });
});

describe("local server routing", () => {
  const seen: Array<{ path: string; ip: string | null }> = [];
  const api = new Hono();
  api.all("*", (c) => {
    seen.push({ path: new URL(c.req.url).pathname, ip: c.req.header("x-insights-client-ip") ?? null });
    return c.json({ ok: true });
  });
  const ui = (request: Request) => new Response(`ui ${new URL(request.url).pathname}`);
  const handle = localHandler(api as unknown as App, ui, {} as WorkerDeps);

  it("sends /api/* and Shopify's bare paths to the API, everything else to the UI", async () => {
    seen.length = 0;
    await handle(new Request("http://localhost:8787/api/me"), "::ffff:127.0.0.1");
    await handle(new Request("http://localhost:8787/webhooks/shopify", { method: "POST", body: "{}" }), "::1");
    await handle(new Request("http://localhost:8787/healthz"), "::1");
    expect(seen.map((s) => s.path)).toEqual(["/me", "/webhooks/shopify", "/healthz"]);
    expect(await (await handle(new Request("http://localhost:8787/dashboard"), "::1")).text()).toBe("ui /dashboard");
  });

  it("names the client's address unless the request already does (tests pose as many visitors)", async () => {
    seen.length = 0;
    await handle(new Request("http://localhost:8787/api/me"), "::ffff:127.0.0.1");
    await handle(new Request("http://localhost:8787/api/me", { headers: { "x-insights-client-ip": "10.1.2.3" } }), "::1");
    expect(seen.map((s) => s.ip)).toEqual(["127.0.0.1", "10.1.2.3"]);
  });
});
