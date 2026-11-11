// Checks against a deployed environment, from outside AWS (what a visitor or attacker sees), plus
// a few AWS-side facts read with the CLI. Read-only: no account is created, no one is emailed, no
// data changes (the one sign-in call asks for a password reset of an address that doesn't exist).
//
//   node infra/cdk/scripts/smoke.mjs [--env production]
//
// Prints one line per check and exits non-zero if any fails. What isn't a reason to roll back but
// needs the owner (a provider's secret missing) is a ::warning:: line, shown on the run's summary.
// (No #! line: infra/cdk/test imports this file for configCheck, and Vitest can't load one that
// starts with #! in a Windows checkout, whose line ends are CRLF. The checks run only as `node ...`.)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** A GitHub annotation (a ::warning:: on the run's summary), its title and text escaped as GitHub reads them. */
const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const warning = (title, text) => `::warning title=${escapeProperty(title)}::${escapeData(text)}`;

const isConfigReport = (r) =>
  !!r &&
  typeof r === "object" &&
  !!r.ads?.configured &&
  !!r.ads?.restricted &&
  !!r.whatsapp &&
  !!r.email &&
  !!r.auth &&
  Array.isArray(r.credentials) &&
  r.credentials.every((c) => c && typeof c.provider === "string" && typeof c.idSetting === "string" && typeof c.secretSetting === "string" && typeof c.idSet === "boolean" && typeof c.secretSet === "boolean");

/**
 * The smoke tests' requests (redirects never followed). A read that got no answer at all (fetch
 * throws: the connection between the runner and the edge was dropped or reset) is asked once more,
 * for the reason the configuration check below asks twice: it says nothing about the release, and a
 * failed smoke test rolls every function back. On 2026-11-11 `/settings` and `/terms` each failed
 * with "fetch failed" within 70 ms of the page before, and release 176 was rolled back; both
 * answered 200 minutes later. An answer is never asked again, whatever its status, and neither is
 * anything but a read: a POST that may have arrived is not sent twice.
 */
export function requester(fetchImpl = fetch, pauseMs = 1000) {
  return async (url, init) => {
    const ask = () => fetchImpl(url, { redirect: "manual", ...init });
    try {
      return await ask();
    } catch (err) {
      if (!/^(GET|HEAD)$/i.test(init?.method ?? "GET")) throw err;
      await new Promise((r) => setTimeout(r, pauseMs));
      return ask();
    }
  };
}

/**
 * What the cron function answered to {"action":"config"} (packages/core/src/configReport.ts), as
 * the check "app configuration read from the cron function" reports it. `invoke()` asks once and
 * returns { meta, report }: the CLI's answer (FunctionError when the function threw) and the
 * function's. It throws when nothing came back. Returns the PASS line's detail and the warnings.
 *
 * Only an error from the function itself fails the check, after asking twice: the cron function,
 * which every schedule runs on, threw while loading its secrets or reading its settings, a fault of
 * this release that rolling back does fix. No answer at all (the CLI throttled or timed out, or the
 * runner's network dropped the call, as it did S3's on 2026-10-18) or an answer this check doesn't
 * know says nothing about the release, so it is a warning and the check passes: only real health
 * checks roll a release back. A provider whose secret is missing is a warning too: rolling back
 * wouldn't bring the secret, and a provider may be left unset on purpose.
 */
