import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { dbReachable, systemDb } from "@app/db";
import { AppError, env, logger } from "@app/core";
import { ReportRangeError } from "@app/shared/staff";
import { clientIp, HttpError, SESSION_COOKIE, SHARE_COOKIE, type AppEnv, type Deps } from "./context.js";
import { probeDb, tenantDb, type ProbeResult } from "@app/db";
import { requestContext } from "./requestContext.js";
import { rowScope } from "./rowScope.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { sessionRoutes } from "./routes/sessions.js";
import { shopifyRoutes } from "./routes/shopify.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { mailEventRoutes } from "./routes/mailEvents.js";
import { pixelRoutes } from "./routes/pixel.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { scopeRoutes } from "./routes/scopes.js";
import { contactRoutes } from "./routes/contacts.js";
import { adsRoutes } from "./routes/ads.js";
import { adsGoogleDemoRoutes } from "./routes/adsGoogleDemo.js";
import { metaWebhookRoutes } from "./routes/metaWebhooks.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { whatsappWebhookRoutes } from "./routes/whatsappWebhook.js";
import { staffRoutes } from "./routes/staff.js";
import { staffAttendanceRoutes } from "./routes/staffAttendance.js";
import { staffPayrollRoutes } from "./routes/staffPayroll.js";
import { staffReportRoutes } from "./routes/staffReports.js";
import { staffPortalRoutes } from "./routes/staffPortal.js";
import { emailAccountRoutes } from "./routes/emailAccounts.js";
import { emailContentRoutes } from "./routes/emailContent.js";
import { emailActivityRoutes } from "./routes/emailActivity.js";
import { emailPublicRoutes } from "./routes/emailPublic.js";
import { privacyRoutes } from "./routes/privacy.js";
import { teamRoutes } from "./routes/team.js";
import { exportRoutes } from "./routes/exports.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { smsRoutes } from "./routes/sms.js";
import { smsPublicRoutes } from "./routes/smsPublic.js";
import { automationRoutes } from "./routes/automations.js";
import { zapierOAuthRoutes } from "./routes/zapierOAuth.js";
import { zapierRoutes } from "./routes/zapier.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Machine endpoints with their own authentication: webhooks (HMAC), the pixel (ingest key), the
 * event API (event key, no cookie), one-click unsubscribe (a signed token; mail providers POST
 * it from their own servers, RFC 8058), and Zapier's server (its client secret at /oauth/token, a
 * bearer token at /zapier/*: neither ever reads a cookie).
 */
