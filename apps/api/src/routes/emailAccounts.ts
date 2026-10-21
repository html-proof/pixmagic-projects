import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import {
  addSender,
  confirmSender,
  connectOAuthAccount,
  createSmtpAccount,
  disconnectEmailAccount,
  EmailError,
  emailOAuthConfigured,
  env,
  getConnectionHealth,
  getEmailAccount,
  GMAIL_SEND_SCOPE,
  googleEmailAuthorizeUrl,
  googleEmailConfig,
  googleEmailExchangeCode,
  googleIdentity,
  listEmailAccounts,
  listSenders,
  logger,
  microsoftEmailAuthorizeUrl,
  microsoftEmailConfig,
  microsoftEmailExchangeCode,
  microsoftErrorCode,
  microsoftIdentity,
  OAuthError,
  previewTemplate,
  getTemplate,
  publicAccount,
  publicSender,
  releaseHeld,
  removeSender,
  sendNow,
  sendSenderCode,
  setDefaultSender,
  testEmailConnection,
  updateEmailAccount,
  updateSmtpAccount,
} from "@app/core";
import { pkcePair, randomToken, safeEqual } from "@app/shared";
import { accountCanSend, accountUpdateSchema, OAUTH_PROVIDERS, senderCreateSchema, smtpConnectionSchema, smtpUpdateSchema, type OAuthProvider } from "@app/shared/email";
import { body, HttpError, loadUser, memberAllows, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { requireEmail } from "../emailAccess.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Settings → Email → Accounts: connect Gmail / Google Workspace and Outlook / Microsoft 365 with
 * OAuth (authorization code + PKCE), or any other provider over SMTP; test, set defaults, add and
 * verify sender addresses, disable and disconnect.
 *
 * The OAuth round trip mirrors the ad platforms' (routes/ads.ts): single-use state kept in the
 * coordinator (never in the URL beyond its random id), bound to this browser by a cookie and to the
 * person who started it, a PKCE verifier that never leaves the server, and a fixed redirect URI.
 * The callback re-checks that person's membership and permission before saving anything, and only
 * ever redirects to bizinsights' own settings page.
 */

const STATE_TTL_S = 600;
const STATE_COOKIE = "email_oauth_state";
const MAX_PENDING_STATES = 5;
const pendingStates = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));
const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production", maxAge: STATE_TTL_S });
const stateKey = (nonce: string) => `oauth:email:${nonce}`;

interface EmailOAuthState {
  userId: string;
  workspaceId: string;
  provider: OAuthProvider;
  codeVerifier: string;
  reauthorizeAccountId: string | null;
}

const providerSchema = z.enum(OAUTH_PROVIDERS);

async function oauthStart(c: Ctx, deps: Deps, ws: string, provider: OAuthProvider, userId: string, reauthorize: { id: string; email: string } | null) {
  const google = provider === "google" ? googleEmailConfig() : null;
  const microsoft = provider === "microsoft" ? microsoftEmailConfig() : null;
  if (!google && !microsoft) throw new HttpError(503, `${provider === "google" ? "Google" : "Microsoft"} sign-in isn't set up on this server yet.`, "not_configured");
  await limit(deps.coord, `rl:email:connect:${ws}`, LIMITS.emailConnect);
  const nonce = randomToken(24);
  const pkce = pkcePair();
  const state: EmailOAuthState = { userId, workspaceId: ws, provider, codeVerifier: pkce.verifier, reauthorizeAccountId: reauthorize?.id ?? null };
  await deps.coord.put(stateKey(nonce), JSON.stringify(state), STATE_TTL_S);
  setCookie(c, STATE_COOKIE, [nonce, ...pendingStates(getCookie(c, STATE_COOKIE))].slice(0, MAX_PENDING_STATES).join("."), cookieOpts());
  const input = { state: nonce, codeChallenge: pkce.challenge, loginHint: reauthorize?.email ?? null };
  return google ? googleEmailAuthorizeUrl(google, input) : microsoftEmailAuthorizeUrl(microsoft!, input);
}

