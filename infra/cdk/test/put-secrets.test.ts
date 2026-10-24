import { describe, expect, it } from "vitest";
import { APP_SETTINGS } from "../../../apps/aws/src/settings.js";

/**
 * put-secrets.mjs --set reads a secret from the clipboard, which often holds something else: the
 * App ID shown next to the secret, the Secret ID next to Entra's value, a URL. Those are refused.
 */
type Publics = Array<{ name: string; value: string }>;
const script = (await import(new URL("../scripts/put-secrets.mjs", import.meta.url).href)) as {
  secretProblem: (name: string, value: string, publics?: Publics) => string | null;
  publicSettings: (text?: string) => Publics;
  metaAppOf: (name: string, publics?: Publics) => { appId: string; version?: string } | null;
};
const { secretProblem, publicSettings, metaAppOf } = script;

const META_SECRET = "0123456789abcdef0123456789abcdef";
const ENTRA_SECRET = "Xyz8Q~abcdefghijklmnopqrstuvwxyz0123456_";

describe("the shapes put-secrets.mjs accepts", () => {
  it("takes a Meta app secret, for Meta Ads and for WhatsApp, and nothing else", () => {
    for (const name of ["META_APP_SECRET", "WHATSAPP_APP_SECRET"]) {
      expect(secretProblem(name, META_SECRET)).toBeNull();
      for (const wrong of ["971575545351940", "https://developers.facebook.com/apps/971575545351940/settings/basic/", `node put-secrets.mjs --set ${name}`, META_SECRET.slice(1), META_SECRET.toUpperCase()]) {
        expect(secretProblem(name, wrong), wrong).toMatch(/Meta app secret/);
      }
    }
  });

  it("takes a Google client secret for Gmail sending, not its client id", () => {
    expect(secretProblem("EMAIL_GOOGLE_CLIENT_SECRET", "GOCSPX-abcdefghijklmnopqrstuvwxyz12")).toBeNull();
    expect(secretProblem("EMAIL_GOOGLE_CLIENT_SECRET", "123-abc.apps.googleusercontent.com")).toMatch(/GOCSPX-/);
  });

  it("takes an Entra secret's Value for Outlook sending, not its Secret ID or the application id", () => {
    expect(secretProblem("EMAIL_MICROSOFT_CLIENT_SECRET", ENTRA_SECRET)).toBeNull();
    expect(secretProblem("EMAIL_MICROSOFT_CLIENT_SECRET", "0f0f0f0f-1111-2222-3333-444444444444")).toMatch(/not its Secret ID/);
    expect(secretProblem("EMAIL_MICROSOFT_CLIENT_SECRET", "short~value")).toMatch(/Entra/);
  });

  it("keeps the shapes it had", () => {
    expect(secretProblem("GOOGLE_ADS_CLIENT_SECRET", "GOCSPX-abcdefghijklmnopqrstuvwxyz12")).toBeNull();
    expect(secretProblem("SHOPIFY_APP_SECRET_PIXMAGIC", `shpss_${META_SECRET}`)).toBeNull();
    expect(secretProblem("RESEND_API_KEY", "not a key")).toMatch(/Resend API key/);
    expect(secretProblem("NANGO_SECRET_KEY", "0f0f0f0f-1111-2222-3333-444444444444")).toBeNull();
    expect(secretProblem("NANGO_SECRET_KEY", "https://api.nango.dev")).toMatch(/Nango secret API key/);
    expect(secretProblem("NANGO_WEBHOOK_SECRET", "short")).toMatch(/Nango webhook signing key/);
    // A secret without a known shape takes any value, but not none.
    expect(secretProblem("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "anything-at-all")).toBeNull();
    expect(secretProblem("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "")).toMatch(/0 characters/);
  });

  it("never repeats the value it refuses", () => {
    const value = "a-pasted-value-that-must-not-be-printed";
    expect(secretProblem("META_APP_SECRET", value)).not.toContain(value);
  });
});

describe("the Meta app a Meta secret is checked against", () => {
  it("META_APP_SECRET is META_APP_ID's; WHATSAPP_APP_SECRET is WHATSAPP_APP_ID's, else META_APP_ID's", () => {
    expect(metaAppOf("META_APP_SECRET")).toEqual({ appId: APP_SETTINGS.META_APP_ID, version: APP_SETTINGS.META_API_VERSION });
    const own = [
      { name: "META_APP_ID", value: "111" },
      { name: "WHATSAPP_APP_ID", value: "222" },
    ];
    expect(metaAppOf("WHATSAPP_APP_SECRET", own)).toEqual({ appId: "222", version: undefined });
    expect(metaAppOf("WHATSAPP_APP_SECRET", [own[0]!])).toEqual({ appId: "111", version: undefined });
  });

  it("nothing for another secret, or without the app id", () => {
    expect(metaAppOf("GOOGLE_ADS_CLIENT_SECRET")).toBeNull();
    expect(metaAppOf("META_APP_SECRET", [])).toBeNull();
  });
});

describe("a public setting pasted as a secret", () => {
  it("is refused even when it has the secret's shape", () => {
    // Shopify client ids are 32 hexadecimal characters, like the secrets: only this tells them apart.
    expect(secretProblem("SHOPIFY_API_SECRET", APP_SETTINGS.SHOPIFY_API_KEY)).toMatch(/SHOPIFY_API_KEY .* public/);
    const pixmagic = (JSON.parse(APP_SETTINGS.SHOPIFY_EXTRA_APPS) as Array<{ key: string; clientId: string }>).find((a) => a.key === "pixmagic")!;
    expect(secretProblem("SHOPIFY_APP_SECRET_PIXMAGIC", pixmagic.clientId)).toMatch(/SHOPIFY_EXTRA_APPS \(pixmagic\)/);
    expect(secretProblem("WHATSAPP_WEBHOOK_VERIFY_TOKEN", APP_SETTINGS.WHATSAPP_APP_ID)).toMatch(/WHATSAPP_APP_ID/);
    expect(secretProblem("META_APP_SECRET", APP_SETTINGS.META_APP_ID)).toMatch(/META_APP_ID/);
  });

  it("is read from every setting the app ships", () => {
    const found = new Map(publicSettings().map((p) => [p.name, p.value]));
    for (const [name, value] of Object.entries(APP_SETTINGS)) if (value) expect(found.get(name), name).toBe(value);
    for (const app of JSON.parse(APP_SETTINGS.SHOPIFY_EXTRA_APPS) as Array<{ key: string; clientId: string }>) {
      expect(found.get(`SHOPIFY_EXTRA_APPS (${app.key})`)).toBe(app.clientId);
    }
  });

  it("still reads the other settings when the extra apps aren't a list", () => {
    expect(publicSettings(`  "META_APP_ID": "123",\n  "SHOPIFY_EXTRA_APPS": "nope",\n  "EMPTY": "",\r\n`)).toEqual([
      { name: "META_APP_ID", value: "123" },
      { name: "SHOPIFY_EXTRA_APPS", value: "nope" },
    ]);
  });
});
