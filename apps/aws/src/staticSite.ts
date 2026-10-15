import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * The static UI (the Next.js export) served from the function's own package, the way Workers
 * Static Assets serves it on Cloudflare: /login is login.html, unknown paths get 404.html with a
 * 404, and the rules in public/_headers (security headers) apply to every file.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

/** The "/*" block of a Cloudflare-style _headers file. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inAll = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === "/*";
      continue;
    }
    const i = line.indexOf(":");
    if (inAll && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function staticSite(root: string) {
  const files = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.add(`/${relative(root, full).split(sep).join("/")}`);
    }
  };
  walk(root);
  const headers = files.has("/_headers") ? parseHeaders(readFileSync(join(root, "_headers"), "utf8")) : {};

  const respond = (file: string, status = 200) => {
    const ext = extname(file);
    return new Response(readFileSync(join(root, file)), {
      status,
      headers: {
        ...headers,
        "content-type": TYPES[ext] ?? "application/octet-stream",
        // Next's hashed build files never change; pages must be re-checked.
        "cache-control": file.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };

  return (request: Request): Response => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (path.includes("\0") || path.split("/").includes("..") || path === "/_headers") return respond404();
    const bare = path.length > 1 ? path.replace(/\/+$/, "") : path;
    for (const candidate of [path, `${bare}.html`, `${bare}/index.html`, path === "/" ? "/index.html" : ""]) {
      if (candidate && files.has(candidate)) return respond(candidate);
    }
    return respond404();
  };

  function respond404() {
    return files.has("/404.html") ? respond("/404.html", 404) : new Response("Not found", { status: 404 });
  }
}
