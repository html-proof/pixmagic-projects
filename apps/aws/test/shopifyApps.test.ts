import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_STORE_APP, APP_STORE_APPS } from "@app/core";
import { APP_SETTINGS } from "../src/settings.js";

/**
 * The Shopify apps production ships (SHOPIFY_EXTRA_APPS) against their tomls. One unreadable entry
 * disables every extra app (packages/core/src/apps.ts), and a client id that isn't the toml's
 * sends merchants to an app whose launches and webhooks we can't verify. The CDK tests read these
 * settings only in Deploy to AWS, after the merge: this runs on the pull request.
 */
const toml = (name: string) => readFileSync(fileURLToPath(new URL(`../../../shopify-app/${name}`, import.meta.url)), "utf8");
const clientId = (text: string) => /^client_id\s*=\s*"([^"]*)"/m.exec(text)?.[1];

describe("the Shopify apps in the shipped settings", () => {
  const extras = JSON.parse(APP_SETTINGS.SHOPIFY_EXTRA_APPS) as Array<{ key: string; clientId: string; shops?: string[] }>;

  it("are readable, with unique lowercase keys", () => {
    expect(Array.isArray(extras)).toBe(true);
    for (const a of extras) {
      expect(a.key).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(a.key).not.toBe("default");
      expect(a.clientId).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(new Set(extras.map((a) => a.key)).size).toBe(extras.length);
  });

  it("each use the client id of their own toml", () => {
    expect(clientId(toml("shopify.app.toml"))).toBe(APP_SETTINGS.SHOPIFY_API_KEY);
    for (const a of extras) expect(clientId(toml(`shopify.app.${a.key}.toml`)), a.key).toBe(a.clientId);
  });

  it("include every App Store app, installable on any store", () => {
    expect(APP_STORE_APPS[0]).toBe(APP_STORE_APP);
    for (const key of APP_STORE_APPS) expect(extras.find((a) => a.key === key)?.shops ?? null, key).toEqual([]);
  });
});
