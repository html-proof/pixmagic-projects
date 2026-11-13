import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp, CLIENT_GEO_HEADER, CLIENT_IP_HEADER, type App } from "@app/api";
import { consume, CRON, runScheduled, type WorkerDeps } from "@app/worker";
import { logger, reportUnscopedSystemQueries, warnHalfConfigured, withTimeout } from "@app/core";
import { disconnectDb } from "@app/db";
import { apiDeps } from "./app.js";
import { roleCredentials } from "./awsClient.js";
import { pruneEvolutionData } from "./evolutionDb.js";
import { fsBlobs } from "./fsBlobs.js";
import { chooseMailer } from "./mailers.js";
import { Registry, serveMetrics, statusClass } from "./metrics.js";
import { send, toRequest } from "./nodeHttp.js";
import { apiPath } from "./paths.js";
import { pgCoord } from "./pgCoord.js";
import { pgQueues, pruneDead, queueConcurrency, queueStats, startQueueRunner } from "./pgQueues.js";
import { pruneTicks, startSchedules, type Schedule } from "./schedules.js";
import { APP_SETTINGS } from "./settings.js";
import { staticSite } from "./staticSite.js";

/**
 * bizinsights on a server of its own (docs/ikorex-migration): the same UI, API and job handlers as
 * the AWS functions (index.ts), as long-running Node processes behind a Cloudflare Tunnel. One build,
 * two roles (server.ts):
 *
 *   web      the UI and the API on PORT (8080)
 *   worker   the queues' jobs (pgQueues.ts) and, with SCHEDULES=on, the schedules (schedules.ts)
 *
 * Each also answers GET /metrics on METRICS_PORT (9464) for Prometheus, on the internal network only.
 * In place of the AWS services: PostgreSQL holds the jobs, the schedule ticks and the coordinator;
 * large webhook bodies and WhatsApp media are files under BLOB_DIR (a volume both roles mount);
 * settings and secrets come from the environment (Compose's env file), not Secrets Manager. Email
 * goes through Resend; sign-in is the app's own (AUTH_MODE), with Cognito behind it until the AWS
 * account closes. What still reaches AWS uses keys from the environment where AWS used the
 * function's role.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** Required in the environment; the error names what is missing, never a value. */
const REQUIRED = ["DATABASE_URL", "APP_DATABASE_URL", "APP_URL"] as const;

