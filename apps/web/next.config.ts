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
    // `out` and `out-deploy` are what gets deployed (wrangler.jsonc, apps/cloudflare/scripts/deploy.mjs).
    // A build wired to the Auth emulator (docs/local-dev.md has developers put it in .env.local,
    // which `next build` reads) signs nobody in anywhere else.
    if (["out", "out-deploy"].includes(exportDir || "out") && process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR) {
      throw new Error(
        `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR is set, and this build goes to \`${exportDir || "out"}\`, which is what gets deployed. ` +
          "Build into another folder (NEXT_EXPORT_DIR=out-local) or unset it.",
      );
    }
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
