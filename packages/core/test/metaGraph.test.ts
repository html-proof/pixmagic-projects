import { describe, expect, it } from "vitest";
import { AdsApiError, AdsRetryableError, metaAdAccounts, graph, metaRevokeAdsRead, WhatsappApiError, type FetchLike } from "../src/index.js";
import { graphCall, type GraphFailure } from "../src/metaGraph.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake(route: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return route(url, init);
  };
  return { fetchImpl, calls };
}

const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);
const failed = (f: GraphFailure) => Object.assign(new Error(f.message ?? "failed"), { failure: f });
const failureOf = (p: Promise<unknown>) => p.then(
  () => {
    throw new Error("expected the call to fail");
  },
  (err: { failure: GraphFailure }) => err.failure,
);

describe("graphCall (the one Meta Graph API transport)", () => {
  it("sends the token in the Authorization header, never in the URL or the form", async () => {
    const f = fake(() => json({ ok: true }));
    await graphCall(f.fetchImpl, { version: "v25.0", method: "GET", path: "me", token: "SECRET_TOKEN", query: { fields: "id", access_token: "SECRET_TOKEN" } }, failed);
    await graphCall(f.fetchImpl, { version: "v25.0", method: "DELETE", path: "me/permissions/ads_read", token: "SECRET_TOKEN", form: { access_token: "SECRET_TOKEN", x: "1" } }, failed);
    for (const c of f.calls) {
      expect(c.url.toString()).not.toContain("SECRET_TOKEN");
      expect(String(c.init?.body ?? "")).not.toContain("SECRET_TOKEN");
      expect(header(c.init, "authorization")).toBe("Bearer SECRET_TOKEN");
    }
    expect(f.calls[0]!.url.toString()).toBe("https://graph.facebook.com/v25.0/me?fields=id");
    expect(header(f.calls[1]!.init, "content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(f.calls[1]!.init?.body)).toBe("x=1");
  });

  it("follows Meta's paging link only to graph.facebook.com, minus the token it carried", async () => {
    const f = fake(() => json({ data: [] }));
    await graphCall(f.fetchImpl, { version: "v25.0", method: "GET", path: "https://graph.facebook.com/v25.0/me/adaccounts?after=x&access_token=OLD", token: "T" }, failed);
    expect(f.calls[0]!.url.toString()).toBe("https://graph.facebook.com/v25.0/me/adaccounts?after=x");
    expect(header(f.calls[0]!.init, "authorization")).toBe("Bearer T");

    for (const link of ["https://evil.example/v25.0/me?after=x", "http://graph.facebook.com/v25.0/me"]) {
      const failure = await failureOf(graphCall(f.fetchImpl, { version: "v25.0", method: "GET", path: link, token: "T" }, failed));
      expect(failure).toMatchObject({ reason: "bad_link", status: 502 });
    }
    expect(f.calls).toHaveLength(1);
  });

  it("reports Meta's error fields, no answer at all, and an answer that isn't JSON", async () => {
    const refused = fake(() =>
      json({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190, error_subcode: 463, error_user_title: "Expired", error_user_msg: "Log in again", error_data: { details: "d" } } }, 400),
    );
    expect(await failureOf(graphCall(refused.fetchImpl, { version: "v25.0", method: "GET", path: "me", token: "T" }, failed))).toMatchObject({
      reason: "refused",
      status: 400,
      code: 190,
      subcode: 463,
      type: "OAuthException",
      message: "Invalid OAuth access token",
      userTitle: "Expired",
      userMessage: "Log in again",
      details: "d",
    });

    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await failureOf(graphCall(down, { version: "v25.0", method: "GET", path: "me", token: "T" }, failed))).toMatchObject({ reason: "network", status: 0, message: "fetch failed" });

    // A 200 that isn't JSON is an error page, not an empty answer.
    const page = fake(() => new Response("<html>Sorry, something went wrong</html>", { status: 200 }));
    expect(await failureOf(graphCall(page.fetchImpl, { version: "v25.0", method: "GET", path: "me", token: "T" }, failed))).toMatchObject({
      reason: "refused",
      status: 200,
      text: "<html>Sorry, something went wrong</html>",
    });

    // An empty answer is fine (some POSTs answer nothing).
    const empty = fake(() => new Response("", { status: 200 }));
    expect(await graphCall(empty.fetchImpl, { version: "v25.0", method: "POST", path: "1/subscribed_apps", token: "T" }, failed)).toEqual({});
  });

  it("sends a JSON body when asked", async () => {
    const f = fake(() => json({ messages: [{ id: "wamid.1" }] }));
    await graphCall(f.fetchImpl, { version: "v25.0", method: "POST", path: "/123/messages", token: "T", json: { to: "61400000000" } }, failed);
    expect(f.calls[0]!.url.pathname).toBe("/v25.0/123/messages");
    expect(header(f.calls[0]!.init, "content-type")).toBe("application/json");
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({ to: "61400000000" });
  });
});

describe("the ads and WhatsApp clients on it", () => {
  const meta = (fetchImpl: FetchLike) => ({ appId: "app1", appSecret: "sec", version: "v25.0", fetchImpl });

  it("ads: the token stays out of every URL, paging included, and an outage is worth a retry", async () => {
    const f = fake((u) =>
      u.searchParams.get("after")
        ? json({ data: [{ id: "act_2" }] })
        : json({ data: [{ id: "act_1" }], paging: { next: "https://graph.facebook.com/v25.0/me/adaccounts?after=x&access_token=USER_TOKEN" } }),
    );
    expect((await metaAdAccounts(meta(f.fetchImpl), "USER_TOKEN")).map((a) => a.accountId)).toEqual(["act_1", "act_2"]);
    expect(f.calls.map((c) => c.url.toString()).join(" ")).not.toContain("USER_TOKEN");
    expect(f.calls.every((c) => header(c.init, "authorization") === "Bearer USER_TOKEN")).toBe(true);

    const revoke = fake(() => json({ success: true }));
    await metaRevokeAdsRead(meta(revoke.fetchImpl), "USER_TOKEN");
    expect(revoke.calls[0]!.init?.method).toBe("DELETE");
    expect(String(revoke.calls[0]!.init?.body ?? "")).not.toContain("USER_TOKEN");

    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(metaAdAccounts(meta(down), "T")).rejects.toBeInstanceOf(AdsRetryableError);
    const elsewhere = fake(() => json({ data: [], paging: { next: "https://evil.example/next" } }));
    await expect(metaAdAccounts(meta(elsewhere.fetchImpl), "T")).rejects.toMatchObject({ constructor: AdsApiError, status: 502 });
  });

  it("WhatsApp: Meta's wording and the action it implies; an outage is retryable", async () => {
    const f = fake(() => json({ error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_data: { details: "Unsupported get request" } } }, 400));
    const err = await graph(f.fetchImpl, "T", "GET", "123", { version: "v25.0" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsappApiError);
    expect(err).toMatchObject({ httpStatus: 400, code: 100, title: "OAuthException", details: "Unsupported get request", action: "fail" });

    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(graph(down, "T", "GET", "123", { version: "v25.0" })).rejects.toMatchObject({ httpStatus: 503, title: "network", action: "retry" });
  });
});
