import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { createMessage, unsubscribeToken, type FetchLike } from "@app/core";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { dohResponse, fakeSmtp, idToken, isDoh, json, type FakeSmtp } from "../../../test-support/emailFakes.js";
import { LEGACY_GRANTS } from "@app/shared";

/**
 * Email integrations through the API: who may do what (tenant isolation, roles), connecting Google,
 * Microsoft and SMTP accounts, domains, templates, automations, the event API and unsubscribe.
 * Real Postgres; Google, Microsoft, DNS and the SMTP server are faked.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));

const KEYS = {
  EMAIL_GOOGLE_CLIENT_ID: "g-email",
  EMAIL_GOOGLE_CLIENT_SECRET: "g-secret",
  EMAIL_MICROSOFT_CLIENT_ID: "ms-email",
  EMAIL_MICROSOFT_CLIENT_SECRET: "ms-secret",
  EMAIL_MICROSOFT_AUTHORITY: "common",
};

const MS_TENANT = "11111111-2222-3333-4444-555555555555";
let dns: Record<string, string[]>;
let dnsDown: boolean;
let googleToken: Record<string, unknown>;
let microsoftToken: Record<string, unknown>;
let smtp: FakeSmtp;
let calls: string[];

const platform: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  calls.push(`${url.hostname}${url.pathname}`);
  if (isDoh(url)) return dohResponse(url, dns, dnsDown);
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") return json(googleToken);
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") return json({});
  if (url.hostname === "login.microsoftonline.com") return json(microsoftToken);
  if (url.hostname === "graph.microsoft.com" && url.pathname === "/v1.0/me") return json({ id: "ms-oid", mail: "Billing@Contoso.com", userPrincipalName: "billing@contoso.com", displayName: "Billing" });
  throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
};

let owner: Awaited<ReturnType<typeof signIn>>;
let ws: string;
const H = () => owner.headers;
const api = (method: string, url: string, payload?: unknown, headers = H()) => ctx.app.inject({ method, url: `/workspaces/${ws}/email${url}`, headers, payload });

beforeEach(async () => {
  await clean(ctx);
  ctx.setEnv(KEYS);
  calls = [];
  dns = { "smtp.shopmail.com|A": ["93.184.216.34"] };
  dnsDown = false;
  googleToken = {
    access_token: "G_ACCESS",
    refresh_token: "G_REFRESH_SECRET",
    expires_in: 3599,
    scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send",
    id_token: idToken({ iss: "https://accounts.google.com", aud: "g-email", sub: "g-sub-1", email: "Owner@ShopMail.com", email_verified: true, hd: "shopmail.com" }),
  };
  microsoftToken = {
    access_token: "MS_ACCESS",
    refresh_token: "MS_REFRESH_SECRET",
    expires_in: 3600,
    scope: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid email profile offline_access",
    id_token: idToken({ iss: `https://login.microsoftonline.com/${MS_TENANT}/v2.0`, aud: "ms-email", oid: "ms-oid", tid: MS_TENANT }),
  };
  smtp = fakeSmtp();
  ctx.deps.smtpConnect = smtp.connect;
  ctx.setFetch(platform);
  owner = await signIn(ctx, "email-owner", "owner@shopmail.com");
  ws = await createWorkspace(ctx, owner.headers, "Shop");
});

/** Start a connect and follow the provider back to our callback, as the browser would. */
async function oauthFlow(provider: "google" | "microsoft", query: Record<string, string> = { code: "CODE" }, opts: { stateCookie?: string; path?: string } = {}) {
  const start = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/email${opts.path ?? `/oauth/${provider}/start`}`, headers: H() });
  expect(start.statusCode, start.body).toBe(200);
  const authorize = new URL(start.json().url);
  const state = authorize.searchParams.get("state")!;
  const cb = await ctx.app.inject({
    method: "GET",
    url: `/email/oauth/${provider}/callback?${new URLSearchParams({ state, ...query })}`,
    headers: { cookie: `${owner.cookie}; email_oauth_state=${opts.stateCookie ?? state}` },
  });
  return { authorize, state, cb, location: new URL(cb.headers.location ?? "http://none/") };
}

async function connectSmtp(extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/smtp/connections", { emailAddress: "billing@shopmail.com", displayName: "Billing", host: "smtp.shopmail.com", port: 587, encryption: "starttls", username: "billing@shopmail.com", password: "right-password", ...extra });
  return res;
}

async function activeTemplate(body: Record<string, unknown> = {}) {
  const res = await api("POST", "/templates", { name: "Thanks", eventType: "order.paid", subject: "Thanks for order {{order.id}}", html: "<p>Hi {{customer.first_name | default: \"there\"}}</p>", status: "active", ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().template as { id: string };
}

describe("tenant isolation and roles", () => {
  it("never shows or uses another workspace's accounts, templates or senders", async () => {
    const google = await oauthFlow("google");
    expect(google.location.searchParams.get("connected")).toBeTruthy();
    const template = await activeTemplate();
    const senderA = (await api("GET", "/senders")).json().senders[0].id as string;

    const other = await signIn(ctx, "email-other", "other@else.com");
    const wsB = await createWorkspace(ctx, other.headers, "Other");
    // A non-member asking for workspace A's data: 404, as if it didn't exist.
    for (const path of ["/accounts", "/templates", `/templates/${template.id}`, "/messages", "/domains", "/automations"]) {
      const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/email${path}`, headers: other.headers });
      expect(res.statusCode, path).toBe(404);
    }
    // B naming A's sender or template in its own rule: refused.
    const rule = await ctx.app.inject({ method: "POST", url: `/workspaces/${wsB}/email/automations`, headers: other.headers, payload: { name: "Steal", eventType: "order.paid", senderIdentityId: senderA, templateId: template.id } });
    expect(rule.statusCode).toBe(400);
    expect(rule.json().error).toBe("sender_not_found");
    // B's own lists are empty.
    expect((await ctx.app.inject({ method: "GET", url: `/workspaces/${wsB}/email/accounts`, headers: other.headers })).json().accounts).toEqual([]);
  });

  it("lets analysts read activity but not change anything; viewers see neither activity nor credentials controls", async () => {
    const analyst = await signIn(ctx, "email-analyst", "analyst@shopmail.com");
    const viewer = await signIn(ctx, "email-viewer", "viewer@shopmail.com");
    await systemDb.membership.createMany({ data: [{ workspaceId: ws, userId: analyst.user.id, role: "analyst", permissions: [...LEGACY_GRANTS.analyst] }, { workspaceId: ws, userId: viewer.user.id, role: "viewer", permissions: [...LEGACY_GRANTS.viewer] }] });
    expect((await api("GET", "/messages", undefined, analyst.headers)).statusCode).toBe(200);
    expect((await api("POST", "/templates", { name: "x", subject: "x" }, analyst.headers)).statusCode).toBe(403);
    expect((await api("POST", "/smtp/connections", {}, analyst.headers)).statusCode).toBe(403);
    expect((await api("POST", "/oauth/google/start", undefined, analyst.headers)).statusCode).toBe(403);
    expect((await api("GET", "/accounts", undefined, viewer.headers)).statusCode).toBe(200);
    expect((await api("GET", "/messages", undefined, viewer.headers)).statusCode).toBe(403);
    // Membership removed: gone.
    await systemDb.membership.deleteMany({ where: { workspaceId: ws, userId: analyst.user.id } });
    expect((await api("GET", "/messages", undefined, analyst.headers)).statusCode).toBe(404);
  });

  it("refuses workspace API keys", async () => {
    const key = await ctx.app.inject({ method: "POST", url: `/workspaces/${ws}/api-keys`, headers: H(), payload: { name: "BI" } });
    const res = await ctx.app.inject({ method: "GET", url: `/workspaces/${ws}/email/accounts`, headers: { authorization: `Bearer ${key.json().secret}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe("Google OAuth", () => {
  it("asks only for sending, with PKCE and offline access", async () => {
    const res = await api("POST", "/oauth/google/start");
    const url = new URL(res.json().url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.send");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/email/oauth/google/callback");
  });

  it("connects the signed-in mailbox, encrypted, with a verified default sender", async () => {
    const { location } = await oauthFlow("google");
    expect(location.pathname).toBe("/settings/email/accounts");
    const accounts = (await api("GET", "/accounts")).json().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "google_workspace", email: "owner@shopmail.com", status: "connected", isDefault: true });
    expect(JSON.stringify(accounts)).not.toContain("G_REFRESH_SECRET");
    const cred = await systemDb.emailOAuthCredential.findFirstOrThrow({});
    expect(cred.refreshTokenEnc).not.toContain("G_REFRESH_SECRET");
    expect(cred.accessTokenEnc).not.toContain("G_ACCESS");
    const audit = await systemDb.auditLog.findFirst({ where: { action: "email.account.connected" } });
    expect(JSON.stringify(audit)).not.toContain("G_REFRESH");
  });

  it("rejects a forged, replayed or foreign state", async () => {
    const bad = await oauthFlow("google", { code: "CODE" }, { stateCookie: "someone-elses-state-000000" });
    expect(bad.location.searchParams.get("error")).toBe("state_mismatch");
    const first = await oauthFlow("google");
    expect(first.location.searchParams.get("connected")).toBeTruthy();
    // The same state again (a replayed callback): it was used up.
    const replay = await ctx.app.inject({ method: "GET", url: `/email/oauth/google/callback?state=${first.state}&code=CODE`, headers: { cookie: `${owner.cookie}; email_oauth_state=${first.state}` } });
    expect(new URL(replay.headers.location!).searchParams.get("error")).toBe("state_expired");
    // A different signed-in person finishing someone else's sign-in.
    const start = await api("POST", "/oauth/google/start");
    const state = new URL(start.json().url).searchParams.get("state")!;
    const intruder = await signIn(ctx, "email-intruder", "intruder@else.com");
    const cb = await ctx.app.inject({ method: "GET", url: `/email/oauth/google/callback?state=${state}&code=CODE`, headers: { cookie: `${intruder.cookie}; email_oauth_state=${state}` } });
    expect(new URL(cb.headers.location!).searchParams.get("error")).toBe("session_mismatch");
  });

  it("refuses a sign-in without the send permission or without offline access, and handles a decline", async () => {
    googleToken.scope = "openid email";
    expect((await oauthFlow("google")).location.searchParams.get("error")).toBe("permission_missing");
    googleToken.scope = "openid email https://www.googleapis.com/auth/gmail.send";
    delete googleToken.refresh_token;
    expect((await oauthFlow("google")).location.searchParams.get("error")).toBe("no_refresh_token");
    expect((await oauthFlow("google", { error: "access_denied" })).location.searchParams.get("error")).toBe("denied");
    expect(await systemDb.emailAccount.count()).toBe(0);
  });

  it("reconnects the same mailbox without losing the stored refresh token, and refuses a different one", async () => {
    await oauthFlow("google");
    const account = await systemDb.emailAccount.findFirstOrThrow({});
    await systemDb.emailAccount.update({ where: { id: account.id }, data: { status: "reauthorization_required" } });
    const before = await systemDb.emailOAuthCredential.findFirstOrThrow({});
    delete googleToken.refresh_token; // Google often sends none on a repeat consent
    const again = await oauthFlow("google", { code: "CODE" }, { path: `/accounts/${account.id}/reauthorize` });
    expect(again.authorize.searchParams.get("login_hint")).toBe("owner@shopmail.com");
    expect(again.location.searchParams.get("reconnected")).toBe("1");
    const after = await systemDb.emailOAuthCredential.findFirstOrThrow({});
    expect(after.refreshTokenEnc).toBe(before.refreshTokenEnc);
    expect((await systemDb.emailAccount.findFirstOrThrow({})).status).toBe("connected");
    // Reconnecting this account but signing in as someone else.
    googleToken.id_token = idToken({ iss: "https://accounts.google.com", aud: "g-email", sub: "g-sub-2", email: "someone@gmail.com", email_verified: true });
    googleToken.refresh_token = "OTHER";
    const wrong = await oauthFlow("google", { code: "CODE" }, { path: `/accounts/${account.id}/reauthorize` });
    expect(wrong.location.searchParams.get("error")).toBe("different_account");
  });

  it("says when it isn't set up", async () => {
    ctx.setEnv({ EMAIL_GOOGLE_CLIENT_ID: "" });
    const res = await api("POST", "/oauth/google/start");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("not_configured");
  });
});

describe("Microsoft OAuth", () => {
  it("connects a Microsoft 365 mailbox from Graph's /me", async () => {
    const { authorize, location } = await oauthFlow("microsoft");
    expect(authorize.hostname).toBe("login.microsoftonline.com");
    expect(authorize.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(authorize.searchParams.get("scope")).toContain("https://graph.microsoft.com/Mail.Send");
    expect(authorize.searchParams.get("scope")).not.toContain(".default");
    expect(location.searchParams.get("connected")).toBeTruthy();
    const a = await systemDb.emailAccount.findFirstOrThrow({});
    expect(a).toMatchObject({ provider: "microsoft_365", emailAddress: "billing@contoso.com", providerTenantId: MS_TENANT, providerAccountId: "ms-oid" });
  });

  it("tells the merchant when their organization's admin must consent", async () => {
    const r = await oauthFlow("microsoft", { error: "consent_required", error_description: "AADSTS65001: admin consent required" });
    expect(r.location.searchParams.get("error")).toBe("consent_required");
    const r2 = await oauthFlow("microsoft", { error: "access_denied", error_description: "AADSTS90094: Admin approval required" });
    expect(r2.location.searchParams.get("error")).toBe("consent_required");
  });

  it("refuses a token without Mail.Send", async () => {
    microsoftToken.scope = "openid email User.Read";
    expect((await oauthFlow("microsoft")).location.searchParams.get("error")).toBe("permission_missing");
  });
});

describe("SMTP accounts", () => {
  it("connects over STARTTLS, keeps the password write-only and encrypted", async () => {
    const res = await connectSmtp();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().test).toEqual({ ok: true });
    expect(res.json().account).toMatchObject({ status: "connected", provider: "smtp", smtp: { host: "smtp.shopmail.com", port: 587, encryption: "starttls" } });
    expect(res.body).not.toContain("right-password");
    const cred = await systemDb.emailSmtpCredential.findFirstOrThrow({});
    expect(cred.secretEnc).not.toContain("right-password");
    expect(smtp.connections[0]).toMatchObject({ tls: true, authed: true });
    expect(smtp.delivered).toHaveLength(0); // a connection test sends nothing
    // Its own address isn't a verified sender until proven.
    expect(res.json().account.senders[0].status).toBe("pending");
  });

  it("refuses private, loopback and metadata destinations, before and after DNS", async () => {
    for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "10.0.0.5", "[::1]", "mail.internal"]) {
      const res = await connectSmtp({ host });
      expect(res.statusCode, host).toBe(400);
      expect(res.json().error, host).toBe("blocked_destination");
    }
    dns["rebind.shopmail.com|A"] = ["192.168.1.10"];
    const rebind = await connectSmtp({ host: "rebind.shopmail.com" });
    expect(rebind.json().error).toBe("blocked_destination");
    const missing = await connectSmtp({ host: "nope.shopmail.com" });
    expect(missing.json().error).toBe("invalid_host");
    expect(smtp.connections).toHaveLength(0);
  });

  it("refuses unencrypted ports and mismatched encryption", async () => {
    expect((await connectSmtp({ port: 25 })).json().error).toBe("invalid_port");
    expect((await connectSmtp({ port: 465, encryption: "starttls" })).json().error).toBe("invalid_port");
  });

  it("reports a wrong password and a broken TLS setup without connecting the account", async () => {
    smtp.opts.password = "something-else";
    const wrong = await connectSmtp();
    expect(wrong.json().test).toMatchObject({ ok: false, code: "auth_failed" });
    expect(wrong.json().account.status).toBe("failed");
    smtp.opts.password = "right-password";
    smtp.opts.starttls = false;
    const notls = await connectSmtp({ emailAddress: "other@shopmail.com" });
    expect(notls.json().test).toMatchObject({ ok: false, code: "starttls_unavailable" });
  });

  it("verifies a sender with a code sent through the account, then sends a test to oneself", async () => {
    const acc = (await connectSmtp()).json().account;
    const sender = acc.senders[0];
    expect((await api("POST", `/senders/${sender.id}/send-code`)).statusCode).toBe(200);
    expect(smtp.delivered).toHaveLength(1);
    expect(smtp.delivered[0]!.to).toBe("billing@shopmail.com");
    const code = /is (\d{6})/.exec(Buffer.from(smtp.delivered[0]!.data.split("\r\n\r\n").slice(2).join("").split("\r\n--")[0]!.replace(/\r\n/g, ""), "base64").toString())?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect((await api("POST", `/senders/${sender.id}/confirm`, { code: "000000" === code ? "111111" : "000000" })).json().error).toBe("wrong_code");
    const ok = await api("POST", `/senders/${sender.id}/confirm`, { code });
    expect(ok.json().sender).toMatchObject({ status: "verified", method: "smtp_confirmation", isDefault: true });
    const test = await api("POST", `/accounts/${acc.id}/test-send`, {});
    expect(test.json().result.status).toBe("accepted_by_provider");
    expect(smtp.delivered[1]!.to).toBe("owner@shopmail.com");
  });

  it("disconnecting deletes credentials, retires senders and turns off its automations", async () => {
    await oauthFlow("google");
    const acc = await systemDb.emailAccount.findFirstOrThrow({});
    const t = await activeTemplate();
    const sender = (await api("GET", "/senders")).json().senders[0];
    const rule = (await api("POST", "/automations", { name: "Thanks", eventType: "order.paid", senderIdentityId: sender.id, templateId: t.id })).json().automation;
    expect((await api("POST", `/automations/${rule.id}/enable`)).statusCode).toBe(200);
    const res = await api("DELETE", `/accounts/${acc.id}`);
    expect(res.json()).toMatchObject({ ok: true, revocation: "revoked", rulesDisabled: 1 });
    expect(calls).toContain("oauth2.googleapis.com/revoke");
    expect(await systemDb.emailOAuthCredential.count()).toBe(0);
    expect((await systemDb.emailAccount.findFirstOrThrow({})).status).toBe("revoked");
    expect((await api("GET", "/accounts")).json().accounts).toEqual([]);
    expect((await systemDb.emailAutomationRule.findFirstOrThrow({})).enabled).toBe(false);
  });
});

describe("domains", () => {
  async function addDomain(body: Record<string, unknown> = {}) {
    const res = await api("POST", "/domains", { domain: "https://ShopMail.com/", sendingService: "google", ...body });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().domain;
  }

  it("issues a unique challenge and verifies it from public DNS", async () => {
    const d = await addDomain();
    expect(d.domain).toBe("shopmail.com");
    expect(d.status).toBe("unverified");
    expect(d.records.ownership).toMatchObject({ type: "TXT", host: "_insights-verify.shopmail.com", relativeHost: "_insights-verify" });
    // Missing record: still pending.
    expect((await api("POST", `/domains/${d.id}/verify`)).json().domain.status).toBe("pending");
    // Wrong value: failed (fixable).
    dns["_insights-verify.shopmail.com|TXT"] = ["insights-verification=not-this-one"];
    expect((await api("POST", `/domains/${d.id}/verify`)).json().domain.status).toBe("failed");
    // Right value, with SPF, DKIM and DMARC for Google.
    dns["_insights-verify.shopmail.com|TXT"] = [d.records.ownership.value];
    dns["shopmail.com|TXT"] = ["v=spf1 include:_spf.google.com ~all"];
    dns["google._domainkey.shopmail.com|TXT"] = [`v=DKIM1; k=rsa; p=${"B".repeat(300)}`];
    dns["_dmarc.shopmail.com|TXT"] = ["v=DMARC1; p=none; rua=mailto:d@shopmail.com"];
    await ctx.deps.coord.clear();
    const ok = (await api("POST", `/domains/${d.id}/verify`)).json().domain;
    expect(ok).toMatchObject({ status: "verified", spf: "pass", dkim: "pass", dmarc: "warn" });
    expect(ok.results.dmarc.explanation).toMatch(/monitoring mode/);
  });

  it("reports SPF and DKIM honestly when they don't match the sending service", async () => {
    const d = await addDomain({ sendingService: "microsoft" });
    dns["shopmail.com|TXT"] = ["v=spf1 include:_spf.google.com ~all"];
    const r = (await api("POST", `/domains/${d.id}/verify`)).json().domain;
    expect(r.spf).toBe("fail");
    expect(r.dkim).toBe("missing");
    expect(r.dmarc).toBe("missing");
  });

  it("keeps state through a DNS outage, and expires an old challenge", async () => {
    const d = await addDomain();
    dnsDown = true;
    const r = (await api("POST", `/domains/${d.id}/verify`)).json().domain;
    expect(r.status).toBe("unverified");
    expect(r.results.error).toMatch(/couldn't be read/);
    await systemDb.emailDomain.update({ where: { id: d.id }, data: { verificationExpiresAt: new Date(Date.now() - 1000) } });
    dnsDown = false;
    await ctx.deps.coord.clear();
    expect((await api("POST", `/domains/${d.id}/verify`)).json().domain.status).toBe("expired");
    const fresh = (await api("POST", `/domains/${d.id}/regenerate`)).json().domain;
    expect(fresh.status).toBe("unverified");
    expect(fresh.records.ownership.value).not.toBe(d.records.ownership.value);
  });

  it("authorizes an SMTP sender at a verified domain once the account signs in", async () => {
    const acc = (await connectSmtp()).json().account;
    const d = await addDomain({ sendingService: "other" });
    dns["_insights-verify.shopmail.com|TXT"] = [d.records.ownership.value];
    await api("POST", `/domains/${d.id}/verify`);
    const sender = (await api("GET", "/senders")).json().senders.find((s: { accountId: string }) => s.accountId === acc.id);
    expect(sender).toMatchObject({ status: "verified", method: "domain_ownership" });
  });

  it("refuses private and malformed domains", async () => {
    for (const domain of ["localhost", "intranet", "10.0.0.1", "printer.local"]) expect((await api("POST", "/domains", { domain })).json().error, domain).toBe("invalid_domain");
  });
});

describe("templates", () => {
  it("sanitizes HTML, versions edits and restores old versions", async () => {
    const res = await api("POST", "/templates", { name: "Promo", category: "marketing", eventType: null, subject: "Hello {{customer.first_name}}", html: '<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>', status: "draft" });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json().template;
    expect(t.html).toBe("<p>Hi</p><a>x</a>");
    expect(t.version).toBe(1);
    const updated = (await api("PATCH", `/templates/${t.id}`, { subject: "Hi again {{customer.first_name}}" })).json().template;
    expect(updated.version).toBe(2);
    const restored = (await api("POST", `/templates/${t.id}/versions/1/restore`)).json().template;
    expect(restored).toMatchObject({ version: 3, subject: "Hello {{customer.first_name}}" });
    const detail = (await api("GET", `/templates/${t.id}`)).json();
    expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
  });

  it("refuses variables the event doesn't have and anything that isn't a placeholder", async () => {
    const bad = await api("POST", "/templates", { name: "Bad", eventType: "order.paid", subject: "{{checkout.recovery_url}}", html: "" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_template");
    const code = await api("POST", "/templates", { name: "Code", subject: "{{ constructor.constructor('x')() }}", html: "" });
    expect(code.statusCode).toBe(400);
  });

  it("previews with example data and adds the unsubscribe footer to marketing", async () => {
    await api("PATCH", "/settings", { businessName: "Shop Co", businessAddress: "1 Main St" });
    const res = await api("POST", "/templates/preview", { name: "x", category: "marketing", eventType: "order.paid", subject: "Order {{order.id}}", html: "<p>{{customer.first_name}}</p>" });
    const p = res.json().preview;
    expect(p.subject).toBe("Order #1001");
    expect(p.html).toContain("Alex");
    expect(p.html).toContain("Unsubscribe");
    expect(p.text).toContain("1 Main St");
  });
});

describe("automations", () => {
  it("creates rules off, enables only when ready, and dry-runs without sending", async () => {
    await oauthFlow("google");
    const sender = (await api("GET", "/senders")).json().senders[0];
    const draft = (await api("POST", "/templates", { name: "Draft", eventType: "order.paid", subject: "Hi", html: "<p>x</p>" })).json().template;
    const rule = (await api("POST", "/automations", { name: "Thanks", eventType: "order.paid", senderIdentityId: sender.id, templateId: draft.id, conditions: { op: "greater_than", field: "order.total", value: 100 }, delayMinutes: 5 })).json();
    expect(rule.automation.enabled).toBe(false);
    expect(rule.blocking[0]).toMatch(/draft/);
    const enable = await api("POST", `/automations/${rule.automation.id}/enable`);
    expect(enable.statusCode).toBe(409);
    await api("PATCH", `/templates/${draft.id}`, { status: "active" });
    expect((await api("POST", `/automations/${rule.automation.id}/enable`)).json().automation.enabled).toBe(true);
    const dry = (await api("POST", `/automations/${rule.automation.id}/dry-run`, { data: { order: { total: 150 } } })).json();
    expect(dry.wouldSend).toBe(true);
    expect(dry.preview.subject).toBe("Hi");
    const no = (await api("POST", `/automations/${rule.automation.id}/dry-run`, { data: { order: { total: 50 } } })).json();
    expect(no.wouldSend).toBe(false);
    expect(no.steps.find((s: { step: string }) => s.step === "conditions").ok).toBe(false);
    expect(await systemDb.emailMessage.count()).toBe(0);
  });

  it("validates conditions, the template's event and the store", async () => {
    await oauthFlow("google");
    const sender = (await api("GET", "/senders")).json().senders[0];
    const t = await activeTemplate();
    const bad = await api("POST", "/automations", { name: "x", eventType: "order.paid", senderIdentityId: sender.id, templateId: t.id, conditions: { op: "greater_than", field: "order.secret", value: 1 } });
    expect(bad.json().error).toBe("invalid_conditions");
    const mismatch = await api("POST", "/automations", { name: "x", eventType: "checkout.abandoned", senderIdentityId: sender.id, templateId: t.id });
    expect(mismatch.json().error).toBe("template_mismatch");
    const otherWs = await createWorkspace(ctx, owner.headers, "Second");
    const foreignStore = await createStore(otherWs, "foreign.myshopify.com", []);
    const store = await api("POST", "/automations", { name: "x", eventType: "order.paid", storeId: foreignStore.id, senderIdentityId: sender.id, templateId: t.id });
    expect(store.json().error).toBe("invalid_store");
  });
});

describe("event API", () => {
  async function key() {
    return (await api("POST", "/ingest-keys", { name: "CRM" })).json().secret as string;
  }
  const post = (secret: string | null, payload: unknown) => ctx.app.inject({ method: "POST", url: "/v1/events", headers: secret ? { authorization: `Bearer ${secret}` } : {}, payload });

  it("needs a key, accepts custom events once, and refuses Shopify's names", async () => {
    expect((await post(null, { id: "e1", type: "appointment.booked" })).statusCode).toBe(401);
    expect((await post("ek_live_wrong", { id: "e1", type: "appointment.booked" })).statusCode).toBe(401);
    const secret = await key();
    const first = await post(secret, { id: "e1", type: "appointment.booked", customer: { email: "pat@example.com" }, data: { when: "2026-11-01" } });
    expect(first.statusCode).toBe(202);
    const again = await post(secret, { id: "e1", type: "appointment.booked" });
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    expect((await post(secret, { id: "e2", type: "order.paid" })).json().error).toBe("invalid_event_type");
    expect((await post(secret, { id: "e3", type: "x.y", data: { "Bad Key": 1 } })).json().error).toBe("invalid_data");
    expect(await systemDb.emailBusinessEvent.count()).toBe(1);
    // Nothing listens yet: no customer data kept.
    expect((await systemDb.emailBusinessEvent.findFirstOrThrow({})).payloadEnc).toBeNull();
  });

  it("queues the automations of the key's own workspace", async () => {
    await oauthFlow("google");
    const sender = (await api("GET", "/senders")).json().senders[0];
    const t = await activeTemplate({ name: "Appt", eventType: "appointment.booked", subject: "See you {{customer.first_name}}" });
    const rule = (await api("POST", "/automations", { name: "Appt", eventType: "appointment.booked", senderIdentityId: sender.id, templateId: t.id })).json().automation;
    await api("POST", `/automations/${rule.id}/enable`);
    const secret = await key();
    const res = await post(secret, { id: "a-1", type: "appointment.booked", customer: { email: "pat@example.com", first_name: "Pat" } });
    expect(res.json()).toMatchObject({ accepted: true, automations: true });
    expect(ctx.deps.queues.sent.email).toEqual([{ kind: "email_event", eventId: expect.any(String) }]);
    const evt = await systemDb.emailBusinessEvent.findFirstOrThrow({});
    expect(evt.workspaceId).toBe(ws);
    expect(evt.payloadEnc).not.toContain("pat@example.com");
  });
});

describe("unsubscribe", () => {
  it("suppresses marketing to that address with a signed link, once", async () => {
    await oauthFlow("google");
    const account = await systemDb.emailAccount.findFirstOrThrow({});
    const sender = await systemDb.emailSenderIdentity.findFirstOrThrow({});
    const msg = await createMessage(systemDb, { workspaceId: ws, account, sender, to: "pat@example.com", subject: "Sale", kind: "automation", category: "marketing", scheduledAt: new Date(), idempotencyKey: "k1" });
    const token = unsubscribeToken({ w: ws, h: msg.recipientHash, e: msg.recipientMasked, m: msg.id });
    const page = await ctx.app.inject({ method: "GET", url: `/email/unsubscribe/${token}` });
    expect(page.json()).toMatchObject({ email: "p***t@example.com", unsubscribed: false });
    // One-click from a mail provider: no cookie, no Origin.
    const click = await ctx.app.inject({ method: "POST", url: `/email/unsubscribe/${token}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
    expect(click.json()).toMatchObject({ ok: true, already: false });
    expect((await ctx.app.inject({ method: "POST", url: `/email/unsubscribe/${token}` })).json().already).toBe(true);
    const s = await systemDb.emailSuppression.findFirstOrThrow({});
    expect(s).toMatchObject({ reason: "unsubscribed", scope: "marketing", source: "one_click" });
    // The queued marketing message to that address won't go.
    expect((await systemDb.emailMessage.findFirstOrThrow({})).status).toBe("suppressed");
    expect((await ctx.app.inject({ method: "GET", url: `/email/unsubscribe/${token.slice(0, -2)}xx` })).statusCode).toBe(404);
  });
});
