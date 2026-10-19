import { afterAll, it } from "vitest";
import { fillAdPersons } from "@app/core";
import { disconnectDb } from "@app/db";

/**
 * Fill in who granted access (Google's account id, Meta's app-scoped user id) for ad connections that
 * don't know it: made before bizinsights kept it, or the look-up failed when they were connected.
 * Until they know, a disconnect looks them up itself, a few at a time, and keeps the grant for any it
 * can't place. Each sign-in is looked up once (a token refresh for Google first); a token that no
 * longer works marks its connections "reconnect". Safe to repeat. OPS_LIMIT caps the sign-ins (200).
 *   pnpm --filter @app/worker ops:ad-persons
 */
afterAll(async () => disconnectDb());

it("fills in who granted each ad connection's access", async () => {
  const limit = process.env.OPS_LIMIT ? Number(process.env.OPS_LIMIT) : undefined;
  const r = await fillAdPersons({ limit });
  console.log(`learned ${r.learned}, access ended ${r.ended}, not known ${r.unknown}; ${r.remaining} connections still without a person`);
});
