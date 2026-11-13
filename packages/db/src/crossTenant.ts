/**
 * Every reason the system paths have to see more than one workspace's rows (`crossTenant`,
 * docs/system-database-role.md). This list is the review: a new way of reading across workspaces
 * starts as a new entry here, which is the line a reviewer reads. Narrowing an entry point to
 * `forTenant` (once it knows its workspace) takes its reason off the list.
 */
export const CROSS_TENANT_REASONS = {
  // --- Cron and maintenance.
  sweep: "The cron's scheduled sweeps (runScheduled): work due across every store, such as sends, token refreshes, checks and retention.",
  maintenance: "The cron function's maintenance actions (after-move, reread, verify, shopify-check, product-check): run by the owner or the deploy across stores.",

  // --- Jobs whose workspace isn't found from the job itself (worker/src/scope.ts says which).
  job: "A queued job whose own row names no workspace yet, or names none any more: it finds its store or account itself.",

  // --- Inside a workspace's own scope.
  already_connected:
    "Whether a WhatsApp number is connected to a store of another workspace (a number is unique across bizinsights): only yes or no comes back.",
  workspace_deleted:
    "Deleting a workspace (packages/core/src/workspaceDeletion.ts): the record of the deletion, written with no workspace once the workspace is gone so it outlives it (one insert into audit_logs).",
  ad_grants:
    "A person's own Google or Meta grant, which may power connections in several workspaces: whether it still powers one before bizinsights takes it back at the platform (taking it back ends every connection on it), who granted the connections that never learned it, the refresh token they gave before, reused on their next sign-in (adConnections/connect.ts), and their own Meta sign-in for another of their stores, used for a new store without Meta's screen (adConnections/reuse.ts).",

  // --- API requests outside /workspaces/:ws (apps/api/src/rowScope.ts lists the paths).
  sign_in: "Sign-in, sign-up, account and session routes: the person's own workspaces and memberships, before any one workspace is chosen.",
  invitations: "Opening and accepting an invitation, and the staff portal's own list: the inviting workspace is found from the invitation or the employee.",
  shopify_install:
    "Shopify's install, claim and launch, and connecting a store from any workspace: finds or makes the store's workspace from the shop, says whether the shop is live in another one, and moves a store nobody claimed (apps/api/src/connectStore.ts).",
  webhooks: "Webhooks and public callbacks (Shopify, Meta, WhatsApp, the app's mail provider, the pixel): the workspace is found from what the provider sent.",
  integrations_oauth: "OAuth callbacks of ad and Zapier connections, ad connect links, and Zapier's API: the workspace is found from the signed state, the link or the token.",
} as const;

export type CrossTenantReason = keyof typeof CROSS_TENANT_REASONS;
