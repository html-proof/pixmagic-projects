// The Zapier app against a faked bizinsights (nock): the OAuth flow's requests, the triggers'
// subscriptions and samples, the searches, the WhatsApp action, and bizinsights' refusals read into
// Zapier's errors.
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

beforeAll(() => nock.disableNetConnect());
afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
});
afterAll(() => nock.enableNetConnect());

describe("the app definition", () => {
  it("is valid for Zapier's schema, with every trigger, search and action Zapier will list", () => {
    expect(validateApp(compileApp(App))).toEqual([]);
    expect(Object.keys(App.triggers)).toEqual(["alert_raised", "ad_spend_threshold", "adsense_earnings_threshold", "ads_daily_summary", "whatsapp_message_failed", "whatsapp_templates"]);
    expect(Object.keys(App.searches)).toEqual(["find_ad_performance", "find_adsense_earnings"]);
    expect(Object.keys(App.creates)).toEqual(["send_whatsapp_template"]);
    // Every listed trigger is instant; the template list only feeds the action's dropdown.
    for (const t of Object.values(App.triggers)) if (!t.display.hidden) expect(t.operation.type).toBe("hook");
    expect(App.triggers.whatsapp_templates.display.hidden).toBe(true);
  });
});

describe("connecting (OAuth 2.0)", () => {
  it("opens bizinsights' consent page with Zapier's state and redirect URI", async () => {
    const url = await appTester(App.authentication.oauth2Config.authorizeUrl, { inputData: { state: "st&te 1", redirect_uri: REDIRECT } });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${BASE}/connect/zapier`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "bizinsights-zapier", state: "st&te 1", redirect_uri: REDIRECT, response_type: "code" });
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
    expect(result).toEqual({ access_token: "zat_new", refresh_token: "zrt_new" });
  });

  it("refreshes with the refresh token, and keeps the new one bizinsights rotates to", async () => {
    nock(BASE)
      .post("/api/oauth/token", (body) => fields(body).grant_type === "refresh_token" && fields(body).refresh_token === "zrt_refresh")
      .reply(200, { access_token: "zat_2", refresh_token: "zrt_2", token_type: "Bearer", expires_in: 3600 });
    const result = await appTester(App.authentication.oauth2Config.refreshAccessToken, { authData });
    expect(result).toEqual({ access_token: "zat_2", refresh_token: "zrt_2" });
    expect(App.authentication.oauth2Config.autoRefresh).toBe(true);
  });

  it("tests the connection with /api/zapier/me and labels it by store", async () => {
    nock(BASE)
      .get("/api/zapier/me")
      .matchHeader("authorization", "Bearer zat_access")
      .reply(200, { store: { id: "s1", name: "Acme" }, workspace: { id: "w1", name: "Acme Ltd" }, label: "Acme (Acme Ltd)" });
    const me = await appTester(App.authentication.test, { authData });
    expect(me.label).toBe("Acme (Acme Ltd)");
    expect(App.authentication.connectionLabel({}, { inputData: me })).toBe("Acme (Acme Ltd)");
  });

  it("asks Zapier to refresh on a 401 (the token ran out, or its member lost access)", async () => {
    nock(BASE).get("/api/zapier/me").reply(401, { error: "invalid_token", message: "Connect bizinsights to Zapier again." });
    await expect(appTester(App.authentication.test, { authData })).rejects.toMatchObject({ name: "RefreshAuthError" });
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
    expect(sub).toEqual({ id: "hook_1", event: "ad_spend_threshold" });
    nock(BASE).delete("/api/zapier/hooks/hook_1").reply(200, { ok: true });
    expect(await appTester(App.triggers.ad_spend_threshold.operation.performUnsubscribe, { authData, subscribeData: sub })).toEqual({ ok: true });
  });

  it("passes on the event bizinsights posted, as it came", async () => {
    const event = { id: "alert_raised:a1:s1", event: "alert_raised", data: { title: "Couldn't sync your orders" } };
    expect(await appTester(App.triggers.alert_raised.operation.perform, { authData, cleanedRequest: event })).toEqual([event]);
  });

  it("lists the store's real recent events as samples, and none when there are none", async () => {
    nock(BASE).get("/api/zapier/samples/whatsapp_message_failed").reply(200, []);
    expect(await appTester(App.triggers.whatsapp_message_failed.operation.performList, { authData })).toEqual([]);
    nock(BASE)
      .get("/api/zapier/samples/alert_raised")
      .reply(200, [{ id: "alert_raised:a1:s1", event: "alert_raised", data: { title: "x" } }]);
    expect(await appTester(App.triggers.alert_raised.operation.performList, { authData })).toHaveLength(1);
  });

  it("shows bizinsights' own words when it refuses (a permission the member doesn't have)", async () => {
    nock(BASE)
      .post("/api/zapier/hooks")
      .reply(403, { error: "no_permission", message: "The person who connected bizinsights can't see advertising figures in this workspace." });
    await expect(
      appTester(App.triggers.ads_daily_summary.operation.performSubscribe, { authData, targetUrl: HOOK, inputData: {} }),
    ).rejects.toThrow(/can't see advertising figures/);
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
    expect(found).toEqual([{ id: "x", spend: 10, currency: "AUD" }]);
  });

  it("find AdSense earnings, empty when no account is connected", async () => {
    nock(BASE).get("/api/zapier/search/adsense-earnings").reply(200, []);
    expect(await appTester(App.searches.find_adsense_earnings.operation.perform, { authData, inputData: {} })).toEqual([]);
  });
});

describe("the action: Send WhatsApp Template Message", () => {
  const TEMPLATES = [
    { id: "t1", name: "Thanks for your enquiry", category: "transactional", category_label: "Order update", language: "en", body: "Hi {{customer_first_name}}, {{store_name}} here: your quote {{order_number}} is ready.", variables: ["customer_first_name", "order_number"], automatic: ["store_name"] },
  ];

  it("lists the approved templates for the dropdown", async () => {
    nock(BASE).get("/api/zapier/whatsapp/templates").matchHeader("authorization", "Bearer zat_access").reply(200, TEMPLATES);
    expect(await appTester(App.triggers.whatsapp_templates.operation.perform, { authData })).toEqual(TEMPLATES);
    expect(App.creates.send_whatsapp_template.operation.inputFields[0]).toMatchObject({ key: "template_id", dynamic: "whatsapp_templates.id.name", altersDynamicFields: true });
  });

  it("asks for the chosen template's own variables (its first name optional), with its text", async () => {
    const dynamic = App.creates.send_whatsapp_template.operation.inputFields.find((f) => typeof f === "function");
    expect(await appTester(dynamic, { authData, inputData: {} })).toEqual([]);
    nock(BASE).get("/api/zapier/whatsapp/templates").reply(200, TEMPLATES);
    const fieldsFor = await appTester(dynamic, { authData, inputData: { template_id: "t1" } });
    expect(fieldsFor.map((f) => [f.key, f.required ?? null])).toEqual([
      ["template_text", null],
      ["value_customer_first_name", false],
      ["value_order_number", true],
    ]);
    expect(fieldsFor[0].helpText).toContain("your quote {{order_number}} is ready");
    // The send-once key is required: Zapier doesn't give an action the trigger item's id.
    expect(App.creates.send_whatsapp_template.operation.inputFields.find((f) => f.key === "unique_key")).toMatchObject({ required: true });
  });

  it("posts the message with the mapped values, the consent and the Zap's id, and answers what was queued", async () => {
    const queued = { id: "m1", status: "queued", duplicate: false, phone_masked: "+61 4•• ••• 678", template: { id: "t1", name: "Thanks for your enquiry", category: "transactional" }, consent_recorded: true };
    nock(BASE)
      .post("/api/zapier/whatsapp/messages", {
        template_id: "t1",
        phone: "+61412345678",
        values: { order_number: "Q-77" },
        first_name: "Sam",
        customer_agreed: true,
        consent_note: "Meta lead form: WhatsApp box",
        unique_key: "lead-123",
        zap_id: 99,
      })
      .matchHeader("authorization", "Bearer zat_access")
      .reply(201, queued);
    const result = await appTester(App.creates.send_whatsapp_template.operation.perform, {
      authData,
      meta: { zap: { id: 99 } },
      inputData: { template_id: "t1", phone: "+61412345678", value_order_number: "Q-77", value_customer_first_name: "", first_name: "Sam", customer_agreed: true, consent_note: "Meta lead form: WhatsApp box", unique_key: "lead-123" },
    });
    expect(result).toEqual(queued);
  });

  it("shows bizinsights' words when the message can't go (no consent), and tries later when told to slow down", async () => {
    nock(BASE)
      .post("/api/zapier/whatsapp/messages")
      .reply(409, { error: "not_allowed", message: "This message can't go to that number: The customer hasn't agreed to WhatsApp updates." });
    await expect(appTester(App.creates.send_whatsapp_template.operation.perform, { authData, inputData: { template_id: "t1", phone: "+61412345678" } })).rejects.toThrow(/hasn't agreed/);
    nock(BASE).post("/api/zapier/whatsapp/messages").reply(429, { error: "rate_limited", message: "Too quickly." }, { "retry-after": "30" });
    await expect(appTester(App.creates.send_whatsapp_template.operation.perform, { authData, inputData: { template_id: "t1", phone: "+61412345678" } })).rejects.toMatchObject({ name: "ThrottledError" });
  });
});
