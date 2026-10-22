import { existsSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { buildApp, CLIENT_IP_HEADER, type App } from "@app/api";
import { consume, runScheduled, type WorkerDeps } from "@app/worker";
import { logger, mailpitMailer, memoryBlobs, memoryCoord, withTimeout, type Mailer } from "@app/core";
import { fakeSmsProvider, type FakeSent } from "@app/core/sms";
import { disconnectDb } from "@app/db";
import { apiDeps, apiPath } from "./app.js";
import { localQueues, type LocalQueues } from "./localQueues.js";
import { nodeSmtpConnect } from "./nodeSmtp.js";
import { APP_SETTINGS } from "./settings.js";
import { staticSite } from "./staticSite.js";

/**
 * bizinsights on one machine, for development, the demos and the end-to-end tests: the same UI, API
 * and job handlers as the AWS functions (index.ts), in one Node process. In place of the AWS
 * services: jobs run in-process (localQueues.ts), coordination and large webhook bodies stay in
 * memory, email goes to Mailpit when MAILPIT_URL is set (else it is only logged), and Postgres is
 * whatever DATABASE_URL / APP_DATABASE_URL point at. Schedules don't run by themselves:
 * `POST /__scheduled?cron=<expression>` runs one (see CRON in apps/worker/src/index.ts).
 *
 * Started by dev.ts (`pnpm --filter @app/aws dev`). Configuration, lowest first: APP_SETTINGS
 * (settings.ts), the env file, the process environment. It answers on the loopback addresses only.
 */
export interface LocalOptions {
  port: number;
  /** The UI build (a Next.js export) to serve. */
  assets: string;
}

/** Mail without Mailpit: say what would have been sent, never the address. */
const logMailer: Mailer = {
  async send(to, subject) {
    logger.info({ subject, to: to.replace(/^(.).*@/, "$1…@") }, "email not sent (no MAILPIT_URL)");
  },
};

/** The process's settings: the env file under the environment, APP_SETTINGS under both. */
export function loadSettings(envFile: string | null) {
  if (envFile) process.loadEnvFile(envFile);
  for (const [k, v] of Object.entries(APP_SETTINGS)) process.env[k] ??= v;
  process.env.NODE_ENV ??= "development";
  // Much here is only right on one machine (state kept in memory, Mailpit), so never production.
  if (process.env.NODE_ENV === "production") throw new Error("The local server is for development: NODE_ENV must not be production");
}

/** The local server's stand-in sender (core's fake AWS): a shared sender ID any store may verify. */
export const LOCAL_SMS_SENDER = "LOCALTEST";

/** What AWS would report a moment after a send: delivered, at no charge (nothing left the machine). */
function localDelivery(sent: FakeSent) {
  return {
    eventType: "TEXT_DELIVERED",
    eventVersion: "1.0",
    eventTimestamp: Date.now(),
    isFinal: true,
    messageId: sent.messageId,
    messageRequestTimestamp: Date.now() - 1000,
    messageType: sent.messageType,
    messageStatus: "DELIVERED",
    messageStatusDescription: "Local server: nothing was sent",
    context: sent.context,
    totalMessageParts: 1,
    totalMessagePrice: 0,
    totalCarrierFee: 0,
  };
}

export function localDeps(): { jobs: WorkerDeps; queues: LocalQueues } {
  const mailpit = process.env.MAILPIT_URL;
  const queues = localQueues((queue, msg) => consume(queue, msg, jobs));
  // Texts never leave the machine: the fake records them and "delivers" each a moment later.
  process.env.SMS_SHARED_SENDER ??= LOCAL_SMS_SENDER;
  const sms = fakeSmsProvider({
    identities: [{ kind: "sender_id", arn: `arn:aws:sms-voice:local:000000000000:sender-id/${LOCAL_SMS_SENDER}/AU`, id: LOCAL_SMS_SENDER, label: LOCAL_SMS_SENDER, country: "AU", status: "REGISTERED", twoWay: false, optOutList: "Default", registrationStatus: "COMPLETE", tags: { "bizinsights:shared": "true" } }],
    onSend: (sent) => {
      logger.info({ messageId: sent.messageId, parts: Math.ceil(sent.body.length / 153) }, "local server: text not sent (fake AWS)");
      setTimeout(() => void queues.smsEvents.send(localDelivery(sent)), 1500);
    },
  });
  const jobs: WorkerDeps = {
    coord: memoryCoord(),
    queues,
    payloads: memoryBlobs(),
    mailer: mailpit ? mailpitMailer(mailpit) : logMailer,
    // Every outbound call the API and the jobs make goes through this, so each gets a time limit.
    fetchImpl: withTimeout((input, init) => fetch(input, init)),
    smtpConnect: nodeSmtpConnect,
    sms,
  };
  return { jobs, queues };
}

/** A UI build, re-read when its folder changes (a rebuild while the server runs). */
function uiFiles(dir: string): (request: Request) => Response {
  let site: ((request: Request) => Response) | null = null;
  try {
    watch(dir, { recursive: true }, () => (site = null));
  } catch {
    /* no folder yet, or no recursive watching here: restart after a rebuild */
  }
  return (request) => {
    if (!existsSync(resolve(dir, "index.html"))) {
      return new Response(`No UI build in ${dir}: run pnpm --filter @app/web build`, { status: 404 });
    }
    site ??= staticSite(dir);
    return site(request);
  };
}

/**
 * The request router: the API under /api (and the bare paths Shopify calls), the UI otherwise.
 * The client's address is the socket's unless the request names one (tests pose as many visitors).
 */
export function localHandler(app: App, ui: (request: Request) => Response, jobs: WorkerDeps) {
  return async (request: Request, remoteAddress: string | undefined): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/__scheduled" && request.method === "POST") {
      const cron = url.searchParams.get("cron") ?? "";
      return Response.json({ cron, result: await runScheduled(cron, jobs) });
    }
    const path = apiPath(url.pathname);
    if (path === null) return ui(request);
    url.pathname = path;
    const headers = new Headers(request.headers);
    if (!headers.has(CLIENT_IP_HEADER) && remoteAddress) headers.set(CLIENT_IP_HEADER, remoteAddress.replace(/^::ffff:/, ""));
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
    return app.fetch(new Request(url, { method: request.method, headers, body, duplex: "half" } as RequestInit));
  };
}

