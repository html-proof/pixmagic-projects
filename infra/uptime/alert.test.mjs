// node --test infra/uptime/alert.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FROM, TO, alertEmail, runOnce, urlsFrom } from "./alert.mjs";
import { DEFAULT_URLS } from "./check.mjs";

const config = JSON.parse(readFileSync(new URL("./wrangler.json", import.meta.url), "utf8"));

test("wrangler.json: every 10 minutes, no address of its own, the alert goes where alert.mjs says", () => {
  assert.deepEqual(config.triggers.crons, ["*/10 * * * *"]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.routes, undefined);
  assert.deepEqual(config.send_email, [{ name: "ALERT", destination_address: TO }]);
  assert.match(FROM, /@bizinsights\.io$/);
});

test("urlsFrom: the usual two, plus https addresses from EXTRA_URLS", () => {
  assert.deepEqual(urlsFrom(undefined), DEFAULT_URLS);
  assert.deepEqual(urlsFrom(""), DEFAULT_URLS);
  assert.deepEqual(urlsFrom(" https://bizinsights.io/x  ftp://no http://no https://bizinsights.io/y "), [...DEFAULT_URLS, "https://bizinsights.io/x", "https://bizinsights.io/y"]);
});

test("alertEmail: headers Email Routing needs, CRLF only, a problem can't add a header", () => {
  const raw = alertEmail(["https://bizinsights.io/login answered 502", "evil\r\nBcc: someone@example.com"], { now: new Date("2026-11-13T12:00:00Z"), id: "abc" });
  assert.equal(raw.replace(/\r\n/g, "").includes("\n"), false, "no bare line feed");
  const text = raw.replace(/\r\n/g, "\n");
  const head = text.slice(0, text.indexOf("\n\n"));
  const body = text.slice(text.indexOf("\n\n") + 2);
  assert.match(head, /^From: bizinsights uptime <uptime@bizinsights\.io>$/m);
  assert.match(head, /^To: bizinsightsaus@yahoo\.com$/m);
  assert.match(head, /^Subject: bizinsights\.io is DOWN$/m);
  assert.match(head, /^Date: Fri, 13 Nov 2026 12:00:00 GMT$/m);
  assert.match(head, /^Message-ID: <abc@bizinsights\.io>$/m);
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.match(body, /^- https:\/\/bizinsights\.io\/login answered 502$/m);
  assert.match(body, /^- evil Bcc: someone@example\.com$/m);
});

test("runOnce: all well sends nothing; still wrong sends once; a failed send fails the run", async () => {
  const sent = [];
  const logs = [];
  const send = async (p) => void sent.push(p);
  const log = (s) => void logs.push(s);
  assert.deepEqual(await runOnce(["a"], { checkImpl: async () => [], send, log }), []);
  assert.equal(sent.length, 0);
  assert.deepEqual(logs, ["up: a"]);

  await runOnce(["a"], { checkImpl: async () => ["a answered 502"], send, log });
  assert.deepEqual(sent, [["a answered 502"]]);
  assert.equal(logs.at(-1), `alert sent to ${TO}`);

  await assert.rejects(runOnce(["a"], { checkImpl: async () => ["a answered 502"], send: async () => { throw new Error("destination address not verified"); }, log }), /not verified/);
});
