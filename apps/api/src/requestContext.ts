import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { logger, withLogContext } from "@app/core";
import { HttpError, type AppEnv } from "./context.js";

/** Paths that are polled by monitors: logged only when they fail, so they don't drown the rest. */
const QUIET = new Set(["/healthz", "/readyz"]);

/**
 * The request's id, and one log line per request.
 *
 * The id is a random UUID, returned as `x-request-id` on every response (so a log line can be
 * matched with what a merchant reports) and added to every log line written while the
 * request is handled, through the logger's context, so a failure's lines can be found together.
 *
 * The access line records the route *pattern* (`/workspaces/:ws/stores/:storeId/overview`), never
 * the concrete path: paths can carry tokens (tracking links, pixel keys, review links).
 */
export function requestContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    await withLogContext({ requestId }, async () => {
      await next();
      const status = c.res.status;
      const line = { method: c.req.method, route: routePath(c, -1), status, ms: Date.now() - started };
      // onError has already logged anything unexpected; an HttpError it answered with a 5xx is our
      // failure too (a provider or the database said no), and is otherwise never logged.
      if (status >= 500 && c.error instanceof HttpError) logger.error({ ...line, err: c.error }, "request failed");
      else if (status >= 500) logger.warn(line, "request failed");
      else if (!QUIET.has(c.req.path)) logger.info(line, "request");
    });
    c.res.headers.set("x-request-id", requestId);
  };
}
