import type { Permission } from "@app/shared";
import { HttpError, requireWorkspace, type Ctx, type Deps } from "./context.js";

/**
 * Access to a workspace's email integrations: a signed-in member with the permission. Workspace API
 * keys (read-only metrics keys) never reach email settings, credentials, recipients or templates:
 * the only key the email module accepts is an event key, on POST /v1/events.
 *
 * The workspace in the path only selects; membership is checked on every request, and a
 * non-member gets 404 like everywhere else.
 */
export async function requireEmail(c: Ctx, deps: Deps, ws: string, perm: Permission) {
  if (c.req.header("authorization")) throw new HttpError(403, "Email settings can't be used with an API key", "forbidden");
  const access = await requireWorkspace(c, deps, ws, perm);
  return { ...access, user: access.user! };
}

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 400;

/** `?from=&to=` (YYYY-MM-DD or ISO, `to` exclusive for instants, inclusive for days); the last 30 days by default. */
export function rangeQuery(q: { from?: string; to?: string }): { from: Date; to: Date } {
  const parse = (v: string | undefined, endOfDay: boolean) => {
    if (!v) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(`${v}T00:00:00.000Z`);
      return Number.isNaN(d.getTime()) ? "bad" : new Date(d.getTime() + (endOfDay ? DAY_MS : 0));
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "bad" : d;
  };
  const to = parse(q.to, true);
  const from = parse(q.from, false);
  if (to === "bad" || from === "bad") throw new HttpError(400, "from and to must be dates (YYYY-MM-DD) or timestamps", "invalid_range");
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - 30 * DAY_MS);
  if (start >= end) throw new HttpError(400, "from must be before to", "invalid_range");
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new HttpError(400, `A range can be at most ${MAX_RANGE_DAYS} days`, "invalid_range");
  return { from: start, to: end };
}
