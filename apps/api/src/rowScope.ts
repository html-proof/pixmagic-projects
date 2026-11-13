import type { MiddlewareHandler } from "hono";
import { crossTenant, forTenant, withoutTenant, type CrossTenantReason } from "@app/db";

/**
 * Whose rows `systemDb` sees while serving a request (docs/system-database-role.md).
 *
 * A path that names its workspace (/workspaces/:ws, the staff portal's /employee/:ws) sees that
 * workspace only. This doesn't decide who may use it (requireWorkspace and requireStaff still do);
 * it bounds what a forgotten where-clause could reach, whoever is asking.
 *
 * The other paths are listed below, each with its reason for reading across workspaces (the list in
 * @app/db crossTenant.ts), or none at all. A path in no list runs unscoped and is logged
 * (core rowScope.ts); test/rowScope.test.ts fails for a route that is in no list.
 */
type PathScope = { reason: CrossTenantReason } | "none";

const PATHS: Array<[RegExp, PathScope]> = [
  // Answers that read no workspace's rows.
  [/^\/(healthz|readyz|version)$/, "none"],
  // Before a workspace is chosen: signing in and up, the account, and the person's own workspaces.
  [/^\/(auth|me)(\/|$)/, { reason: "sign_in" }],
  [/^\/workspaces\/?$/, { reason: "sign_in" }],
  [/^\/(invitations|staff\/invitations)\//, { reason: "invitations" }],
  [/^\/employee\/workspaces$/, { reason: "invitations" }],
  [/^\/shopify\//, { reason: "shopify_install" }],
  // Providers and the links customers follow: the workspace comes from what they carry.
  [/^\/(webhooks|pixel)(\/|$)/, { reason: "webhooks" }],
  [/^\/(meta\/data-deletion|staff\/exports)\//, { reason: "webhooks" }],
  // Returns from signing in to a provider, and Zapier's API (by its token).
  [/^\/ads\/[^/]+\/(callback|oauth-callback)$/, { reason: "integrations_oauth" }],
  [/^\/(oauth|zapier)\//, { reason: "integrations_oauth" }],
  // A connect link's page (routes/adLinks.ts): the store comes from the link.
  [/^\/ads\/links\//, { reason: "integrations_oauth" }],
];

const WORKSPACE = /^\/(?:workspaces|employee)\/([^/]+)(?:\/|$)/;

/** The row scope for a request path: one workspace, a listed reason, none, or null (unlisted). */
export function pathScope(path: string): { workspaceId: string } | PathScope | null {
  for (const [pattern, scope] of PATHS) if (pattern.test(path)) return scope;
  // As it is in the path: workspace ids are plain letters and digits, and one that isn't matches nothing.
  const ws = WORKSPACE.exec(path)?.[1];
  return ws ? { workspaceId: ws } : null;
}

export function rowScope(): MiddlewareHandler {
  return async (c, next) => {
    const scope = pathScope(c.req.path);
    if (scope === null) return next();
    if (scope === "none") return withoutTenant(next);
    if ("workspaceId" in scope) return forTenant(scope.workspaceId, next);
    return crossTenant(scope.reason, next);
  };
}
