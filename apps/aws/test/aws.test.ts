import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { originCheck } from "../src/app.js";
import { dynamoCoord } from "../src/dynamoCoord.js";
import { API_PATH_PATTERNS, apiPath } from "../src/paths.js";
import { loadSecrets } from "../src/secrets.js";
import { parseHeaders, staticSite } from "../src/staticSite.js";

/** A DynamoDB that keeps items in a Map and understands exactly the requests dynamoCoord sends. */
function fakeDynamo() {
  const items = new Map<string, Record<string, { S?: string; N?: string }>>();
  const seen: Array<{ target: string; auth: string | null; body: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const target = req.headers.get("x-amz-target")!.split(".")[1]!;
    const body = JSON.parse(await req.text());
    seen.push({ target, auth: req.headers.get("authorization"), body });
    const k = body.Key?.k?.S ?? body.Item?.k?.S;
    switch (target) {
      case "GetItem":
        return json(items.has(k) ? { Item: items.get(k) } : {});
      case "PutItem": {
        const cur = items.get(k);
        if (body.ConditionExpression && cur && Number(cur.until!.N) >= Number(body.ExpressionAttributeValues[":now"].N)) {
          return json({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException" }, 400);
        }
        items.set(k, body.Item);
        return json({});
      }
      case "DeleteItem": {
        const old = items.get(k);
        items.delete(k);
        return json(body.ReturnValues === "ALL_OLD" && old ? { Attributes: old } : {});
      }
      case "UpdateItem": {
        const cur: Record<string, { S?: string; N?: string }> = items.get(k) ?? { k: { S: k } };
        const n = Number(cur.n?.N ?? 0) + 1;
        const v = body.ExpressionAttributeValues;
        items.set(k, { ...cur, n: { N: String(n) }, until: cur.until ?? v[":until"], exp: cur.exp ?? v[":exp"] });
        return json({ Attributes: { n: { N: String(n) } } });
      }
    }
    return json({ __type: "UnknownOperationException" }, 400);
  }) as typeof fetch;
  return { items, seen, fetchImpl };
}

describe("the DynamoDB coordinator", () => {
  let clock = 1_000_000;
  const now = () => clock;
  const make = () => {
    const db = fakeDynamo();
    const coord = dynamoCoord({ table: "t", region: "ap-southeast-2", credentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "tok" }, fetchImpl: db.fetchImpl, now });
    return { db, coord };
  };

  it("signs every call with the role's temporary credentials", async () => {
    const { db, coord } = make();
    await coord.ping();
    expect(db.seen[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/ap-southeast-2\/dynamodb\/aws4_request/);
    expect(db.seen[0]!.body.TableName).toBe("t");
  });

  it("counts hits per fixed window, starting again in the next one", async () => {
    const { coord } = make();
    clock = 60_000 * 100;
    expect(await coord.hit("rl:x", 60)).toBe(1);
    expect(await coord.hit("rl:x", 60)).toBe(2);
    clock += 60_000;
    expect(await coord.hit("rl:x", 60)).toBe(1);
  });

  it("keeps values until they expire, and take() reads them once", async () => {
    const { coord } = make();
    await coord.put("state:a", "v1", 10);
    expect(await coord.peek("state:a")).toBe("v1");
    expect(await coord.take("state:a")).toBe("v1");
    expect(await coord.take("state:a")).toBeNull();
    await coord.put("state:b", "v2", 10);
    clock += 11_000;
    // TTL deletion is lazy in DynamoDB: an expired item may still be there, and must read as gone.
    expect(await coord.peek("state:b")).toBeNull();
    expect(await coord.take("state:b")).toBeNull();
  });

  it("lets one holder take a lock, and anyone after it runs out", async () => {
    const { coord } = make();
    expect(await coord.acquire("lock", 5_000)).toBe(true);
    expect(await coord.acquire("lock", 5_000)).toBe(false);
    clock += 6_000;
    expect(await coord.acquire("lock", 5_000)).toBe(true);
    await coord.release("lock");
    expect(await coord.acquire("lock", 5_000)).toBe(true);
  });
});

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

describe("the function URL's origin check", () => {
  const secret = "s3cret-origin-value-0123456789";
  it("serves the API only to requests carrying CloudFront's secret", () => {
    expect(originCheck(secret, secret, true)).toBe("cloudfront");
    expect(originCheck(null, secret, true)).toBe("forbidden");
    expect(originCheck("wrong", secret, true)).toBe("forbidden");
    expect(originCheck(`${secret}x`, secret, true)).toBe("forbidden");
  });

  it("refuses in production when the secret is missing, instead of letting anyone around WAF", () => {
    expect(originCheck(null, undefined, true)).toBe("unconfigured");
    expect(originCheck("anything", "", true)).toBe("unconfigured");
    // Locally there is no CloudFront.
    expect(originCheck(null, undefined, false)).toBe("direct");
  });
});

describe("secrets at cold start", () => {
  it("puts each secret's keys in the environment and builds verified-TLS database URLs", async () => {
    const values: Record<string, Record<string, string>> = {
      app: { SESSION_SECRET: "s", APP_RLS_PASSWORD: "p@ss/w:rd" },
      cognito: { COGNITO_CLIENT_SECRET: "c" },
      db: { username: "app", password: "m a&s" },
    };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const { SecretId } = JSON.parse(await new Request(input, init).text());
      return new Response(JSON.stringify({ SecretString: JSON.stringify(values[SecretId]) }));
    }) as typeof fetch;
    const env: NodeJS.ProcessEnv = {
      AWS_REGION: "ap-southeast-2",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "s",
      APP_SECRET_ARN: "app",
      COGNITO_WORKER_SECRET_ARN: "cognito",
      DB_SECRET_ARN: "db",
      DB_HOST: "db.example",
      DB_NAME: "app",
      SESSION_SECRET: "already-set",
    };
    await loadSecrets(env, fetchImpl);
    expect(env.SESSION_SECRET).toBe("already-set");
    expect(env.COGNITO_CLIENT_SECRET).toBe("c");
    expect(env.DATABASE_URL).toBe("postgresql://app:m%20a%26s@db.example:5432/app?sslmode=verify-full");
    expect(env.APP_DATABASE_URL).toBe("postgresql://app_rls:p%40ss%2Fw%3Ard@db.example:5432/app?sslmode=verify-full");
  });
});
