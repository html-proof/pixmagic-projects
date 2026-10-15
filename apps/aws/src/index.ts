import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { buildApp, cognitoAuth, cognitoConfig, firebasePasswordCheck, unconfiguredCognito, type App, type Deps } from "@app/api";
import { env as config, logger, memoryBlobs, memoryCoord, withTimeout, type Coord, type Mailer, type Queues } from "@app/core";
import { dynamoCoord } from "./dynamoCoord.js";
import { migrate } from "./migrate.js";
import { loadSecrets } from "./secrets.js";
import { staticSite } from "./staticSite.js";

/**
 * AWS hosting (infra/aws/staging.yaml): one Lambda function URL serves the static UI and the API on
 * one origin, as the Cloudflare Worker does (apps/cloudflare/src/index.ts), so the session cookie
 * stays first-party. The API is the same Hono app; what differs is the wiring:
 *   - database: RDS PostgreSQL, connections kept per instance (no per-request scope on Lambda)
 *   - coordinator: DynamoDB (dynamoCoord.ts) instead of a Durable Object
 *   - secrets: Secrets Manager at cold start (secrets.ts)
 *   - background jobs (Shopify sync, webhooks, email sending): not run here. This environment is
 *     for sign-in (Phase 1); jobs sent to a queue are logged and dropped.
 */
const here = dirname(fileURLToPath(import.meta.url));
const API_PREFIX = /^\/api(\/|$)/;
/** API paths served without the /api prefix (webhooks, pixel, Shopify), as on the Worker. */
const BARE_API = /^\/(webhooks|pixel|shopify)\/|^\/(healthz|readyz)$/;

function droppedQueues(): Queues {
  const drop = (queue: string) => ({
    async send() {
      logger.warn({ queue }, "background jobs don't run in this environment: job dropped");
    },
  });
  return { sync: drop("sync"), webhooks: drop("webhooks"), aggregate: drop("aggregate"), email: drop("email") };
}

/** App emails (invitations, alerts) aren't sent from this environment; sign-in emails are Cognito's. */
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
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "", sessionToken: process.env.AWS_SESSION_TOKEN },
      fetchImpl: withTimeout((input, init) => fetch(input, init), 5_000),
    });
  }
  // Many Lambda instances run at once: state kept in one of them is wrong for the others.
  if (process.env.NODE_ENV === "production") throw new Error("COORD_TABLE is required in production");
  return memoryCoord();
}

interface Ready {
  route: (request: Request, clientIp: string | null) => Promise<Response>;
}
let ready: Promise<Ready> | undefined;

async function boot(origin: string | null): Promise<Ready> {
  await loadSecrets();
  // On AWS the function's own role makes Cognito's admin calls (least privilege, no long-lived keys).
  if (!process.env.COGNITO_ADMIN_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_ID) {
    process.env.COGNITO_ADMIN_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
    process.env.COGNITO_ADMIN_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.COGNITO_ADMIN_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN ?? "";
  }
  // The function knows its own address from the event Lambda hands it (not a client header).
  if (!process.env.APP_URL && origin) {
    process.env.APP_URL = origin;
    process.env.API_URL = `${origin}/api`;
  }
  const authFetch = withTimeout((input, init) => fetch(input, init), 10_000);
  const cognito = cognitoConfig();
  if (!cognito) logger.error({}, "COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are not set: every sign-in will answer 503");
  const legacyKey = config().LEGACY_FIREBASE_API_KEY;
  const coord = coordinator();
  const deps: Deps = {
    auth: cognito ? cognitoAuth(cognito, authFetch) : unconfiguredCognito(),
    legacy: legacyKey ? firebasePasswordCheck(legacyKey, authFetch) : null,
    coord,
    // The Worker's GLOBAL_LIMITER binding (300 a minute per IP), on the coordinator.
    globalLimit: async (ip) => (await coord.hit(`rl:global:${ip}`, 60)) <= 300,
    queues: droppedQueues(),
    payloads: memoryBlobs(),
    mailer: logMailer,
    fetchImpl: withTimeout((input, init) => fetch(input, init)),
  };
  const api: App = buildApp(deps);
  const site = staticSite(join(here, "public"));
  return {
    async route(request, clientIp) {
      const url = new URL(request.url);
      let apiPath: string | null = null;
      if (API_PREFIX.test(url.pathname)) apiPath = url.pathname.slice(4) || "/";
      else if (BARE_API.test(url.pathname)) apiPath = url.pathname;
      if (apiPath === null) return site(request);
      url.pathname = apiPath;
      // The API reads the client's address from cf-connecting-ip (rate limits, audit). Cloudflare
      // sets it at its edge; here nothing does, so a client could send its own. Replace it with
      // the address Lambda saw.
      const headers = new Headers(request.headers);
      headers.delete("x-real-ip");
      if (clientIp) headers.set("cf-connecting-ip", clientIp);
      else headers.delete("cf-connecting-ip");
      return api.fetch(new Request(url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit));
    },
  };
}

const root = new Hono();
root.all("*", async (c) => {
  const event = (c.env as { event?: { requestContext?: { domainName?: string; http?: { sourceIp?: string } } } } | undefined)?.event;
  const domain = event?.requestContext?.domainName;
  const { route } = await (ready ??= boot(domain ? `https://${domain}` : null));
  return route(c.req.raw, event?.requestContext?.http?.sourceIp ?? null);
});
const http = handle(root);

/** A direct invocation (not through the URL): maintenance actions for the deploy script. */
interface Action {
  action: "migrate";
}

export const handler = async (event: unknown, context: unknown) => {
  if (event && typeof event === "object" && (event as Action).action === "migrate") {
    await loadSecrets();
    if (!process.env.DATABASE_URL) throw new Error("DB_SECRET_ARN / DB_HOST / DB_NAME are not set");
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
