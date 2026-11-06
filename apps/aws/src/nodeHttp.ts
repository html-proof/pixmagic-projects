import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * Node's HTTP server ↔ the Fetch API's Request/Response, for the servers that run the app as a Node
 * process: the local one (local.ts) and the self-hosted one (server.ts).
 */

/** A Fetch Request for an incoming request, its URL on `origin` (the local server: the Host it was asked for). */
export function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (v !== undefined) headers.set(k, v);
  }
  const url = new URL(req.url ?? "/", origin);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
}

/** Write a Fetch Response to Node's response, streaming its body (several Set-Cookie headers kept apart). */
export async function send(res: ServerResponse, response: Response, head: boolean) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (head || !response.body) return res.end();
  await new Promise<void>((done, fail) => {
    Readable.fromWeb(response.body as never)
      .on("error", fail)
      .pipe(res)
      .on("finish", done)
      .on("error", fail);
  });
}
