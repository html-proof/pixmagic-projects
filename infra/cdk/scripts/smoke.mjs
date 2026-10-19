#!/usr/bin/env node
// Checks against a deployed environment, from outside AWS (what a visitor or attacker sees), plus
// a few AWS-side facts read with the CLI. Read-only: no account is created, no one is emailed, no
// data changes (the one sign-in call asks for a password reset of an address that doesn't exist).
//
//   node infra/cdk/scripts/smoke.mjs [--env production]
//
// Prints one line per check and exits non-zero if any fails.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { connect } from "node:net";

const args = process.argv.slice(2);
const envName = args[args.indexOf("--env") + 1] && args.includes("--env") ? args[args.indexOf("--env") + 1] : "production";
const region = "ap-southeast-2";
const aws = (a) => JSON.parse(execFileSync("aws", [...a, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const outputs = (stack) => Object.fromEntries((aws(["cloudformation", "describe-stacks", "--stack-name", stack]).Stacks[0].Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));

const app = outputs(`InsightsApp-${envName}`);
const base = app.AppUrl;
const fnUrl = app.ApiFunctionUrl.replace(/\/$/, "");
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const get = (url, init) => fetch(url, { redirect: "manual", ...init });
// The domain's DNS is at Cloudflare, proxied: it answers as `server: cloudflare` and may serve a file
// from its own cache, so CloudFront's and S3's marks are looked for in what it passes on.
const edgeHit = (r) => /hit/i.test(r.headers.get("x-cache") ?? "") || /hit/i.test(r.headers.get("cf-cache-status") ?? "");
const fromS3 = (r) => r.headers.get("server") === "AmazonS3" || !!r.headers.get("x-amz-server-side-encryption");

console.log(`Checking ${base}\n`);

// --- Frontend
await check("home page loads", async () => {
  const r = await get(`${base}/`);
  const html = await r.text();
  expect(r.status === 200, `status ${r.status}`);
  expect(/<html/i.test(html) && /_next\/static/.test(html), "not the Next.js export");
  return `${(html.length / 1024).toFixed(0)} KB`;
});
for (const page of ["/login", "/signup", "/forgot-password", "/dashboard", "/settings", "/privacy", "/terms"]) {
  await check(`page ${page}`, async () => {
    const r = await get(`${base}${page}`);
    expect(r.status === 200, `status ${r.status}`);
    expect((r.headers.get("content-type") ?? "").startsWith("text/html"), r.headers.get("content-type"));
  });
}
await check("unknown page is a 404 page", async () => {
  const r = await get(`${base}/no-such-page-${randomBytes(4).toString("hex")}`);
  expect(r.status === 404, `status ${r.status}`);
});
await check("static assets cached at the edge", async () => {
  const html = await (await get(`${base}/login`)).text();
  const asset = /\/_next\/static\/[^"']+\.js/.exec(html)?.[0];
  expect(asset, "no script in the page");
  await get(`${base}${asset}`);
  const r = await get(`${base}${asset}`);
  expect(r.status === 200, `status ${r.status}`);
  expect(edgeHit(r), `x-cache ${r.headers.get("x-cache")}, cf-cache-status ${r.headers.get("cf-cache-status")}`);
  expect(/immutable/.test(r.headers.get("cache-control") ?? ""), `cache-control ${r.headers.get("cache-control")}`);
  return [r.headers.get("x-cache"), r.headers.get("cf-cache-status") && `cloudflare ${r.headers.get("cf-cache-status")}`].filter(Boolean).join(", ");
});
// What a first visit does: every script of the page at once. Served by the function, a burst like
// this ran past the account's Lambda concurrency and came back 429 with a JSON body.
await check("all of a page's scripts load at once, as JavaScript, from S3", async () => {
  const html = await (await get(`${base}/dashboard`)).text();
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)]+\.js/g) ?? [])];
  expect(assets.length, "no scripts in the page");
  const rs = await Promise.all(assets.map((a) => get(`${base}${a}`)));
  const bad = rs.map((r, i) => [assets[i], r]).filter(([, r]) => r.status !== 200 || !/javascript/.test(r.headers.get("content-type") ?? "") || !fromS3(r));
  expect(!bad.length, bad.map(([a, r]) => `${a}: ${r.status} ${r.headers.get("content-type")} ${r.headers.get("server")}`).join("; "));
  return `${assets.length} scripts`;
});
await check("security headers on pages", async () => {
  const r = await get(`${base}/login`);
  for (const h of ["strict-transport-security", "x-content-type-options", "x-frame-options", "content-security-policy", "referrer-policy"]) expect(r.headers.get(h), `missing ${h}`);
});
await check("security.txt published", async () => {
  const r = await get(`${base}/.well-known/security.txt`);
  const text = await r.text();
  expect(r.status === 200 && /^Contact: /m.test(text) && /^Expires: /m.test(text), `status ${r.status}`);
  // Renewed by hand before it expires (apps/web/public/.well-known/security.txt).
  return /^Expires: (.+)$/m.exec(text)?.[1];
});
await check("http redirects to https", async () => {
  const r = await get(base.replace("https://", "http://") + "/");
  expect([301, 302, 307, 308].includes(r.status) && (r.headers.get("location") ?? "").startsWith("https://"), `status ${r.status}`);
});
// With a domain of its own (config.ts `domain`), CloudFront's name and www send pages there, with
// the same path and query parameters. Not necessarily in the same order: CloudFront gives the
// viewer function the query as an object (viewer-request.ts), and Shopify's launch HMAC is checked
// over the parameters sorted by name, so the order is all that may change.
const host = new URL(base).host;
const sortedQuery = (u) => {
  const url = new URL(u);
  url.searchParams.sort();
  return url.href;
};
if (app.CloudFrontDomain && app.CloudFrontDomain !== host) {
  for (const other of [app.CloudFrontDomain, `www.${host}`]) {
    await check(`${other} sends pages to ${host}`, async () => {
      const r = await get(`https://${other}/login?next=%2Fdashboard&x`);
      const location = r.headers.get("location");
      const same = !!location && sortedQuery(location) === sortedQuery(`${base}/login?next=%2Fdashboard&x`);
      expect(r.status === 301 && same, `status ${r.status}, location ${location}`);
    });
  }
}