const CSRF_EXEMPT = [/^\/webhooks\//, /^\/pixel\//, /^\/v1\/events/, /^\/email\/unsubscribe\//, /^\/oauth\/token$/, /^\/zapier\//];
/**
 * Not subject to the global per-IP limit. Shopify delivers every store's webhooks from a small
 * pool of addresses, so a per-IP cap meant one busy merchant (or a backfill burst) could get
 * every store's webhooks 429ed into Shopify's retry/disable path; they are HMAC-verified
 * instead. The pixel has its own, more generous per-IP limit that the global one shadowed. Zapier
 * calls for every merchant from a few addresses too: its routes have their own limits (per
 * connection, and per IP for tokens that don't verify).
 */
const GLOBAL_LIMIT_EXEMPT = [/^\/healthz$/, /^\/readyz$/, /^\/webhooks\//, /^\/pixel\//, /^\/oauth\/token$/, /^\/zapier\//];
const MB = 1024 * 1024;

export type App = Hono<AppEnv>;

/**
 * On every API response, including errors and early 413/429s. public/_headers covers the static
 * UI files only (apps/aws/src/staticSite.ts), never responses the API generates. API responses
 * are JSON or redirects, never a page: nothing may sniff them into HTML, render them, frame them,
 * or keep a copy (they carry account and customer data).
 */
const API_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cache-control": "no-store",
};

export function buildApp(deps: Deps): App {
  const app = new Hono<AppEnv>();

  // First, so every response carries the request id and every log line below can be matched to it.
  app.use("*", requestContext());
  // Whose rows systemDb sees for the rest of the request: the workspace in the path, or a listed reason.
  app.use("*", rowScope());

  app.use("*", async (c, next) => {
    await next();
    // A response that names who may frame it (Shopify's admin, routes/shopify.ts) can't also say DENY.
    const framable = /frame-ancestors (?!'none')/.test(c.res.headers.get("content-security-policy") ?? "");
    for (const [name, value] of Object.entries(API_HEADERS)) {
      if (framable && name === "x-frame-options") continue;
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
    // Only over https (CloudFront redirects everything else; local development is plain http).
    if (c.req.url.startsWith("https:")) c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  // Shopify webhooks carry up to 5 MB; everything else (Meta's webhooks included) is small JSON.
  app.use("*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path === "/webhooks/shopify" ? 5 * MB : MB,
      onError: (c) => c.json({ error: "request", message: "Request body too large" }, 413),
    })(c, next),
  );

  app.use("*", async (c, next) => {
    if (deps.globalLimit && !GLOBAL_LIMIT_EXEMPT.some((r) => r.test(c.req.path))) {
      if (!(await deps.globalLimit(clientIp(c)))) {
        return c.json({ error: "rate_limited", message: "Rate limit exceeded, retry in a minute" }, 429, { "retry-after": "60" });
      }
    }
    await next();
  });

  /**
   * CSRF: cookie-authenticated state-changing requests must originate from our
   * web app. (SameSite=Lax already blocks most cross-site POSTs; this is the
   * belt to that pair of braces.) API-key requests carry no cookie.
   */
  app.use("*", async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || CSRF_EXEMPT.some((r) => r.test(c.req.path)) || (!getCookie(c, SESSION_COOKIE) && !getCookie(c, SHARE_COOKIE))) {
      return next();
    }
    const origin = c.req.header("origin") ?? c.req.header("referer");
    const appOrigin = new URL(env().APP_URL).origin;
    let ok = false;
    try {
      ok = !!origin && new URL(origin).origin === appOrigin;
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: "csrf", message: "Cross-site request blocked" }, 403);
    await next();
  });

  app.onError(async (err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) },
        err.statusCode as ContentfulStatusCode,
        err.retryAfterSec ? { "retry-after": String(err.retryAfterSec) } : {},
      );
    }
    // A rule the person broke or a step they must take first (StaffError, EmailError, WhatsappError):
    // its message is written for them.
    if (err instanceof AppError) {
      return c.json({ error: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) }, err.status as ContentfulStatusCode);
    }
    if (err instanceof ReportRangeError) return c.json({ error: "invalid_range", message: err.message }, 400);
    if (err instanceof ZodError) {
      return c.json({ error: "validation", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    }
    // A query that died because Postgres went away is an outage, not a bug: answer "try again"
    // (503) as loadUser does. The driver's error can't say so reliably (see dbReachable), so ask
    // the database itself. While it answers, the error is ours and stays a 500.
    if (!(await (deps.dbHealthy ?? (() => dbReachable(2_000)))())) {
      logger.warn({ err, path: c.req.path }, "database unreachable");
      c.header("retry-after", "5");
      return c.json({ error: "db_unavailable", message: "We can't reach your data right now. Please try again in a moment." }, 503);
    }
    logger.error({ err, path: c.req.path }, "unhandled error");
    return c.json({ error: "internal", message: "Something went wrong" }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));

  app.get("/healthz", (c) => c.json({ ok: true }));
  /**
   * Which release answers at this address, so a deploy can be checked from outside (smoke.mjs):
   * the package's commit and build time, the environment, and the Lambda version serving it.
   * Nothing secret: no settings, hosts or account details.
   */
  app.get("/version", (c) => {
    const e = env();
    return c.json({
      app: "bizinsights",
      environment: e.APP_ENVIRONMENT || e.NODE_ENV,
      commit: e.APP_COMMIT || null,
      builtAt: e.APP_BUILT_AT || null,
      release: e.AWS_LAMBDA_FUNCTION_VERSION || null,
    });
  });
  /**
   * Ready to serve: both database connections (the system role, and `app_rls`, which every tenant
   * read uses) and the coordinator answer. Each probe is bounded, so a stalled tunnel makes this
   * say "not ready" in seconds instead of hanging, and a failed probe is logged with its reason.
   * The tenant connection must also be one row-level security binds: a superuser or a BYPASSRLS
   * role there would answer every query, for every workspace. In production so must the system
   * connection (docs/system-database-role.md), and it must own no table, since owners skip it too.
   */
  app.get("/readyz", async (c) => {
    const [system, tenant, coord] = await Promise.all([
      deps.dbHealthy
        ? deps.dbHealthy().then((up): ProbeResult => (up ? { ok: true } : { ok: false, error: "database health check failed" }))
        : probeDb(async () => {
            const [role] = await systemDb.$queryRaw<Array<{ bypasses: boolean }>>`
              SELECT (rolsuper OR rolbypassrls OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user)) AS bypasses
              FROM pg_roles WHERE rolname = current_user`;
            if (process.env.NODE_ENV === "production" && (!role || role.bypasses)) throw new Error("the system connection's role isn't bound by row-level security");
          }),
      probeDb(async () => {
        const [role] = await tenantDb.$queryRaw<Array<{ bypasses: boolean }>>`SELECT (rolsuper OR rolbypassrls) AS bypasses FROM pg_roles WHERE rolname = current_user`;
        if (!role || role.bypasses) throw new Error("the tenant connection's role bypasses row-level security");
      }),
      deps.coord.ping().then(
        (up): ProbeResult => (up ? { ok: true } : { ok: false, error: "coordinator did not answer" }),
        (error: unknown): ProbeResult => ({ ok: false, error }),
      ),
    ]);
    const checks = { db: system.ok, coord: coord.ok, tenantDb: tenant.ok };
    const ok = checks.db && checks.coord && checks.tenantDb;
    if (!ok) {
      const reason = (r: ProbeResult) => (r.ok ? undefined : r.error);
      logger.error({ checks, db: reason(system), tenantDb: reason(tenant), coord: reason(coord) }, "not ready");
    }
    return c.json({ ok, checks }, ok ? 200 : 503);
  });

  authRoutes(app, deps);
  accountRoutes(app, deps);
  sessionRoutes(app, deps);
  shopifyRoutes(app, deps);
  webhookRoutes(app, deps);
  mailEventRoutes(app, deps);
  pixelRoutes(app, deps);
  dashboardRoutes(app, deps);
  workspaceRoutes(app, deps);
  scopeRoutes(app, deps);
  contactRoutes(app, deps);
  adsRoutes(app, deps);
  adsGoogleDemoRoutes(app, deps);
  // Meta's deauthorize and data deletion callbacks: /webhooks/*, so CSRF- and global-limit-exempt above.
  metaWebhookRoutes(app, deps);
  whatsappRoutes(app, deps);
  whatsappWebhookRoutes(app, deps);
  staffRoutes(app, deps);
  staffAttendanceRoutes(app, deps);
  staffPayrollRoutes(app, deps);
  staffReportRoutes(app, deps);
  staffPortalRoutes(app, deps);
  emailAccountRoutes(app, deps);
  emailContentRoutes(app, deps);
  emailActivityRoutes(app, deps);
  emailPublicRoutes(app, deps);
  privacyRoutes(app, deps);
  teamRoutes(app, deps);
  exportRoutes(app, deps);
  inventoryRoutes(app, deps);
  smsRoutes(app, deps);
  smsPublicRoutes(app, deps);
  automationRoutes(app, deps);
  // Zapier (docs/zapier.md): the OAuth provider (consent, token) and Zapier's own API (/zapier/*, bearer tokens only).
  zapierOAuthRoutes(app, deps);
  zapierRoutes(app, deps);
  return app;
}