/** Settings: the package's (settings.ts) under the environment's, then what follows from them. */
export function selfHostSettings(env: NodeJS.ProcessEnv = process.env, dir = here) {
  for (const [k, v] of Object.entries(APP_SETTINGS)) env[k] ??= v;
  env.NODE_ENV ??= "production";
  // Which commit this is (GET /api/version), from the build (scripts/build-server.mjs); infra/cdk does this on AWS.
  const buildFile = join(dir, "build.json");
  if (existsSync(buildFile)) {
    const build = JSON.parse(readFileSync(buildFile, "utf8")) as { commit?: string; builtAt?: string };
    if (build.commit) env.APP_COMMIT ??= build.commit;
    if (build.builtAt) env.APP_BUILT_AT ??= build.builtAt;
  }
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Not set: ${missing.join(", ")} (see infra/ikorex/env.example)`);
  const appUrl = env.APP_URL!.replace(/\/+$/, "");
  env.APP_URL = appUrl;
  env.API_URL ??= `${appUrl}/api`;
  // Cognito's admin calls: on AWS the function's own role makes them (index.ts); here an IAM user's keys.
  if (!env.COGNITO_ADMIN_ACCESS_KEY_ID && env.AWS_ACCESS_KEY_ID) {
    env.COGNITO_ADMIN_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID;
    env.COGNITO_ADMIN_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
    env.COGNITO_ADMIN_SESSION_TOKEN = env.AWS_SESSION_TOKEN ?? "";
  }
}

/** The pool for the queue, the schedules and the coordinator: the system login, outside @app/db's row scopes. */
export function runtimePool(env: NodeJS.ProcessEnv, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max, idleTimeoutMillis: 30_000, application_name: "bizinsights-runtime" });
  // An idle connection the database drops (a restart) must not take the process down with it.
  pool.on("error", (err) => logger.warn({ err }, "runtime database connection dropped"));
  return pool;
}

export interface SelfHostDeps extends WorkerDeps {
  coord: ReturnType<typeof pgCoord>;
  payloads: ReturnType<typeof fsBlobs>;
}

export function selfHostDeps(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): SelfHostDeps {
  const credentials = roleCredentials(env);
  const coord = pgCoord(pool);
  return {
    coord,
    queues: pgQueues(pool),
    payloads: fsBlobs(env.BLOB_DIR || "/data/blobs"),
    mailer: chooseMailer(env, credentials, fetch),
    // Every outbound call the API and the jobs make goes through this, so each gets a time limit.
    fetchImpl: withTimeout((input, init) => fetch(input, init)),
  };
}

/** Headers only this server may set: whatever a client sends under these names is dropped. */
const OWN_HEADERS = [CLIENT_IP_HEADER, CLIENT_GEO_HEADER, "x-real-ip", "x-insights-viewer-ip", "x-insights-viewer-host", "x-insights-viewer-geo", "x-origin-verify"];

/** Where the client is, as "country|region|city" (each part URI-encoded), from Cloudflare's visitor-location headers. */
export function cloudflareGeo(h: Headers): string | null {
  const parts = [h.get("cf-ipcountry"), h.get("cf-region"), h.get("cf-ipcity")].map((v) => v?.trim() ?? "");
  return parts.some(Boolean) ? parts.map(encodeURIComponent).join("|") : null;
}

export interface WebOptions {
  /**
   * The header the edge puts the client's address in (Cloudflare: cf-connecting-ip). Believed only
   * because the tunnel is the one way in: the web container publishes no port (infra/ikorex).
   * Requests without it (Prometheus, the WhatsApp service's webhooks on the internal network) get
   * the socket's address.
   */
  trustedIpHeader: string | null;
  /** Bodies larger than this are refused (the Lambda function URL allowed 6 MB). */
  maxBodyBytes: number;
  /**
   * The app's own host (APP_URL's). GET and HEAD requests that come through the edge on any other
   * name the tunnel answers on (www, a test name) get a 301 there, path and query unchanged:
   * sessions, the CSRF check and OAuth callbacks all expect one origin. What CloudFront's
   * viewer-request function did on AWS (infra/cdk/lib/viewer-request.ts). Other methods (webhooks,
   * pixel events, API-key clients) are served where they arrive: they don't follow redirects. And
   * so is everything from inside the server (Docker's health check, deploy.sh's checks, the
   * WhatsApp service), which has no edge header and calls by container name or 127.0.0.1.
   */
  canonicalHost?: string | null;
}

/** The request router: /__health for Docker, the API under /api (and the bare paths Shopify calls), the UI otherwise. */
export function webHandler(app: App, files: ((request: Request) => Response) | null, o: WebOptions) {
  const canonical = o.canonicalHost?.toLowerCase() || null;
  return async (request: Request, remoteAddress: string | undefined): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/__health") return new Response("ok", { headers: { "cache-control": "no-store" } });
    const edgeIp = o.trustedIpHeader ? request.headers.get(o.trustedIpHeader)?.trim() : undefined;
    const viaEdge = !!edgeIp && isIP(edgeIp) !== 0;
    if (canonical && viaEdge && (request.method === "GET" || request.method === "HEAD")) {
      const host = request.headers.get("host")?.trim().toLowerCase();
      if (host && host !== canonical) {
        return new Response(null, { status: 301, headers: { location: `https://${canonical}${url.pathname}${url.search}`, "cache-control": "max-age=3600" } });
      }
    }
    const path = apiPath(url.pathname);
    if (path === null) return files ? files(request) : new Response("Not found", { status: 404 });
    if (Number(request.headers.get("content-length") ?? 0) > o.maxBodyBytes) return Response.json({ error: "too_large" }, { status: 413 });
    url.pathname = path;
    const headers = new Headers(request.headers);
    const geo = viaEdge ? cloudflareGeo(request.headers) : null;
    for (const h of OWN_HEADERS) headers.delete(h);
    const ip = viaEdge ? edgeIp : remoteAddress?.replace(/^::ffff:/, "");
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    if (geo) headers.set(CLIENT_GEO_HEADER, geo);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
    return app.fetch(new Request(url, { method: request.method, headers, body, duplex: "half" } as RequestInit));
  };
}

