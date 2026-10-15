import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dynamoCoord } from "../src/dynamoCoord.js";
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
        const cur = items.get(k) ?? { k: { S: k } };
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

  it("serves pages the way Workers Static Assets does", async () => {
    expect(await get("/")).toMatchObject({ status: 200, text: "home" });
    expect(await get("/login")).toMatchObject({ status: 200, text: "login" });
    expect(await get("/login/")).toMatchObject({ status: 200, text: "login" });
    expect(await get("/auth/callback")).toMatchObject({ status: 200, text: "callback" });
    const missing = await get("/nope");
    expect(missing).toMatchObject({ status: 404, text: "missing" });
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
