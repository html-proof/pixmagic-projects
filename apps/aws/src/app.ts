import { googleSignInConfig, localAuth, prismaAuthStore, type CognitoAuth, type Deps } from "@app/api";
import type { WorkerDeps } from "@app/worker";
import { logger, withTimeout } from "@app/core";

/**
 * What the server (selfhost.ts) and the local server (local.ts) share: the API's dependencies on
 * top of the jobs' own. Which requests are the API's is paths.ts.
 */

/** Time limit for sign-in's outbound calls (Google's token exchange and keys). */
const AUTH_TIMEOUT_MS = 10_000;

/**
 * Requests a minute per client address across the whole API (Cloudflare stops floods before
 * this). One address is often many people (an office, a mobile
 * carrier's NAT), so this is about a hundred dashboard loads a minute from one address, not one
 * person's pace.
 */
const GLOBAL_LIMIT_PER_MIN = 1500;

export function apiDeps(jobs: WorkerDeps): Deps {
  return {
    ...jobs,
    auth: signIn(jobs),
    globalLimit: async (ip) => (await jobs.coord.hit(`rl:global:${ip}`, 60)) <= GLOBAL_LIMIT_PER_MIN,
  };
}

/**
 * Who checks sign-ins: the app's own sign-in (apps/api/src/localAuth.ts), with Google on the app's
 * own OAuth client when it is configured. (The type is named after Cognito, the provider it replaced.)
 */
function signIn(jobs: WorkerDeps): CognitoAuth {
  // Sign-in's calls to Google: a shorter limit than other providers.
  const authFetch = withTimeout((input, init) => fetch(input, init), AUTH_TIMEOUT_MS);
  const google = googleSignInConfig();
  logger.info({ google: !!google }, "sign-in: the app's own");
  return localAuth({ store: prismaAuthStore(), coord: jobs.coord, mailer: jobs.mailer, fetchImpl: authFetch, google });
}
