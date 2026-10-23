// Ends any outgoing HTTP(S) request that goes STALL_MS without a byte either way, with ETIMEDOUT.
// Loaded into the Deploy (CDK) step's node processes through NODE_OPTIONS (aws-deploy.yml):
//
//   NODE_OPTIONS="--require <repo>/infra/cdk/scripts/stall-guard.cjs"
//
// Why: the CDK CLI (aws-cdk 2.1143.0) gives each AWS call a 5-minute requestTimeout, but its HTTP
// handler (@smithy/node-http-handler) only logs a warning when that passes (it throws only with
// throwOnRequestTimeout, which the CLI doesn't set), and with no socketTimeout configured it calls
// socket.setTimeout(0) 3 s into every request. A connection the network drops without a word then
// waits for ever. 2026-10-23, Deploy 40032504218 attempt 1: the PC went into Modern Standby,
// CloudFormation finished InsightsEdge-production in 10 s, and the CLI sat on its us-east-1 poll
// for 57 minutes until the job's limit cancelled the run.
//
// So this watches each request's socket byte counters on a timer of its own, which nothing in the
// handler can switch off. Only inactivity counts: an upload or download still moving bytes is never
// cut. The handler turns ETIMEDOUT into a TimeoutError, which the SDK retries like any dropped
// connection; if every try fails, the step's `network` pattern matches and cdk deploy runs again.
"use strict";

const http = process.getBuiltinModule("node:http");
const https = process.getBuiltinModule("node:https");
const { setInterval, clearInterval } = process.getBuiltinModule("node:timers");

const STALL_MS = Number(process.env.STALL_GUARD_MS) || 120_000;
const CHECK_MS = Math.min(5_000, Math.max(50, Math.floor(STALL_MS / 4)));

function watch(req) {
  let timer;
  const stop = () => clearInterval(timer);
  req.once("socket", (socket) => {
    let seen = socket.bytesRead + socket.bytesWritten;
    let since = Date.now();
    timer = setInterval(() => {
      if (req.destroyed) return stop();
      const now = socket.bytesRead + socket.bytesWritten;
      if (now !== seen) {
        seen = now;
        since = Date.now();
      } else if (Date.now() - since >= STALL_MS) {
        stop();
        const error = new Error(`stall-guard: no data on the connection for ${STALL_MS} ms (ETIMEDOUT)`);
        error.code = "ETIMEDOUT";
        req.destroy(error);
      }
    }, CHECK_MS);
    // A watch never keeps a process alive by itself.
    timer.unref();
  });
  req.once("close", stop);
  return req;
}

for (const mod of [http, https]) {
  const { request } = mod;
  mod.request = function guardedRequest(...args) {
    return watch(request.apply(this, args));
  };
  // get() calls the module's own request, not the export above.
  mod.get = function guardedGet(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}
