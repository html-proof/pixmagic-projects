#!/usr/bin/env node
// A stand-in for Mailpit's HTTP API, for e2e where Docker isn't available (the self-hosted CI
// runner, a PC with Docker Desktop off). It keeps messages in memory and answers only what the app
// (POST /api/v1/send, packages/core mailpitMailer) and the specs use: search by `to:`, read one,
// delete all.
//
//   node apps/web/e2e/mailpit-stub.mjs [port]      (default 8025), then E2E_MAILPIT_URL=http://127.0.0.1:<port>
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8025);
/** Newest first, like Mailpit's search. */
let messages = [];
let next = 1;

const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    if (req.method === "POST" && url.pathname === "/api/v1/send") {
      const m = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const ID = String(next++);
      messages.unshift({ ID, From: m.From, To: m.To ?? [], Subject: m.Subject ?? "", Text: m.Text ?? "", HTML: m.HTML ?? "", ReplyTo: m.ReplyTo ?? [] });
      return reply(res, 200, { ID });
    }
    if (req.method === "DELETE" && url.pathname === "/api/v1/messages") {
      messages = [];
      return reply(res, 200, "ok");
    }
    if (req.method === "GET" && url.pathname === "/api/v1/search") {
      const to = /^to:(.+)$/i.exec(url.searchParams.get("query") ?? "")?.[1]?.toLowerCase();
      const found = messages.filter((m) => !to || m.To.some((t) => String(t.Email).toLowerCase() === to));
      return reply(res, 200, { total: messages.length, messages_count: found.length, messages: found });
    }
    const one = /^\/api\/v1\/message\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      const m = messages.find((x) => x.ID === one[1]);
      return m ? reply(res, 200, m) : reply(res, 404, { error: "not found" });
    }
    return reply(res, 404, { error: "not in the stand-in" });
  } catch (err) {
    return reply(res, 400, { error: String(err) });
  }
}).listen(port, "127.0.0.1", () => console.log(`Mailpit stand-in on http://127.0.0.1:${port}`));
