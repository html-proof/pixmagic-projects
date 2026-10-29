// The Zapier app against a faked bizinsights (nock): the OAuth flow's requests, the triggers'
// subscriptions and samples, the searches, and bizinsights' refusals read into Zapier's errors.
// Node's own test runner (`node --test`): no Jest, so none of its dependencies in this folder.
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const nock = require("nock");
const zapier = require("zapier-platform-core");
// What `zapier validate` checks the definition with (the app compiled, functions cleaned, then Zapier's schema).
const { compileApp, validateApp } = require("zapier-platform-core/src/tools/schema");

const BASE = "https://bizinsights.test";
process.env.BASE_URL = BASE;
process.env.CLIENT_ID = "bizinsights-zapier";
process.env.CLIENT_SECRET = "s3cret-for-tests-only-0123456789abcdefghij";

const App = require("../index");
const appTester = zapier.createAppTester(App);
const HOOK = "https://hooks.zapier.com/hooks/standard/1/abc/";
const REDIRECT = "https://zapier.com/dashboard/auth/oauth/return/App4242CLIAPI/";
const authData = { access_token: "zat_access", refresh_token: "zrt_refresh" };

/** A form-encoded or JSON body, as an object. */
const fields = (body) => (typeof body === "string" ? Object.fromEntries(new URLSearchParams(body)) : body);

before(() => nock.disableNetConnect());
afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  assert.deepEqual(pending, []);
});
after(() => nock.enableNetConnect());

describe("the app definition", () => {
  it("is valid for Zapier's schema, with every trigger and search Zapier will list", () => {
    assert.deepEqual(validateApp(compileApp(App)), []);
    assert.deepEqual(Object.keys(App.triggers), [
      "alert_raised",
      "ad_spend_threshold",
      "adsense_earnings_threshold",
      "ads_daily_summary",
      "whatsapp_message_failed",
      "integration_connected",
      "integration_disconnected",
      "sync_completed",
      "order_paid",
    ]);
    assert.deepEqual(Object.keys(App.searches), ["find_ad_performance", "find_adsense_earnings"]);
    assert.deepEqual(App.creates, {});
    for (const t of Object.values(App.triggers)) assert.equal(t.operation.type, "hook");
  });

  it("says which payload version every trigger's events and samples are", () => {
    for (const t of Object.values(App.triggers)) {
      assert.equal(t.operation.sample.schema_version, 1);
      assert.ok(t.operation.outputFields.map((f) => f.key).includes("schema_version"), t.key);
      // The sample is the trigger's own event.
      assert.equal(t.operation.sample.event, t.key);
    }
  });

  it("never puts a customer's details in a paid order's sample", () => {
    const sample = JSON.stringify(App.triggers.order_paid.operation.sample);
    assert.doesNotMatch(sample, /email|phone|address|customer|first_name|last_name|discount_code/i);
  });
});

describe("connecting (OAuth 2.0)", () => {
  it("opens bizinsights' consent page with Zapier's state and redirect URI", async () => {
    const url = await appTester(App.authentication.oauth2Config.authorizeUrl, { inputData: { state: "st&te 1", redirect_uri: REDIRECT } });
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, `${BASE}/connect/zapier`);
    assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: "bizinsights-zapier", state: "st&te 1", redirect_uri: REDIRECT, response_type: "code" });
  });

  it("exchanges the code at bizinsights' token endpoint, form-encoded, with the client's secret", async () => {
    nock(BASE)
      .post("/api/oauth/token", (body) => {
        const f = fields(body);
        return f.grant_type === "authorization_code" && f.code === "zac_code" && f.redirect_uri === REDIRECT && f.client_id === "bizinsights-zapier" && f.client_secret === process.env.CLIENT_SECRET;
      })
      .matchHeader("content-type", /application\/x-www-form-urlencoded/)
      .reply(200, { access_token: "zat_new", refresh_token: "zrt_new", token_type: "Bearer", expires_in: 3600 });
    const result = await appTester(App.authentication.oauth2Config.getAccessToken, { inputData: { code: "zac_code", redirect_uri: REDIRECT } });
    assert.deepEqual(result, { access_token: "zat_new", refresh_token: "zrt_new" });
  });

  it("refreshes with the refresh token, and keeps the new one bizinsights rotates to", async () => {
    nock(BASE)
      .post("/api/oauth/token", (body) => fields(body).grant_type === "refresh_token" && fields(body).refresh_token === "zrt_refresh")
      .reply(200, { access_token: "zat_2", refresh_token: "zrt_2", token_type: "Bearer", expires_in: 3600 });
    const result = await appTester(App.authentication.oauth2Config.refreshAccessToken, { authData });
    assert.deepEqual(result, { access_token: "zat_2", refresh_token: "zrt_2" });
    assert.equal(App.authentication.oauth2Config.autoRefresh, true);
  });

  it("tests the connection with /api/zapier/me and labels it by store", async () => {
    nock(BASE)
      .get("/api/zapier/me")
      .matchHeader("authorization", "Bearer zat_access")
      .reply(200, { store: { id: "s1", name: "Acme" }, workspace: { id: "w1", name: "Acme Ltd" }, label: "Acme (Acme Ltd)" });
    const me = await appTester(App.authentication.test, { authData });
    assert.equal(me.label, "Acme (Acme Ltd)");
    assert.equal(App.authentication.connectionLabel({}, { inputData: me }), "Acme (Acme Ltd)");
  });

  it("asks Zapier to refresh on a 401 (the token ran out, or its member lost access)", async () => {
    nock(BASE).get("/api/zapier/me").reply(401, { error: "invalid_token", message: "Connect bizinsights to Zapier again." });
    await assert.rejects(appTester(App.authentication.test, { authData }), { name: "RefreshAuthError" });
  });
});