export function configCheck(invoke, envName) {
  const ask = () => {
    try {
      return invoke();
    } catch (err) {
      const said = `${err.stderr ?? ""}`.trim().split(/\r?\n/).pop() || err.code || err.message;
      return { noAnswer: `${said}`.slice(0, 200) };
    }
  };
  let answer = ask();
  // Asked again once: a throttled or timed-out call, or a cold start that failed on its way up.
  if (answer.noAnswer || answer.meta?.FunctionError) {
    const again = ask();
    // An answer wins over none: an error, then silence, is still an error.
    if (!again.noAnswer || answer.noAnswer) answer = again;
  }
  const notChecked = (why) => ({
    detail: `not checked: ${why}`,
    warnings: [
      warning(
        "Provider secrets weren't checked",
        `The cron function's configuration check (${why}) didn't say which provider is missing its secret on ${envName}. Check by hand: docs/aws-deployment.md, "Which provider secrets are there".`,
      ),
    ],
  });
  if (answer.noAnswer) return notChecked(`no answer from insights-${envName}-cron: ${answer.noAnswer}`);
  const { meta, report } = answer;
  expect(!meta?.FunctionError, `${meta?.FunctionError}: ${report?.errorType ?? ""} ${report?.errorMessage ?? ""}`);
  if (!isConfigReport(report)) return notChecked(`an answer this check doesn't know, is the cron function on this commit? ${JSON.stringify(report ?? null).slice(0, 120)}`);

  // On production the Deploy to AWS workflow restarts the functions; any other environment is deployed by hand.
  const restart = envName === "production" ? "run Deploy to AWS (Actions, Run workflow, on main)" : `deploy ${envName} again (cdk deploy --all -c env=${envName})`;
  const half = report.credentials.filter((c) => c.idSet && !c.secretSet);
  const warnings = half.map((c) =>
    warning(
      `${c.provider} isn't set up`,
      `${c.idSetting} is set but ${c.secretSetting} is missing from insights/${envName}/app, so ${c.effect || `${c.provider} doesn't work here`}. ` +
        `Copy the secret, run node infra/cdk/scripts/put-secrets.mjs --env ${envName} --set ${c.secretSetting}, then ${restart} so the functions read it (docs/aws-deployment.md).`,
    ),
  );
  // The WhatsApp service is private: the cron function says whether it reaches it.
  if (report.whatsapp.service && !report.whatsapp.service.reachable) {
    warnings.push(
      warning(
        "WhatsApp's service doesn't answer",
        `The functions can't reach Evolution API (stack InsightsWhatsapp-${envName}), so no store can connect WhatsApp or send. Check its ECS service and logs (docs/whatsapp.md, Runbook).`,
      ),
    );
  }
  const on = (flags) => Object.keys(flags).filter((k) => flags[k]).join("+") || "none";
  const needs = (list) => (Array.isArray(list) && list.length ? ` (needs ${list.join(", ")})` : "");
  const detail = [
    `ads ${on(report.ads.configured)} (restricted ${on(report.ads.restricted)})`,
    `WhatsApp service ${!report.whatsapp.evolution ? `off${needs(report.whatsapp.evolutionNeeds)}` : !report.whatsapp.service ? "on" : report.whatsapp.service.reachable ? `on (Evolution ${report.whatsapp.service.version ?? "?"} answers)` : "on but NOT reachable"}, Cloud API ${report.whatsapp.embeddedSignup ? "on" : `off${needs(report.whatsapp.embeddedSignupNeeds)}`}`,
    `email ${on({ gmail: report.email.google, outlook: report.email.microsoft, resend: report.email.resend })}`,
    `Google sign-in ${report.auth.google ? "on" : "off"}`,
    `emailed sign-in code ${report.auth.loginCode ? "on" : "off"}`,
    half.length ? `missing a secret: ${half.map((c) => c.provider).join(", ")}` : "every provider with an id has its secret",
  ].join("; ");
  return { detail, warnings };
}

if (!process.env.VITEST) await main();

async function main() {
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
  const get = requester();
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
      // Read to the end, so the connection is free for the next page and not dropped half-read.
      await r.arrayBuffer();
      expect(r.status === 200, `status ${r.status}`);
      expect((r.headers.get("content-type") ?? "").startsWith("text/html"), r.headers.get("content-type"));
    });
  }
  await check("unknown page is a 404 page", async () => {
    const r = await get(`${base}/no-such-page-${randomBytes(4).toString("hex")}`);
    expect(r.status === 404, `status ${r.status}`);
  });
  // What CloudFront shows for a page while the function can't answer (app-stack.ts): asked of the
  // fallback directly, since the app is up. Any path is the page, as a 503, and its styles and
  // scripts load through the app's address from S3, which doesn't need the function.
  await check("page shown while the app can't answer", async () => {
    const r = await get(`https://${app.FallbackDomain}/dashboard`);
    const html = await r.text();
    expect(r.status === 503, `status ${r.status}`);
    expect(/Service temporarily unavailable/.test(html), "not the unavailable page");
    expect(/no-store/.test(r.headers.get("cache-control") ?? ""), `cache-control ${r.headers.get("cache-control")}`);
    const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)]+\.(?:css|js)/g) ?? [])];
    expect(assets.some((a) => a.endsWith(".css")), "no stylesheet in the page");
    const rs = await Promise.all(assets.map((a) => get(`${base}${a}`)));
    const bad = rs.map((res, i) => [assets[i], res]).filter(([, res]) => res.status !== 200 || !fromS3(res));
    expect(!bad.length, bad.map(([a, res]) => `${a}: ${res.status} ${res.headers.get("server")}`).join("; "));
    return `${assets.length} files`;
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
  await check("WhatsApp service's webhook without its token is refused", async () => {
    const r = await get(`${base}/api/webhooks/whatsapp/evolution/bi_000000000000000000000000`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status === 401, `status ${r.status}`);
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
  // What the app has set up, asked of the cron function the way the deploy runs its migrations
  // ({"action":"config"}): booleans and setting names, never a value. A provider whose public id is in
  // the app's settings (apps/aws/src/settings.ts) but whose secret isn't in insights/<env>/app works
  // nowhere (an ad platform's card says "Coming soon", its connections stop syncing) while every
  // other check passes, so each one is a warning on the run. configCheck (above) says what fails.
  await check("app configuration read from the cron function", async () => {
    const dir = mkdtempSync(join(tmpdir(), "insights-smoke-"));
    try {
      const out = join(dir, "config.json");
      const invoke = () => {
        rmSync(out, { force: true });
        const meta = aws(["lambda", "invoke", "--function-name", `insights-${envName}-cron:live`, "--cli-binary-format", "raw-in-base64-out", "--payload", JSON.stringify({ action: "config" }), out]);
        let report = null;
        try {
          report = JSON.parse(readFileSync(out, "utf8"));
        } catch {
          // Not JSON, or not written: configCheck says it doesn't know that answer.
        }
        return { meta, report };
      };
      const { detail, warnings } = configCheck(invoke, envName);
      for (const w of warnings) console.log(w);
      return detail;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
}
