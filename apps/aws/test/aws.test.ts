import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_PATH_PATTERNS, apiPath } from "../src/paths.js";
import { parseHeaders, staticSite } from "../src/staticSite.js";

describe("which requests are the API's", () => {
  // CloudFront's path patterns: `*` any run of characters, `?` one, the rest literal.
  const cloudFront = (path: string) => API_PATH_PATTERNS.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(path));

  it("strips /api and keeps the bare API paths", () => {
    expect(apiPath("/api/me")).toBe("/me");
    expect(apiPath("/api")).toBe("/");
    expect(apiPath("/webhooks/shopify")).toBe("/webhooks/shopify");
    expect(apiPath("/healthz")).toBe("/healthz");
    expect(apiPath("/dashboard")).toBeNull();
  });

  // CloudFront sends the rest to a page of its own while the function can't answer (infra/cdk
  // app-stack.ts): one path it got wrong would hide an API answer behind that page, or leave a page
  // without it.
  it("are the paths CloudFront keeps on the function, and no others", () => {
    const api = ["/api", "/api/", "/api/me", "/api/auth/oauth/google/callback", "/webhooks/", "/webhooks/shopify/orders", "/pixel/v1/e", "/shopify/install", "/healthz", "/readyz"];
    const ui = ["/", "/apis", "/apix/me", "/dashboard", "/settings/ads", "/login", "/webhooks", "/pixel", "/shopify", "/healthz/", "/readyz.html", "/API/me", "/support", "/_next/static/chunks/a.js"];
    for (const p of api) expect([p, apiPath(p) !== null, cloudFront(p)]).toEqual([p, true, true]);
    for (const p of ui) expect([p, apiPath(p), cloudFront(p)]).toEqual([p, null, false]);
  });
});

describe("the static UI", () => {
  const root = mkdtempSync(join(tmpdir(), "site-"));
  mkdirSync(join(root, "auth"));
  mkdirSync(join(root, "_next/static/chunks"), { recursive: true });
  writeFileSync(join(root, "index.html"), "home");
  writeFileSync(join(root, "login.html"), "login");
  writeFileSync(join(root, "auth/callback.html"), "callback");
  writeFileSync(join(root, "404.html"), "missing");
  writeFileSync(join(root, "_next/static/chunks/a.js"), "js");
  writeFileSync(join(root, "_headers"), "/*\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n/other\n  X-Other: no\n");
  const site = staticSite(root);
  const get = async (path: string) => {
    const r = site(new Request(`https://x.example${path}`));
    return { status: r.status, text: await r.text(), headers: r.headers };
  };

  it("serves pages by their clean URLs, with a 404 page for the rest", async () => {
    expect(await get("/")).toMatchObject({ status: 200, text: "home" });
    expect(await get("/login")).toMatchObject({ status: 200, text: "login" });
    expect(await get("/login/")).toMatchObject({ status: 200, text: "login" });
    expect(await get("/auth/callback")).toMatchObject({ status: 200, text: "callback" });
    const missing = await get("/nope");
    expect(missing).toMatchObject({ status: 404, text: "missing" });
    // An address that can't be decoded is a bad request, shown with the same page.
    expect(await get("/%E0%A4%A")).toMatchObject({ status: 400, text: "missing" });
  });

  it("applies the _headers rules, caches only hashed files, and never serves outside the folder", async () => {
    const page = await get("/login");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-other")).toBeNull();
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect((await get("/_next/static/chunks/a.js")).headers.get("cache-control")).toContain("immutable");
    for (const p of ["/../package.json", "/%2e%2e/secret", "/_headers"]) expect((await get(p)).status).toBe(404);
    expect(parseHeaders("/*\n  A: 1\n")).toEqual({ A: "1" });
  });

  it("enforces the pages' Content-Security-Policy: where scripts load from and what they may reach", () => {
    const shipped = parseHeaders(readFileSync(new URL("../../web/public/_headers", import.meta.url), "utf8"));
    // Enforced, not only reported: a report-only policy stops nothing.
    expect(shipped["Content-Security-Policy-Report-Only"]).toBeUndefined();
    const directives = new Map(
      shipped["Content-Security-Policy"]!.split(";").map((d) => {
        const [name, ...sources] = d.trim().split(/\s+/);
        return [name!, sources] as const;
      }),
    );
    expect(directives.get("default-src")).toEqual(["'self'"]);
    for (const name of ["script-src", "connect-src", "frame-src"]) {
      const sources = directives.get(name)!;
      expect(sources, name).toContain("'self'");
      // Only named hosts: no wildcard, no scheme on its own, no eval.
      for (const s of sources) expect(s, `${name} ${s}`).not.toMatch(/^(\*|https?:|data:|blob:|'unsafe-eval')$/);
    }
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("form-action")).toEqual(["'self'"]);
  });
});
