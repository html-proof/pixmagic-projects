import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/stall-guard.cjs, which Deploy (CDK) loads into the CDK CLI: a request that goes quiet ends
 * with ETIMEDOUT instead of waiting for ever (Deploy 40032504218 sat 57 minutes on one). Each case
 * runs a fresh node with the guard preloaded, as NODE_OPTIONS does, at a 300 ms stall limit.
 */
const GUARD = fileURLToPath(new URL("../scripts/stall-guard.cjs", import.meta.url));
const STALL_MS = 300;

/** Runs `code` in a node with the guard; resolves with what it printed and how long it took. */
function run(code: string, env: Record<string, string>): Promise<{ out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--require", GUARD, "-e", code], { env: { ...process.env, STALL_GUARD_MS: String(STALL_MS), ...env }, timeout: 20_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({ out: stdout.trim(), ms: Date.now() - started }),
    );
  });
}

/** Prints the request's outcome: "ok <status> <body>" or "error <code> <message>". */
const REPORT = `
  const report = (req) => {
    req.on("response", (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => console.log("ok", res.statusCode, body)); });
    req.on("error", (e) => console.log("error", e.code, e.message));
    req.end();
  };`;

let silent: TcpServer;
let silentPort = 0;
const held: Socket[] = [];
let trickle: Server;
let tricklePort = 0;

beforeAll(async () => {
  // Accepts connections and never says a word, like a connection the network dropped.
  silent = createTcpServer((socket) => {
    held.push(socket);
    socket.on("error", () => {});
  });
  // Answers slowly but without a gap as long as the limit: one byte every 100 ms for a second.
  trickle = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    let sent = 0;
    const timer = setInterval(() => {
      res.write("x");
      if (++sent === 10) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
  });
  await Promise.all([
    new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve())),
    new Promise<void>((resolve) => trickle.listen(0, "127.0.0.1", () => resolve())),
  ]);
  silentPort = (silent.address() as { port: number }).port;
  tricklePort = (trickle.address() as { port: number }).port;
});

afterAll(() => {
  for (const socket of held) socket.destroy();
  silent.close();
  trickle.close();
});

describe("stall-guard", () => {
  it("ends an HTTP request that gets no answer with ETIMEDOUT", async () => {
    const { out, ms } = await run(`${REPORT} report(require("node:http").request({ host: "127.0.0.1", port: process.env.PORT, path: "/" }));`, { PORT: String(silentPort) });
    expect(out).toMatch(/^error ETIMEDOUT stall-guard: no data on the connection for 300 ms \(ETIMEDOUT\)$/);
    expect(ms).toBeLessThan(10_000);
  });

  it("ends an HTTPS request whose TLS handshake never gets an answer", async () => {
    const { out } = await run(`${REPORT} report(require("node:https").request({ host: "127.0.0.1", port: process.env.PORT, path: "/" }));`, { PORT: String(silentPort) });
    expect(out).toMatch(/^error ETIMEDOUT /);
  });

  it("isn't switched off by socket.setTimeout(0), which the CLI's HTTP handler calls 3 s into a request", async () => {
    const { out } = await run(
      `${REPORT}
      const req = require("node:http").request({ host: "127.0.0.1", port: process.env.PORT, path: "/" });
      req.on("socket", (socket) => { socket.setTimeout(0); req.setTimeout(0); setTimeout(() => socket.setTimeout(0), 100); });
      report(req);`,
      { PORT: String(silentPort) },
    );
    expect(out).toMatch(/^error ETIMEDOUT /);
  });

  it("covers http.get too", async () => {
    const { out } = await run(
      `const req = require("node:http").get({ host: "127.0.0.1", port: process.env.PORT, path: "/" }, () => console.log("answered"));
      req.on("error", (e) => console.log("error", e.code));`,
      { PORT: String(silentPort) },
    );
    expect(out).toBe("error ETIMEDOUT");
  });

  it("lets a slow answer through while bytes keep coming, for longer than the limit in all", async () => {
    const { out, ms } = await run(`${REPORT} report(require("node:http").request({ host: "127.0.0.1", port: process.env.PORT, path: "/" }));`, { PORT: String(tricklePort) });
    expect(out).toBe("ok 200 xxxxxxxxxx");
    expect(ms).toBeGreaterThan(STALL_MS);
  });

  it("leaves nothing running once requests on a kept-alive connection are done", async () => {
    // The process exits as soon as the second answer is in: no timer of the guard's keeps it up,
    // and the idle pooled socket isn't cut while it waits (its request is over).
    const { out, ms } = await run(
      `const http = require("node:http");
      const agent = new http.Agent({ keepAlive: true });
      const get = () => new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: process.env.PORT, path: "/", agent }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)); }).on("error", reject));
      get().then(() => new Promise((r) => setTimeout(r, ${STALL_MS * 3}))).then(get).then((b) => { console.log("ok", b.length); agent.destroy(); }, (e) => console.log("error", e.code));`,
      { PORT: String(tricklePort) },
    );
    expect(out).toBe("ok 10");
    expect(ms).toBeLessThan(10_000);
  });
});

describe("Deploy (CDK) in aws-deploy.yml", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/aws-deploy.yml", import.meta.url), "utf8");
  const step = /^ {6}- name: Deploy \(CDK\)\n((?: {8}.*\n)+)/m.exec(workflow.replace(/\r\n/g, "\n"))?.[1] ?? "";
  const jobLimit = Number(/^ {2}deploy:\n(?: {4}.*\n)*? {4}timeout-minutes: (\d+)/m.exec(workflow.replace(/\r\n/g, "\n"))?.[1]);

  it("preloads the guard into the CLI, alongside the connect setting", () => {
    expect(step).toMatch(/NODE_OPTIONS: "--network-family-autoselection-attempt-timeout=5000 --require \$\{\{ github\.workspace \}\}\/infra\/cdk\/scripts\/stall-guard\.cjs"/);
  });

  it("has a limit of its own under the job's, so a hang fails the step and the rollback still runs", () => {
    const stepLimit = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]);
    expect(stepLimit).toBeGreaterThan(0);
    expect(jobLimit).toBeGreaterThan(stepLimit + 5);
  });

  it("runs cdk deploy again on the guard's error", () => {
    const network = new RegExp(/^\s*network='([^']+)'\s*$/m.exec(step)?.[1] ?? "(?!)");
    expect(network.test("stall-guard: no data on the connection for 120000 ms (ETIMEDOUT)")).toBe(true);
  });
});