export function emailAccountRoutes(app: App, deps: Deps) {
  const base = "/workspaces/:ws/email";

  app.get(`${base}/accounts`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    const accounts = await listEmailAccounts(ws);
    return c.json({ accounts: accounts.map(publicAccount), configured: emailOAuthConfigured(), smtpAvailable: !!deps.smtpConnect });
  });

  app.get(`${base}/accounts/:id`, async (c) => {
    const { ws, id } = c.req.param();
    await requireEmail(c, deps, ws, "email:read");
    const a = await getEmailAccount(ws, id);
    return c.json({ account: publicAccount(a), health: await getConnectionHealth(a) });
  });

  // ---------------- OAuth ----------------

  /** Step 1: where to send the browser to approve sending access. */
  app.post(`${base}/oauth/:provider/start`, async (c) => {
    const ws = c.req.param("ws");
    const provider = providerSchema.parse(c.req.param("provider"));
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    if (!user.emailVerified) throw new HttpError(403, "Verify your email first", "email_unverified");
    return c.json({ url: await oauthStart(c, deps, ws, provider, user.id, null) });
  });

  /** Reconnect an OAuth account (expired or revoked access): the same mailbox must sign in again. */
  app.post(`${base}/accounts/:id/reauthorize`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const a = await getEmailAccount(ws, id);
    if (a.connectionMethod === "smtp") throw new HttpError(400, "Update the SMTP password instead.", "not_oauth");
    const provider: OAuthProvider = a.connectionMethod === "oauth_google" ? "google" : "microsoft";
    return c.json({ url: await oauthStart(c, deps, ws, provider, user.id, { id: a.id, email: a.emailAddress }) });
  });

  /** Step 2: Google or Microsoft sends the browser back here. Always answers with a redirect to Settings. */
  app.get("/email/oauth/:provider/callback", async (c) => {
    const appUrl = env().APP_URL;
    const back = (params: Record<string, string>) => c.redirect(`${appUrl}/settings/email/accounts?${new URLSearchParams(params)}`);
    const parsed = providerSchema.safeParse(c.req.param("provider"));
    if (!parsed.success) return back({ error: "unknown_provider" });
    const provider = parsed.data;
    const q = c.req.query();
    try {
      const pending = pendingStates(getCookie(c, STATE_COOKIE));
      const ours = !!q.state && pending.some((n) => safeEqual(n, q.state!));
      const rest = pending.filter((n) => n !== q.state);
      if (rest.length) setCookie(c, STATE_COOKIE, rest.join("."), cookieOpts());
      else deleteCookie(c, STATE_COOKIE, { path: "/" });
      // Not started in this browser (CSRF, a link someone was sent), or used already (replay).
      if (!ours) return back({ error: "state_mismatch", provider });
      const raw = await deps.coord.take(stateKey(q.state!));
      if (!raw) return back({ error: "state_expired", provider });
      const state = JSON.parse(raw) as EmailOAuthState;
      if (state.provider !== provider) return back({ error: "state_mismatch", provider });
      if (q.error || !q.code) {
        const ms = provider === "microsoft" && q.error ? microsoftErrorCode(q.error, q.error_description ?? "") : null;
        const code = ms?.code === "consent_required" ? "consent_required" : q.error === "access_denied" ? "denied" : (ms?.code ?? "missing_params");
        return back({ error: code, provider });
      }
      // The person who pressed the button, still a member allowed to manage email.
      const user = await loadUser(c, deps);
      if (!user || user.id !== state.userId) return back({ error: "session_mismatch", provider });
      const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: state.workspaceId, userId: user.id } } });
      if (!memberAllows(m, "email:manage")) return back({ error: "forbidden", provider });

      let result;
      try {
        if (provider === "google") {
          const cfg = googleEmailConfig(deps.fetchImpl);
          if (!cfg) return back({ error: "not_configured", provider });
          const tokens = await googleEmailExchangeCode(cfg, q.code, state.codeVerifier);
          // Granular consent: the person can untick "Send email on your behalf".
          if (!tokens.scopes.includes(GMAIL_SEND_SCOPE)) return back({ error: "permission_missing", provider });
          result = await connectOAuthAccount({ workspaceId: state.workspaceId, userId: user.id, method: "oauth_google", identity: googleIdentity(cfg, tokens), tokens, reauthorizeAccountId: state.reauthorizeAccountId });
        } else {
          const cfg = microsoftEmailConfig(deps.fetchImpl);
          if (!cfg) return back({ error: "not_configured", provider });
          const tokens = await microsoftEmailExchangeCode(cfg, q.code, state.codeVerifier);
          if (!tokens.scopes.some((s) => /(^|\/)mail\.send$/i.test(s))) return back({ error: "permission_missing", provider });
          result = await connectOAuthAccount({ workspaceId: state.workspaceId, userId: user.id, method: "oauth_microsoft", identity: await microsoftIdentity(cfg, tokens), tokens, reauthorizeAccountId: state.reauthorizeAccountId });
        }
      } catch (err) {
        if (err instanceof OAuthError) {
          logger.warn({ err, provider, errorCode: err.code }, "email OAuth connect refused");
          return back({ error: err.code, provider });
        }
        if (err instanceof EmailError) return back({ error: err.code, provider });
        throw err;
      }
      // Mail held while this account waited to be reconnected goes out now.
      await releaseHeld({ workspaceId: state.workspaceId, emailAccountId: result.account.id }, ["account_reauthorization_required", "account_failed"], deps).catch(() => 0);
      return back({ connected: result.account.id, provider, ...(result.created ? {} : { reconnected: "1" }) });
    } catch (err) {
      logger.error({ err, provider }, "email OAuth callback failed");
      return back({ error: "temporarily_unavailable", provider });
    }
  });

  // ---------------- SMTP ----------------

  app.post(`${base}/smtp/connections`, async (c) => {
    const ws = c.req.param("ws");
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const input = smtpConnectionSchema.parse(await body(c));
    await limit(deps.coord, `rl:email:connect:${ws}`, LIMITS.emailConnect);
    const { account, test } = await createSmtpAccount(ws, user.id, input, deps);
    return c.json({ account: publicAccount(account), test });
  });

  app.patch(`${base}/smtp/connections/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const input = smtpUpdateSchema.parse(await body(c));
    await limit(deps.coord, `rl:email:connect:${ws}`, LIMITS.emailConnect);
    const test = await updateSmtpAccount(ws, id, user.id, input, deps);
    return c.json({ account: publicAccount(await getEmailAccount(ws, id)), test });
  });

  // ---------------- Account actions ----------------

  /** Check the connection works (refresh the token, or sign in to the SMTP server). Sends nothing. */
  app.post(`${base}/accounts/:id/test`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    await limit(deps.coord, `rl:email:test:${ws}`, LIMITS.emailTest);
    const test = await testEmailConnection(ws, id, deps, user.id);
    return c.json({ account: publicAccount(await getEmailAccount(ws, id)), test });
  });

  /** Send one test email from the account to the signed-in person's own address (never anyone else's). */
  app.post(`${base}/accounts/:id/test-send`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const input = z.object({ senderId: z.string().max(64).optional(), templateId: z.string().max(64).optional() }).parse(await body(c));
    if (!user.emailVerified) throw new HttpError(403, "Verify your own email address first: test emails go to it.", "email_unverified");
    await limit(deps.coord, `rl:email:testsend:${ws}`, LIMITS.emailTestSend);
    const account = await getEmailAccount(ws, id);
    if (!accountCanSend(account.status)) throw new HttpError(409, "This account can't send right now. Test or reconnect it first.", "account_unavailable");
    const sender = account.senders.find((s) => (input.senderId ? s.id === input.senderId : s.senderEmail === account.emailAddress) && s.authorizationStatus === "verified");
    if (!sender) throw new HttpError(409, "That sender address isn't verified for this account.", "sender_unavailable");
    const content = input.templateId
      ? await (async () => {
          const t = await getTemplate(ws, input.templateId!);
          return previewTemplate(ws, { subject: t.subjectTemplate, html: t.htmlTemplate, text: t.textTemplate, category: t.category, eventType: t.eventType }, undefined, user.email);
        })()
      : {
          subject: "bizinsights test email",
          text: `This is a test from bizinsights, sent through ${account.emailAddress}. If you can read it, the connection works.`,
          html: `<p>This is a test from bizinsights, sent through <b>${account.emailAddress}</b>.</p><p>If you can read it, the connection works.</p>`,
        };
    const result = await sendNow({ workspaceId: ws, account, sender, to: user.email, content: { ...content, subject: `[Test] ${content.subject}` }, kind: "test" }, deps);
    return c.json({ result, account: publicAccount(await getEmailAccount(ws, id)) });
  });

  app.patch(`${base}/accounts/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const patch = accountUpdateSchema.parse(await body(c));
    const before = await getEmailAccount(ws, id);
    const a = await updateEmailAccount(ws, id, user.id, patch);
    if (before.status === "disabled" && patch.enabled === true) await releaseHeld({ workspaceId: ws, emailAccountId: id }, ["account_disabled"], deps).catch(() => 0);
    return c.json({ account: publicAccount(a) });
  });

  app.delete(`${base}/accounts/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const r = await disconnectEmailAccount(ws, id, user.id, deps);
    return c.json({ ok: true, ...r });
  });

  // ---------------- Sender identities ----------------

  app.get(`${base}/senders`, async (c) => {
    const ws = c.req.param("ws");
    await requireEmail(c, deps, ws, "email:read");
    return c.json({ senders: (await listSenders(ws)).map(publicSender) });
  });

  app.post(`${base}/accounts/:id/senders`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const input = senderCreateSchema.parse(await body(c));
    const s = await addSender(ws, id, input, user.id);
    return c.json({ sender: publicSender(s) });
  });

  app.post(`${base}/senders/:id/send-code`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    await limit(deps.coord, `rl:email:sendercode:${id}`, LIMITS.emailSenderCode);
    return c.json(await sendSenderCode(ws, id, user.id, deps));
  });

  app.post(`${base}/senders/:id/confirm`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    const { code } = z.object({ code: z.string().trim().min(1).max(12) }).parse(await body(c));
    await limit(deps.coord, `rl:email:senderconfirm:${id}`, LIMITS.emailSenderConfirm);
    const s = await confirmSender(ws, id, code, user.id);
    return c.json({ sender: publicSender(s) });
  });

  app.post(`${base}/senders/:id/default`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    await setDefaultSender(ws, id, user.id);
    return c.json({ ok: true });
  });

  app.delete(`${base}/senders/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const { user } = await requireEmail(c, deps, ws, "email:manage");
    await removeSender(ws, id, user.id);
    return c.json({ ok: true });
  });
}
