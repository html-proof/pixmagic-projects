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

/**
 * `fetchImpl` with one deadline (epoch ms) shared by every call made through it: each call gets what's
 * left of it (at most OUTBOUND_TIMEOUT_MS), and none starts after it. For work that must end within a
 * request's time limit, however many calls it takes. A call cut off by the deadline rejects with
 * `outOfTime()` (by default a `TimeoutError`, as withTimeout's); the call's own signal still applies.
 */
export function fetchUntil(fetchImpl: FetchLike | undefined, deadline: number, outOfTime: () => Error = () => new DOMException("The deadline passed", "TimeoutError")): FetchLike {
  const f = fetchImpl ?? fetch;
  const timed = async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const left = deadline - Date.now();
    if (left <= 0) throw outOfTime();
    const own = AbortSignal.timeout(Math.min(left, OUTBOUND_TIMEOUT_MS));
    try {
      return await f(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, own]) : own });
    } catch (err) {
      if (own.aborted) throw outOfTime();
      throw err;
    }
  };
  return timed as FetchLike;
}