function toRequest(req: IncomingMessage, port: number): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (v !== undefined) headers.set(k, v);
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response, head: boolean) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (head || !response.body) return res.end();
  await new Promise<void>((done, fail) => {
    Readable.fromWeb(response.body as never)
      .on("error", fail)
      .pipe(res)
      .on("finish", done)
      .on("error", fail);
  });
}

function listen(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((ready, fail) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // A machine without IPv6 still serves on 127.0.0.1.
      if (host === "::1" && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) ready(false);
      else fail(err);
    });
    server.listen(port, host, () => ready(true));
  });
}

/**
 * Listens on both loopback addresses: `localhost` resolves to either, depending on the client, and
 * a client that tries the missing one first waits for that to fail on every connection.
 */
export async function startLocal(opts: LocalOptions): Promise<{ close(): Promise<void> }> {
  const { jobs, queues } = localDeps();
  const handle = localHandler(buildApp(apiDeps(jobs)), uiFiles(opts.assets), jobs);
  const servers: Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer((req, res) => {
      handle(toRequest(req, opts.port), req.socket.remoteAddress)
        .then((response) => send(res, response, req.method === "HEAD"))
        .catch((err: unknown) => {
          logger.error({ err, path: req.url?.split("?")[0] }, "local server: request failed");
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        });
    });
    if (await listen(server, opts.port, host)) servers.push(server);
  }
  logger.info({ url: `http://localhost:${opts.port}`, assets: opts.assets }, "local server ready");
  return {
    async close() {
      queues.close();
      await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
      await disconnectDb();
    },
  };
}
