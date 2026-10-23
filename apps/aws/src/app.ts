import { timingSafeEqual } from "node:crypto";
import { cognitoAuth, cognitoConfig, unconfiguredCognito, type Deps } from "@app/api";
import type { WorkerDeps } from "@app/worker";
import { logger, withTimeout } from "@app/core";

/**
 * What the Lambda functions (index.ts) and the local server (local.ts) share: which requests are
 * the API's, and the API's dependencies on top of the jobs' own.
 */

/** API paths served without the /api prefix (webhooks, pixel, Shopify, health checks). */
const BARE_API = /^\/(webhooks|pixel|shopify)\/|^\/(healthz|readyz)$/;
const API_PREFIX = /^\/api(\/|$)/;

/** The API route a path is for (`/api/me` → `/me`), or null for the static UI. */
export function apiPath(pathname: string): string | null {
  if (API_PREFIX.test(pathname)) return pathname.slice(4) || "/";
  if (BARE_API.test(pathname)) return pathname;
  return null;
}

/**
 * Who sent an API request to the function URL: CloudFront (it carries the origin secret CloudFront
 * adds, compared in constant time), someone calling the URL directly ("forbidden": that would go
 * around WAF), or nobody can tell because the secret isn't configured. In production it always is
 * (the Data stack creates it in the app's secret, CloudFront sends it), so a missing one is a broken
 * configuration and is refused too ("unconfigured"); elsewhere there is no CloudFront ("direct").
 */
export function originCheck(given: string | null, expected: string | undefined, production: boolean): "cloudfront" | "forbidden" | "unconfigured" | "direct" {
  if (!expected) return production ? "unconfigured" : "direct";
  if (!given) return "forbidden";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? "cloudfront" : "forbidden";
}

/** Time limit for calls to Cognito (sign-in, token exchange, session re-checks). */
const AUTH_TIMEOUT_MS = 10_000;

/**
 * Requests a minute per client address across the whole API (AWS WAF stops floods before this,
 * with the same figure: edge-stack.ts). One address is often many people (an office, a mobile
 * carrier's NAT), so this is about a hundred dashboard loads a minute from one address, not one
 * person's pace.
 */
const GLOBAL_LIMIT_PER_MIN = 1500;

export function apiDeps(jobs: WorkerDeps): Deps {
  // Cognito sits on the sign-in path: a shorter limit than other providers.
  const authFetch = withTimeout((input, init) => fetch(input, init), AUTH_TIMEOUT_MS);
  const cognito = cognitoConfig();
  if (!cognito) logger.error({}, "COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are not set: every sign-in will answer 503");
  return {
    ...jobs,
    auth: cognito ? cognitoAuth(cognito, authFetch) : unconfiguredCognito(),
    globalLimit: async (ip) => (await jobs.coord.hit(`rl:global:${ip}`, 60)) <= GLOBAL_LIMIT_PER_MIN,
  };
}
