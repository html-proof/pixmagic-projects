import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { App } from "@app/api";
import { parseArgs, toAction } from "../src/adminArgs.js";
import { blobPath, fsBlobs } from "../src/fsBlobs.js";
import { Registry } from "../src/metrics.js";
import { DEFAULT_CONCURRENCY, queueConcurrency } from "../src/pgQueues.js";
import { cronField, latestDue, parseCron } from "../src/schedules.js";
import { cloudflareGeo, selfHostSettings, webHandler } from "../src/selfhost.js";

/**
 * The self-hosted runtime's parts that need no database (docs/ikorex-migration): the cron reader,
 * the blob folder, the request router, the settings, the admin command's arguments and the metrics
 * text. The queue, the coordinator and the schedule ticks are in selfhostPg.test.ts.
 */

const utc = (s: string) => Date.parse(`${s}Z`);

describe("cron", () => {
  it("reads lists, ranges and steps, and refuses what it can't read", () => {
    expect([...cronField("*/15", 0, 59)]).toEqual([0, 15, 30, 45]);
    expect([...cronField("1-3,10", 0, 59)]).toEqual([1, 2, 3, 10]);
    expect([...cronField("5/20", 0, 59)]).toEqual([5, 25, 45]);
    expect(() => cronField("61", 0, 59)).toThrow(/out of range/);
    expect(() => cronField("a", 0, 59)).toThrow(/Unreadable/);
    expect(() => parseCron("* * * *")).toThrow(/five fields/);
  });

  it("finds the latest due minute of the every-15-minutes and nightly schedules, in UTC", () => {
    const every15 = parseCron("*/15 * * * *");
    expect(latestDue(every15, "UTC", utc("2026-11-06T10:07:30"), 14)).toBe(utc("2026-11-06T10:00:00"));
    expect(latestDue(every15, "UTC", utc("2026-11-06T10:15:00"), 14)).toBe(utc("2026-11-06T10:15:00"));
    const nightly = parseCron("15 3 * * *");
    // A worker started at 05:00 still runs the 03:15 tick (catch-up 12 hours), not one started next noon + 1 h.
    expect(latestDue(nightly, "UTC", utc("2026-11-06T05:00:00"), 720)).toBe(utc("2026-11-06T03:15:00"));
    expect(latestDue(nightly, "UTC", utc("2026-11-06T16:00:00"), 720)).toBeNull();
  });

  it("fires the cost email at 07:00 Melbourne on both sides of daylight saving", () => {
    const seven = parseCron("0 7 * * *");
    // Daylight saving (UTC+11) in November: 07:00 is 20:00 UTC the day before.
    expect(latestDue(seven, "Australia/Melbourne", utc("2026-11-05T20:30:00"), 360)).toBe(utc("2026-11-05T20:00:00"));
    // Standard time (UTC+10) in June: 21:00 UTC.
    expect(latestDue(seven, "Australia/Melbourne", utc("2026-06-10T21:05:00"), 360)).toBe(utc("2026-06-10T21:00:00"));
  });

  it("matches either day field when both are restricted, as cron does", () => {
    const c = parseCron("0 0 1 * 1"); // the 1st, or any Monday
    expect(latestDue(c, "UTC", utc("2026-11-09T00:00:00"), 0)).toBe(utc("2026-11-09T00:00:00")); // a Monday
    expect(latestDue(c, "UTC", utc("2026-11-01T00:00:00"), 0)).toBe(utc("2026-11-01T00:00:00")); // a Sunday, the 1st
    expect(latestDue(c, "UTC", utc("2026-11-10T00:00:00"), 0)).toBeNull();
  });
});

describe("blob folder", () => {
  it("stores, reads and deletes the app's keys, and refuses keys that would leave the folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "blobs-"));
    const blobs = fsBlobs(root);
    await blobs.put("webhooks/c1abc-Xy_9.json", '{"a":1}');
    await blobs.put("wapp-media/m1", "data");
    expect(await blobs.get("webhooks/c1abc-Xy_9.json")).toBe('{"a":1}');
    await blobs.delete("webhooks/c1abc-Xy_9.json");
    expect(await blobs.get("webhooks/c1abc-Xy_9.json")).toBeNull();
    await blobs.delete("webhooks/never-there");
    for (const bad of ["../etc/passwd", "a/../../b", "/abs", "a//b", "a\\b", ".hidden", ""]) {
      expect(() => blobPath(root, bad)).toThrow(/Unusable blob key/);
      await expect(blobs.put(bad, "x")).rejects.toThrow(/Unusable blob key/);
    }
  });

  it("prunes what is older than the limit and keeps the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), "blobs-"));
    const blobs = fsBlobs(root);
    await blobs.put("webhooks/old.json", "old");
    await blobs.put("webhooks/new.json", "new");
    const now = Date.now();
    const eightDays = (now - 8 * 86_400_000) / 1000;
    utimesSync(blobPath(root, "webhooks/old.json"), eightDays, eightDays);
    expect(await blobs.prune(7 * 86_400_000, now)).toBe(1);
    expect(await blobs.get("webhooks/old.json")).toBeNull();
    expect(await blobs.get("webhooks/new.json")).toBe("new");
    expect(await fsBlobs(join(root, "missing")).prune(1)).toBe(0);
  });
});

