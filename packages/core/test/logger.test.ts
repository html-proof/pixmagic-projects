import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLogContext, logger, redactForLog, withLogContext } from "../src/index.js";

/** What the logger wrote, parsed: every console channel, in order. */
function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const take = (s: unknown) => lines.push(JSON.parse(String(s)) as Record<string, unknown>);
  const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(take));
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

let prevLevel: string | undefined;
let out: ReturnType<typeof capture>;
beforeEach(() => {
  prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  out = capture();
});
afterEach(() => {
  out.restore();
  process.env.LOG_LEVEL = prevLevel;
});

describe("log context", () => {
  it("adds the context's fields to every line written inside it, and only there", async () => {
    logger.info("before");
    await withLogContext({ requestId: "r-1" }, async () => {
      logger.info({ a: 1 }, "inside");
      await Promise.resolve();
      logger.warn("after an await");
    });
    logger.info("after");
    expect(out.lines.map((l) => l.requestId)).toEqual([undefined, "r-1", "r-1", undefined]);
  });

  it("nests, and addLogContext adds to the current context", () => {
    withLogContext({ requestId: "r-2" }, () => {
      addLogContext({ userId: "u-1" });
      withLogContext({ queue: "sync" }, () => logger.info("nested"));
      logger.info("outer");
    });
    expect(out.lines[0]).toMatchObject({ requestId: "r-2", userId: "u-1", queue: "sync" });
    expect(out.lines[1]).toMatchObject({ requestId: "r-2", userId: "u-1" });
    expect(out.lines[1]).not.toHaveProperty("queue");
  });

  it("addLogContext outside any context does nothing", () => {
    addLogContext({ userId: "u-2" });
    logger.info("plain");
    expect(out.lines[0]).not.toHaveProperty("userId");
  });

  it("concurrent contexts don't see each other's fields", async () => {
    const run = (id: string, wait: number) =>
      withLogContext({ requestId: id }, async () => {
        await new Promise((r) => setTimeout(r, wait));
        logger.info(id);
      });
    await Promise.all([run("slow", 20), run("fast", 1)]);
    for (const l of out.lines) expect(l.requestId).toBe(l.msg);
  });
});

describe("log lines", () => {
  it("never let a field replace the entry's level or message", () => {
    logger.error({ msg: "the provider's text", level: "info" }, "email sign-in link could not be checked");
    expect(out.lines[0]).toMatchObject({ level: "error", msg: "email sign-in link could not be checked", detail: "the provider's text" });
  });

  it("keep an error's cause and its code, which a `code` key would lose to redaction", () => {
    const root = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
    const err = Object.assign(new Error("Can't reach the database", { cause: root }), { code: "P1001", status: 503 });
    expect(redactForLog(err)).toMatchObject({
      name: "Error",
      message: "Can't reach the database",
      errorCode: "P1001",
      status: 503,
      cause: { message: "connect ECONNREFUSED 10.0.0.1:5432", errorCode: "ECONNREFUSED" },
    });
  });

  it("truncate very deep objects instead of writing them unredacted", () => {
    let deep: Record<string, unknown> = { accessToken: "shpat_deep" };
    for (let i = 0; i < 8; i++) deep = { next: deep };
    const text = JSON.stringify(redactForLog(deep));
    expect(text).not.toContain("shpat_deep");
    expect(text).toContain("[truncated]");
  });

  it("log a primitive passed as fields under `value`", () => {
    logger.info(42, "count");
    expect(out.lines[0]).toMatchObject({ msg: "count", value: 42 });
  });
});
