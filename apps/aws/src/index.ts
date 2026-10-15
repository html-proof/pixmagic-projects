import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { buildApp, cognitoAuth, cognitoConfig, firebasePasswordCheck, unconfiguredCognito, type App, type Deps } from "@app/api";
import { consume, runScheduled, seedAfterMove, type WorkerDeps } from "@app/worker";
import { env as config, logger, memoryBlobs, memoryCoord, withLogContext, withTimeout, type Coord, type Mailer, type Queues } from "@app/core";
import { roleCredentials } from "./awsClient.js";
import { consumeSqs, isSqsEvent } from "./consumer.js";
import { dynamoCoord } from "./dynamoCoord.js";
import { migrate, tableCounts } from "./migrate.js";
import { nodeSmtpConnect } from "./nodeSmtp.js";
import { s3Blobs } from "./s3Blobs.js";
import { loadSecrets } from "./secrets.js";
import { sesMailer } from "./sesMailer.js";
import { parseQueueUrls, sqsApi, sqsQueues } from "./sqsQueues.js";
import { staticSite } from "./staticSite.js";

/**
 * Insights on AWS (infra/cdk). One package, deployed as three functions that differ only in
 * memory, timeout and trigger, so the UI, the API and the jobs always run the same build:
 *   - api:  the Lambda function URL behind CloudFront. The static UI (the Next.js export) and the
 *           API on one origin, as on the Cloudflare Worker (apps/cloudflare/src/index.ts), so the
 *           session cookie stays first-party.
 *   - jobs: SQS event source mappings (sync, webhooks, aggregate, email) → the worker's consume().
 *   - cron: EventBridge Scheduler ({ "cron": "..." }) → runScheduled(), plus maintenance actions
 *           invoked directly ({ "action": "migrate" | "counts" | "after-move" }).
 * Platform pieces: RDS PostgreSQL (process-wide pools; Lambda has no per-request scope), DynamoDB
 * for the coordinator, S3 for large webhook bodies, SES for app email, Secrets Manager + SSM for
 * configuration (secrets.ts).
 */
const here = dirname(fileURLToPath(import.meta.url));
const API_PREFIX = /^\/api(\/|$)/;
/** API paths served without the /api prefix (webhooks, pixel, Shopify), as on the Worker. */
const BARE_API = /^\/(webhooks|pixel|shopify)\/|^\/(healthz|readyz)$/;

/** Set by the CloudFront viewer-request function from what CloudFront itself saw (infra/cdk). */
const VIEWER_IP = "x-insights-viewer-ip";
const VIEWER_HOST = "x-insights-viewer-host";
/** CloudFront adds this to every origin request; without it the function URL was called directly. */
const ORIGIN_VERIFY = "x-origin-verify";

function droppedQueues(): Queues {
  const drop = (queue: string) => ({
    async send() {
      logger.warn({ queue }, "no queues in this environment: job dropped");
    },
  });
  return { sync: drop("sync"), webhooks: drop("webhooks"), aggregate: drop("aggregate"), email: drop("email") };
}

/** Without SES configured (local runs): say what would have been sent, never the address. */
const logMailer: Mailer = {
  async send(to, subject) {
    logger.info({ subject, to: to.replace(/^(.).*@/, "$1…@") }, "email not sent (no mailer in this environment)");
  },
};

function coordinator(): Coord {
  const table = process.env.COORD_TABLE;
  if (table) {
    return dynamoCoord({
      table,
      region: process.env.AWS_REGION ?? "",
      credentials: roleCredentials(),
      fetchImpl: withTimeout((input, init) => fetch(input, init), 5_000),
    });
  }
  // Many Lambda instances run at once: state kept in one of them is wrong for the others.
  if (process.env.NODE_ENV === "production") throw new Error("COORD_TABLE is required in production");
  return memoryCoord();
}

