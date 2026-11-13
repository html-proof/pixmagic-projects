import { cognitoAuth, cognitoConfig, googleSignInConfig, localAuth, migratingAuth, prismaAuthStore, unconfiguredCognito, type CognitoAuth, type Deps } from "@app/api";
import type { WorkerDeps } from "@app/worker";
import { env, logger, withTimeout } from "@app/core";

/**
 * What the server (selfhost.ts) and the local server (local.ts) share: the API's dependencies on
 * top of the jobs' own. Which requests are the API's is paths.ts.
 */

/** Time limit for calls to Cognito (sign-in, token exchange, session re-checks). */
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
 * Who checks sign-ins (AUTH_MODE, docs/ikorex-migration): Cognito, the app's own sign-in with
 * Cognito behind it while its users move over, or the app's own alone once Cognito is gone.
 */
function signIn(jobs: WorkerDeps): CognitoAuth {
  // Sign-in calls (Cognito, Google): a shorter limit than other providers.
  const authFetch = withTimeout((input, init) => fetch(input, init), AUTH_TIMEOUT_MS);
  const mode = env().AUTH_MODE;
  const cfg = cognitoConfig();
  if (!cfg && mode !== "local") logger.error({}, "COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are not set: every sign-in will answer 503");
  const cognito = cfg ? cognitoAuth(cfg, authFetch) : unconfiguredCognito();
  if (mode === "cognito") return cognito;
  const google = googleSignInConfig();
  const local = localAuth({ store: prismaAuthStore(), coord: jobs.coord, mailer: jobs.mailer, fetchImpl: authFetch, google, findCognitoUsers: mode === "local" });
  logger.info({ mode, google: !!google }, "sign-in: the app's own");
  return mode === "local" ? local : migratingAuth({ local, cognito, coord: jobs.coord, mailer: jobs.mailer, localGoogle: !!google });
}