describe("request router", () => {
  // A stand-in API that echoes what reached it.
  const echo = new Hono().all("*", (c) =>
    c.json({ path: new URL(c.req.url).pathname, ip: c.req.header("x-insights-client-ip") ?? null, geo: c.req.header("x-insights-client-geo") ?? null, verify: c.req.header("x-origin-verify") ?? null }),
  ) as unknown as App;
  const files = (request: Request) => new Response(`page ${new URL(request.url).pathname}`);
  const handle = webHandler(echo, files, { trustedIpHeader: "cf-connecting-ip", maxBodyBytes: 100 });
  const call = async (path: string, init: RequestInit = {}, remote = "172.18.0.5") => {
    const res = await handle(new Request(`https://bizinsights.io${path}`, init), remote);
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };

  it("takes the client's address and location from Cloudflare's headers, and drops anything posing as ours", async () => {
    const r = await call("/api/me", {
      headers: { "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "AU", "cf-region": "Victoria", "cf-ipcity": "St Kilda", "x-insights-client-ip": "6.6.6.6", "x-origin-verify": "guess" },
    });
    expect(r.body).toEqual({ path: "/me", ip: "203.0.113.9", geo: "AU|Victoria|St%20Kilda", verify: null });
  });

  it("uses the socket's address when the edge header is missing or not an address", async () => {
    expect((await call("/api/me", { headers: { "x-insights-client-ip": "6.6.6.6" } }, "::ffff:172.18.0.7")).body).toMatchObject({ ip: "172.18.0.7", geo: null });
    expect((await call("/api/me", { headers: { "cf-connecting-ip": "not an ip", "cf-ipcountry": "AU" } })).body).toMatchObject({ ip: "172.18.0.5", geo: null });
  });

  it("trusts no header when told so", async () => {
    const strict = webHandler(echo, files, { trustedIpHeader: null, maxBodyBytes: 100 });
    const res = await strict(new Request("https://bizinsights.io/api/me", { headers: { "cf-connecting-ip": "203.0.113.9" } }), "172.18.0.5");
    expect(await res.json()).toMatchObject({ ip: "172.18.0.5" });
  });

  it("serves pages and health without the API, and refuses oversized bodies", async () => {
    expect(await call("/dashboard")).toEqual({ status: 200, body: "page /dashboard" });
    expect(await call("/__health")).toEqual({ status: 200, body: "ok" });
    const big = await call("/api/webhooks/shopify", { method: "POST", headers: { "content-length": "101" }, body: "x".repeat(101) });
    expect(big.status).toBe(413);
  });

  it("sends page and API reads that arrive through the edge on another name to the app's own, as CloudFront's function did", async () => {
    const one = webHandler(echo, files, { trustedIpHeader: "cf-connecting-ip", maxBodyBytes: 100, canonicalHost: "bizinsights.io" });
    const ask = (path: string, host: string | null, init: RequestInit = {}, edge = true) =>
      one(new Request(`https://bizinsights.io${path}`, { ...init, headers: { ...(host ? { host } : {}), ...(edge ? { "cf-connecting-ip": "203.0.113.9" } : {}) } }), "172.18.0.5");

    const www = await ask("/login?next=%2Fdashboard&shop=a.myshopify.com", "www.bizinsights.io");
    expect(www.status).toBe(301);
    expect(www.headers.get("location")).toBe("https://bizinsights.io/login?next=%2Fdashboard&shop=a.myshopify.com");
    expect(www.headers.get("cache-control")).toBe("max-age=3600");
    expect((await ask("/api/version", "WWW.bizinsights.io", { method: "HEAD" })).status).toBe(301);

    // Its own name, with or without the edge: served.
    expect(await (await ask("/dashboard", "bizinsights.io")).text()).toBe("page /dashboard");
    // Webhooks and other writes don't follow redirects: served where they arrive.
    expect((await ask("/api/webhooks/shopify", "www.bizinsights.io", { method: "POST", body: "{}" })).status).toBe(200);
    // From inside the server (no edge header): Docker's health check, deploy.sh's checks, the WhatsApp service.
    expect(await (await ask("/__health", "www.bizinsights.io")).text()).toBe("ok");
    expect((await ask("/api/readyz", "127.0.0.1:8080", {}, false)).status).toBe(200);
    expect(await (await ask("/dashboard", "web:8080", {}, false)).text()).toBe("page /dashboard");
    // Without an own name configured (the other tests' handler), nothing is redirected.
    expect((await call("/dashboard", { headers: { host: "www.bizinsights.io", "cf-connecting-ip": "203.0.113.9" } })).status).toBe(200);
  });

  it("formats Cloudflare's location like the CloudFront viewer function did", () => {
    expect(cloudflareGeo(new Headers({ "cf-ipcountry": "NZ" }))).toBe("NZ||");
    expect(cloudflareGeo(new Headers())).toBeNull();
  });
});

describe("settings", () => {
  it("names what is missing without printing a value", () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: "postgresql://secret@db/app" };
    expect(() => selfHostSettings(env, tmpdir())).toThrow("Not set: APP_DATABASE_URL, APP_URL");
    expect(() => selfHostSettings(env, tmpdir())).not.toThrow(/secret/);
  });

  it("derives the API address, the commit and Cognito's admin keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-"));
    writeFileSync(join(dir, "build.json"), JSON.stringify({ commit: "abc123", builtAt: "2026-11-06T00:00:00Z" }));
    const env: NodeJS.ProcessEnv = { DATABASE_URL: "a", APP_DATABASE_URL: "b", APP_URL: "https://bizinsights.io/", AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s" };
    selfHostSettings(env, dir);
    expect(env).toMatchObject({ APP_URL: "https://bizinsights.io", API_URL: "https://bizinsights.io/api", APP_COMMIT: "abc123", NODE_ENV: "production", COGNITO_ADMIN_ACCESS_KEY_ID: "AKIA1", COGNITO_ADMIN_SECRET_ACCESS_KEY: "s" });
  });
});

