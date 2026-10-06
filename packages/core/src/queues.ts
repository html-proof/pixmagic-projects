/**
 * Job contracts for Cloudflare Queues. Producers are thin wrappers over Queue
 * bindings (apps/cloudflare); tests use memoryQueues(). Delivery is
 * at-least-once, so every consumer is idempotent.
 */
export const QUEUE = {
  sync: "sync",
  webhooks: "webhooks",
  aggregate: "aggregate",
} as const;
export type QueueName = keyof typeof QUEUE;

/** Attempts before a job is marked failed (first delivery + retries). Keep in sync with wrangler max_retries + 1. */
export const MAX_ATTEMPTS = 6;
/** Exponential backoff: 5s, 10s, 20s, ... capped at 15 minutes. */
export const backoffSeconds = (attempt: number) => Math.min(900, 5 * 2 ** Math.max(0, attempt - 1));

export type SyncKind = "shop" | "products" | "variants" | "orders" | "install_pixel";

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
   * On a "shop" job: the jobs seeded with it that wait for the store's time zone, which it
   * starts once it has learned it. Absent on messages sent before the ids were carried.
   */
  waitingJobIds?: string[];
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

export interface Producer<T> {
  send(body: T, opts?: { delaySeconds?: number }): Promise<void>;
}

export interface Queues {
  sync: Producer<SyncJobData>;
  webhooks: Producer<WebhookJobData>;
  aggregate: Producer<AggregateJobData>;
}

/** Large payload storage (R2 in production). */
export interface BlobStore {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** Cloudflare Queues messages are limited to 128 KB; leave headroom for the envelope. */
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
  const sent = { sync: [] as SyncJobData[], webhooks: [] as WebhookJobData[], aggregate: [] as AggregateJobData[] };
  const sentOpts = { sync: [] as Array<SendOptions | undefined>, webhooks: [] as Array<SendOptions | undefined>, aggregate: [] as Array<SendOptions | undefined> };
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
    clear() {
      for (const k of ["sync", "webhooks", "aggregate"] as const) {
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
