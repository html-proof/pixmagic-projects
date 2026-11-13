// What the Cloudflare uptime Worker (worker.mjs) decides and sends, kept apart from Cloudflare's own
// modules so Node's test runner can check it: node --test infra/uptime/alert.test.mjs.
//
// The email goes through Cloudflare Email Routing on bizinsights.io: the sender must be an address
// on that domain, the receiver a verified destination address of its Email Routing (wrangler.json's
// send_email binding names it, and alert.test.mjs holds the two together).
import { DEFAULT_URLS } from "./check.mjs";

export const FROM = "uptime@bizinsights.io";
export const TO = "bizinsightsaus@yahoo.com";

/** The addresses to ask: the usual two, plus any in EXTRA_URLS (spaces between), used to see a failure. */
export function urlsFrom(extra) {
  const more = String(extra ?? "")
    .split(/\s+/)
    .filter((u) => /^https:\/\//.test(u));
  return [...DEFAULT_URLS, ...more];
}

/** One header-safe line: no line break can start a header or end the message early. */
const line = (s) => String(s).replace(/[\r\n]+/g, " ");

/** The raw message (RFC 5322, CRLF line ends), plain text. `id` is the part of the Message-ID before "@". */
export function alertEmail(problems, { now = new Date(), id }) {
  const body = [
    "bizinsights.io is DOWN. Checked from Cloudflare, twice, 30 seconds apart:",
    "",
    ...problems.map((p) => `- ${line(p)}`),
    "",
    "Another email follows every 10 minutes while it stays down. When they stop, it is back:",
    "https://bizinsights.io/api/readyz says {\"ok\":true} again.",
    "",
    "Sent by the Worker bizinsights-uptime (infra/uptime/worker.mjs).",
  ];
  return [
    `From: bizinsights uptime <${FROM}>`,
    `To: ${TO}`,
    `Subject: bizinsights.io is DOWN`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${line(id)}@bizinsights.io>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...body,
    "",
  ].join("\r\n");
}

/**
 * One scheduled run: ask, and when something is still wrong after the second look, send the alert.
 * A failed send throws, so Cloudflare marks the run as failed in the Worker's logs.
 */
export async function runOnce(urls, { checkImpl, send, log = console.log }) {
  const problems = await checkImpl(urls);
  if (problems.length === 0) {
    log(`up: ${urls.join(", ")}`);
    return problems;
  }
  log(`DOWN: ${problems.map(line).join("; ")}`);
  await send(problems);
  log(`alert sent to ${TO}`);
  return problems;
}