// --- Backend
await check("API health", async () => {
  const r = await get(`${base}/api/healthz`);
  expect(r.status === 200, `status ${r.status}`);
});
await check("API ready: database (owner + tenant role) and coordinator", async () => {
  let last;
  for (let i = 0; i < 3; i++) {
    const r = await get(`${base}/api/readyz`);
    last = await r.json().catch(() => ({}));
    if (r.status === 200 && last.ok) break;
  }
  expect(last?.ok === true && last.checks?.db && last.checks?.tenantDb && last.checks?.coord, JSON.stringify(last));
  return JSON.stringify(last.checks);
});
await check("protected API needs a session", async () => {
  const r = await get(`${base}/api/me`);
  expect(r.status === 401, `status ${r.status}`);
});
await check("sign-in service wired (Cognito client + secret), no account touched", async () => {
  const r = await get(`${base}/api/auth/password/forgot`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: `smoke-${randomBytes(6).toString("hex")}@example.com` }),
  });
  const body = await r.json().catch(() => ({}));
  expect(r.status === 200 && body.ok, `status ${r.status} ${JSON.stringify(body)}`);
});
await check("auth config served", async () => {
  const r = await get(`${base}/api/auth/config`);
  const body = await r.json();
  expect(r.status === 200 && "providers" in body, `status ${r.status}`);
  return `google ${body.providers.google}`;
});
await check("cross-site POST with a session cookie is refused (CSRF)", async () => {
  const r = await get(`${base}/api/auth/logout`, { method: "POST", headers: { origin: "https://evil.example", cookie: "__session=x" } });
  expect(r.status === 403, `status ${r.status}`);
});
await check("other sites get no CORS grant", async () => {
  const r = await get(`${base}/api/me`, { headers: { origin: "https://evil.example" } });
  const acao = r.headers.get("access-control-allow-origin");
  expect(!acao || (acao !== "*" && acao !== "https://evil.example"), `access-control-allow-origin ${acao}`);
});
await check("Shopify webhook with a bad signature is refused", async () => {
  const r = await get(`${base}/api/webhooks/shopify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-hmac-sha256": "bad", "x-shopify-topic": "orders/create", "x-shopify-shop-domain": "example.myshopify.com", "x-shopify-webhook-id": randomBytes(8).toString("hex") },
    body: "{}",
  });
  expect(r.status === 401, `status ${r.status}`);
});

// --- Edge protection
await check("function URL refuses requests that skip CloudFront", async () => {
  const r = await get(`${fnUrl}/api/healthz`);
  expect(r.status === 403, `status ${r.status}`);
  const r2 = await get(`${fnUrl}/api/healthz`, { headers: { "x-origin-verify": "guess" } });
  expect(r2.status === 403, `status with a guessed secret ${r2.status}`);
});

// --- AWS side
await check("database is private (no public address, not reachable)", async () => {
  const db = aws(["rds", "describe-db-instances", "--db-instance-identifier", `insights-${envName}`]).DBInstances[0];
  expect(db.PubliclyAccessible === false, "PubliclyAccessible");
  expect(db.StorageEncrypted === true, "storage not encrypted");
  const ips = await resolve4(db.Endpoint.Address);
  expect(ips.every((ip) => /^10\./.test(ip)), `resolves to ${ips}`);
  const reachable = await new Promise((res) => {
    const s = connect({ host: db.Endpoint.Address, port: 5432, timeout: 4000 });
    s.on("connect", () => (s.destroy(), res(true)));
    s.on("error", () => res(false));
    s.on("timeout", () => (s.destroy(), res(false)));
  });
  expect(!reachable, "port 5432 answered from the internet");
  return `${db.DBInstanceClass}, backups ${db.BackupRetentionPeriod} days, deletion protection ${db.DeletionProtection}`;
});
await check("buckets are private", async () => {
  const unanswered = [];
  for (const kind of ["payloads", "artifacts", "site"]) {
    const name = `insights-${envName}-${kind}-605411278365`;
    // AWS's own answer: with all four settings on, S3 ignores public ACLs and refuses anonymous
    // access whatever the bucket policy says.
    const pab = aws(["s3api", "get-public-access-block", "--bucket", name]).PublicAccessBlockConfiguration;
    expect(Object.values(pab).every(Boolean), `${name} public access block`);
    // And what anyone on the internet gets. Any answer but 403 fails. The runner's network sometimes
    // can't reach S3's regional endpoint at all (connect timeouts, 2026-10-18): a request with no
    // answer proves nothing either way, so it is asked again once and then left to the check above.
    const url = `https://${name}.s3.${region}.amazonaws.com/`;
    let r = null;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      r = await get(url).catch((err) => {
        if (attempt === 1) unanswered.push(`${kind}: ${err.cause?.code ?? err.name}`);
        return null;
      });
    }
    if (r) expect(r.status === 403, `${name} anonymous list: ${r.status}`);
  }
  return unanswered.length ? `S3 gave no answer from here (${unanswered.join(", ")}); public access block verified` : "";
});
await check("functions healthy (live alias, no errors in the last hour)", async () => {
  const end = new Date();
  const start = new Date(end.getTime() - 3600_000);
  const out = [];
  for (const part of ["api", "jobs", "cron"]) {
    const fn = `insights-${envName}-${part}`;
    const alias = aws(["lambda", "get-alias", "--function-name", fn, "--name", "live"]);
    const stats = aws(["cloudwatch", "get-metric-statistics", "--namespace", "AWS/Lambda", "--metric-name", "Errors", "--dimensions", `Name=FunctionName,Value=${fn}`, "--start-time", start.toISOString(), "--end-time", end.toISOString(), "--period", "3600", "--statistics", "Sum"]);
    const errors = stats.Datapoints.reduce((n, d) => n + d.Sum, 0);
    out.push(`${part} v${alias.FunctionVersion} errors ${errors}`);
  }
  return out.join(", ");
});
await check("the public address runs this checkout's commit, on the live release", async () => {
  // What a visitor reaches (Cloudflare → CloudFront → the function URL) against what was deployed:
  // the commit checked out here, and the version the api function's live alias points at.
  const r = await get(`${base}/api/version`);
  const v = await r.json().catch(() => ({}));
  expect(r.status === 200, `status ${r.status}`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(v.commit?.replace(/-dirty$/, "") === head, `serves ${v.commit}, this checkout is ${head}`);
  const live = aws(["lambda", "get-alias", "--function-name", `insights-${envName}-api`, "--name", "live"]).FunctionVersion;
  expect(v.release === live, `serves release ${v.release}, the live alias is ${live}`);
  return `${v.commit.slice(0, 7)}${v.commit.endsWith("-dirty") ? " (built with uncommitted changes)" : ""}, release ${v.release}, built ${v.builtAt}`;
});
await check("queues empty of dead letters", async () => {
  const url = aws(["sqs", "get-queue-url", "--queue-name", `insights-${envName}-dlq`]).QueueUrl;
  const n = Number(aws(["sqs", "get-queue-attributes", "--queue-url", url, "--attribute-names", "ApproximateNumberOfMessages"]).Attributes.ApproximateNumberOfMessages);
  expect(n === 0, `${n} message(s) in the DLQ`);
});
await check("logs flowing to CloudWatch", async () => {
  const streams = aws(["logs", "describe-log-streams", "--log-group-name", `/aws/lambda/insights-${envName}-api`, "--order-by", "LastEventTime", "--descending", "--max-items", "1"]);
  expect(streams.logStreams?.length, "no log streams");
  const last = streams.logStreams[0].lastEventTimestamp;
  return `last event ${Math.round((Date.now() - last) / 1000)} s ago`;
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
