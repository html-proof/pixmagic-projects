import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIRED_AD_SCOPE } from "../src/ads/common.js";

/**
 * Guards the one piece of configuration Shopify reads instead of us.
 *
 * With `use_legacy_install_flow = false` (Shopify managed installation) the merchant is asked
 * to grant exactly the scopes declared in `shopify.app*.toml`. The `scope` parameter our
 * authorize URL carries is IGNORED, so SHOPIFY_SCOPES in the app's settings cannot widen, narrow
 * or correct what is actually granted — it only decides what we believe we asked for.
 *
 * That asymmetry has already cost a production outage: the optional protected-customer-data
 * scopes were cleared from the app's settings to stop Shopify refusing installs, but stayed
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

/** `KEY=value` from a dotenv file, or `"KEY": "value",` from the settings module. */
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

const APP_CONFIGS = [
  "shopify-app/shopify.app.toml",
  "shopify-app/shopify.app.pixmagic.toml",
  "shopify-app/shopify.app.public.toml",
  "shopify-app/shopify.app.appstore.toml",
];
/** Mirrors the default in packages/core/src/env.ts. */
const ENV_SCOPES = "read_orders,read_products";
/**
 * The optional (post-install) scopes every app declares. Only these can be requested: a
 * dashboard "Enable" button is built from `declaredOptionalScopes`, so this list, the
 * `optional_scopes` in both tomls and the shipped env must agree exactly.
 */
const ENV_OPTIONAL_SCOPES = ["read_customers", "write_pixels", "read_customer_events", "read_inventory", "read_locations", "write_inventory"];

