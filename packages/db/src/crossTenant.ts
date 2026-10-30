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

  // --- API requests outside /workspaces/:ws (apps/api/src/rowScope.ts lists the paths).
  sign_in: "Sign-in, sign-up, account and session routes: the person's own workspaces and memberships, before any one workspace is chosen.",
  invitations: "Opening and accepting an invitation, and the staff portal's own list: the inviting workspace is found from the invitation or the employee.",
  shopify_install: "Shopify's install, claim and launch: finds or makes the store's workspace from the shop.",
  webhooks: "Webhooks and public callbacks (Shopify, Meta, WhatsApp, email and SMS providers, unsubscribe links, the pixel): the workspace is found from what the provider sent.",
  integrations_oauth: "OAuth callbacks of ad, email and Zapier connections, and Zapier's API: the workspace is found from the signed state or the token.",
} as const;

export type CrossTenantReason = keyof typeof CROSS_TENANT_REASONS;
