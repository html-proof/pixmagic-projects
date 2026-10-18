import type { FetchLike } from "./shopify.js";

/**
 * How long an outbound call (Shopify, Meta, Google, email, Slack) may take before it is
 * abandoned. Long enough for Shopify's slowest GraphQL pages and a 2 MB bulk-result chunk; short
 * enough that one hung provider can't hold a whole queue batch (its messages run one after
 * another) until the function's time limit, which redelivers every message in it.
 */
export const OUTBOUND_TIMEOUT_MS = 30_000;

/**
 * `fetchImpl` with a time limit on every call that doesn't bring its own `signal`. A call that runs
 * out rejects with a `TimeoutError` (a DOMException), which the clients already treat like any
 * network failure: retried by the queue, or answered 502/503 by the API.
 */
export function withTimeout(fetchImpl: FetchLike, ms = OUTBOUND_TIMEOUT_MS): FetchLike {
  const timed = (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
    fetchImpl(input, init?.signal ? init : { ...init, signal: AbortSignal.timeout(ms) });
  return timed as FetchLike;
}