describe("the triggers (REST hooks)", () => {
  it("subscribes Zapier's address with the trigger's own fields, and unsubscribes it", async () => {
    nock(BASE)
      .post("/api/zapier/hooks", { event: "ad_spend_threshold", targetUrl: HOOK, zapId: "zap-7", platform: "meta", period: "month", amount: 500 })
      .matchHeader("authorization", "Bearer zat_access")
      .reply(201, { id: "hook_1", event: "ad_spend_threshold" });
    const sub = await appTester(App.triggers.ad_spend_threshold.operation.performSubscribe, {
      authData,
      targetUrl: HOOK,
      meta: { zap: { id: "zap-7" } },
      inputData: { platform: "meta", period: "month", amount: "500" },
    });
    assert.deepEqual(sub, { id: "hook_1", event: "ad_spend_threshold" });
    nock(BASE).delete("/api/zapier/hooks/hook_1").reply(200, { ok: true });
    assert.deepEqual(await appTester(App.triggers.ad_spend_threshold.operation.performUnsubscribe, { authData, subscribeData: sub }), { ok: true });
  });

  it("subscribes AdSense's threshold with which way it is crossed: reached, or a finished period ended below it", async () => {
    nock(BASE)
      .post("/api/zapier/hooks", { event: "adsense_earnings_threshold", targetUrl: HOOK, period: "day", amount: 20, direction: "below" })
      .reply(201, { id: "hook_2", event: "adsense_earnings_threshold" });
    await appTester(App.triggers.adsense_earnings_threshold.operation.performSubscribe, { authData, targetUrl: HOOK, inputData: { period: "day", amount: "20", direction: "below" } });
    // Anything but "below" is "above", the default.
    nock(BASE)
      .post("/api/zapier/hooks", { event: "adsense_earnings_threshold", targetUrl: HOOK, period: "month", amount: 300, direction: "above" })
      .reply(201, { id: "hook_3", event: "adsense_earnings_threshold" });
    await appTester(App.triggers.adsense_earnings_threshold.operation.performSubscribe, { authData, targetUrl: HOOK, inputData: { period: "month", amount: "300" } });
    const direction = App.triggers.adsense_earnings_threshold.operation.inputFields.find((f) => f.key === "direction");
    assert.equal(direction.required, true);
    assert.equal(direction.default, "above");
    assert.deepEqual(Object.keys(direction.choices), ["above", "below"]);
  });

  it("subscribes the new triggers with their own event", async () => {
    for (const key of ["integration_connected", "integration_disconnected", "sync_completed", "order_paid"]) {
      nock(BASE).post("/api/zapier/hooks", { event: key, targetUrl: HOOK }).reply(201, { id: `hook_${key}`, event: key });
      assert.deepEqual(await appTester(App.triggers[key].operation.performSubscribe, { authData, targetUrl: HOOK, inputData: {} }), { id: `hook_${key}`, event: key });
      nock(BASE).get(`/api/zapier/samples/${key}`).reply(200, []);
      assert.deepEqual(await appTester(App.triggers[key].operation.performList, { authData }), []);
    }
  });

  it("passes on the event bizinsights posted, as it came", async () => {
    const event = { id: "alert_raised:a1:s1", event: "alert_raised", data: { title: "Couldn't sync your orders" } };
    assert.deepEqual(await appTester(App.triggers.alert_raised.operation.perform, { authData, cleanedRequest: event }), [event]);
  });

  it("lists the store's real recent events as samples, and none when there are none", async () => {
    nock(BASE).get("/api/zapier/samples/whatsapp_message_failed").reply(200, []);
    assert.deepEqual(await appTester(App.triggers.whatsapp_message_failed.operation.performList, { authData }), []);
    nock(BASE)
      .get("/api/zapier/samples/alert_raised")
      .reply(200, [{ id: "alert_raised:a1:s1", event: "alert_raised", data: { title: "x" } }]);
    assert.equal((await appTester(App.triggers.alert_raised.operation.performList, { authData })).length, 1);
  });

  it("shows bizinsights' own words when it refuses (a permission the member doesn't have)", async () => {
    nock(BASE)
      .post("/api/zapier/hooks")
      .reply(403, { error: "no_permission", message: "The person who connected bizinsights can't see advertising figures in this workspace." });
    await assert.rejects(
      appTester(App.triggers.ads_daily_summary.operation.performSubscribe, { authData, targetUrl: HOOK, inputData: {} }),
      /can't see advertising figures/,
    );
  });
});

describe("the searches", () => {
  it("find ad performance for the dates, as days", async () => {
    nock(BASE)
      .get("/api/zapier/search/ad-performance")
      .query({ platform: "google", since: "2026-10-01", until: "2026-10-07" })
      .reply(200, [{ id: "x", spend: 10, currency: "AUD" }]);
    const found = await appTester(App.searches.find_ad_performance.operation.perform, {
      authData,
      inputData: { platform: "google", since: "2026-10-01T00:00:00+11:00", until: "2026-10-07T00:00:00+11:00" },
    });
    assert.deepEqual(found, [{ id: "x", spend: 10, currency: "AUD" }]);
  });

  it("find AdSense earnings, empty when no account is connected", async () => {
    nock(BASE).get("/api/zapier/search/adsense-earnings").reply(200, []);
    assert.deepEqual(await appTester(App.searches.find_adsense_earnings.operation.perform, { authData, inputData: {} }), []);
  });
});