/** Everything the jobs need, built once per instance after the secrets are in process.env. */
function workerDeps(): WorkerDeps {
  const region = process.env.AWS_REGION ?? "";
  const credentials = roleCredentials();
  const urls = parseQueueUrls(process.env.QUEUE_URLS);
  const bucket = process.env.PAYLOADS_BUCKET;
  return {
    coord: coordinator(),
    queues: urls ? sqsQueues(urls, { region, credentials, fetchImpl: withTimeout((i, init) => fetch(i, init), 10_000) }) : droppedQueues(),
    payloads: bucket ? s3Blobs({ bucket, region, credentials }) : memoryBlobs(),
    mailer: process.env.SES_REGION ? sesMailer({ region: process.env.SES_REGION, credentials, configurationSet: process.env.SES_CONFIGURATION_SET }) : logMailer,
    // Every outbound call the API and the jobs make goes through this, so each gets a time limit.
    fetchImpl: withTimeout((input, init) => fetch(input, init)),
    smtpConnect: nodeSmtpConnect,
  };
}

let secretsLoaded: Promise<void> | undefined;
/** Cold start: secrets and settings into process.env, once per instance (retried after a failure). */
function ensureSecrets(): Promise<void> {
  secretsLoaded ??= (async () => {
    await loadSecrets();
    // On AWS the function's own role makes Cognito's admin calls (least privilege, no long-lived keys).
    if (!process.env.COGNITO_ADMIN_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_ID) {
      process.env.COGNITO_ADMIN_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
      process.env.COGNITO_ADMIN_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
      process.env.COGNITO_ADMIN_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN ?? "";
    }
  })().catch((err: unknown) => {
    secretsLoaded = undefined;
    throw err;
  });
  return secretsLoaded;
}

let api: Promise<App> | undefined;
function apiApp(origin: string | null): Promise<App> {
  api ??= (async () => {
    await ensureSecrets();
    // Normally from the runtime parameter; else the address CloudFront was asked for.
    if (!process.env.APP_URL && origin) {
      process.env.APP_URL = origin;
      process.env.API_URL = `${origin}/api`;
    }
    const authFetch = withTimeout((input, init) => fetch(input, init), 10_000);
    const cognito = cognitoConfig();
    if (!cognito) logger.error({}, "COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are not set: every sign-in will answer 503");
    const legacyKey = config().LEGACY_FIREBASE_API_KEY;
    const jobs = workerDeps();
    const deps: Deps = {
      ...jobs,
      auth: cognito ? cognitoAuth(cognito, authFetch) : unconfiguredCognito(),
      legacy: legacyKey ? firebasePasswordCheck(legacyKey, authFetch) : null,
      // The Worker's GLOBAL_LIMITER binding (300 a minute per IP), on the coordinator. AWS WAF's
      // rate rule at CloudFront stops floods before they reach the function.
      globalLimit: async (ip) => (await jobs.coord.hit(`rl:global:${ip}`, 60)) <= 300,
    };
    return buildApp(deps);
  })().catch((err: unknown) => {
    api = undefined;
    throw err;
  });
  return api;
}

let jobDeps: WorkerDeps | undefined;
async function jobs(): Promise<WorkerDeps> {
  await ensureSecrets();
  return (jobDeps ??= workerDeps());
}

/** The UI files shipped in the package (none in a package built with --skip-web). */
let site: ((request: Request) => Response) | null | undefined;
function staticFiles() {
  if (site === undefined) site = existsSync(join(here, "public")) ? staticSite(join(here, "public")) : null;
  return site;
}

