import type { EmailJob, QueueName, WhatsappJob } from "@app/core";
import { crossTenant, forTenant, systemDb } from "@app/db";

/**
 * Run one queued job with `systemDb` seeing only its own workspace's rows (docs/system-database-role.md).
 *
 * Jobs carry ids, not workspaces (core queues.ts), so the workspace is read from the row the job is
 * about: its store, ad connection, message, delivery or event. A job whose row names none (a Shopify
 * webhook for a shop with no store, WhatsApp's raw events) finds its own store,
 * so it runs across workspaces: the `job` reason (@app/db crossTenant.ts).
 *
 * A failed lookup never fails the job: the database being down is consume()'s to notice (it
 * defers the job rather than spending its retries), so the job then runs across workspaces too.
 */
export async function inJobScope<T>(queue: QueueName, body: unknown, run: () => Promise<T>): Promise<T> {
  const workspaceId = await crossTenant("job", () => jobWorkspace(queue, body)).catch(() => null);
  return workspaceId ? forTenant(workspaceId, run) : crossTenant("job", run);
}

/** The workspace a job is for, from its own row; null when nothing it carries names one. */
export async function jobWorkspace(queue: QueueName, body: unknown): Promise<string | null> {
  const job = (body ?? {}) as { kind?: string } & Record<string, unknown>;
  const id = (key: string) => (typeof job[key] === "string" && job[key] ? (job[key] as string) : null);
  const of = (row: { workspaceId: string | null } | null) => row?.workspaceId ?? null;
  const select = { workspaceId: true } as const;

  if (queue === "sync") {
    if (job.kind === "ads") return lookup(id("connectionId"), (where) => systemDb.adConnection.findUnique({ where, select }).then(of));
    if (job.kind === "zapier") return lookup(id("deliveryId"), (where) => systemDb.zapierDelivery.findUnique({ where, select }).then(of));
    // Store syncs, the check against Shopify, Shopify's report figures: each names its store.
    return lookup(id("storeId"), (where) => systemDb.store.findUnique({ where, select }).then(of));
  }
  if (queue === "aggregate") return lookup(id("storeId"), (where) => systemDb.store.findUnique({ where, select }).then(of));
  if (queue === "webhooks") return lookup(id("eventId"), (where) => systemDb.webhookEvent.findUnique({ where, select }).then(of));
  if (queue === "email") {
    const kind = job.kind as EmailJob["kind"] | undefined;
    if (kind === "team_invitation") return lookup(id("deliveryId"), (where) => systemDb.emailDelivery.findUnique({ where, select }).then(of));
    return null;
  }
  if (queue === "whatsapp") {
    const kind = job.kind as WhatsappJob["kind"] | undefined;
    if (kind === "wapp_send") return lookup(id("messageId"), (where) => systemDb.wappMessage.findUnique({ where, select }).then(of));
    if (kind === "wapp_campaign") return lookup(id("campaignId"), (where) => systemDb.wappCampaign.findUnique({ where, select }).then(of));
    return null;
  }
  return null;
}

function lookup(id: string | null, find: (where: { id: string }) => Promise<string | null>): Promise<string | null> {
  return id ? find({ id }) : Promise.resolve(null);
}
