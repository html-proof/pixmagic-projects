import { describe, expect, it } from "vitest";

/**
 * nango-setup.mjs's checks: what differs between a Nango integration and bizinsights' own keys (a secret
 * compared, never printed), and whether Meta takes META_APP_SECRET as its app's. A Nango integration
 * holding another Meta secret makes tokens Meta refuses with "Invalid appsecret_proof".
 */
interface Def {
  key: string;
  provider: string;
  name: string;
}
interface Want {
  clientId: string;
  clientSecret: string;
  scopes: string;
}
const script = (await import(new URL("../scripts/nango-setup.mjs", import.meta.url).href)) as {
  INTEGRATIONS: Record<string, Def>;
  differences: (def: Def, data: Record<string, unknown>, want: Want) => { problems: string[]; fatal: boolean };
};
const { metaAcceptsSecret } = (await import(new URL("../scripts/meta-secret.mjs", import.meta.url).href)) as {
  metaAcceptsSecret: (appId: string, appSecret: string, version?: string, fetchImpl?: typeof fetch) => Promise<{ accepted: boolean | null; detail: string | null }>;
};

const META = script.INTEGRATIONS.meta!;
const WANT: Want = { clientId: "971575545351940", clientSecret: "0123456789abcdef0123456789abcdef", scopes: "" };
const held = (credentials: Record<string, unknown>, provider = "facebook") => ({ provider, credentials: { type: "OAUTH2", ...credentials } });

describe("what differs in a Nango integration", () => {
  it("nothing, when Nango holds bizinsights' client, secret and scopes", () => {
    expect(script.differences(META, held({ client_id: WANT.clientId, client_secret: WANT.clientSecret, scopes: "" }), WANT)).toEqual({ problems: [], fatal: false });
  });

  it("another client secret, said without saying either secret", () => {
    const { problems, fatal } = script.differences(META, held({ client_id: WANT.clientId, client_secret: "ffffffffffffffffffffffffffffffff", scopes: "" }), WANT);
    expect(problems).toEqual(["client secret isn't the one in the app secret"]);
    expect(fatal).toBe(false);
    expect(problems.join(" ")).not.toMatch(/[0-9a-f]{32}/);
  });

  it("another client and scopes, each named; a secret Nango doesn't show isn't compared", () => {
    expect(script.differences(META, held({ client_id: "1799660384680551", scopes: "ads_read" }), WANT).problems).toEqual([
      `client id 1799660384680551, not ${WANT.clientId}`,
      'scopes "ads_read", not ""',
    ]);
  });

  it("made from another Nango provider: only deleting it in Nango's dashboard fixes it", () => {
    const { problems, fatal } = script.differences(META, held({ client_id: WANT.clientId, client_secret: WANT.clientSecret, scopes: "" }, "meta-marketing-api"), WANT);
    expect(fatal).toBe(true);
    expect(problems[0]).toMatch(/^made from provider meta-marketing-api, not facebook/);
  });
});

describe("whether Meta takes META_APP_SECRET", () => {
  const meta = (answer: () => Response | Promise<Response>) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return answer();
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("yes when an app token comes back; the secret goes in the body, never the address", async () => {
    const m = meta(() => json({ access_token: "971575545351940|x", token_type: "bearer" }));
    expect(await metaAcceptsSecret(WANT.clientId, WANT.clientSecret, "v26.0", m.fetchImpl)).toEqual({ accepted: true, detail: null });
    expect(m.calls[0]!.url).toBe("https://graph.facebook.com/v26.0/oauth/access_token");
    expect(m.calls[0]!.url).not.toContain(WANT.clientSecret);
    expect(new URLSearchParams(String(m.calls[0]!.init?.body)).get("grant_type")).toBe("client_credentials");
  });

  it("no when Meta refuses it, with Meta's words and never the secret; unknown when Meta doesn't answer", async () => {
    // What production's META_APP_SECRET got on 2026-10-24.
    const refused = meta(() => json({ error: { message: "Error validating client secret.", type: "OAuthException", code: 1 } }, 400));
    expect(await metaAcceptsSecret(WANT.clientId, WANT.clientSecret, "v26.0", refused.fetchImpl)).toEqual({
      accepted: false,
      detail: "HTTP 400, OAuthException, code 1, Error validating client secret.",
    });
    const echoing = meta(() => json({ error: { message: `bad secret ${WANT.clientSecret}`, code: 1 } }, 400));
    expect((await metaAcceptsSecret(WANT.clientId, WANT.clientSecret, "v26.0", echoing.fetchImpl)).detail).toBe("HTTP 400, code 1, bad secret ***");
    expect((await metaAcceptsSecret(WANT.clientId, "bad", "v26.0", meta(() => json({}, 503)).fetchImpl)).accepted).toBeNull();
    expect(await metaAcceptsSecret(WANT.clientId, "bad", "v26.0", meta(() => Promise.reject(new TypeError("fetch failed"))).fetchImpl)).toEqual({
      accepted: null,
      detail: "no answer: fetch failed",
    });
  });
});
