// The uptime check for production, run by Cloudflare: the Worker bizinsights-uptime asks
// https://bizinsights.io/api/readyz and /login every 10 minutes (check.mjs, the same check the GitHub
// workflow runs) and emails the owner through Email Routing when either is still wrong after a
// second look 30 seconds later. Cloudflare starts its cron triggers on time; GitHub's schedule for
// .github/workflows/uptime.yml never started a run on 2026-11-13, which is why this exists. The
// workflow stays as a second check and as the way to run one by hand.
//
// It has no address of its own (workers_dev false, no route): nothing outside can call it.
//
// Published from a checkout, by hand, into the Cloudflare account that holds bizinsights.io
// (wrangler.json's account_id: Email Routing refuses to send for a domain in another account, as it
// did when it was first published into the wrong one on 2026-11-13). Signed in with
// `npx wrangler@4.154.0 login` as a login that can open that account:
//
//   npx --yes wrangler@4.154.0 deploy --config infra/uptime/wrangler.json
//
// To see an alert arrive: publish with an address that fails added, wait for the next 10-minute
// mark, then publish again without it:
//
//   npx --yes wrangler@4.154.0 deploy --config infra/uptime/wrangler.json --var EXTRA_URLS:https://bizinsights.io/uptime-test-404
//
// Its runs and their log lines: Cloudflare dashboard → Workers & Pages → bizinsights-uptime → Logs,
// or `npx wrangler@4.154.0 tail --config infra/uptime/wrangler.json`.
import { EmailMessage } from "cloudflare:email";
import { FROM, TO, alertEmail, runOnce, urlsFrom } from "./alert.mjs";
import { check } from "./check.mjs";

export default {
  async scheduled(_controller, env) {
    await runOnce(urlsFrom(env.EXTRA_URLS), {
      checkImpl: check,
      send: (problems) => env.ALERT.send(new EmailMessage(FROM, TO, alertEmail(problems, { id: globalThis.crypto.randomUUID() }))),
    });
  },
};
