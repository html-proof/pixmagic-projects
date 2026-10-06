import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the one piece of configuration Shopify reads instead of us.
 *
 * With `use_legacy_install_flow = false` (Shopify managed installation) the merchant is asked
 * to grant exactly the scopes declared in `shopify.app*.toml`. The `scope` parameter our
 * authorize URL carries is IGNORED, so SHOPIFY_SCOPES in the Worker env cannot widen, narrow
 * or correct what is actually granted — it only decides what we believe we asked for.
 *
 * That asymmetry has already cost a production outage: the optional protected-customer-data
 * scopes were cleared from the Worker env to stop Shopify refusing installs, but stayed
 * declared in the toml, so every live merchant store kept being refused while development
 * stores (exempt from protected customer data review) kept working. These tests fail the
 * build when the toml and the env defaults drift apart again.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

/** `key = "value"` at the top level of a toml, ignoring commented-out lines. */
function tomlString(toml: string, key: string): string | null {
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
  return m ? m[1]! : null;
}

/** `key = [...]` — null when the key is absent or only present commented out. */
function tomlArray(toml: string, key: string): string[] | null {
  const m = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(toml);
  if (!m) return null;
  return [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

/** `KEY=value` from a dotenv file, or `"KEY": "value"` from wrangler's jsonc vars. */
function envValue(text: string, key: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
    // jsonc: `"KEY": "value",` — the trailing comma belongs to the object, not the value.
    const jsonc = new RegExp(`^"${key}"\\s*:\\s*"([^"]*)"\\s*,?$`).exec(line);
    if (jsonc) return jsonc[1]!;
  }
  return null;
}

const APP_CONFIGS = ["shopify-app/shopify.app.toml", "shopify-app/shopify.app.pixmagic.toml"];
/** Mirrors the default in packages/core/src/env.ts. */
const ENV_SCOPES = "read_orders,read_products";
/**
 * The optional (post-install) scopes every app declares. Only these can be requested: a
 * dashboard "Enable" button is built from `declaredOptionalScopes`, so this list, the
 * `optional_scopes` in both tomls and the shipped env must agree exactly.
 */
const ENV_OPTIONAL_SCOPES = ["read_customers", "write_pixels", "read_customer_events"];

describe("Shopify app configuration", () => {
  for (const path of APP_CONFIGS) {
    describe(path, () => {
      const toml = read(path);

      it("uses Shopify managed installation", () => {
        // If this is ever flipped to true, the scope parameter in buildAuthorizeUrl becomes
        // authoritative and the assertions below stop describing what merchants are granted.
        expect(tomlString(toml, "use_legacy_install_flow")).toBeNull();
        expect(/^use_legacy_install_flow\s*=\s*false/m.test(toml)).toBe(true);
      });

      it("declares exactly the scopes the app expects to be granted", () => {
        expect(tomlString(toml, "scopes")).toBe(ENV_SCOPES);
      });

      it("declares exactly the optional scopes the app knows how to request", () => {
        // Enabled 2026-10-04 so merchants can unlock the customers and funnel modules
        // themselves. The guard that matters is no longer "declare nothing" but "declare the
        // same thing everywhere": a scope in the env that the toml does not declare offers an
        // "Enable" button that lands the merchant on a Shopify error, which is the drift that
        // caused the outage described at the top of this file. Both apps must match.
        expect(tomlArray(toml, "optional_scopes")).toEqual(ENV_OPTIONAL_SCOPES);
      });

      it("points every Shopify callback at one host", () => {
        const appUrl = tomlString(toml, "application_url")!;
        const host = new URL(appUrl).origin;
        expect(appUrl).toBe(`${host}/api/shopify/launch`);
        expect(tomlArray(toml, "redirect_urls")).toEqual([`${host}/api/shopify/callback`]);
        for (const uri of [...toml.matchAll(/^\s*uri\s*=\s*"([^"]*)"/gm)].map((m) => m[1]!)) {
          expect(uri).toBe(`${host}/api/webhooks/shopify`);
        }
      });
    });
  }

  it("keeps every app on the same API version and URLs", () => {
    const [main, ...others] = APP_CONFIGS.map(read);
    const shape = (t: string) => ({
      apiVersion: tomlString(t, "api_version"),
      applicationUrl: tomlString(t, "application_url"),
      scopes: tomlString(t, "scopes"),
      embedded: /^embedded\s*=\s*(\w+)/m.exec(t)?.[1],
    });
    for (const other of others) expect(shape(other)).toEqual(shape(main!));
  });

  /**
   * The checks above compare the tomls with ENV_SCOPES, a constant, which left the config we
   * actually ship unchecked — and it drifted. The Worker env and `.env.example` kept declaring
   * the protected-customer-data optional scopes long after they were removed from the tomls.
   * Under managed installation that drift cannot change what Shopify grants, which is exactly
   * why nothing surfaced it: it only made our logs and authorize URLs claim scopes the app
   * neither asks for nor can obtain, pointing the next person debugging an install at a cause
   * that had already been fixed. Check the files themselves, not a constant describing them.
   */
  describe("the shipped configuration matches the tomls", () => {
    for (const path of ["apps/cloudflare/wrangler.jsonc", ".env.example"]) {
      const text = read(path);

      it(`${path} asks for the scopes the main app declares`, () => {
        expect(envValue(text, "SHOPIFY_SCOPES")).toBe(tomlString(read(APP_CONFIGS[0]!), "scopes"));
      });

      it(`${path} mirrors the optional scopes the tomls declare`, () => {
        // `declaredOptionalScopes` reads this var to decide what the dashboard may offer, while
        // Shopify grants only what the toml declares. An entry here the toml lacks would offer
        // merchants an "Enable" button that lands them on a Shopify error; an entry in the toml
        // missing here would hide a feature the app could actually unlock. Hence exact mirror.
        expect(envValue(text, "SHOPIFY_OPTIONAL_SCOPES")).toBe(ENV_OPTIONAL_SCOPES.join(","));
        expect(tomlArray(read(APP_CONFIGS[0]!), "optional_scopes")).toEqual(ENV_OPTIONAL_SCOPES);
      });
    }

    /**
     * Shopify matches `redirect_uri` against its allowlist exactly, and we build that URI at
     * runtime as `${APP_URL}/api/shopify/callback` (apps/api/src/routes/shopify.ts). So the
     * deployed APP_URL has to be the same origin the toml registered — moving the Worker to a
     * custom domain by editing APP_URL alone would make Shopify reject every callback, and
     * until now nothing here would have caught it: the scope checks above read wrangler.jsonc,
     * but the URL checks only ever compared each toml against itself.
     *
     * Only the deployed config is checked. `.env.example` points at localhost on purpose.
     */
    it("the deployed APP_URL is the origin the main app registered with Shopify", () => {
      const appUrl = envValue(read("apps/cloudflare/wrangler.jsonc"), "APP_URL")!;
      const registered = new URL(tomlString(read(APP_CONFIGS[0]!), "application_url")!).origin;
      expect(appUrl).toBe(registered);
      // A trailing slash would build `…//api/shopify/callback`, which Shopify would not match.
      expect(appUrl.endsWith("/")).toBe(false);
    });
  });

  it("has a real client id for the app we actually deploy", () => {
    // The extra-app configs may still hold a placeholder until that client app is created,
    // but the main app must always be deployable.
    expect(tomlString(read(APP_CONFIGS[0]!), "client_id")).toMatch(/^[0-9a-f]{32}$/);
  });
});
