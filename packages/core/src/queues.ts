/**
 * Job contracts for the background queues. Producers are thin wrappers over
 * SQS on AWS (apps/aws/src/sqsQueues.ts) and in-process queues locally
 * (localQueues.ts); tests use memoryQueues(). Delivery is at-least-once, so
 * every consumer is idempotent.
 */
export const QUEUE = {
  sync: "sync",
  webhooks: "webhooks",
  aggregate: "aggregate",
  email: "email",
  /** WhatsApp Automation (core/whatsapp): sends, Evolution API's webhook events, campaign batches. */
  whatsapp: "whatsapp",
} as const;
export type QueueName = keyof typeof QUEUE;

/** Attempts before a job is marked failed (first delivery + retries). The SQS queues' maxReceiveCount stays above it (infra/cdk). */
export const MAX_ATTEMPTS = 6;
/** Exponential backoff: 5s, 10s, 20s, ... capped at 15 minutes. */
export const backoffSeconds = (attempt: number) => Math.min(900, 5 * 2 ** Math.max(0, attempt - 1));

/** `inventory`: every location and stock level of the store, read from Shopify (core/inventory). */
export type SyncKind = "shop" | "products" | "variants" | "orders" | "install_pixel" | "inventory";

/** How an inventory pass came about, which is also what it records its differences as. */
export type InventoryTrigger = "import" | "manual" | "reconcile";

export interface SyncJobData {
  storeId: string;
  kind: SyncKind;
  syncJobId: string;
  sinceDays?: number;
  /** Pagination continuation: each message processes one page, then re-enqueues itself. */
  cursor?: string | null;
  progress?: number;
  /**
   * Page size for paginated kinds. Shopify rejects queries whose *requested* cost exceeds
   * 1000 points (MAX_COST_EXCEEDED); the worker halves this and retries when that happens.
   */
  pageSize?: number;
  /**
   * Where a bulk order backfill has got to. Absent means the paged path, which is what
   * reconcile/refresh jobs always use.
   *
   * The whole backfill stays one `sync_jobs` row of kind "orders" whatever path it takes:
   * the onboarding screen groups jobs by kind against a fixed list, so a new kind would show
   * up there as an unlabelled row that never settles.
   */
  bulk?: {
    phase: "start" | "poll" | "ingest";
    /** BulkOperation gid, known from "poll" onward. */
    id?: string;
    /** Byte offset into the JSONL result. Always at the start of a parent (order) line. */
    byteOffset?: number;
    /** Lines already applied, for a server that ignores Range and forces a re-read. */
    linesDone?: number;
    /** Poll attempts so far, for the backoff and the give-up cap. */
    polls?: number;
    /** Times "start" found another job holding the store's export lock and re-sent itself, for the give-up cap. */
    lockWaits?: number;
  };
  /**
   * Set once bulk has failed for this job, so the fallback to the paged path cannot bounce
   * back into bulk and loop.
   */
  pagedOnly?: boolean;
  /**
   * On a full orders import with read_all_orders: the year of the history plan this message reads
   * (order_history_windows, packages/core/src/orderHistory.ts). Absent on the import's first message,
   * which plans the years, and on every other orders job.
   */
  history?: { windowId: string };
  /**
   * On a "shop" job: the jobs seeded with it that wait for the store's time zone, which it
   * starts once it has learned it. Absent on messages sent before the ids were carried.
   */
  waitingJobIds?: string[];
  /**
   * Where an inventory pass has got to: the locations first (paged by `cursor`), then each
   * location's stock levels in turn (`index` into `locations`, paged by `cursor`). `runId` is its
   * inventory_sync_runs row, which counts what it read and what differed.
   */
  inventory?: {
    trigger: InventoryTrigger;
    runId?: string;
    phase: "locations" | "levels";
    /** Location ids to read levels at, in order. */
    locations?: string[];
    index?: number;
    /** ISO time the pass started: levels at a location it didn't see since then are gone. */
    startedAt: string;
  };
}