/** The schedules EventBridge Scheduler fires on AWS (infra/cdk app-stack.ts), plus the housekeeping AWS did by itself. */
export function selfHostSchedules(deps: SelfHostDeps, pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): Schedule[] {
  const quietly = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      logger.error({ err, what }, "nightly housekeeping step failed; the next night tries again");
      return null;
    }
  };
  return [
    { name: "every15min", cron: CRON.refreshTokens, timeZone: "UTC", catchUpMinutes: 14, run: () => runScheduled(CRON.refreshTokens, deps) },
    {
      name: "nightly",
      cron: CRON.reconcile,
      timeZone: "UTC",
      catchUpMinutes: 12 * 60,
      run: async () => {
        const result = (await runScheduled(CRON.reconcile, deps)) as Record<string, unknown>;
        const now = Date.now();
        // What AWS did by itself: DynamoDB's TTL, the bucket's 7-day rule, SQS's 14-day dead-letter retention.
        result.housekeeping = {
          coord: await quietly("coord", () => deps.coord.prune()),
          blobs: await quietly("blobs", () => deps.payloads.prune(7 * 86_400_000, now)),
          deadJobs: await quietly("dead jobs", () => pruneDead(pool, now)),
          ticks: await quietly("ticks", () => pruneTicks(pool, now)),
        };
        // What the WhatsApp service (Evolution API) keeps of sent messages goes after 7 days.
        if (env.EVOLUTION_DATABASE_URL) result.evolutionPruned = await quietly("evolution", () => pruneEvolutionData(env.EVOLUTION_DATABASE_URL!, 7));
        return result;
      },
    },
  ];
  // No AWS cost email here: AWS's own schedule sends it while there is an AWS bill, and the account
  // closes after the move (docs/ikorex-migration, decision 4b).
}

export interface Running {
  close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((ready, fail) => {
    server.once("error", fail);
    server.listen(port, "0.0.0.0", () => ready());
  });
}

const port = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};

export async function startWeb(env: NodeJS.ProcessEnv = process.env): Promise<Running> {
  const pool = runtimePool(env, 4);
  const deps = selfHostDeps(pool, env);
  const app = buildApp(apiDeps(deps));
  const assets = env.ASSETS_DIR || join(here, "public");
  const files = existsSync(join(assets, "index.html")) ? staticSite(assets) : null;
  if (!files) logger.warn({ assets }, "no UI build here: only the API answers");
  const origin = new URL(env.APP_URL!).origin;
  const handle = webHandler(app, files, {
    trustedIpHeader: env.TRUSTED_IP_HEADER === "none" ? null : (env.TRUSTED_IP_HEADER || "cf-connecting-ip").toLowerCase(),
    maxBodyBytes: 6 * 1024 * 1024,
    canonicalHost: new URL(origin).host,
  });

  const registry = new Registry();
  const requests = registry.counter("bizinsights_http_requests_total", "Requests answered, by kind (api or page) and status class.");
  const duration = registry.histogram("bizinsights_http_request_seconds", "Time to answer, by kind.", [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]);

  const server = createServer((req, res) => {
    const started = performance.now();
    const kind = apiPath(req.url?.split("?")[0] ?? "/") === null ? "page" : "api";
    handle(toRequest(req, origin), req.socket.remoteAddress)
      .then(async (response) => {
        await send(res, response, req.method === "HEAD");
        return response.status;
      })
      .catch((err: unknown) => {
        logger.error({ err, path: req.url?.split("?")[0] }, "request failed");
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
        return 500;
      })
      .then((status) => {
        requests.inc({ kind, status: statusClass(status) });
        duration.observe({ kind }, (performance.now() - started) / 1000);
      });
  });
  // The API function's limit on AWS was 55 s; Cloudflare gives up on an origin after 100 s.
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  // Longer than cloudflared keeps an idle connection, so it never sends on one this side closed.
  server.keepAliveTimeout = 95_000;
  await listen(server, port(env.PORT, 8080));
  const metrics = await serveMetrics(registry, port(env.METRICS_PORT, 9464));
  logger.info({ port: port(env.PORT, 8080), url: env.APP_URL }, "web ready");

  return {
    async close() {
      await new Promise((done) => server.close(done));
      server.closeAllConnections();
      await new Promise((done) => metrics.close(done));
      await pool.end();
      await disconnectDb();
    },
  };
}

