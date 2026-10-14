import { describe, expect, it } from "vitest";
import { withTimeout, type FetchLike } from "../src/index.js";

/** A fetch that answers after `ms`, or rejects as soon as its signal aborts (as fetch does). */
function slowFetch(ms: number) {
  const seen: Array<AbortSignal | undefined> = [];
  const impl = ((_input: unknown, init?: RequestInit) => {
    seen.push(init?.signal ?? undefined);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("ok")), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    });
  }) as FetchLike;
  return { impl, seen };
}

describe("withTimeout", () => {
  it("abandons a call that takes longer than the limit, with a TimeoutError", async () => {
    const { impl } = slowFetch(5_000);
    const started = Date.now();
    await expect(withTimeout(impl, 50)("https://example.test/")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("lets a call that answers in time through, with its own options", async () => {
    const { impl, seen } = slowFetch(1);
    const res = await withTimeout(impl, 1_000)("https://example.test/", { method: "POST", body: "x" });
    expect(await res.text()).toBe("ok");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("leaves a caller's own signal alone", async () => {
    const { impl, seen } = slowFetch(1);
    const own = new AbortController();
    await withTimeout(impl, 1_000)("https://example.test/", { signal: own.signal });
    expect(seen[0]).toBe(own.signal);
  });
});
