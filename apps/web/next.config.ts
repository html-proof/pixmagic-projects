import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// The UI is fully client-rendered, so it ships as a static export served by the
// Cloudflare Worker (Workers Static Assets). The same Worker answers /api/*, so
// the browser talks to one origin and session cookies stay first-party.
// Security headers for the static files live in public/_headers.
export default function config(phase: string): NextConfig {
  const base: NextConfig = {
    images: { unoptimized: true },
    transpilePackages: ["@app/shared"],
  };
  if (phase !== PHASE_DEVELOPMENT_SERVER) {
    // NEXT_EXPORT_DIR builds into another folder than `out` (e.g. while `wrangler dev` is serving `out`).
    const exportDir = process.env.NEXT_EXPORT_DIR;
    return { ...base, output: "export", ...(exportDir ? { distDir: exportDir } : {}) };
  }
  // `next dev` only: proxy /api/* to `wrangler dev` so the UI can hot-reload against the real Worker.
  return {
    ...base,
    async rewrites() {
      const api = process.env.API_INTERNAL_URL ?? "http://localhost:8787/api";
      return [{ source: "/api/:path*", destination: `${api}/:path*` }];
    },
  };
}
