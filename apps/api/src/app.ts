import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { systemDb } from "@app/db";
import { env, logger } from "@app/core";
import { clientIp, HttpError, SESSION_COOKIE, type AppEnv, type Deps } from "./context.js";
import { authRoutes } from "./routes/auth.js";
import { shopifyRoutes } from "./routes/shopify.js";
import { shopifySignupRoutes } from "./routes/shopifySignup.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { pixelRoutes } from "./routes/pixel.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { scopeRoutes } from "./routes/scopes.js";
import { contactRoutes } from "./routes/contacts.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_EXEMPT = [/^\/webhooks\//, /^\/pixel\//];
const MB = 1024 * 1024;

export type App = Hono<AppEnv>;

export function buildApp(deps: Deps): App {
  const app = new Hono<AppEnv>();

  // Webhooks carry up to 5 MB; everything else is small JSON.
  app.use("*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path.startsWith("/webhooks/") ? 5 * MB : MB,
      onError: (c) => c.json({ error: "request", message: "Request body too large" }, 413),
    })(c, next),
  );

  app.use("*", async (c, next) => {
    if (deps.globalLimit && c.req.path !== "/healthz" && c.req.path !== "/readyz") {
      if (!(await deps.globalLimit(clientIp(c)))) {
        return c.json({ error: "rate_limited", message: "Rate limit exceeded, retry in a minute" }, 429);
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
    if (SAFE_METHODS.has(c.req.method) || CSRF_EXEMPT.some((r) => r.test(c.req.path)) || !getCookie(c, SESSION_COOKIE)) {
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

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.statusCode as ContentfulStatusCode);
    if (err instanceof ZodError) {
      return c.json({ error: "validation", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    }
    logger.error({ err, path: c.req.path }, "unhandled error");
    return c.json({ error: "internal", message: "Something went wrong" }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    const checks = { db: false, coord: false };
    try {
      await systemDb.$queryRaw`SELECT 1`;
      checks.db = true;
    } catch {
      /* not ready */
    }
    try {
      checks.coord = await deps.coord.ping();
    } catch {
      /* not ready */
    }
    const ok = checks.db && checks.coord;
    return c.json({ ok, checks }, ok ? 200 : 503);
  });

  authRoutes(app, deps);
  shopifyRoutes(app, deps);
  shopifySignupRoutes(app, deps);
  webhookRoutes(app, deps);
  pixelRoutes(app, deps);
  dashboardRoutes(app, deps);
  workspaceRoutes(app, deps);
  scopeRoutes(app, deps);
  contactRoutes(app, deps);
  return app;
}