describe("admin command and queue settings", () => {
  it("reads commands, positionals and flags", () => {
    expect(parseArgs(["verify", "--shop", "a.myshopify.com", "--days", "3", "--dry-run"])).toEqual({ command: "verify", positional: [], flags: { shop: "a.myshopify.com", days: "3", "dry-run": true } });
    expect(toAction("verify", { shop: "a.myshopify.com", days: "3", "dry-run": true })).toEqual({ action: "verify", shop: "a.myshopify.com", days: 3, dryRun: true, dateFrom: undefined, dateTo: undefined });
    expect(toAction("queues", {})).toBeNull();
    expect(parseArgs(["redrive", "sync"]).positional).toEqual(["sync"]);
  });

  it("takes per-queue concurrency over the AWS defaults and refuses nonsense", () => {
    expect(queueConcurrency(undefined)).toEqual(DEFAULT_CONCURRENCY);
    expect(queueConcurrency('{"sync":4,"whatsapp":0}')).toEqual({ ...DEFAULT_CONCURRENCY, sync: 4, whatsapp: 0 });
    expect(() => queueConcurrency('{"nope":1}')).toThrow(/unknown queue/);
    expect(() => queueConcurrency('{"sync":-1}')).toThrow(/whole number/);
  });
});

describe("metrics", () => {
  it("renders counters, histograms and gauges in Prometheus's text format, and skips a gauge that fails", async () => {
    const r = new Registry();
    r.counter("jobs_total", "Jobs.").inc({ queue: "sync", outcome: "ack" }, 2);
    r.histogram("job_seconds", "Time.", [1, 5]).observe({ queue: "sync" }, 3);
    r.gauge({ name: "depth", help: "Depth.", read: async () => [{ labels: { queue: 'we"ird' }, value: 4 }] });
    r.gauge({ name: "broken", help: "Broken.", read: async () => Promise.reject(new Error("db away")) });
    const text = await r.render();
    expect(text).toContain('jobs_total{outcome="ack",queue="sync"} 2');
    expect(text).toContain('job_seconds_bucket{queue="sync",le="1"} 0');
    expect(text).toContain('job_seconds_bucket{queue="sync",le="5"} 1');
    expect(text).toContain('job_seconds_bucket{queue="sync",le="+Inf"} 1');
    expect(text).toContain('job_seconds_sum{queue="sync"} 3');
    expect(text).toContain('depth{queue="we\\"ird"} 4');
    expect(text).not.toContain("broken");
  });
});