export async function startWorker(env: NodeJS.ProcessEnv = process.env): Promise<Running> {
  const concurrency = queueConcurrency(env.QUEUE_CONCURRENCY);
  const pool = runtimePool(env, 6);
  const deps = selfHostDeps(pool, env);

  const registry = new Registry();
  const jobs = registry.counter("bizinsights_jobs_total", "Jobs settled, by queue and outcome (ack, retry, unsettled, threw, timeout, dead).");
  const jobTime = registry.histogram("bizinsights_job_seconds", "Time a job ran, by queue.", [0.1, 0.5, 1, 5, 15, 60, 300, 900]);
  const scheduleRuns = registry.counter("bizinsights_schedule_runs_total", "Scheduled runs, by schedule and result.");
  const lastSuccess = new Map<string, number>();
  registry.gauge({
    name: "bizinsights_queue_jobs",
    help: "Jobs in each queue now, by state (ready, delayed, in_flight, dead).",
    async read() {
      const stats = await queueStats(pool, Date.now());
      return stats.flatMap((s) => [
        { labels: { queue: s.queue, state: "ready" }, value: s.ready },
        { labels: { queue: s.queue, state: "delayed" }, value: s.delayed },
        { labels: { queue: s.queue, state: "in_flight" }, value: s.inFlight },
        { labels: { queue: s.queue, state: "dead" }, value: s.dead },
      ]);
    },
  });
  registry.gauge({
    name: "bizinsights_queue_oldest_ready_seconds",
    help: "How long the oldest due job of each queue has waited.",
    async read() {
      return (await queueStats(pool, Date.now())).map((s) => ({ labels: { queue: s.queue }, value: s.oldestReadyS }));
    },
  });
  registry.gauge({
    name: "bizinsights_schedule_last_success_timestamp_seconds",
    help: "When each schedule last finished without an error (this process).",
    async read() {
      return [...lastSuccess].map(([schedule, ms]) => ({ labels: { schedule }, value: Math.floor(ms / 1000) }));
    },
  });

  const runner = startQueueRunner({
    pool,
    run: (queue, msg) => consume(queue, msg, deps),
    concurrency,
    onSettled: (queue, outcome, ms) => {
      jobs.inc({ queue, outcome });
      jobTime.observe({ queue }, ms / 1000);
    },
  });
  // Off unless asked for: a staging copy of production must never refresh tokens or reconcile stores
  // on its own, and before the cutover AWS runs them (docs/ikorex-migration).
  const schedules =
    env.SCHEDULES === "on"
      ? startSchedules({
          pool,
          schedules: selfHostSchedules(deps, pool, env),
          onRun: (schedule, ok) => {
            scheduleRuns.inc({ schedule, result: ok ? "ok" : "failed" });
            if (ok) lastSuccess.set(schedule, Date.now());
          },
        })
      : null;
  if (!schedules) logger.warn({}, "SCHEDULES is not on: no scheduled runs here");
  const metrics = await serveMetrics(registry, port(env.METRICS_PORT, 9464));
  logger.info({ concurrency, schedules: !!schedules }, "worker ready");

  return {
    async close() {
      // At once: the jobs' grace fits Docker's 60 s.
      await Promise.all([schedules?.stop(), runner.stop(Number(env.STOP_GRACE_MS) || 45_000)]);
      await new Promise((done) => metrics.close(done));
      await pool.end();
      await disconnectDb();
    },
  };
}

/** `server.mjs web|worker`: start the role, stop cleanly on SIGTERM (docker stop) or SIGINT. */
export async function main(argv: string[]): Promise<void> {
  const role = argv[0];
  if (role !== "web" && role !== "worker") {
    console.error("usage: node server.mjs web|worker");
    process.exit(2);
  }
  selfHostSettings();
  // As on AWS (index.ts): a system query that names no row scope is logged with where it came from.
  reportUnscopedSystemQueries();
  // A provider with its public id set and no secret fails quietly ("Coming soon"): say so in the logs.
  warnHalfConfigured();
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "unhandled rejection: exiting (Docker restarts the container)");
    process.exit(1);
  });
  const running = role === "web" ? await startWeb() : await startWorker();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal, role }, "stopping");
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, "stopping failed");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