function sameSecret(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type UrlEvent = { requestContext?: { domainName?: string; http?: { sourceIp?: string } } };

const root = new Hono();
root.all("*", async (c) => {
  const event = (c.env as { event?: UrlEvent } | undefined)?.event;
  const request = c.req.raw;
  const url = new URL(request.url);
  let apiPath: string | null = null;
  if (API_PREFIX.test(url.pathname)) apiPath = url.pathname.slice(4) || "/";
  else if (BARE_API.test(url.pathname)) apiPath = url.pathname;
  if (apiPath === null) {
    // Public files: served without waiting for the secrets (a cold start shows the page sooner).
    const files = staticFiles();
    return files ? files(request) : new Response("Not found", { status: 404 });
  }

  await ensureSecrets();
  const expected = process.env.ORIGIN_VERIFY;
  const viaCloudFront = !!expected && sameSecret(request.headers.get(ORIGIN_VERIFY), expected);
  // Behind CloudFront, only CloudFront may call the API: that is what puts WAF in front of it.
  if (expected && !viaCloudFront) return Response.json({ error: "forbidden" }, { status: 403 });

  const viewerHost = viaCloudFront ? request.headers.get(VIEWER_HOST) : null;
  const origin = viewerHost ? `https://${viewerHost}` : event?.requestContext?.domainName ? `https://${event.requestContext.domainName}` : null;
  const app = await apiApp(origin);

  url.pathname = apiPath;
  // The API reads the client's address from cf-connecting-ip (rate limits, audit). Nothing a
  // client sends is trusted for it: behind CloudFront it is the address CloudFront saw (set by the
  // viewer-request function, and only believed on requests that carry the origin secret), and on a
  // bare function URL the address Lambda saw.
  const headers = new Headers(request.headers);
  const clientIp = viaCloudFront ? request.headers.get(VIEWER_IP) : (event?.requestContext?.http?.sourceIp ?? null);
  for (const h of ["x-real-ip", "cf-connecting-ip", VIEWER_IP, VIEWER_HOST, ORIGIN_VERIFY]) headers.delete(h);
  if (clientIp) headers.set("cf-connecting-ip", clientIp);
  return app.fetch(new Request(url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit));
});
const http = handle(root);

/** Direct invocations (not through the URL): maintenance actions for the deploy scripts. */
interface Action {
  action: "migrate" | "counts" | "after-move";
}
interface CronEvent {
  cron: string;
}

export const handler = async (event: unknown, context: unknown) => {
  if (isSqsEvent(event)) {
    const deps = await jobs();
    const urls = parseQueueUrls(process.env.QUEUE_URLS);
    if (!urls) throw new Error("QUEUE_URLS is not set");
    const call = sqsApi({ region: process.env.AWS_REGION ?? "", credentials: roleCredentials(), fetchImpl: withTimeout((i, init) => fetch(i, init), 10_000) });
    return consumeSqs(event, { call, urls, run: (queue, msg) => consume(queue, msg, deps) });
  }

  if (event && typeof event === "object" && typeof (event as CronEvent).cron === "string") {
    const cron = (event as CronEvent).cron;
    const deps = await jobs();
    return withLogContext({ cron }, async () => {
      try {
        const result = await runScheduled(cron, deps);
        logger.info({ cron, ...result }, "scheduled run finished");
        return result;
      } catch (err) {
        // Rethrown so the invocation is recorded as failed (Lambda errors metric, alarm).
        logger.error({ err, cron }, "scheduled run failed");
        throw err;
      }
    });
  }

  const action = event && typeof event === "object" ? (event as Partial<Action>).action : undefined;
  if (action === "after-move") {
    // Once, after the database is copied in from another deployment (docs/aws-deployment.md, Cutover).
    const result = await seedAfterMove(await jobs());
    logger.info(result, "after-move repair queued");
    return result;
  }
  if (action === "migrate" || action === "counts") {
    await ensureSecrets();
    if (!process.env.DATABASE_URL) throw new Error("DB_SECRET_ARN / DB_HOST / DB_NAME are not set");
    if (action === "counts") return tableCounts(process.env.DATABASE_URL);
    const result = await migrate({
      databaseUrl: process.env.DATABASE_URL,
      migrationsDir: join(here, "migrations"),
      initSql: readFileSync(join(here, "init.sql"), "utf8"),
      appRlsPassword: process.env.APP_RLS_PASSWORD,
    });
    logger.info(result, "migrations applied");
    return result;
  }

  return http(event as Parameters<typeof http>[0], context as Parameters<typeof http>[1]);
};
