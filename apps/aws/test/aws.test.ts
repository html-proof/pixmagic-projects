import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { originCheck } from "../src/app.js";
import { dynamoCoord } from "../src/dynamoCoord.js";
import { API_PATH_PATTERNS, apiPath } from "../src/paths.js";
import { loadSecrets, secretParameterName } from "../src/secrets.js";
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
  /**
   * Stand-ins for the two stores: `parameters` by name (/insights/…), `secrets` by id. A parameter
   * given as a number answers with that HTTP status, as AWS does for one the role may not read.
   */
  function stores(parameters: Record<string, Record<string, string> | string | number>, secrets: Record<string, Record<string, string>>) {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = JSON.parse(await request.text()) as { Name?: string; SecretId?: string; WithDecryption?: boolean };
      if (request.headers.get("x-amz-target") === "AmazonSSM.GetParameter") {
        asked.push(`parameter ${body.Name}${body.WithDecryption ? " (decrypted)" : ""}`);
        const value = parameters[body.Name!];
        if (value === undefined) return new Response(JSON.stringify({ __type: "ParameterNotFound" }), { status: 400 });
        if (typeof value === "number") return new Response(JSON.stringify({ __type: "AccessDeniedException" }), { status: value });
        return new Response(JSON.stringify({ Parameter: { Name: body.Name, Value: typeof value === "string" ? value : JSON.stringify(value) } }));
      }
      asked.push(`secret ${body.SecretId}`);
      const value = secrets[body.SecretId!];
      if (!value) return new Response(JSON.stringify({ __type: "ResourceNotFoundException" }), { status: 400 });
      return new Response(JSON.stringify({ SecretString: JSON.stringify(value) }));
    }) as typeof fetch;
    return { fetchImpl, asked };
  }
  const AWS = { AWS_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s" };
  const values = {
    app: { SESSION_SECRET: "s", APP_RLS_PASSWORD: "p@ss/w:rd" },
    cognito: { COGNITO_CLIENT_SECRET: "c" },
    db: { username: "app", password: "m a&s" },
    system: { SYSTEM_DB_USER: "app_system", SYSTEM_DB_PASSWORD: "sy s&" },
  };

  it("puts each secret's keys in the environment and builds verified-TLS database URLs", async () => {
    const { fetchImpl } = stores({}, values);
    const env: NodeJS.ProcessEnv = {
      ...AWS,
      APP_SECRET_ARN: "app",
      COGNITO_WORKER_SECRET_ARN: "cognito",
      DB_SECRET_ARN: "db",
      SYSTEM_DB_SECRET_ARN: "system",
      DB_HOST: "db.example",
      DB_NAME: "app",
      SESSION_SECRET: "already-set",
    };
    await loadSecrets(env, fetchImpl);
    expect(env.SESSION_SECRET).toBe("already-set");
    expect(env.COGNITO_CLIENT_SECRET).toBe("c");
    // systemDb logs in as the system role (docs/system-database-role.md); the owner's login is the
    // cron's alone, for migrate and the other maintenance actions.
    expect(env.DATABASE_URL).toBe("postgresql://app_system:sy%20s%26@db.example:5432/app?sslmode=verify-full");
    expect(env.OWNER_DATABASE_URL).toBe("postgresql://app:m%20a%26s@db.example:5432/app?sslmode=verify-full");
    expect(env.APP_DATABASE_URL).toBe("postgresql://app_rls:p%40ss%2Fw%3Ard@db.example:5432/app?sslmode=verify-full");
  });

  it("gives the api and jobs functions, which have no owner's secret, no owner's login", async () => {
    const { fetchImpl, asked } = stores({}, { system: { SYSTEM_DB_PASSWORD: "sys" } });
    const env: NodeJS.ProcessEnv = { ...AWS, SYSTEM_DB_SECRET_ARN: "system", DB_HOST: "db.example", DB_NAME: "app" };
    await loadSecrets(env, fetchImpl);
    expect(asked.filter((a) => a.startsWith("secret "))).toEqual(["secret system"]);
    expect(env.DATABASE_URL).toBe("postgresql://app_system:sys@db.example:5432/app?sslmode=verify-full");
    expect(env.OWNER_DATABASE_URL).toBeUndefined();
  });

  // The move to Parameter Store (docs/aws-migration/SECRETS_TO_PARAMETER_STORE.md): each secret's
  // copy is a SecureString parameter named like the secret after a slash, holding the same JSON.
  const APP_ARN = "arn:aws:secretsmanager:ap-southeast-2:605411278365:secret:insights/production/app-AbC123";
  const DB_ARN = "arn:aws:secretsmanager:ap-southeast-2:605411278365:secret:insights/production/db-owner-xY9zQ0";

  it("names a secret's parameter after the secret, given by name or by ARN", () => {
    expect(secretParameterName("insights/production/db-system")).toBe("/insights/production/db-system");
    expect(secretParameterName(APP_ARN)).toBe("/insights/production/app");
    expect(secretParameterName(DB_ARN)).toBe("/insights/production/db-owner");
    // A name that only looks like it ends in a suffix is a name: evolution-db stays whole.
    expect(secretParameterName("insights/production/evolution-db")).toBe("/insights/production/evolution-db");
  });

  it("reads each secret from its parameter, decrypted, and never asks Secrets Manager when it is there", async () => {
    const { fetchImpl, asked } = stores(
      {
        "/insights/production/app": values.app,
        "/insights/production/db-system": values.system,
        "/insights/production/db-owner": values.db,
        "/insights/production/runtime": { APP_URL: "https://bizinsights.io" },
      },
      {},
    );
    const env: NodeJS.ProcessEnv = { ...AWS, APP_SECRET_ARN: APP_ARN, SYSTEM_DB_SECRET_ARN: "insights/production/db-system", DB_SECRET_ARN: DB_ARN, RUNTIME_PARAM: "/insights/production/runtime", DB_HOST: "db.example", DB_NAME: "app" };
    const report = await loadSecrets(env, fetchImpl);
    expect(asked).toEqual([
      "parameter /insights/production/app (decrypted)",
      "parameter /insights/production/db-system (decrypted)",
      // Not a secret: read as before.
      "parameter /insights/production/runtime",
      "parameter /insights/production/db-owner (decrypted)",
    ]);
    expect(report).toEqual({
      sources: { "insights/production/app": "parameter", "insights/production/db-system": "parameter", "insights/production/db-owner": "parameter" },
      fallbacks: {},
    });
    expect(env.SESSION_SECRET).toBe("s");
    expect(env.APP_URL).toBe("https://bizinsights.io");
    expect(env.DATABASE_URL).toBe("postgresql://app_system:sy%20s%26@db.example:5432/app?sslmode=verify-full");
    expect(env.OWNER_DATABASE_URL).toBe("postgresql://app:m%20a%26s@db.example:5432/app?sslmode=verify-full");
    expect(env.APP_DATABASE_URL).toBe("postgresql://app_rls:p%40ss%2Fw%3Ard@db.example:5432/app?sslmode=verify-full");
  });

  it("reads the secret itself when its parameter is missing, refused or not the secret's JSON, and says why", async () => {
    const secrets = { [APP_ARN]: values.app, "insights/production/db-system": values.system, "insights/production/evolution-api": { EVOLUTION_API_KEY: "k" } };
    const { fetchImpl, asked } = stores({ "/insights/production/db-system": 400, "/insights/production/evolution-api": "not json {" }, secrets);
    const env: NodeJS.ProcessEnv = { ...AWS, APP_SECRET_ARN: APP_ARN, SYSTEM_DB_SECRET_ARN: "insights/production/db-system", EVOLUTION_SECRET_ARN: "insights/production/evolution-api", DB_HOST: "db.example", DB_NAME: "app" };
    const report = await loadSecrets(env, fetchImpl);
    expect(asked).toEqual([
      "parameter /insights/production/app (decrypted)",
      `secret ${APP_ARN}`,
      "parameter /insights/production/evolution-api (decrypted)",
      "secret insights/production/evolution-api",
      "parameter /insights/production/db-system (decrypted)",
      "secret insights/production/db-system",
    ]);
    expect(report.sources).toEqual({ "insights/production/app": "secret", "insights/production/evolution-api": "secret", "insights/production/db-system": "secret" });
    // Why, by AWS's own error name; the refused text is never part of it.
    expect(report.fallbacks).toEqual({
      "insights/production/app": "400 ParameterNotFound",
      "insights/production/evolution-api": "not a JSON object",
      "insights/production/db-system": "400 AccessDeniedException",
    });
    expect(env.SESSION_SECRET).toBe("s");
    expect(env.EVOLUTION_API_KEY).toBe("k");
    expect(env.DATABASE_URL).toBe("postgresql://app_system:sy%20s%26@db.example:5432/app?sslmode=verify-full");
  });

  it("reads the secret when Parameter Store can't be reached at all", async () => {
    const { fetchImpl } = stores({}, { "insights/production/db-system": values.system });
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new Request(input, init).headers.get("x-amz-target") === "AmazonSSM.GetParameter") throw new TypeError("fetch failed");
      return fetchImpl(input, init);
    }) as typeof fetch;
    const env: NodeJS.ProcessEnv = { ...AWS, SYSTEM_DB_SECRET_ARN: "insights/production/db-system", DB_HOST: "db.example", DB_NAME: "app" };
    const report = await loadSecrets(env, failing);
    expect(report).toEqual({ sources: { "insights/production/db-system": "secret" }, fallbacks: { "insights/production/db-system": "TypeError" } });
    expect(env.SYSTEM_DB_PASSWORD).toBe("sy s&");
  });

  it("still fails, naming the secret, when neither store has it", async () => {
    const { fetchImpl } = stores({}, {});
    await expect(loadSecrets({ ...AWS, APP_SECRET_ARN: "insights/production/app" }, fetchImpl)).rejects.toThrow("Reading secret insights/production/app failed (400 ResourceNotFoundException)");
  });
});
