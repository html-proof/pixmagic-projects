// The uptime check for production: asks the public address what a visitor would, from GitHub's
// machines, so from outside both the iKorex server and AWS. Run every 10 minutes by
// .github/workflows/uptime.yml; a run that ends 1 is what tells the owner (GitHub emails a failed
// scheduled run to whoever last changed the workflow's schedule).
//
//   node infra/uptime/check.mjs [url ...]     default: the two addresses below
//
// An address must answer 200; one whose path is /api/readyz must also say {"ok":true}. A failure is
// looked at once more after 30 seconds before it counts: shipping a release restarts the web
// container, which takes a few seconds. Nothing of an answer's body is printed.
import { pathToFileURL } from "node:url";

export const DEFAULT_URLS = ["https://bizinsights.io/api/readyz", "https://bizinsights.io/login"];

/** null when the address answers as it should, otherwise what was wrong (never a body). */
export async function probe(url, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), redirect: "manual", headers: { "user-agent": "bizinsights-uptime-check", "cache-control": "no-cache" } });
    if (r.status !== 200) return `${url} answered ${r.status}`;
    if (new URL(url).pathname === "/api/readyz") {
      const body = await r.json().catch(() => null);
      if (!body || body.ok !== true) return `${url} says it is not ready`;
    }
    return null;
  } catch (err) {
    return `${url}: ${err?.name === "TimeoutError" ? "no answer within 15 seconds" : String(err?.cause?.code ?? err?.message ?? err)}`;
  }
}

/** What is wrong, after a second look when the first one found something. An empty list: all is well. */
export async function check(urls, { probeImpl = probe, wait = (ms) => new Promise((r) => setTimeout(r, ms)), retryAfterMs = 30_000 } = {}) {
  const look = async () => (await Promise.all(urls.map((u) => probeImpl(u)))).filter(Boolean);
  const first = await look();
  if (first.length === 0) return [];
  await wait(retryAfterMs);
  return look();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const urls = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_URLS;
  const problems = await check(urls);
  if (problems.length === 0) {
    console.log(`up: ${urls.join(", ")}`);
  } else {
    // GitHub shows an ::error:: line on the run's page and in its email; one line each, no % or line break.
    for (const p of problems) console.log(`::error title=bizinsights.io is DOWN::${p.replace(/[%\r\n]/g, " ")} (checked twice, 30 seconds apart)`);
    process.exitCode = 1;
  }
}
