/**
 * Evolution API (https://github.com/evolution-foundation/evolution-api), the self-hosted service that
 * held phones linked with a QR code until 2026-10-28. Nothing creates, pairs or sends through it any
 * more: this client is kept only to retire what is left of it (retireQr.ts: log out, delete, list)
 * and for the deploy's check that the service still answers, until release 2 removes the service
 * (docs/whatsapp.md, "Removing Evolution"). Pinned to release 2.3.7; every path, field and answer
 * below was read from that release's source.
 *
 *  - Auth: the `apikey` header; the global key (EVOLUTION_API_KEY) opens every instance.
 *  - Errors: a non-2xx answer is `{ status, error, response: { message } }`.
 *  - Every call has a timeout (EVOLUTION_TIMEOUT_MS); reads are retried twice on a network error or a 5xx.
 *
 * Nothing here logs a key or a number.
 */
import { z } from "zod";
import { env } from "../env.js";
import { providerDetail } from "../errors.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";

export type EvolutionErrorKind = "unreachable" | "timeout" | "unauthorized" | "not_found" | "bad_request" | "server" | "invalid_response" | "not_configured";

export class EvolutionError extends Error {
  constructor(
    public readonly kind: EvolutionErrorKind,
    /** The HTTP status (0 when no answer came). */
    public readonly status: number,
    /** Evolution's own words, cleaned (providerDetail): for the logs. */
    public readonly detail: string,
  ) {
    super(`Evolution API ${kind} (${status}): ${detail}`);
    this.name = "EvolutionError";
  }
}

export interface EvolutionServer {
  shard: string;
  url: string;
  apiKey: string;
  timeoutMs: number;
}

/** Whether bizinsights' Evolution API service is still set up on this server. */
export const evolutionConfigured = () => !!env().EVOLUTION_API_URL && !!env().EVOLUTION_API_KEY;

/** The shard the service's instances are on (one: "a"). */
export const defaultShard = () => env().EVOLUTION_SHARD;

/**
 * Whether a shard's server answers, and its version (its root answers with it): the deploy's check,
 * asked from inside the VPC by the cron's "config" action. Never throws.
 */
export async function evolutionStatus(shard: string, fetchImpl: FetchLike): Promise<{ reachable: boolean; version: string | null }> {
  try {
    const s = evolutionServer(shard);
    const r = await fetchImpl(`${s.url}/`, { headers: { apikey: s.apiKey }, signal: AbortSignal.timeout(5_000) });
    const body = (await r.json().catch(() => null)) as { version?: unknown } | null;
    return { reachable: r.ok, version: typeof body?.version === "string" ? body.version.slice(0, 20) : null };
  } catch {
    return { reachable: false, version: null };
  }
}

/** The server that holds a shard's instances (EVOLUTION_SHARD at EVOLUTION_API_URL). */
export function evolutionServer(shard: string): EvolutionServer {
  const e = env();
  if (!evolutionConfigured()) throw new EvolutionError("not_configured", 0, "Evolution API isn't set up on this server");
  if (shard !== e.EVOLUTION_SHARD) throw new EvolutionError("not_configured", 0, `No Evolution API server for shard ${shard}`);
  return { shard, url: e.EVOLUTION_API_URL.replace(/\/+$/, ""), apiKey: e.EVOLUTION_API_KEY, timeoutMs: e.EVOLUTION_TIMEOUT_MS };
}

const instanceInfoSchema = z
  .object({
    name: z.string(),
    id: z.string().optional(),
    connectionStatus: z.string().nullable().optional(),
    integration: z.string().nullable().optional(),
  })
  .passthrough();

const errorSchema = z.object({ status: z.number().optional(), error: z.string().optional(), response: z.object({ message: z.unknown() }).passthrough().optional() }).passthrough();

export type EvolutionInstance = z.output<typeof instanceInfoSchema>;

/** Evolution's error message (a string, or an array of strings or objects), cleaned. */
function messageOf(body: unknown): string {
  const parsed = errorSchema.safeParse(body);
  const m = parsed.success ? parsed.data.response?.message : (body as { message?: unknown } | null)?.message;
  const text = Array.isArray(m) ? m.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ") : typeof m === "string" ? m : parsed.success ? (parsed.data.error ?? "") : "";
  return providerDetail(text);
}

interface CallOptions {
  method: "GET" | "DELETE";
  path: string;
  key: string;
  query?: Record<string, string>;
  /** Retry network errors and 5xx (reads only). */
  retry?: boolean;
}

/**
 * The client for one shard's server. `fetchImpl` is the app's (with its own timeout on AWS), and
 * this adds an abort of its own so no call outlives EVOLUTION_TIMEOUT_MS.
 */
export function evolutionClient(shard: string, fetchImpl: FetchLike) {
  const server = evolutionServer(shard);

  async function call(o: CallOptions): Promise<unknown> {
    const qs = o.query && Object.keys(o.query).length ? `?${new URLSearchParams(o.query).toString()}` : "";
    const url = `${server.url}${o.path}${qs}`;
    const attempts = o.retry ? 3 : 1;
    let last: EvolutionError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), server.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, { method: o.method, headers: { apikey: o.key, accept: "application/json" }, signal: ac.signal });
      } catch (err) {
        clearTimeout(timer);
        const aborted = ac.signal.aborted || (err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError";
        last = aborted ? new EvolutionError("timeout", 0, "Evolution API didn't answer in time") : new EvolutionError("unreachable", 0, "Evolution API couldn't be reached");
        logger.warn({ shard, path: o.path.replace(/\/[^/]+$/, "/:instance"), attempt, kind: last.kind }, "evolution call failed");
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok) return body;
      const detail = messageOf(body) || `HTTP ${res.status}`;
      const kind: EvolutionErrorKind = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_found" : res.status >= 500 ? "server" : "bad_request";
      last = new EvolutionError(kind, res.status, detail);
      if (kind !== "server" || attempt >= attempts) throw last;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    throw last ?? new EvolutionError("unreachable", 0, "Evolution API couldn't be reached");
  }

  function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.output<S> {
    const r = schema.safeParse(body);
    if (r.success) return r.data;
    logger.warn({ shard, answer: what, problems: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) }, "evolution answer doesn't fit its schema");
    throw new EvolutionError("invalid_response", 200, `Unexpected answer to ${what}`);
  }

  return {
    shard,

    /** DELETE /instance/logout/{instance}: ends the WhatsApp session (the phone's linked device goes). Not connected already: fine. */
    async logout(instanceName: string, key: string) {
      try {
        await call({ method: "DELETE", path: `/instance/logout/${encodeURIComponent(instanceName)}`, key });
      } catch (e) {
        if (e instanceof EvolutionError && (e.kind === "not_found" || (e.kind === "bad_request" && /not connected/i.test(e.detail)))) return;
        throw e;
      }
    },

    /** DELETE /instance/delete/{instance}: the instance and its saved session go. Already gone: fine. */
    async deleteInstance(instanceName: string, key: string) {
      try {
        await call({ method: "DELETE", path: `/instance/delete/${encodeURIComponent(instanceName)}`, key });
      } catch (e) {
        if (e instanceof EvolutionError && e.kind === "not_found") return;
        throw e;
      }
    },

    /** GET /instance/fetchInstances (global key): every instance on this server. */
    async fetchInstances(): Promise<EvolutionInstance[]> {
      const body = await call({ method: "GET", path: "/instance/fetchInstances", key: server.apiKey, retry: true });
      return parse(z.array(instanceInfoSchema), body ?? [], "fetch instances");
    },
  };
}

export type EvolutionClient = ReturnType<typeof evolutionClient>;