describe("Shopify app configuration", () => {
  for (const path of APP_CONFIGS) {
    describe(path, () => {
      const toml = read(path);

      it("sets each top-level key once", () => {
        // TOML forbids a repeated key, so `shopify app deploy` refuses the file outright, and the
        // single-match readers below only ever see the first copy. Two merged branches once left
        // both an old and a new `name`/`application_url` here, and the address change silently
        // never reached Shopify: "Continue with Shopify" kept landing on the retired host.
        const top = toml.split(/^\s*\[/m)[0]!;
        const keys = [...top.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]!);
        expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
      });

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
   * actually ship unchecked — and it drifted. The app's settings (and the old root `.env.example`,
   * which no longer carries app settings: local dev inherits these) kept declaring
   * the protected-customer-data optional scopes long after they were removed from the tomls.
   * Under managed installation that drift cannot change what Shopify grants, which is exactly
   * why nothing surfaced it: it only made our logs and authorize URLs claim scopes the app
   * neither asks for nor can obtain, pointing the next person debugging an install at a cause
   * that had already been fixed. Check the files themselves, not a constant describing them.
   */
  describe("the shipped configuration matches the tomls", () => {
    for (const path of ["apps/aws/src/settings.ts"]) {
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
     * deployed APP_URL has to be the origin the tomls register. Production is the AWS deployment
     * (docs/aws-deployment.md), whose APP_URL is its CloudFront address, set from the distribution
     * at deploy time, so it can't be read from a file here; moving to another address means
     * changing it in both tomls and running `shopify app deploy`. What can be checked: https, and
     * not the retired Cloudflare address (workers.dev).
     */
    it("registers the production address with Shopify", () => {
      const registered = new URL(tomlString(read(APP_CONFIGS[0]!), "application_url")!);
      expect(registered.protocol).toBe("https:");
      expect(registered.hostname.endsWith(".workers.dev")).toBe(false);
    });

    /**
     * The Admin API calls (SHOPIFY_API_VERSION) and the webhook payloads (the toml's api_version)
     * must be one version: the worker parses webhooks with the same schemas as API results.
     */
    it("calls the Admin API on the version the webhooks are sent in", () => {
      expect(envValue(read("apps/aws/src/settings.ts"), "SHOPIFY_API_VERSION")).toBe(tomlString(read(APP_CONFIGS[0]!), "api_version"));
    });

    /**
     * Shopify serves a stable version for about a year (each one is accessible until the 16th of
     * the month, twelve months after its release) and then silently answers with a newer one; App
     * Store review also refuses apps on a version that ends within 90 days. 2025-10 reached that
     * end unnoticed, so this fails once fewer than 90 days are left: bump the version in
     * settings.ts and both tomls, check every query against the new schema, run
     * `shopify app deploy`. https://shopify.dev/docs/api/usage/versioning
     */
    it("uses a Shopify API version that stays available for at least 90 more days", () => {
      const version = envValue(read("apps/aws/src/settings.ts"), "SHOPIFY_API_VERSION")!;
      const [year, month] = version.split("-").map(Number) as [number, number];
      const accessibleUntil = Date.UTC(year + 1, month - 1, 16, 15);
      const daysLeft = (accessibleUntil - Date.now()) / 86_400_000;
      expect(daysLeft, `Shopify API ${version} stops being served on ${new Date(accessibleUntil).toISOString()}`).toBeGreaterThan(90);
    });
  });

  it("has a real client id for the app we actually deploy", () => {
    // The extra-app configs may still hold a placeholder until that client app is created,
    // but the main app must always be deployable.
    expect(tomlString(read(APP_CONFIGS[0]!), "client_id")).toMatch(/^[0-9a-f]{32}$/);
  });
});

/**
 * The ad platforms' and WhatsApp's API versions, pinned in apps/aws/src/settings.ts, end on dates
 * their makers announce. Google refuses every call to a sunset Google Ads version, so on that day
 * every Google Ads account would show "Sync problem"; Meta does the same to a Marketing API or Graph
 * API version past its end. This fails the build 90 days before the end, like the Shopify check
 * above: move to a newer version, check every query and field against its changelog, and add the
 * new version's end date here.
 *
 * End dates, as published (checked 2026-10-19):
 *   - Google Ads: https://developers.google.com/google-ads/api/docs/sunset-dates gives a month,
 *     and a version may be turned off on any day of it, so its first day counts. Google dates each
 *     version when it is released, so none is ever unknown here.
 *   - Meta: https://developers.facebook.com/docs/graph-api/changelog. META_API_VERSION reads ads
 *     (Marketing API, whose versions end sooner); WHATSAPP_API_VERSION is the Graph API (Cloud API).
 *     A version still marked "TBD" there has `ends: null` and its release date. Meta promises only
 *     90 days after the next version comes out, and then says the end date in the changelog, so a
 *     TBD version is counted as ending when the shortest-lived dated version in its list would
 *     have (Marketing API v24.0: 363 days, which puts v25.0 at 2027-02-16), and the changelog has
 *     to be read again within 180 days, or 60 once a newer version is out (then Meta may announce
 *     the end at any time). Read it again and update `checked` (and the date, once there is one).
 */
interface VersionDates {
  /** Needed for a version whose end is still TBD, and to learn how long a version lasts. */
  released?: string;
  ends: string | null;
}
const API_VERSION_ENDS: Record<string, { checked: string; versions: Record<string, VersionDates>; source: string }> = {
  GOOGLE_ADS_API_VERSION: {
    checked: "2026-10-19",
    versions: { v24: { ends: "2027-05-01" }, v25: { ends: "2027-08-01" }, v26: { ends: "2027-11-01" } },
    source: "https://developers.google.com/google-ads/api/docs/sunset-dates",
  },
  META_API_VERSION: {
    checked: "2026-10-19",
    versions: {
      "v24.0": { released: "2025-10-08", ends: "2026-10-06" },
      "v25.0": { released: "2026-02-18", ends: null },
      "v26.0": { released: "2026-07-29", ends: null },
    },
    source: "https://developers.facebook.com/docs/graph-api/changelog (Marketing API versions)",
  },
  WHATSAPP_API_VERSION: {
    checked: "2026-10-19",
    versions: {
      "v24.0": { released: "2025-10-08", ends: "2028-02-18" },
      "v25.0": { released: "2026-02-18", ends: "2028-07-29" },
      "v26.0": { released: "2026-07-29", ends: null },
    },
    source: "https://developers.facebook.com/docs/graph-api/changelog (Graph API versions)",
  },
};

const DAY = 86_400_000;

/**
 * When a version stops being served, as far as this table knows: its published end, or for a TBD
 * one, its release plus the shortest life of a dated version in the same list. Also how soon the
 * changelog must be read again (`recheckDays`), shorter once a newer version is out.
 */
function versionEnd(versions: Record<string, VersionDates>, version: string): { end: number; projected: boolean; recheckDays: number } {
  const v = versions[version]!;
  const superseded = Object.values(versions).some((o) => o.released && v.released && o.released > v.released);
  const recheckDays = superseded ? 60 : 180;
  if (v.ends) return { end: Date.parse(v.ends), projected: false, recheckDays };
  if (!v.released) throw new Error(`${version}: an end date of "TBD" needs its release date`);
  const lives = Object.values(versions).flatMap((o) => (o.released && o.ends ? [Date.parse(o.ends) - Date.parse(o.released)] : []));
  if (!lives.length) throw new Error(`${version}: no dated version in the list to tell how long a version lasts`);
  return { end: Date.parse(v.released) + Math.min(...lives), projected: true, recheckDays };
}

describe("API versions the ad platforms and WhatsApp still serve", () => {
  const settings = read("apps/aws/src/settings.ts");

  for (const [setting, { checked, versions, source }] of Object.entries(API_VERSION_ENDS)) {
    it(`uses a ${setting} that stays available for at least 90 more days`, () => {
      const version = envValue(settings, setting);
      expect(version, `${setting} isn't in apps/aws/src/settings.ts`).toBeTruthy();
      expect(Object.keys(versions), `${setting} ${version} has no end date here: look it up (${source}) and add it`).toContain(version);
      const { end, projected, recheckDays } = versionEnd(versions, version!);
      const when = new Date(end).toISOString().slice(0, 10);
      const daysLeft = (end - Date.now()) / DAY;
      expect(
        daysLeft,
        projected
          ? `${setting} ${version}'s end is still "TBD", but versions in this list have lasted no longer than to about ${when}: move to a newer version (${source})`
          : `${setting} ${version} stops being served on ${when} (${source})`,
      ).toBeGreaterThan(90);
      if (projected) {
        const sinceChecked = (Date.now() - Date.parse(checked)) / DAY;
        expect(sinceChecked, `${setting} ${version}'s end date was "TBD" on ${checked}: read ${source} again and record it`).toBeLessThan(recheckDays);
      }
    });
  }

  it("projects a TBD version's end from how long dated versions lasted", () => {
    const meta = API_VERSION_ENDS.META_API_VERSION!.versions;
    // v24.0 lasted 363 days, from 2025-10-08 to 2026-10-06.
    expect(versionEnd(meta, "v25.0")).toEqual({ end: Date.parse("2027-02-16"), projected: true, recheckDays: 60 });
    expect(versionEnd(meta, "v26.0")).toEqual({ end: Date.parse("2027-07-27"), projected: true, recheckDays: 180 });
    expect(versionEnd(meta, "v24.0")).toEqual({ end: Date.parse("2026-10-06"), projected: false, recheckDays: 60 });
    // The Graph API's shortest dated life here is v24.0's (2025-10-08 to 2028-02-18).
    expect(versionEnd(API_VERSION_ENDS.WHATSAPP_API_VERSION!.versions, "v26.0").end).toBe(Date.parse("2028-12-08"));
    expect(() => versionEnd({ v1: { ends: null } }, "v1")).toThrow(/needs its release date/);
    expect(() => versionEnd({ v1: { released: "2026-01-01", ends: null } }, "v1")).toThrow(/no dated version/);
  });
});

/**
 * Google's OAuth verification checks that the homepage says why the app asks for Google data, and
 * the verification form links to https://bizinsights.io/#google-data. So the landing page's ad
 * accounts section (apps/web/src/components/landing/AdPlatforms.tsx) must stay on the page, keep that
 * id, name every permission the ads clients ask for, and keep its Limited Use statement and links.
 */
describe("the homepage's ad accounts section", () => {
  const section = read("apps/web/src/components/landing/AdPlatforms.tsx");

  it("is on the landing page, with the id Google's verification form links to", () => {
    expect(section).toContain('id="google-data"');
    expect(read("apps/web/src/components/landing/LandingPage.tsx")).toMatch(/<AdPlatforms \/>/);
  });

  it("names every permission the ad platforms are asked for", () => {
    for (const scope of Object.values(REQUIRED_AD_SCOPE)) expect(section).toContain(`scope: "${scope.split("/").pop()}"`);
  });

  it("states Limited Use and links the privacy policy's Google section and the terms", () => {
    expect(section).toContain("Google API Services User Data Policy");
    expect(section).toContain("including the Limited Use requirements");
    expect(section).toContain('href="/privacy#google-user-data"');
    expect(read("apps/web/src/app/privacy/page.tsx")).toContain('id: "google-user-data"');
    expect(section).toContain('href="/terms"');
  });

  it("stays static text (the landing page's motion rules)", () => {
    expect(section).not.toMatch(/from "motion|use client|useEffect|useState/);
  });
});
