// The old Cloudflare address once Insights has moved to AWS (docs/aws-deployment.md, "Cutover").
// Uploaded as a version of the `insights` Worker and deployed in place of the app, in two phases:
//
//   maintenance  while the database is copied: pages say "moving, back in a few minutes" and the API
//                answers 503 with Retry-After, so Shopify holds its webhooks and delivers them later
//                instead of to a database that is about to be left behind.
//   forward      afterwards, for as long as the old address gets traffic: pages and browser
//                navigations (Shopify app launches, OAuth returns) are redirected to the new address,
//                and calls that can't follow a redirect (Shopify webhooks, storefront pixel events)
//                are passed through to it unchanged, so their signatures still verify there.
//
// The app's own version stays on Cloudflare, so a rollback is `wrangler versions deploy <it>@100%`.
import { DurableObject } from "cloudflare:workers";

interface Env {
  /** The new address, e.g. https://d2mr8m2p1qkh58.cloudfront.net (no trailing slash). */
  MOVED_TO?: string;
  /** "forward" once the copy is done; anything else (or unset) is maintenance. */
  MOVE_PHASE?: string;
}

/**
 * Kept so the Worker's Durable Object binding (COORD) stays valid. Its stored state (rate-limit
 * counters, OAuth state, locks) is left untouched for a rollback; nothing reaches it from here.
 */
export class Coordinator extends DurableObject {
  override async fetch(): Promise<Response> {
    return new Response("moved", { status: 410 });
  }
}

const RETRY_AFTER_S = 600;
/** API paths the app also answered without the /api prefix (a dedicated API hostname). */
const BARE_API = /^\/(webhooks|pixel|shopify)\/|^\/(healthz|readyz)$/;
/** Set by Cloudflare or a client; never passed on as if they described the new hop. */
const HOP_HEADERS = ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-worker", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"];

const phase = (env: Env) => (env.MOVE_PHASE === "forward" && destination(env) ? "forward" : "maintenance");

function destination(env: Env): URL | null {
  try {
    const url = new URL(env.MOVED_TO ?? "");
    return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" ? url : null;
  } catch {
    return null;
  }
}

/** The path on the new address: API calls always under /api, as the AWS app serves them. */
function apiPath(pathname: string): string | null {
  if (pathname === "/api" || pathname.startsWith("/api/")) return pathname;
  return BARE_API.test(pathname) ? `/api${pathname}` : null;
}

const MAINTENANCE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Insights is moving</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f6f3; --card: #fff; --text: #1d1d1b; --muted: #5f5e5a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #20201e; --text: #ecebe7; --muted: #a3a29c; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 420px; background: var(--card); border-radius: 12px; padding: 28px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.08); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Insights is moving to a new home</h1>
  <p>We're moving your data to faster servers. This takes a few minutes; this page reloads by itself and takes you there when it's done.</p>
</main>
</body>
</html>`;

export function handle(request: Request, env: Env): Response | Promise<Response> {
  const url = new URL(request.url);
  const api = apiPath(url.pathname);

  if (phase(env) === "maintenance") {
    const headers = { "retry-after": String(RETRY_AFTER_S), "cache-control": "no-store" };
    if (api !== null) {
      return Response.json({ error: "maintenance", message: "Insights is moving to a new address. Please try again in a few minutes." }, { status: 503, headers });
    }
    return new Response(MAINTENANCE_PAGE, { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }

  const target = new URL(`${api ?? url.pathname}${url.search}`, destination(env)!);
  // Pages, and API navigations (an app launch from the Shopify admin, an OAuth return): the browser
  // follows, and any cookie the new address sets belongs to the new address.
  if (api === null || request.method === "GET" || request.method === "HEAD") {
    return new Response(null, { status: api === null ? 308 : 307, headers: { location: target.toString(), "cache-control": "no-store" } });
  }
  // Webhooks and pixel events: passed through byte for byte (HMACs are over the raw body).
  const headers = new Headers(request.headers);
  for (const h of HOP_HEADERS) headers.delete(h);
  return fetch(target, { method: request.method, headers, body: request.body, redirect: "manual" });
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),

  // Jobs the app queued before the switch. In maintenance they wait (a rollback puts the app back to
  // run them); once forwarding, the database they were for has been copied and left behind.
  async queue(batch: MessageBatch, env: Env) {
    if (phase(env) === "forward") {
      console.log(JSON.stringify({ msg: "dropped a job queued before the move", queue: batch.queue, count: batch.messages.length }));
      batch.ackAll();
    } else {
      batch.retryAll({ delaySeconds: RETRY_AFTER_S });
    }
  },

  // The app's cron triggers are removed at the switch; should one still fire, there is nothing to do.
  async scheduled() {},
} satisfies ExportedHandler<Env>;