export interface WebhookJobData {
  eventId: string;
  topic: string;
  shop: string;
  /** Which of our Shopify apps sent it (the one whose secret signed it). */
  app?: string;
  /**
   * When Shopify generated the delivery (`x-shopify-triggered-at`), ISO 8601. Shopify retries a
   * failed delivery for up to 48 hours, so a delivery can arrive after the state it describes has
   * been superseded; handlers that overwrite install state compare against this instead of "now".
   */
  triggeredAt?: string;
  /** Inline payload when small enough for a queue message... */
  payload?: unknown;
  /** ...otherwise the key of the payload in the PAYLOADS R2 bucket. */
  payloadKey?: string;
}

export interface AggregateJobData {
  storeId: string;
  days: string[];
}

/**
 * The app's own invitation emails (core/mail): another attempt at one that hit a transient failure.
 * The delivery's row carries the state; a message only says which one to look at.
 */
export type EmailJob = { kind: "team_invitation"; deliveryId: string };

/**
 * WhatsApp Automation (core/whatsapp): send one message, apply one stored webhook event from
 * Evolution API, or make the next batch of a campaign's messages. The rows carry the state.
 */
export type WhatsappJob = { kind: "wapp_send"; messageId: string } | { kind: "wapp_event"; eventId: string } | { kind: "wapp_campaign"; campaignId: string };

export interface Producer<T> {
  send(body: T, opts?: { delaySeconds?: number }): Promise<void>;
}

export interface Queues {
  sync: Producer<SyncJobData>;
  webhooks: Producer<WebhookJobData>;
  aggregate: Producer<AggregateJobData>;
  email: Producer<EmailJob>;
  whatsapp: Producer<WhatsappJob>;
}

/** Large payload storage (R2 in production). */
export interface BlobStore {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** Bodies above this go to the BlobStore instead of the queue message (well under SQS's message size limit). */
export const INLINE_PAYLOAD_LIMIT = 100 * 1024;

export type SendOptions = { delaySeconds?: number };

/**
 * `sent` holds the message bodies (what almost every assertion wants); `sentOpts` holds the
 * send options at the same indexes. They are separate because the options used to be dropped
 * on the floor here, which made the sync chains' cost-budget `delaySeconds` - the thing that
 * decides how fast a backfill runs - invisible to every test in the suite.
 */
export type MemoryQueues = Queues & {
  sent: { [K in QueueName]: Array<Parameters<Queues[K]["send"]>[0]> };
  sentOpts: { [K in QueueName]: Array<SendOptions | undefined> };
  clear(): void;
};

export function memoryQueues(): MemoryQueues {
  const sent = { sync: [] as SyncJobData[], webhooks: [] as WebhookJobData[], aggregate: [] as AggregateJobData[], email: [] as EmailJob[], whatsapp: [] as WhatsappJob[] };
  const sentOpts = {
    sync: [] as Array<SendOptions | undefined>,
    webhooks: [] as Array<SendOptions | undefined>,
    aggregate: [] as Array<SendOptions | undefined>,
    email: [] as Array<SendOptions | undefined>,
    whatsapp: [] as Array<SendOptions | undefined>,
  };
  const producer = <T>(list: T[], opts: Array<SendOptions | undefined>): Producer<T> => ({
    async send(body, o) {
      list.push(structuredClone(body));
      opts.push(o ? { ...o } : undefined);
    },
  });
  return {
    sent,
    sentOpts,
    sync: producer(sent.sync, sentOpts.sync),
    webhooks: producer(sent.webhooks, sentOpts.webhooks),
    aggregate: producer(sent.aggregate, sentOpts.aggregate),
    email: producer(sent.email, sentOpts.email),
    whatsapp: producer(sent.whatsapp, sentOpts.whatsapp),
    clear() {
      for (const k of ["sync", "webhooks", "aggregate", "email", "whatsapp"] as const) {
        sent[k].length = 0;
        sentOpts[k].length = 0;
      }
    },
  };
}

export function memoryBlobs(): BlobStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async put(k, v) {
      data.set(k, v);
    },
    async get(k) {
      return data.get(k) ?? null;
    },
    async delete(k) {
      data.delete(k);
    },
  };
}
