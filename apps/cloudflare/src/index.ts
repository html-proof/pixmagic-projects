import { buildApp, firebaseAuthProvider, type App, type AuthProvider, type Deps } from "@app/api";
import { consume, runScheduled, type QueueMessage, type WorkerDeps } from "@app/worker";
import { cloudflareMailer, logger, mailpitMailer, type BlobStore, type Producer, type QueueName, type Queues } from "@app/core";
import { withDb, type DbUrls } from "@app/db";
import { env as bindings } from "cloudflare:workers";
import { durableCoord, type Coordinator } from "./coordinator.js";

export { Coordinator } from "./coordinator.js";

/** API paths served without the /api prefix (for a dedicated API hostname, e.g. Shopify webhooks). */
const BARE_API = /^\/(webhooks|pixel|shopify)\/|^\/(healthz|readyz)$/;

const QUEUES: Record<string, QueueName> = {
  "insights-sync": "sync",
  "insights-webhooks": "webhooks",
  "insights-aggregate": "aggregate",
};

function producer<T>(q: Queue): Producer<T> {
  return {
    async send(body, opts) {
      await q.send(body, { contentType: "json", delaySeconds: opts?.delaySeconds });
    },
  };
}

function r2Blobs(bucket: R2Bucket): BlobStore {
  return {
    async put(key, value) {
      await bucket.put(key, value, { httpMetadata: { contentType: "application/json" } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? obj.text() : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

/** Payloads kept without R2 expire after a week (processed ones are deleted right away). */
const BLOB_TTL_S = 7 * 86400;

/** Characters per stored chunk: 2 MB per value even if every character took two bytes. */
const BLOB_CHUNK_CHARS = 512 * 1024;

/**
 * Fallback when the R2 bucket isn't bound (R2 must be enabled on the account first): keep
 * large webhook payloads in Durable Object storage instead, one object per payload.
 * Durable Object values are limited to 2 MB and webhook bodies may be 5 MB, so payloads are
 * split into chunks; stored whole, a 2-5 MB payload failed on every one of Shopify's retries.
 */
function durableBlobs(ns: DurableObjectNamespace<Coordinator>): BlobStore {
  const stub = (key: string) => ns.get(ns.idFromName(`blob:${key}`));
  return {
    put: (key, value) => {
      const chunks: string[] = [];
      for (let i = 0; i < value.length; i += BLOB_CHUNK_CHARS) chunks.push(value.slice(i, i + BLOB_CHUNK_CHARS));
      return stub(key).putChunks(chunks.length ? chunks : [""], BLOB_TTL_S);
    },
    get: (key) => stub(key).peekChunks(),
    delete: (key) => stub(key).release(),
  };
}

// The auth provider only caches plain data (Google keys, an OAuth access token),
// so one instance per isolate is safe and saves a key fetch per request.
let auth: AuthProvider | undefined;

function workerDeps(env: Env): WorkerDeps {
  // Optional binding: absent from the generated Env type while R2 is commented out in wrangler.jsonc.
  const bucket = (env as Env & { PAYLOADS?: R2Bucket }).PAYLOADS;
  const queues: Queues = {
    sync: producer(env.SYNC_QUEUE),
    webhooks: producer(env.WEBHOOK_QUEUE),
    aggregate: producer(env.AGGREGATE_QUEUE),
  };
  return {
    coord: durableCoord(env.COORD),
    queues,
    payloads: bucket ? r2Blobs(bucket) : durableBlobs(env.COORD),
    // MAILPIT_URL is a local-dev-only override (.dev.vars); production sends through Email Sending.
    mailer: process.env.MAILPIT_URL ? mailpitMailer(process.env.MAILPIT_URL) : cloudflareMailer(env.EMAIL),
    fetchImpl: (input, init) => fetch(input, init),
  };
}

function apiDeps(env: Env): Deps {
  auth ??= firebaseAuthProvider();
  return {
    ...workerDeps(env),
    auth,
    globalLimit: async (ip) => (await env.GLOBAL_LIMITER.limit({ key: ip })).success,
  };
}

// Bindings are stateless handles, so the routed app is built once per isolate.
let built: App | undefined;
function app(env: Env): App {
  return (built ??= buildApp(apiDeps(env)));
}

/**
 * Build it now, while the isolate starts, instead of inside whichever request arrives first.
 * Workers charge module top-level work to the startup CPU budget, but everything done inside
 * fetch() comes out of that one request's budget - so parsing the env, registering the routes
 * and decoding the service account used to land on a cold request that was already doing real
 * work, and it died with "Worker exceeded resource limits" (Cloudflare error 1102).
 *
 * A failure here must not take the Worker down (static assets are served from the same script),
 * so it is only logged: the next request rebuilds and reports the problem the normal way.
 */
try {
  app(bindings as Env);
} catch (err) {
  logger.error({ err }, "building the API at startup failed; retrying on the first request");
}

const dbUrls = (env: Env): DbUrls => ({ system: env.HYPERDRIVE.connectionString, tenant: env.HYPERDRIVE_RLS.connectionString });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let apiPath: string | null = null;
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) apiPath = url.pathname.slice(4) || "/";
    else if (BARE_API.test(url.pathname)) apiPath = url.pathname;
    if (apiPath === null) return env.ASSETS.fetch(request);
    // A UI-only deploy has no Hyperdrive bindings; answer in JSON rather than crash.
    if (!env.HYPERDRIVE || !env.HYPERDRIVE_RLS) {
      return Response.json({ error: "db_unavailable", message: "The database is not connected yet." }, { status: 503 });
    }

    url.pathname = apiPath;
    return withDb(dbUrls(env), async () => app(env).fetch(new Request(url, request), env, ctx));
  },

  async queue(batch, env) {
    const name = QUEUES[batch.queue];
    if (!name) {
      logger.error({ queue: batch.queue }, "message from unknown queue");
      batch.retryAll();
      return;
    }
    const deps = workerDeps(env);
    await withDb(dbUrls(env), async () => {
      for (const msg of batch.messages) await consume(name, msg as QueueMessage, deps);
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      withDb(dbUrls(env), async () => {
        const result = await runScheduled(controller.cron, workerDeps(env));
        logger.info({ cron: controller.cron, ...result }, "scheduled run finished");
      }),
    );
  },
} satisfies ExportedHandler<Env>;
